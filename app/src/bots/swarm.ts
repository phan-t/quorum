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

import type { ClientMessage, HostCommand, RenderState, ServerMessage } from "../protocol.ts";

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
  return {
    count, url, code, hostToken, seed,
    joinOnly: argv.includes("--join-only"),
    staggerMs,
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
class Bot {
  readonly conn: Conn;
  private readonly rand: () => number;
  private readonly acted = new Set<string>();
  private seq = 0;

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
    if (this.rand() < 0.08) this.acted.add(`q${t.index}`);
    if (!this.once(`q${t.index}`)) return;
    const choice = Math.floor(this.rand() * Math.max(1, t.answers.length));
    this.later(this.think(400, 6_000), () => {
      const now = this.conn.state?.trivia;
      // The question may have closed while this bot was thinking. Sending
      // anyway is what a real phone does, and the refusal is worth counting.
      if (now?.index !== t.index) return;
      this.conn.send({ t: "trivia.answer", cid: this.cid(), index: t.index, choice });
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
          this.conn.send({ t: "arcade.back", cid: this.cid(), pid });
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
      this.conn.send({ t: "arcade.answer", cid: this.cid(), item: r.at, answer: guess });
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
      this.conn.send({ t: "arcade.tap", cid: this.cid(), round });
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
      this.conn.send({ t: "arcade.step", cid: this.cid(), round, step: g.step, choice });
    });
  }

  private playUnseal(s: RenderState, round: number): void {
    const u = s.arcadeMine?.unseal;
    if (!u) return;
    if (u.shape === null && this.once(`shape${round}`)) {
      const shapes = ["circle", "triangle", "star", "umbrella"] as const;
      const shape = shapes[Math.floor(this.rand() * shapes.length)] ?? "triangle";
      this.conn.send({ t: "arcade.shape", cid: this.cid(), round, shape });
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
      this.conn.send({ t: "arcade.letter", cid: this.cid(), round, letter });
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
      this.conn.send({ t: "arcade.beat", cid: this.cid(), round });
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
 * Walk a whole session from the host's seat.
 *
 * Deliberately the same frames the console sends. If the protocol changes
 * under this, the swarm breaks the way a console would, which is the point:
 * a test-only driving endpoint would keep passing while the real console
 * stopped working.
 */
async function runOfShow(host: Conn, bots: readonly Bot[], opts: Opts): Promise<void> {
  const arcade = (): RenderState["arcade"] => host.state?.arcade;

  /**
   * Wait for a round to finish rather than sleeping a guess at its length.
   *
   * Arcade rounds end themselves on their own timer, so a fixed sleep either
   * cuts a round short or presses `arcade.end` on a round that already ended
   * — and the engine refuses the second one. Waiting on the phase is what a
   * host does, and it makes the run honest about how long a round took.
   */
  async function untilRoundOver(budgetMs: number): Promise<void> {
    await waitFor(() => arcade()?.phase !== "running", budgetMs);
    if (arcade()?.phase === "running") {
      // It overran its own clock; end it by hand, which is also a finding.
      await cmd(host, { name: "arcade.end" }, 1_200, "end-overrun");
    }
  }

  await sleep(2_000); // let the joins land
  if (opts.joinOnly) return;

  await cmd(host, { name: "start" }, 1_000, "start");

  const questions = host.state?.trivia?.of ?? 0;
  if (questions > 0) {
    await cmd(host, { name: "segment", kind: "trivia" }, 800, "seg-trivia");
    // Three questions exercises open/close/reveal/next without making a smoke
    // test take twenty minutes.
    const play = Math.min(3, questions);
    for (let i = 0; i < play; i += 1) {
      await cmd(host, { name: "trivia.open", suddenDeath: false }, 500, `q${i}-open`);
      // Close when the room has answered, or when the question's own timer
      // has run — whichever comes first, which is the console's affordance.
      await waitFor(() => host.state?.trivia?.phase !== "open", 20_000);
      if (host.state?.trivia?.phase === "open") {
        await cmd(host, { name: "trivia.close" }, 600, `q${i}-close`);
      }
      await cmd(host, { name: "trivia.reveal" }, 1_200, `q${i}-reveal`);
      if (i + 1 < play) await cmd(host, { name: "trivia.next" }, 700, `q${i}-next`);
    }
  }

  await cmd(host, { name: "segment", kind: "arcade" }, 800, "seg-arcade");
  await cmd(host, { name: "arcade.enter" }, 1_500, "enter");

  await cmd(host, { name: "arcade.round", kind: "recruitment", secondsPerItem: 6 }, 900, "r-rec");
  await cmd(host, { name: "arcade.begin" }, 600, "rec-begin");
  await untilRoundOver(70_000);
  await cmd(host, { name: "arcade.reveal" }, 1_500, "rec-reveal");
  // No "next round" command exists, and `arcade.next` is Recruitment's next
  // *emoji* — pressing it here is refused with `wrong_round_phase`. Moving on
  // is choosing the next round, which is what the console does.

  await cmd(host, { name: "arcade.round", kind: "plan_apply", target: 120, seconds: 20 }, 900, "r-pa");
  await cmd(host, { name: "arcade.begin" }, 600, "pa-begin");
  await untilRoundOver(45_000);
  await cmd(host, { name: "arcade.reveal" }, 1_500, "pa-reveal");

  // Unseal and the Bridge, so the bot code for them actually runs. Without
  // these the shape/letter/step branches are dead code that typechecks: they
  // were written against the protocol and had never once executed.
  await cmd(host, { name: "arcade.round", kind: "unseal", seconds: 20 }, 900, "r-unseal");
  await cmd(host, { name: "arcade.begin" }, 600, "unseal-begin");
  await untilRoundOver(45_000);
  await cmd(host, { name: "arcade.reveal" }, 1_500, "unseal-reveal");

  await cmd(
    host,
    { name: "arcade.round", kind: "glass_bridge", waveSeconds: [8, 7, 6] },
    900,
    "r-glass",
  );
  await cmd(host, { name: "arcade.begin" }, 600, "glass-begin");
  await untilRoundOver(90_000);
  await cmd(host, { name: "arcade.reveal" }, 1_500, "glass-reveal");

  await cmd(host, { name: "segment", kind: "standings" }, 1_000, "seg-standings");
  await cmd(host, { name: "seal", state: "revealed" }, 1_500, "reveal");

  void bots;
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const pad = (s: string, n: number): string => s.padEnd(n);
const kb = (n: number): string => `${(n / 1024).toFixed(1)}KB`;

function report(bots: readonly Bot[], host: Conn, opts: Opts, elapsedMs: number): number {
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

  process.stdout.write(
    `  opening ${opts.count} sockets against ${wsUrl}\n`,
  );

  const host = new Conn("host");
  await connect(wsUrl, host, { t: "hello", role: "host", hostToken: opts.hostToken }, (s) => {
    host.state = s;
  });
  if (host.joinedAt === null) {
    die(`  the host socket did not connect: ${host.refused ?? host.error ?? "silent"}`);
  }

  // Open the lobby first. A staged session is `draft`, and a draft refuses
  // every join with `not_joinable` — so connecting the bots before this
  // measures the refusal path rather than the join path.
  //
  // The wait is the point: `welcome` resolves the connect, and the first
  // `state` follows it. Reading `host.state` straight after connecting finds
  // null, decides the session is already open, and produces a run where every
  // bot is refused — which is how this was first written.
  await waitFor(() => host.state !== null, 5_000);
  if (host.state === null) die("  the host socket never received a state frame.");
  if (host.state.phase === "draft") await cmd(host, { name: "open" }, 1_200, "open");

  const bots = Array.from({ length: opts.count }, (_, i) => {
    const name = `${NAMES[i % NAMES.length]}${i >= NAMES.length ? `-${Math.floor(i / NAMES.length)}` : ""}`;
    return new Bot(i, name, opts.seed);
  });

  // All at once by default, deliberately: a QR code on a screen produces a
  // join storm, and staggering by default would test a thing that does not
  // happen. `--stagger` exists because the server admits ten hellos a minute
  // per IP and every bot here shares one.
  const joins = bots.map(async (b, i) => {
    if (opts.staggerMs > 0) await sleep(i * opts.staggerMs);
    return connect(
      wsUrl,
      b.conn,
      { t: "hello", role: "participant", joinCode: opts.code, nickname: b.nickname },
      (s) => b.react(s),
    );
  });
  await Promise.all(joins);

  await runOfShow(host, bots, opts);
  await sleep(2_000); // let the last acks and broadcasts land

  const code = report(bots, host, opts, Date.now() - started);
  for (const b of bots) b.conn.ws?.close();
  host.ws?.close();
  process.exit(code);
}

void main();
