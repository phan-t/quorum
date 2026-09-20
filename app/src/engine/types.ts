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
  /**
   * The arcade register: player numbers, who is on the Floor, what is banked.
   * Null until `enterArcade`.
   *
   * Here for the same reason `trivia` is here and not beside it: one snapshot
   * and one event log have to restore the whole session. A crash between
   * `beginPlay` and `endRound` must come back with the same people drained and
   * the same points banked, and a second store would be a second thing for the
   * first one to disagree with.
   */
  readonly arcade: ArcadeState | null;
  /** Joins refused while true, even in lobby/running. */
  readonly joinsLocked: boolean;
  /** Monotonic, bumped on every accepted event. */
  readonly seq: number;
  readonly nextPlayerNumber: number;
}

/* ------------------------------------------------------------------ */
/* Hashi Arcade                                                        */
/* ------------------------------------------------------------------ */

/**
 * What a round needs to start. The host sets these; SPEC calls the resource
 * target "a host setting" and 120 is only a tuning default.
 */
export type ArcadeRoundConfig =
  | { readonly kind: "recruitment"; readonly items: readonly EmojiItem[]; readonly secondsPerItem: number }
  | { readonly kind: "plan_apply"; readonly target: number; readonly seconds: number };

export type ArcadeRoundKind =
  | "recruitment"
  | "plan_apply"
  | "unseal"
  | "tug_of_raft"
  | "gganbu"
  | "glass_bridge";

/**
 * Round 0, Recruitment: two emoji, one product, typed.
 *
 * The answer is matched after folding, with an accept list, because "tf" is a
 * reasonable thing to type for Terraform under a twenty-second timer and
 * refusing it would be the game being clever at the player's expense.
 */
export interface EmojiItem {
  readonly cue: string;
  readonly answer: string;
  readonly accept: readonly string[];
  /** Shown at the reveal. The bit people actually learn from. */
  readonly note: string;
}

/**
 * Where a person is this round.
 *
 * `drained` is not elimination and lasts exactly one round — SPEC is emphatic
 * about both. The Lounge is where a drained player goes, and they are still
 * scoring there, which is the whole design.
 */
export type ArcadeStanding = "floor" | "drained";

export interface LoungeSeat {
  /** Who they are backing, changeable until the Floor locks. */
  readonly backing: ParticipantId | null;
  /** The instant they were drained, for the big screen's ordering. */
  readonly at: number;
}

export type ArcadePhase = "idle" | "card" | "running" | "reveal";

/**
 * State shared by every round, plus whichever round is being played.
 *
 * `banked` is per round and `totals` is the arcade raw score. They are
 * separate because SPEC banks progress at checkpoints *before* a drain — being
 * caught at 75% keeps what you banked at 50% — so a drain must not be able to
 * take away points already earned this round.
 */
export interface ArcadeState {
  readonly activityId: ActivityId;
  /** Three digits, roster order, assigned once on entering the arcade. */
  readonly playerNumbers: Readonly<Record<ParticipantId, number>>;
  readonly round: ArcadeRoundKind | null;
  /** Which round of the run this is, from 0. For the round card. */
  readonly roundIndex: number;
  readonly phase: ArcadePhase;
  readonly standing: Readonly<Record<ParticipantId, ArcadeStanding>>;
  readonly lounge: Readonly<Record<ParticipantId, LoungeSeat>>;
  /** Earned this round, kept through a drain. */
  readonly banked: Readonly<Record<ParticipantId, number>>;
  /** Cumulative arcade raw, across rounds. */
  readonly totals: Readonly<Record<ParticipantId, number>>;
  /** Null unless a round is running. Absolute epoch, never a duration. */
  readonly startedAt: number | null;
  readonly endsAt: number | null;
  /** The round being played, if it carries state of its own. */
  readonly play: ArcadePlay | null;
}

/** Per-round state. One variant per round that needs one. */
export type ArcadePlay =
  | {
      readonly kind: "recruitment";
      readonly items: readonly EmojiItem[];
      readonly at: number;
      readonly secondsPerItem: number;
      /**
       * When the current item closes. Each item carries its own twenty
       * seconds, so the round's `endsAt` is the last item's, not this one.
       */
      readonly itemEndsAt: number;
      /**
       * Correct answers to the *current item*, in order, for the "first three"
       * bonus — which is per item, not per round: three bonuses on each of six
       * items is what makes the Floor max 6 × 15 = 90. Cleared by `nextItem`.
       */
      readonly solvedOrder: readonly ParticipantId[];
      /** Who has answered the current item, and whether they got it. */
      readonly answered: Readonly<Record<ParticipantId, boolean>>;
    }
  | {
      readonly kind: "plan_apply";
      /** `plan` is green and tappable; `apply` is pink and a tap drains you. */
      readonly light: "plan" | "apply";
      /** When the current light began. The turn is announced 400 ms ahead. */
      readonly lightChangedAt: number;
      readonly nextChangeAt: number;
      /** Resources tapped, per player. The finish line is `target`. */
      readonly resources: Readonly<Record<ParticipantId, number>>;
      readonly target: number;
      /** How long the Floor runs once `beginPlay` starts the clock. */
      readonly seconds: number;
      /** Who has crossed, in order, for the +15/+10/+5. */
      readonly finishOrder: readonly ParticipantId[];
    };

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
  | { type: "nextQuestion" }
  // arcade
  | { type: "enterArcade"; activityId: ActivityId }
  | { type: "startRound"; round: ArcadeRoundKind; config: ArcadeRoundConfig }
  /** The round card is up; the Floor opens on `beginPlay`. */
  | { type: "beginPlay" }
  /** Recruitment: a typed answer. Folding happens before this event. */
  | { type: "submitAnswer"; pid: ParticipantId; answer: string }
  | { type: "nextItem" }
  /**
   * Plan/Apply: the server flips the light. The engine has no clock and no
   * randomness, so the duration is chosen at the boundary and passed in.
   */
  | { type: "setLight"; light: "plan" | "apply"; until: number }
  /** One tap. `ms` is the corrected instant, as with a trivia answer. */
  | { type: "tap"; pid: ParticipantId; at: number }
  /** Lounge: back a player, or change who you are backing. */
  | { type: "backPlayer"; pid: ParticipantId; backing: ParticipantId }
  | { type: "endRound" }
  | { type: "revealRound" };

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
  | "no_more_questions"
  // arcade
  | "not_in_arcade"
  | "wrong_round_phase"
  | "already_answered_item"
  | "not_on_the_floor"
  | "not_in_the_lounge"
  | "cannot_back_yourself"
  | "cannot_back_a_drained_player"
  | "floor_locked"
  /** `startRound` for one of the four rounds that are designed but not built. */
  | "round_not_built"
  /** A round config the round itself rejects — a target of zero, say. */
  | "invalid_round_config";

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
