/**
 * Phase 3's acceptance test. BUILD-PLAN.md: "thirty bots play a full
 * 20-question round and the scores match a hand-computed expectation."
 *
 * Thirty bots play the real launch set — `config/event.example/trivia-questions.json`,
 * the twenty HashiCorp and IBM questions, which is the generic set without the
 * event-specific block an event adds — through the *runtime* (`SessionRuntime`,
 * fake sockets, fake clock), so the path under test is the one a real tap takes: the socket
 * boundary computes the latency-corrected response time, the reducer settles
 * the question, the projection reports it.
 *
 * **The expectation is not the engine.** Nothing in this file imports
 * `questionPoints`, `streakBonus`, `settleQuestion`, `correctedResponseMs` or
 * `medianRtt`. The oracle is {@link specPoints}/{@link specBonus}/
 * {@link specCorrection} below, written from the formulas in SPEC.md "Trivia"
 * and ARCHITECTURE.md "Clocks and fairness" in exact integer arithmetic, plus
 * a per-bot streak walk in {@link expectRound}. Three bots' totals are also
 * worked out by hand in the comments and asserted as literals, so a bug that
 * happened to be shared by the oracle and the engine would still be caught
 * on the numbers a person can check.
 *
 * Deterministic: the only randomness is a seeded PRNG for the eighteen
 * "ordinary" bots; the twelve with a job (see `SPECIAL`) are fixed. Same
 * seed, same round, same numbers.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type {
  Activity,
  Event,
  ParticipantId,
  Question,
  SessionState,
  TriviaAnswer,
} from "../engine/types.ts";
import { newSession, replay } from "../engine/reducer.ts";
import { computeStandings } from "../engine/scoring.ts";
import { SessionRegistry, type Client } from "../server/runtime.ts";
import { renderStateFor, triviaPodium } from "../server/views.ts";
import { importTriviaJson } from "../trivia/import.ts";

/* ------------------------------------------------------------------ */
/* The oracle: SPEC.md, in integers                                     */
/* ------------------------------------------------------------------ */

/**
 * SPEC.md: `round(base × (1 − (t ÷ T) ÷ 2))`, `t` clamped to `[0, T]` so an
 * answer at the buzzer is "worth half of an instant one, never less".
 *
 * Rearranged to a single exact fraction, `base × (2T − t) ÷ 2T`, and rounded
 * half-up in BigInt so no floating-point representation is involved. This is
 * the arithmetic a person does on paper.
 */
export function specPoints(base: number, tMs: number, limitMs: number): number {
  const t = Math.min(Math.max(tMs, 0), limitMs);
  const num = BigInt(base) * BigInt(2 * limitMs - t);
  const den = BigInt(2 * limitMs);
  return Number((2n * num + den) / (2n * den));
}

/** True when `base × (2T − t) ÷ 2T` lands exactly on a half. */
export function isExactHalf(base: number, tMs: number, limitMs: number): boolean {
  const t = Math.min(Math.max(tMs, 0), limitMs);
  const num = BigInt(base) * BigInt(2 * limitMs - t);
  const den = BigInt(2 * limitMs);
  return (2n * num) % den === 0n && num % den !== 0n;
}

/** SPEC.md: `100 × min(n − 1, 5)` for the n-th consecutive correct answer. */
export function specBonus(n: number): number {
  return 100 * Math.min(n - 1, 5);
}

/**
 * ARCHITECTURE.md: `t = serverReceivedAt − opensAt − min(rtt ÷ 2, 250 ms)`,
 * where `rtt` is the server's median of its recent measurements of that
 * socket. An unmeasured socket gets no correction. Odd sample counts only, so
 * "median" means one thing.
 */
export function specCorrection(rtt: readonly number[]): number {
  if (rtt.length === 0) return 0;
  assert.equal(rtt.length % 2, 1, "use an odd number of RTT samples");
  const sorted = [...rtt].sort((a, b) => a - b);
  const median = sorted[(sorted.length - 1) / 2] ?? 0;
  return Math.min(median / 2, 250);
}

/* ------------------------------------------------------------------ */
/* The set, transcribed by hand from the CSV                            */
/* ------------------------------------------------------------------ */

/**
 * `[time limit in seconds, correct answer 1-based]` for the first twenty
 * questions of the example set, read off the file by eye rather than through
 * the importer, so the importer is checked against this and not the other way
 * round. Every question in the file is 4-answer, 1000 base (no `basePoints`).
 *
 * The blank lines are the round boundaries, and the timers are why they
 * matter: the set opens on History at 15 s, drops to a five-question Speed
 * round at 10 s where the streaks build, and spends 20 s a question through
 * the Deep cuts. A round simulation that flattened all of that to one timer
 * would stop testing the thing the set was reshaped to do.
 */
const SET: readonly (readonly [number, number])[] = [
  [15, 3], // 1  founded in 2012
  [15, 2], // 2  Vagrant
  [15, 1], // 3  Mitchell Hashimoto
  [15, 2], // 4  The Tao of HashiCorp
  [20, 2], // 5  Consul
  [20, 2], // 6  Boundary & Waypoint

  [10, 2], // 7  Go
  [10, 3], // 8  Sentinel
  [10, 3], // 9  a box
  [10, 2], // 10 Raft
  [10, 2], // 11 Big Blue

  [20, 2], // 12 8200
  [20, 3], // 13 Shamir's Secret Sharing
  [20, 2], // 14 a credential generated on demand
  [20, 2], // 15 a task group
  [15, 2], // 16 Vault Radar

  [20, 3], // 17 Business Source License
  [15, 2], // 18 OpenTofu
  [20, 2], // 19 HCP Terraform

  [20, 3], // 20 2025
];

const BASE = 1000;

function loadSet(): readonly Question[] {
  const text = readFileSync(
    new URL("../../../config/event.example/trivia-questions.json", import.meta.url),
    "utf8",
  );
  const result = importTriviaJson(text);
  assert.ok(result.ok, "the launch set must load");
  return result.questions;
}

/* ------------------------------------------------------------------ */
/* Seeded PRNG                                                          */
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

const SEED = 20260919;

/* ------------------------------------------------------------------ */
/* The plan: who taps what, when                                        */
/* ------------------------------------------------------------------ */

type Tap = { readonly choice: number; readonly delayMs: number } | null;

interface Bot {
  readonly pid: ParticipantId;
  readonly nickname: string;
  /** The server's RTT samples for this socket. Empty = never measured. */
  readonly rtt: readonly number[];
  /** Index of the first question this bot is in the room for. */
  readonly joinsBefore: number;
  /** What this bot does on question `qi`, or null to sit it out. */
  readonly play: (qi: number, limitSec: number, correct: number) => Tap;
}

/** The lowest answer index that is not the correct one. */
function wrongOf(correct: number): number {
  return correct === 0 ? 1 : 0;
}

/**
 * How late the close lands after `opensAt`, per question. The timer normally
 * fires a shade after `closesAt` (event-loop lag); on two questions the host
 * presses Close early with taps still arriving, which is the real-world case
 * SPEC describes ("24 of 27 answered").
 */
function closeAtMs(qi: number, limitSec: number): number {
  if (qi === 5 || qi === 12) return 6_000;
  return limitSec * 1000 + 400;
}

const SPECIAL: readonly Bot[] = [
  {
    // Right every time, instantly, from the lobby. The streak cap bot.
    pid: "p001", nickname: "Priya", rtt: [], joinsBefore: 0,
    play: (_qi, _T, correct) => ({ choice: correct, delayMs: 0 }),
  },
  {
    // Right every time at exactly the buzzer. Half points, and refused on
    // the two early-close questions because T > 6 s.
    pid: "p002", nickname: "Kenji", rtt: [], joinsBefore: 0,
    play: (_qi, T, correct) => ({ choice: correct, delayMs: T * 1000 }),
  },
  {
    // Never answers anything.
    pid: "p003", nickname: "Ade", rtt: [], joinsBefore: 0,
    play: () => null,
  },
  {
    // Answers everything, always wrong, fast.
    pid: "p004", nickname: "Sam", rtt: [60, 70, 80], joinsBefore: 0,
    play: (_qi, _T, correct) => ({ choice: wrongOf(correct), delayMs: 1_500 }),
  },
  {
    // Right on odd questions, wrong on even: a streak that never reaches 2.
    pid: "p005", nickname: "Zoë", rtt: [], joinsBefore: 0,
    play: (qi, _T, correct) => ({
      choice: qi % 2 === 0 ? correct : wrongOf(correct),
      delayMs: 5_000,
    }),
  },
  {
    // Right every time, but the tap lands 300 ms after closesAt, before the
    // (late) close event. Clamped to the buzzer: half points, never less.
    pid: "p006", nickname: "Late", rtt: [], joinsBefore: 0,
    play: (_qi, T, correct) => ({ choice: correct, delayMs: T * 1000 + 300 }),
  },
  {
    // Bengaluru on hotel Wi-Fi: a 4 s round trip. The correction is capped
    // at 250 ms, so t = 3005 − 250 = 2755.
    pid: "p007", nickname: "Hotel", rtt: [4_000, 4_100, 3_900], joinsBefore: 0,
    play: (_qi, _T, correct) => ({ choice: correct, delayMs: 3_005 }),
  },
  {
    // Sydney on fibre, same instant of tapping: t = 3005 − 10 = 2995.
    pid: "p008", nickname: "Fibre", rtt: [20, 20, 20], joinsBefore: 0,
    play: (_qi, _T, correct) => ({ choice: correct, delayMs: 3_005 }),
  },
  {
    // A socket the server never got a pong from: zero correction.
    pid: "p009", nickname: "Unmeasured", rtt: [], joinsBefore: 0,
    play: (_qi, _T, correct) => ({ choice: correct, delayMs: 4_005 }),
  },
  {
    // Right for eight, wrong once, right for eleven: the cap, a reset, and
    // the climb back to the cap.
    pid: "p010", nickname: "Streaky", rtt: [100, 100, 100], joinsBefore: 0,
    play: (qi, _T, correct) => ({
      choice: qi === 8 ? wrongOf(correct) : correct,
      delayMs: 2_005,
    }),
  },
  {
    // Right whenever they answer; silent on Q5 and Q15. Silence breaks a
    // streak the same way a miss does.
    pid: "p011", nickname: "Skipper", rtt: [200, 200, 200], joinsBefore: 0,
    play: (qi, _T, correct) =>
      qi === 4 || qi === 14 ? null : { choice: correct, delayMs: 5_005 },
  },
  {
    // Joins during the round, before Q11. Scores only from there.
    pid: "p012", nickname: "Latecomer", rtt: [40, 4_000, 46], joinsBefore: 10,
    play: (_qi, _T, correct) => ({ choice: correct, delayMs: 2_505 }),
  },
];

const ORDINARY_NAMES = [
  "Grace", "Ola", "Yuki", "Tomasz", "Aisha", "Mateo", "Ines", "Ravi", "Hana",
  "Femi", "Lena", "Diego", "Noor", "Kai", "Sofia", "Emeka", "Mira", "Jonas",
];

const RTT_PROFILES: readonly (readonly number[])[] = [
  [],
  [30, 40, 50],
  [180, 200, 220],
  [900, 1_000, 1_100],
  [40, 4_000, 46], // one bufferbloated packet: the median ignores it
];

/**
 * Eighteen bots whose behaviour comes off the PRNG: 12% sit a question out,
 * 23% get it wrong, the rest are right, at a delay anywhere in the window.
 *
 * A delay that would land the corrected `t` on an exact half is re-rolled.
 * The engine is known to round some exact halves the wrong way (see the todo
 * test at the bottom); this round is about everything else, so it steers
 * clear of that one cell and the todo test names it.
 */
function ordinaryBots(): Bot[] {
  const rng = mulberry32(SEED);
  return ORDINARY_NAMES.map((nickname, i) => {
    const pid = `p${String(i + 13).padStart(3, "0")}`;
    const rtt = RTT_PROFILES[i % RTT_PROFILES.length] ?? [];
    // Pre-roll the whole round so `play` is a pure lookup.
    const taps: Tap[] = SET.map(([limitSec, oneBased]) => {
      const correct = oneBased - 1;
      const r = rng();
      if (r < 0.12) return null;
      const choice = r < 0.35 ? wrongOf(correct) : correct;
      const limitMs = limitSec * 1000;
      let delayMs = 0;
      do {
        delayMs = 200 + Math.floor(rng() * (limitMs - 400));
      } while (
        isExactHalf(BASE, Math.max(0, delayMs - specCorrection(rtt)), limitMs)
      );
      return { choice, delayMs };
    });
    return {
      pid,
      nickname,
      rtt,
      joinsBefore: 0,
      play: (qi) => taps[qi] ?? null,
    };
  });
}

const BOTS: readonly Bot[] = [...SPECIAL, ...ordinaryBots()];

/* ------------------------------------------------------------------ */
/* The expectation, from the plan alone                                 */
/* ------------------------------------------------------------------ */

interface ExpectedAnswer {
  readonly choice: number;
  readonly correct: boolean;
  readonly tMs: number;
  readonly points: number;
  readonly bonus: number;
}

interface ExpectedQuestion {
  /** Per bot that got an answer in before the close. */
  readonly answers: ReadonlyMap<ParticipantId, ExpectedAnswer>;
  /** Taps that arrive after the close and must be refused. */
  readonly refused: readonly ParticipantId[];
  /** Streaks after this question; a bot with streak 0 is absent. */
  readonly streaks: ReadonlyMap<ParticipantId, number>;
  /** Running totals after this question; never-scored bots are absent. */
  readonly totals: ReadonlyMap<ParticipantId, number>;
}

function expectRound(): ExpectedQuestion[] {
  const streaks = new Map<ParticipantId, number>();
  const totals = new Map<ParticipantId, number>();
  const out: ExpectedQuestion[] = [];

  SET.forEach(([limitSec, oneBased], qi) => {
    const correct = oneBased - 1;
    const limitMs = limitSec * 1000;
    const closeAt = closeAtMs(qi, limitSec);
    const answers = new Map<ParticipantId, ExpectedAnswer>();
    const refused: ParticipantId[] = [];
    const answered = new Set<ParticipantId>();

    for (const bot of BOTS) {
      if (bot.joinsBefore > qi) continue;
      const tap = bot.play(qi, limitSec, correct);
      if (tap === null) continue;
      if (tap.delayMs >= closeAt) {
        refused.push(bot.pid);
        continue;
      }
      // The engine records the response time already clamped to the limit
      // (types.ts `TriviaAnswer.ms`); the points would be the same either way.
      const tMs = Math.min(limitMs, Math.max(0, tap.delayMs - specCorrection(bot.rtt)));
      const isRight = tap.choice === correct;
      const n = isRight ? (streaks.get(bot.pid) ?? 0) + 1 : 0;
      const points = isRight ? specPoints(BASE, tMs, limitMs) : 0;
      const bonus = isRight ? specBonus(n) : 0;
      answers.set(bot.pid, { choice: tap.choice, correct: isRight, tMs, points, bonus });
      answered.add(bot.pid);
      totals.set(bot.pid, (totals.get(bot.pid) ?? 0) + points + bonus);
      if (n > 0) streaks.set(bot.pid, n);
      else streaks.delete(bot.pid);
    }
    // Anyone who did not get an answer in — silent, refused, or not yet in
    // the room — has no consecutive correct answer to count.
    for (const pid of [...streaks.keys()]) {
      if (!answered.has(pid)) streaks.delete(pid);
    }

    out.push({
      answers,
      refused,
      streaks: new Map(streaks),
      totals: new Map(totals),
    });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Driving the runtime                                                  */
/* ------------------------------------------------------------------ */

const ACTIVITIES: readonly Activity[] = [
  { id: "ttx", title: "Agentic Security TTX", kind: "manual", spotCap: 2 },
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
];

/** A fixed wall clock: 25 Sep 2026 14:00 UTC. The runtime never reads the real one. */
const T0 = Date.UTC(2026, 8, 25, 14, 0, 0);

function fakeClient(pid: ParticipantId, rtt: readonly number[]): Client {
  const socket = { readyState: 1, send() {} } as unknown as Client["socket"];
  return { socket, role: "participant", pid, lastSeen: T0, seq: 0, rtt: [...rtt], pingSentAt: null };
}

interface Played {
  readonly runtime: ReturnType<SessionRegistry["add"]>["runtime"];
  readonly initial: SessionState;
  /** The engine's state after each question's close, before its reveal. */
  readonly closed: readonly SessionState[];
  /** The rejection code every late tap got. */
  readonly refusals: readonly { qi: number; pid: ParticipantId; code: string | undefined }[];
}

function playRound(questions: readonly Question[]): Played {
  const registry = new SessionRegistry();
  const initial = newSession({
    sid: "ses-acceptance",
    title: "Example Team Offsite",
    joinCode: "RAFT",
    activities: ACTIVITIES,
  });
  const { runtime } = registry.add(initial, T0);
  const clients = new Map<ParticipantId, Client>();

  const must = (event: Event, at: number, what: string): void => {
    const out = runtime.apply(event, at);
    assert.ok(out.applied, `${what}: ${out.rejection?.code ?? "not applied"}`);
  };
  const join = (bot: Bot, at: number): void => {
    must({ type: "join", pid: bot.pid, nickname: bot.nickname }, at, `join ${bot.nickname}`);
    const client = fakeClient(bot.pid, bot.rtt);
    clients.set(bot.pid, client);
    runtime.clients.add(client);
  };

  let now = T0;
  must({ type: "open" }, now, "open");
  for (const bot of BOTS) {
    if (bot.joinsBefore === 0) join(bot, (now += 700));
  }
  must({ type: "start" }, (now += 30_000), "start");
  must({ type: "setSegment", segment: "trivia" }, (now += 1_000), "segment");
  must({ type: "loadTrivia", activityId: "trivia", questions }, (now += 1_000), "load");

  const closed: SessionState[] = [];
  const refusals: { qi: number; pid: ParticipantId; code: string | undefined }[] = [];

  SET.forEach(([limitSec, oneBased], qi) => {
    for (const bot of BOTS) {
      if (bot.joinsBefore === qi && qi > 0) join(bot, (now += 500));
    }
    const opensAt = (now += 3_000);
    must({ type: "openQuestion", suddenDeath: false }, opensAt, `open Q${qi + 1}`);
    assert.equal(runtime.state.trivia?.closesAt, opensAt + limitSec * 1000);

    const correct = oneBased - 1;
    const closeAt = closeAtMs(qi, limitSec);
    const taps = BOTS.flatMap((bot) => {
      if (bot.joinsBefore > qi) return [];
      const tap = bot.play(qi, limitSec, correct);
      return tap ? [{ bot, tap }] : [];
    }).sort((a, b) => a.tap.delayMs - b.tap.delayMs || a.bot.pid.localeCompare(b.bot.pid));

    const before = taps.filter((t) => t.tap.delayMs < closeAt);
    const after = taps.filter((t) => t.tap.delayMs >= closeAt);

    for (const { bot, tap } of before) {
      const client = clients.get(bot.pid);
      assert.ok(client, `${bot.nickname} has a socket`);
      const out = runtime.answer(client, qi, tap.choice, opensAt + tap.delayMs);
      assert.ok(out.applied, `Q${qi + 1} ${bot.nickname}: ${out.rejection?.code ?? "not applied"}`);
    }
    must({ type: "closeQuestion" }, opensAt + closeAt, `close Q${qi + 1}`);
    for (const { bot, tap } of after) {
      const client = clients.get(bot.pid);
      assert.ok(client);
      const out = runtime.answer(client, qi, tap.choice, opensAt + tap.delayMs);
      assert.equal(out.applied, false, `Q${qi + 1} ${bot.nickname} tapped after the close and was accepted`);
      refusals.push({ qi, pid: bot.pid, code: out.rejection?.code });
    }
    closed.push(runtime.state);

    now = opensAt + closeAt;
    must({ type: "revealQuestion" }, (now += 2_000), `reveal Q${qi + 1}`);
    if (qi + 1 < SET.length) must({ type: "nextQuestion" }, (now += 4_000), `next after Q${qi + 1}`);
  });

  return { runtime, initial, closed, refusals };
}

/* ------------------------------------------------------------------ */
/* Hand-computed anchors                                                */
/* ------------------------------------------------------------------ */

/**
 * Priya: right and instant on all 20, so 1000 a question. Streak 1..20;
 * bonus 0, 100, 200, 300, 400, then 500 for the remaining fifteen.
 *   20 × 1000 = 20 000
 *   0 + 100 + 200 + 300 + 400 + 15 × 500 = 1 000 + 7 500 = 8 500
 */
const PRIYA = 28_500;

/**
 * Kenji: right at the buzzer, 500 a question — except Q6 and Q13, where the
 * host closes at 6 s and his tap at the buzzer is refused, which also breaks
 * the streak. Both of those questions run 20 s, so the early close still
 * lands well before him. Late lands in exactly the same place (tap after
 * closesAt, clamped to the buzzer; refused on the same two questions).
 *   Q1–5:   5 × 500 + (0 + 100 + 200 + 300 + 400)             = 3 500
 *   Q7–12:  6 × 500 + (0 + 100 + 200 + 300 + 400 + 500)       = 4 500
 *   Q14–20: 7 × 500 + (0 + 100 + 200 + 300 + 400 + 500 + 500) = 5 500
 */
const KENJI = 13_500;

/**
 * Zoë: right on the odd questions only, always at 5 s, never a streak of 2.
 *
 * Her total is the one anchor here that moves when the set's timers move, and
 * it moves downwards: the same five-second tap is worth less on a short
 * question, because the speed weighting is a fraction of the time limit.
 *   T = 20 s: 1000 × (1 − (5 ÷ 20) ÷ 2) = 875     — Q5, Q13, Q15, Q17, Q19
 *   T = 15 s: 1000 × (1 − (5 ÷ 15) ÷ 2) = 833.33  — Q1, Q3 → 833
 *   T = 10 s: 1000 × (1 − (5 ÷ 10) ÷ 2) = 750     — Q7, Q9, Q11
 *   5 × 875 + 2 × 833 + 3 × 750 = 4 375 + 1 666 + 2 250
 */
const ZOE = 8_291;

/* ------------------------------------------------------------------ */
/* The round                                                            */
/* ------------------------------------------------------------------ */

describe("thirty bots play the launch set", () => {
  const questions = loadSet();
  const expected = expectRound();
  const played = playRound(questions);
  const finalState = played.closed[SET.length - 1];
  assert.ok(finalState);
  // After the last reveal. Points settle at the close but only reach `scores`
  // at the reveal — deliberately, so a phone's points strip cannot move while
  // the answer is still private — so anything asserting on `scores` or on
  // standings has to read the revealed state, not the closed one.
  const revealedState = played.runtime.state;

  test("the importer read the file the way a person reads it", () => {
    // `SET` is a hand transcription of the questions this round plays, and
    // that is the whole of its value: it is an independent reading of the
    // file rather than a copy of whatever the importer produced. The file is
    // allowed to grow past it — questions get added — so this pins the ones
    // it transcribed and plays those, rather than pinning the file's length
    // and having every new question break a round simulation that never
    // claimed to cover it.
    assert.ok(
      questions.length >= SET.length,
      `the example set has ${questions.length} questions; this fixture needs at least ${SET.length}`,
    );
    questions.slice(0, SET.length).forEach((q, i) => {
      const [limitSec, oneBased] = SET[i] ?? [0, 0];
      assert.equal(q.timeLimitSec, limitSec, `Q${i + 1} time limit`);
      assert.deepEqual(q.correct, [oneBased - 1], `Q${i + 1} correct answer`);
      assert.equal(q.answers.length, 4, `Q${i + 1} has four answers`);
      assert.equal(q.basePoints, BASE, `Q${i + 1} base points`);
    });
  });

  test("the plan is what it says it is", () => {
    assert.equal(BOTS.length, 30);
    assert.equal(new Set(BOTS.map((b) => b.pid)).size, 30);
    // At least one bot never answers, at least one streak reaches the cap,
    // wrong answers and no-answers both occur among the ordinary bots.
    const last = expected[SET.length - 1];
    assert.ok(last);
    assert.equal(last.totals.has("p003"), false, "Ade never scored");
    assert.ok((last.streaks.get("p001") ?? 0) >= 6, "Priya's streak passed the cap");
    const ordinary = BOTS.slice(SPECIAL.length);
    const outcomes = { silent: 0, wrong: 0, right: 0, late: 0 };
    ordinary.forEach((bot) => {
      SET.forEach(([limitSec, oneBased], qi) => {
        const tap = bot.play(qi, limitSec, oneBased - 1);
        if (tap === null) outcomes.silent += 1;
        else if (tap.delayMs >= closeAtMs(qi, limitSec)) outcomes.late += 1;
        else if (tap.choice === oneBased - 1) outcomes.right += 1;
        else outcomes.wrong += 1;
      });
    });
    assert.ok(outcomes.silent > 10 && outcomes.wrong > 30 && outcomes.right > 180, JSON.stringify(outcomes));
    assert.ok(outcomes.late > 0, "some ordinary bot tapped after an early close");
  });

  test("every question: each answer's points and streak bonus", () => {
    SET.forEach((_, qi) => {
      const want = expected[qi];
      const got = played.closed[qi]?.trivia;
      assert.ok(want && got, `Q${qi + 1} state`);
      assert.equal(got.phase, "closed");
      assert.deepEqual(
        Object.keys(got.answers).sort(),
        [...want.answers.keys()].sort(),
        `Q${qi + 1}: who has an answer on record`,
      );
      for (const [pid, w] of want.answers) {
        const g: TriviaAnswer | undefined = got.answers[pid];
        assert.ok(g, `Q${qi + 1} ${pid}`);
        assert.equal(g.choice, w.choice, `Q${qi + 1} ${pid} choice`);
        assert.equal(g.correct, w.correct, `Q${qi + 1} ${pid} correct`);
        assert.equal(g.ms, w.tMs, `Q${qi + 1} ${pid} corrected response time`);
        assert.equal(g.points, w.points, `Q${qi + 1} ${pid} points (t=${w.tMs})`);
        assert.equal(g.streakBonus, w.bonus, `Q${qi + 1} ${pid} streak bonus`);
      }
    });
  });

  test("every question: the streaks", () => {
    SET.forEach((_, qi) => {
      const want = expected[qi];
      const got = played.closed[qi]?.trivia;
      assert.ok(want && got);
      assert.deepEqual(
        got.streaks,
        Object.fromEntries(want.streaks),
        `Q${qi + 1} streaks`,
      );
    });
  });

  test("every question: the running totals", () => {
    SET.forEach((_, qi) => {
      const want = expected[qi];
      const got = played.closed[qi]?.trivia;
      assert.ok(want && got);
      assert.deepEqual(got.totals, Object.fromEntries(want.totals), `Q${qi + 1} totals`);
    });
  });

  test("a tap after the close is refused as question_not_open", () => {
    const want = expected.flatMap((q, qi) => q.refused.map((pid) => `${qi}:${pid}`)).sort();
    const got = played.refusals.map((r) => `${r.qi}:${r.pid}`).sort();
    assert.deepEqual(got, want);
    assert.ok(got.length >= 4, "Kenji and Late are refused on both early closes");
    for (const r of played.refusals) assert.equal(r.code, "question_not_open");
  });

  test("the hand-computed totals", () => {
    const totals = finalState.trivia?.totals ?? {};
    assert.equal(totals["p001"], PRIYA, "Priya");
    assert.equal(totals["p002"], KENJI, "Kenji");
    assert.equal(totals["p006"], KENJI, "Late, clamped to the buzzer, matches Kenji");
    assert.equal(totals["p005"], ZOE, "Zoë");
    assert.equal(totals["p004"], 0, "Sam answered everything wrong and is on the board at 0");
    assert.equal(totals["p003"], undefined, "Ade never answered and has no total");
    // And the oracle agrees with the hand arithmetic, so the two are not
    // just agreeing with each other.
    const last = expected[SET.length - 1];
    assert.equal(last?.totals.get("p001"), PRIYA);
    assert.equal(last?.totals.get("p002"), KENJI);
    assert.equal(last?.totals.get("p005"), ZOE);
  });

  test("the streak bonus stops at 500", () => {
    const priya = played.closed.map((s) => s.trivia?.answers["p001"]?.streakBonus);
    assert.deepEqual(priya.slice(0, 6), [0, 100, 200, 300, 400, 500]);
    assert.ok(priya.slice(5).every((b) => b === 500), "sixth and later: 500, flat");
    // Streaky: cap, one miss, climb back.
    const streaky = played.closed.map((s) => s.trivia?.answers["p010"]?.streakBonus);
    assert.deepEqual(streaky, [
      0, 100, 200, 300, 400, 500, 500, 500,
      0,
      0, 100, 200, 300, 400, 500, 500, 500, 500, 500, 500,
    ]);
    // Skipper: silence on Q5 and Q15 resets the count without a wrong tap.
    const skipper = played.closed.map((s) => s.trivia?.answers["p011"]?.streakBonus);
    assert.deepEqual(skipper, [
      0, 100, 200, 300, undefined,
      0, 100, 200, 300, 400, 500, 500, 500, 500, undefined,
      0, 100, 200, 300, 400,
    ]);
  });

  test("the latency correction is capped and absent when unmeasured", () => {
    // Hotel and Fibre tap at the same instant on every question.
    for (const s of played.closed) {
      const hotel = s.trivia?.answers["p007"];
      const fibre = s.trivia?.answers["p008"];
      const unmeasured = s.trivia?.answers["p009"];
      assert.ok(hotel && fibre && unmeasured);
      assert.equal(hotel.ms, 3_005 - 250, "4 s round trip gives back exactly the cap");
      assert.equal(fibre.ms, 3_005 - 10, "20 ms round trip gives back 10");
      assert.equal(unmeasured.ms, 4_005, "no pong ever: nothing given back");
      assert.ok(hotel.points >= fibre.points, "the worse link is never behind for the same tap");
      assert.ok(hotel.points - fibre.points <= 13, "…and never ahead by more than 250 ms is worth");
    }
    // The bufferbloated socket: median 46 of [40, 4000, 46], not the mean.
    const late = finalState.trivia?.answers["p012"];
    assert.ok(late);
    assert.equal(late.ms, 2_505 - 23);
  });

  test("the late joiner scores from their first question only", () => {
    for (let qi = 0; qi < 10; qi += 1) {
      assert.equal(played.closed[qi]?.trivia?.answers["p012"], undefined, `Q${qi + 1}`);
    }
    for (let qi = 10; qi < 20; qi += 1) {
      assert.ok(played.closed[qi]?.trivia?.answers["p012"], `Q${qi + 1}`);
    }
    const want = expected[SET.length - 1]?.totals.get("p012");
    assert.equal(finalState.trivia?.totals["p012"], want);
  });

  test("the raw scores and normalisation the scoreboard sees", () => {
    const scores = revealedState.scores["trivia"] ?? {};
    const last = expected[SET.length - 1];
    assert.ok(last);
    for (const [pid, raw] of last.totals) {
      assert.deepEqual(scores[pid], { raw, status: "played" }, pid);
    }
    assert.equal(scores["p003"], undefined, "Ade has no trivia cell: the host decides");
    // SCORING.md: top raw is 100, everyone else round(100 × raw ÷ top).
    const top = Math.max(...last.totals.values());
    assert.equal(top, PRIYA);
    const standings = computeStandings(revealedState);
    for (const [pid, raw] of last.totals) {
      const row = standings.find((s) => s.pid === pid);
      assert.equal(row?.perActivity["trivia"]?.points, Math.round((100 * raw) / top), pid);
    }
    assert.equal(standings.find((s) => s.pid === "p002")?.perActivity["trivia"]?.points, 47); // 13500/28500
  });

  test("the podium is the top five by total, ties by name", () => {
    const revealed = replay(finalState, [{ event: { type: "revealQuestion" }, at: T0 }]);
    assert.ok(revealed.trivia);
    const podium = triviaPodium(revealed, revealed.trivia);
    const last = expected[SET.length - 1];
    assert.ok(last);
    const nameOf = (pid: string) => BOTS.find((b) => b.pid === pid)?.nickname ?? pid;
    const want = [...last.totals.entries()]
      .sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0])))
      .slice(0, 5)
      .map(([pid, points]) => ({ nickname: nameOf(pid), points }));
    assert.deepEqual(podium.map((r) => ({ nickname: r.nickname, points: r.points })), want);
    assert.equal(podium[0]?.nickname, "Priya");
    assert.equal(podium.length, 5);
  });

  test("the whole round replays from its event log to the same state", () => {
    const again = replay(
      played.initial,
      played.runtime.log.map((r) => ({ event: r.event, at: r.at })),
    );
    assert.deepEqual(again, played.runtime.state);
  });
});

/* ------------------------------------------------------------------ */
/* Known discrepancies, left visible                                    */
/* ------------------------------------------------------------------ */

describe("known discrepancies against SPEC", () => {
  const Q: Question = {
    text: "q", answers: ["a", "b", "c", "d"], timeLimitSec: 10, correct: [1],
    note: null, round: null, basePoints: 1000,
  };
  const base = newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES });
  const lobby: readonly Event[] = [
    { type: "open" },
    { type: "join", pid: "p1", nickname: "Priya" },
    { type: "join", pid: "p2", nickname: "Kenji" },
    { type: "start" },
    { type: "setSegment", segment: "trivia" },
  ];

  test(
    "an exact half rounds up, as SPEC's round does",
    () => {
      // 1000 × (1 − (2570 ÷ 10000) ÷ 2) = 1000 × 0.8715 = 871.5 → 872.
      assert.equal(specPoints(1000, 2_570, 10_000), 872);
      assert.ok(isExactHalf(1000, 2_570, 10_000));
      const events: Event[] = [
        ...lobby,
        { type: "loadTrivia", activityId: "trivia", questions: [Q] },
        { type: "openQuestion", suddenDeath: false },
        { type: "answerQuestion", pid: "p1", choice: 1, ms: 2_570 },
        { type: "closeQuestion" },
      ];
      const s = replay(base, events.map((event) => ({ event, at: T0 })));
      assert.equal(s.trivia?.answers["p1"]?.points, 872);
    },
  );

  test(
    "a participant's own points do not move between the close and the reveal",
    () => {
      const events: Event[] = [
        ...lobby,
        { type: "setScore", activityId: "ttx", pid: "p1", raw: 30 },
        { type: "setScore", activityId: "ttx", pid: "p2", raw: 40 },
        { type: "loadTrivia", activityId: "trivia", questions: [Q] },
        { type: "openQuestion", suddenDeath: false },
        { type: "answerQuestion", pid: "p1", choice: 1, ms: 2_000 },
        { type: "answerQuestion", pid: "p2", choice: 0, ms: 2_000 },
      ];
      const open = replay(base, events.map((event) => ({ event, at: T0 })));
      const closed = replay(open, [{ event: { type: "closeQuestion" }, at: T0 + 10_400 }]);
      const view = (s: SessionState, pid: string) =>
        renderStateFor(s, { role: "participant", pid, lastSeen: new Map(), now: T0 });
      for (const pid of ["p1", "p2"]) {
        assert.deepEqual(view(closed, pid).own, view(open, pid).own, `${pid}'s own points moved at close`);
        assert.deepEqual(view(closed, pid).standings, view(open, pid).standings, "the public top five moved at close");
      }
    },
  );
});
