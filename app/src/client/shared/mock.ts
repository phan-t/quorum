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
 *                    (an empty grid, and the scoring is yours to type)
 *   &speed=2         run the script at 2×
 *   &drop=1          kill the socket once, 14s in, to show the banner
 *   &gap=1           skip a `seq` once, to force a resync
 *   &latency=250     milliseconds added to every frame, both ways
 *
 * One deliberate detail: one of the bots is named with a fragment of HTML. If
 * a surface ever renders a nickname as markup, that bot makes it obvious on
 * the first run rather than in front of thirty people.
 *
 * The scripted session runs the whole of Phase 2 scoring, so every surface can
 * be watched without a backend: a judged activity out of 20 with its
 * facilitator on bench, a trivia activity in the thousands with a different
 * one, two Spot Awards with reasons, then the seal and the reveal. The
 * arithmetic here is SCORING.md's, implemented a second time on purpose — the
 * mock is a stand-in for the server and must not borrow the engine to agree
 * with it.
 */

import type {
  ActivitySummary,
  ClientMessage,
  HostCommand,
  RenderState,
  RosterEntry,
  ScoreRow,
  ServerMessage,
  Role,
  StandingRow,
} from "../../protocol.ts";
import type {
  Seal,
  ScoreStatus,
  Segment,
  SessionPhase,
} from "../../engine/types.ts";
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
  /**
   * activityId -> what the host typed. Benching clears it, exactly as the
   * reducer does: a raw score that is no longer meaningful must not reappear
   * if the status flips back.
   */
  raw: Record<string, number>;
  status: Record<string, ScoreStatus>;
  bot: boolean;
}

interface MockSpot {
  seq: number;
  pid: string;
  activityId: string;
  reason: string;
}

/** One participant's line of the board, before it is projected to a role. */
interface MockRow {
  p: MockParticipant;
  /** Normalised points, or the bench credit, per activity. Null for unset. */
  points: Record<string, number | null>;
  bench: string[];
  spot: number;
  total: number;
  rank: number;
}

/** The three the server ships with — `DEFAULT_ACTIVITIES` in runtime.ts. */
const ACTIVITIES: readonly Omit<ActivitySummary, "spotsLeft">[] = [
  { id: "ttx", title: "Agentic Security TTX", kind: "manual", spotCap: 2 },
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

const SPOT_AWARD_POINTS = 10;

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
  spots: MockSpot[] = [];
  #nextNumber = 1;
  #nextSpotSeq = 1;

  reset(): void {
    this.phase = "draft";
    this.segment = "lobby";
    this.seal = "live";
    this.holding = null;
    this.joinsLocked = false;
    this.spots = [];
    for (const p of this.participants) {
      p.raw = {};
      p.status = {};
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
      raw: {},
      status: {},
      bot,
    };
    this.participants.push(p);
    return p;
  }

  find_pid(pid: string): MockParticipant | undefined {
    return this.participants.find((p) => p.pid === pid);
  }

  activity(id: string): (typeof ACTIVITIES)[number] | undefined {
    return ACTIVITIES.find((a) => a.id === id);
  }

  grantSpot(pid: string, activityId: string, reason: string): MockSpot {
    const spot: MockSpot = {
      seq: this.#nextSpotSeq++,
      pid,
      activityId,
      reason: reason.trim(),
    };
    this.spots.push(spot);
    return spot;
  }

  spotsLeft(activityId: string): number {
    const cap = this.activity(activityId)?.spotCap ?? 0;
    return Math.max(0, cap - this.spots.filter((s) => s.activityId === activityId).length);
  }

  /* ---- scoring: SCORING.md, and nothing else ---- */

  /**
   * Normalise one activity: the top raw among `played` becomes 100, everyone
   * else `round(100 × raw ÷ top)`. Bench is excluded from the top — a
   * facilitator's absence must not set the ceiling for the room.
   */
  #normalise(activityId: string): Map<string, number> {
    let top = 0;
    for (const p of this.participants) {
      if (p.status[activityId] !== "played") continue;
      top = Math.max(top, p.raw[activityId] ?? 0);
    }
    const out = new Map<string, number>();
    for (const p of this.participants) {
      if (p.status[activityId] !== "played") continue;
      // A top of 0 means nobody scored: everyone gets 0, never NaN.
      out.set(p.pid, top > 0 ? Math.round((100 * (p.raw[activityId] ?? 0)) / top) : 0);
    }
    return out;
  }

  /** The whole board, ranked. Ties share a rank and the next rank skips. */
  board(): MockRow[] {
    const normalised = new Map<string, Map<string, number>>();
    for (const a of ACTIVITIES) normalised.set(a.id, this.#normalise(a.id));

    const rows = this.participants.map((p) => {
      const played: number[] = [];
      for (const a of ACTIVITIES) {
        const pts = normalised.get(a.id)?.get(p.pid);
        if (pts !== undefined) played.push(pts);
      }
      // Bench Credit: the mean of their own normalised points where they
      // played in full. Null — not zero — before they have played anything.
      const credit =
        played.length === 0
          ? null
          : Math.round(played.reduce((x, y) => x + y, 0) / played.length);

      const points: Record<string, number | null> = {};
      const bench: string[] = [];
      for (const a of ACTIVITIES) {
        const pts = normalised.get(a.id)?.get(p.pid);
        if (pts !== undefined) {
          points[a.id] = pts;
        } else if (p.status[a.id] === "bench") {
          points[a.id] = credit;
          bench.push(a.id);
        } else {
          points[a.id] = null;
        }
      }
      // An award for an activity they are now benched for does not count:
      // benching after a grant would otherwise be a back door to keeping it.
      const spot =
        this.spots.filter(
          (s) => s.pid === p.pid && p.status[s.activityId] !== "bench",
        ).length * SPOT_AWARD_POINTS;
      const total =
        ACTIVITIES.reduce((n, a) => n + (points[a.id] ?? 0), 0) + spot;
      return { p, points, bench, spot, total };
    });

    rows.sort(
      (a, b) => b.total - a.total || a.p.nickname.localeCompare(b.p.nickname),
    );

    const out: MockRow[] = [];
    let rank = 0;
    let seen = 0;
    let prev: number | null = null;
    for (const r of rows) {
      seen += 1;
      if (prev === null || r.total !== prev) {
        rank = seen;
        prev = r.total;
      }
      out.push({ ...r, rank });
    }
    return out;
  }

  roster(): RosterEntry[] {
    return this.participants.map((p) => ({
      pid: p.pid,
      nickname: p.nickname,
      playerNumber: p.playerNumber,
      conn: p.conn,
    }));
  }

  #row(r: MockRow): StandingRow {
    return {
      rank: r.rank,
      nickname: r.p.nickname,
      total: r.total,
      perActivity: { ...r.points },
      bench: [...r.bench],
      spot: r.spot,
    };
  }

  /** Top five, expanding a tie at fifth. Console and export only. */
  #topFive(board: readonly MockRow[]): MockRow[] {
    if (board.length <= 5) return [...board];
    const fifth = board[4];
    if (!fifth) return [...board];
    return board.filter((r) => r.total >= fifth.total);
  }

  /**
   * What may go on the wire to a phone or the big screen: a hard five, and
   * nothing at all before anyone has scored — an unscored board is an
   * alphabetical slice of the room, not a leaderboard.
   */
  #publicRows(board: readonly MockRow[]): MockRow[] {
    if (!board.some((r) => r.total > 0)) return [];
    return this.#topFive(board).slice(0, 5);
  }

  #scoreRows(board: readonly MockRow[]): ScoreRow[] {
    return board.map((r) => {
      const raw: Record<string, number | null> = {};
      const status: Record<string, ScoreStatus> = {};
      for (const a of ACTIVITIES) {
        const st = r.p.status[a.id] ?? "unset";
        status[a.id] = st;
        raw[a.id] = st === "played" ? (r.p.raw[a.id] ?? 0) : null;
      }
      return {
        pid: r.p.pid,
        nickname: r.p.nickname,
        playerNumber: r.p.playerNumber,
        raw,
        status,
        points: { ...r.points },
        spot: r.spot,
        total: r.total,
        rank: r.rank,
      };
    });
  }

  activities(): ActivitySummary[] {
    return ACTIVITIES.map((a) => ({ ...a, spotsLeft: this.spotsLeft(a.id) }));
  }

  /**
   * The server sends the view for the role. A participant is never handed the
   * sixth-place row, because the only way to keep it off the phone is to never
   * put it on the wire.
   */
  render(role: Role, pid: string | null): RenderState {
    const sealed = this.seal === "sealed";
    const board = this.board();
    const base = {
      sid: this.sid,
      title: this.title,
      phase: this.phase,
      segment: this.segment,
      seal: this.seal,
      holding: this.holding,
      roster: this.roster(),
      joinsLocked: this.joinsLocked,
      activities: this.activities(),
    };

    if (role === "host") {
      return {
        ...base,
        // The console shows everything. Sealing is about what the *room* sees,
        // and a host cannot run the session blind.
        standings: this.#topFive(board).map((r) => this.#row(r)),
        joinCode: this.joinCode,
        hostExtras: {
          joinCode: this.joinCode,
          participantCount: this.participants.length,
          awayCount: this.participants.filter((p) => p.conn === "away").length,
          scores: this.#scoreRows(board),
          spots: this.spots.map((s) => ({
            seq: s.seq,
            pid: s.pid,
            activityId: s.activityId,
            reason: s.reason,
          })),
        },
      };
    }

    const standings = sealed ? [] : this.#publicRows(board).map((r) => this.#row(r));
    if (role === "screen") return { ...base, standings, joinCode: this.joinCode };

    const me = pid === null ? null : board.find((r) => r.p.pid === pid);
    // Sealed omits `own` entirely. The phone has nothing to fall back on, by
    // design: a total it kept through the seal is a sealed total on screen.
    if (me === null || me === undefined || sealed) {
      return { ...base, standings };
    }
    return {
      ...base,
      standings,
      own: { total: me.total, byActivity: { ...me.points } },
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

    // The shape the join form produces, and any code of that shape is this
    // session: the mock has exactly one. (It used to insist on four capitals,
    // which no join link has produced since the codes became `hvs.` tokens —
    // it refused every participant who tried to join the mock.)
    if (!/^hvs\.[0-9A-Za-z]{8,64}$/.test(code)) {
      return this.#refuse(conn, "no_such_code", `No session with the code ${code}.`);
    }
    // …except one, kept so the locked-lobby refusal is still demonstrable.
    if (/lock$/i.test(code)) {
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
    /** Understood, allowed, and changed nothing. The engine acks these false. */
    const noop = (): void => {
      this.#send(conn, { t: "ack", cid, applied: false });
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

      /* ---- scoring ---- */

      case "score.set": {
        const activity = s.activity(cmd.activityId);
        if (!activity) return reject("unknown_activity", `No activity ${cmd.activityId}.`);
        const p = s.find_pid(cmd.pid);
        if (!p) return reject("unknown_participant", "No such participant.");
        if (!Number.isFinite(cmd.raw) || cmd.raw < 0) {
          return reject(
            "invalid_score",
            "A raw score must be a finite number, zero or above.",
          );
        }
        // Scoring someone on bench credit is refused rather than stored: the
        // raw would reappear if they were ever un-benched.
        if (p.status[cmd.activityId] === "bench") {
          return reject(
            "bench_cannot_be_scored",
            `${p.nickname} is on bench credit for ${activity.title}.`,
          );
        }
        if (p.status[cmd.activityId] === "played" && p.raw[cmd.activityId] === cmd.raw) {
          return noop();
        }
        p.raw[cmd.activityId] = cmd.raw;
        p.status[cmd.activityId] = "played";
        break;
      }

      case "score.status": {
        const activity = s.activity(cmd.activityId);
        if (!activity) return reject("unknown_activity", `No activity ${cmd.activityId}.`);
        const p = s.find_pid(cmd.pid);
        if (!p) return reject("unknown_participant", "No such participant.");
        if ((p.status[cmd.activityId] ?? "unset") === cmd.status) return noop();
        // Benching discards the raw, exactly as the reducer does.
        if (cmd.status === "played") p.raw[cmd.activityId] = p.raw[cmd.activityId] ?? 0;
        else p.raw[cmd.activityId] = 0;
        p.status[cmd.activityId] = cmd.status;
        break;
      }

      case "spot.grant": {
        const activity = s.activity(cmd.activityId);
        if (!activity) return reject("unknown_activity", `No activity ${cmd.activityId}.`);
        const p = s.find_pid(cmd.pid);
        if (!p) return reject("unknown_participant", "No such participant.");
        // The console must never send this, but the server refuses it anyway:
        // a field that may be blank will be blank.
        if (cmd.reason.trim() === "") {
          return reject(
            "reason_required",
            "A Spot Award needs a reason — it gets read out.",
          );
        }
        if (p.status[cmd.activityId] === "bench") {
          return reject(
            "bench_cannot_receive_spot",
            "They are on bench credit for this activity.",
          );
        }
        if (s.spotsLeft(cmd.activityId) <= 0) {
          return reject("spot_cap_reached", `No Spot Awards left for ${activity.title}.`);
        }
        const spot = s.grantSpot(cmd.pid, cmd.activityId, cmd.reason);
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#broadcastState();
        this.#toast("spot", `Spot Award — ${p.nickname} — ${spot.reason}`);
        return;
      }

      case "spot.revoke": {
        const before = s.spots.length;
        s.spots = s.spots.filter((sp) => sp.seq !== cmd.seq);
        if (s.spots.length === before) return noop();
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
      // The host's counts and the whole scoring grid live in `hostExtras`,
      // which a roster frame does not carry: a delta would leave the console
      // one joiner behind. They get the whole thing; there is one of them.
      // This is what the real server does — see runtime.ts broadcastRoster.
      if (conn.role === "host") {
        this.#send(conn, {
          t: "state",
          seq,
          state: this.session.render("host", conn.pid),
        });
        continue;
      }
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

    // The TTX: a judged rubric out of 20, and the facilitator who ran it on
    // bench. Raw units differ wildly from the trivia below on purpose — that
    // is the whole reason SCORING.md normalises instead of adding.
    this.#at(18, () => {
      const people = this.session.participants;
      people.forEach((p, i) => {
        if (i === 3) {
          // Ade ran this one. Bench Credit, not a zero.
          p.status["ttx"] = "bench";
          p.raw["ttx"] = 0;
          return;
        }
        p.raw["ttx"] = Math.max(4, 20 - i - Math.floor(Math.random() * 3));
        p.status["ttx"] = "played";
      });
      this.session.segment = "standings";
      this.#broadcastState();
    });

    this.#at(22, () => {
      const star = this.session.participants[1];
      if (!star) return;
      const spot = this.session.grantSpot(star.pid, "ttx", "best question of the day");
      this.#broadcastState();
      this.#toast("spot", `Spot Award — ${star.nickname} — ${spot.reason}`);
    });

    // Trivia: speed-weighted, in the thousands, and a different facilitator.
    this.#at(26, () => {
      const people = this.session.participants;
      people.forEach((p, i) => {
        if (i === 1) {
          p.status["trivia"] = "bench";
          p.raw["trivia"] = 0;
          return;
        }
        p.raw["trivia"] = Math.max(
          800,
          18_400 - i * 900 - Math.floor(Math.random() * 700),
        );
        p.status["trivia"] = "played";
      });
      this.#broadcastState();
    });

    this.#at(30, () => {
      const p = this.session.participants[4];
      if (!p) return;
      const spot = this.session.grantSpot(
        p.pid,
        "trivia",
        "drew out someone who had not spoken",
      );
      this.#broadcastState();
      this.#toast("spot", `Spot Award — ${p.nickname} — ${spot.reason}`);
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
