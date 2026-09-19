/**
 * The live session: the thin driver around the pure reducer.
 *
 * The engine decides *what* happens; this decides who hears about it. It holds
 * the sockets, applies effects, and projects a view per role. It contains no
 * game rules — if a rule appears here it is in the wrong file.
 */

import type { WebSocket } from "ws";
import { reduce } from "../engine/reducer.ts";
import type {
  Activity,
  Effect,
  Event,
  ParticipantId,
  SessionState,
} from "../engine/types.ts";
import type {
  RefusedReason,
  RenderState,
  Role,
  ServerMessage,
} from "../protocol.ts";
import { renderStateFor, rosterOf } from "./views.ts";
import { hashToken, newToken } from "./tokens.ts";
import {
  NO_PERSISTENCE,
  type Persister,
  type SessionPersistence,
} from "./persist.ts";
import {
  MAX_REJOIN_TOKENS,
  type LoadedSession,
  type SessionMeta,
  type StoredParticipant,
} from "./store/types.ts";

export interface Client {
  readonly socket: WebSocket;
  readonly role: Role;
  /** Participants only. */
  readonly pid?: ParticipantId;
  /** Last frame received, for the away/amber indicator. */
  lastSeen: number;
  /**
   * Frames sent to *this* client, not engine events.
   *
   * The engine's `state.seq` counts every accepted event, including ones only
   * the host hears about — locking the lobby moves it twice while a phone is
   * sent nothing. The phone then sees its next frame jump, and the protocol
   * says a jump means resync, so thirty phones resync at once over a host
   * toggling a switch. A per-client counter makes consecutive frames true by
   * construction, so a gap only ever means a genuinely lost frame.
   */
  seq: number;
}

export interface SessionSecrets {
  readonly hostTokenHash: string;
  readonly screenTokenHash: string;
}

export interface EventRecord {
  readonly seq: number;
  readonly event: Event;
  readonly at: number;
}

export class SessionRuntime {
  state: SessionState;
  readonly secrets: SessionSecrets;
  readonly clients = new Set<Client>();
  /** rejoin token hash -> pid. Lets a phone that slept come back as itself. */
  private readonly rejoin = new Map<string, ParticipantId>();
  /** pid -> its token hashes, newest last. The half that has to be stored. */
  private readonly rejoinByPid = new Map<ParticipantId, string[]>();
  /** Append-only, for replay and for settling a scoring dispute after the fact. */
  readonly log: EventRecord[] = [];
  /** Where a `persist` effect goes. Writes never block {@link apply}. */
  readonly persistence: SessionPersistence;
  readonly createdAt: number;

  constructor(
    state: SessionState,
    secrets: SessionSecrets,
    persistence: SessionPersistence = NO_PERSISTENCE,
    createdAt = Date.now(),
  ) {
    this.state = state;
    this.secrets = secrets;
    this.persistence = persistence;
    this.createdAt = createdAt;
  }

  /* ---------------- participants ---------------- */

  issueRejoinToken(pid: ParticipantId): string {
    const token = newToken();
    const hash = hashToken(token);
    this.rejoin.set(hash, pid);
    const held = [...(this.rejoinByPid.get(pid) ?? []), hash];
    // Only the recent ones are on a device anyone still has, and an unbounded
    // list would grow by one item per reconnect for the whole afternoon.
    while (held.length > MAX_REJOIN_TOKENS) {
      const dropped = held.shift();
      if (dropped) this.rejoin.delete(dropped);
    }
    this.rejoinByPid.set(pid, held);
    this.persistParticipant(pid);
    return token;
  }

  pidForRejoin(token: string): ParticipantId | undefined {
    return this.rejoin.get(hashToken(token));
  }

  /** Reinstate the tokens a restart loaded, so phones come back as themselves. */
  restoreRejoinTokens(pid: ParticipantId, hashes: readonly string[]): void {
    const held = hashes.slice(-MAX_REJOIN_TOKENS);
    for (const h of held) this.rejoin.set(h, pid);
    this.rejoinByPid.set(pid, held);
  }

  /**
   * `SESSION#<sid>` / `PARTICIPANT#<pid>`.
   *
   * The snapshot already has the roster, so this item exists for the one thing
   * the snapshot cannot hold: the rejoin token hashes, which live here rather
   * than in `SessionState` because the engine is pure and holds no secrets.
   */
  private persistParticipant(pid: ParticipantId): void {
    const p = this.state.participants[pid];
    if (!p) return;
    const record: StoredParticipant = {
      pid: p.pid,
      nickname: p.nickname,
      nicknameKey: p.nicknameKey,
      playerNumber: p.playerNumber,
      joinedAt: p.joinedAt,
      kicked: p.kicked,
      rejoinTokenHashes: this.rejoinByPid.get(pid) ?? [],
    };
    this.persistence.participant(record);
  }

  meta(now = Date.now()): SessionMeta {
    return {
      sid: this.state.sid,
      title: this.state.title,
      joinCode: this.state.joinCode,
      phase: this.state.phase,
      seal: this.state.seal,
      hostTokenHash: this.secrets.hostTokenHash,
      screenTokenHash: this.secrets.screenTokenHash,
      createdAt: this.createdAt,
      updatedAt: now,
    };
  }

  private lastSeenMap(): Map<ParticipantId, number> {
    const m = new Map<ParticipantId, number>();
    for (const c of this.clients) {
      if (!c.pid) continue;
      m.set(c.pid, Math.max(m.get(c.pid) ?? 0, c.lastSeen));
    }
    return m;
  }

  /* ---------------- applying events ---------------- */

  /**
   * Apply an event and fan the resulting effects out to sockets.
   * Returns whether the engine accepted it, plus any rejection to echo back.
   */
  apply(
    event: Event,
    now: number,
  ): { applied: boolean; rejection?: { code: string; message: string } } {
    const before = this.state;
    const result = reduce(this.state, event, now);
    this.state = result.state;

    if (result.applied) {
      this.log.push({ seq: this.state.seq, event, at: now });
    }

    let rejection: { code: string; message: string } | undefined;
    let sendState = false;
    let sendRoster = false;
    let persist = false;

    for (const effect of result.effects) {
      switch (effect.kind) {
        case "broadcast":
          // Any broadcast means somebody's view changed. Rather than encoding
          // which fields moved, resend the projection — it is a few hundred
          // bytes for thirty people and it cannot go subtly stale.
          if (effect.what === "toast") {
            this.sendAll({
              t: "toast",
              seq: this.state.seq,
              kind: "spot",
              text: effect.detail ?? "",
            });
          } else {
            sendState = true;
            if (effect.what === "state") sendRoster = true;
          }
          break;
        case "reject":
          rejection = { code: effect.code, message: effect.message };
          break;
        case "persist":
          persist = true;
          break;
      }
    }

    // The store write happens after the sockets, and returns immediately: the
    // room sees the reveal at socket speed whatever DynamoDB is doing. It is
    // gated on the engine's own `persist` effect, which is why a disconnect
    // does not write — ARCHITECTURE.md is explicit that who is connected is
    // not durable, and persisting it would bring everyone back "present".
    if (persist && result.applied) {
      const seq = this.state.seq;
      this.persistence.snapshot(this.state, now);
      this.persistence.event({ seq, event, at: now });
      if (before.phase !== this.state.phase || before.seal !== this.state.seal) {
        // `phase` is what a restart scans on, so META has to keep up with it.
        this.persistence.meta(this.meta(now));
      }
      if (before.phase !== "closed" && this.state.phase === "closed") {
        // "Exists only while the session is joinable" — a finished session's
        // code stops resolving rather than sending someone to a dead lobby.
        this.persistence.deleteJoinCode(this.state.joinCode);
      }
      if ("pid" in event) this.persistParticipant(event.pid);
    }

    if (sendState) this.broadcastState(now);
    if (sendRoster) this.broadcastRoster(now);
    return rejection ? { applied: result.applied, rejection } : { applied: result.applied };
  }

  /* ---------------- sending ---------------- */

  viewFor(client: Client, now: number): RenderState {
    return renderStateFor(this.state, {
      role: client.role,
      ...(client.pid ? { pid: client.pid } : {}),
      lastSeen: this.lastSeenMap(),
      now,
    });
  }

  send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== 1) return; // OPEN
    const framed =
      "seq" in message ? { ...message, seq: ++client.seq } : message;
    try {
      client.socket.send(JSON.stringify(framed));
    } catch {
      // A socket that fails mid-send is already gone; the close handler tidies up.
    }
  }

  sendAll(message: ServerMessage): void {
    // Each send stamps its own per-client seq, so this cannot be hoisted.
    for (const c of this.clients) this.send(c, message);
  }

  sendState(client: Client, now: number): void {
    this.send(client, {
      t: "state",
      seq: 0, // replaced per-client in send()
      state: this.viewFor(client, now),
    });
  }

  broadcastState(now: number): void {
    for (const c of this.clients) this.sendState(c, now);
  }

  /** `except` is the client that has just been sent a full state already. */
  broadcastRoster(now: number, except?: Client): void {
    const roster = rosterOf(this.state, this.lastSeenMap(), now);
    for (const c of this.clients) {
      if (c === except) continue;
      // The host's counts live in hostExtras, which a roster frame does not
      // carry — sending them a delta would leave the console's headcount
      // stale. They get the whole thing; there is one of them.
      if (c.role === "host") this.sendState(c, now);
      else this.send(c, { t: "roster", seq: 0, roster });
    }
  }

  refuse(socket: WebSocket, reason: RefusedReason, message: string): void {
    try {
      socket.send(JSON.stringify({ t: "refused", reason, message }));
      socket.close(1008, reason);
    } catch {
      /* already gone */
    }
  }

  /** Participants whose socket has gone quiet are marked away, not removed. */
  sweep(now: number): void {
    this.broadcastRoster(now);
  }
}

/* ------------------------------------------------------------------ */

export interface CreatedSession {
  readonly runtime: SessionRuntime;
  /** Shown once, at creation. Never retrievable afterwards. */
  readonly hostToken: string;
  readonly screenToken: string;
}

export class SessionRegistry {
  private readonly bySid = new Map<string, SessionRuntime>();
  private readonly byCode = new Map<string, string>();
  /** Null in a bare registry: sessions are then in memory and nowhere else. */
  private readonly persister: Persister | null;

  constructor(persister: Persister | null = null) {
    this.persister = persister;
  }

  private persistenceFor(sid: string): SessionPersistence {
    return this.persister ? this.persister.forSession(sid) : NO_PERSISTENCE;
  }

  add(state: SessionState, now = Date.now()): CreatedSession {
    const hostToken = newToken();
    const screenToken = newToken();
    const runtime = new SessionRuntime(
      state,
      {
        hostTokenHash: hashToken(hostToken),
        screenTokenHash: hashToken(screenToken),
      },
      this.persistenceFor(state.sid),
      now,
    );
    this.bySid.set(state.sid, runtime);
    // No case folding: the code is base62 and case is significant.
    this.byCode.set(state.joinCode, state.sid);

    // META first: it carries the token hashes, and a session that came back
    // with its scores and no way for the host to sign in would be worse than
    // one that did not come back at all. Then a snapshot, so a crash between
    // creation and the first event still recovers something coherent.
    runtime.persistence.meta(runtime.meta(now));
    runtime.persistence.snapshot(state, now);
    runtime.persistence.joinCode(state.joinCode, state.sid);
    return { runtime, hostToken, screenToken };
  }

  /**
   * Put a session loaded from the store back in the registry.
   *
   * The caller has already rebuilt the state; this reattaches the identity
   * (token hashes, rejoin tokens, join code) that the snapshot does not carry.
   */
  restore(
    loaded: LoadedSession,
    state: SessionState,
  ): SessionRuntime {
    const runtime = new SessionRuntime(
      state,
      {
        hostTokenHash: loaded.meta.hostTokenHash,
        screenTokenHash: loaded.meta.screenTokenHash,
      },
      this.persistenceFor(state.sid),
      loaded.meta.createdAt,
    );
    for (const p of loaded.participants) {
      runtime.restoreRejoinTokens(p.pid, p.rejoinTokenHashes);
    }
    for (const e of loaded.events) {
      runtime.log.push({ seq: e.seq, event: e.event, at: e.at });
    }
    this.bySid.set(state.sid, runtime);
    this.byCode.set(state.joinCode, state.sid);
    return runtime;
  }

  bySessionId(sid: string): SessionRuntime | undefined {
    return this.bySid.get(sid);
  }

  byJoinCode(code: string): SessionRuntime | undefined {
    const sid = this.byCode.get(code.trim());
    return sid ? this.bySid.get(sid) : undefined;
  }

  takenCodes(): Set<string> {
    return new Set(this.byCode.keys());
  }

  all(): SessionRuntime[] {
    return [...this.bySid.values()];
  }

  /** `sessionsLive` in /healthz — the deploy-freeze signal. */
  liveCount(): number {
    return this.all().filter(
      (r) => r.state.phase === "lobby" || r.state.phase === "running",
    ).length;
  }

  socketCount(): number {
    return this.all().reduce((n, r) => n + r.clients.size, 0);
  }
}

export const DEFAULT_ACTIVITIES: readonly Activity[] = [
  { id: "ttx", title: "Agentic Security TTX", kind: "manual", spotCap: 2 },
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];
