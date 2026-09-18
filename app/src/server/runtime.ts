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
  /** Append-only, for replay and for settling a scoring dispute after the fact. */
  readonly log: EventRecord[] = [];

  constructor(state: SessionState, secrets: SessionSecrets) {
    this.state = state;
    this.secrets = secrets;
  }

  /* ---------------- participants ---------------- */

  issueRejoinToken(pid: ParticipantId): string {
    const token = newToken();
    this.rejoin.set(hashToken(token), pid);
    return token;
  }

  pidForRejoin(token: string): ParticipantId | undefined {
    return this.rejoin.get(hashToken(token));
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
    const result = reduce(this.state, event, now);
    this.state = result.state;

    if (result.applied) {
      this.log.push({ seq: this.state.seq, event, at: now });
    }

    let rejection: { code: string; message: string } | undefined;
    let sendState = false;
    let sendRoster = false;

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
          // Phase 1 keeps the log in memory; Phase 2 writes it to DynamoDB.
          break;
      }
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

  add(state: SessionState): CreatedSession {
    const hostToken = newToken();
    const screenToken = newToken();
    const runtime = new SessionRuntime(state, {
      hostTokenHash: hashToken(hostToken),
      screenTokenHash: hashToken(screenToken),
    });
    this.bySid.set(state.sid, runtime);
    this.byCode.set(state.joinCode.toUpperCase(), state.sid);
    return { runtime, hostToken, screenToken };
  }

  bySessionId(sid: string): SessionRuntime | undefined {
    return this.bySid.get(sid);
  }

  byJoinCode(code: string): SessionRuntime | undefined {
    const sid = this.byCode.get(code.trim().toUpperCase());
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
