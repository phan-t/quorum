/**
 * The wire protocol, shared by the server and all three clients.
 *
 * JSON text frames, every message `{ t: "<type>", ... }`. Server broadcasts
 * carry `seq`, a per-session monotonic counter: a client that sees a gap sends
 * `resync` and gets a full `state` back. Client messages carry `cid`, echoed
 * in `ack`, so a client can reconcile an optimistic update.
 *
 * Phase 1 covers connection, segments, roster, seal and host control. Phase 3
 * adds trivia; Phase 4 adds the arcade.
 */

import type {
  ArcadePhase,
  ArcadeRoundKind,
  ArcadeStanding,
  GlassWave,
  ParticipantId,
  QuestionPhase,
  Seal,
  ScoreStatus,
  Segment,
  SessionPhase,
  UnsealShape,
  WaveSeconds,
} from "./engine/types.ts";

export const PROTOCOL_VERSION = 1;

export type Role = "participant" | "host" | "screen";

/** Why a socket was refused. Distinct from engine RejectCodes on purpose: */
export type RefusedReason =
  | "no_such_code"
  | "nickname_taken"
  | "invalid_nickname"
  | "lobby_locked"
  | "kicked"
  | "bad_token"
  | "not_joinable"
  | "rate_limited"
  | "malformed";

/* ------------------------------------------------------------------ */
/* Client → server                                                     */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  | {
      t: "hello";
      role: "participant";
      joinCode: string;
      nickname: string;
      /** Present on a reconnect; lets the server restore the same pid. */
      rejoinToken?: string;
    }
  | { t: "hello"; role: "host"; hostToken: string }
  | { t: "hello"; role: "screen"; screenToken: string }
  | { t: "resync" }
  | { t: "ping"; t0: number }
  /**
   * One tap, and it is final. Participants only.
   *
   * There is deliberately no timestamp on this frame. The response time is
   * measured at the socket boundary from the server's own clock and its own
   * latency estimate for this socket — a client-supplied `at` would be a
   * number worth points, which is a number worth forging.
   *
   * `index` is the question the tap was meant for. A tap sent as the host
   * closes and advances would otherwise land on the *next* question, which is
   * the one race a phone can lose without anyone noticing.
   */
  | { t: "trivia.answer"; cid: string; index: number; choice: number }
  /**
   * Recruitment: a typed answer, one per item and final.
   *
   * `item` is the index the answer was meant for, for the same reason
   * `trivia.answer` carries one: a phone that submits as the host advances
   * would otherwise have answered the *next* emoji, which it has not seen.
   */
  | { t: "arcade.answer"; cid: string; item: number; answer: string }
  /**
   * Plan / Apply: one tap on the big button.
   *
   * No timestamp, for the trivia reason and then one more. The instant a tap
   * happened decides whether it was a resource or a drain, so a client-chosen
   * `at` would not merely be worth points — it would be an "I did not tap
   * during the lock" claim that nothing could check. The server times it from
   * its own clock and its own latency estimate for this socket; see
   * SPEC.md "Plan / Apply" and `correctedTapAt` in runtime.ts.
   *
   * `round` is the arcade's `roundIndex`, so a tap in flight when the round
   * ends cannot land on the next one.
   */
  | { t: "arcade.tap"; cid: string; round: number }
  /**
   * The Glass Bridge: put your weight on one of the two panes. One per step,
   * and it is final.
   *
   * No timestamp, for the same two reasons a tap carries none, and then a
   * third. The decision time this frame produces — how long after the step
   * opened the pane was chosen — is what "the fastest full crossing" is
   * measured in, so a client-chosen instant would be a number worth 15 points
   * to somebody's backer. The server times it from its own clock and its own
   * latency estimate for this socket; see `step` in runtime.ts.
   *
   * `step` is the step the phone believed was open, for the reason
   * `arcade.answer` carries `item`: a frame that crossed a step boundary is a
   * commitment to a pane the player never saw, and the engine refuses it
   * rather than applying it to whatever is open now. `round` is the arcade's
   * `roundIndex`, so a frame in flight when the round ends cannot land on the
   * next one — the bridge resets to step 0 at every wave and every round, and
   * step 0 is exactly the index a stale frame carries.
   *
   * `choice` is 0 for the left pane and 1 for the right, in the order the
   * labels arrived. Which of them is real is not on this wire in either
   * direction: see {@link ArcadeGlassView}.
   */
  | { t: "arcade.step"; cid: string; round: number; step: number; choice: number }
  /**
   * Unseal: choose a shape, before knowing the word.
   *
   * No timestamp and nothing else: the shape is the whole bet. `round` is the
   * arcade's `roundIndex`, so a pick in flight when the host moves on cannot
   * hand somebody a tin in the next round.
   *
   * Changeable while the tin is still closed and final once the Floor opens —
   * that rule lives in the engine, not here.
   */
  | { t: "arcade.shape"; cid: string; round: number; shape: UnsealShape }
  /**
   * Unseal: tap one letter of the scrambled cue.
   *
   * The **character**, not a tile index, because a word with a repeated
   * letter has two tiles that are the same tap and an index would make the
   * two of them different. The engine checks the character is on the tin and
   * refuses anything else as a malformed frame rather than as a wrong guess.
   *
   * No timestamp: the only instant this round measures is when a tin came
   * open, which decides the +10 for the fastest in a shape, and a
   * client-chosen one would be a number worth points. The server times it
   * from its own clock — see `letter` in runtime.ts.
   */
  | { t: "arcade.letter"; cid: string; round: number; letter: string }
  /**
   * Unseal: **Read the docs.** Reveals the next letter and halves the round.
   *
   * Its own frame rather than a flag on `arcade.letter`, because it is not a
   * guess: it commits whatever the next letter is, which the phone does not
   * know and must not be told in order to send this.
   */
  | { t: "arcade.docs"; cid: string; round: number }
  /**
   * Tug of Raft: one tap at the rope.
   *
   * No timestamp, for the reason `arcade.tap` carries none and then the one
   * that matters most in this round: whether a tap was *on the beat* is the
   * entire game, so a client-chosen instant would be a claim to have hit
   * every beat that nothing could check. The server times it from its own
   * clock and its own latency estimate for this socket, and the beat grid it
   * is judged against is the server's — see `beat` in runtime.ts.
   */
  | { t: "arcade.beat"; cid: string; round: number }
  /** The Lounge: back a player, or change who you are backing. */
  | { t: "arcade.back"; cid: string; pid: ParticipantId }
  /**
   * `cmd` is null when the command could not be parsed. The frame still
   * arrives so the server can answer with `refusedCmd` on that `cid` — a
   * console that gets silence cannot tell a rejected click from a dropped one.
   */
  | { t: "host.cmd"; cid: string; cmd: HostCommand | null };

/** Mirrors the console's buttons one to one. Phase 1 subset. */
export type HostCommand =
  /** draft -> lobby: the join code goes live and people can arrive. */
  | { name: "open" }
  | { name: "start" }
  | { name: "close" }
  /**
   * Undo a close: `closed` -> `running`, keeping every score. Nothing else
   * moves — see the `reopen` event in engine/types.ts.
   */
  | { name: "session.reopen" }
  /**
   * Back to a clean lobby, wiping every score. The room, the join code and the
   * loaded questions stay.
   *
   * `confirm` carries the session's own join code, and the server refuses the
   * command unless it matches. It is not authentication — the socket is
   * already the host's — it is the reason this one command cannot be fired by
   * a frame that merely names it. Every other command in this union is
   * expressible as a bare `{ name }`, which is fine for a command that shows a
   * holding card and is not fine for the one that wipes the afternoon. A
   * replayed frame, a fuzzed frame, or a console that has lost track of which
   * session it is attached to all fail this check rather than land.
   *
   * The host's own guard is a different one and lives in the console: they
   * type a word into a field. The join code is not something anybody should be
   * asked to type — it is `hvs.` and twenty-four case-sensitive characters.
   */
  | { name: "session.restart"; confirm: string }
  | { name: "segment"; kind: Segment }
  | { name: "holding"; title: string; line: string }
  | { name: "seal"; state: Seal }
  /**
   * Practice on or off. A boolean rather than a toggle, so two consoles that
   * both press it do not cancel each other out.
   */
  | { name: "practice"; on: boolean }
  /* ---- the send-off (a segment, not an activity) ---- */
  /**
   * One step through the send-off: the montage to the first message, one
   * message to the next, the last message to the closing card, and off the
   * end. The engine's `sendoffNext` event, which is the same walk read
   * forwards.
   *
   * Skipping a kudo is two of these in one press — see the console. There is
   * deliberately no `sendoff.skip`: the engine holds no such event, and a
   * command that means "two steps" is a thing the wire should not have to
   * express when "one step" already composes.
   */
  | { name: "sendoff.next" }
  /** Back one step, for an overshoot. The engine's `sendoffBack`. */
  | { name: "sendoff.back" }
  /**
   * Auto / Manual, and the speed of auto in seconds per photograph.
   *
   * Two commands rather than one settings blob: the button and the slider are
   * pressed at different moments, and a slider drag that also re-sent the mode
   * would fight a host who had just switched back to manual.
   */
  | { name: "sendoff.auto"; auto: boolean }
  | { name: "sendoff.speed"; seconds: number }
  | { name: "lobby.lock"; locked: boolean }
  | { name: "participant.kick"; pid: ParticipantId }
  | { name: "participant.release"; pid: ParticipantId }
  /* ---- scoring (phase 2) ---- */
  /** Raw score for one person in one activity. Whatever it scored out of. */
  | { name: "score.set"; activityId: string; pid: ParticipantId; raw: number }
  /** played / bench / unset. Bench is what triggers Bench Credit. */
  | {
      name: "score.status";
      activityId: string;
      pid: ParticipantId;
      status: ScoreStatus;
    }
  /** 10 points, and the reason is required — it gets read out. */
  | {
      name: "spot.grant";
      pid: ParticipantId;
      activityId: string;
      reason: string;
    }
  | { name: "spot.revoke"; seq: number }
  /* ---- trivia (phase 3) ---- */
  /**
   * Open the current question. The timer starts on the server and every
   * surface counts down to the same absolute `closesAt`.
   *
   * `suddenDeath` rides on the open rather than being its own command because
   * the engine has no event for arming it: `openQuestion` carries it, so the
   * console's toggle is a pre-arm and the mode is fixed for the question at
   * the moment it opens. Flipping it mid-question would change the rules
   * under people who have already answered.
   */
  | { name: "trivia.open"; suddenDeath: boolean }
  /** Close early. The server's timer sends the identical event at `closesAt`. */
  | { name: "trivia.close" }
  | { name: "trivia.reveal" }
  | { name: "trivia.next" }
  /* ---- arcade (phase 4) ---- */
  /** Hand out the player numbers and put the room in the arcade. */
  | { name: "arcade.enter" }
  /**
   * Pick the round and its settings. Two variants rather than one command
   * with optional fields: a round's settings are not interchangeable, and
   * `{ kind: "plan_apply", secondsPerItem: 20 }` should not be a thing the
   * wire can express.
   *
   * The content — the six emoji items — is *not* on this command. It lives on
   * the server and is attached when the event is built, so a console cannot
   * choose what the answers are and the answers never travel towards a phone.
   */
  | { name: "arcade.round"; kind: "recruitment"; secondsPerItem: number }
  | { name: "arcade.round"; kind: "plan_apply"; target: number; seconds: number }
  /**
   * The Glass Bridge. Only the three step timers are the host's to set.
   *
   * The eighteen panes are *not* on this command, for the reason Recruitment's
   * six items are not: the content lives on the server, is attached when the
   * event is built, and therefore never travels towards a browser. Here that
   * is not merely tidy — the steps carry `real` and both reveal notes, so a
   * round config on the wire would be the answer key leaving the server on a
   * frame the console could be made to echo.
   */
  | { name: "arcade.round"; kind: "glass_bridge"; waveSeconds: WaveSeconds }
  /**
   * Unseal. Only the length of the Floor is the host's to set.
   *
   * The tins are *not* on this command, for the reason the Bridge's
   * panes are not: an `UnsealItem` carries the word and the reveal note, so a
   * round config on the wire would be the answer key leaving the server on a
   * frame the console could be made to echo.
   */
  | { name: "arcade.round"; kind: "unseal"; seconds: number }
  /**
   * Tug of Raft: how many pulls, how long each one is, and the heartbeat.
   *
   * The **seed is not here**. Sides are "reshuffled by seed before each of
   * three pulls" and a seed the console chose would be a console that can
   * deal itself the sides; it is drawn at the socket boundary exactly as
   * Plan / Apply's light durations are, and for the same reason.
   */
  | {
      name: "arcade.round";
      kind: "tug_of_raft";
      pulls: number;
      pullSeconds: number;
      bpm: number;
    }
  /** The round card is up; this opens the Floor. */
  | { name: "arcade.begin" }
  /** Recruitment: next emoji. */
  | { name: "arcade.next" }
  /**
   * The Glass Bridge: close the open step and open the next one.
   *
   * The server's step timer sends the identical event at `stepEndsAt`, so this
   * is the host cutting a step short — every runner has already stepped and
   * nobody wants to watch the clock run out — and not a second code path.
   */
  | { name: "arcade.nextStep" }
  /** The Glass Bridge: close the wave and send the next one onto the bridge. */
  | { name: "arcade.nextWave" }
  /**
   * Tug of Raft: settle the open pull and start the next one, with new sides.
   *
   * The server's pull timer sends the identical event at `pullEndsAt`, so
   * this is the host cutting a pull short and not a second code path. It
   * carries no seed for the reason `arcade.round` does not.
   */
  | { name: "arcade.nextPull" }
  | { name: "arcade.end" }
  | { name: "arcade.reveal" };

/* ------------------------------------------------------------------ */
/* Server → client                                                     */
/* ------------------------------------------------------------------ */

export interface RosterEntry {
  readonly pid: ParticipantId;
  readonly nickname: string;
  readonly playerNumber: number;
  /** `away` after 30s of silence — amber on the console, not a disconnect. */
  readonly conn: "on" | "away";
}

/** The participant's own points strip. Omitted entirely while sealed. */
export interface OwnPoints {
  readonly total: number;
  readonly byActivity: Readonly<Record<string, number | null>>;
}

export interface StandingRow {
  readonly rank: number;
  readonly nickname: string;
  readonly total: number;
  /**
   * Points per activity, so the big screen can draw the stacked bar in
   * activity hues. Null where nothing has been scored yet; a bench credit
   * reads as a number like any other, with `bench` saying where it came from.
   */
  readonly perActivity: Readonly<Record<string, number | null>>;
  readonly bench: readonly string[];
  readonly spot: number;
}

/** One row of the console's scoring grid. Host only. */
export interface ScoreRow {
  readonly pid: ParticipantId;
  readonly nickname: string;
  readonly playerNumber: number;
  /** activityId -> what was typed, and whether they played it. */
  readonly raw: Readonly<Record<string, number | null>>;
  readonly status: Readonly<Record<string, ScoreStatus>>;
  readonly points: Readonly<Record<string, number | null>>;
  readonly spot: number;
  readonly total: number;
  readonly rank: number;
}

export interface ActivitySummary {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly spotCap: number;
  readonly spotsLeft: number;
}

/* ------------------------------------------------------------------ */
/* Trivia                                                              */
/* ------------------------------------------------------------------ */

/**
 * A run of consecutive questions sharing a CSV `Round` value.
 *
 * SPEC: "Consecutive questions with the same value get a round card between
 * them." So the card belongs to the *first* question of a run, and the run is
 * computed once, on the server, rather than three times by three surfaces
 * looking at a question list two of them are never sent.
 */
export interface TriviaRound {
  readonly name: string;
  /** 1-based position of this question within the run. */
  readonly position: number;
  readonly size: number;
  /** True on the first question of the run: the console offers the card. */
  readonly startsHere: boolean;
}

/** One line of the activity's own podium. Five at most, on every surface. */
export interface TriviaPodiumRow {
  readonly rank: number;
  readonly nickname: string;
  readonly points: number;
}

/**
 * The question, as the room may see it *right now*.
 *
 * The optional fields are the whole point of this type. They are absent —
 * not null — for a role that may not have them yet, so the word never appears
 * in the JSON on that socket and "was it sent?" is a question about the wire
 * rather than about a renderer's discipline:
 *
 * | field | participant | screen | host |
 * | --- | --- | --- | --- |
 * | `correct` | reveal | reveal | always |
 * | `distribution` | never | reveal | always |
 * | `note` | reveal | reveal | always |
 * | `podium` | reveal | reveal | reveal |
 * | `answered` / `eligible` | never | always | always |
 *
 * A phone that learns the correct answer while the question is open has lost
 * the game for the person sitting next to its owner, and a phone that learns
 * the distribution is showing a big-screen thing on a 360px surface. The host
 * sees everything, always, because they are reading the answer out.
 */
export interface TriviaView {
  readonly activityId: string;
  /** 0-based index into the loaded set. */
  readonly index: number;
  readonly of: number;
  readonly phase: QuestionPhase;
  readonly text: string;
  /** Two to four. A blank CSV column is a question with fewer answers. */
  readonly answers: readonly string[];
  /**
   * Absolute server epochs, never durations: a client that receives this late
   * still counts down to the right instant. `closesAt` is null in sudden
   * death, which has no timer at all.
   */
  readonly opensAt: number | null;
  readonly closesAt: number | null;
  readonly timeLimitSec: number;
  readonly basePoints: number;
  readonly suddenDeath: boolean;
  /** A nickname, once someone has taken it. Sudden death only. */
  readonly suddenDeathWinner: string | null;
  readonly round: TriviaRound | null;
  /** 0-based, Kahoot semantics: more than one means any of them counts. */
  readonly correct?: readonly number[];
  /** Counts per answer index, same length as `answers`. */
  readonly distribution?: readonly number[];
  readonly note?: string;
  readonly podium?: readonly TriviaPodiumRow[];
  readonly answered?: number;
  /** Everyone in the room who could have answered — the "of 27". */
  readonly eligible?: number;
}

/**
 * The participant's own standing in the current question. Participants only.
 *
 * Three states and no fourth, because the middle one is a security property:
 * while the question is open the phone is told that it is locked in and
 * **nothing else**. There is no `correct` field on `locked` to forget to
 * strip, no `points` to render by accident, and nothing in the JSON for
 * someone with devtools to read out to the room. SPEC: "the phone shows
 * 'locked in' and nothing else … a phone that turns green is visible to the
 * person next to you."
 */
export type TriviaMine =
  | { readonly state: "unanswered" }
  | { readonly state: "locked"; readonly choice: number }
  | {
      readonly state: "revealed";
      /** Null when they did not answer at all. */
      readonly choice: number | null;
      readonly correct: boolean;
      /** For this question. Zero when wrong, absent, or a warm-up. */
      readonly points: number;
      readonly streakBonus: number;
      /** Consecutive correct answers *including* this one. */
      readonly streak: number;
      /** Their running trivia total, which is the raw score for the activity. */
      readonly total: number;
    };


/* ------------------------------------------------------------------ */
/* Hashi Arcade                                                        */
/* ------------------------------------------------------------------ */

export type ArcadeLight = "plan" | "apply";

/**
 * One cell of the big screen's dormitory grid — and, small, of the mirror at
 * the bottom of the Lounge screen.
 *
 * Numbers, not nicknames. DESIGN.md: "Lines refer to player numbers, never
 * nicknames, when the news is bad … the nickname is on the phone only." The
 * roster is on every socket already, so this is a rendering rule that the
 * shape of the cell keeps honest rather than a secret the wire is keeping.
 *
 * No points and no resource counts, on any surface but the host's. Sixty
 * cells each carrying a score is the full leaderboard, which SPEC allows
 * exactly nobody below the console to see.
 */
export interface ArcadeCell {
  readonly pid: ParticipantId;
  /** Three digits when rendered; a number here. */
  readonly playerNumber: number;
  readonly standing: ArcadeStanding;
  /** How many people in the Lounge are backing them. */
  readonly backers: number;
  /** Drained during *this* round: the thin pink strike over the cell. */
  readonly struck: boolean;
}

/**
 * Round 0, Recruitment.
 *
 * `answer` is the whole game, so it is the field this type exists to withhold:
 * it reaches a phone or the big screen at the reveal and not one frame before,
 * and the host has it throughout because the host is reading it out.
 */
export interface ArcadeItemRecap {
  readonly cue: string;
  readonly answer: string;
  readonly note: string;
}

export interface ArcadeRecruitmentView {
  /** 0-based index into the item list. */
  readonly at: number;
  readonly of: number;
  /**
   * When *this item* closes, as an absolute epoch — never a duration.
   *
   * Every role gets it, because every surface has an item timer to draw and
   * the round's `endsAt` is the wrong number for all of them: it is the last
   * item's deadline, two minutes away on item one. Absent while the round
   * card is up and at the reveal, when no item is running.
   */
  readonly itemEndsAt?: number;
  /** The two emoji. Absent until the Floor is open — a card is not a cue. */
  readonly cue?: string;
  /** The current item's answer. Reveal, and the host. */
  readonly answer?: string;
  readonly note?: string;
  /**
   * Every item with its answer and its note, for the reveal the room reads
   * together. Present at the reveal, and to the host throughout.
   */
  readonly recap?: readonly ArcadeItemRecap[];
  /** Host and screen: the climbing counts. */
  readonly answered?: number;
  readonly eligible?: number;
  readonly solved?: number;
  /** The first three correct in the room, as player numbers. At the reveal. */
  readonly firstThree?: readonly number[];
}

/**
 * Round 1, Plan / Apply.
 *
 * The two optional epochs are the point of the whole projection. A phone that
 * knew `nextChangeAt` could tap until 401 ms before the lock and never be
 * caught, so it is **absent** from a participant's frame — not null, not zero:
 * the key is not in the bytes. The big screen has it because the big screen
 * *is* the warning, and the host has it because the host is watching for the
 * round to end.
 *
 * `headTurnsAt` is the telegraph, 400 ms before the lock, as an absolute
 * epoch. It is sent rather than derived so that a screen which received this
 * frame late still starts the wipe at the instant the server meant, and stops
 * it at the instant the light actually changes.
 */
export interface ArcadePlanApplyView {
  readonly light: ArcadeLight;
  /** When the current light began. Absolute, so a late frame still lines up. */
  readonly lightChangedAt: number;
  readonly target: number;
  /** Where the progress bar's ticks go, and where the banking happens. */
  readonly checkpoints: readonly number[];
  /** Screen and host only. */
  readonly nextChangeAt?: number;
  /** Screen and host only, and only for a turn *into* the lock. */
  readonly headTurnsAt?: number;
  /** Screen and host: how many have crossed the line. */
  readonly crossed?: number;
  /** Screen and host: who crossed, in order, as player numbers. */
  readonly finishOrder?: readonly number[];
}

/**
 * Round 2, Unseal: one of the four tins, as the room may see it.
 *
 * `score` is on the wire rather than in the client because it is the whole of
 * the bet: SPEC.md prices the four shapes at 10 / 20 / 35 / 50 and the pick
 * is made before the word is known, so the number *is* the question the
 * picker asks. One source of truth for it — `UNSEAL_SHAPE_SCORE` in
 * engine/arcade.ts — and the client renders what it is told.
 *
 * What is deliberately not here is **who** picked what. `picked` is a count,
 * exactly as `unsealFloorView` makes it: a per-player shape on the big screen
 * is a per-player word length, three metres from the person working it out.
 * And no length: the shapes *are* the lengths, and learning which is which is
 * what picking buys you.
 */
export interface ArcadeUnsealShape {
  readonly shape: UnsealShape;
  /** There is at least one tin of this shape. A host may load a set without. */
  readonly available: boolean;
  /** What unsealing it pays, in total. SPEC.md: 10 / 20 / 35 / 50. */
  readonly score: number;
  /** How many picked it. Numbers, not people. */
  readonly picked: number;
  /** How many of those have the tin open. */
  readonly unsealed: number;
  /** Fastest in this shape, as a player number. Screen and host, at the end. */
  readonly fastest?: number;
}

/**
 * One tin with its word, at the reveal. **The answer.**
 *
 * Every tin, not only the ones somebody held: SPEC.md asks the reveal to read
 * the note out, and the note is the thing a room of solutions architects
 * actually takes away — *Reusable Terraform. The thing everyone means to
 * write and never does.*
 */
export interface ArcadeUnsealRecap {
  readonly shape: UnsealShape;
  readonly cue: string;
  readonly answer: string;
  readonly note: string;
}

/**
 * Round 2, Unseal — projected.
 *
 * The round's secret is small and absolute: **the words**. They live in
 * `ArcadePlay.key` and reach one phone at a time, through `unsealMeView`, and
 * never any public surface until `revealRound`. There is no cue on this
 * view, no length, and no per-player shape, because any of the three would
 * say what somebody else is holding.
 *
 * | field | participant | screen | host |
 * | --- | --- | --- | --- |
 * | `shapes` (glyph, score, counts) | always | always | always |
 * | `shapes[].fastest` | never | always | always |
 * | `unsealOrder` | never | always | always |
 * | `progress` (per player) | never | never | always |
 * | `docs` (who read them) | never | never | always |
 * | `recap` (**the words**) | reveal | reveal | always |
 */
export interface ArcadeUnsealView {
  /** The four tins, in picker order: ○ △ ☆ ☂. */
  readonly shapes: readonly ArcadeUnsealShape[];
  /** How many are holding a tin at all, and how many are on the Floor. */
  readonly picked: number;
  readonly unsealed: number;
  /** Who got a tin open, in order, as player numbers. Screen and host. */
  readonly unsealOrder?: readonly number[];
  /**
   * Host only: letters tapped, per player.
   *
   * A count and never a letter — a letter would be the prefix of somebody's
   * word. It is on the console for the reason every other number is: the host
   * is the only reader who is not in the room.
   */
  readonly progress?: Readonly<Record<ParticipantId, number>>;
  /** Host only: who pressed **Read the docs**, as player numbers. */
  readonly docs?: readonly number[];
  /** The words, at the reveal. The host has them throughout: they read them out. */
  readonly recap?: readonly ArcadeUnsealRecap[];
}

/**
 * Round 3, Tug of Raft — projected.
 *
 * Nothing in this round is a secret. Nobody is drained, there is nothing to
 * know and no answer to withhold: SPEC.md builds it that way on purpose —
 * "the arcade needs one round that is pure noise". So the projection's job is
 * not secrecy, it is making sure **every surface counts the same beats**.
 *
 * That is why the beat is described here as a grid rather than as a tempo.
 * `pullStartedAt` is beat 0 and beat *n* is `pullStartedAt + n * beatMs`, as
 * absolute server epochs against the client's corrected clock — the same
 * discipline as `closesAt` in trivia and `stepEndsAt` on the bridge. A
 * surface that started its own 600 ms interval on the frame it happened to
 * receive would drift away from the server's grid within a pull, and every
 * tap it encouraged would be judged against a beat it was not showing.
 *
 * `toleranceMs`, `missesToElection` and `electionMs` ride along for the same
 * reason the checkpoints do in Plan / Apply: they are the rule, the engine
 * owns them, and a client that hard-coded its own copy would eventually draw
 * a window the server does not judge by.
 *
 * | field | participant | screen | host |
 * | --- | --- | --- | --- |
 * | the beat grid and the rope | always | always | always |
 * | `sides` (everybody's side) | never | always | always |
 * | `leaders` | never | always | always |
 * | `onBeats` (per player) | never | never | always |
 */
export interface ArcadeTugView {
  /** Which pull is being pulled, from 0. */
  readonly pull: number;
  readonly pulls: number;
  readonly pullSeconds: number;
  /** 60 000 / bpm. Beat *n* of the pull is `pullStartedAt + n * beatMs`. */
  readonly beatMs: number;
  /** How far off a beat a tap may land and still pull. */
  readonly toleranceMs: number;
  /** Missed beats in a row that time a node out. */
  readonly missesToElection: number;
  /** How long an election achieves nothing for. */
  readonly electionMs: number;
  /** Absolute server epochs. Absent while the round card is up. */
  readonly pullStartedAt?: number;
  readonly pullEndsAt?: number;
  /** On-beat taps this pull, per side. The rope is the difference. */
  readonly totals: readonly [number, number];
  /** Pulls won, per side. */
  readonly wins: readonly [number, number];
  /** Which side each player is on. The Desktop draws both clusters. */
  readonly sides?: Readonly<Record<ParticipantId, ParticipantSide>>;
  /** The best on-beat rate on each side, as player numbers. Null for nobody. */
  readonly leaders?: readonly [number | null, number | null];
  /** Host only: on-beat taps per player, which is what the leader is read off. */
  readonly onBeats?: Readonly<Record<ParticipantId, number>>;
}

/** 0 or 1. Which rope end, and nothing about which is winning. */
export type ParticipantSide = 0 | 1;

/**
 * Round 5, The Glass Bridge: one step of the bridge, as the room may see it.
 *
 * The product and the two labels, in display order, and nothing else. This is
 * `GlassBoardStep` from the engine, on the wire — the type exists so the
 * answer is *absent* from the value a projection is handed rather than merely
 * withheld by it. A projection that spreads one of these cannot leak the
 * round; a projection that spread a whole step would leak it on its first
 * line.
 */
export interface ArcadeGlassStep {
  readonly product: string;
  /** Left, then right. `choice` on `arcade.step` indexes this pair. */
  readonly labels: readonly [string, string];
}

/**
 * The same step at the reveal, with the answer attached: which pane was real,
 * and why the other one was not.
 *
 * SPEC.md: "The reveal note for each pane reads out why the fake was fake."
 * Both notes, because the big screen reads out both — the fake's is the joke
 * and the real one's is the thing somebody learns.
 */
export interface ArcadeGlassRecapStep {
  readonly product: string;
  readonly labels: readonly [string, string];
  readonly real: 0 | 1;
  readonly notes: readonly [string, string];
}

/**
 * Round 5, The Glass Bridge — the projection this round lives or dies on.
 *
 * **There is no screen-only secret in a room with a projector in it.** The
 * big screen is the surface waves 2 and 3 are told to read, and it is three
 * metres from the people still deciding, so whatever it carries the whole
 * room carries. That makes `glassFloorView()` in engine/arcade.ts the *only*
 * public view of the round, and everything here a subset of it: a
 * participant's frame is narrower than the screen's, never a different cut of
 * the same state.
 *
 * Absent from every role but the host until the reveal:
 *
 * - **the answer key.** `real` and the two notes live in `ArcadePlay.key` and
 *   reach a phone and the big screen at `revealRound` and not one frame
 *   earlier — including the phone of somebody who fell at step 1 and is
 *   sitting next to somebody who has not.
 * - **which pane anyone chose.** The engine never stores it, because with two
 *   panes *a pane that held identifies the real pane exactly as well as one
 *   that broke*. Nothing on this wire reintroduces it: there is no per-player
 *   choice, and there is no "who is standing where" that can be joined
 *   against a break to recover one.
 *
 * `broken` is the exception that proves it. It is written by the engine only
 * when a step **closes**, never as a player falls, so by the time an entry is
 * non-null every player who could have used it has already stepped past it.
 * That one rule is what keeps wave 1 blind and what waves 2 and 3 are
 * promised, and it is why this field is safe to send to everybody.
 *
 * `position` is safe for the same reason and needs saying, because it looks
 * like the dangerous one. It says how far along the bridge each player is,
 * which is "X survived step 3" — and that is only the answer to step 3 once
 * `broken[3]` is public, which is once step 3 has closed, which is once the
 * answer is public anyway. During an open step it says somebody is still
 * standing and says nothing whatever about which pane they are standing on.
 *
 * | field | participant | screen | host |
 * | --- | --- | --- | --- |
 * | `wave` / `waveCuts` / `waveSeconds` / `of` | always | always | always |
 * | `broken` | always | always | always |
 * | `board` | running, reveal | running, reveal | always |
 * | `step` / `stepStartedAt` / `stepEndsAt` / `waveStartedAt` | running | running | always |
 * | `position` | running, reveal | running, reveal | always |
 * | `crossed` / `fastest` | never | always | always |
 * | `elapsedMs` | never | never | always |
 * | `recap` | reveal | reveal | always |
 */
export interface ArcadeGlassView {
  /** Which wave is on the bridge. */
  readonly wave: GlassWave;
  /**
   * The last arcade player number in wave 1, and in wave 2.
   *
   * Two numbers rather than a per-player map, so the room can work out its
   * own wave off the big screen — which is how SPEC.md's "three waves by
   * player number" is actually read by thirty people at once.
   */
  readonly waveCuts: readonly [number, number];
  /** Seconds per step for waves 1, 2 and 3. SPEC.md tunes them to 12 / 9 / 6. */
  readonly waveSeconds: WaveSeconds;
  /** How many steps the bridge has. Present even while the round card is up. */
  readonly of: number;
  /**
   * Which pane broke, per step, or null for a step nobody has fallen at.
   *
   * The information wave 2 and wave 3 are promised, and the reason going
   * first is worse. Safe on every surface because of *when* the engine writes
   * it: see the note on this interface.
   */
  readonly broken: readonly (0 | 1 | null)[];
  /**
   * The eighteen panes, in bridge order. Absent while the round card is up,
   * for the reason Recruitment's cue is: the room is looking at the card, and
   * six pairs of labels sitting in a phone's JSON twenty seconds early is
   * twenty seconds of reading nobody else gets.
   */
  readonly board?: readonly ArcadeGlassStep[];
  /** 0-based index into `board`, for the wave that is crossing. */
  readonly step?: number;
  /**
   * How many of the crossing wave have committed to a pane at this step.
   *
   * A count, never a list: who has stepped is not projected anywhere, and a
   * number names nobody. It is carried so the phone can draw a waiting wave's
   * bet under the lock the engine actually enforces — the bet is open until
   * the crossing wave puts its first foot down, because a fall is public the
   * instant it happens. Everything it discloses is disclosed twice over
   * already: a commit either raises that player's `position` or drains them.
   */
  readonly onPanes?: number;
  /** Absolute server epochs, never durations. Absent unless a step is open. */
  readonly waveStartedAt?: number;
  readonly stepStartedAt?: number;
  readonly stepEndsAt?: number;
  /**
   * Steps completed, per player; `of` means across. This is the bridge
   * filling in, which is what SPEC.md asks a waiting wave to watch.
   */
  readonly position?: Readonly<Record<ParticipantId, number>>;
  /** Screen and host: who reached the far side, in order, as player numbers. */
  readonly crossed?: readonly number[];
  /** Screen and host: the fastest full crossing, as a player number. */
  readonly fastest?: number;
  /**
   * Host only: summed decision time per player, in ms.
   *
   * Not a secret — anyone in the room could hold a stopwatch — but it is the
   * raw material of an award, and DESIGN.md puts every number on the console
   * and nowhere else.
   */
  readonly elapsedMs?: Readonly<Record<ParticipantId, number>>;
  /** The answer, at the reveal. The host has it throughout: they read it out. */
  readonly recap?: readonly ArcadeGlassRecapStep[];
}

/**
 * The arcade, as one role may see it right now.
 *
 * | field | participant | screen | host |
 * | --- | --- | --- | --- |
 * | `grid` | always | always | always |
 * | `recruitment.cue` | running | running | always |
 * | `recruitment.answer` / `note` | reveal | reveal | always |
 * | `recruitment.answered` / `eligible` / `solved` | never | always | always |
 * | `planApply.light` | always | always | always |
 * | `planApply.nextChangeAt` / `headTurnsAt` | **never** | always | always |
 * | `planApply.crossed` / `finishOrder` | never | always | always |
 * | `unseal.shapes` (glyph, score, counts) | always | always | always |
 * | `unseal.progress` / `docs` | never | never | always |
 * | `unseal.recap` (**the words**) | reveal | reveal | always |
 * | `tug` beat grid and rope | always | always | always |
 * | `tug.sides` / `leaders` | never | always | always |
 * | `glass.broken` | always | always | always |
 * | `glass.board` | running, reveal | running, reveal | always |
 * | `glass.crossed` / `fastest` | never | always | always |
 * | `glass.recap` (**the answer**) | reveal | reveal | always |
 */
export interface ArcadeView {
  readonly activityId: string;
  readonly round: ArcadeRoundKind | null;
  /** Which round of the run this is, from 0. The round card counts from 1. */
  readonly roundIndex: number;
  readonly phase: ArcadePhase;
  /** Absolute server epochs, never durations. */
  readonly startedAt: number | null;
  readonly endsAt: number | null;
  readonly grid: readonly ArcadeCell[];
  readonly onFloor: number;
  readonly inLounge: number;
  readonly recruitment?: ArcadeRecruitmentView;
  readonly planApply?: ArcadePlanApplyView;
  readonly unseal?: ArcadeUnsealView;
  readonly tug?: ArcadeTugView;
  readonly glass?: ArcadeGlassView;
}

/** Recruitment, for the one phone it belongs to. */
export type ArcadeMineRecruitment =
  | { readonly state: "unanswered" }
  /**
   * Locked in, with whether it was right — and not with what they typed,
   * which their own phone already knows and the server has no reason to
   * repeat.
   *
   * Unlike trivia this *is* sent while the item is open, and the difference is
   * the input. Four tiles mean a phone that turns green tells the person next
   * to you which tile to press; a text field means "Recruited." tells them
   * nothing they can type. DESIGN.md asks for that line on a correct answer,
   * and the answer itself still does not travel.
   */
  | { readonly state: "locked"; readonly correct: boolean };

export interface ArcadeMinePlanApply {
  readonly resources: number;
  /** 1-based, once they are across the line. Absent until then. */
  readonly place?: number;
}

/**
 * Unseal, for the one phone it belongs to.
 *
 * This is `unsealMeView()` from engine/arcade.ts on the wire, and it is the
 * **only** way a cue ever leaves the server: there is no public view of the
 * tins at all, because publishing the list would say which word sits behind
 * each shape and "pick your shape before you know the word" is the entire
 * round.
 *
 * `cue` is null until the Floor opens — the tin is handed over at the pick
 * and opened when the round starts — and `solved` is the prefix this player
 * has already tapped, theirs because they tapped it. The rest of the word
 * stays in the key until `revealRound`.
 */
export interface ArcadeMineUnseal {
  /** Null until they choose. ○ △ ☆ ☂ */
  readonly shape: UnsealShape | null;
  /** The scrambled letters. Null until the Floor opens. */
  readonly cue: string | null;
  /** How long the word is, which is what the shape turns out to have meant. */
  readonly length: number;
  readonly progress: number;
  /** What they have tapped so far, in order. Never one letter more. */
  readonly solved: string;
  /** They pressed **Read the docs**. Their Floor score for the round halves. */
  readonly docs: boolean;
  readonly unsealed: boolean;
  readonly cracked: boolean;
}

/**
 * Tug of Raft, for the one phone it belongs to.
 *
 * Three facts and no fourth: which end of the rope they are on, how many
 * beats they have hit this pull, and the last beat they hit.
 *
 * `lastBeat` is what an **election** is derived from, here exactly as in the
 * engine. Three missed beats in a row time a node out for two seconds, and
 * neither side of the wire stores that: the engine has no clock, so it could
 * only ever write such a field when some other event happened to arrive —
 * which is precisely when it is not needed. The phone has a clock, so it
 * derives the same window from `lastBeat`, `pullStartedAt` and `beatMs`, and
 * the two agree because they are the same arithmetic on the same numbers.
 */
export interface ArcadeMineTug {
  readonly side: ParticipantSide;
  /** On-beat taps this pull. Reset every pull, like the sides. */
  readonly onBeats: number;
  /** The last beat they hit, as an index from the pull's start. −1 for none. */
  readonly lastBeat: number;
}

/**
 * The Glass Bridge, for the one phone it belongs to.
 *
 * This is `glassMeView()` from engine/arcade.ts on the wire, and it is
 * deliberately the *whole* of what one player is told that the room is not:
 * their wave, whether it is their turn, how far they have got, and whether
 * the pane they put their weight on held.
 *
 * `held` is their own fact about their own step and nothing else. It is not
 * the answer to the step — the phone is never told which pane was real, only
 * that the one they chose did or did not take their weight — and it tells
 * them nothing they would not know a second later from being drained or not.
 * It is absent, not null, until they commit.
 *
 * What is *not* here is the choice itself. The phone knows which pane it
 * pressed; the server never stores it and never sends it back, so there is no
 * frame anywhere on this wire that pairs a player with a pane.
 */
export interface ArcadeMineGlass {
  /** Theirs for the round, from their player number. Wave 1 goes blind. */
  readonly wave: GlassWave;
  /** Their wave is the one crossing, they are not drained, not yet across. */
  readonly onTheBridge: boolean;
  /** Steps completed. Also where they are standing. */
  readonly step: number;
  /** They have put their weight on a pane at the step that is open. */
  readonly committed: boolean;
  /** Whether that pane held. Absent until they commit. */
  readonly held?: boolean;
  readonly across: boolean;
}

/** The participant's own arcade standing. Participants only. */
export interface ArcadeMine {
  /** Theirs for the whole arcade. Rendered zero-padded to three digits. */
  readonly playerNumber: number;
  readonly standing: ArcadeStanding;
  /** Banked this round. Kept through a drain, which is the whole point. */
  readonly banked: number;
  /** The arcade raw score so far, across rounds. */
  readonly total: number;
  /**
   * Who they are backing. The Lounge, and on the Bridge a wave that is
   * waiting to cross and has bet on the wave in front of it.
   */
  readonly backing?: ParticipantId;
  /** Lounge only: absent for a bet placed from the Floor. */
  readonly drainedAt?: number;
  readonly recruitment?: ArcadeMineRecruitment;
  readonly planApply?: ArcadeMinePlanApply;
  readonly unseal?: ArcadeMineUnseal;
  readonly tug?: ArcadeMineTug;
  readonly glass?: ArcadeMineGlass;
}

/**
 * What a client renders. The server sends the view for that role — a
 * participant is never sent the full ranking, because the rule is that only
 * the top five is ever visible and enforcing it in the client would mean
 * shipping the rest of the list to the phone.
 */
/** One message, as any surface may see it. */
export interface KudoView {
  readonly from: string;
  readonly message: string;
}

export interface SendoffView {
  readonly name: string;
  readonly subtitle: string | null;
  readonly phase: "title" | "run" | "closing" | "done";
  /**
   * Which message, of how many, in the order the room is getting them.
   *
   * The plan shuffles the messages, so this is the ordinal within the run
   * rather than the index in the file — "9 of 13" has to mean four more to
   * come, which is the only thing anybody asks out loud. Zero on a photograph.
   */
  readonly index: number;
  readonly total: number;
  /**
   * Which slide of a split message this is, 1-based, and how many it takes.
   * `1 of 1` for a message that fits on one, which is most of them.
   */
  readonly part: number;
  readonly parts: number;
  /** The words on screen now — one part of a message — or null. */
  readonly kudo: KudoView | null;
  /**
   * The longest *slide* in the set, in characters.
   *
   * The Desktop sets every message at one size and the size that works is the
   * one the longest needs, but a surface only ever holds the slide it is
   * showing and cannot find that out by looking. It is a slide rather than a
   * whole message now that long messages are split, which is most of why the
   * type got bigger.
   */
  readonly longest: number;
  /** The photograph on screen now, during the run. Null otherwise. */
  readonly photo: string | null;
  /**
   * Every photograph this phase will need, in the order it will need them.
   *
   * The run sends the whole list even though it shows one at a time, because
   * the Desktop preloads them and only ever displays what has decoded — a
   * key whose asset row is missing has to leave the previous photograph up
   * rather than draw a broken-image glyph in front of the room. Fetching one
   * per slide would also put a four-second cadence on the network.
   */
  readonly photos: readonly string[];
  readonly seconds: number;
  readonly music: string | null;
  readonly line: string | null;
  /** The console's Auto / Manual, and its slider in seconds per photograph. */
  readonly auto: boolean;
  readonly autoSeconds: number;
  /**
   * When this slide advances itself, in server time, or null in manual and
   * anywhere outside the run. On the wire so a surface can draw the wait and
   * so a reload lands where the room already is.
   */
  readonly advanceAt: number | null;
  /** Host only. The reason the console can skip one without anybody knowing. */
  readonly next?: KudoView | null;
}

export interface RenderState {
  readonly sid: string;
  readonly title: string;
  /** Under the title in the lobby. Null when the session set none. */
  readonly subtitle: string | null;
  readonly phase: SessionPhase;
  readonly segment: Segment;
  readonly seal: Seal;
  /**
   * Practice: the games run and nothing they score reaches the board.
   *
   * On the wire to *everyone*, not just the host. A room that thinks a round
   * counted and finds later that it did not has been lied to by omission, and
   * the fix is not a briefing — it is a word on the screen they are already
   * looking at.
   */
  readonly practice: boolean;
  /**
   * The send-off, when the room is in one.
   *
   * Carries only what the surface being drawn is allowed to know. The host's
   * projection includes the *next* message; nobody else's does — see
   * docs/sendoff.md for why a host who can read ahead can skip one quietly.
   */
  readonly sendoff?: SendoffView;
  readonly holding: { title: string; line: string } | null;
  readonly roster: readonly RosterEntry[];
  readonly joinsLocked: boolean;
  /** Top five, or empty while sealed. */
  readonly standings: readonly StandingRow[];
  /** Participant only, and only while not sealed. */
  readonly own?: OwnPoints;
  /**
   * Host and screen only. The screen puts the join URL and a QR on the lobby,
   * so it needs the code; a participant has already used it.
   */
  readonly joinCode?: string;
  /** Every surface needs the activity list to label a breakdown. */
  readonly activities: readonly ActivitySummary[];
  /** Absent until a question set is loaded. Projected per role: {@link TriviaView}. */
  readonly trivia?: TriviaView;
  /** Participant only, and only while a question set is loaded. */
  readonly triviaMine?: TriviaMine;
  /** Absent until `enterArcade`. Projected per role: {@link ArcadeView}. */
  readonly arcade?: ArcadeView;
  /** Participant only, and only inside the arcade. */
  readonly arcadeMine?: ArcadeMine;
  /** Host only. */
  readonly hostExtras?: {
    readonly joinCode: string;
    readonly participantCount: number;
    readonly awayCount: number;
    /** The full grid, unsealed — the host cannot run the session blind. */
    readonly scores: readonly ScoreRow[];
    readonly spots: readonly {
      readonly seq: number;
      readonly pid: ParticipantId;
      readonly activityId: string;
      readonly reason: string;
    }[];
    /**
     * Per-participant answer state, which ARCHITECTURE gives the host and
     * nobody else. *Who* has answered, never *what* they answered: the
     * console's job is to decide whether to wait, and a grid of choices would
     * be the answer key on a screen the host sometimes shares by accident.
     */
    readonly trivia?: {
      readonly answeredBy: readonly ParticipantId[];
      /** How many questions are loaded. Zero means the CSV has not landed. */
      readonly loaded: number;
    };
    /**
     * The arcade in full: who is where, who is backing whom, and every
     * number. The console is the only surface that may hold all of it,
     * because the host is running the round and settling the score.
     */
    readonly arcade?: {
      /**
       * Who has committed at whatever is open — an item in Recruitment, the
       * step on the bridge in the Glass Bridge. *Who*, never *what*: this is
       * a list of pids and it stays one, because on the bridge the answer to
       * "what" is the answer to the round. The console's job is to decide
       * whether to advance or wait.
       */
      readonly answeredBy: readonly ParticipantId[];
      readonly drained: readonly ParticipantId[];
      /** pid -> the pid they are backing. */
      readonly backing: Readonly<Record<ParticipantId, ParticipantId>>;
      readonly banked: Readonly<Record<ParticipantId, number>>;
      readonly totals: Readonly<Record<ParticipantId, number>>;
      /** Plan / Apply only. pid -> resources applied. */
      readonly resources: Readonly<Record<ParticipantId, number>>;
    };
  };
}

export type ServerMessage =
  | {
      t: "welcome";
      role: Role;
      sid: string;
      pid?: ParticipantId;
      rejoinToken?: string;
      serverTime: number;
      protocol: number;
    }
  | { t: "refused"; reason: RefusedReason; message: string }
  | { t: "state"; seq: number; state: RenderState }
  | { t: "roster"; seq: number; roster: readonly RosterEntry[] }
  | { t: "seal"; seq: number; state: Seal }
  | { t: "toast"; seq: number; kind: "spot" | "text"; text: string }
  | { t: "ack"; cid: string; applied: boolean }
  | {
      t: "refusedCmd";
      cid: string;
      code: string;
      message: string;
    }
  | { t: "pong"; t0: number; t1: number };

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parse a client frame. Returns null for anything malformed.
 *
 * Everything arriving on a socket is untrusted: this is the only place that
 * turns bytes into a typed message, and it never throws.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof m[k] === "string" ? (m[k] as string) : null;

  switch (m["t"]) {
    case "hello": {
      if (m["role"] === "participant") {
        const joinCode = str("joinCode");
        const nickname = str("nickname");
        if (joinCode === null || nickname === null) return null;
        const rejoinToken = str("rejoinToken");
        return rejoinToken !== null
          ? { t: "hello", role: "participant", joinCode, nickname, rejoinToken }
          : { t: "hello", role: "participant", joinCode, nickname };
      }
      if (m["role"] === "host") {
        const hostToken = str("hostToken");
        return hostToken === null ? null : { t: "hello", role: "host", hostToken };
      }
      if (m["role"] === "screen") {
        const screenToken = str("screenToken");
        return screenToken === null
          ? null
          : { t: "hello", role: "screen", screenToken };
      }
      return null;
    }
    case "resync":
      return { t: "resync" };
    case "ping":
      return typeof m["t0"] === "number" ? { t: "ping", t0: m["t0"] } : null;
    case "trivia.answer": {
      const cid = str("cid");
      const index = m["index"];
      const choice = m["choice"];
      // Non-negative integers or nothing. The engine refuses an out-of-range
      // choice as well, but a fractional index that reached the boundary's
      // `===` comparison would simply never match, which is a silent drop.
      if (
        cid === null ||
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        typeof choice !== "number" ||
        !Number.isInteger(choice) ||
        choice < 0
      ) {
        return null;
      }
      return { t: "trivia.answer", cid, index, choice };
    }
    case "arcade.answer": {
      const cid = str("cid");
      const answer = str("answer");
      const item = m["item"];
      if (
        cid === null ||
        answer === null ||
        typeof item !== "number" ||
        !Number.isInteger(item) ||
        item < 0
      ) {
        return null;
      }
      // Bounded here rather than in the engine: a megabyte of "answer" is a
      // socket problem, not a game rule. The fold happens on the server.
      return { t: "arcade.answer", cid, item, answer: answer.slice(0, 64) };
    }
    case "arcade.tap": {
      const cid = str("cid");
      const round = m["round"];
      if (
        cid === null ||
        typeof round !== "number" ||
        !Number.isInteger(round) ||
        round < 0
      ) {
        return null;
      }
      return { t: "arcade.tap", cid, round };
    }
    case "arcade.step": {
      const cid = str("cid");
      const round = m["round"];
      const step = m["step"];
      const choice = m["choice"];
      // Non-negative integers or nothing, and `choice` is one of exactly two
      // panes. The engine refuses an out-of-range choice as well; refusing it
      // here keeps a fractional index off a `===` comparison that would
      // otherwise never match, which is a silent drop rather than an error.
      const nat = (v: unknown): boolean =>
        typeof v === "number" && Number.isInteger(v) && v >= 0;
      if (cid === null || !nat(round) || !nat(step) || !nat(choice)) return null;
      return {
        t: "arcade.step",
        cid,
        round: round as number,
        step: step as number,
        choice: choice as number,
      };
    }
    case "arcade.shape": {
      const cid = str("cid");
      const round = m["round"];
      const shape = m["shape"];
      const SHAPES: readonly UnsealShape[] = [
        "circle",
        "triangle",
        "star",
        "umbrella",
      ];
      if (
        cid === null ||
        typeof round !== "number" ||
        !Number.isInteger(round) ||
        round < 0 ||
        !SHAPES.includes(shape as UnsealShape)
      ) {
        return null;
      }
      return { t: "arcade.shape", cid, round, shape: shape as UnsealShape };
    }
    case "arcade.letter": {
      const cid = str("cid");
      const round = m["round"];
      const letter = str("letter");
      if (
        cid === null ||
        letter === null ||
        typeof round !== "number" ||
        !Number.isInteger(round) ||
        round < 0
      ) {
        return null;
      }
      // Bounded here rather than in the engine, exactly as `arcade.answer` is:
      // a megabyte of "letter" is a socket problem and not a game rule. The
      // engine takes the first letter of what arrives and refuses the frame if
      // that letter is not on this player's own tin.
      return { t: "arcade.letter", cid, round, letter: letter.slice(0, 8) };
    }
    case "arcade.docs":
    case "arcade.beat": {
      const cid = str("cid");
      const round = m["round"];
      if (
        cid === null ||
        typeof round !== "number" ||
        !Number.isInteger(round) ||
        round < 0
      ) {
        return null;
      }
      return { t: m["t"] as "arcade.docs" | "arcade.beat", cid, round };
    }
    case "arcade.back": {
      const cid = str("cid");
      const pid = str("pid");
      return cid === null || pid === null ? null : { t: "arcade.back", cid, pid };
    }
    case "host.cmd": {
      const cid = str("cid");
      if (cid === null) return null;
      return { t: "host.cmd", cid, cmd: parseHostCommand(m["cmd"]) };
    }
    default:
      return null;
  }
}

function parseHostCommand(v: unknown): HostCommand | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  const name = c["name"];
  const str = (k: string): string | null =>
    typeof c[k] === "string" ? (c[k] as string) : null;

  // `sendoff` belongs here for the same reason every other segment does: this
  // list is what a `segment` frame is checked against, and a segment missing
  // from it is a segment the console cannot reach at all.
  const SEGMENTS: readonly Segment[] = [
    "lobby", "holding", "sendoff", "trivia", "arcade", "standings", "final",
  ];
  const SEALS: readonly Seal[] = ["live", "sealed", "revealed"];

  switch (name) {
    case "open":
      return { name: "open" };
    case "start":
      return { name: "start" };
    case "close":
      return { name: "close" };
    case "session.reopen":
      return { name: "session.reopen" };
    case "session.restart": {
      // No default. A restart with no `confirm` is a restart nobody typed, and
      // the frame is refused here rather than turned into an event the server
      // then has to second-guess. Whether the string is the *right* join code
      // is the server's question — this file has no session to compare it to.
      const confirm = str("confirm");
      return confirm === null ? null : { name: "session.restart", confirm };
    }
    case "segment": {
      const kind = c["kind"];
      return SEGMENTS.includes(kind as Segment)
        ? { name: "segment", kind: kind as Segment }
        : null;
    }
    case "holding": {
      const title = str("title");
      const line = str("line");
      return title !== null && line !== null
        ? { name: "holding", title, line }
        : null;
    }
    case "seal": {
      const st = c["state"];
      return SEALS.includes(st as Seal) ? { name: "seal", state: st as Seal } : null;
    }
    case "practice":
      return typeof c["on"] === "boolean" ? { name: "practice", on: c["on"] } : null;
    case "sendoff.next":
      return { name: "sendoff.next" };
    case "sendoff.back":
      return { name: "sendoff.back" };
    case "sendoff.auto":
      return typeof c["auto"] === "boolean" ? { name: "sendoff.auto", auto: c["auto"] } : null;
    case "sendoff.speed":
      // Range-checked in the engine, which is the only place that may decide
      // what the slider means. This asks only whether it is a number at all.
      return typeof c["seconds"] === "number" && Number.isFinite(c["seconds"])
        ? { name: "sendoff.speed", seconds: c["seconds"] }
        : null;
    case "lobby.lock":
      return typeof c["locked"] === "boolean"
        ? { name: "lobby.lock", locked: c["locked"] }
        : null;
    case "participant.kick": {
      const pid = str("pid");
      return pid === null ? null : { name: "participant.kick", pid };
    }
    case "participant.release": {
      const pid = str("pid");
      return pid === null ? null : { name: "participant.release", pid };
    }
    case "score.set": {
      const activityId = str("activityId");
      const pid = str("pid");
      const raw = c["raw"];
      // Finite and non-negative is the engine's rule too; refusing here keeps
      // a NaN off the wire rather than relying on the reducer to catch it.
      return activityId !== null &&
        pid !== null &&
        typeof raw === "number" &&
        Number.isFinite(raw) &&
        raw >= 0
        ? { name: "score.set", activityId, pid, raw }
        : null;
    }
    case "score.status": {
      const activityId = str("activityId");
      const pid = str("pid");
      const st = c["status"];
      const OK: readonly ScoreStatus[] = ["played", "bench", "unset"];
      return activityId !== null && pid !== null && OK.includes(st as ScoreStatus)
        ? { name: "score.status", activityId, pid, status: st as ScoreStatus }
        : null;
    }
    case "spot.grant": {
      const pid = str("pid");
      const activityId = str("activityId");
      const reason = str("reason");
      return pid !== null && activityId !== null && reason !== null
        ? { name: "spot.grant", pid, activityId, reason }
        : null;
    }
    case "spot.revoke": {
      const seq = c["seq"];
      return typeof seq === "number" && Number.isInteger(seq)
        ? { name: "spot.revoke", seq }
        : null;
    }
    case "trivia.open":
      // Explicit, never defaulted: "sudden death was off, wasn't it?" is not a
      // question anyone should be asking after the question is on the wall.
      return typeof c["suddenDeath"] === "boolean"
        ? { name: "trivia.open", suddenDeath: c["suddenDeath"] }
        : null;
    case "trivia.close":
      return { name: "trivia.close" };
    case "trivia.reveal":
      return { name: "trivia.reveal" };
    case "trivia.next":
      return { name: "trivia.next" };
    case "arcade.enter":
      return { name: "arcade.enter" };
    case "arcade.round": {
      // Positive integers only, and per variant. A zero-second item and a
      // target of zero are both rounds that end before they start.
      const int = (k: string): number | null => {
        const v = c[k];
        return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
      };
      if (c["kind"] === "recruitment") {
        const secondsPerItem = int("secondsPerItem");
        return secondsPerItem === null
          ? null
          : { name: "arcade.round", kind: "recruitment", secondsPerItem };
      }
      if (c["kind"] === "plan_apply") {
        const target = int("target");
        const seconds = int("seconds");
        return target === null || seconds === null
          ? null
          : { name: "arcade.round", kind: "plan_apply", target, seconds };
      }
      if (c["kind"] === "glass_bridge") {
        // Exactly three, in wave order, each above zero. A wave with a
        // zero-second step is a wave that is drained for not answering a
        // question it was never shown.
        const ws = c["waveSeconds"];
        if (!Array.isArray(ws) || ws.length !== 3) return null;
        if (!ws.every((v) => typeof v === "number" && Number.isInteger(v) && v > 0)) {
          return null;
        }
        return {
          name: "arcade.round",
          kind: "glass_bridge",
          waveSeconds: [ws[0], ws[1], ws[2]] as WaveSeconds,
        };
      }
      if (c["kind"] === "unseal") {
        const seconds = int("seconds");
        return seconds === null
          ? null
          : { name: "arcade.round", kind: "unseal", seconds };
      }
      if (c["kind"] === "tug_of_raft") {
        // No seed. It is drawn at the socket boundary — a seed a console
        // could choose is a console that can deal itself the sides.
        const pulls = int("pulls");
        const pullSeconds = int("pullSeconds");
        const bpm = int("bpm");
        return pulls === null || pullSeconds === null || bpm === null
          ? null
          : {
              name: "arcade.round",
              kind: "tug_of_raft",
              pulls,
              pullSeconds,
              bpm,
            };
      }
      // Gganbu is designed but not built. Refusing the frame is how the
      // console finds that out, rather than a round that starts and does
      // nothing.
      return null;
    }
    case "arcade.begin":
      return { name: "arcade.begin" };
    case "arcade.next":
      return { name: "arcade.next" };
    case "arcade.nextStep":
      return { name: "arcade.nextStep" };
    case "arcade.nextWave":
      return { name: "arcade.nextWave" };
    case "arcade.nextPull":
      return { name: "arcade.nextPull" };
    case "arcade.end":
      return { name: "arcade.end" };
    case "arcade.reveal":
      return { name: "arcade.reveal" };
    default:
      return null;
  }
}
