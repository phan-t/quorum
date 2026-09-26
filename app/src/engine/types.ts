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
  | "sendoff"
  | "final";

/* ------------------------------------------------------------------ */
/* The send-off                                                        */
/* ------------------------------------------------------------------ */

/**
 * Where the send-off has got to.
 *
 * `closing` is a photo montage and a line; `done` is a real state rather than
 * an absence — the last message having been read is not the same as the
 * segment never having started, and the Desktop shows something different for
 * each.
 *
 * `title` is the Farewell card, and it is a real state rather than the first
 * frame of the montage: it holds until the host presses, so the room reads
 * the name before anything moves. `run` is the single interleaved sequence of
 * photographs and messages — see engine/sendoff.ts for how it is dealt.
 */
export type SendoffPhase = "title" | "run" | "closing" | "done";

/**
 * One frame of the run.
 *
 * A kudo slide carries the index of the message in `content.kudos` rather
 * than its text, and which part of it this is. The text is derived by
 * `partsOf` wherever it is needed, which keeps the split in one place and
 * keeps every message out of the state a second time.
 */
export type SendoffSlide =
  | { readonly kind: "photo"; readonly key: string }
  | {
      readonly kind: "kudo";
      readonly at: number;
      readonly part: number;
      readonly parts: number;
    };

/** One message. No photo: see docs/sendoff.md — they are not paired. */
export interface Kudo {
  readonly from: string;
  readonly message: string;
}

/**
 * The content of a send-off, as the engine holds it.
 *
 * Photos are **keys, not bytes**. The images live in their own store rows,
 * served over HTTP the way the promo card is, and only their keys travel
 * through state — a snapshot is replayed and broadcast, and seven megabytes of
 * JPEG has no business in either.
 */
export interface SendoffContent {
  readonly name: string;
  readonly subtitle: string | null;
  readonly opening: {
    readonly photos: readonly string[];
    readonly seconds: number;
    /** A key, or null. Off unless the file says otherwise — see the note. */
    readonly music: string | null;
  };
  readonly kudos: readonly Kudo[];
  readonly closing: {
    readonly photos: readonly string[];
    readonly line: string | null;
  };
}

export interface SendoffState {
  readonly content: SendoffContent;
  readonly phase: SendoffPhase;
  /**
   * The dealt sequence of photographs and messages. Built once by
   * `buildPlan` when the content loads, from a seed drawn at the socket
   * boundary, and never rebuilt — a plan that changed under a reload would
   * show the room a photograph it had already seen.
   */
  readonly plan: readonly SendoffSlide[];
  /** Index into `plan`. Meaningful only while `phase` is `run`. */
  readonly at: number;
  /**
   * Whether the run advances itself. Off at the title card whatever this
   * says: the room reads the name on a press, never on a timer.
   *
   * The host turns it on and off mid-run from the console, because the two
   * modes are wanted at different moments of the same segment — photographs
   * play themselves and a message is read aloud.
   */
  readonly auto: boolean;
  /**
   * Seconds a photograph holds under auto-advance. The console's slider.
   *
   * A message holds longer, scaled by its length — see `slideMs`. One
   * control rather than two, because a host setting two numbers in front of
   * a room is a host not watching the room.
   */
  readonly autoSeconds: number;
  /**
   * When the current slide arrived, so a surface joining late can place
   * itself in the run rather than restarting it. Null outside `run`.
   */
  readonly slideAt: number | null;
}

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
  /**
   * A tiebreak question: **not part of the scored set**.
   *
   * SCORING.md settles a tie with sudden death — "one question, first correct
   * answer wins, no points" — and a question that scores nothing must not also
   * be one of the twenty that do. `loadTrivia` lifts every flagged question out
   * of `questions` and into {@link TriviaState.tiebreakers}, so a file of 23
   * rows with three flagged is a twenty-question game with three tiebreakers
   * behind it.
   *
   * Optional, and false by omission on almost every question. A file that
   * flags none is the ordinary case, and sudden death then draws on the
   * built-in pool instead — see engine/tiebreak.ts.
   */
  readonly tiebreak?: boolean;
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
  /**
   * Index into `questions` of the **scored question in play**.
   *
   * While a sudden death is running there is no scored question in play, and
   * this says so by pointing past the end of the set: a tiebreaker is not one
   * of the twenty and does not have a place among them. The index the host
   * will come back to is parked in {@link tiebreakHeld}.
   *
   * That is not only bookkeeping. Every projection built before the tiebreak
   * pool existed reads `questions[at]` for "the question in play"; left
   * pointing at the next scored question, such a projection would put that
   * question's text on every phone during a tiebreak, judge the taps against
   * a different question, and read its answer and its note out at the reveal —
   * destroying a question that had not been asked yet. Out of range, the same
   * projection finds nothing and shows nothing, which is the safe way to be
   * wrong. Anything that wants the question in play calls `currentQuestion`.
   */
  readonly at: number;
  readonly phase: QuestionPhase;
  /** Absolute server epochs, never durations. Null unless `phase` is open. */
  readonly opensAt: number | null;
  readonly closesAt: number | null;
  /**
   * Questions held back for sudden death, in the order they will be asked.
   *
   * Separate from `questions` because SCORING.md's sudden death "scores
   * nothing" and a question that scores nothing cannot also be one of the
   * twenty that do. Before this existed, sudden death was a *mode* on the
   * question the set happened to be sitting on: it consumed a scored question,
   * it could not be run once the set was exhausted, and running one mid-set
   * meant that question was never asked for points.
   *
   * Filled from the questions flagged {@link Question.tiebreak} in the loaded
   * file, from an explicit pool on `loadTrivia`, or — when the file carries
   * neither, which is the ordinary case — from the built-in pool, so that a
   * host can always settle a tie without a coin flip.
   */
  readonly tiebreakers: readonly Question[];
  /**
   * Index into `tiebreakers` of the sudden death **in play**. Meaningful only
   * while `suddenDeath` is true.
   */
  readonly tiebreakAt: number;
  /**
   * How many tiebreakers have been spent. Bumped when a sudden death opens,
   * not when it closes: a question the room has heard is spent whether or not
   * anybody got it, and asking it twice would be asking a question the answer
   * to which has already been shouted.
   *
   * Two fields rather than one index plus an off-by-one, because an off-by-one
   * here is a question revealed to thirty people.
   */
  readonly tiebreakUsed: number;
  /**
   * Where the scored set was when the sudden death interrupted it, put aside
   * to be handed back when the tiebreak is cleared.
   *
   * A tiebreak does not move `at`, so without this the set comes back from one
   * in phase `idle` — and `idle` on a question that has already been asked,
   * settled and written to `scores` is a question the host can open a second
   * time, scoring it twice. It also keeps that question's answers, which the
   * big screen draws its distribution from and which the tiebreak would
   * otherwise overwrite with its own.
   *
   * Null except while a sudden death is in play.
   */
  readonly tiebreakHeld: {
    /** The scored question the host will come back to. */
    readonly at: number;
    readonly phase: QuestionPhase;
    readonly answers: Readonly<Record<ParticipantId, TriviaAnswer>>;
  } | null;
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
  /**
   * A second line under the title, for the things that are not the name.
   *
   * A date belongs here rather than in `title`: the title is what the session
   * *is* and gets set in display type across the Desktop, and a title with
   * the date welded onto it, set at that size, is a name with an
   * administrative detail welded onto it. Null on a session that does not
   * want one. Nothing in the engine reads it.
   */
  readonly subtitle: string | null;
  readonly joinCode: string;
  readonly phase: SessionPhase;
  readonly segment: Segment;
  readonly seal: Seal;
  /**
   * Practice: the games run, and nothing they score reaches the board.
   *
   * SPEC assumes a room that knows the rules. A room meeting Red Light, Green
   * Light for the first time does not, and the first run of a game is spent
   * learning that a tap during APPLY drains you — which is a lesson worth
   * having and a terrible thing to be scored on. So a round can be run once
   * for real, in the sense that everything happens, and once for keeps.
   *
   * It gates exactly one thing: {@link withActivityTotals}, the single funnel
   * both trivia and the arcade use to move an activity's totals onto the
   * board. The activity still computes its totals and still shows them on the
   * reveal — "this is what you would have scored" is the whole point of a
   * practice run — and `scores`, and therefore standings, do not move.
   *
   * Deliberately *not* gated: `setScore` and `setStatus`. Those are the host
   * typing a number in, for the TTX and for bench credit, and a host who does
   * that during a practice round meant it.
   */
  readonly practice: boolean;
  /** Null until a send-off is loaded. Not every event has one. */
  readonly sendoff: SendoffState | null;
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
  | { readonly kind: "plan_apply"; readonly target: number; readonly seconds: number }
  | {
      readonly kind: "unseal";
      /** The tins. Carries the answers — see {@link UnsealItem}. */
      readonly items: readonly UnsealItem[];
      /** How long the Floor runs. SPEC.md: sixty seconds. */
      readonly seconds: number;
    }
  | {
      readonly kind: "tug_of_raft";
      /** SPEC.md: three pulls, sides reshuffled between them. */
      readonly pulls: number;
      /** Seconds per pull. SPEC.md: 25. */
      readonly pullSeconds: number;
      /** The heartbeat. SPEC.md: 100 bpm, which is a beat every 600 ms. */
      readonly bpm: number;
      /**
       * The seed the **first** pull's sides are dealt from.
       *
       * Drawn at the socket boundary, exactly as Plan / Apply's light
       * durations are: the engine has no randomness, and "reshuffled by seed
       * before each of three pulls" is SPEC.md's own phrasing. Pulls two and
       * three get their seeds on `nextPull`.
       */
      readonly seed: number;
    }
  | {
      readonly kind: "gganbu";
      /** Six Over/Under prompts. Carries the answers — see {@link OverUnderItem}. */
      readonly prompts: readonly OverUnderItem[];
      /** SPEC.md: fifteen seconds a prompt. */
      readonly secondsPerPrompt: number;
      /** SPEC.md: "You each hold ten Vault tokens." */
      readonly startTokens: number;
      /** The seed the pairs are drawn from. Boundary-drawn, as above. */
      readonly seed: number;
    }
  | {
      readonly kind: "glass_bridge";
      /** Six steps, two panes each. Carries the answers — see {@link GlassStep}. */
      readonly steps: readonly GlassStep[];
      /** Seconds per step for waves 1, 2 and 3. SPEC.md tunes them to 12 / 9 / 6. */
      readonly waveSeconds: WaveSeconds;
    };

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

/* ------------------------------------------------------------------ */
/* Round 2 — Unseal                                                    */
/* ------------------------------------------------------------------ */

/**
 * The four tins. SPEC.md: "○ △ ☆ ☂ … the shapes are word lengths."
 *
 * Circle is a four- or five-letter term, triangle six, star eight, umbrella
 * eleven or more. The shape is picked **before** the word is known, which is
 * the whole conceit, and which is why {@link UnsealTin} does not reach a phone
 * until the Floor opens.
 */
export type UnsealShape = "circle" | "triangle" | "star" | "umbrella";

/**
 * One tin, as content: the scrambled letters, the word inside, and the line
 * the reveal reads out.
 *
 * `cue` is a permutation of `answer` with the letters spaced — "S I P G O S"
 * for GOSSIP — and is the only half a player ever sees. `answer` is the
 * answer, and is split away from `cue` at `startRound` for the same reason a
 * glass pane's `real` is: see {@link UnsealTin} and {@link UnsealAnswer}.
 */
export interface UnsealItem {
  readonly shape: UnsealShape;
  readonly cue: string;
  readonly answer: string;
  readonly note: string;
}

/**
 * The half of a tin a player may see once they are holding it: the shape they
 * picked, the scrambled letters, and how many there are.
 *
 * Not the word. A projection handed one of these cannot leak the round,
 * however carelessly it spreads the object.
 */
export interface UnsealTin {
  readonly shape: UnsealShape;
  readonly cue: string;
  readonly length: number;
}

/** The other half: the word, and the reveal note. Both are the answer. */
export interface UnsealAnswer {
  readonly answer: string;
  readonly note: string;
}

/* ------------------------------------------------------------------ */
/* Round 4 — Gganbu                                                    */
/* ------------------------------------------------------------------ */

/** A wager's side. "Vagrant's first release — over or under 2011?" */
export type OverUnder = "over" | "under";

/**
 * One Over/Under prompt, as content.
 *
 * `verify` is the trivia bank's ⚠️ VERIFY discipline, carried in the data
 * rather than in a comment so that a test can hold the count and the host
 * console can show the flag. SPEC.md: "three are flagged VERIFY exactly as the
 * trivia bank flags dates". It travels with the *answer*, never with the
 * prompt: which prompts the author was least sure of is not something a
 * player needs, and a flag beside a question is a nudge.
 */
export interface OverUnderItem {
  /** "Vagrant's first public release". Shown with the threshold. */
  readonly cue: string;
  /** "2011". Shown. */
  readonly threshold: string;
  /** **The answer.** */
  readonly answer: OverUnder;
  /** Read out at the reveal, with the real figure in it. */
  readonly note: string;
  /** Checked before the session, or not. */
  readonly verify: boolean;
}

/** The half of a prompt that may be shown: the question, and nothing else. */
export interface GganbuPrompt {
  readonly cue: string;
  readonly threshold: string;
}

/** The other half. Everything here is the answer. */
export interface GganbuAnswer {
  readonly answer: OverUnder;
  readonly note: string;
  readonly verify: boolean;
}

/**
 * One player's secret call on the open prompt.
 *
 * Secret until the prompt settles, and that is the round's whole leak: both
 * halves of a pair answer the same prompt, so a rival's wager — never mind
 * their token count moving — is the answer arriving early. See
 * {@link ArcadePlay} and `gganbuMeView`.
 */
export interface Wager {
  readonly pick: OverUnder;
  /** One to five tokens, and never more than they hold. */
  readonly amount: number;
}

/**
 * Round 5, The Glass Bridge: one pane. A real HashiCorp feature, or an
 * invented one.
 *
 * `note` is the reveal line, and for a fake it says *why* it is fake. Both
 * fields together with the step's `real` index are the answer, which is why
 * `note` never travels with the label once a round starts: see
 * {@link GlassBoardStep} and {@link GlassAnswer}.
 */
export interface GlassPane {
  readonly label: string;
  readonly note: string;
}

/**
 * One step of the bridge, as content: two panes for one product, one of them
 * real.
 *
 * Both panes are the same product on purpose. SPEC.md: the pairs are
 * "re-paired **within a product**", so the step is never won by recognising
 * the vendor's product line — only by knowing the feature.
 */
export interface GlassStep {
  /** "Vault". Shown with the step; identical for both panes, so it is safe. */
  readonly product: string;
  readonly panes: readonly [GlassPane, GlassPane];
  /** Index of the pane that is a real feature. **The answer.** */
  readonly real: 0 | 1;
}

/**
 * The half of a step that may be shown to a player who has not stepped yet:
 * the product and the two labels, in display order, and nothing else.
 *
 * This type exists so that the answer is not merely *withheld* by the
 * projection but absent from the value the projection is given. A projection
 * that spreads a whole step object leaks the round; a projection that spreads
 * a whole `GlassBoardStep` cannot.
 */
export interface GlassBoardStep {
  readonly product: string;
  readonly labels: readonly [string, string];
}

/**
 * The other half: which pane holds, and both reveal notes.
 *
 * Everything in here is the answer. It stays in `ArcadePlay.key` and must not
 * reach any phone before the reveal — including the phone of a player who has
 * already fallen, who is sitting next to somebody who has not.
 */
export interface GlassAnswer {
  readonly real: 0 | 1;
  readonly notes: readonly [string, string];
}

/** Which wave a player crosses in. Wave 1 goes blind. */
export type GlassWave = 1 | 2 | 3;

/** Seconds per step, for waves 1, 2 and 3 in that order. */
export type WaveSeconds = readonly [number, number, number];

/**
 * Where a person is this round.
 *
 * `drained` is not elimination and lasts exactly one round — SPEC is emphatic
 * about both. The Lounge is where a drained player goes, and they are still
 * scoring there, which is the whole design.
 */
export type ArcadeStanding = "floor" | "drained";

/**
 * One person's bet on somebody else's round.
 *
 * Every drained player has a seat, with or without a bet in it. On the Glass
 * Bridge a player who is still on the Floor can hold one too — a wave waiting
 * its turn backs the wave in front of it — which is why the seat records
 * where the bet was placed from as well as who it names.
 */
export interface LoungeSeat {
  /** Who they are backing, changeable until the Floor locks. */
  readonly backing: ParticipantId | null;
  /**
   * The instant they were drained, for the big screen's ordering. Null for a
   * seat taken from the Floor by a wave that has not crossed yet, because
   * they have not been drained and may never be.
   */
  readonly at: number | null;
  /**
   * When the bet now held was placed. Null while there is no bet.
   *
   * A bet is only paid if it predates the outcome it names: the Floor of a
   * round is a public surface, and without this a player drained early can
   * read who crossed off the big screen and back them for a certainty. See
   * `betStands` in arcade.ts.
   */
  readonly placedAt: number | null;
  /**
   * Where the backer stood when they placed it. `floor` is a waiting wave on
   * the Bridge, which is paid at the lower rate — they are being paid for
   * this round twice, once by their own crossing.
   */
  readonly placedFrom: ArcadeStanding;
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
       * bonus — which is per item, not per round: three bonuses on each of
       * seven items is what makes the Floor max 7 × 15 = 105. Cleared by
       * `nextItem`.
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
      /**
       * When the APPLY in force began — or, while the light is PLAN, when the
       * APPLY that *preceded* this PLAN began. Null until the first lock.
       *
       * One window of history, and one is enough: a tap's corrected instant is
       * at most 250 ms behind the frame that carried it, and a light lasts at
       * least two seconds, so a tap can only ever fall in the window that is
       * running or the one immediately before it. It exists because a tap has
       * to be judged against the light that was showing *at the corrected
       * instant*, not against whatever the light happens to be by the time the
       * frame lands — see `tap` in reducer.ts.
       */
      readonly applySince: number | null;
      /** Resources tapped, per player. The finish line is `target`. */
      readonly resources: Readonly<Record<ParticipantId, number>>;
      readonly target: number;
      /** How long the Floor runs once `beginPlay` starts the clock. */
      readonly seconds: number;
      /** Who has crossed, in order, for the +15/+10/+5. */
      readonly finishOrder: readonly ParticipantId[];
      /**
       * When each crossing landed. Absolute epoch, never a duration.
       *
       * The order is what the bonuses are paid from; the instants are what
       * the Lounge is judged against, because a bet placed after its runner
       * was already across is not a bet. See `betStands` in arcade.ts.
       */
      readonly finishedAt: Readonly<Record<ParticipantId, number>>;
    }
  | {
      readonly kind: "unseal";
      /**
       * What may be shown: shape, scrambled letters, length. Deliberately
       * separate from {@link key} — see {@link UnsealTin}.
       *
       * Note that this is not public *state*: a tin reaches one phone, the
       * phone of the player holding it, and not before the Floor opens.
       * Publishing the list during the round card would tell the room which
       * word sits behind each shape, and SPEC.md's whole conceit is "pick your
       * shape before you know the word". `unsealMeView` is the only way out.
       */
      readonly tins: readonly UnsealTin[];
      /**
       * **The answer key**, index-aligned with {@link tins}. The words, and
       * the reveal notes. Nothing here reaches any phone before `revealRound`.
       */
      readonly key: readonly UnsealAnswer[];
      readonly seconds: number;
      /**
       * Which tin each player holds, as an index into {@link tins}. Written
       * when they pick a shape; a tier with more than one word hands them out
       * by arcade player number, so that two people sitting together are not
       * unscrambling the same word.
       */
      readonly pick: Readonly<Record<ParticipantId, number>>;
      /**
       * Letters tapped in order, per player. The *count*, never the letters:
       * the letters would be the prefix of the answer, on a screen the room
       * can see.
       */
      readonly progress: Readonly<Record<ParticipantId, number>>;
      /** Who pressed **Read the docs**. Their Floor score for the round halves. */
      readonly docs: Readonly<Record<ParticipantId, true>>;
      /**
       * Whose tin is cracked: they have had one wrong letter, and the next one
       * shatters it.
       *
       * The round is two strikes. A cracked tin is damaged rather than gone —
       * the player keeps tapping and can still get their word out — and what
       * the damage costs is the same halving {@link docs} costs, charged once
       * however the tin came to be damaged. See `unsealFloorPoints`.
       *
       * A flag and not a count, because there is nothing after the second
       * strike to count towards: the second wrong letter drains the player and
       * the Lounge takes over from here.
       */
      readonly cracked: Readonly<Record<ParticipantId, true>>;
      /** Time from the Floor opening to the tin coming open, in ms. */
      readonly unsealedMs: Readonly<Record<ParticipantId, number>>;
      /** Who unsealed, in the order they did it. Ties in `unsealedMs` break here. */
      readonly unsealOrder: readonly ParticipantId[];
    }
  | {
      readonly kind: "tug_of_raft";
      readonly pulls: number;
      readonly pullSeconds: number;
      /** 60 000 / bpm. Stored derived so every judgement uses one number. */
      readonly beatMs: number;
      /** Which pull is being pulled, from 0. */
      readonly pull: number;
      /** The seed this pull's sides were dealt from. */
      readonly seed: number;
      /**
       * Which side each player is on this pull. Re-dealt every pull, so
       * "nobody is stuck on a losing side" is arithmetic rather than a hope.
       */
      readonly sides: Readonly<Record<ParticipantId, 0 | 1>>;
      readonly pullStartedAt: number;
      readonly pullEndsAt: number;
      /** On-beat taps this pull, per player. The rope is the difference. */
      readonly onBeats: Readonly<Record<ParticipantId, number>>;
      /**
       * The last beat each player hit, as a beat index from the pull's start.
       * −1 until they hit one.
       *
       * This is what an election is derived from rather than stored: three
       * missed beats in a row time a node out, and a stored `electionUntil`
       * would be a second thing for a snapshot to disagree with. See
       * `resolveBeat`.
       */
      readonly lastBeat: Readonly<Record<ParticipantId, number>>;
      /** When each player's last on-beat tap landed. Breaks a leader tie. */
      readonly creditedAt: Readonly<Record<ParticipantId, number>>;
      /** Pulls won, per side. For the big screen, and for nothing else. */
      readonly wins: readonly [number, number];
    }
  | {
      readonly kind: "gganbu";
      /** What may be shown: the cue and the threshold. */
      readonly board: readonly GganbuPrompt[];
      /** **The answer key**, index-aligned with {@link board}. */
      readonly key: readonly GganbuAnswer[];
      readonly at: number;
      readonly secondsPerPrompt: number;
      /** When the current prompt closes. The round's `endsAt` is the last one's. */
      readonly promptEndsAt: number;
      readonly startTokens: number;
      /** Tokens held. Moves **only when a prompt settles** — see `wagers`. */
      readonly tokens: Readonly<Record<ParticipantId, number>>;
      /**
       * Who is paired with whom. Symmetric. A player with no entry is paired
       * with the house, which is what an odd roster and a latecomer both get.
       */
      readonly rivals: Readonly<Record<ParticipantId, ParticipantId>>;
      /**
       * Players who are playing the house because their pair dissolved.
       *
       * SPEC.md: "a rival who disconnects is replaced by the house". Recorded
       * at the instant it happens rather than derived at settlement, because
       * the engine has no clock and a rival who dropped and came back is still
       * a rival who dropped. **Both** halves of the pair are marked, or the
       * two comparisons the +10 is made from can disagree with each other —
       * see `houseThePairOf` in reducer.ts.
       */
      readonly housed: Readonly<Record<ParticipantId, true>>;
      /**
       * Wagers on the **current prompt only**, cleared when it settles.
       *
       * This is the field the round is built around. Both halves of a pair
       * answer the same prompt, so a rival's pick, a rival's stake, or a
       * rival's token count moving mid-prompt are all the answer arriving
       * early. Nothing in here is projected to anybody but its owner, and
       * `tokens` does not move until the prompt closes.
       */
      readonly wagers: Readonly<Record<ParticipantId, Wager>>;
    }
  | {
      readonly kind: "glass_bridge";
      /**
       * What may be shown: product and two labels per step. Deliberately
       * separate from {@link key} — see {@link GlassBoardStep}.
       */
      readonly board: readonly GlassBoardStep[];
      /**
       * **The answer key.** Which pane holds at each step, and both notes.
       *
       * This is the only field in the round that a projection must withhold,
       * and it is the only field it *can* leak: no other field in this
       * variant identifies a pane. Nothing here reaches a phone before
       * `revealRound`, and nothing here reaches the big screen before it
       * either, because the big screen is in the room and the room contains
       * players who have not stepped yet.
       */
      readonly key: readonly GlassAnswer[];
      readonly waveSeconds: WaveSeconds;
      /**
       * The last arcade player number in wave 1, and in wave 2. Stored rather
       * than a per-player map so a latecomer — whose number is necessarily
       * higher than both — lands in wave 3 without anything having to
       * re-run. Waves are "by player number", and this is that sentence.
       */
      readonly waveCuts: readonly [number, number];
      /** Which wave is on the bridge. */
      readonly wave: GlassWave;
      /** 0-based index into `board` for the wave that is crossing. */
      readonly step: number;
      /**
       * The round's own clocks. The wave's start is needed by nothing but the
       * big screen; the step's start is what a decision time is measured
       * from, and the step's end is what closes it. `ArcadeState.endsAt` is
       * the whole round and is far too coarse to judge a step against.
       */
      readonly waveStartedAt: number;
      readonly stepStartedAt: number;
      readonly stepEndsAt: number;
      /**
       * Which pane broke, per step, or null for a step nobody has fallen at.
       *
       * Written **only when a step closes**, never when a player falls. That
       * one-line rule is what keeps wave 1 blind: a pane that broke ten
       * seconds ago is the whole answer, and half the wave is still deciding.
       * By the time an entry is non-null every player who could use it has
       * already stepped past it, so this array is safe to show to everybody —
       * which is exactly what wave 2 and wave 3 are promised.
       */
      readonly broken: readonly (0 | 1 | null)[];
      /**
       * The *current* step only: who has committed, and whether their pane
       * held. Cleared when the step closes.
       *
       * Note what is not here: which pane they picked. It is never stored,
       * because it is never needed — a pane that holds advances the player
       * and a pane that breaks drains them — and because "X stepped and
       * survived" plus X's choice would be the answer, on a screen the whole
       * room can see.
       */
      readonly stepped: Readonly<Record<ParticipantId, boolean>>;
      /** Steps completed, per player. `board.length` means across. */
      readonly position: Readonly<Record<ParticipantId, number>>;
      /**
       * Time spent deciding, summed over every step a player committed, in ms.
       *
       * This is what "the fastest full crossing" is measured with. Wall-clock
       * cannot be: the waves run at 12, 9 and 6 seconds a step and a wave
       * cannot advance before its step closes, so elapsed time would hand the
       * award to wave 3 every time and first-across would hand it to wave 1
       * every time. Six reaction times added up is comparable between waves.
       */
      readonly elapsedMs: Readonly<Record<ParticipantId, number>>;
      /** Who reached the far side, in the order they got there. */
      readonly crossOrder: readonly ParticipantId[];
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
  /**
   * Undo a close. `closed` -> `running`, and **nothing else moves**.
   *
   * `close` is the one lifecycle transition with no way back, and an
   * accidental one ends the afternoon: the reducer refuses every rule event on
   * a closed session, so the alternative is a new session, a re-upload, a new
   * join code and thirty people rejoining. This is the cheap way back, and it
   * costs nobody a point.
   *
   * It deliberately restores only what it can restore *honestly*. `close` also
   * sets `segment: "final"` and `seal: "revealed"`, and this does not put
   * either back, for two reasons. The state carries no memory of where they
   * were — inventing a field to hold it would be a field a snapshot could
   * disagree with the rest of the state about — and more to the point, the
   * room has already seen the final and already seen the scoreboard. Un-seeing
   * it is not on offer. What is on offer is carrying on: one press of the rail
   * puts the segment back and one press of the scoreboard control puts the
   * seal back, and both of those are things the host does in front of people
   * all afternoon anyway.
   *
   * Joins are unlocked, because `close` locked them as a side effect rather
   * than because the host asked. See {@link Event} `restartSession` for the
   * other, destructive way back.
   */
  | { type: "reopen" }
  /**
   * Back to a clean lobby, from any phase including `closed`.
   *
   * The dry run's undo, and the accident's. **Keeps** the session id, the join
   * code, every participant with their nickname and their join-order number,
   * the loaded question set, the activity list — and, outside the engine, the
   * host, screen and rejoin tokens, which live in the runtime. Nobody rejoins
   * and nothing is re-uploaded.
   *
   * **Clears** every score, every Spot Award, all trivia progress (back to
   * question 1, with the same questions), the arcade entirely, the holding
   * card, the seal, the segment and the join lock.
   *
   * One event, not a sequence, and that is the point: a projection is built
   * from a whole `SessionState`, so there is no instant at which a phone can
   * be handed a session that is half cleared — trivia rewound with the arcade
   * still standing, or scores gone with the seal still hiding them.
   */
  | { type: "restartSession" }
  /**
   * Turn practice on or off. Refused while a question or a round is live,
   * because the flag is read when totals are banked rather than when they are
   * earned: flipping it mid-round would decide, retrospectively, whether the
   * thing the room just did counted.
   */
  | { type: "setPractice"; on: boolean }
  /** Replace the send-off content. Refused once it has started, like trivia. */
  /**
   * `seed` deals the plan. Drawn at the socket boundary like every other seed
   * in this engine, which has no randomness of its own — see engine/sendoff.ts.
   */
  | { type: "loadSendoff"; content: SendoffContent; seed: number }
  /**
   * Forward and back through the send-off, a step at a time.
   *
   * Two events rather than one `goto`, because the host drives this with the
   * space bar and the only two things they can mean are "next" and "I went too
   * fast". A `goto` would also let a console with a stale view jump the room to
   * a message it has already heard.
   */
  | { type: "sendoffNext" }
  | { type: "sendoffBack" }
  /** The console's Auto / Manual button. */
  | { type: "setSendoffAuto"; auto: boolean }
  /** The console's speed slider, in seconds per photograph. */
  | { type: "setSendoffSpeed"; seconds: number }
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
  /**
   * `tiebreakers` is the sudden-death pool. Optional, and three sources feed
   * it: this field, the questions in `questions` flagged
   * {@link Question.tiebreak}, and — when neither is present — the built-in
   * pool. See `partitionTiebreakers`.
   */
  | {
      type: "loadTrivia";
      activityId: ActivityId;
      questions: readonly Question[];
      tiebreakers?: readonly Question[];
    }
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
  /**
   * Glass Bridge: commit to a pane. `step` is the step the phone believed was
   * open, and a mismatch is refused rather than applied to whatever is open
   * now — a frame that crossed a step boundary is a tap on a pane the player
   * never saw.
   */
  | { type: "stepPane"; pid: ParticipantId; step: number; choice: number }
  /**
   * Unseal: choose a shape, before knowing the word. Allowed while the round
   * card is up — which is what the card is *for* — and after the Floor opens,
   * because a player who has not picked by then has nothing else to do and
   * the seconds they spent are punishment enough.
   */
  | { type: "pickShape"; pid: ParticipantId; shape: UnsealShape }
  /**
   * Unseal: tap a letter. The character, not a tile index — with a repeated
   * letter either tile is the same tap, and a phone that renumbers its tiles
   * on a repaint must not be able to crack somebody's tin.
   */
  | { type: "tapLetter"; pid: ParticipantId; letter: string }
  /** Unseal: **Read the docs.** Reveals the next letter, halves the round. */
  | { type: "readDocs"; pid: ParticipantId }
  /**
   * Tug of Raft: one tap. `at` is the corrected instant, as with `tap` — the
   * beat is judged against the heartbeat the phone was showing, not against
   * whatever the frame's arrival time makes of it.
   */
  | { type: "tapBeat"; pid: ParticipantId; at: number }
  /**
   * Tug of Raft: settle the pull and start the next one, with new sides. The
   * seed is drawn at the boundary; the engine has no randomness.
   */
  | { type: "nextPull"; seed: number }
  /** Gganbu: a secret call and stake on the open prompt. */
  | { type: "wager"; pid: ParticipantId; pick: OverUnder; amount: number }
  /** Gganbu: settle the open prompt — tokens move here — and open the next. */
  | { type: "nextPrompt" }
  /** Glass Bridge: close the open step and open the next one. */
  | { type: "nextStep" }
  /** Glass Bridge: close the wave and send the next one onto the bridge. */
  | { type: "nextWave" }
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
  /** A sudden death with no tiebreak question left to ask. */
  | "no_tiebreak_question"
  // arcade
  | "not_in_arcade"
  | "wrong_round_phase"
  | "already_answered_item"
  | "not_on_the_floor"
  | "not_in_the_lounge"
  | "cannot_back_yourself"
  | "cannot_back_a_drained_player"
  | "floor_locked"
  // arcade — Unseal
  /** The tin is open. The shape was a choice made before it was. */
  | "already_picked"
  /** Tapping letters, or reading the docs, before choosing a shape. */
  | "no_shape_picked"
  /** A letter that is not on any of that player's tiles. Not a crack: a bug. */
  | "invalid_letter"
  // arcade — Gganbu
  /** Not one to five, or more tokens than they hold. */
  | "invalid_wager"
  // arcade — the Glass Bridge
  /** Stepping while somebody else's wave is on the bridge. */
  | "not_your_wave"
  /** One pane per step. A second frame is not a change of mind. */
  | "already_stepped"
  /** The phone committed to a step that is no longer the open one. */
  | "wrong_step"
  /** SPEC: drained players back someone in a **later** wave. */
  | "must_back_a_later_wave"
  /**
   * A waiting wave bets on the wave in front of it, and on nobody else.
   *
   * The mirror image of `must_back_a_later_wave`: a player who is still on
   * the Floor is backing the wave they are watching, which is the one
   * crossing now. A later wave is one they will be walking beside.
   */
  | "must_back_the_crossing_wave"
  /**
   * Somebody in the crossing wave has stood on a pane. A waiting wave's bet is
   * placed before that, because a fall is public the moment it happens.
   */
  | "wave_already_stepped"
  /** Your runner's wave has started. The bet was placed before they stepped. */
  | "backing_locked"
  /**
   * `startRound` for a round that is designed but not built.
   *
   * All six are built now, so nothing in the engine can produce this any
   * more. It stays because it is part of the wire's vocabulary and because a
   * seventh round is a thing a future session could ask for and not get.
   */
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
