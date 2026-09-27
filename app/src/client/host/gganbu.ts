/**
 * Gganbu, as the console has to decide it. No DOM, no commands, no timers.
 *
 * The round's console work is three decisions and a lot of markup, and these
 * are the three. They are pulled out here for the reason `plan.ts` and
 * `controls.ts` are pulled out: the markup is a widget and the decisions are
 * rules, and a rule the host reads out loud at 14:40 should have a test rather
 * than a comment.
 *
 * What makes this round different from every other console panel is the third
 * one. `arcade.gganbu.recap` reaches the host **from the moment the round card
 * goes up**, and it is the only projection on this wire that carries `verify`
 * — which is omitted rather than falsed everywhere else, so it is not even in
 * the bytes a phone or the Desktop receives. The flag does not mean "this
 * answer might be wrong". It means the answer can *move*: a default in a
 * config file that a release could change, or a date that different sources
 * record differently. The facilitator is the one person who can re-check those
 * before reading the note out, so the console is where the flag has to land —
 * including at the reveal, which is the moment the notes are actually read.
 *
 * The copy in this file is this file's own, deliberately. `shared/view.ts`
 * holds the copy catalogues the three surfaces share, and none of these
 * strings is shared with anybody: they are host-only sentences about a
 * host-only flag.
 */

import type { ArcadePhase, ArcadeRoundKind } from "../../engine/types.ts";
import type { ArcadeGganbuRecap } from "../../protocol.ts";

/**
 * Whether "Settle the prompt" can be pressed, decided exactly as the engine
 * decides it.
 *
 * The engine refuses `nextPrompt` on the last prompt — "That was the last
 * prompt. End the round." — because settling the sixth one is what `endRound`
 * does on its way past. The console says so by being unpressable rather than
 * by being pressed, which is the same shape as Tug of Raft's "Start the next
 * pull" on the last pull and the Bridge's "Close the step" on a wave's last
 * step.
 *
 * `of` is the number of prompts on the board and is allowed to be 0: a console
 * that has a `gganbu` view with an empty board has a round the engine would
 * have refused to start, and nothing is pressable on it.
 */
export function canSettlePrompt(at: {
  readonly phase: ArcadePhase;
  readonly round: ArcadeRoundKind | null;
  readonly at: number;
  readonly of: number;
}): boolean {
  if (at.phase !== "running" || at.round !== "gganbu") return false;
  return at.at + 1 < at.of;
}

export interface GganbuLockIn {
  /** How many of the players still holding tokens have locked in. */
  readonly staked: number;
  /** How many are still on the Floor and could. */
  readonly onFloor: number;
  /** Everybody who could has. The cue to settle rather than wait. */
  readonly all: boolean;
}

/**
 * Who has locked in, out of who could.
 *
 * Named for the lock rather than for the stake, because `shared/view.ts` has a
 * `gganbuStake` of its own — the phone's stake dial, clamped to the hand — and
 * two functions of that name in one console would be one import away from a
 * host reading the wrong rule.
 *
 * `wagered` is `hostExtras.arcade.answeredBy`, which for this round is the
 * **keys** of `play.wagers` and never its values: a value is a pick and a
 * stake, and the console is three feet from the host's mouth. The keys answer
 * the only question the host has — settle now, or wait — on their own.
 *
 * Counted against the Floor rather than against the room, because a revoked
 * player cannot wager and a round that waited for them would never settle
 * another prompt. Anybody in `wagered` who is no longer on the Floor is
 * ignored: they staked, the stake settled them to zero, and they are not part
 * of "everybody who could has".
 */
export function gganbuLockedIn(
  floor: readonly string[],
  wagered: readonly string[],
): GganbuLockIn {
  const locked = new Set(wagered);
  const staked = floor.filter((pid) => locked.has(pid)).length;
  return { staked, onFloor: floor.length, all: floor.length > 0 && staked === floor.length };
}

/**
 * The line under the prompt: whether to settle, said as the thing to do.
 *
 * `last` is the sixth prompt, where there is no next one to open — the button
 * that settles it is "End the round", so the sentence has to point at that one
 * instead. Getting this wrong is a facilitator pressing a disabled button
 * while the room waits, which is the failure this sentence exists to prevent.
 */
export function gganbuLockNote(stake: GganbuLockIn, last: boolean): string {
  const settle = last
    ? "End the round to settle it."
    : "Settle the prompt to move the tokens.";
  if (stake.onFloor === 0) {
    return "Nobody is holding tokens. End the round.";
  }
  if (stake.all) {
    return `All ${stake.onFloor} have locked in. ${settle}`;
  }
  return `${stake.staked} of ${stake.onFloor} have locked in. ${settle}`;
}

/** One prompt, as the console draws it. */
export interface GganbuRecapRow {
  /** 1-based, because the round card counts from 1 and so does the host. */
  readonly n: number;
  readonly cue: string;
  readonly threshold: string;
  readonly answer: "over" | "under";
  readonly note: string;
  /** The host-only flag: re-check this note before reading it out. */
  readonly verify: boolean;
  /** The prompt the room is on right now. */
  readonly open: boolean;
}

/**
 * The six prompts, numbered, with the flag attached.
 *
 * Absent recap is an empty list rather than a throw: the recap is host-only
 * and arrives with the round card, so the only way it is missing is a console
 * that is not the host — and a console that is not the host has nothing to
 * draw here.
 */
export function gganbuRecapRows(
  recap: readonly ArcadeGganbuRecap[] | undefined,
  at: number,
): readonly GganbuRecapRow[] {
  if (recap === undefined) return [];
  return recap.map((r, i) => ({
    n: i + 1,
    cue: r.cue,
    threshold: r.threshold,
    answer: r.answer,
    note: r.note,
    verify: r.verify === true,
    open: i === at,
  }));
}

/**
 * The one sentence that says which answers to re-check, by number.
 *
 * By number and not by name, because the host is looking at a numbered list
 * two lines below it and a cue repeated here would be a second thing to read.
 * Empty when nothing carries the flag — a bank whose answers cannot move needs
 * no sentence about checking them, and a line saying "none" is a line the host
 * reads before finding out it said nothing.
 *
 * The flag belongs to whoever wrote the bank, so this counts rather than
 * assuming a number. SPEC.md fixed the count at three of the six when this was
 * written; the shipped bank flags all six, for the reason its own "Why all six
 * carry the flag" section gives, and counting is what let that change land here
 * without an edit.
 *
 * ## Why all-flagged is a different sentence
 *
 * Counting produced "Check prompts 1, 2, 3, 4, 5 and 6" once the bank flagged
 * everything, which is an enumeration of the whole list sitting directly under
 * the whole list — and every one of those rows already draws its own VERIFY
 * chip. Naming them again is the panel repeating itself in longer form.
 *
 * What the chips cannot say is *why*, so that is what is left when the numbers
 * go. The enumeration still runs for any bank that flags some but not all,
 * which is the case the numbers were for.
 *
 * One flagged prompt in a one-prompt bank keeps the numbered form: "every
 * answer here" is a strange way to describe a list of one.
 *
 * ## Not "read the note out"
 *
 * This used to end "before you read the note out". The notes left this panel —
 * the Desktop puts one up beside its prompt at the reveal, which is where they
 * are read from now — so the sentence was pointing the host at a surface that
 * no longer carries them. "Before the reveal" names the moment instead of the
 * surface, and stays true wherever the note is drawn.
 */
export function gganbuVerifyNotice(
  recap: readonly ArcadeGganbuRecap[] | undefined,
): string {
  const rows = gganbuRecapRows(recap, -1);
  const flagged = rows.filter((r) => r.verify).map((r) => String(r.n));
  if (flagged.length === 0) return "";
  if (flagged.length === rows.length && rows.length > 1) {
    return "Every answer here is a default a release can move. Check against the source before the reveal.";
  }
  const which =
    flagged.length === 1
      ? `prompt ${flagged[0]}`
      : `prompts ${flagged.slice(0, -1).join(", ")} and ${flagged[flagged.length - 1]}`;
  return `Check ${which} against the source before the reveal: those answers can move.`;
}
