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
  QuestionPhase,
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
    // Auto acts from `closed` and `revealed` and from nowhere else, so an idle
    // question has no beat to count. Cleared rather than left stale: a stamp
    // from the question before it is a deadline in the past, and a timer armed
    // off one fires the instant it is armed.
    autoAt: null,
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

/* ---- auto-advance ---------------------------------------------------- */

/**
 * The beat, in seconds: the pause between a question closing and its answer
 * going up.
 *
 * Five rather than the send-off's four. A photograph is glanced at and done;
 * this beat is the moment the host says "let's see", and under about three
 * seconds it reads as the console having jumped rather than as a pause. Over
 * about eight it is dead air. Five is the middle of that, and — the reason
 * that matters more than the pacing — it is long enough that a host who
 * pressed Auto by mistake sees the console counting and presses Manual before
 * anything has happened in front of the room.
 */
export const DEFAULT_BEAT_SECONDS = 5;
export const MIN_BEAT_SECONDS = 3;
export const MAX_BEAT_SECONDS = 15;

/**
 * How long the reveal holds, per character of its note, at the default beat.
 *
 * The send-off reads a farewell message out at 60 ms a character. A trivia
 * note is scanned off a screen while the host talks over it and while the
 * room is also looking at four bars and a top five, so it is quicker: 45 ms a
 * character is roughly 265 words a minute. The real set's notes run 75 to 190
 * characters, which is 3.4 to 8.6 seconds on top of the fixed part.
 */
const REVEAL_MS_PER_CHAR = 45;

/** What auto would do next, or nothing. */
export type TriviaBeat =
  /** Close → reveal. The answer goes up. */
  | "reveal"
  /** Reveal → the next question, open. Two engine events; see the note. */
  | "advance";

/**
 * The parts of a trivia state this decision looks at, and nothing else.
 *
 * Plain fields rather than {@link TriviaState} so the console can ask the same
 * question of the view it was sent. There is one rule about when the room
 * moves on its own and it is worth exactly one implementation — a console that
 * drew "advancing in 5s" from a second, similar-looking rule would be a
 * console that says one thing while the server does another.
 */
export interface TriviaAutoAt {
  readonly auto: boolean;
  readonly suddenDeath: boolean;
  readonly phase: QuestionPhase;
  /** Index of the scored question in play. */
  readonly at: number;
  /** How many scored questions there are. */
  readonly of: number;
}

/**
 * What auto does next, or null for "nothing; the host presses".
 *
 * This is the whole safety argument for the feature, so it is one pure
 * function and every clause in it is a refusal:
 *
 * - **Off unless the host turned it on.** `loadTrivia` sets `auto: false` and
 *   nothing else does.
 * - **Never a sudden death.** A tiebreak is a decision hanging over a room
 *   with a result on it; the host settles it and announces it, on their own
 *   clock. Opening one also switches Auto *off* in the reducer, so the button
 *   says what is true — this clause is the second lock, for a state that
 *   arrives by replay or recovery rather than through `openQuestion`.
 * - **Never opens a question from cold.** There is no beat out of `idle`, so
 *   flipping Auto on at question one does nothing at all: the first question
 *   goes up on a press, and so does any question the host has walked back to
 *   by hand. The earliest thing Auto can do is one full beat after the next
 *   close, and every beat it performs is one the host was going to press
 *   anyway. That is what makes it safe to have on a console in front of
 *   thirty people.
 * - **Never off the end.** `advance` is offered only while there is a next
 *   question, so the last reveal in the set stays on the screen and the host
 *   walks out of trivia themselves.
 * - **Never while a question is open.** That beat already has a clock — the
 *   question's own — and it belongs to `armQuestionTimer`.
 *
 * `advance` is two engine events, `nextQuestion` then `openQuestion`, because
 * a set that runs itself has to put the next question *up*; stopping on an
 * idle question would be a mode that pauses every other beat. The console's
 * Skip does the same thing with two `sendoff.next` frames: the composite step
 * is two of the steps that already exist, not a third kind of step the engine
 * has to learn.
 */
export function autoBeat(t: TriviaAutoAt): TriviaBeat | null {
  if (!t.auto) return null;
  if (t.suddenDeath) return null;
  if (t.phase === "closed") return "reveal";
  if (t.phase === "revealed") return t.at + 1 < t.of ? "advance" : null;
  return null;
}

/**
 * The slider's value, made safe.
 *
 * Rounded and clamped, and a value that is not a number at all comes back as
 * the default rather than as NaN — which matters beyond a malformed frame,
 * because a snapshot written before Auto existed has no `autoSeconds` on it
 * and `undefined * 1000` is a timer armed for never.
 */
export function clampBeatSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_BEAT_SECONDS;
  return Math.min(MAX_BEAT_SECONDS, Math.max(MIN_BEAT_SECONDS, Math.round(seconds)));
}

/**
 * How long one beat holds, in milliseconds.
 *
 * **One slider, two waits, and they are not the same number.** The pause
 * before the answer is a pause for effect and is exactly what the host set.
 * The wait after it is the room reading — the correct tile, the distribution,
 * the note, then the activity's top five — and it is derived, the same way the
 * send-off derives a message slide's hold from the message rather than asking
 * for a second slider. A second slider would be two numbers to get wrong in
 * front of a room, and the number a host actually has an opinion about is the
 * short one.
 *
 * `beat × 2` is the fixed part of a reveal, which every question has whether
 * or not it carries a note; the note adds its own reading time on top. Capped
 * at six beats so one pathological note cannot hold the room for a minute, and
 * the whole thing scales with the slider, so "faster" is faster everywhere.
 */
export function autoBeatMs(
  beat: TriviaBeat,
  autoSeconds: number,
  noteChars: number,
): number {
  const seconds = clampBeatSeconds(autoSeconds);
  const base = seconds * 1000;
  if (beat === "reveal") return base;
  const scale = seconds / DEFAULT_BEAT_SECONDS;
  const chars = Number.isFinite(noteChars) ? Math.max(0, noteChars) : 0;
  return Math.min(base * 6, base * 2 + chars * REVEAL_MS_PER_CHAR * scale);
}

/**
 * When the current beat fires, as an absolute server epoch, or null when
 * nothing is pending.
 *
 * Absolute and not a duration, for the discipline `closesAt` keeps: a console
 * that receives the frame late still counts down to the instant the server
 * means, and a process that restarts re-arms for the moment it always meant.
 */
export function autoFiresAt(t: TriviaState): number | null {
  const beat = autoBeat({ ...t, of: t.questions.length });
  if (beat === null || t.autoAt === null) return null;
  const question = currentQuestion(t);
  return t.autoAt + autoBeatMs(beat, t.autoSeconds, question?.note?.length ?? 0);
}
