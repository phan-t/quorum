/**
 * Trivia arithmetic and question settlement. See SPEC.md "Trivia".
 *
 * Split out of scoring.ts on purpose: scoring.ts implements SCORING.md — the
 * one normalisation rule that turns a raw score into points out of 100 — and
 * this file implements the *other* scoring, the per-question one that produces
 * the raw score trivia hands to it. Mixing them in one file would blur the
 * line SCORING.md draws between "what an activity produced" and "what that is
 * worth in the session".
 *
 * Every function here is pure, and none of them reads a clock.
 */

import type {
  ParticipantId,
  Question,
  TriviaAnswer,
  TriviaState,
} from "./types.ts";

/** SPEC.md's default when the CSV leaves `Points` blank. */
export const DEFAULT_BASE_POINTS = 1000;

/**
 * The question in play: the tiebreaker during a sudden death, the scored
 * question otherwise.
 *
 * Every read of "the current question" goes through here. Sudden death used to
 * be a *mode* applied to `questions[at]`, and that had three consequences, all
 * of them wrong: it spent a scored question to settle a tie, a tie settled
 * mid-set silently removed a question from the game, and once the set was
 * exhausted a tiebreak could not be run at all — `nextQuestion` refuses past
 * the last question, so there was nothing left to put the mode on, which is
 * precisely when a tie needs settling.
 *
 * Returning `undefined` rather than throwing keeps the callers' shape: an
 * empty pool is refused at `openQuestion`, which is the only place that can
 * say anything useful about it.
 */
export function currentQuestion(t: TriviaState): Question | undefined {
  return t.suddenDeath ? t.tiebreakers[t.tiebreakAt] : t.questions[t.at];
}

/**
 * Split a loaded file into the scored set and the sudden-death pool.
 *
 * Three sources, in order:
 *
 * 1. Questions flagged {@link Question.tiebreak} in the file. This is the
 *    design SCORING.md wants — the tiebreaker travels with the set it is meant
 *    to settle, written by the same person and verified in the same pass — and
 *    it needs one column in the CSV importer, which is the follow-up this
 *    change does not reach.
 * 2. An explicit pool on the event, for a host who keeps tiebreakers in a
 *    second file.
 * 3. The built-in pool, so that "never a coin flip" is true for the files that
 *    exist today, none of which carry a flag.
 *
 * The flagged questions come out of `questions` entirely. That is the whole
 * point: a question that scores nothing must not be left sitting in the twenty
 * that do, where a host working down the list would open it for points.
 */
export function partitionTiebreakers(
  questions: readonly Question[],
  explicit: readonly Question[] | undefined,
  fallback: readonly Question[],
): { scored: readonly Question[]; tiebreakers: readonly Question[] } {
  const scored = questions.filter((q) => q.tiebreak !== true);
  const flagged = questions.filter((q) => q.tiebreak === true);
  const pool = [...flagged, ...(explicit ?? [])];
  return { scored, tiebreakers: pool.length > 0 ? pool : fallback };
}

/** The streak bonus stops growing at the sixth consecutive correct answer. */
export const MAX_STREAK_BONUS_STEPS = 5;

/** One step of the streak bonus, in points. */
export const STREAK_BONUS_STEP = 100;

/**
 * Speed-weighted points for a correct answer:
 * `round(base × (1 − (t ÷ T) ÷ 2))`.
 *
 * At `t = 0` that is the full base; at the buzzer it is exactly half, never
 * less. `ms` is already latency-corrected by the socket boundary (see
 * ARCHITECTURE.md "Clocks and fairness"); it is clamped here anyway, because
 * a response time above the limit is arithmetically possible — the timer and
 * the close event race — and an unclamped one would score *below* half.
 *
 * `base` of 0 is a warm-up: it scores nothing, by construction.
 */
export function questionPoints(
  basePoints: number,
  ms: number,
  timeLimitSec: number,
): number {
  const limitMs = timeLimitSec * 1000;
  // A non-positive limit would divide by zero. No CSV can produce one (the
  // importer enforces 5–120) but the engine does not get to assume that.
  if (limitMs <= 0) return Math.round(basePoints);
  const t = clampMs(ms, limitMs);
  // One division, not three.
  //
  // The obvious transcription of the formula — `base * (1 - t / limitMs / 2)`
  // — divides twice and subtracts, and each step carries its own binary
  // rounding error. Values that land on an exact half arrive as .4999… and
  // `Math.round` takes them *down*, one point short. It is not hypothetical:
  // for the real launch set there are 123 response times where it happens.
  // Rearranged to `(base × (2T − t)) ÷ 2T` there is a single correctly-rounded
  // division, and every numerator here is a safe integer.
  return Math.round((basePoints * (2 * limitMs - t)) / (2 * limitMs));
}

/**
 * The bonus for the n-th consecutive correct answer: `100 × min(n − 1, 5)`.
 *
 * So the first correct answer in a run earns nothing extra and the sixth and
 * everything after it earn 500. `n` is the streak *including* this answer.
 */
export function streakBonus(n: number): number {
  if (n <= 1) return 0;
  return STREAK_BONUS_STEP * Math.min(n - 1, MAX_STREAK_BONUS_STEPS);
}

/**
 * Clamp a response time into `[0, limit]`.
 *
 * `ms` arrives trusted but not sanitised: it is a number that came off a
 * socket, and NaN would propagate silently through the multiplication into a
 * NaN total, which poisons every standings comparison downstream. A response
 * time that is not a number is treated as instant, which is the reading most
 * favourable to the participant — they answered, the clock arithmetic failed.
 */
export function clampMs(ms: number, limitMs: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(ms, limitMs);
}

export interface Settlement {
  readonly answers: Readonly<Record<ParticipantId, TriviaAnswer>>;
  readonly totals: Readonly<Record<ParticipantId, number>>;
  readonly streaks: Readonly<Record<ParticipantId, number>>;
}

/**
 * Price the current question: fill in every answer's points and streak bonus,
 * add them to the running totals, and advance or reset each streak.
 *
 * **Why this happens at close and not at answer time.** The points are
 * derivable from the answer the instant it lands — but a total that ticks up
 * the moment a phone taps tells that phone it was right, and SPEC.md is
 * explicit that a participant learns nothing until the reveal ("a phone that
 * turns green is visible to the person next to you"). Computing at close means
 * the participant's *own* state carries no correctness signal while the
 * question is open, so the projection layer has nothing to leak even by
 * accident. Correctness for the host — which ARCHITECTURE.md does allow before
 * the reveal — is on `TriviaAnswer.correct`, which is host-only to project.
 *
 * Sudden death settles to nothing: SPEC.md says "no points change".
 *
 * A warm-up (`basePoints: 0`) pays nothing *including the streak bonus* — the
 * whole point of a warm-up is that it does not move the scoreboard — but a
 * correct answer on one still advances the streak, because the streak counts
 * consecutive correct answers and a warm-up is a question you got right.
 */
export function settleQuestion(trivia: TriviaState): Settlement {
  const question = trivia.questions[trivia.at];
  if (!question || trivia.suddenDeath) {
    return {
      answers: trivia.answers,
      totals: trivia.totals,
      streaks: trivia.streaks,
    };
  }

  const answers: Record<ParticipantId, TriviaAnswer> = {};
  const totals: Record<ParticipantId, number> = { ...trivia.totals };
  const streaks: Record<ParticipantId, number> = {};

  // Everyone who had a streak keeps it only by answering correctly below; a
  // miss and a no-answer are the same thing to a streak. Absence is zero, so
  // a broken streak is dropped rather than stored as 0.
  for (const [pid, answer] of Object.entries(trivia.answers)) {
    const n = answer.correct ? (trivia.streaks[pid] ?? 0) + 1 : 0;
    if (n > 0) streaks[pid] = n;

    const points = answer.correct
      ? questionPoints(question.basePoints, answer.ms, question.timeLimitSec)
      : 0;
    const bonus =
      answer.correct && question.basePoints > 0 ? streakBonus(n) : 0;

    answers[pid] = { ...answer, points, streakBonus: bonus };
    // Answering at all puts you on the board, even at zero: a raw of 0 is
    // "played and scored nothing", which is a different statement from the
    // absent cell that lets a host mark someone benched.
    totals[pid] = (totals[pid] ?? 0) + points + bonus;
  }

  return { answers, totals, streaks };
}

/**
 * Whether a choice is one of this question's correct answers.
 *
 * Multi-answer is Kahoot semantics: `Correct answer(s)` may list several and
 * any one of them is right, not all of them together.
 */
export function isCorrect(question: Question, choice: number): boolean {
  return question.correct.includes(choice);
}

/** The state a freshly loaded, never-opened question set is in. */
export function idleQuestion(
  trivia: TriviaState,
  at: number,
): TriviaState {
  return {
    ...trivia,
    at,
    phase: "idle",
    opensAt: null,
    closesAt: null,
    suddenDeath: false,
    suddenDeathWinner: null,
    answers: {},
  };
}

/**
 * Has this set been played at all?
 *
 * Used to decide whether a second `loadTrivia` replaces the set or is refused.
 * Derived rather than stored: any of these three being true means a question
 * has been opened, and a stored flag would be one more thing a snapshot could
 * disagree with the rest of the state about.
 */
export function triviaHasBegun(t: TriviaState): boolean {
  return (
    t.at > 0 || t.phase !== "idle" || Object.keys(t.totals).length > 0
  );
}
