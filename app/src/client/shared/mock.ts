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
 * The scripted session runs the whole of Phase 2 scoring and the whole of
 * Phase 3 trivia, so every surface can be watched without a backend: a judged
 * activity out of 20 with its facilitator on bench, then four real questions
 * with bots tapping at plausible speeds — including a round card, a
 * multi-answer question, a two-answer question and a sudden death — two Spot
 * Awards with reasons, then the seal and the reveal.
 *
 * The arithmetic here is SCORING.md's and SPEC.md's, implemented a second
 * time on purpose — the mock is a stand-in for the server and must not borrow
 * the engine to agree with it. The projection is implemented a second time
 * for the same reason, which matters more here than anywhere: if the mock
 * copied views.ts, the one thing it could never catch is views.ts putting the
 * correct answer on a phone.
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
  TriviaMine,
  TriviaPodiumRow,
  TriviaRound,
  TriviaView,
} from "../../protocol.ts";
import type {
  QuestionPhase,
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

/* ---- trivia ---- */

interface MockQuestion {
  text: string;
  answers: string[];
  timeLimitSec: number;
  /** 0-based here, as in the engine. The CSV's 1-based column is the importer's problem. */
  correct: number[];
  note: string | null;
  round: string | null;
  basePoints: number;
}

/**
 * Four questions out of SPEC.md's own CSV example, chosen to exercise the
 * shapes that break layouts: a long question, a two-answer question, a
 * multi-answer question, a note, and a pair sharing a `Round` so the round
 * card has something to appear for.
 */
const QUESTIONS: readonly MockQuestion[] = [
  {
    text: "In what year was HashiCorp founded?",
    answers: ["2008", "2010", "2012", "2015"],
    timeLimitSec: 15,
    correct: [1],
    note: null,
    round: "History",
    basePoints: 1000,
  },
  {
    text: "Which product does secrets management, encryption as a service and dynamic credentials?",
    answers: ["Consul", "Boundary", "Vault", "Nomad"],
    timeLimitSec: 15,
    correct: [2],
    note: "Dynamic credentials are the bit people forget.",
    round: "Name that product",
    basePoints: 1000,
  },
  {
    text: "Which product's brand colour is purple?",
    answers: ["Vault", "Consul", "Terraform", "Nomad"],
    timeLimitSec: 10,
    correct: [2],
    note: null,
    round: "Brand",
    basePoints: 500,
  },
  {
    // Kahoot semantics: any listed answer counts. And two answers only, which
    // is the case a 2 x 2 grid gets wrong if nobody checks it.
    text: "Which of these is a HashiCorp product?",
    answers: ["Waypoint", "Sentinel"],
    timeLimitSec: 10,
    correct: [0, 1],
    note: "Both. Waypoint is the deploy one; Sentinel is policy as code.",
    round: "Brand",
    basePoints: 1000,
  },
];

interface MockAnswer {
  choice: number;
  correct: boolean;
  ms: number;
  points: number;
  streakBonus: number;
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
  spots: MockSpot[] = [];
  #nextNumber = 1;
  #nextSpotSeq = 1;

  /* ---- trivia ---- */
  questions: readonly MockQuestion[] = QUESTIONS;
  at = 0;
  questionPhase: QuestionPhase = "idle";
  opensAt: number | null = null;
  closesAt: number | null = null;
  suddenDeath = false;
  suddenDeathWinner: string | null = null;
  answers: Record<string, MockAnswer> = {};
  triviaTotals: Record<string, number> = {};
  triviaStreaks: Record<string, number> = {};

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
    this.at = 0;
    this.questionPhase = "idle";
    this.opensAt = null;
    this.closesAt = null;
    this.suddenDeath = false;
    this.suddenDeathWinner = null;
    this.answers = {};
    this.triviaTotals = {};
    this.triviaStreaks = {};
  }

  question(): MockQuestion | undefined {
    return this.questions[this.at];
  }

  /**
   * SPEC.md's arithmetic, written out rather than imported: base points
   * scaled so an answer at the buzzer is worth half an instant one, never
   * less, plus `100 x min(n - 1, 5)` for the n-th consecutive correct answer.
   *
   * Settled at close, not at answer time, because a participant's own state
   * must carry no correctness signal while the question is open.
   */
  settleQuestion(): void {
    const q = this.question();
    if (!q) return;
    for (const p of this.participants) {
      const a = this.answers[p.pid];
      if (!a) {
        this.triviaStreaks[p.pid] = 0;
        continue;
      }
      if (!a.correct || this.suddenDeath) {
        if (!a.correct) this.triviaStreaks[p.pid] = 0;
        continue;
      }
      const t = Math.min(a.ms, q.timeLimitSec * 1000);
      const points = Math.round(q.basePoints * (1 - t / (q.timeLimitSec * 1000) / 2));
      const streak = (this.triviaStreaks[p.pid] ?? 0) + 1;
      const streakBonus = 100 * Math.min(streak - 1, 5);
      this.triviaStreaks[p.pid] = streak;
      a.points = points;
      a.streakBonus = streakBonus;
      this.triviaTotals[p.pid] = (this.triviaTotals[p.pid] ?? 0) + points + streakBonus;
    }
    // Sudden death moves no points, so it must not move the scoreboard either.
    if (this.suddenDeath) return;
    for (const p of this.participants) {
      if (p.status["trivia"] === "bench") continue;
      p.raw["trivia"] = this.triviaTotals[p.pid] ?? 0;
      p.status["trivia"] = "played";
    }
  }

  /** The run of consecutive questions sharing a `Round`, if there is one. */
  round(index: number): TriviaRound | null {
    const here = this.questions[index];
    if (!here || here.round === null) return null;
    let first = index;
    while (first > 0 && this.questions[first - 1]?.round === here.round) first -= 1;
    let last = index;
    while (
      last + 1 < this.questions.length &&
      this.questions[last + 1]?.round === here.round
    ) {
      last += 1;
    }
    const size = last - first + 1;
    if (size < 2) return null;
    return { name: here.round, position: index - first + 1, size, startsHere: index === first };
  }

  triviaPodium(): TriviaPodiumRow[] {
    const rows = this.participants
      .map((p) => ({ p, points: this.triviaTotals[p.pid] ?? 0 }))
      .sort((a, b) => b.points - a.points || a.p.nickname.localeCompare(b.p.nickname));
    if (!rows.some((r) => r.points > 0)) return [];
    const out: TriviaPodiumRow[] = [];
    let rank = 0;
    let seen = 0;
    let prev: number | null = null;
    for (const r of rows) {
      seen += 1;
      if (prev === null || r.points !== prev) {
        rank = seen;
        prev = r.points;
      }
      if (out.length === 5) break;
      out.push({ rank, nickname: r.p.nickname, points: r.points });
    }
    return out;
  }

  /**
   * The trivia block, projected for one role.
   *
   * Written from SPEC.md rather than copied from views.ts, and the optional
   * fields are *omitted* rather than nulled, so a phone's frame does not
   * contain the word `correct` at all until the reveal. If this and the real
   * server ever disagree about that, the disagreement is the bug worth having
   * found.
   */
  triviaView(role: Role): TriviaView | undefined {
    const q = this.question();
    if (!q) return undefined;
    const host = role === "host";
    const revealed = this.questionPhase === "revealed";
    const visible = host || this.questionPhase !== "idle";
    const winner =
      this.suddenDeathWinner === null
        ? null
        : (this.find_pid(this.suddenDeathWinner)?.nickname ?? null);

    const view: TriviaView = {
      activityId: "trivia",
      index: this.at,
      of: this.questions.length,
      phase: this.questionPhase,
      text: visible ? q.text : "",
      answers: visible ? q.answers : [],
      opensAt: this.opensAt,
      closesAt: this.closesAt,
      timeLimitSec: q.timeLimitSec,
      basePoints: q.basePoints,
      suddenDeath: this.suddenDeath,
      suddenDeathWinner: winner,
      round: this.round(this.at),
    };

    const distribution = new Array<number>(q.answers.length).fill(0);
    for (const a of Object.values(this.answers)) {
      const at = distribution[a.choice];
      if (at !== undefined) distribution[a.choice] = at + 1;
    }

    return {
      ...view,
      ...(host || revealed ? { correct: q.correct } : {}),
      ...((host || revealed) && q.note !== null ? { note: q.note } : {}),
      ...(host || (role === "screen" && revealed) ? { distribution } : {}),
      ...(revealed ? { podium: this.triviaPodium() } : {}),
      ...(host || role === "screen"
        ? { answered: Object.keys(this.answers).length, eligible: this.participants.length }
        : {}),
    };
  }

  /** Three states, and the middle one is "locked in" and nothing else. */
  triviaMine(pid: string): TriviaMine {
    const mine = this.answers[pid];
    if (this.questionPhase !== "revealed") {
      return mine === undefined
        ? { state: "unanswered" }
        : { state: "locked", choice: mine.choice };
    }
    return {
      state: "revealed",
      choice: mine?.choice ?? null,
      correct: mine?.correct ?? false,
      points: mine?.points ?? 0,
      streakBonus: mine?.streakBonus ?? 0,
      streak: this.triviaStreaks[pid] ?? 0,
      total: this.triviaTotals[pid] ?? 0,
    };
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

    const trivia = this.triviaView(role);
    const withTrivia = trivia ? { ...base, trivia } : base;

    if (role === "host") {
      return {
        ...withTrivia,
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
          trivia: {
            answeredBy: Object.keys(this.answers),
            loaded: this.questions.length,
          },
        },
      };
    }

    const standings = sealed ? [] : this.#publicRows(board).map((r) => this.#row(r));
    if (role === "screen") {
      return { ...withTrivia, standings, joinCode: this.joinCode };
    }

    const mine = pid === null ? undefined : this.triviaMine(pid);
    const forPhone = mine ? { ...withTrivia, triviaMine: mine } : withTrivia;
    const me = pid === null ? null : board.find((r) => r.p.pid === pid);
    // Sealed omits `own` entirely. The phone has nothing to fall back on, by
    // design: a total it kept through the seal is a sealed total on screen.
    if (me === null || me === undefined || sealed) {
      return { ...forPhone, standings };
    }
    return {
      ...forPhone,
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
  /**
   * Frames sent to *this* connection, as the real server counts them.
   *
   * It used to be one counter for the whole session, which was fine while
   * every broadcast went to everybody. A trivia answer does not: it is
   * addressed to the phone that sent it, the console and the big screen. With
   * a shared counter the other twenty-six phones would see the next delta
   * skip, decide they had missed a frame, and all resync at once — a bug in
   * the mock that looks exactly like a bug in the product.
   */
  seq: number;
}

class MockHub {
  readonly session = new MockSession();
  readonly #conns = new Set<MockConn>();
  readonly #cfg: MockConfig;
  #directorStarted = false;
  #directorStopped = false;
  #dropped = false;
  #gapUsed = false;
  #gapNext = false;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(cfg: MockConfig) {
    this.#cfg = cfg;
  }

  connect(handlers: TransportHandlers): Transport {
    const conn: MockConn = { role: null, pid: null, handlers, open: true, seq: 0 };
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
      case "trivia.answer":
        this.#answer(conn, msg.cid, msg.index, msg.choice);
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

      /* ---- trivia ---- */

      case "trivia.open": {
        if (s.questionPhase !== "idle") {
          return reject("wrong_question_phase", "That question is already open.");
        }
        if (!s.question()) return reject("no_more_questions", "That was the last one.");
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#openQuestion(cmd.suddenDeath);
        return;
      }
      case "trivia.close": {
        if (s.questionPhase !== "open") {
          return reject("wrong_question_phase", "No question is open.");
        }
        this.#send(conn, { t: "ack", cid, applied: true });
        this.#closeQuestion();
        this.#broadcastState();
        return;
      }
      case "trivia.reveal": {
        if (s.questionPhase !== "closed") {
          return reject(
            "wrong_question_phase",
            s.questionPhase === "open"
              ? "Close the question before revealing it."
              : "There is nothing to reveal.",
          );
        }
        s.questionPhase = "revealed";
        break;
      }
      case "trivia.next": {
        if (s.questionPhase !== "revealed") {
          return reject("wrong_question_phase", "Reveal this one first.");
        }
        if (s.at + 1 >= s.questions.length) {
          return reject("no_more_questions", "That was the last question.");
        }
        s.at += 1;
        s.questionPhase = "idle";
        s.answers = {};
        s.suddenDeath = false;
        s.suddenDeathWinner = null;
        break;
      }
    }
    this.#send(conn, { t: "ack", cid, applied: true });
    this.#broadcastState();
  }

  /* ---- trivia mechanics ---- */

  /**
   * The server's timer, mocked: the question closes at `closesAt` whatever
   * anyone does, and the host closing early clears it. The guard on the
   * index and the deadline is the same one the real runtime uses, because it
   * is the same race — a timeout in flight when the host advances must not
   * close the next question.
   */
  #closeTimer: ReturnType<typeof setTimeout> | null = null;

  #openQuestion(suddenDeath: boolean): void {
    const s = this.session;
    const q = s.question();
    if (!q) return;
    const now = Date.now() + SERVER_SKEW_MS;
    s.questionPhase = "open";
    s.suddenDeath = suddenDeath;
    s.suddenDeathWinner = null;
    s.answers = {};
    s.opensAt = now;
    // Sudden death has no timer at all: it runs until someone is right.
    s.closesAt = suddenDeath ? null : now + q.timeLimitSec * 1000;
    this.#armCloseTimer();
    this.#broadcastState();
    this.#botsAnswer();
  }

  #armCloseTimer(): void {
    const s = this.session;
    if (this.#closeTimer !== null) clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    if (s.questionPhase !== "open" || s.closesAt === null) return;
    const index = s.at;
    const closesAt = s.closesAt;
    this.#closeTimer = setTimeout(
      () => {
        this.#closeTimer = null;
        if (s.questionPhase !== "open" || s.at !== index || s.closesAt !== closesAt) return;
        this.#closeQuestion();
        this.#broadcastState();
        return;
      },
      Math.max(0, closesAt - (Date.now() + SERVER_SKEW_MS)),
    );
  }

  #closeQuestion(): void {
    const s = this.session;
    if (this.#closeTimer !== null) clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    s.settleQuestion();
    s.questionPhase = "closed";
    s.opensAt = null;
    s.closesAt = null;
  }

  #answer(conn: MockConn, cid: string, index: number, choice: number): void {
    const s = this.session;
    const pid = conn.pid;
    if (conn.role !== "participant" || pid === null) {
      this.#send(conn, {
        t: "refusedCmd",
        cid,
        code: "forbidden",
        message: "Only a participant can answer.",
      });
      return;
    }
    const refuse = (code: string, message: string): void => {
      this.#send(conn, { t: "refusedCmd", cid, code, message });
    };
    if (s.questionPhase !== "open") return refuse("question_not_open", "That question is closed.");
    if (index !== s.at) return refuse("question_not_open", "That question has moved on.");
    if (s.answers[pid]) return refuse("already_answered", "You are locked in.");
    const q = s.question();
    if (!q || choice < 0 || choice >= q.answers.length) {
      return refuse("invalid_choice", "No such answer.");
    }
    this.#recordAnswer(pid, choice);
    this.#send(conn, { t: "ack", cid, applied: true });
    // Addressed, not broadcast: the count belongs on the console and the big
    // screen, and the only phone that learns anything is the one that tapped.
    // Unless that tap ended a sudden death, in which case the room needs the
    // whole state, because the question just closed.
    if (s.questionPhase === "open") {
      this.#sendStateTo((c) => c.role !== "participant" || c.pid === pid);
    } else {
      this.#broadcastState();
    }
  }

  /** Shared by real taps and by the bots, so both take the same path. */
  #recordAnswer(pid: string, choice: number): void {
    const s = this.session;
    const q = s.question();
    if (!q || s.questionPhase !== "open" || s.answers[pid]) return;
    const correct = q.correct.includes(choice);
    // The mock is the server here, so the response time is the server's
    // clock and nothing the client sent.
    const ms = Math.max(0, Date.now() + SERVER_SKEW_MS - (s.opensAt ?? 0));
    s.answers[pid] = { choice, correct, ms, points: 0, streakBonus: 0 };
    if (s.suddenDeath && correct && s.suddenDeathWinner === null) {
      s.suddenDeathWinner = pid;
      // First correct answer wins, and the question is over. The caller
      // broadcasts; this only moves the state.
      this.#closeQuestion();
    }
  }

  /**
   * The bots tap. Most of them are right, they arrive over a few seconds, and
   * two of them never answer at all — which is what makes "24 of 27" mean
   * something and gives the host a reason to press Close early.
   */
  #botsAnswer(): void {
    const s = this.session;
    const q = s.question();
    if (!q) return;
    const index = s.at;
    const bots = s.participants.filter((p) => p.bot);
    bots.forEach((p, i) => {
      if (i % 7 === 3) return; // two or three people always miss one
      const rightish = (i + index) % 4 !== 0;
      const choice = rightish
        ? (q.correct[0] ?? 0)
        : (q.correct[0] === 0 ? 1 : 0) % q.answers.length;
      const delay = 400 + i * 220 + Math.random() * 900;
      this.#later(() => {
        if (s.at !== index || s.questionPhase !== "open") return;
        this.#recordAnswer(p.pid, choice);
        if (s.questionPhase === "open") {
          this.#sendStateTo((c) => c.role !== "participant" || c.pid === p.pid);
        } else {
          this.#broadcastState();
        }
      }, delay / this.#cfg.speed);
    });
  }

  #sendStateTo(want: (conn: MockConn) => boolean): void {
    for (const conn of this.#conns) {
      if (conn.role === null || !want(conn)) continue;
      this.#sendState(conn);
    }
  }

  /* ---- mock server → clients ---- */

  /** Stamps the per-connection `seq`, exactly as runtime.ts's `send` does. */
  #send(conn: MockConn, msg: ServerMessage): void {
    if (!conn.open) return;
    let framed = msg;
    if ("seq" in msg) {
      // The injected gap: burn a number so the client sees `last + 2` and
      // does the thing the protocol says, which is ask for the whole state.
      if (this.#gapNext) conn.seq += 1;
      framed = { ...msg, seq: ++conn.seq };
    }
    this.#later(() => {
      if (conn.open) conn.handlers.onMessage(framed);
    }, this.#cfg.latency);
  }

  #sendState(conn: MockConn): void {
    if (conn.role === null) return;
    this.#send(conn, {
      t: "state",
      seq: 0, // replaced per-connection in #send
      state: this.session.render(conn.role, conn.pid),
    });
  }

  #broadcastState(): void {
    for (const conn of this.#conns) {
      if (conn.role === null) continue;
      this.#sendState(conn);
    }
  }

  /** A delta, so the client's `seq` handling is exercised by the normal path. */
  #broadcastRoster(): void {
    if (this.#cfg.gap && !this.#gapUsed && this.session.participants.length >= 5) {
      this.#gapUsed = true;
      this.#gapNext = true;
    }
    const roster = this.session.roster();
    for (const conn of this.#conns) {
      if (conn.role === null) continue;
      // The host's counts and the whole scoring grid live in `hostExtras`,
      // which a roster frame does not carry: a delta would leave the console
      // one joiner behind. They get the whole thing; there is one of them.
      // This is what the real server does — see runtime.ts broadcastRoster.
      if (conn.role === "host") {
        this.#sendState(conn);
        continue;
      }
      this.#send(conn, { t: "roster", seq: 0, roster });
    }
    this.#gapNext = false;
  }

  #toast(kind: "spot" | "text", text: string): void {
    for (const conn of this.#conns) {
      if (conn.role === null) continue;
      this.#send(conn, { t: "toast", seq: 0, kind, text });
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

    // Trivia, played rather than typed in: one facilitator on bench, then four
    // real questions with the bots tapping. Raw units end up in the thousands
    // against the TTX's twenty, which is the whole reason SCORING.md
    // normalises instead of adding.
    this.#at(24, () => {
      const facilitator = this.session.participants[1];
      if (facilitator) {
        facilitator.status["trivia"] = "bench";
        facilitator.raw["trivia"] = 0;
      }
      this.session.segment = "trivia";
      this.#broadcastState();
    });

    /**
     * One question, on a fixed beat: open, let the bots tap, close early
     * rather than waiting out the timer (which is exactly the dead air the
     * close button exists for), reveal, hold, advance.
     *
     * The last one runs as sudden death, which has no timer at all and ends
     * the moment somebody is right.
     */
    const QUESTION_SECONDS = 11;
    for (let i = 0; i < 4; i += 1) {
      const t = 26 + i * QUESTION_SECONDS;
      const sudden = i === 3;
      this.#at(t, () => this.#openQuestion(sudden));
      // Not for the sudden death: that one closes itself on the first correct
      // answer, and closing it again would be the race the guard is for.
      this.#at(t + 5.5, () => {
        if (this.session.questionPhase !== "open") return;
        this.#closeQuestion();
        this.#broadcastState();
      });
      this.#at(t + 6.5, () => {
        if (this.session.questionPhase !== "closed") return;
        this.session.questionPhase = "revealed";
        this.#broadcastState();
      });
      if (i < 3) {
        this.#at(t + QUESTION_SECONDS - 0.5, () => {
          if (this.session.questionPhase !== "revealed") return;
          this.session.at += 1;
          this.session.questionPhase = "idle";
          this.session.answers = {};
          this.session.suddenDeath = false;
          this.session.suddenDeathWinner = null;
          this.#broadcastState();
        });
      }
    }

    this.#at(70, () => {
      this.session.segment = "standings";
      this.#broadcastState();
    });

    this.#at(72, () => {
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

    this.#at(74, () => {
      this.session.seal = "sealed";
      this.#broadcastState();
    });

    this.#at(86, () => {
      this.session.seal = "revealed";
      this.session.segment = "final";
      this.#broadcastState();
    });

    // Long enough for the big screen's final reveal to actually finish: four
    // four-second dwells, then the hold on the empty first slot.
    this.#at(122, () => {
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
