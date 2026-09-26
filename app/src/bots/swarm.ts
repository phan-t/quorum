/**
 * The swarm: N real WebSockets against a running Quorum.
 *
 *     npm run swarm -- 20 --url http://localhost:3000 --code hvs.xxx --host-token XXX
 *     npm run swarm -- 60 --url https://quorum.example.com --code … --host-token … --seed 99
 *
 * Unlike `simulate.ts`, which drives the reducer in memory, everything here
 * goes over the wire: one socket per bot, one for the host, the same frames
 * the browser clients send. That is the whole point — the failures this is
 * for live between the phone and the reducer, and an in-memory harness cannot
 * see them. See docs/smoke-test.md.
 *
 * **Every number in the report is counted on a bot socket.** What the server
 * believes it broadcast is not evidence; a frame a client actually received
 * is. The gap between those two is the bug this exists to find.
 *
 * Deterministic where it can be: each bot's choices come from a seeded PRNG,
 * so the same `--seed` plays the same way. What it cannot make deterministic
 * is the network, which is the part under test.
 */

import { WebSocket } from "ws";

import { RECRUITMENT_ITEMS } from "../arcade/recruitment.ts";
import type { ClientMessage, HostCommand, RenderState, ServerMessage } from "../protocol.ts";
import { HELLO_FLOOD_LIMIT } from "../server/limits.ts";

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

interface Opts {
  readonly count: number;
  readonly url: string;
  readonly code: string;
  readonly hostToken: string;
  readonly seed: number;
  /** Stop after the lobby, for a join-storm test with no gameplay. */
  readonly joinOnly: boolean;
  /**
   * Milliseconds between joins. Zero is the honest default — a QR code on a
   * screen produces a storm — but the server admits ten hellos a minute per
   * IP, so every bot past the tenth from one machine is refused. Stagger to
   * get a gameplay run past that; leave it at zero to measure the limit.
   */
  readonly staggerMs: number;
  /**
   * How many trivia questions to play. The committed example set is
   * twenty-four scored questions, and a run is clamped to what the session
   * actually loaded, so asking for more than a set holds plays the set.
   */
  readonly questions: number;
  /** The Desktop. Its frames are the heaviest and were never measured. */
  readonly screenToken: string | null;
  /** Bots that join after the session has started, as people do. */
  readonly lateCount: number;
  /** Bots that drop and come back on their rejoin token, as phones do. */
  readonly churnCount: number;
  /** Play the staged event's own plan and timings, not the built-in sweep. */
  readonly fromSession: boolean;
}

/** A progress line, so a long run is not silent. */
function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Opts {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  // A bare integer, and only when it is not some flag's value. Scanning argv
  // for "the first integer" read `--seed 99` as a request for 99 bots.
  const positional = argv.find(
    (a, i) => !a.startsWith("--") && /^\d+$/.test(a) && !(i > 0 && argv[i - 1]?.startsWith("--")),
  );
  const count = Number(positional ?? flag("count") ?? 20);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    die("Bot count must be a whole number from 1 to 500.");
  }
  const url = flag("url") ?? "http://localhost:3000";
  const code = flag("code");
  const hostToken = flag("host-token");
  if (!code) die("Set --code to the session's join code. `make stage` prints it.");
  if (!hostToken) die("Set --host-token. `make stage` prints it in the console link's fragment.");
  const rawSeed = flag("seed") ?? "1";
  const seed = rawSeed === "random" ? Math.floor(Math.random() * 0xffffffff) : Number(rawSeed);
  if (!Number.isFinite(seed)) die("--seed must be a number, or the word random.");
  const staggerMs = Number(flag("stagger") ?? 0);
  if (!Number.isFinite(staggerMs) || staggerMs < 0) die("--stagger must be a number of milliseconds.");
  const questions = Number(flag("questions") ?? 5);
  if (!Number.isInteger(questions) || questions < 0) die("--questions must be a whole number.");
  const lateCount = Number(flag("late") ?? 0);
  const churnCount = Number(flag("churn") ?? 0);
  if (!Number.isInteger(lateCount) || lateCount < 0) die("--late must be a whole number.");
  if (!Number.isInteger(churnCount) || churnCount < 0) die("--churn must be a whole number.");
  if (lateCount + churnCount > count) die("--late plus --churn cannot exceed the bot count.");
  return {
    count, url, code, hostToken, seed,
    joinOnly: argv.includes("--join-only"),
    staggerMs,
    questions,
    screenToken: flag("screen-token") ?? null,
    lateCount,
    churnCount,
    fromSession: argv.includes("--from-session"),
  };
}

/** http(s):// → ws(s)://, and on to the one socket path the server serves. */
function socketUrl(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = "";
  return u.toString();
}

/* ------------------------------------------------------------------ */
/* Seeded PRNG — mulberry32, as everywhere else in this repository      */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* What a socket records                                               */
/* ------------------------------------------------------------------ */

interface Gap {
  readonly from: number;
  readonly to: number;
  /** Which frame revealed it, so its own arrival cannot be read as the cure. */
  readonly askedAtFrame: number;
  closed: boolean;
}

/**
 * One connection and everything measured on it.
 *
 * The counters are per socket rather than summed as they arrive, because the
 * question the report has to answer — can one laptop drain this — is about one
 * socket, and a total across sixty of them hides the answer.
 */
class Conn {
  readonly label: string;
  ws: WebSocket | null = null;
  joinedAt: number | null = null;
  openedAt = 0;
  refused: string | null = null;
  pid: string | null = null;
  rejoinToken: string | null = null;
  state: RenderState | null = null;
  lastSeq = 0;
  frames = 0;
  bytes = 0;
  largestFrame = 0;
  readonly gaps: Gap[] = [];
  /** cid -> when it was sent, for the ack round trip. */
  readonly pending = new Map<string, number>();
  readonly ackMs: number[] = [];
  /** Answered, applied nothing. Neither a success nor a refusal. */
  noop = 0;
  acked = 0;
  sent = 0;
  refusedCmds: string[] = [];
  closedWith: number | null = null;
  reconnects = 0;
  error: string | null = null;

  constructor(label: string) {
    this.label = label;
  }

  send(msg: ClientMessage): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    const cid = (msg as { cid?: string }).cid;
    if (cid !== undefined) {
      this.pending.set(cid, Date.now());
      this.sent += 1;
    }
    this.ws.send(JSON.stringify(msg));
  }
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[at] ?? 0;
}

/* ------------------------------------------------------------------ */
/* A bot                                                               */
/* ------------------------------------------------------------------ */

/**
 * The longest a participant may sit with nothing to press, in a segment that
 * is supposed to be a game, before the run says so.
 *
 * Sixty seconds, because SPEC names the failure the arcade exists to design
 * out — "a person knocked out at minute six with fifteen minutes of watching
 * left" — and a minute is about when somebody picks up their phone for a
 * different reason. It is a judgement rather than a measurement, which is why
 * it is a named constant: changing it should be a decision, not an edit.
 */
const IDLE_ALARM_MS = 60_000;

/**
 * The gameplay is reactive, not scripted.
 *
 * A bot reads the state it was just sent and decides what to press. There is
 * deliberately no list of expected frames: a script would pass against a
 * server that had stopped sending anything new, and the thing being tested is
 * whether a real client can follow along.
 *
 * `acted` keys the one-shot decisions — one answer per question, one pane per
 * step — because a broadcast arrives many times per round and pressing on
 * every one of them would be a tap flood the engine refuses, which would be
 * measuring the rate limiter rather than the round.
 */
/**
 * What a bot could do at one instant.
 *
 * `idle` is the one that matters: in a playing segment, on the Floor, with
 * nothing pressable. That is the state SPEC calls out as the failure the
 * arcade had to design out — "a person knocked out at minute six with fifteen
 * minutes of watching left" — and until now nothing measured whether the
 * design actually achieved it.
 */
type Posture = "idle" | "actionable" | "betting" | "resting";

class Bot {
  readonly conn: Conn;
  private readonly rand: () => number;
  /** Decisions taken, which guards scheduling: one answer per question. */
  private readonly acted = new Set<string>();
  /**
   * Frames actually sent, which is what posture reads.
   *
   * Not the same set, and the difference produced a false finding. A bot
   * decides to answer the instant an item opens and then sits in a think
   * timer of up to nine seconds. Reading `acted` made it look idle for the
   * whole item — 120 seconds of "nothing to press" across a Recruitment round
   * the bots in fact answered six times. A person who has not answered yet
   * still has something to press, and so does a bot.
   */
  private readonly done = new Set<string>();
  private seq = 0;

  /* ---- experience, sampled ---- */
  /** Milliseconds in a playing segment, by what the bot could do. */
  readonly posture: Record<Posture, number> = { idle: 0, actionable: 0, betting: 0, resting: 0 };
  /** The longest unbroken stretch with nothing to press, and the current one. */
  longestIdleMs = 0;
  private idleRunMs = 0;
  /** Play frames sent, per arcade round. A round with none is a round sat out. */
  readonly actionsByRound = new Map<number, number>();
  /**
   * Idle milliseconds, by where they were spent.
   *
   * Without this the report can say a bot waited two minutes and not where,
   * which is the first thing anybody asks and the only part that tells you
   * what to change.
   */
  readonly idleWhere = new Map<string, number>();

  readonly index: number;
  readonly nickname: string;

  // Fields declared and assigned rather than parameter properties: the whole
  // repository runs under `node --experimental-strip-types`, which parses but
  // does not transform, and a parameter property needs a transform. It
  // typechecks and then refuses to start, which is a failure worth only
  // meeting once.
  constructor(index: number, nickname: string, seed: number) {
    this.index = index;
    this.nickname = nickname;
    this.conn = new Conn(nickname);
    this.rand = mulberry32(seed + index * 7919);
  }

  private cid(): string {
    this.seq += 1;
    return `${this.index}-${this.seq}`;
  }

  /** Send a play frame and remember the round it belonged to. */
  private act(msg: ClientMessage): void {
    const round = this.conn.state?.arcade?.roundIndex;
    if (typeof round === "number") {
      this.actionsByRound.set(round, (this.actionsByRound.get(round) ?? 0) + 1);
    }
    this.conn.send(msg);
  }

  /**
   * What this bot could do right now.
   *
   * Read from the same state the bot plays off, so it cannot drift from what
   * the bot would actually have been able to press. `resting` is a segment
   * that is not a game — a lobby or a holding card is not dead time, it is the
   * afternoon working as intended.
   */
  posture_(): Posture {
    const st = this.conn.state;
    if (!st) return "resting";
    if (st.segment === "trivia") {
      const t = st.trivia;
      if (!t || t.phase !== "open") return "resting";
      return this.done.has(`q${t.index}`) ? "idle" : "actionable";
    }
    if (st.segment !== "arcade") return "resting";
    const a = st.arcade;
    const mine = st.arcadeMine;
    if (!a || !mine || a.phase !== "running") return "resting";

    if (mine.standing === "drained") {
      return mine.backing === undefined ? "actionable" : "betting";
    }
    switch (a.round) {
      case "recruitment": {
        const at = a.recruitment?.at;
        if (at === undefined) return "resting";
        return this.done.has(`rec${a.roundIndex}-${at}`) ? "idle" : "actionable";
      }
      case "plan_apply":
      case "tug_of_raft":
        // A tap train: always something to press while the Floor is open.
        return "actionable";
      case "unseal": {
        const u = mine.unseal;
        if (!u) return "idle";
        if (u.cracked) return "idle";
        if (u.shape === null) return "actionable";
        return u.cue ? "actionable" : "idle";
      }
      case "glass_bridge": {
        const g = mine.glass;
        if (!g) return "idle";
        // The case the review found by reading: a wave that is not on the
        // bridge has nothing to press, for as long as the waves ahead take.
        if (!g.onTheBridge) return mine.backing === undefined ? "actionable" : "betting";
        return g.committed ? "idle" : "actionable";
      }
      default:
        return "idle";
    }
  }

  /** Where the bot is, in words the report can group by. */
  private where(): string {
    const st = this.conn.state;
    if (!st) return "not connected";
    if (st.segment !== "arcade") return st.segment;
    const a = st.arcade;
    if (!a || a.round === null) return "arcade (between rounds)";
    return `${a.round} (round ${a.roundIndex})`;
  }

  /** Called on a fixed clock, so the number does not depend on broadcasts. */
  sample(elapsedMs: number): void {
    const p = this.posture_();
    this.posture[p] += elapsedMs;
    if (p === "idle") {
      this.idleRunMs += elapsedMs;
      this.longestIdleMs = Math.max(this.longestIdleMs, this.idleRunMs);
      const k = this.where();
      this.idleWhere.set(k, (this.idleWhere.get(k) ?? 0) + elapsedMs);
    } else {
      this.idleRunMs = 0;
    }
  }

  /** Once per key, ever. Returns false when this bot has already acted. */
  private once(key: string): boolean {
    if (this.acted.has(key)) return false;
    this.acted.add(key);
    return true;
  }

  /** Human-ish thinking time, seeded so a run repeats. */
  private think(minMs: number, maxMs: number): number {
    return minMs + Math.floor(this.rand() * (maxMs - minMs));
  }

  private later(ms: number, go: () => void): void {
    const t = setTimeout(go, ms);
    t.unref?.();
  }

  /** Called on every `state` frame. */
  react(s: RenderState): void {
    if (s.segment === "trivia") this.playTrivia(s);
    else if (s.segment === "arcade") this.playArcade(s);
  }

  private playTrivia(s: RenderState): void {
    const t = s.trivia;
    if (!t || t.phase !== "open") return;
    // One answer per question, and only while it is open. A few bots never
    // answer, which is a real thing a room does and the thing that makes
    // "14 of 20 answered" a number worth showing.
    // A few never answer at all, which a room does. They are idle from here,
    // so the decision goes into both sets.
    if (this.rand() < 0.08) {
      this.acted.add(`q${t.index}`);
      this.done.add(`q${t.index}`);
    }
    if (!this.once(`q${t.index}`)) return;
    const choice = Math.floor(this.rand() * Math.max(1, t.answers.length));
    this.later(this.think(400, 6_000), () => {
      const now = this.conn.state?.trivia;
      // The question may have closed while this bot was thinking. Sending
      // anyway is what a real phone does, and the refusal is worth counting.
      if (now?.index !== t.index) return;
      this.done.add(`q${t.index}`);
      this.act({ t: "trivia.answer", cid: this.cid(), index: t.index, choice });
    });
  }

  private playArcade(s: RenderState): void {
    const a = s.arcade;
    const mine = s.arcadeMine;
    if (!a || !mine || a.phase !== "running") return;
    const round = a.roundIndex;

    // Drained, or waiting for a wave: back somebody. The engine decides
    // whether a bet from this position is allowed; a refusal is data.
    if (mine.backing === undefined && (mine.standing === "drained" || a.round === "glass_bridge")) {
      // Exclude *this bot* by its participant id. Comparing a pid against a
      // player number never matches, so a bot could draw itself, be refused
      // with `cannot_back_yourself`, and — because the one-shot key was
      // already spent — never back anybody for the rest of the round.
      const me = this.conn.pid;
      const others = a.grid.filter((c) => c.pid !== undefined && c.pid !== me);
      const pick = others[Math.floor(this.rand() * others.length)];
      const pid = (pick as { pid?: string } | undefined)?.pid;
      if (pid !== undefined && this.once(`back${round}`)) {
        this.later(this.think(600, 2_500), () => {
          this.act({ t: "arcade.back", cid: this.cid(), pid });
        });
      }
    }
    if (mine.standing === "drained") return;

    if (a.round === "recruitment") this.playRecruitment(a, round);
    else if (a.round === "plan_apply") this.playPlanApply(round);
    else if (a.round === "glass_bridge") this.playGlassBridge(s, round);
    else if (a.round === "unseal") this.playUnseal(s, round);
    else if (a.round === "tug_of_raft") this.playTug(round);
  }

  private playRecruitment(a: NonNullable<RenderState["arcade"]>, round: number): void {
    const r = a.recruitment;
    if (!r) return;
    if (!this.once(`rec${round}-${r.at}`)) return;
    // A bot cannot know the answer: the wire deliberately withholds it while
    // an item is open, because a phone holding the answer key is the round
    // given away. So it types a plausible product name, and some land — which
    // is also what a room does.
    const guess = PRODUCTS[Math.floor(this.rand() * PRODUCTS.length)] ?? "terraform";
    this.later(this.think(800, 9_000), () => {
      this.done.add(`rec${round}-${r.at}`);
      this.act({ t: "arcade.answer", cid: this.cid(), item: r.at, answer: guess });
    });
  }

  private playPlanApply(round: number): void {
    // A tap train, not one tap: the round is 75 seconds of tapping and the
    // load it puts on the server is the whole reason this harness exists.
    if (!this.once(`pa${round}`)) return;
    const tick = (): void => {
      const s = this.conn.state;
      const a = s?.arcade;
      if (!a || a.phase !== "running" || a.roundIndex !== round) return;
      if (s?.arcadeMine?.standing !== "floor") return;
      this.act({ t: "arcade.tap", cid: this.cid(), round });
      this.later(this.think(220, 900), tick);
    };
    this.later(this.think(300, 1_500), tick);
  }

  private playGlassBridge(s: RenderState, round: number): void {
    const g = s.arcadeMine?.glass;
    if (!g || !g.onTheBridge || g.committed) return;
    if (!this.once(`gb${round}-${g.step}`)) return;
    const choice = this.rand() < 0.5 ? 0 : 1;
    this.later(this.think(500, 3_500), () => {
      const now = this.conn.state?.arcadeMine?.glass;
      if (!now?.onTheBridge || now.committed || now.step !== g.step) return;
      this.act({ t: "arcade.step", cid: this.cid(), round, step: g.step, choice });
    });
  }

  private playUnseal(s: RenderState, round: number): void {
    const u = s.arcadeMine?.unseal;
    if (!u) return;
    if (u.shape === null && this.once(`shape${round}`)) {
      const shapes = ["circle", "triangle", "star", "umbrella"] as const;
      const shape = shapes[Math.floor(this.rand() * shapes.length)] ?? "triangle";
      this.act({ t: "arcade.shape", cid: this.cid(), round, shape });
      return;
    }
    const cue = u.cue;
    if (!cue || u.cracked) return;
    // Tap a letter that is on the tin. Which one is a guess; the engine
    // refuses a character that is not there, and that refusal is malformed
    // rather than wrong, so a bot must not send junk.
    const at = (u.solved ?? "").length;
    if (!this.once(`letter${round}-${at}`)) return;
    const letter = cue[Math.floor(this.rand() * cue.length)];
    if (letter === undefined) return;
    this.later(this.think(400, 2_000), () => {
      this.act({ t: "arcade.letter", cid: this.cid(), round, letter });
    });
  }

  private playTug(round: number): void {
    // 100 bpm is a beat every 600ms. Tapping near it is the point: this is
    // the round that fans a frame out per credited beat.
    if (!this.once(`tug${round}`)) return;
    const tick = (): void => {
      const s = this.conn.state;
      const a = s?.arcade;
      if (!a || a.phase !== "running" || a.roundIndex !== round) return;
      this.act({ t: "arcade.beat", cid: this.cid(), round });
      this.later(this.think(520, 700), tick);
    };
    this.later(this.think(200, 600), tick);
  }
}

/* ------------------------------------------------------------------ */
/* Wiring a socket                                                     */
/* ------------------------------------------------------------------ */

function connect(
  wsUrl: string,
  conn: Conn,
  hello: ClientMessage,
  onState: (s: RenderState) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    conn.ws = ws;
    conn.openedAt = Date.now();
    let settled = false;
    const settle = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    ws.on("open", () => ws.send(JSON.stringify(hello)));

    ws.on("message", (raw: Buffer | string) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      conn.frames += 1;
      conn.bytes += Buffer.byteLength(text, "utf8");
      conn.largestFrame = Math.max(conn.largestFrame, Buffer.byteLength(text, "utf8"));
      let msg: ServerMessage;
      try {
        msg = JSON.parse(text) as ServerMessage;
      } catch {
        conn.error = "a frame was not JSON";
        return;
      }

      switch (msg.t) {
        case "welcome":
          conn.joinedAt = Date.now();
          conn.pid = msg.pid ?? null;
          conn.rejoinToken = msg.rejoinToken ?? null;
          settle();
          return;
        case "refused":
          conn.refused = `${msg.reason}: ${msg.message}`;
          settle();
          ws.close();
          return;
        case "ack": {
          const at = conn.pending.get(msg.cid);
          if (at !== undefined) {
            conn.pending.delete(msg.cid);
            conn.ackMs.push(Date.now() - at);
            if (msg.applied) conn.acked += 1;
            else conn.noop += 1;
          }
          return;
        }
        case "refusedCmd": {
          // A refusal is an answer. The server replies to a frame the engine
          // rejected with `refusedCmd` rather than `ack`, so a late tap or a
          // wrong-phase press lands here — and counting those as "never
          // acked" reports ordinary, correct behaviour as a fault, which is
          // how this was first written.
          const at = conn.pending.get(msg.cid);
          if (at !== undefined) {
            conn.pending.delete(msg.cid);
            conn.ackMs.push(Date.now() - at);
          }
          conn.refusedCmds.push(`${msg.cid}: ${msg.code} — ${msg.message}`);
          return;
        }
        default:
          break;
      }

      // Everything else carries a seq. A gap means this socket missed a
      // frame, which is exactly what `resync` exists for — so record the gap
      // and ask, and record whether the answer closed it.
      const seq = (msg as { seq?: number }).seq;
      if (typeof seq === "number") {
        // The server stamps `++client.seq` per socket from 1, so the first
        // frame is 1 and anything higher means frames were skipped before we
        // ever saw one. Keying the check on `lastSeq > 0` — as this did — made
        // a dropped first frame invisible.
        const expected = conn.lastSeq + 1;
        if (seq > expected) {
          conn.gaps.push({ from: conn.lastSeq, to: seq, closed: false, askedAtFrame: conn.frames });
          conn.send({ t: "resync" });
        }
        if (seq > conn.lastSeq) conn.lastSeq = seq;
      }
      if (msg.t === "state") {
        // A gap is closed by the `state` a resync answers with — which is a
        // *later* frame than the one that revealed the gap.
        //
        // The first version closed the gap on the revealing frame itself,
        // because that frame is usually a `state` too. The check could then
        // never fail: a swallowed resync, with no reply at all, still reported
        // "seen and recovered". `askedAtFrame` is what makes it a real test.
        const open = conn.gaps.find((g) => !g.closed && conn.frames > g.askedAtFrame);
        if (open) open.closed = true;
        conn.state = msg.state;
        onState(msg.state);
      }
    });

    ws.on("close", (code: number) => {
      conn.closedWith = code;
      settle();
    });
    ws.on("error", (err: Error) => {
      // `ws` reports ECONNREFUSED with an empty message, so the code is the
      // only thing that says what happened. Reporting "" loses the reason and
      // defeats the `?? "no welcome"` fallback, which "" does not trigger.
      const code = (err as Error & { code?: string }).code;
      conn.error = err.message || code || "socket error";
      settle();
    });

    // A socket that never answers is a result, not a reason to hang.
    const bail = setTimeout(() => {
      if (conn.joinedAt === null && conn.refused === null) {
        conn.error = conn.error ?? "no welcome within 20s";
      }
      settle();
    }, 20_000);
    bail.unref?.();
  });
}

/* ------------------------------------------------------------------ */
/* The host                                                            */
/* ------------------------------------------------------------------ */

/** Issue a console command and wait a beat for the room to see it. */
async function cmd(host: Conn, name: HostCommand, waitMs: number, note: string): Promise<void> {
  const cid = `host-${note}-${host.sent}`;
  host.send({ t: "host.cmd", cid, cmd: name });
  await sleep(waitMs);
}

/** Poll until a condition holds, or give up. Returns nothing; check the state. */
async function waitFor(ready: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!ready() && Date.now() < until) await sleep(50);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/**
 * The staged plan, as the console would read it.
 *
 * `GET /api/sessions/:sid/setup` returns the blob `make stage` put there. The
 * server stores it and never looks inside — it is the console's own — so this
 * is the only thing asserting its shape, and it has to treat every field as
 * unknown. Anything missing or the wrong type falls back to the sweep, and
 * says so, because a rehearsal that silently played a different event from
 * the one being rehearsed would be worse than no rehearsal.
 */
interface StagedPlan {
  readonly rounds: readonly string[];
  readonly timings: Readonly<Record<string, number>>;
  readonly holding: { title: string; line: string } | null;
}

async function fetchStagedPlan(
  baseUrl: string,
  sid: string,
  hostToken: string,
): Promise<StagedPlan | null> {
  let raw: unknown;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sid)}/setup`, {
      headers: { authorization: `Bearer ${hostToken}` },
    });
    if (!res.ok) {
      log(`  --from-session: the setup endpoint answered ${res.status}; playing the built-in sweep`);
      return null;
    }
    raw = await res.json();
  } catch (err) {
    log(`  --from-session: could not read the staged setup (${String(err)}); playing the built-in sweep`);
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    log("  --from-session: this session was staged without a console setup; playing the built-in sweep");
    return null;
  }

  const o = raw as Record<string, unknown>;
  const arcade = (o["arcade"] ?? {}) as Record<string, unknown>;
  const rawPlan = arcade["plan"];
  const rounds = Array.isArray(rawPlan) ? rawPlan.filter((k): k is string => typeof k === "string") : [];

  const timings: Record<string, number> = {};
  const t = arcade["timings"];
  if (typeof t === "object" && t !== null) {
    for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) timings[k] = Math.round(v);
    }
  }

  // The first holding card, which is what the runbook's holding step shows.
  let holding: { title: string; line: string } | null = null;
  const cards = ((o["cards"] ?? {}) as Record<string, unknown>)["cards"];
  if (Array.isArray(cards) && cards.length > 0) {
    const first = cards[0] as Record<string, unknown>;
    if (typeof first["title"] === "string") {
      holding = { title: first["title"], line: typeof first["line"] === "string" ? first["line"] : "" };
    }
  }

  if (rounds.length === 0) {
    log("  --from-session: the staged setup names no arcade rounds; playing the built-in sweep");
    return null;
  }
  return { rounds, timings, holding };
}

/**
 * The host, as a bot rather than a script.
 *
 * The first version was a list of commands with sleeps between them, which
 * tests the server's ability to accept commands in an order somebody wrote
 * down. A real host does not do that: they watch the room and press when the
 * room is ready. So this waits on state — everyone has answered, the round
 * has ended itself, the reveal is up — and presses then.
 *
 * That difference is not cosmetic. Sleeping past a round that ended early
 * makes the run longer than the event; sleeping short of one makes the host
 * press into the wrong phase and be refused, which is how the first version
 * produced two spurious refusals. Neither is what a rehearsal is for.
 */
class HostBot {
  readonly conn: Conn;
  private readonly opts: Opts;
  private readonly staged: StagedPlan | null;

  constructor(conn: Conn, opts: Opts, staged: StagedPlan | null = null) {
    this.conn = conn;
    this.opts = opts;
    this.staged = staged;
  }

  private get state(): RenderState | null {
    return this.conn.state;
  }

  private async press(name: HostCommand, note: string, settleMs = 700): Promise<void> {
    const cid = `host-${note}-${this.conn.sent}`;
    this.conn.send({ t: "host.cmd", cid, cmd: name });
    await sleep(settleMs);
  }

  /** Wait for the room, not the clock. */
  private async until(ready: () => boolean, budgetMs: number, note: string): Promise<boolean> {
    await waitFor(ready, budgetMs);
    const ok = ready();
    if (!ok) log(`  host: gave up waiting for ${note} after ${budgetMs / 1000}s`);
    return ok;
  }

  /**
   * Open the lobby, before anybody tries to join.
   *
   * Separate from `run` because ordering is load-bearing: a staged session is
   * `draft`, a draft refuses every join with `not_joinable`, and a host that
   * opens the lobby as its first act of the run has already let the whole
   * room bounce off the door.
   */
  async openLobby(): Promise<void> {
    await this.until(() => this.state !== null, 5_000, "the first state frame");
    if (this.state === null) die("  the host socket never received a state frame.");
    if (this.state.phase === "draft") await this.press({ name: "open" }, "open", 1_200);
  }

  async run(bots: readonly Bot[]): Promise<void> {
    // Wait for the room to arrive, the way a host watches the head count
    // stop climbing rather than counting to a number.
    await this.until(
      () => (this.state?.roster.length ?? 0) >= Math.min(bots.length, this.opts.count),
      15_000,
      "the room to arrive",
    );
    if (this.opts.joinOnly) return;

    await this.press({ name: "start" }, "start", 900);

    // A holding card while the off-platform thing happens. Every real run of
    // show has one, and it is the segment the phone sits on longest.
    const card = this.staged?.holding ?? { title: "Tabletop Exercise", line: "Back shortly" };
    await this.press({ name: "holding", title: card.title, line: card.line }, "holding");
    await this.press({ name: "segment", kind: "holding" }, "seg-holding", 1_500);

    await this.trivia();
    await this.arcade();
    await this.standings(bots);
    await this.sendoff();

    await this.press({ name: "segment", kind: "final" }, "seg-final", 1_500);
  }

  private async trivia(): Promise<void> {
    const loaded = this.state?.trivia?.of ?? 0;
    if (loaded === 0) return;
    await this.press({ name: "segment", kind: "trivia" }, "seg-trivia", 900);

    const play = Math.min(this.opts.questions, loaded);
    for (let i = 0; i < play; i += 1) {
      await this.press({ name: "trivia.open", suddenDeath: false }, `q${i}-open`, 400);

      // Close when everyone who could answer has, which is the console's
      // affordance and what a host actually watches for. Otherwise let the
      // question's own timer run out.
      const everyone = (): boolean => {
        const t = this.state?.trivia;
        if (!t || t.phase !== "open") return true;
        const answered = t.answered ?? 0;
        const eligible = t.eligible ?? 0;
        return eligible > 0 && answered >= eligible;
      };
      await this.until(everyone, 25_000, `question ${i + 1} to be answered`);
      if (this.state?.trivia?.phase === "open") {
        await this.press({ name: "trivia.close" }, `q${i}-close`, 600);
      }
      await this.press({ name: "trivia.reveal" }, `q${i}-reveal`, 1_400);
      if (i + 1 < play) await this.press({ name: "trivia.next" }, `q${i}-next`, 700);
    }
  }

  /**
   * Every round in the plan, not a sample.
   *
   * The rounds are listed here rather than read from the staged setup because
   * the setup is the console's own blob and the server never looks inside it;
   * a swarm that parsed it would be asserting a shape nothing else does. What
   * matters for a smoke test is that every round's code runs, so it runs all
   * of them.
   */
  private async arcade(): Promise<void> {
    await this.press({ name: "segment", kind: "arcade" }, "seg-arcade", 900);
    await this.press({ name: "arcade.enter" }, "enter", 1_500);

    const rounds = this.roundsToPlay();

    for (const r of rounds) {
      await this.press(r.round, `r-${r.note}`, 900);
      await this.press({ name: "arcade.begin" }, `${r.note}-begin`, 600);
      const over = await this.until(
        () => this.state?.arcade?.phase !== "running",
        r.budgetMs,
        `the ${r.note} round to end`,
      );
      // A round that outran its own clock is a finding, not a reason to hang.
      if (!over) await this.press({ name: "arcade.end" }, `${r.note}-end-overrun`, 1_200);
      await this.press({ name: "arcade.reveal" }, `${r.note}-reveal`, 1_500);
    }
  }

  /**
   * Which rounds to play, and how long to give each.
   *
   * Without `--from-session` this is the sweep: every round, fast, so nothing
   * goes unexercised. With it, it is the event's own plan at the event's own
   * timings — a rehearsal of the afternoon rather than a test of the build.
   * The two answer different questions and the default is the first, because
   * a smoke test that skipped three rounds would be quiet about them.
   *
   * The budget is derived from the timings rather than fixed: a round given
   * ninety seconds in the console needs longer than the sweep's twenty, and a
   * budget that did not follow would end it by hand and call that a finding.
   */
  private roundsToPlay(): { round: HostCommand; note: string; budgetMs: number }[] {
    const t = this.staged?.timings ?? {};
    const n = (key: string, fallback: number): number => t[key] ?? fallback;
    const slack = 25_000; // the card, the reveal, and a round that overruns

    const build = (kind: string): { round: HostCommand; note: string; budgetMs: number } | null => {
      switch (kind) {
        case "recruitment": {
          const secondsPerItem = n("secondsPerItem", 6);
          return {
            round: { name: "arcade.round", kind: "recruitment", secondsPerItem },
            note: "rec",
            // Recruitment's clock is per *item*, so the round is the item
            // clock times however many items the board has. Counted off the
            // content rather than written down: the board went from six items
            // to seven and a literal six here would have quietly budgeted the
            // sweep one item short, then reported the overrun as a finding.
            budgetMs: secondsPerItem * RECRUITMENT_ITEMS.length * 1_000 + slack,
          };
        }
        case "plan_apply": {
          const seconds = n("seconds", 20);
          return {
            round: { name: "arcade.round", kind: "plan_apply", target: n("target", 120), seconds },
            note: "pa",
            budgetMs: seconds * 1_000 + slack,
          };
        }
        case "unseal": {
          const seconds = n("unsealSeconds", 20);
          return {
            round: { name: "arcade.round", kind: "unseal", seconds },
            note: "unseal",
            budgetMs: seconds * 1_000 + slack,
          };
        }
        case "tug_of_raft": {
          const pulls = n("tugPulls", 2);
          const pullSeconds = n("tugPullSeconds", 12);
          return {
            round: {
              name: "arcade.round",
              kind: "tug_of_raft",
              pulls,
              pullSeconds,
              bpm: n("tugBpm", 100),
            },
            note: "tug",
            budgetMs: pulls * pullSeconds * 1_000 + slack,
          };
        }
        case "glass_bridge": {
          const waves: [number, number, number] = [n("wave1", 8), n("wave2", 7), n("wave3", 6)];
          return {
            round: { name: "arcade.round", kind: "glass_bridge", waveSeconds: waves },
            note: "glass",
            // Six steps a wave, three waves.
            budgetMs: (waves[0] + waves[1] + waves[2]) * 6 * 1_000 + slack,
          };
        }
        default:
          // Gganbu, or something a future console offers that this does not
          // know. Named rather than skipped silently.
          log(`  the staged plan names a round this harness cannot drive: ${kind}`);
          return null;
      }
    };

    const kinds = this.staged?.rounds ?? [
      "recruitment",
      "plan_apply",
      "unseal",
      "tug_of_raft",
      "glass_bridge",
    ];
    return kinds.map(build).filter((r): r is NonNullable<typeof r> => r !== null);
  }

  /** Seal, grant a couple of Spot Awards, then reveal — the real ending. */
  private async standings(bots: readonly Bot[]): Promise<void> {
    await this.press({ name: "segment", kind: "standings" }, "seg-standings", 900);
    await this.press({ name: "seal", state: "sealed" }, "seal", 900);

    const withPid = bots.map((b) => b.conn.pid).filter((pid): pid is string => pid !== null);
    const activity = this.state?.activities[0]?.id;
    if (activity !== undefined) {
      for (const pid of withPid.slice(0, 2)) {
        await this.press(
          { name: "spot.grant", pid, activityId: activity, reason: "best recovery of the afternoon" },
          `spot-${pid.slice(0, 6)}`,
          700,
        );
      }
    }
    await this.press({ name: "seal", state: "revealed" }, "reveal", 2_000);
  }

  /** The send-off, if the event staged one. Walks it to the end. */
  private async sendoff(): Promise<void> {
    if (this.state?.sendoff === undefined) return;
    await this.press({ name: "segment", kind: "sendoff" }, "seg-sendoff", 1_200);
    // Auto, so the run does not depend on this bot pressing sixty times, and
    // fast, so a smoke test is not eight minutes of photographs.
    await this.press({ name: "sendoff.auto", auto: true }, "sendoff-auto", 600);
    await this.press({ name: "sendoff.speed", seconds: 2 }, "sendoff-speed", 600);
    await this.press({ name: "sendoff.next" }, "sendoff-start", 1_000);
    await this.until(
      () => this.state?.sendoff?.phase === "done" || this.state?.sendoff?.phase === "closing",
      60_000,
      "the send-off to finish",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const pad = (s: string, n: number): string => s.padEnd(n);
const kb = (n: number): string => `${(n / 1024).toFixed(1)}KB`;

function report(
  bots: readonly Bot[],
  host: Conn,
  screen: Conn | null,
  opts: Opts,
  elapsedMs: number,
): number {
  const conns = bots.map((b) => b.conn);
  const joined = conns.filter((c) => c.joinedAt !== null);
  const refused = conns.filter((c) => c.refused !== null);
  const never = conns.filter((c) => c.joinedAt === null && c.refused === null);
  const joinMs = joined.map((c) => (c.joinedAt ?? 0) - c.openedAt);
  const allAcks = conns.flatMap((c) => c.ackMs);
  const openGaps = conns.flatMap((c) => c.gaps.filter((g) => !g.closed).map((g) => ({ c, g })));
  const closedGaps = conns.reduce((n, c) => n + c.gaps.filter((g) => g.closed).length, 0);
  const segments = new Map<string, number>();
  for (const c of joined) {
    const seg = c.state?.segment ?? "(no state)";
    segments.set(seg, (segments.get(seg) ?? 0) + 1);
  }

  const out: string[] = [];
  const line = (s = ""): void => void out.push(s);

  line();
  line(`  swarm — ${opts.count} bots against ${opts.url}`);
  line(`  seed ${opts.seed} · ${(elapsedMs / 1000).toFixed(1)}s`);
  line();

  line("  Joining");
  line(`    joined       ${joined.length} of ${opts.count}`);
  if (joinMs.length > 0) {
    line(
      `    time to welcome   p50 ${percentile(joinMs, 50)}ms · p95 ${percentile(joinMs, 95)}ms · slowest ${Math.max(...joinMs)}ms`,
    );
  }
  const limited = refused.filter((c) => c.refused?.startsWith("rate_limited"));
  for (const c of refused.filter((c) => !limited.includes(c))) {
    line(`    refused      ${pad(c.label, 14)} ${c.refused}`);
  }
  if (limited.length > 0) {
    line(`    rate limited ${limited.length} of ${opts.count}`);
    line(`                 the server admits 10 hellos a minute per IP and every`);
    line(`                 bot here shares one, so a run of more than 10 needs`);
    line(`                 --stagger 6500 or more to get past it. A room behind`);
    line(`                 one office NAT shares an IP too, and cannot stagger.`);
  }
  for (const c of never) line(`    never joined ${pad(c.label, 14)} ${c.error ?? "silent"}`);
  line();

  const bytes = conns.map((c) => c.bytes);
  const frames = conns.map((c) => c.frames);
  line("  Frames, per socket");
  if (bytes.length > 0) {
    line(
      `    received     p50 ${percentile(frames, 50)} · max ${Math.max(...frames)} frames`,
    );
    line(
      `    bytes        p50 ${kb(percentile(bytes, 50))} · max ${kb(Math.max(...bytes))} · total ${kb(bytes.reduce((a, b) => a + b, 0))}`,
    );
    line(`    largest frame ${kb(Math.max(...conns.map((c) => c.largestFrame)))}`);
  }
  line(`    host socket  ${host.frames} frames · ${kb(host.bytes)} · largest ${kb(host.largestFrame)}`);
  if (screen !== null) {
    line(`    Desktop      ${screen.frames} frames · ${kb(screen.bytes)} · largest ${kb(screen.largestFrame)}`);
  } else {
    line(`    Desktop      not connected — pass --screen-token to measure the heaviest surface`);
  }
  line();

  line("  Play");
  line(`    sent         ${conns.reduce((n, c) => n + c.sent, 0)}`);
  line(`    applied      ${conns.reduce((n, c) => n + c.acked, 0)}`);
  line(`    refused      ${conns.reduce((n, c) => n + c.refusedCmds.length, 0)}   (a late or wrong-phase press; the engine is right to)`);
  line(`    no-op        ${conns.reduce((n, c) => n + c.noop, 0)}   (accepted, changed nothing)`);
  line(`    no response  ${conns.reduce((n, c) => n + c.pending.size, 0)}`);
  if (allAcks.length > 0) {
    line(
      // "Reply", not "ack": a refusal is a reply and is timed here too, so
      // calling this an ack round trip would overstate what it measures.
      `    reply round trip  p50 ${percentile(allAcks, 50)}ms · p95 ${percentile(allAcks, 95)}ms · slowest ${Math.max(...allAcks)}ms`,
    );
  }
  line(`    host refusals ${host.refusedCmds.length}`);
  line(`    host silent   ${host.pending.size}   (a command with no reply at all)`);
  for (const r of host.refusedCmds.slice(0, 6)) line(`      ${r}`);
  line();

  const reconnected = conns.filter((c) => c.reconnects > 0);
  if (reconnected.length > 0) {
    line("  Reconnects");
    line(`    dropped and came back  ${reconnected.length}`);
    line(
      `    still connected after   ${reconnected.filter((c) => c.joinedAt !== null && c.refused === null).length}`,
    );
    line();
  }

  /* ---- the experience, as the bots had it ---- */
  const played = conns.length > 0 ? bots.filter((b) => b.conn.joinedAt !== null) : [];
  if (played.length > 0) {
    const secs = (ms: number): string => `${(ms / 1000).toFixed(0)}s`;
    const playMs = played.map((b) => b.posture.idle + b.posture.actionable + b.posture.betting);
    const idlePct = played.map((b, i) => {
      const total = playMs[i] ?? 0;
      return total === 0 ? 0 : Math.round((b.posture.idle / total) * 100);
    });
    const longest = played.map((b) => b.longestIdleMs);
    const rounds = [...new Set(played.flatMap((b) => [...b.actionsByRound.keys()]))].sort(
      (a, b) => a - b,
    );

    line("  The afternoon, as a participant had it");
    line(`    in a game      ${secs(percentile(playMs, 50))} of ${secs(elapsedMs)} elapsed (p50)`);
    line(
      `    nothing to press  p50 ${percentile(idlePct, 50)}% · worst ${Math.max(...idlePct)}% of that time`,
    );
    line(
      `    longest wait   p50 ${secs(percentile(longest, 50))} · worst ${secs(Math.max(...longest))} with nothing pressable`,
    );
    for (const r of rounds) {
      const satOut = played.filter((b) => (b.actionsByRound.get(r) ?? 0) === 0).length;
      const acts = played.map((b) => b.actionsByRound.get(r) ?? 0);
      line(
        `    round ${r}        ${percentile(acts, 50)} actions each (p50)` +
          (satOut > 0 ? ` · ${satOut} bot(s) pressed nothing at all` : ""),
      );
    }

    // Where the waiting happened. A run that says somebody waited two minutes
    // and not where is a report that raises a question and answers none.
    const where = new Map<string, number[]>();
    for (const b of played) {
      for (const [k, ms] of b.idleWhere) {
        const seen = where.get(k) ?? [];
        seen.push(ms);
        where.set(k, seen);
      }
    }
    const ranked = [...where.entries()]
      .map(([k, all]) => ({ k, median: percentile(all, 50) }))
      .filter((e) => e.median > 0)
      .sort((a, b) => b.median - a.median);
    if (ranked.length > 0) {
      line("    waiting happened in");
      for (const e of ranked.slice(0, 5)) {
        line(`      ${pad(e.k, 26)} ${secs(e.median)} (p50)`);
      }
    }
    line();
  }

  line("  Where everyone ended");
  for (const [seg, n] of [...segments].sort((a, b) => b[1] - a[1])) {
    line(`    ${pad(seg, 14)} ${n}`);
  }
  line();

  /* ---- checks ---- */
  interface Check {
    ok: boolean;
    text: string;
  }
  const checks: Check[] = [
    {
      ok: never.length === 0,
      text:
        never.length === 0
          ? `every bot that opened a socket was answered`
          : `${never.length} bot(s) never got a welcome`,
    },
    {
      ok: refused.length === 0,
      text:
        refused.length === 0
          ? "no bot was refused"
          : `${refused.length} bot(s) refused — ${[...new Set(refused.map((c) => c.refused?.split(":")[0]))].join(", ")}`,
    },
    {
      ok: openGaps.length === 0,
      text:
        openGaps.length === 0
          ? `no unclosed seq gap (${closedGaps} gap(s) seen and recovered)`
          : `${openGaps.length} seq gap(s) never closed`,
    },
    {
      // `segments` is built from bots that joined, so `size <= 1` passes
      // vacuously when none did. Requiring one segment *and* somebody in it
      // stops a total failure reading as agreement.
      ok: segments.size === 1 && joined.length > 0,
      text:
        segments.size === 1 && joined.length > 0
          ? `all ${joined.length} bots ended on the same segment`
          : joined.length === 0
            ? "no bot joined, so there is no agreement to report"
            : `bots ended on ${segments.size} different segments — a desync`,
    },
    {
      // Answered, not applied: the engine refusing a late tap is correct, and
      // silence is the fault. A frame with no response at all means the
      // server took it and said nothing, which a client cannot recover from.
      ok: conns.every((c) => c.pending.size === 0),
      text: conns.every((c) => c.pending.size === 0)
        ? "every frame sent got an answer, applied or refused"
        : `${conns.reduce((n, c) => n + c.pending.size, 0)} frame(s) got no response at all`,
    },
    {
      ok: host.refusedCmds.length === 0,
      text:
        host.refusedCmds.length === 0
          ? "no host command was refused"
          : `${host.refusedCmds.length} host command(s) refused`,
    },
    {
      ok: host.pending.size === 0,
      text:
        host.pending.size === 0
          ? "every host command got a reply"
          : `${host.pending.size} host command(s) got no reply at all`,
    },
    {
      ok: reconnected.every((c) => c.refused === null),
      text: reconnected.length === 0
        ? "no bot was asked to reconnect"
        : reconnected.every((c) => c.refused === null)
          ? `all ${reconnected.length} bot(s) that dropped came back as themselves`
          : `${reconnected.filter((c) => c.refused !== null).length} bot(s) could not rejoin`,
    },
    {
      // Not a mechanical failure — the server can be perfect and the
      // afternoon still be dull. This is the only check about whether the
      // event was worth attending.
      ok: played.every((b) => b.longestIdleMs < IDLE_ALARM_MS),
      text: played.every((b) => b.longestIdleMs < IDLE_ALARM_MS)
        ? `nobody sat longer than ${IDLE_ALARM_MS / 1000}s with nothing to press`
        : `${played.filter((b) => b.longestIdleMs >= IDLE_ALARM_MS).length} bot(s) sat over ` +
          `${IDLE_ALARM_MS / 1000}s with nothing to press — the failure the arcade exists to avoid`,
    },
    {
      ok: conns.every((c) => c.error === null),
      text: conns.every((c) => c.error === null)
        ? "no socket errored"
        : `${conns.filter((c) => c.error !== null).length} socket(s) errored`,
    },
  ];

  line("  Checks");
  for (const c of checks) line(`    ${c.ok ? "ok  " : "FAIL"}  ${c.text}`);
  line();

  process.stdout.write(out.join("\n") + "\n");
  return checks.every((c) => c.ok) ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

/** What a bot types at a Recruitment cue. It does not know which is right. */
const PRODUCTS = [
  "terraform", "vault", "consul", "nomad", "packer", "vagrant", "boundary", "waypoint",
];

const NAMES = [
  "Ada", "Bo", "Cleo", "Dev", "Eli", "Fen", "Gus", "Hana", "Ines", "Jo",
  "Kit", "Lux", "Mira", "Nils", "Ola", "Pax", "Quin", "Rui", "Sana", "Tao",
  "Uma", "Vik", "Wren", "Xan", "Yara", "Zeke",
];

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const wsUrl = socketUrl(opts.url);
  const started = Date.now();

  // Every socket that says hello counts against the same bucket — the bots,
  // the host, the Desktop, and every reconnect and late arrival. A run that
  // cannot fit inside ten a minute will report refusals that are the limit,
  // not the server failing, and it is better to say so before the run than to
  // explain it in the report afterwards.
  // Read from the server's own constant rather than written down here, so a
  // change to the limit cannot leave this warning quoting a number the server
  // stopped using — which it did, within an hour of the limit being raised.
  const hellos = opts.count + 1 + (opts.screenToken !== null ? 1 : 0) + opts.churnCount;
  log(`  ${opts.count} bots against ${wsUrl}`);
  if (opts.staggerMs === 0 && hellos > HELLO_FLOOD_LIMIT) {
    const overhead = hellos - opts.count;
    log(
      `  warning: this run needs ${hellos} hellos (bots + host${opts.screenToken !== null ? " + Desktop" : ""}${opts.churnCount > 0 ? " + reconnects" : ""}) ` +
        `and the server admits ${HELLO_FLOOD_LIMIT} a minute per IP.`,
    );
    log(`           expect refusals. Use --stagger, or ${HELLO_FLOOD_LIMIT - overhead} bots or fewer.`);
  }

  const hostConn = new Conn("host");
  await connect(wsUrl, hostConn, { t: "hello", role: "host", hostToken: opts.hostToken }, (st) => {
    hostConn.state = st;
  });
  if (hostConn.joinedAt === null) {
    die(`  the host socket did not connect: ${hostConn.refused ?? hostConn.error ?? "silent"}`);
  }
  await waitFor(() => hostConn.state !== null, 5_000);

  // The Desktop, when a token is given. It is the surface with the heaviest
  // frames — the host console and the big screen both receive a full state on
  // every roster change — and until now nothing measured it.
  let screen: Conn | null = null;
  if (opts.screenToken !== null) {
    screen = new Conn("screen");
    await connect(
      wsUrl,
      screen,
      { t: "hello", role: "screen", screenToken: opts.screenToken },
      (st) => {
        if (screen !== null) screen.state = st;
      },
    );
    if (screen.joinedAt === null) log(`  the Desktop did not connect: ${screen.refused ?? screen.error ?? "silent"}`);
  }

  const bots = Array.from({ length: opts.count }, (_, i) => {
    const suffix = i >= NAMES.length ? `-${Math.floor(i / NAMES.length)}` : "";
    return new Bot(i, `${NAMES[i % NAMES.length]}${suffix}`, opts.seed);
  });

  const joinBot = async (b: Bot): Promise<void> => {
    await connect(
      wsUrl,
      b.conn,
      {
        t: "hello",
        role: "participant",
        joinCode: opts.code,
        nickname: b.nickname,
        ...(b.conn.rejoinToken !== null ? { rejoinToken: b.conn.rejoinToken } : {}),
      },
      (st) => b.react(st),
    );
  };

  // The staged plan, if asked for. The sid comes from `welcome`, which is why
  // this happens after the host socket is up rather than from the arguments.
  let staged: StagedPlan | null = null;
  if (opts.fromSession) {
    const sid = hostConn.state?.sid ?? null;
    if (sid === null) {
      log("  --from-session: no sid yet; playing the built-in sweep");
    } else {
      staged = await fetchStagedPlan(opts.url, sid, opts.hostToken);
      if (staged !== null) {
        log(`  playing the staged plan: ${staged.rounds.join(", ")}`);
      }
    }
  }

  // One clock for every bot, ticking whether or not the server says anything.
  // Sampling on broadcasts would have measured the server's chattiness: a bot
  // with nothing to press is also a bot nobody is broadcasting about, so the
  // quietest stretches would have counted for the least.
  const SAMPLE_MS = 500;
  const sampler = setInterval(() => {
    for (const b of bots) b.sample(SAMPLE_MS);
  }, SAMPLE_MS);
  sampler.unref?.();

  const host = new HostBot(hostConn, opts, staged);
  await host.openLobby();

  // Everyone but the late arrivals, all at once: a QR code on a screen makes
  // a storm, and staggering by default would test something that does not
  // happen. `--stagger` exists because ten hellos a minute per IP is the cap.
  const onTime = bots.slice(0, bots.length - opts.lateCount);
  const late = bots.slice(bots.length - opts.lateCount);
  await Promise.all(
    onTime.map(async (b, i) => {
      if (opts.staggerMs > 0) await sleep(i * opts.staggerMs);
      return joinBot(b);
    }),
  );

  const show = host.run(bots);

  // People who wander in after it has started. They get Bench Credit rather
  // than a zero, which is a rule nothing has ever exercised over a socket.
  if (late.length > 0) {
    void (async () => {
      await sleep(12_000);
      log(`  ${late.length} late joiner(s) arriving`);
      for (const b of late) {
        await joinBot(b);
        await sleep(600);
      }
    })();
  }

  // Phones that drop and come back. `rejoinToken` is what restores the same
  // participant, and until now the swarm captured it and never used it — so
  // the reconnect path, which every real event hits, was untested.
  if (opts.churnCount > 0) {
    void (async () => {
      await sleep(30_000);
      const victims = bots.slice(0, opts.churnCount);
      log(`  ${victims.length} bot(s) dropping and reconnecting`);
      for (const b of victims) {
        b.conn.ws?.close();
        b.conn.reconnects += 1;
        await sleep(1_500);
        await joinBot(b);
        await sleep(400);
      }
    })();
  }

  await show;
  await sleep(2_500); // let the last acks and broadcasts land

  clearInterval(sampler);
  const code = report(bots, hostConn, screen, opts, Date.now() - started);
  for (const b of bots) b.conn.ws?.close();
  hostConn.ws?.close();
  screen?.ws?.close();
  process.exit(code);
}

void main();
