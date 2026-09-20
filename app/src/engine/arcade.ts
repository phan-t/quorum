/**
 * Hashi Arcade arithmetic and settlement. See SPEC.md "Hashi Arcade".
 *
 * Split from reducer.ts the same way trivia.ts is: this file is what a tap is
 * worth, what the Lounge pays and who was first across; reducer.ts is the
 * state machine that calls it. scoring.ts is a third thing again — SCORING.md's
 * one normalisation rule, which the arcade feeds with an ordinary raw score.
 *
 * Pure, like everything else in engine/: no clock, no randomness, no I/O. The
 * light durations in Plan / Apply are random 2–6 s, so they are drawn at the
 * socket boundary and arrive on `setLight`; the 250 ms grace after a lock is
 * likewise applied to the tap instant before it gets here, exactly as a trivia
 * response time is latency-corrected before `answerQuestion`.
 */

import type {
  ArcadePlay,
  ArcadeRoundConfig,
  ArcadeRoundKind,
  ArcadeStanding,
  ArcadeState,
  EmojiItem,
  GlassAnswer,
  GlassBoardStep,
  GlassStep,
  GlassWave,
  LoungeSeat,
  Participant,
  ParticipantId,
  SessionState,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Round 0 — Recruitment                                               */
/* ------------------------------------------------------------------ */

/** SPEC.md: "Every correct answer within the timer scores 10". */
export const RECRUITMENT_CORRECT = 10;

/** "…the first three correct in the room score +5" — per item, not per round. */
export const RECRUITMENT_FIRST_BONUS = 5;
export const RECRUITMENT_FIRST_PLACES = 3;

/* ------------------------------------------------------------------ */
/* Round 1 — Plan / Apply                                              */
/* ------------------------------------------------------------------ */

/** Each checkpoint banks 5, and banked means banked: a drain cannot take it. */
export const PLAN_APPLY_CHECKPOINT_BANK = 5;

/** Crossing the line banks 10 on top of the checkpoints. */
export const PLAN_APPLY_CROSS = 10;

/** First, second and third across. Fourth onwards get the crossing and no more. */
export const PLAN_APPLY_FINISH_BONUS: readonly number[] = [15, 10, 5];

/**
 * The APPLY window that was in force at `at`, as the instant it began — or
 * null if the light was green then.
 *
 * A tap is judged against the light that was showing **at its corrected
 * instant**, which is not always the light showing when the frame lands. A
 * 400 ms round trip taps 1.9 s into a lock and the frame can arrive after the
 * light has gone back to green; the phone was plainly pink, and SPEC is flat
 * about it — "During APPLY (pink), any tap is … drained."
 *
 * Only two windows can ever be in play. `play.applySince` names the APPLY that
 * is running or the one that ended when this PLAN began, and that is enough: a
 * corrected instant is at most 250 ms behind the frame that carried it (the
 * cap on the latency correction) and a light runs for at least two seconds, so
 * nothing can reach back past the window immediately before the current one.
 *
 * The start instant is returned rather than a boolean because the 250 ms grace
 * at the socket boundary needs it: the grace pulls a tap back to the last
 * instant of the PLAN that preceded *that* lock.
 */
export function lockInForceAt(
  play: Extract<ArcadePlay, { kind: "plan_apply" }>,
  at: number,
): number | null {
  if (play.light === "apply") {
    return at >= play.lightChangedAt ? play.lightChangedAt : null;
  }
  const since = play.applySince;
  if (since === null) return null;
  return at >= since && at < play.lightChangedAt ? since : null;
}

/** The Lounge: the runner you backed crossed the line. */
export const PLAN_APPLY_BACKED_CROSSES = 10;

/**
 * The Lounge: the runner you backed was first across.
 *
 * This does **not** stack with the crossing award — a perfect Lounge round is
 * the larger of the two, 15, not their sum. Stacking made 25, which tied the
 * 25 a player scores for crossing the line in fourth place or later, and a
 * player drained at 90 resources who then backed the winner scored 40: exactly
 * the same as the player who actually won the Floor. SPEC's rule is that
 * crossing the line always beats a perfect Lounge, and with the two awards
 * added together it was not true at either end.
 */
export const PLAN_APPLY_BACKED_WINS = 15;

/**
 * The three checkpoints, as quarter marks of the target rather than the
 * literal 30 / 60 / 90.
 *
 * SPEC.md gives both: the round says "checkpoints at 30, 60 and 90 resources"
 * and the frame says "getting caught at 75% keeps what you banked at 50%" —
 * percentages. For the tuned target of 120 the two readings are the same
 * numbers, and the percentage reading is the one that survives the host
 * changing the target, which SPEC.md explicitly allows. Fixed checkpoints and
 * a target of 60 would put a checkpoint *on* the finish line and another past
 * it, which is not a game.
 *
 * Deduplicated and kept strictly inside (0, target) so a very small target
 * cannot pay a checkpoint twice or pay one for crossing the line.
 */
export function checkpointsFor(target: number): readonly number[] {
  if (!Number.isFinite(target) || target <= 0) return [];
  const marks = [1, 2, 3]
    .map((k) => Math.round((target * k) / 4))
    .filter((m) => m > 0 && m < target);
  return [...new Set(marks)];
}

/** Points banked by moving from `from` resources to `to`. */
export function checkpointBank(
  from: number,
  to: number,
  checkpoints: readonly number[],
): number {
  const passed = checkpoints.filter((m) => from < m && m <= to).length;
  return passed * PLAN_APPLY_CHECKPOINT_BANK;
}

/** The bonus for the `place`-th finisher, 0-based. Zero past third. */
export function finishBonus(place: number): number {
  return PLAN_APPLY_FINISH_BONUS[place] ?? 0;
}

/* ------------------------------------------------------------------ */
/* Round 5 — The Glass Bridge                                          */
/* ------------------------------------------------------------------ */

/** "Each step crossed banks 5." Banked means banked: a fall cannot take it. */
export const GLASS_STEP_BANK = 5;

/** "Reaching the far side +15." */
export const GLASS_FAR_SIDE = 15;

/**
 * "Wave 1 banks +3 per step for going blind."
 *
 * The compensation for an asymmetry the round is built on rather than an
 * apology for it: 6 × (5 + 3) + 15 = 63, which is the Floor max in SPEC.md's
 * scoring table, and waves 2 and 3 top out at 45.
 */
export const GLASS_BLIND_BONUS = 3;

/** The Lounge: the runner you backed reached the far side. */
export const GLASS_BACKED_CROSSES = 10;

/**
 * The Lounge: the runner you backed made the fastest full crossing.
 *
 * As in Plan / Apply, **the better of the two and never their sum** — SPEC.md
 * is explicit that the Lounge rule must not change between rounds, "it is hard
 * enough to explain once". A perfect Lounge round is 15.
 */
export const GLASS_BACKED_FASTEST = 15;

/** One committed step, for a player in `wave`. */
export function glassStepBank(wave: GlassWave): number {
  return GLASS_STEP_BANK + (wave === 1 ? GLASS_BLIND_BONUS : 0);
}

/** The Glass Bridge's own play state, which several helpers here want. */
export type GlassPlay = Extract<ArcadePlay, { kind: "glass_bridge" }>;

/**
 * Split content into the half that may be shown and the half that may not.
 *
 * Done once, at `startRound`, so that from then on the answer lives in exactly
 * one field with one name. The alternative — keeping `GlassStep` whole in the
 * play state and trusting every projection to pick fields out of it — puts the
 * answer one careless object spread away from thirty phones.
 */
export function splitBoard(steps: readonly GlassStep[]): {
  board: readonly GlassBoardStep[];
  key: readonly GlassAnswer[];
} {
  return {
    board: steps.map((s) => ({
      product: s.product,
      labels: [s.panes[0].label, s.panes[1].label] as const,
    })),
    key: steps.map((s) => ({
      real: s.real,
      notes: [s.panes[0].note, s.panes[1].note] as const,
    })),
  };
}

/**
 * Where the wave boundaries fall, as the last arcade player number in wave 1
 * and the last in wave 2.
 *
 * Contiguous thirds in player-number order, earlier waves taking the
 * remainder. Contiguous rather than round-robin because SPEC says the waves
 * are "by player number" and because the room can work out its own wave from
 * two numbers on the big screen, which a modulo cannot give them.
 *
 * Awkward rosters fall out of `floor(i × 3 / n)` without a special case: one
 * player is wave 1 alone, two players are waves 1 and 2 with wave 3 empty,
 * four are 2 / 1 / 1. An empty wave is not a problem — it crosses instantly
 * and the round moves on.
 *
 * Cuts rather than a per-player map so that a latecomer, whose number is
 * necessarily above both, is in wave 3 by arithmetic rather than by being
 * re-assigned mid-round.
 */
export function waveCutsFor(numbers: readonly number[]): readonly [number, number] {
  const sorted = [...numbers].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return [0, 0];
  let cut1 = 0;
  let cut2 = 0;
  for (let i = 0; i < n; i++) {
    const wave = Math.floor((i * 3) / n);
    const number = sorted[i]!;
    if (wave === 0) cut1 = number;
    if (wave <= 1) cut2 = number;
  }
  // An empty wave 2 leaves cut2 where cut1 is, which is what "wave 2 is
  // nobody" has to mean for `waveOf` to keep working.
  if (cut2 < cut1) cut2 = cut1;
  return [cut1, cut2];
}

/**
 * Which wave a player number crosses in.
 *
 * An undefined number — somebody who joined after the round started and has
 * not been handed an arcade number yet — is wave 3, which is where their
 * number would have put them anyway.
 */
export function waveOf(
  playerNumber: number | undefined,
  cuts: readonly [number, number],
): GlassWave {
  if (playerNumber === undefined) return 3;
  if (playerNumber <= cuts[0]) return 1;
  if (playerNumber <= cuts[1]) return 2;
  return 3;
}

/**
 * How much round is left after the open step's deadline: the rest of this
 * wave, plus every wave that has not walked on yet.
 *
 * Recomputed every time a step opens rather than fixed at `beginPlay`, for the
 * reason `nextItem` recomputes Recruitment's: each step opens a little after
 * its predecessor's deadline, because the timer that opens it has event-loop
 * lag, and a round end guessed up front drifts earlier than the truth by the
 * accumulated lag. Left alone that is wave 3 losing the tail of its last step,
 * which is the one it can least afford at six seconds.
 */
export function glassRemainingMs(
  play: GlassPlay,
  wave: GlassWave,
  step: number,
): number {
  const steps = play.board.length;
  let ms = Math.max(0, steps - step - 1) * (play.waveSeconds[wave - 1] ?? 0) * 1000;
  for (let w = wave + 1; w <= 3; w++) {
    ms += steps * (play.waveSeconds[w - 1] ?? 0) * 1000;
  }
  return ms;
}

/**
 * Everyone the open step is waiting for: in the wave that is on the bridge,
 * still on the Floor, and not already across.
 *
 * "Not already across" is load-bearing. A player who reached the far side is
 * still `floor` — they were never drained — and without this they would be
 * drained at the next step close for failing to step onto a bridge they had
 * already finished.
 */
export function bridgeRunners(
  state: SessionState,
  arcade: ArcadeState,
  play: GlassPlay,
): readonly ParticipantId[] {
  return rosterOrder(state)
    .map((p) => p.pid)
    .filter(
      (pid) =>
        arcade.standing[pid] !== "drained" &&
        waveOf(arcade.playerNumbers[pid], play.waveCuts) === play.wave &&
        (play.position[pid] ?? 0) < play.board.length,
    );
}

export interface GlassStepClose {
  readonly standing: Readonly<Record<ParticipantId, ArcadeStanding>>;
  readonly lounge: Readonly<Record<ParticipantId, LoungeSeat>>;
  readonly broken: readonly (0 | 1 | null)[];
  /** Who this close drained, for the caller's effects and for tests. */
  readonly drained: readonly ParticipantId[];
}

/**
 * Close the open step: drain whoever did not step, and publish the pane that
 * broke.
 *
 * Both halves happen *here* rather than as they occur, and that is the round's
 * one real secrecy rule. A pane that broke is the complete answer for that
 * step — with two panes, "the left one broke" is "the right one is real" — so
 * publishing it the instant somebody fell would hand it to the half of their
 * own wave who are still deciding. Held until the step closes, it reaches only
 * players who have already stepped past it, which is precisely the promise
 * SPEC makes to waves 2 and 3.
 *
 * Failing to step drains you. SPEC does not say so in as many words, but the
 * alternatives are worse: leaving a non-stepper standing on the bridge breaks
 * the wave apart (a wave crosses as a unit, which is what makes one `step` and
 * one deadline meaningful) and leaves them sitting out the rest of the round,
 * which is the one thing the Floor and the Lounge exist to prevent. Drained,
 * they are in the Lounge backing somebody within a second.
 */
export function closeGlassStep(
  state: SessionState,
  arcade: ArcadeState,
  play: GlassPlay,
  now: number,
): GlassStepClose {
  const drained = bridgeRunners(state, arcade, play).filter(
    (pid) => !(pid in play.stepped),
  );

  const standing: Record<ParticipantId, ArcadeStanding> = { ...arcade.standing };
  const lounge: Record<ParticipantId, LoungeSeat> = { ...arcade.lounge };
  for (const pid of drained) {
    standing[pid] = "drained";
    lounge[pid] = arcade.lounge[pid] ?? { backing: null, at: now };
  }

  const answer = play.key[play.step];
  const fell = Object.values(play.stepped).some((held) => !held);
  let broken = play.broken;
  if (fell && answer !== undefined && play.broken[play.step] !== undefined) {
    const next = [...play.broken];
    // The pane that broke is the one that is not real. A second wave falling
    // at the same step writes the same value, so this is idempotent.
    next[play.step] = answer.real === 0 ? 1 : 0;
    broken = next;
  }

  return { standing, lounge, broken, drained };
}

/**
 * The fastest full crossing: the lowest total decision time among the players
 * who reached the far side, ties broken by who got there first.
 *
 * SPEC says "fastest full crossing" and leaves what "fastest" means to the
 * round, which runs three waves at three different step lengths. Two readings
 * were available and both are degenerate:
 *
 *   - **First across in wall-clock order.** Wave 1 crosses before wave 2 is
 *     on the bridge, so the award is settled before most of the Lounge has
 *     sat down — and the Lounge may only back a *later* wave, so nobody in it
 *     could ever win the 15.
 *   - **Elapsed time from your own wave's start.** A wave cannot advance
 *     before its step closes, so a wave-1 crossing takes at least five full
 *     12 s steps and a wave-3 crossing at most five 6 s ones. Wave 3 wins by
 *     construction, every time.
 *
 * Decision time — the six reaction times added up — is the only measure that
 * is comparable across waves, stays live until the last wave is off the
 * bridge, and rewards the thing the round is about. A decisive wave-1 player
 * can hold the record against a dithering wave-3 one.
 */
export function fastestCrossing(play: GlassPlay): ParticipantId | null {
  let best: ParticipantId | null = null;
  let bestMs = Infinity;
  // crossOrder is in crossing order, so a strict `<` keeps the earliest
  // crosser on a tie without a second comparison.
  for (const pid of play.crossOrder) {
    const ms = play.elapsedMs[pid] ?? Infinity;
    if (ms < bestMs) {
      best = pid;
      bestMs = ms;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Round 5 — projections                                               */
/* ------------------------------------------------------------------ */

/**
 * The round's public state: what the big screen may show, which is the same
 * thing as what every player in the room may know.
 *
 * There is no "screen only" secret in a room with a projector in it, so this
 * is the *only* public view and the phone's round view is a subset of it. It
 * is built by naming fields rather than by deleting them from `play`, so a
 * field added to the play state later is private until somebody decides
 * otherwise.
 *
 * Deliberately absent: `key` (the answer), and `stepped` (who has committed at
 * the open step). `stepped` would add nothing that `position` and the drained
 * grid do not already show, and a field that says "X survived this step" is
 * one accidental join away from the field that says which pane X chose —
 * which is why that field does not exist at all.
 */
export interface GlassFloorView {
  readonly board: readonly GlassBoardStep[];
  readonly wave: GlassWave;
  readonly waveCuts: readonly [number, number];
  readonly step: number;
  readonly waveStartedAt: number;
  readonly stepStartedAt: number;
  readonly stepEndsAt: number;
  readonly broken: readonly (0 | 1 | null)[];
  readonly position: Readonly<Record<ParticipantId, number>>;
  readonly elapsedMs: Readonly<Record<ParticipantId, number>>;
  readonly crossed: readonly ParticipantId[];
  readonly fastest: ParticipantId | null;
}

export function glassFloorView(play: GlassPlay): GlassFloorView {
  return {
    board: play.board,
    wave: play.wave,
    waveCuts: play.waveCuts,
    step: play.step,
    waveStartedAt: play.waveStartedAt,
    stepStartedAt: play.stepStartedAt,
    stepEndsAt: play.stepEndsAt,
    broken: play.broken,
    position: play.position,
    elapsedMs: play.elapsedMs,
    crossed: play.crossOrder,
    fastest: fastestCrossing(play),
  };
}

/** One player's private view: their own wave, their own step, their own step. */
export interface GlassMeView {
  readonly wave: GlassWave;
  readonly onTheBridge: boolean;
  readonly step: number;
  readonly committed: boolean;
  /** Null until they commit; then whether the pane held. */
  readonly held: boolean | null;
  readonly across: boolean;
}

export function glassMeView(
  arcade: ArcadeState,
  play: GlassPlay,
  pid: ParticipantId,
): GlassMeView {
  const wave = waveOf(arcade.playerNumbers[pid], play.waveCuts);
  const position = play.position[pid] ?? 0;
  const committed = pid in play.stepped;
  return {
    wave,
    onTheBridge:
      wave === play.wave &&
      arcade.standing[pid] !== "drained" &&
      position < play.board.length,
    step: position,
    committed,
    held: committed ? play.stepped[pid]! : null,
    across: position >= play.board.length,
  };
}

/* ------------------------------------------------------------------ */
/* Player numbers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Three digits, zero-padded. *Player 017 has been drained.*
 *
 * Above 999 the number simply gets longer: sixty people fit on the big screen
 * grid and a four-digit badge is a better failure than a wrapped-around one.
 */
export function formatPlayerNumber(n: number): string {
  return String(n).padStart(3, "0");
}

/**
 * The roster, in roster order.
 *
 * Same filter and order as the console's roster: kicked and released people
 * are not in the room, and `Participant.playerNumber` is join order.
 */
export function rosterOrder(state: SessionState): readonly Participant[] {
  return Object.values(state.participants)
    .filter((p) => !p.kicked && p.nicknameKey !== "")
    .sort((a, b) => a.playerNumber - b.playerNumber);
}

/**
 * Hand out arcade numbers, keeping every number already handed out.
 *
 * Not `Participant.playerNumber` itself, which is join order and therefore has
 * holes in it — everyone who joined and was kicked, everyone who released a
 * nickname. The grid wants 001…060 with nothing missing, and a number that
 * changed after a person had read it off their own phone would be worse than
 * any hole, so assignment is once per person and append-only for latecomers.
 */
export function assignPlayerNumbers(
  state: SessionState,
  assigned: Readonly<Record<ParticipantId, number>>,
): Readonly<Record<ParticipantId, number>> {
  const next: Record<ParticipantId, number> = { ...assigned };
  let n = Object.values(next).reduce((max, v) => Math.max(max, v), 0);
  for (const p of rosterOrder(state)) {
    if (next[p.pid] !== undefined) continue;
    next[p.pid] = ++n;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Answer matching                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fold a typed answer: lowercase, then keep letters only.
 *
 * SPEC.md says "matched after lowercasing and stripping non-letters", so
 * "Terra-form!" and " terraform " are the same answer, and so is "TERRAFORM".
 * Letters from any script are kept for the same reason nicknameKey() keeps
 * them: an APJ room is not an edge case. Digits go, which costs nothing —
 * no product name in the launch set has one.
 */
export function foldAnswer(answer: string): string {
  return answer.toLowerCase().replace(/[^\p{L}]/gu, "");
}

/**
 * Does this answer match the item?
 *
 * The accept list is the point: `tf` is a reasonable thing to type for
 * Terraform under a twenty-second timer and refusing it would be the game
 * being clever at the player's expense.
 */
export function matchesItem(item: EmojiItem, answer: string): boolean {
  const folded = foldAnswer(answer);
  if (folded === "") return false;
  return (
    folded === foldAnswer(item.answer) ||
    item.accept.some((a) => foldAnswer(a) === folded)
  );
}

/* ------------------------------------------------------------------ */
/* The Lounge                                                          */
/* ------------------------------------------------------------------ */

/**
 * What the Lounge pays a backer, given how the player they backed ended up.
 *
 * SPEC.md's frame is "score if they survive, score more if they win"; each
 * round then names its own numbers, and Plan / Apply's are crossing and
 * winning, not surviving. A backed runner who is never drained but never
 * crosses pays nothing — see the note on loungeMax() for why that reading is
 * the one the scoring table supports.
 */
export function loungePoints(
  play: ArcadePlay,
  backing: ParticipantId,
  backedStanding: ArcadeStanding | undefined,
): number {
  // Backing someone who was drained pays nothing, whichever round it is.
  if (backedStanding !== "floor") return 0;
  switch (play.kind) {
    // Recruitment does not drain, so nobody is ever in the Lounge for it.
    case "recruitment":
      return 0;
    case "plan_apply": {
      const crossed = play.finishOrder.includes(backing);
      const won = play.finishOrder[0] === backing;
      // The better of the two, never both. See PLAN_APPLY_BACKED_WINS.
      if (won) return PLAN_APPLY_BACKED_WINS;
      return crossed ? PLAN_APPLY_BACKED_CROSSES : 0;
    }
    case "glass_bridge": {
      // The same shape as Plan / Apply, because SPEC.md says the Lounge rule
      // must not change between rounds. A runner who was never drained but
      // never reached the far side pays nothing — which on this bridge can
      // only happen to a wave that the host ended early, since every other
      // way off it is a drain.
      if (fastestCrossing(play) === backing) return GLASS_BACKED_FASTEST;
      return play.crossOrder.includes(backing) ? GLASS_BACKED_CROSSES : 0;
    }
  }
}

/**
 * The most the Floor can pay one player in this round.
 *
 * Exists so the Lounge cap can be *checked* rather than asserted in a comment:
 * see arcade.test.ts, which holds these against SPEC.md's scoring table.
 */
export function floorMax(config: ArcadeRoundConfig): number {
  switch (config.kind) {
    case "recruitment":
      // 6 × (10 + 5) = 90.
      return config.items.length * (RECRUITMENT_CORRECT + RECRUITMENT_FIRST_BONUS);
    case "plan_apply":
      // 3 × 5 + 10 + 15 = 40.
      return (
        checkpointsFor(config.target).length * PLAN_APPLY_CHECKPOINT_BANK +
        PLAN_APPLY_CROSS +
        finishBonus(0)
      );
    case "glass_bridge":
      // Wave 1, all six steps: 6 × (5 + 3) + 15 = 63. Waves 2 and 3 max at
      // 6 × 5 + 15 = 45, and the difference is what going blind is worth.
      return (
        config.steps.length * (GLASS_STEP_BANK + GLASS_BLIND_BONUS) +
        GLASS_FAR_SIDE
      );
  }
}

/**
 * The most the Lounge can pay one backer in this round.
 *
 * SPEC.md: "Lounge points are real points … capped so a perfect Lounge round
 * is worth less than surviving the Floor." The awards are deliberately not
 * cumulative, so this is 15 rather than 25, and crossing the line — 25 at
 * worst — always beats it.
 *
 * The literal reading of that sentence still cannot hold for *every* Floor
 * outcome, and no choice of constants would make it: a player who survives the
 * whole round without reaching a single checkpoint banks nothing, and nothing
 * is less than a perfect Lounge. That is the intended shape, not a bug —
 * banked progress is what the Floor pays for, and someone who neither
 * progressed nor was drained has not done more than a backer who picked the
 * winner.
 */
export function loungeMax(round: ArcadeRoundKind): number {
  switch (round) {
    case "plan_apply":
      return Math.max(PLAN_APPLY_BACKED_CROSSES, PLAN_APPLY_BACKED_WINS);
    case "glass_bridge":
      return Math.max(GLASS_BACKED_CROSSES, GLASS_BACKED_FASTEST);
    // Recruitment does not drain. The rest are not built yet.
    case "recruitment":
    case "unseal":
    case "tug_of_raft":
    case "gganbu":
      return 0;
  }
}

export interface RoundSettlement {
  /** This round's points, Floor and Lounge, per player. */
  readonly banked: Readonly<Record<ParticipantId, number>>;
  /** The arcade raw score: every round banked so far. */
  readonly totals: Readonly<Record<ParticipantId, number>>;
}

/**
 * Close the round: pay the Lounge, then fold this round into the totals.
 *
 * The Lounge cannot be paid until the Floor stops moving — whether the runner
 * you backed crossed is not known until the round ends — which is why these
 * points land here and the Floor's land as they are earned. Everyone who was
 * in the round lands in `totals`, at zero if they scored nothing: a raw of 0
 * is "played and scored nothing", which is a different statement from the
 * absent cell that lets a host mark somebody benched.
 *
 * `banked` is returned rather than cleared. The reveal still needs to show
 * what the round was worth; it is cleared by the next `startRound`.
 */
export function settleRound(arcade: ArcadeState): RoundSettlement {
  const banked: Record<ParticipantId, number> = { ...arcade.banked };

  for (const [pid, seat] of Object.entries(arcade.lounge)) {
    if (seat.backing === null || !arcade.play) continue;
    const points = loungePoints(
      arcade.play,
      seat.backing,
      arcade.standing[seat.backing],
    );
    if (points > 0) banked[pid] = (banked[pid] ?? 0) + points;
  }

  const totals: Record<ParticipantId, number> = { ...arcade.totals };
  for (const pid of Object.keys(arcade.standing)) {
    totals[pid] = (totals[pid] ?? 0) + (banked[pid] ?? 0);
  }

  return { banked, totals };
}
