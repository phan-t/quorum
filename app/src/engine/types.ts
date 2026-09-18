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
  | { type: "releaseNickname"; pid: ParticipantId };

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
  | "spot_cap_reached";

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
