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
    // Recruitment does not drain. The rest are not built yet.
    case "recruitment":
    case "unseal":
    case "tug_of_raft":
    case "gganbu":
    case "glass_bridge":
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
