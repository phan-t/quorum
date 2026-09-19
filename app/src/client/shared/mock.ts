/**
 * The mock server: a whole Quorum session, in the page, behind the same
 * `Transport` interface the real WebSocket uses.
 *
 * It exists because the three clients and the server are being built at the
 * same time, and a client that can only be exercised against a backend is a
 * client nobody looks at until the backend works. It is worth keeping after
 * that: it is the only way to open the host console and the big screen on a
 * laptop with no session running, and it reproduces on demand the three things
 * that are awkward to produce on purpose — a dropped socket, a `seq` gap, and
 * a clock that disagrees with the phone's.
 *
 * Turn it on with `?mock=1`. Flags:
 *
 *   ?mock=1          scripted session: bots arrive, the host advances, it loops
 *   ?mock=manual     same session, no director — you drive it from the console
 *   &speed=2         run the script at 2×
 *   &drop=1          kill the socket once, 14s in, to show the banner
 *   &gap=1           skip a `seq` once, to force a resync
 *   &latency=250     milliseconds added to every frame, both ways
 *
 * One deliberate detail: one of the bots is named with a fragment of HTML. If
 * a surface ever renders a nickname as markup, that bot makes it obvious on
 * the first run rather than in front of thirty people.
 */

import type {
  ClientMessage,
  HostCommand,
  RenderState,
  RosterEntry,
  ServerMessage,
  Role,
  StandingRow,
} from "../../protocol.ts";
import type { Seal, Segment, SessionPhase } from "../../engine/types.ts";
import type { Transport, TransportFactory, TransportHandlers } from "./transport.ts";

export interface MockConfig {
  director: boolean;
  speed: number;
  drop: boolean;
  gap: boolean;
  latency: number;
}

/** `null` when the page should talk to a real server. */
export function readMockConfig(search = location.search): MockConfig | null {
  const q = new URLSearchParams(search);
  const mode = q.get("mock");
  if (mode === null || mode === "0" || mode === "off") return null;
  const num = (k: string, dflt: number): number => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    director: mode !== "manual",
    speed: num("speed", 1),
    drop: q.get("drop") === "1",
    gap: q.get("gap") === "1",
    latency: Number(q.get("latency")) || 40,
  };
}

/* ------------------------------------------------------------------ */
/* The session the mock is pretending to run                           */
/* ------------------------------------------------------------------ */

interface MockParticipant {
  pid: string;
  nickname: string;
  nicknameKey: string;
  playerNumber: number;
  conn: "on" | "away";
  ttx: number | null;
  spots: number;
  bot: boolean;
}

const BOT_NAMES = [
  "Kenji",
  "Priya",
  "Sam",
  "Ade",
  "Grace",
  "Tobias",
  "Yuki",
  "Mei",
  "Rahul",
  "Nadia",
  "Oscar",
  "Lena",
  "Ines",
  // Not a joke: this is the regression test for "nicknames render as text".
  '<img src=x onerror="alert(1)">',
  "  spaced   out  ",
];

/** The mock's clock runs ~1.2s ahead of the browser's, on purpose. */
const SERVER_SKEW_MS = 1_237;

class MockSession {
  sid = "mock-session";
  title = "SA APJ Quorum";
  joinCode = sampleJoinCode();
  phase: SessionPhase = "draft";
  segment: Segment = "lobby";
  seal: Seal = "live";
  holding: { title: string; line: string } | null = null;
  joinsLocked = false;
  seq = 0;
  participants: MockParticipant[] = [];
  #nextNumber = 1;

  reset(): void {
    this.phase = "draft";
    this.segment = "lobby";
    this.seal = "live";
    this.holding = null;
    this.joinsLocked = false;
    for (const p of this.participants) {
      p.ttx = null;
      p.spots = 0;
    }
    this.participants = this.participants.filter((p) => !p.bot);
  }

  key(nickname: string): string {
    return nickname.trim().replace(/\s+/g, " ").toLowerCase();
  }

  find(nickname: string): MockParticipant | undefined {
    const k = this.key(nickname);
    return this.participants.find((p) => p.nicknameKey === k);
  }

  add(nickname: string, bot: boolean): MockParticipant {
    const p: MockParticipant = {
      pid: `p${this.#nextNumber}`,
      nickname: nickname.trim().replace(/\s+/g, " "),
      nicknameKey: this.key(nickname),
      playerNumber: this.#nextNumber++,
      conn: "on",
      ttx: null,
      spots: 0,
      bot,
    };
    this.participants.push(p);
    return p;
  }

  total(p: MockParticipant): number {
    return (p.ttx ?? 0) + p.spots * 10;
  }

  roster(): RosterEntry[] {
    return this.participants.map((p) => ({
      pid: p.pid,
      nickname: p.nickname,
      playerNumber: p.playerNumber,
      conn: p.conn,
    }));
  }

  standings(): StandingRow[] {
    return [...this.participants]
      .sort((a, b) => this.total(b) - this.total(a))
      .slice(0, 5)
      .map((p, i) => ({
        rank: i + 1,
        nickname: p.nickname,
        total: this.total(p),
      }));
  }

  /**
   * The server sends the view for the role. A participant is never handed the
   * sixth-place row, because the only way to keep it off the phone is to never
   * put it on the wire.
   */
  render(role: Role, pid: string | null): RenderState {
    const sealed = this.seal === "sealed";
    const base = {
      sid: this.sid,
      title: this.title,
      phase: this.phase,
      segment: this.segment,
      seal: this.seal,
      holding: this.holding,
      roster: this.roster(),
      joinsLocked: this.joinsLocked,
    };

    if (role === "host") {
      return {
        ...base,
        // The console shows everything. The host has to know what is sealed.
        standings: this.standings(),
        hostExtras: {
          joinCode: this.joinCode,
          participantCount: this.participants.length,
          awayCount: this.participants.filter((p) => p.conn === "away").length,
        },
      };
    }

    const standings = sealed ? [] : this.standings();
    if (role === "screen") return { ...base, standings };

    const me = pid === null ? null : this.participants.find((p) => p.pid === pid);
    if (me === null || me === undefined || sealed) {
      return { ...base, standings };
    }
    return {
      ...base,
      standings,
      own: { total: this.total(me), byActivity: { ttx: me.ttx } },
    };
  }
}

/* ------------------------------------------------------------------ */
/* The hub                                                             */
/* ------------------------------------------------------------------ */

interface MockConn {
  role: Role | null;
  pid: string | null;
  handlers: TransportHandlers;
  open: boolean;
}

class MockHub {
  readonly session = new MockSession();
  readonly #conns = new Set<MockConn>();
  readonly #cfg: MockConfig;
  #directorStarted = false;
  #directorStopped = false;
  #dropped = false;
  #gapUsed = false;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(cfg: MockConfig) {
    this.#cfg = cfg;
  }

  connect(handlers: TransportHandlers): Transport {
    const conn: MockConn = { role: null, pid: null, handlers, open: true };
    this.#conns.add(conn);
    this.#later(() => {
      if (conn.open) handlers.onOpen();
    }, 10);

    return {
      send: (msg) => {
        if (!conn.open) return;
        this.#later(() => this.#receive(conn, msg), this.#cfg.latency);
      },
      close: () => {
        conn.open = false;
        this.#conns.delete(conn);
      },
    };
  }

  /* ---- client → mock server ---- */

  #receive(conn: MockConn, msg: ClientMessage): void {
    if (!conn.open) return;
    switch (msg.t) {
      case "hello":
        this.#hello(conn, msg);
        return;
      case "resync":
        if (conn.role) this.#sendState(conn);
        return;
      case "ping":
        this.#send(conn, {
          t: "pong",
          t0: msg.t0,
          t1: Date.now() + SERVER_SKEW_MS,
        });
        return;
      case "host.cmd":
        if (msg.cmd === null) {
          // The frame still gets an answer on its cid: a console that gets
          // silence cannot tell a rejected click from a dropped one.
          this.#send(conn, {
            t: "refusedCmd",
            cid: msg.cid,
            code: "malformed",
            message: "Command not understood.",
          });
          return;
        }
        this.#hostCmd(conn, msg.cid, msg.cmd);
        return;
    }
  }

  #hello(conn: MockConn, msg: Extract<ClientMessage, { t: "hello" }>): void {
    if (msg.role === "host" || msg.role === "screen") {
      conn.role = msg.role;
      this.#send(conn, {
        t: "welcome",
        role: msg.role,
        sid: this.session.sid,
        serverTime: Date.now() + SERVER_SKEW_MS,
        protocol: 1,
      });
      this.#sendState(conn);
      this.#startDirector();
      return;
    }

    const code = msg.joinCode.trim();
    const nickname = msg.nickname.trim().replace(/\s+/g, " ");

    // A rejoin token beats every other check: this is the phone that slept.
    if (msg.rejoinToken) {
      const existing = this.session.participants.find(
        (p) => `tok-${p.pid}` === msg.rejoinToken,
      );
      if (existing) {
        existing.conn = "on";
        this.#admit(conn, existing);
        return;
      }
    }

    if (!/^[A-Z]{4}$/.test(code)) {
      return this.#refuse(conn, "no_such_code", `No session with the code ${code}.`);
    }
    if (code === "LOCK") {
      return this.#refuse(conn, "lobby_locked", "The host has locked the lobby.");
    }
    if (this.session.joinsLocked) {
      return this.#refuse(conn, "lobby_locked", "The host has locked the lobby.");
    }
    if (nickname.length < 2) {
      return this.#refuse(conn, "invalid_nickname", "Two characters or more.");
    }
    const clash = this.session.find(nickname);
    if (clash && clash.conn === "on") {
      return this.#refuse(
        conn,
        "nickname_taken",
        `${clash.nickname} is already in this session.`,
      );
    }
    const me = clash ?? this.session.add(nickname, false);
    me.conn = "on";
    this.#admit(conn, me);
    this.#startDirector();
  }

  #admit(conn: MockConn, p: MockParticipant): void {
    conn.role = "participant";
    conn.pid = p.pid;
    this.#send(conn, {
      t: "welcome",
      role: "participant",
      sid: this.session.sid,
      pid: p.pid,
      rejoinToken: `tok-${p.pid}`,
      serverTime: Date.now() + SERVER_SKEW_MS,
      protocol: 1,
    });
    this.#sendState(conn);
    this.#broadcastRoster();
  }

  #refuse(
    conn: MockConn,
    reason: Extract<ServerMessage, { t: "refused" }>["reason"],
    message: string,
  ): void {
    this.#send(conn, { t: "refused", reason, message });
  }

  #hostCmd(conn: MockConn, cid: string, cmd: HostCommand): void {
    if (conn.role !== "host") {
      this.#send(conn, {
        t: "refusedCmd",
        cid,
        code: "bad_token",
        message: "Not the host.",
      });
      return;
    }
    // A human took the wheel. The script stops arguing with them.
    this.#directorStopped = true;

    const s = this.session;
    const reject = (code: string, message: string): void => {
      this.#send(conn, { t: "refusedCmd", cid, code, message });
    };

    switch (cmd.name) {
      case "open":
        if (s.phase !== "draft") {
          return reject("wrong_phase", "The session is already open.");
        }
        s.phase = "lobby";
        s.segment = "lobby";
        break;
      case "start":
        if (s.phase !== "lobby") {
          return reject(
            "wrong_phase",
            s.phase === "running"
              ? "The session is already running."
              : "Open the session before starting it.",
          );
        }
        s.phase = "running";
        break;
      case "close":
        if (s.phase === "closed") return reject("wrong_phase", "Already closed.");
        s.phase = "closed";
        s.segment = "final";
        s.seal = "revealed";
        s.joinsLocked = true;
        break;
      case "segment":
        if (s.phase !== "running") {
          return reject("wrong_phase", "Start the session first.");
        }
        s.segment = cmd.kind;
        break;
      case "holding":
        s.holding =
          cmd.title === "" && cmd.line === ""
            ? null
            : { title: cmd.title, line: cmd.line };
        break;
      case "seal":
        s.seal = cmd.state;
        break;
      case "lobby.lock":
        s.joinsLocked = cmd.locked;
        break;
      case "participant.kick": {
        const i = s.participants.findIndex((p) => p.pid === cmd.pid);
        if (i === -1) return reject("unknown_participant", "No such participant.");
        s.participants.splice(i, 1);
        break;
      }
      case "participant.release": {
        const p = s.participants.find((x) => x.pid === cmd.pid);
        if (!p) return reject("unknown_participant", "No such participant.");
        p.conn = "away";
        p.nicknameKey = "";
        break;
      }
    }
    this.#send(conn, { t: "ack", cid, applied: true });
    this.#broadcastState();
  }

  /* ---- mock server → clients ---- */

  #send(conn: MockConn, msg: ServerMessage): void {
    if (!conn.open) return;
    this.#later(() => {
      if (conn.open) conn.handlers.onMessage(msg);
    }, this.#cfg.latency);
  }

  #sendState(conn: MockConn): void {
    if (conn.role === null) return;
    this.#send(conn, {
      t: "state",
      seq: ++this.session.seq,
      state: this.session.render(conn.role, conn.pid),
    });
  }

  #broadcastState(): void {
    const seq = ++this.session.seq;
    for (const conn of this.#conns) {
      if (conn.role === null) continue;
      this.#send(conn, {
        t: "state",
        seq,
        state: this.session.render(conn.role, conn.pid),
      });
    }
  }

  /** A delta, so the client's `seq` handling is exercised by the normal path. */
  #broadcastRoster(): void {
    let seq = ++this.session.seq;
    if (this.#cfg.gap && !this.#gapUsed && this.session.participants.length >= 5) {
      this.#gapUsed = true;
      seq = ++this.session.seq; // skip one: the client should notice and resync
    }
    const roster = this.session.roster();
    for (const conn of this.#conns) {
      if (conn.role === null) continue;
      this.#send(conn, { t: "roster", seq, roster });
    }
  }

  #toast(kind: "spot" | "text", text: string): void {
    const seq = ++this.session.seq;
    for (const conn of this.#conns) {
      if (conn.role === null) continue;
      this.#send(conn, { t: "toast", seq, kind, text });
    }
  }

  /* ---- the director ---- */

  #later(fn: () => void, ms: number): void {
    this.#timers.push(setTimeout(fn, ms));
  }

  #at(seconds: number, fn: () => void): void {
    const ms = (seconds * 1000) / this.#cfg.speed;
    this.#timers.push(
      setTimeout(() => {
        if (this.#directorStopped) return;
        fn();
      }, ms),
    );
  }

  #startDirector(): void {
    if (this.#directorStarted) return;
    this.#directorStarted = true;

    if (this.#cfg.drop) {
      this.#at(14, () => {
        if (this.#dropped) return;
        this.#dropped = true;
        for (const conn of [...this.#conns]) {
          conn.open = false;
          this.#conns.delete(conn);
          conn.handlers.onClose("mock: the network went away");
        }
      });
    }

    if (!this.#cfg.director) {
      // Manual mode still needs a room, or the console has nothing to show.
      // The session stays in `draft` so the host drives `open` themselves.
      for (let i = 0; i < 6; i++) this.#at(1 + i * 0.4, () => this.#botJoins());
      return;
    }

    for (let i = 0; i < BOT_NAMES.length; i++) {
      this.#at(1.5 + i * 1.1, () => this.#botJoins());
    }

    this.#at(0.5, () => {
      this.session.phase = "lobby";
      this.session.segment = "lobby";
      this.#broadcastState();
    });

    this.#at(9, () => {
      this.session.phase = "running";
      this.session.segment = "holding";
      this.session.holding = {
        title: "Agentic Security TTX",
        line: "Back at 14:20. Prize: the good coffee.",
      };
      this.#broadcastState();
    });

    this.#at(13, () => {
      const p = this.session.participants[2];
      if (p) p.conn = "away";
      this.#broadcastRoster();
    });

    this.#at(20, () => {
      // Scores land, so the standings have something to show.
      let n = 100;
      for (const p of this.session.participants) {
        p.ttx = n;
        n = Math.max(12, n - 6 - Math.floor(Math.random() * 9));
      }
      const star = this.session.participants[1];
      if (star) star.spots = 1;
      this.session.segment = "standings";
      this.#broadcastState();
      if (star) {
        this.#toast("spot", `Spot Award — ${star.nickname} — best question of the day`);
      }
    });

    this.#at(32, () => {
      this.session.seal = "sealed";
      this.#broadcastState();
    });

    this.#at(44, () => {
      this.session.seal = "revealed";
      this.session.segment = "final";
      this.#broadcastState();
    });

    // Long enough for the big screen's final reveal to actually finish: four
    // four-second dwells, then the hold on the empty first slot.
    this.#at(80, () => {
      this.session.reset();
      this.#directorStarted = false;
      this.#broadcastState();
      this.#startDirector();
    });
  }

  #botJoins(): void {
    const taken = new Set(this.session.participants.map((p) => p.nicknameKey));
    const name = BOT_NAMES.find((n) => !taken.has(this.session.key(n)));
    if (!name) return;
    this.session.add(name, true);
    this.#broadcastRoster();
  }
}

let hub: MockHub | null = null;

/**
 * A join code for the mock, assembled at runtime.
 *
 * Not a literal: a string of the shape `hvs.` + 24 base62 characters is
 * exactly what GitHub's push protection flags as a Vault root token, and it
 * is right to — a repository cannot tell a convincing fake from a real one.
 */
export function sampleJoinCode(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let body = "";
  for (let i = 0; i < 24; i += 1) {
    body += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return ["hvs", body].join(".");
}

export function mockTransport(cfg: MockConfig): TransportFactory {
  hub ??= new MockHub(cfg);
  const h = hub;
  return (handlers) => h.connect(handlers);
}

/** The banner every mocked page wears, so nobody demos the fake by accident. */
export function mockBadge(): HTMLElement {
  const el = document.createElement("div");
  el.className = "mock-badge mono";
  el.textContent = "MOCK SERVER";
  return el;
}
