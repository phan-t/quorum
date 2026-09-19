/**
 * Core domain types.
 *
 * The engine is a pure reducer: `reduce(state, event, now) -> {state, effects}`.
 * Nothing in this file performs I/O, reads a clock, or generates randomness.
 * Anything non-deterministic arrives on the event.
 */

export type ParticipantId = string;
export type ActivityId = string;

/** Session-level lifecycle. See SPEC.md "Session lifecycle". */
export type SessionPhase = "draft" | "lobby" | "running" | "closed";

/** What the participant page renders. Segments are not a fixed sequence. */
export type Segment =
  | "lobby"
  | "holding"
  | "trivia"
  | "arcade"
  | "standings"
  | "final";

/** Whether cumulative standings are visible. See SPEC.md "Seal and reveal". */
export type Seal = "live" | "sealed" | "revealed";

/** Per participant, per activity. */
export type ScoreStatus = "played" | "bench" | "unset";

export type ActivityKind = "trivia" | "arcade" | "manual";

export interface Activity {
  readonly id: ActivityId;
  readonly title: string;
  readonly kind: ActivityKind;
  /** Spot Awards the facilitator of this activity may grant. Default 2. */
  readonly spotCap: number;
}

export interface Participant {
  readonly pid: ParticipantId;
  readonly nickname: string;
  /** Case- and punctuation-folded nickname, for collision detection. */
  readonly nicknameKey: string;
  /** Assigned on join, in join order, from 1. Used by the arcade. */
  readonly playerNumber: number;
  readonly joinedAt: number;
  readonly connected: boolean;
  readonly kicked: boolean;
}

export interface RawScore {
  /** Whatever the activity produced. Never compared across activities. */
  readonly raw: number;
  readonly status: ScoreStatus;
}

export interface SpotAward {
  readonly seq: number;
  readonly pid: ParticipantId;
  readonly activityId: ActivityId;
  /** Mandatory. A field that may be blank will be blank. */
  readonly reason: string;
  readonly at: number;
}

export interface HoldingCard {
  readonly title: string;
  readonly line: string;
}

/* ------------------------------------------------------------------ */
/* Trivia                                                              */
/* ------------------------------------------------------------------ */

/**
 * One loaded question. Immutable for the life of the session: SPEC says a
 * loaded set is re-uploaded rather than edited, so nothing here changes once
 * `loadTrivia` is accepted.
 *
 * `correct` is 0-based here while the CSV is 1-based. The conversion happens
 * once, in the importer, because an off-by-one that survives into the engine
 * is an off-by-one nobody sees until a question is revealed to thirty people.
 */
export interface Question {
  readonly text: string;
  /** Two to four. Blank CSV columns mean a two- or three-answer question. */
  readonly answers: readonly string[];
  readonly timeLimitSec: number;
  /** 0-based. More than one means any of them is correct (Kahoot semantics). */
  readonly correct: readonly number[];
  /** Shown on the reveal. This is the bit people learn from. */
  readonly note: string | null;
  /** Consecutive questions sharing a value get a round card between them. */
  readonly round: string | null;
  /** Base points. 0 makes a question a warm-up that scores nothing. */
  readonly basePoints: number;
}

/**
 * Where the current question is.
 *
 * `closed` exists separately from `revealed` because the host closes the
 * question — or the timer does — and then chooses when to show the answer.
 * Collapsing the two would reveal the answer the instant the last person
 * taps, which removes the pause the reveal is for.
 */
export type QuestionPhase = "idle" | "open" | "closed" | "revealed";

export interface TriviaAnswer {
  readonly choice: number;
  readonly correct: boolean;
  /**
   * Response time in ms, server-measured and latency-corrected before it
   * reaches the engine. The engine never sees a client timestamp: see
   * ARCHITECTURE.md "Clocks and fairness".
   */
  readonly ms: number;
  readonly points: number;
  readonly streakBonus: number;
}

export interface TriviaState {
  readonly activityId: ActivityId;
  readonly questions: readonly Question[];
  /** Index into `questions`. */
  readonly at: number;
  readonly phase: QuestionPhase;
  /** Absolute server epochs, never durations. Null unless `phase` is open. */
  readonly opensAt: number | null;
  readonly closesAt: number | null;
  /** Sudden death: no timer, first correct answer wins, no points change. */
  readonly suddenDeath: boolean;
  readonly suddenDeathWinner: ParticipantId | null;
  /** Answers to the *current* question only. Cleared by `nextQuestion`. */
  readonly answers: Readonly<Record<ParticipantId, TriviaAnswer>>;
  /** Cumulative across the set. This is the raw score the scoreboard reads. */
  readonly totals: Readonly<Record<ParticipantId, number>>;
  /** Consecutive correct answers, for the streak bonus. Reset by a miss. */
  readonly streaks: Readonly<Record<ParticipantId, number>>;
}

export interface SessionState {
  readonly sid: string;
  readonly title: string;
  readonly joinCode: string;
  readonly phase: SessionPhase;
  readonly segment: Segment;
  readonly seal: Seal;
  readonly activities: readonly Activity[];
  /** Activity ids in tiebreak precedence order. */
  readonly tiebreakOrder: readonly ActivityId[];
  readonly participants: Readonly<Record<ParticipantId, Participant>>;
  /** activityId -> pid -> score */
  readonly scores: Readonly<Record<ActivityId, Readonly<Record<ParticipantId, RawScore>>>>;
  readonly spots: readonly SpotAward[];
  readonly holding: HoldingCard | null;
  /**
   * The loaded question set and where it is. Null until `loadTrivia`.
   *
   * Trivia lives *inside* the session state rather than beside it so that one
   * snapshot and one event log restore the whole session: a crash between
   * `openQuestion` and `closeQuestion` has to come back with the same answers
   * in it, and a second store would have a second consistency problem.
   */
  readonly trivia: TriviaState | null;
  /** Joins refused while true, even in lobby/running. */
  readonly joinsLocked: boolean;
  /** Monotonic, bumped on every accepted event. */
  readonly seq: number;
  readonly nextPlayerNumber: number;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export type Event =
  // participant
  | { type: "join"; pid: ParticipantId; nickname: string }
  | { type: "disconnect"; pid: ParticipantId }
  | { type: "reconnect"; pid: ParticipantId }
  // host — lifecycle
  | { type: "open" }
  | { type: "start" }
  | { type: "close" }
  | { type: "setSegment"; segment: Segment }
  | { type: "setSeal"; seal: Seal }
  | { type: "setHolding"; holding: HoldingCard | null }
  | { type: "setJoinsLocked"; locked: boolean }
  // host — scoring
  | { type: "setScore"; activityId: ActivityId; pid: ParticipantId; raw: number }
  | { type: "setStatus"; activityId: ActivityId; pid: ParticipantId; status: ScoreStatus }
  | { type: "grantSpot"; pid: ParticipantId; activityId: ActivityId; reason: string }
  | { type: "revokeSpot"; seq: number }
  | { type: "kick"; pid: ParticipantId }
  /** Frees a nickname so a reconnecting participant can retake it. */
  | { type: "releaseNickname"; pid: ParticipantId }
  // trivia
  | { type: "loadTrivia"; activityId: ActivityId; questions: readonly Question[] }
  | { type: "openQuestion"; suddenDeath: boolean }
  /**
   * `ms` is the corrected response time, computed at the socket boundary
   * before this event is built. The engine is pure and has no clock, so it
   * cannot derive it — and must not, because deriving it from `now` would
   * silently reintroduce network time into the score.
   */
  | { type: "answerQuestion"; pid: ParticipantId; choice: number; ms: number }
  /** Host closing early, or the server's timer firing. Same event either way. */
  | { type: "closeQuestion" }
  | { type: "revealQuestion" }
  | { type: "nextQuestion" };

/* ------------------------------------------------------------------ */
/* Effects                                                             */
/* ------------------------------------------------------------------ */

export type Audience = "all" | "host" | "screen" | { pid: ParticipantId };

export type Effect =
  | { kind: "broadcast"; to: Audience; what: "state" | "standings" | "toast"; detail?: string }
  | { kind: "persist"; what: "snapshot" | "event" }
  /** `to` is an Audience, not a pid: host commands are rejected to the host. */
  | { kind: "reject"; to: Audience; code: RejectCode; message: string };

export type RejectCode =
  /** The name is in use by someone else. */
  | "nickname_taken"
  /** Kicked, and trying to come back under the same name. */
  | "kicked"
  /** The name is unusable: empty, or shorter than two characters. */
  | "invalid_nickname"
  | "joins_locked"
  | "session_closed"
  | "not_joinable"
  | "unknown_participant"
  | "unknown_activity"
  /** A host command that does not apply in the current phase. */
  | "wrong_phase"
  /** A raw score that is not a finite, non-negative number. */
  | "invalid_score"
  | "reason_required"
  | "bench_cannot_receive_spot"
  /** A raw score was typed into a cell the host has since benched. */
  | "bench_cannot_be_scored"
  | "spot_cap_reached"
  // trivia
  | "no_questions_loaded"
  | "questions_already_loaded"
  /** A second `loadTrivia` after the first question has been opened. */
  | "trivia_already_started"
  | "wrong_question_phase"
  | "already_answered"
  | "invalid_choice"
  | "question_not_open"
  | "no_more_questions";

export interface ReduceResult {
  readonly state: SessionState;
  readonly effects: readonly Effect[];
  /**
   * Whether the event changed anything. False for both a rejection and a
   * no-op, so a caller can tell "nothing happened" from "something did"
   * without snapshotting `seq` around every call.
   */
  readonly applied: boolean;
}
