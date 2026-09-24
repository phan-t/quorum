/**
 * The bot harness: drive N simulated participants through a whole session
 * against the reducer, in memory.
 *
 *     npm run bots -- 30
 *     npm run bots -- 30 --seed 99
 *     npm run bots -- 30 --seed random
 *
 * No network, no server, no database — events go straight into `reduce`. The
 * point is to know the engine behaves at real scale before any UI exists, and
 * to have something a person can read at a glance and spot a wrong number in.
 *
 * Deterministic by default: same seed, same run, so a strange result can be
 * reproduced and argued about. The only randomness is the seeded PRNG below;
 * the clock is a counter, not `Date.now()`.
 *
 * A rejected event is not the same as an accepted one. `reduce` returns a
 * `reject` effect and leaves `seq` alone, and this harness counts every one of
 * them: a bot whose join was refused is not a participant and must not turn up
 * in the standings. The checks at the bottom of the report assert exactly that.
 */

import type {
  Activity,
  ActivityId,
  Effect,
  Event,
  ParticipantId,
  RejectCode,
  SessionState,
} from "../engine/types.ts";
import { newSession, nicknameKey, reduce } from "../engine/reducer.ts";
import type { ActivityPoints } from "../engine/scoring.ts";
import { breakTie, computeStandings, topFive } from "../engine/scoring.ts";

/* ------------------------------------------------------------------ */
/* Seeded PRNG                                                         */
/* ------------------------------------------------------------------ */

/** mulberry32 — small, fast, and good enough to make a run reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error("pick() from an empty list");
    return item;
  }

  /** Box–Muller. Scores in a real room cluster; they are not uniform. */
  gauss(mean: number, sd: number): number {
    const u = Math.max(this.next(), Number.EPSILON);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      const a = out[i];
      const b = out[j];
      if (a !== undefined && b !== undefined) {
        out[i] = b;
        out[j] = a;
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Driving the reducer                                                 */
/* ------------------------------------------------------------------ */

type Outcome = "accepted" | "rejected" | "ignored";

interface Dispatched {
  readonly label: string;
  readonly outcome: Outcome;
  readonly code: RejectCode | null;
  readonly message: string | null;
}

function isReject(e: Effect): e is Extract<Effect, { kind: "reject" }> {
  return e.kind === "reject";
}

/**
 * Holds the state, the fake clock and the log. Every event the harness sends
 * goes through `send`, so nothing can quietly swallow a rejection.
 */
class Run {
  state: SessionState;
  clock: number;
  readonly log: Dispatched[] = [];
  readonly steps: { readonly what: string; readonly detail: string }[] = [];

  constructor(state: SessionState, startedAt: number) {
    this.state = state;
    this.clock = startedAt;
  }

  tick(ms: number): void {
    this.clock += ms;
  }

  send(event: Event, label: string): Dispatched {
    const before = this.state.seq;
    const { state, effects } = reduce(this.state, event, this.clock);
    this.state = state;

    const rejection = effects.find(isReject);
    const outcome: Outcome = rejection
      ? "rejected"
      : state.seq > before
        ? "accepted"
        : "ignored";

    const d: Dispatched = {
      label,
      outcome,
      code: rejection ? rejection.code : null,
      message: rejection ? rejection.message : null,
    };
    this.log.push(d);
    return d;
  }

  step(what: string, detail: string): void {
    this.steps.push({ what, detail });
  }

  count(outcome: Outcome): number {
    return this.log.filter((d) => d.outcome === outcome).length;
  }
}

/* ------------------------------------------------------------------ */
/* The run of show                                                     */
/* ------------------------------------------------------------------ */

const ACTIVITIES: readonly Activity[] = [
  { id: "ttx", title: "Agentic Security TTX", kind: "manual", spotCap: 2 },
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

/** TTX first, as SPEC.md's tiebreak section says. */
const TIEBREAK_ORDER: readonly ActivityId[] = ["ttx", "trivia", "arcade"];

const PLAUSIBLE = [
  "Kenji", "Priya", "Ade", "Mei", "Tom", "Ravi", "Sofia", "Hannah",
  "Diego", "Yuki", "Amara", "Jonas", "Leila", "Marcus", "Nadia", "Oscar",
  "Pia", "Quinn", "Rahul", "Sana", "Theo", "Uma", "Viktor", "Wei",
  "Ximena", "Yusuf", "Zara", "Ben", "Chloe", "Dev", "Elena", "Finn",
  "Grace", "Hugo", "Ines", "Jae", "Kira", "Liam", "Mira", "Noor",
  "Otto", "Pax", "Rita", "Suri", "Tariq", "Ada", "Bao", "Cleo",
] as const;

interface Awkward {
  readonly nickname: string;
  /** What this one is probing. Printed next to the outcome. */
  readonly probes: string;
}

/**
 * The inputs a real room produces and a demo never does. `Kenji` is the first
 * plausible name in the shuffled pool's place 0, so the duplicates land after
 * a real Kenji has joined.
 */
function awkwardCases(firstName: string): readonly Awkward[] {
  return [
    { nickname: "", probes: "empty" },
    { nickname: "   ", probes: "whitespace only" },
    { nickname: "!!!", probes: "punctuation only" },
    { nickname: "  Robin  ", probes: "leading/trailing space, otherwise fine" },
    { nickname: `  ${firstName}  `, probes: `leading/trailing space — the same person as ${firstName}` },
    { nickname: firstName.toLowerCase(), probes: "duplicate, different case" },
    { nickname: firstName.toUpperCase().split("").join(" "), probes: "duplicate after folding spaces" },
    { nickname: "Ayşe", probes: "unicode, latin-ish" },
    { nickname: "Zoë", probes: "unicode, accented" },
    { nickname: "こうた", probes: "non-latin script" },
    { nickname: "🦊 Fox", probes: "emoji" },
    { nickname: "Bartholomew Maximilian Featherstonehaugh III of the Northern Reaches", probes: "very long (68 chars)" },
    { nickname: "A".repeat(200), probes: "absurdly long (200 chars)" },
  ];
}

interface Bot {
  readonly pid: ParticipantId;
  readonly nickname: string;
  /** Set when this nickname is here to probe something. */
  readonly probes: string | null;
  /** True for the one bot who joins mid-trivia rather than in the lobby. */
  readonly late: boolean;
}

function planBots(n: number, rng: Rng): Bot[] {
  const pool = rng.shuffled(PLAUSIBLE);
  const nameAt = (i: number): string => {
    const base = pool[i % pool.length] ?? "Bot";
    const round = Math.floor(i / pool.length);
    return round === 0 ? base : `${base} ${round + 1}`;
  };

  const bots: Bot[] = [];
  for (let i = 0; i < n; i += 1) {
    bots.push({
      pid: `p${String(i + 1).padStart(3, "0")}`,
      nickname: nameAt(i),
      probes: null,
      late: false,
    });
  }

  // Awkward inputs from index 4 up, every other slot, so plausible names still
  // dominate and the duplicates have someone to collide with.
  const cases = awkwardCases(nameAt(0));
  let slot = 4;
  for (const c of cases) {
    if (slot >= n - 1) break;
    const existing = bots[slot];
    if (existing) {
      bots[slot] = { ...existing, nickname: c.nickname, probes: c.probes };
    }
    slot += 2;
  }

  // The last bot arrives during trivia. Late join is the most common real
  // failure mode after nickname collisions, so it is always in the run.
  const last = bots[n - 1];
  if (last) bots[n - 1] = { ...last, late: true, probes: "joins during trivia" };

  return bots;
}

interface JoinResult {
  readonly bot: Bot;
  readonly result: Dispatched;
}

/** A raw score with an occasional flat one — a phone dies in every session. */
function rawFor(rng: Rng, kind: Activity["kind"]): number {
  const dud = rng.chance(0.07);
  switch (kind) {
    case "manual":
      return dud ? rng.int(0, 8) : Math.round(clamp(rng.gauss(32, 9), 0, 50));
    case "trivia":
      return dud
        ? rng.int(0, 2500)
        : Math.round(clamp(rng.gauss(11000, 3200), 0, 20000) / 10) * 10;
    case "arcade":
      return dud ? rng.int(0, 40) : Math.round(clamp(rng.gauss(150, 45), 0, 300));
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

const SPOT_REASONS = [
  "best recovery of the afternoon",
  "talked the whole Lounge through the bridge",
  "spotted the prompt injection nobody else did",
  "kept the room together when the call dropped",
];

interface RunOutput {
  readonly run: Run;
  readonly bots: readonly Bot[];
  readonly joins: readonly JoinResult[];
  readonly probeJoins: readonly { readonly what: string; readonly result: Dispatched }[];
  readonly benched: readonly { readonly pid: ParticipantId; readonly activityId: ActivityId; readonly why: string }[];
  readonly blips: { readonly dropped: number; readonly back: number };
}

function runSession(n: number, seed: number): RunOutput {
  const rng = new Rng(seed);
  const bots = planBots(n, rng);

  // A fixed wall clock: 25 Sep 2026, 14:00 UTC. Nothing reads the real one.
  const run = new Run(
    newSession({
      sid: `ses-${seed}`,
      title: "SA APJ huddle",
      joinCode: "RAFT",
      activities: ACTIVITIES,
      tiebreakOrder: TIEBREAK_ORDER,
    }),
    Date.UTC(2026, 8, 25, 14, 0, 0),
  );

  const joins: JoinResult[] = [];
  const probeJoins: { what: string; result: Dispatched }[] = [];
  const benched: { pid: ParticipantId; activityId: ActivityId; why: string }[] = [];

  /* -- draft → lobby -------------------------------------------------- */

  run.send({ type: "open" }, "open");
  run.step("open", `phase ${run.state.phase} · code ${run.state.joinCode}`);

  /* -- the lobby fills ------------------------------------------------ */

  const lobbyBots = bots.filter((b) => !b.late);
  for (const bot of lobbyBots) {
    run.tick(rng.int(120, 1400));
    joins.push({
      bot,
      result: run.send({ type: "join", pid: bot.pid, nickname: bot.nickname }, `join ${quote(bot.nickname)}`),
    });
  }
  const seated = () => joins.filter((j) => j.result.outcome === "accepted").map((j) => j.bot);
  run.step(
    `joins ×${lobbyBots.length}`,
    `${seated().length} accepted · ${lobbyBots.length - seated().length} refused`,
  );

  /* -- lobby → running ------------------------------------------------ */

  run.tick(45_000);
  run.send({ type: "start" }, "start");
  run.step("start", `phase ${run.state.phase}`);

  /* -- activity 1: the TTX, scored by hand ---------------------------- */

  run.send(
    { type: "setHolding", holding: { title: "Security tabletop", line: "The facilitator has the room. Back here at 2:40." } },
    "setHolding TTX",
  );
  run.send({ type: "setSegment", segment: "holding" }, "segment holding");
  run.step("segment → holding", "Agentic Security TTX");

  // Benching needs someone left to score. A two-bot run has nobody to spare.
  const maybePick = <T,>(items: readonly T[]): T | undefined =>
    items.length > 0 ? rng.pick(items) : undefined;
  const facilitator = seated().length >= 3 ? maybePick(seated()) : undefined;
  if (facilitator) {
    run.send({ type: "setStatus", activityId: "ttx", pid: facilitator.pid, status: "bench" }, "bench facilitator");
    benched.push({ pid: facilitator.pid, activityId: "ttx", why: "facilitated the TTX" });
    run.step("bench", `${facilitator.nickname} — facilitated the TTX`);
  } else {
    run.step("bench", "skipped — too few bots to spare a facilitator");
  }

  let ttxScored = 0;
  for (const bot of seated()) {
    if (bot.pid === facilitator?.pid) continue;
    run.tick(rng.int(400, 2000));
    const d = run.send(
      { type: "setScore", activityId: "ttx", pid: bot.pid, raw: rawFor(rng, "manual") },
      `setScore ttx ${bot.nickname}`,
    );
    if (d.outcome === "accepted") ttxScored += 1;
  }
  run.step("TTX raw scores", `${ttxScored} entered by hand`);

  run.send({ type: "setSegment", segment: "standings" }, "segment standings");
  run.step("segment → standings", `seal ${run.state.seal}`);

  /* -- activity 2: trivia, and someone arrives late ------------------- */

  run.tick(30_000);
  run.send({ type: "setSegment", segment: "trivia" }, "segment trivia");
  run.step("segment → trivia", "20 questions");

  const lateBot = bots.find((b) => b.late);
  if (lateBot) {
    run.tick(rng.int(60_000, 200_000));
    const result = run.send(
      { type: "join", pid: lateBot.pid, nickname: lateBot.nickname },
      `join ${quote(lateBot.nickname)} (late)`,
    );
    joins.push({ bot: lateBot, result });
    if (result.outcome === "accepted") {
      run.send({ type: "setStatus", activityId: "ttx", pid: lateBot.pid, status: "bench" }, "bench late joiner");
      benched.push({ pid: lateBot.pid, activityId: "ttx", why: "joined during trivia, missed the TTX" });
      run.step("late join", `${lateBot.nickname} — benched for the TTX`);
    }
  }

  let triviaScored = 0;
  for (const bot of seated()) {
    run.tick(rng.int(50, 400));
    const d = run.send(
      { type: "setScore", activityId: "trivia", pid: bot.pid, raw: rawFor(rng, "trivia") },
      `setScore trivia ${bot.nickname}`,
    );
    if (d.outcome === "accepted") triviaScored += 1;
  }
  run.step("trivia scores", `${triviaScored} from the question flow`);

  const spotOne = maybePick(seated().filter((b) => b.pid !== facilitator?.pid));
  if (spotOne) {
    run.send(
      { type: "grantSpot", pid: spotOne.pid, activityId: "trivia", reason: SPOT_REASONS[0] ?? "" },
      `grantSpot trivia ${spotOne.nickname}`,
    );
    run.step("spot award", `${spotOne.nickname} — trivia`);
  }

  run.send({ type: "setSegment", segment: "standings" }, "segment standings");

  /* -- seal before the last activity ---------------------------------- */

  run.tick(20_000);
  run.send({ type: "setSeal", seal: "sealed" }, "seal");
  run.send({ type: "setJoinsLocked", locked: true }, "lock joins");
  run.step("seal", "standings sealed, joins locked, before the last activity");

  /* -- a straggler, refused because the lobby is locked --------------- */

  probeJoins.push({
    what: "straggler after the lobby locked",
    result: run.send({ type: "join", pid: "probe-late", nickname: "Straggler" }, "join (locked)"),
  });

  /* -- activity 3: the arcade ----------------------------------------- */

  run.send({ type: "setSegment", segment: "arcade" }, "segment arcade");
  run.step("segment → arcade", "five rounds, Floor and Lounge");

  let arcadeScored = 0;
  for (const bot of seated()) {
    run.tick(rng.int(50, 400));
    const d = run.send(
      { type: "setScore", activityId: "arcade", pid: bot.pid, raw: rawFor(rng, "arcade") },
      `setScore arcade ${bot.nickname}`,
    );
    if (d.outcome === "accepted") arcadeScored += 1;
  }
  run.step("arcade scores", `${arcadeScored} from the rounds`);

  // Phones sleep, wifi drops. Most come back.
  let dropped = 0;
  let back = 0;
  for (const bot of seated()) {
    if (!rng.chance(0.15)) continue;
    run.tick(rng.int(500, 4000));
    if (run.send({ type: "disconnect", pid: bot.pid }, `disconnect ${bot.nickname}`).outcome === "accepted") {
      dropped += 1;
      if (rng.chance(0.8)) {
        run.tick(rng.int(2000, 20_000));
        if (run.send({ type: "reconnect", pid: bot.pid }, `reconnect ${bot.nickname}`).outcome === "accepted") {
          back += 1;
        }
      }
    }
  }
  run.step("connection blips", `${dropped} dropped · ${back} came back`);

  const spotTwo = maybePick(
    seated().filter((b) => b.pid !== facilitator?.pid && b.pid !== spotOne?.pid),
  );
  if (spotTwo) {
    run.send(
      { type: "grantSpot", pid: spotTwo.pid, activityId: "arcade", reason: SPOT_REASONS[1] ?? "" },
      `grantSpot arcade ${spotTwo.nickname}`,
    );
    run.step("spot award", `${spotTwo.nickname} — arcade`);
  }

  /* -- deliberate probes of the rules the console must not break ------- */

  const anyone = maybePick(seated());
  if (anyone) {
    run.send(
      { type: "grantSpot", pid: anyone.pid, activityId: "arcade", reason: "   " },
      "probe: spot award with a blank reason",
    );
    run.send(
      { type: "setScore", activityId: "lounge", pid: anyone.pid, raw: 10 },
      "probe: score for an activity that does not exist",
    );
  }
  if (facilitator) {
    run.send(
      { type: "grantSpot", pid: facilitator.pid, activityId: "ttx", reason: "ran it beautifully" },
      "probe: spot award to someone on bench credit",
    );
  }
  run.send(
    { type: "setScore", activityId: "arcade", pid: "ghost", raw: 10 },
    "probe: score for a participant who never joined",
  );

  /* -- close and reveal ----------------------------------------------- */

  run.tick(60_000);
  run.send({ type: "close" }, "close");
  run.step("close", `segment ${run.state.segment} · seal ${run.state.seal}`);

  probeJoins.push({
    what: "join after the session closed",
    result: run.send({ type: "join", pid: "probe-closed", nickname: "TooLate" }, "join (closed)"),
  });

  return { run, bots, joins, probeJoins, benched, blips: { dropped, back } };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

/** Display width, so a table does not skew on CJK or emoji nicknames. */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x0300 && cp <= 0x036f) continue; // combining mark
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

function cut(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (width(out) + width(ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function pad(s: string, n: number): string {
  const t = cut(s, n);
  return t + " ".repeat(Math.max(0, n - width(t)));
}

function padStart(s: string, n: number): string {
  return " ".repeat(Math.max(0, n - width(s))) + s;
}

function quote(s: string): string {
  return `"${s.replace(/\n/g, "\\n")}"`;
}

const out: string[] = [];
function say(line = ""): void {
  out.push(line);
}

function cell(p: ActivityPoints | undefined): string {
  if (!p || p.source === "unset") return "—";
  if (p.source === "bench") return p.points === null ? "bench —" : `${p.points} bench`;
  return `${p.points ?? 0} (${p.raw ?? 0})`;
}

function report(o: RunOutput, n: number, seed: number, seedLabel: string): boolean {
  const { run, joins, probeJoins, benched, blips } = o;
  const state = run.state;
  const standings = computeStandings(state);
  const accepted = joins.filter((j) => j.result.outcome === "accepted");
  const refused = joins.filter((j) => j.result.outcome === "rejected");
  const nameOf = (pid: ParticipantId): string => state.participants[pid]?.nickname ?? pid;

  say();
  say(`Quorum bot harness — ${n} bots, seed ${seedLabel}`);
  say(`  ${state.title} · code ${state.joinCode} · sid ${state.sid}`);
  for (const a of state.activities) {
    say(`  ${pad(a.id, 8)} ${pad(a.title, 24)} ${a.kind} · ${a.spotCap} spot awards`);
  }
  say(`  tiebreak order: ${state.tiebreakOrder.join(" → ")}`);

  /* run of show */
  say();
  say("Run of show");
  run.steps.forEach((s, i) => {
    say(`  ${padStart(String(i + 1), 2)}  ${pad(s.what, 22)}  ${s.detail}`);
  });

  /* events */
  say();
  say(
    `Events  ${run.log.length} sent · ${run.count("accepted")} accepted · ` +
      `${run.count("rejected")} rejected · ${run.count("ignored")} no-ops · final seq ${state.seq}`,
  );

  /* joins */
  say();
  say(`Joins  ${joins.length} attempted · ${accepted.length} accepted · ${refused.length} refused`);
  const byCode = new Map<RejectCode, JoinResult[]>();
  for (const j of refused) {
    const code = j.result.code;
    if (!code) continue;
    byCode.set(code, [...(byCode.get(code) ?? []), j]);
  }
  for (const [code, list] of byCode) {
    say(`  ${pad(code, 22)} ${list.length}`);
    for (const j of list) {
      say(`    ${pad(quote(cut(j.bot.nickname, 28)), 34)} ${j.result.message ?? ""}`);
    }
  }
  if (refused.length === 0) say("  (none — suspicious, the awkward nicknames should refuse some)");

  /* awkward inputs */
  const awkward = o.bots.filter((b) => b.probes !== null);
  if (awkward.length > 0) {
    say();
    say("Awkward nicknames  what each input did");
    say(`  ${pad("input", 34)} ${pad("folded key", 16)} ${pad("outcome", 26)} probing`);
    for (const bot of awkward) {
      const j = joins.find((x) => x.bot.pid === bot.pid);
      const key = nicknameKey(bot.nickname);
      const outcome =
        j === undefined
          ? "not attempted"
          : j.result.outcome === "accepted"
            ? `joined as ${quote(cut(nameOf(bot.pid), 14))}`
            : `refused ${j.result.code ?? ""}`;
      say(
        `  ${pad(quote(cut(bot.nickname, 30)), 34)} ${pad(key === "" ? "(empty)" : key, 16)} ` +
          `${pad(outcome, 26)} ${bot.probes ?? ""}`,
      );
    }
  }

  /* host action rejections */
  const hostRejects = run.log.filter((d) => d.outcome === "rejected" && !d.label.startsWith("join"));
  say();
  const probeRejects = probeJoins.filter((p) => p.result.outcome === "rejected");
  say(`Host actions and probes refused  ${hostRejects.length + probeRejects.length}`);
  for (const d of hostRejects) {
    say(`  ${pad(d.code ?? "", 26)} ${pad(d.label, 46)} ${d.message ?? ""}`);
  }
  for (const p of probeJoins) {
    say(`  ${pad(p.result.code ?? "accepted", 26)} ${pad(p.what, 46)} ${p.result.message ?? ""}`);
  }

  /* standings */
  const five = topFive(standings);
  const nameCol = 24;
  const cellCol = 13;
  say();
  say(`Final standings — top five of ${standings.length}  (seal: ${state.seal})`);
  say(
    `  ${pad("#", 3)} ${pad("participant", nameCol)} ` +
      state.activities.map((a) => pad(a.id, cellCol)).join(" ") +
      ` ${padStart("spot", 6)} ${padStart("total", 6)}`,
  );
  for (const s of five) {
    say(
      `  ${pad(String(s.rank), 3)} ${pad(s.nickname, nameCol)} ` +
        state.activities.map((a) => pad(cell(s.perActivity[a.id]), cellCol)).join(" ") +
        ` ${padStart(s.spotCount > 0 ? `${s.spotPoints}` : "—", 6)} ${padStart(String(s.total), 6)}`,
    );
  }
  say("  points (raw) per activity · \"N bench\" is Bench Credit · \"—\" is unset");

  /* first place */
  const tie = breakTie(state, standings);
  say();
  const leader = standings[0];
  if (tie.tied.length <= 1) {
    say(`First place  ${leader ? `${leader.nickname}, ${leader.total} points — clear` : "nobody"}`);
  } else if (tie.winner) {
    say(
      `First place  tied at ${leader?.total ?? 0}: ${tie.tied.map(nameOf).join(", ")} ` +
        `→ tiebreak → ${nameOf(tie.winner)}`,
    );
  } else {
    say(
      `First place  still tied after the tiebreak: ${tie.tied.map(nameOf).join(", ")} — sudden death`,
    );
  }

  /* bench credit */
  say();
  say(`Bench credit  ${benched.length} credited`);
  for (const b of benched) {
    const s = standings.find((x) => x.pid === b.pid);
    const p = s?.perActivity[b.activityId];
    const base = s
      ? state.activities
          .filter((a) => s.perActivity[a.id]?.source === "normalised")
          .map((a) => `${a.title} ${s.perActivity[a.id]?.points ?? 0}`)
          .join(", ")
      : "";
    const credited = p?.points === null || p?.points === undefined ? "— (played nothing yet)" : String(p.points);
    const activity = state.activities.find((a) => a.id === b.activityId);
    say(`  ${pad(nameOf(b.pid), 24)} ${pad(activity?.title ?? b.activityId, 22)} credited ${padStart(credited, 4)}   mean of ${base}`);
    say(`  ${pad("", 24)} ${b.why}`);
  }

  /* spot awards */
  say();
  say(`Spot awards  ${state.spots.length} granted`);
  for (const s of state.spots) {
    const activity = state.activities.find((a) => a.id === s.activityId);
    const row = standings.find((x) => x.pid === s.pid);
    const where = row ? `rank ${row.rank}, ${row.total} pts` : "not in the standings";
    say(`  ${pad(activity?.title ?? s.activityId, 22)} ${pad(nameOf(s.pid), 20)} ${pad(where, 20)} ${quote(s.reason)}`);
  }

  /* connections */
  say();
  say(
    `Connections  ${blips.dropped} dropped mid-arcade · ${blips.back} came back · ` +
      `${Object.values(state.participants).filter((p) => !p.connected && !p.kicked).length} offline at close`,
  );

  /* checks */
  const checks: { ok: boolean; what: string }[] = [];
  const inStandings = new Set(standings.map((s) => s.pid));

  checks.push({
    ok: refused.every((j) => !inStandings.has(j.bot.pid)),
    what: `${refused.length} refused joins, none of them in the standings`,
  });
  checks.push({
    ok: probeJoins.every((p) => !inStandings.has("probe-late") && !inStandings.has("probe-closed")),
    what: "locked-lobby and post-close joins refused, neither in the standings",
  });
  checks.push({
    ok: standings.length === accepted.length,
    what: `${standings.length} in the standings = ${accepted.length} accepted joins`,
  });
  checks.push({
    ok: state.seq === run.count("accepted"),
    what: `seq ${state.seq} = ${run.count("accepted")} accepted events (rejections do not bump it)`,
  });
  for (const a of state.activities) {
    const played = standings
      .map((s) => s.perActivity[a.id])
      .filter((p): p is ActivityPoints => p?.source === "normalised")
      .map((p) => p.points ?? 0);
    checks.push({
      ok: played.length === 0 || Math.max(...played) === 100,
      what: `${a.title}: top scorer normalises to 100 (${played.length} played)`,
    });
  }
  const ceiling = state.activities.length * 100;
  checks.push({
    ok: standings.every((s) => s.total <= ceiling + s.spotPoints),
    what: `no total above ${ceiling} + spot awards`,
  });
  checks.push({
    ok: Object.values(state.participants).every((p) => p.playerNumber >= 1) &&
      new Set(Object.values(state.participants).map((p) => p.playerNumber)).size ===
        Object.keys(state.participants).length,
    what: "player numbers are unique and start at 1",
  });

  say();
  say("Checks");
  for (const c of checks) say(`  ${c.ok ? "ok  " : "FAIL"}  ${c.what}`);
  say();

  console.log(out.join("\n"));
  return checks.every((c) => c.ok);
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = `Usage: npm run bots -- [count] [--seed <number|random>]

  count          how many bots join (default 30, max 500)
  --seed         PRNG seed; the same seed replays the same session exactly.
                 "--seed random" picks one and prints it so you can replay it.`;

function main(argv: readonly string[]): void {
  let count = 30;
  let seed = 1337;
  let seedLabel = "1337";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      return;
    }
    if (arg === "--seed") {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined) {
        console.error("--seed needs a value");
        process.exitCode = 2;
        return;
      }
      if (value === "random") {
        seed = Math.floor(Math.random() * 2 ** 31);
        seedLabel = `${seed} (random — pass --seed ${seed} to replay)`;
      } else if (/^\d+$/.test(value)) {
        seed = Number(value);
        seedLabel = value;
      } else {
        console.error(`bad seed ${quote(value)}: want a number or "random"`);
        process.exitCode = 2;
        return;
      }
      continue;
    }
    if (/^\d+$/.test(arg)) {
      count = Number(arg);
      continue;
    }
    console.error(`unknown argument ${quote(arg)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (count < 1 || count > 500) {
    console.error("count must be between 1 and 500");
    process.exitCode = 2;
    return;
  }

  const result = runSession(count, seed);
  const ok = report(result, count, seed, seedLabel);
  if (!ok) process.exitCode = 1;
}

main(process.argv.slice(2));
