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
  GganbuAnswer,
  GganbuPrompt,
  GlassAnswer,
  GlassBoardStep,
  GlassStep,
  GlassWave,
  LoungeSeat,
  OverUnderItem,
  Participant,
  ParticipantId,
  SessionState,
  UnsealAnswer,
  UnsealItem,
  UnsealShape,
  UnsealTin,
  Wager,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Round 0 — Recruitment                                               */
/* ------------------------------------------------------------------ */

/**
 * SPEC.md: "Every correct answer within the timer scores 10".
 *
 * **This is the largest number in the arcade, and it is a decision rather than
 * an accident.** Six items at 10 + 5 is a Floor max of 90. On the running
 * order the event actually uses — Recruitment, Plan / Apply, the Bridge — the
 * Floor can pay 90 + 40 + 63 = 193, so Recruitment is 47% of it, and it is the
 * round that asks the least: six product names an SA knows cold, with the +5
 * going to the first three in the room *per item*. That makes it a typing race
 * rather than a quiz, and two or three emoji typed quickly outweigh a whole
 * honest tin in Unseal.
 *
 * The case for leaving it there is SPEC.md's own: "round one sets whether
 * people think they can win", it is the round that hands out the player
 * numbers, and a round nobody can be knocked out of has to pay enough to be
 * worth playing. The case against is that a typing race settles the
 * leaderboard before the rounds with a decision in them have started.
 *
 * Nobody has chosen between those, so the pair is named and asserted rather
 * than quietly tuned. The retune is this line: at 5 the round is
 * 6 × (5 + 5) = 60 and its share of the same three falls to 60 / 163 = 37%.
 * arcade.test.ts holds the ceilings and the ratio, so either number moving
 * fails a test that prints the arithmetic instead of passing in silence.
 */
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
/* Seeded arithmetic                                                   */
/* ------------------------------------------------------------------ */

/**
 * A deterministic generator, for the two rounds that deal something out.
 *
 * This is not randomness: it is arithmetic on a number that arrived on an
 * event. Tug of Raft reshuffles its sides "by seed" and Gganbu draws its
 * pairs, and both seeds are drawn at the socket boundary exactly as Plan /
 * Apply's light durations are, for the same reason — the engine has no
 * randomness, and a replayed event log has to deal the same sides twice.
 *
 * mulberry32, chosen because it is eleven lines, has no state outside the
 * closure, and gives the same sequence on every engine that implements
 * `Math.imul`.
 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Fisher–Yates shuffle from a seed. Pure, and stable across replays. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Round 2 — Unseal                                                    */
/* ------------------------------------------------------------------ */

export type UnsealPlay = Extract<ArcadePlay, { kind: "unseal" }>;

/** The four tins, in the order the picker shows them. ○ △ ☆ ☂ */
export const UNSEAL_SHAPES: readonly UnsealShape[] = [
  "circle",
  "triangle",
  "star",
  "umbrella",
];

/**
 * "Unsealing scores by shape: 10 / 20 / 35 / 50."
 *
 * The shape score is what unsealing pays **in total**, not a bonus on top of
 * the per-letter banking. That is the reading SPEC.md's own scoring table
 * settles: it gives Unseal a Floor max of 60, which is 50 + the 10 for being
 * fastest in your shape and nothing else. Every other row in that table is
 * exactly derivable from its round's prose — Recruitment 6 × 15, Plan / Apply
 * 3 × 5 + 10 + 15, Tug of Raft 3 × 15, Gganbu 40 + 10, the Bridge 6 × 8 + 15 —
 * so it is a precise table rather than a decorative one, and 60 is a fact
 * about how the letters and the shape fit together.
 *
 * So the letters bank *towards* the shape score rather than on top of it: see
 * {@link unsealFloorPoints}.
 */
export const UNSEAL_SHAPE_SCORE: Readonly<Record<UnsealShape, number>> = {
  circle: 10,
  triangle: 20,
  star: 35,
  umbrella: 50,
};

/** "A crack drains you: banked 2 per correct letter up to the crack." */
export const UNSEAL_LETTER_BANK = 2;

/** "…with +10 for the fastest in each shape." */
export const UNSEAL_FASTEST_BONUS = 10;

/**
 * What **Read the docs** costs: a rule the round is handed, rather than a
 * halving written into {@link unsealFloorPoints}.
 *
 * It is a rule and not a number because the current one has a known effect on
 * the shape pick. Reading the docs commits the next letter, there is no limit
 * on the presses, and {@link fastestUnseal} skips a reader — so every shape
 * has a risk-free branch worth half its tin, and the whole payoff table is:
 *
 * |  | honest | honest, fastest | docs |
 * | --- | --- | --- | --- |
 * | ○ circle | 10 | 20 | 5 |
 * | △ triangle | 20 | 30 | 10 |
 * | ☆ star | 35 | 45 | 17 |
 * | ☂ umbrella | 50 | 60 | 25 |
 *
 * Read it down the columns and the umbrella wins all three, which is the
 * problem: the shape is picked before the word is known, and picking the
 * umbrella has no downside to weigh. Its worst case is a guaranteed 25, which
 * is more than a circle can score even with the fastest bonus (20) and more
 * than an honest triangle that is not fastest (20). "Pick your shape before
 * you know the word" is supposed to be the risk decision of the round, and
 * with this rule there is nothing in it to decide.
 *
 * Halving harder does not fix it — {@link UNSEAL_DOCS_COSTS.quarter} still
 * leaves the docs column monotone in the shape score, 2 / 5 / 8 / 12, and 12
 * still beats an honest circle. What fixes it is flattening that column, which
 * is {@link UNSEAL_DOCS_COSTS.cappedAtCheapestTin}: 5 / 10 / 10 / 10, where
 * buying a big word gets you no further than buying a small one and beating an
 * honest circle means opening a tin honestly.
 *
 * **Nothing has been retuned.** `halve` is SPEC.md's rule — "it reveals the
 * next letter and halves your score for the round" — and it is what ships.
 * Swapping the line below is the whole change; unseal.test.ts asserts the
 * table above, so a swap shows up as a payoff table that moved rather than as
 * a number somewhere in a round.
 */
export type UnsealDocsCost = (raw: number, shape: UnsealShape) => number;

export const UNSEAL_DOCS_COSTS = {
  /** SPEC.md's rule, rounding down. */
  halve: (raw: number) => Math.floor(raw / 2),
  /** Half, but never more than an honest circle tin pays: 5 / 10 / 10 / 10. */
  cappedAtCheapestTin: (raw: number) =>
    Math.min(Math.floor(raw / 2), UNSEAL_SHAPE_SCORE.circle),
  /** A quarter: keeps the dominance, narrows it. 2 / 5 / 8 / 12. */
  quarter: (raw: number) => Math.floor(raw / 4),
} as const satisfies Record<string, UnsealDocsCost>;

/** The rule in force. This line is the retune. */
export const UNSEAL_DOCS_COST: UnsealDocsCost = UNSEAL_DOCS_COSTS.halve;

/**
 * The Lounge: the player you backed got their tin open.
 *
 * **Five, not SPEC.md's ten.** The Lounge rule is the settled one — the better
 * of the two awards, never their sum — and the tuning target is that
 * completing the round on the Floor always beats a perfect Lounge. The
 * cheapest completion here is a circle tin at 10, which is less than half of
 * what the cheapest completion is worth in Plan / Apply (25, because crossing
 * the line means passing all three checkpoints on the way). A Lounge of 10 and
 * 15 would therefore *beat* a player who unsealed, which is the failure
 * SPEC.md's own note on Plan / Apply describes and then fixes.
 *
 * So Plan / Apply's pair, halved: 10 → 5, and 15 → 8, rounding the half up
 * because the round-off should favour the room's loudest seats. A perfect
 * Lounge is 8, and 8 < 10.
 */
export const UNSEAL_BACKED_UNSEALS = 5;

/**
 * The Lounge: the player you backed was fastest in their shape. The better of
 * the two, never their sum. See {@link UNSEAL_BACKED_UNSEALS} for the halving.
 */
export const UNSEAL_BACKED_FASTEST = 8;

/**
 * Split content into the half that may be shown and the half that may not.
 *
 * The same move `splitBoard` makes for the Bridge, and for the same reason: a
 * projection handed a whole {@link UnsealItem} is one object spread away from
 * putting the word on the phone of the person trying to work it out.
 */
export function splitTins(items: readonly UnsealItem[]): {
  tins: readonly UnsealTin[];
  key: readonly UnsealAnswer[];
} {
  return {
    tins: items.map((i) => ({
      shape: i.shape,
      cue: i.cue,
      length: unsealLetters(i.answer).length,
    })),
    key: items.map((i) => ({ answer: i.answer, note: i.note })),
  };
}

/** A word or a cue as bare uppercase letters. Spaces and punctuation go. */
export function unsealLetters(text: string): string[] {
  return [...text.toUpperCase()].filter((c) => /\p{L}/u.test(c));
}

/** Is `cue` a scramble of `answer` — the same letters, in some order? */
export function isScrambleOf(cue: string, answer: string): boolean {
  const a = unsealLetters(cue).sort().join("");
  const b = unsealLetters(answer).sort().join("");
  return a !== "" && a === b;
}

/**
 * Which tin a player of this number gets, given the shape they picked.
 *
 * A tier with more than one word hands them out by arcade player number
 * rather than at random, for three reasons: the engine has no randomness; two
 * people sitting next to each other get different words, so the round cannot
 * be played by watching a neighbour's thumbs; and a replay deals the same tin
 * to the same person. −1 when the shape has no tins at all, which is a
 * configuration the host is refused at the pick.
 */
export function tinIndexFor(
  tins: readonly UnsealTin[],
  shape: UnsealShape,
  playerNumber: number | undefined,
): number {
  const ofShape: number[] = [];
  tins.forEach((t, i) => {
    if (t.shape === shape) ofShape.push(i);
  });
  if (ofShape.length === 0) return -1;
  const n = playerNumber === undefined || playerNumber < 1 ? 1 : playerNumber;
  return ofShape[(n - 1) % ofShape.length]!;
}

/** The tin a player is holding, or undefined before they have picked. */
export function tinFor(
  play: UnsealPlay,
  pid: ParticipantId,
): UnsealTin | undefined {
  const at = play.pick[pid];
  return at === undefined ? undefined : play.tins[at];
}

/** The word in that tin. **The answer.** Never project this. */
export function unsealAnswerFor(
  play: UnsealPlay,
  pid: ParticipantId,
): UnsealAnswer | undefined {
  const at = play.pick[pid];
  return at === undefined ? undefined : play.key[at];
}

/**
 * One player's Floor points for this round, **excluding** the fastest bonus,
 * which is not known until the round ends.
 *
 * Unsealed pays the shape score. A crack pays 2 per letter tapped before it,
 * capped at the shape score so partial credit can never beat completion — for
 * the launch content it cannot come close (an eleven-letter umbrella banks 20
 * against 50) but a host who loads a twenty-letter circle word should not
 * discover that by paying somebody 40 for failing.
 *
 * **Read the docs** is charged by {@link UNSEAL_DOCS_COST}, which by default
 * halves the lot, rounding down: SPEC.md prices the cheat at "halves your
 * score for the round", and the round in question is this one — the Floor. It
 * does not reach into the Lounge, where the points are for something the
 * reader did afterwards and did honestly.
 *
 * `docsCost` is a parameter so a test can price the same round two ways in one
 * assertion. Nothing in the engine passes it: the round is played on the rule
 * the module names.
 */
export function unsealFloorPoints(
  play: UnsealPlay,
  pid: ParticipantId,
  docsCost: UnsealDocsCost = UNSEAL_DOCS_COST,
): number {
  const tin = tinFor(play, pid);
  if (!tin) return 0;
  const score = UNSEAL_SHAPE_SCORE[tin.shape];
  const progress = play.progress[pid] ?? 0;
  const raw =
    progress >= tin.length
      ? score
      : Math.min(progress * UNSEAL_LETTER_BANK, score);
  return play.docs[pid] ? docsCost(raw, tin.shape) : raw;
}

/**
 * The fastest unsealing in each shape, or null where nobody qualified.
 *
 * **A player who read the docs cannot be the fastest in their shape.** SPEC.md
 * does not say so, and this is the one place the round goes beyond it. The
 * button reveals the next letter and may be pressed again for the one after
 * it, so an unanswerable tin can always be finished at half price — which is
 * the design, and is the show's own joke about licking the honeycomb. But a
 * player who bought every letter is by construction the quickest, and leaving
 * them eligible would hand the speed prize to whoever mashed the button
 * hardest and take it off the person who actually knew the word. Halving the
 * cheat's score is the price SPEC sets; it does not also make the cheat the
 * winner.
 *
 * Ties go to whoever got there first, which `unsealOrder` already encodes, so
 * a strict `<` is the whole tie-break.
 */
export function fastestUnseal(
  play: UnsealPlay,
): Readonly<Record<UnsealShape, ParticipantId | null>> {
  const best: Record<UnsealShape, ParticipantId | null> = {
    circle: null,
    triangle: null,
    star: null,
    umbrella: null,
  };
  const bestMs: Record<UnsealShape, number> = {
    circle: Infinity,
    triangle: Infinity,
    star: Infinity,
    umbrella: Infinity,
  };
  for (const pid of play.unsealOrder) {
    if (play.docs[pid]) continue;
    const tin = tinFor(play, pid);
    if (!tin) continue;
    const ms = play.unsealedMs[pid] ?? Infinity;
    if (ms < bestMs[tin.shape]) {
      best[tin.shape] = pid;
      bestMs[tin.shape] = ms;
    }
  }
  return best;
}

/** The +10s, paid when the round ends because that is when they are known. */
export function unsealFastestBonuses(
  play: UnsealPlay,
): Readonly<Record<ParticipantId, number>> {
  const out: Record<ParticipantId, number> = {};
  for (const pid of Object.values(fastestUnseal(play))) {
    if (pid !== null) out[pid] = (out[pid] ?? 0) + UNSEAL_FASTEST_BONUS;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Round 2 — projections                                               */
/* ------------------------------------------------------------------ */

/**
 * One player's private view of their own tin.
 *
 * The only way a cue ever leaves the engine, and it is per player by
 * construction: there is no public view of the tins at all. Publishing the
 * list would say which word sits behind each shape, and "pick your shape
 * before you know the word" is the entire round.
 *
 * `solved` is the prefix they have already tapped — theirs, because they
 * tapped it — and never the rest of the word. The remaining letters are in
 * `key` and stay there until `revealRound`.
 */
export interface UnsealMeView {
  readonly shape: UnsealShape | null;
  /** Null until the Floor opens: the tin is handed over, then opened. */
  readonly cue: string | null;
  readonly length: number;
  readonly progress: number;
  /** What they have tapped so far, in order. Never more than that. */
  readonly solved: string;
  readonly docs: boolean;
  readonly unsealed: boolean;
  readonly cracked: boolean;
}

export function unsealMeView(
  arcade: ArcadeState,
  play: UnsealPlay,
  pid: ParticipantId,
): UnsealMeView {
  const tin = tinFor(play, pid);
  const progress = play.progress[pid] ?? 0;
  // The tin is handed over at the pick and opened when the Floor opens. Before
  // that the phone knows its shape and nothing else, which is the promise the
  // shape picker makes.
  const open = arcade.phase === "running" || arcade.phase === "reveal";
  const answer = unsealAnswerFor(play, pid);
  return {
    shape: tin?.shape ?? null,
    cue: tin && open ? tin.cue : null,
    length: tin?.length ?? 0,
    progress,
    solved:
      answer && open ? unsealLetters(answer.answer).slice(0, progress).join("") : "",
    docs: play.docs[pid] === true,
    unsealed: tin !== undefined && progress >= tin.length,
    cracked: arcade.standing[pid] === "drained",
  };
}

/**
 * The round's public state: what the big screen may show, which is the same
 * thing as what the room may know.
 *
 * Named fields, not a filtered `play`, so that a field added later is private
 * until somebody decides otherwise. Deliberately absent: `tins`, `key`,
 * `pick`, and any per-player letter. What is here is counts and names, which
 * is what a dormitory grid draws.
 */
export interface UnsealFloorView {
  /** How many picked each shape. Numbers, not people. */
  readonly picks: Readonly<Record<UnsealShape, number>>;
  /** How many have their tin open, per shape. */
  readonly unsealed: Readonly<Record<UnsealShape, number>>;
  /** Letters tapped, per player. A count leaks nothing; a letter would. */
  readonly progress: Readonly<Record<ParticipantId, number>>;
  readonly unsealOrder: readonly ParticipantId[];
  readonly fastest: Readonly<Record<UnsealShape, ParticipantId | null>>;
}

export function unsealFloorView(play: UnsealPlay): UnsealFloorView {
  const picks: Record<UnsealShape, number> = {
    circle: 0,
    triangle: 0,
    star: 0,
    umbrella: 0,
  };
  const unsealed: Record<UnsealShape, number> = {
    circle: 0,
    triangle: 0,
    star: 0,
    umbrella: 0,
  };
  for (const [pid, at] of Object.entries(play.pick)) {
    const tin = play.tins[at];
    if (!tin) continue;
    picks[tin.shape] += 1;
    if ((play.progress[pid] ?? 0) >= tin.length) unsealed[tin.shape] += 1;
  }
  return {
    picks,
    unsealed,
    progress: play.progress,
    unsealOrder: play.unsealOrder,
    fastest: fastestUnseal(play),
  };
}

/* ------------------------------------------------------------------ */
/* Round 3 — Tug of Raft                                               */
/* ------------------------------------------------------------------ */

export type TugPlay = Extract<ArcadePlay, { kind: "tug_of_raft" }>;

/** "Every member of the winning side banks 10." Every member, tapping or not. */
export const TUG_PULL_WIN = 10;

/** "…the best on-beat rate on each side (the leader) banks +5, win or lose." */
export const TUG_LEADER_BONUS = 5;

/** "Three pulls, sides reshuffled, so nobody is stuck on a losing side." */
export const TUG_PULLS = 3;

/** "Each pull is 25 seconds." */
export const TUG_PULL_SECONDS = 25;

/** "A heartbeat pulses … at 100 bpm", which is a beat every 600 ms. */
export const TUG_BPM = 100;

/**
 * How close to the beat a tap has to be, as a fraction of the interval.
 *
 * A fifth of a beat either side, which at 100 bpm is ±120 ms. Generous on
 * purpose: this is a room on a video call, and the tap has already had its
 * latency taken off at the socket boundary, so what is left is the spread
 * between thirty phones' touch handlers. It is still well under half a beat,
 * so there is no instant that is on two beats at once and no instant that is
 * on the beat by accident.
 */
export const TUG_BEAT_TOLERANCE = 0.2;

/** "Miss three heartbeats in a row and your node … calls an election." */
export const TUG_MISSES_TO_ELECTION = 3;

/** "…which in this game as in Raft achieves nothing useful for two seconds." */
export const TUG_ELECTION_MS = 2_000;

export function beatMsFor(bpm: number): number {
  return 60_000 / bpm;
}

export function beatToleranceMs(beatMs: number): number {
  return beatMs * TUG_BEAT_TOLERANCE;
}

/** The beat a tap is nearest to, as an index from the pull's start. */
export function beatIndexAt(play: TugPlay, at: number): number {
  return Math.round((at - play.pullStartedAt) / play.beatMs);
}

export interface BeatJudgement {
  /** Which beat the tap is nearest to. */
  readonly beat: number;
  /** Within the window around it. */
  readonly onBeat: boolean;
  /** The node is timed out, so this tap achieves nothing. */
  readonly inElection: boolean;
  /** When the election in force ends. Zero when there is none. */
  readonly electionEndsAt: number;
  /** `lastBeat`, wound forward past every election that has since finished. */
  readonly lastBeat: number;
}

/**
 * Judge one tap: which beat it is on, whether it counts, and whether the node
 * that made it is in the middle of an election.
 *
 * Elections are **derived**, not stored. A node is timed out from the instant
 * of its third consecutively missed beat, for two seconds; the only thing the
 * state has to remember is the last beat the player actually hit, and
 * everything else falls out of arithmetic against `at`. A stored
 * `electionUntil` would be a second fact for a snapshot to disagree with, and
 * — more to the point — the engine has no clock, so it could only ever be
 * written when some *other* event happened to arrive, which is exactly when it
 * is not needed.
 *
 * The loop walks forward through however many elections a long silence
 * produced: a node that says nothing for the whole pull calls an election
 * every three-and-a-bit beats, and a tap at the end of that has to be judged
 * against the last one. It terminates because each election advances
 * `lastBeat` by at least three.
 */
export function resolveBeat(
  play: TugPlay,
  lastBeat: number,
  at: number,
): BeatJudgement {
  const beat = beatIndexAt(play, at);
  const offset = Math.abs(at - (play.pullStartedAt + beat * play.beatMs));
  const onBeat = offset <= beatToleranceMs(play.beatMs);
  let last = lastBeat;
  for (;;) {
    if (beat - last - 1 < TUG_MISSES_TO_ELECTION) {
      return { beat, onBeat, inElection: false, electionEndsAt: 0, lastBeat: last };
    }
    const from =
      play.pullStartedAt + (last + TUG_MISSES_TO_ELECTION) * play.beatMs;
    const to = from + TUG_ELECTION_MS;
    if (at < to) {
      return { beat, onBeat, inElection: true, electionEndsAt: to, lastBeat: last };
    }
    // The election is over and the node is back. Missed beats are counted
    // from the first beat after it ended, not from where it started, or a
    // node would be permanently in the election it called two minutes ago.
    last = Math.ceil((to - play.pullStartedAt) / play.beatMs) - 1;
  }
}

/**
 * Deal the sides for a pull: shuffle, then deal alternately.
 *
 * Alternate dealing rather than a per-player coin flip, because a coin flip
 * gives a 3-against-17 rope often enough to matter in a room of twenty, and a
 * tug of war with one side outnumbered five to one is not a game. This is
 * balanced to within one player by construction.
 *
 * SPEC.md's "split by player-number parity" is what this is a reshuffle *of*:
 * the parity split is the shape of the thing — two roughly equal sides, no
 * captains, nobody choosing — and the seed is what stops the same two sides
 * forming three times.
 */
export function tugSides(
  pids: readonly ParticipantId[],
  seed: number,
): Readonly<Record<ParticipantId, 0 | 1>> {
  const sides: Record<ParticipantId, 0 | 1> = {};
  shuffled(pids, seed).forEach((pid, i) => {
    sides[pid] = (i % 2) as 0 | 1;
  });
  return sides;
}

/**
 * A side for somebody who was not in the room when the pull was dealt.
 *
 * They get one rather than being refused, because "nobody sits out" is the
 * arcade's one hard rule and a person who joins during a pull with no side has
 * nothing at all to do. A hash rather than a re-deal, because re-dealing would
 * move everybody else's side mid-pull.
 */
export function lateSide(seed: number, pid: ParticipantId): 0 | 1 {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < pid.length; i++) {
    h = Math.imul(h ^ pid.charCodeAt(i), 0x01000193) >>> 0;
  }
  return (h & 1) as 0 | 1;
}

/** On-beat taps, per side. The rope on the big screen is the difference. */
export function pullTotals(play: TugPlay): readonly [number, number] {
  let a = 0;
  let b = 0;
  for (const [pid, side] of Object.entries(play.sides)) {
    const n = play.onBeats[pid] ?? 0;
    if (side === 0) a += n;
    else b += n;
  }
  return [a, b];
}

/**
 * The leader on a side: the best on-beat rate, which with one pull length and
 * one heartbeat for everybody is the same ordering as the best count.
 *
 * Nobody leads a side that never tapped — a bonus for "best at doing nothing"
 * is not a bonus — and a tie goes to whoever got to that count first. The
 * sort is over pids so that the answer does not depend on the order two
 * sockets happened to connect in.
 */
export function tugLeader(play: TugPlay, side: 0 | 1): ParticipantId | null {
  let best: ParticipantId | null = null;
  let bestBeats = 0;
  let bestAt = Infinity;
  for (const pid of Object.keys(play.sides).sort()) {
    if (play.sides[pid] !== side) continue;
    const beats = play.onBeats[pid] ?? 0;
    if (beats <= 0) continue;
    const at = play.creditedAt[pid] ?? Infinity;
    if (beats > bestBeats || (beats === bestBeats && at < bestAt)) {
      best = pid;
      bestBeats = beats;
      bestAt = at;
    }
  }
  return best;
}

export interface PullClose {
  /** Null when the rope did not move: an even pull pays nobody the 10. */
  readonly winner: 0 | 1 | null;
  readonly leaders: readonly [ParticipantId | null, ParticipantId | null];
  readonly gained: Readonly<Record<ParticipantId, number>>;
  readonly wins: readonly [number, number];
}

/**
 * Settle a pull.
 *
 * A draw pays nobody the 10 — the rope is where it started, and neither side
 * pulled it over — but both leaders are still paid, because SPEC.md pays the
 * leader "win or lose" and a draw is neither. It matters more than it sounds:
 * a pull where nobody on either side taps is 0–0, and paying both sides 10 for
 * that would be the round rewarding the room for ignoring it.
 */
export function closePull(play: TugPlay): PullClose {
  const [a, b] = pullTotals(play);
  const winner: 0 | 1 | null = a > b ? 0 : b > a ? 1 : null;
  const leaders = [tugLeader(play, 0), tugLeader(play, 1)] as const;
  const gained: Record<ParticipantId, number> = {};
  if (winner !== null) {
    for (const [pid, side] of Object.entries(play.sides)) {
      if (side === winner) gained[pid] = (gained[pid] ?? 0) + TUG_PULL_WIN;
    }
  }
  for (const leader of leaders) {
    if (leader !== null) {
      gained[leader] = (gained[leader] ?? 0) + TUG_LEADER_BONUS;
    }
  }
  return {
    winner,
    leaders,
    gained,
    wins: [
      play.wins[0] + (winner === 0 ? 1 : 0),
      play.wins[1] + (winner === 1 ? 1 : 0),
    ],
  };
}

/** The rest of the round after this pull, for `ArcadeState.endsAt`. */
export function tugRemainingMs(play: TugPlay, pull: number): number {
  return Math.max(0, play.pulls - pull - 1) * play.pullSeconds * 1000;
}

/* ------------------------------------------------------------------ */
/* Round 4 — Gganbu                                                    */
/* ------------------------------------------------------------------ */

export type GganbuPlay = Extract<ArcadePlay, { kind: "gganbu" }>;

/** "You each hold ten Vault tokens." */
export const GGANBU_START_TOKENS = 10;

/** "…and a wager of 1 to 5 tokens." */
export const GGANBU_MIN_WAGER = 1;
export const GGANBU_MAX_WAGER = 5;

/** "Six Over / Under prompts, 15 seconds each." */
export const GGANBU_PROMPT_SECONDS = 15;

/** "Whoever of the pair holds more takes +10." */
export const GGANBU_AHEAD = 10;

/**
 * The Lounge: the player you backed finished above their rival.
 *
 * **Five, not SPEC.md's ten**, and for the same arithmetic as Unseal. Tokens
 * convert 1:1, everyone starts on ten, and a player who wagers nothing all
 * round finishes on ten: standing still on this Floor pays 10, and the
 * cheapest *win* — holding one token against a revoked rival's nothing — pays
 * 11. A Lounge of 10 and 15 would beat both. Plan / Apply's pair halved, 5 and
 * 8, sits under the lot, and a perfect Lounge is 8.
 */
export const GGANBU_BACKED_AHEAD = 5;

/**
 * The Lounge: the player you backed finished with the most tokens in the room.
 * The better of the two, never their sum.
 */
export const GGANBU_BACKED_RICHEST = 8;

/** Split content into the half that may be shown and the half that may not. */
export function splitPrompts(items: readonly OverUnderItem[]): {
  board: readonly GganbuPrompt[];
  key: readonly GganbuAnswer[];
} {
  return {
    board: items.map((i) => ({ cue: i.cue, threshold: i.threshold })),
    key: items.map((i) => ({
      answer: i.answer,
      note: i.note,
      verify: i.verify,
    })),
  };
}

/**
 * Draw the pairs: shuffle, then pair adjacent.
 *
 * An odd roster leaves one person unpaired, and unpaired means the house —
 * SPEC.md: "an odd person out is paired with the house, played by the
 * Front-End Man". Being the odd one out costs nothing: the house holds ten and
 * never wagers, so beating it is beating the score of a player who stood
 * still, which is exactly what beating any *rival* who stood still would be.
 */
export function gganbuPairs(
  pids: readonly ParticipantId[],
  seed: number,
): Readonly<Record<ParticipantId, ParticipantId>> {
  const order = shuffled(pids, seed);
  const pairs: Record<ParticipantId, ParticipantId> = {};
  for (let i = 0; i + 1 < order.length; i += 2) {
    const a = order[i]!;
    const b = order[i + 1]!;
    pairs[a] = b;
    pairs[b] = a;
  }
  return pairs;
}

/** Tokens held. A latecomer who has not wagered holds the opening stake. */
export function tokensOf(play: GganbuPlay, pid: ParticipantId): number {
  return play.tokens[pid] ?? play.startTokens;
}

/** The house holds the opening stake and never wagers. Beat that. */
export function houseTokens(play: GganbuPlay): number {
  return play.startTokens;
}

/**
 * Who a player is playing against, or null for the house.
 *
 * Null covers three cases and they are deliberately the same case: the odd one
 * out, a latecomer who was not there when the pairs were drawn, and a player
 * whose pair dissolved because one of its halves left the room. All three face
 * a rival who holds ten and does nothing.
 */
export function rivalOf(
  play: GganbuPlay,
  pid: ParticipantId,
): ParticipantId | null {
  if (play.housed[pid]) return null;
  return play.rivals[pid] ?? null;
}

export function rivalTokens(play: GganbuPlay, pid: ParticipantId): number {
  const rival = rivalOf(play, pid);
  return rival === null ? houseTokens(play) : tokensOf(play, rival);
}

/** "Whoever of the pair holds more takes +10." Level pays nobody. */
export function aheadOfRival(play: GganbuPlay, pid: ParticipantId): boolean {
  return tokensOf(play, pid) > rivalTokens(play, pid);
}

/**
 * Who holds the most tokens in the room, as a list because a tie is real.
 *
 * Everyone tied at the top counts, and their backers are all paid. The
 * alternative — one winner, decided by something the room cannot see — would
 * make the biggest Lounge award turn on a tie-break nobody could follow.
 *
 * A revoked player holds nothing and cannot be in here, because reaching zero
 * is what revocation *is*; the empty list is a round where everybody was
 * revoked, which pays no backer anything.
 */
export function richestInTheRoom(play: GganbuPlay): readonly ParticipantId[] {
  let best = 0;
  for (const n of Object.values(play.tokens)) if (n > best) best = n;
  if (best <= 0) return [];
  return Object.keys(play.tokens)
    .filter((pid) => play.tokens[pid] === best)
    .sort();
}

export interface PromptSettlement {
  readonly tokens: Readonly<Record<ParticipantId, number>>;
  /** Who hit zero on this prompt. Their token is revoked; they are drained. */
  readonly revoked: readonly ParticipantId[];
}

/**
 * Settle the open prompt: move the tokens, and revoke whoever reached zero.
 *
 * **This is the only place tokens move**, and that is the round's secrecy
 * rule. Both halves of a pair answer the same prompt with the rival's token
 * count on screen throughout, so a token count that moved when a wager was
 * *placed* would tell you your rival's stake, and a token count that moved
 * when a wager was *judged* would tell you the answer while you were still
 * deciding. Everything waits for the prompt to close, at which point the
 * answer is the room's anyway.
 *
 * A player who did not wager keeps what they hold: no answer is not a wrong
 * answer, it is a wager of nothing.
 */
export function settleGganbuPrompt(play: GganbuPlay): PromptSettlement {
  const answer = play.key[play.at];
  const tokens: Record<ParticipantId, number> = { ...play.tokens };
  const revoked: ParticipantId[] = [];
  if (!answer) return { tokens: play.tokens, revoked: [] };
  for (const [pid, wager] of Object.entries(play.wagers)) {
    const held = tokensOf(play, pid);
    const next =
      wager.pick === answer.answer ? held + wager.amount : held - wager.amount;
    tokens[pid] = Math.max(0, next);
    if (tokens[pid] === 0 && held > 0) revoked.push(pid);
  }
  return { tokens, revoked };
}

/**
 * One player's Floor points: tokens at the buzzer, 1:1, plus the 10 for
 * finishing above their rival.
 *
 * Settled at the end rather than banked along the way, and this is the one
 * round where that is right: tokens are not a checkpoint, they are a stake,
 * and a stake that went up and came back down has not banked anything. A
 * revoked player converts nothing, which is what "reach zero" means.
 */
export function gganbuFloorPoints(
  play: GganbuPlay,
  pid: ParticipantId,
): number {
  return tokensOf(play, pid) + (aheadOfRival(play, pid) ? GGANBU_AHEAD : 0);
}

/* ------------------------------------------------------------------ */
/* Round 4 — projections                                               */
/* ------------------------------------------------------------------ */

/**
 * One player's private view: their tokens, their rival's, and their own wager.
 *
 * `rivalTokens` is the **settled** count and can be nothing else: it is read
 * off `play.tokens`, which does not move until the prompt closes.
 *
 * `rivalCommitted` is here on purpose and is the one tell the round allows. It
 * says that they have wagered, never what: the same line trivia draws between
 * "24 of 27 answered" and the answers themselves. Watching a rival lock in
 * fast is a read on their confidence, and reading your gganbu is the round.
 */
export interface GganbuMeView {
  readonly tokens: number;
  /** Null means the house: the odd one out, or a rival who left. */
  readonly rival: ParticipantId | null;
  readonly rivalTokens: number;
  readonly rivalCommitted: boolean;
  readonly committed: boolean;
  /** Their own wager on the open prompt. Theirs, because they made it. */
  readonly wager: Wager | null;
  readonly revoked: boolean;
}

export function gganbuMeView(
  arcade: ArcadeState,
  play: GganbuPlay,
  pid: ParticipantId,
): GganbuMeView {
  const rival = rivalOf(play, pid);
  return {
    tokens: tokensOf(play, pid),
    rival,
    rivalTokens: rivalTokens(play, pid),
    rivalCommitted: rival !== null && rival in play.wagers,
    committed: pid in play.wagers,
    wager: play.wagers[pid] ?? null,
    revoked: arcade.standing[pid] === "drained",
  };
}

/**
 * The round's public state.
 *
 * `tokens` is public and safe: it only ever holds settled counts, so it says
 * who is winning and never what the open prompt's answer is. `wagered` is a
 * count, for "18 of 27 have wagered". `wagers` itself is not here, and
 * `key` — the answers — is not here either.
 */
export interface GganbuFloorView {
  readonly at: number;
  readonly of: number;
  readonly prompt: GganbuPrompt | undefined;
  readonly promptEndsAt: number;
  readonly tokens: Readonly<Record<ParticipantId, number>>;
  readonly wagered: number;
  readonly richest: readonly ParticipantId[];
}

export function gganbuFloorView(play: GganbuPlay): GganbuFloorView {
  return {
    at: play.at,
    of: play.board.length,
    prompt: play.board[play.at],
    promptEndsAt: play.promptEndsAt,
    tokens: play.tokens,
    wagered: Object.keys(play.wagers).length,
    richest: richestInTheRoom(play),
  };
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

/**
 * The Floor's own bet: a wave waiting its turn backs the wave in front of it.
 *
 * SPEC.md's "nobody sits out" is the arcade's design constraint, and on this
 * bridge it was the one round that broke it: with three waves and thirty
 * people, two thirds of the room are on the Floor with nothing to press for
 * up to two minutes. The Lounge is not open to them — they have not been
 * drained — so "watching intently" had no mechanic under it at all.
 *
 * Half of the Lounge's pair, by the precedent Unseal and Gganbu already set
 * for a halved pair, and for a reason neither of those has: a waiting wave is
 * paid for this round twice, once by their own crossing and once by the bet.
 * At 5 and 8 the bet is worth having and is nowhere near what walking across
 * is worth — the cheapest full crossing is six steps and the far side, 45 —
 * so nobody is ever better off watching than stepping, which is the tuning
 * rule the whole scoring table is held to.
 */
export const GLASS_WAITING_CROSSES = 5;

/** As {@link GLASS_WAITING_CROSSES}: the better of the two, never their sum. */
export const GLASS_WAITING_FASTEST = 8;

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
    lounge[pid] = drainSeat(arcade.lounge[pid], now);
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
 *
 * Its *size* is here as `onPanes`, and that is a different thing: a number
 * names nobody. It is also already public twice over, because every commit
 * either raises that player's `position` or drains them and both are drawn in
 * the room a beat later. It is carried because the phone has to draw the
 * waiting wave's bet under exactly the lock the engine enforces — open until
 * the crossing wave puts its first foot down — and a phone that has to guess
 * at that draws a button the engine then refuses.
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
  /** How many of the crossing wave have committed to a pane at this step. */
  readonly onPanes: number;
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
    onPanes: Object.keys(play.stepped).length,
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
 * The seat a drain puts somebody in.
 *
 * Written as one function because a drain can find a seat already there: on
 * the Bridge a wave waiting to cross may have placed a bet from the Floor and
 * then fallen at its own first step. The bet stands — it was placed before
 * the wave it names walked on, which is the only thing the round asks of it —
 * and `placedFrom` keeps it paid at the rate it was placed at.
 */
export function drainSeat(
  seat: LoungeSeat | undefined,
  now: number,
): LoungeSeat {
  if (seat) return { ...seat, at: now };
  return { backing: null, at: now, placedAt: null, placedFrom: "drained" };
}

/**
 * Whether a bet was placed before the outcome it is betting on.
 *
 * A round's Floor is a public surface — the big screen draws who has crossed,
 * whose tin is open and who is fastest, because that is the round's theatre —
 * so a bet that may be changed until the Floor locks can be placed on a
 * result that has already happened. Drained at 90 resources in Plan / Apply,
 * watch the screen until somebody crosses and then name them: 15 banked and
 * 15 for a certainty, which is level with an honest third-place crossing and
 * more than every crossing after it. That is not a bet, and the Lounge is
 * only worth having if it is one.
 *
 * Only two rounds can leak an outcome this way and they are the two with a
 * per-player finish: Plan / Apply's crossings and Unseal's open tins. The
 * Bridge is already covered by a rule of its own — a bet there may only name
 * a later wave, and locks when that wave walks on — and Gganbu's outcome is
 * the token count at the buzzer, which is after the Floor has locked and
 * nobody can still be betting.
 */
export function betStands(
  play: ArcadePlay,
  seat: LoungeSeat,
  startedAt: number | null,
): boolean {
  const backing = seat.backing;
  if (backing === null) return false;
  // A bet with no placement came out of a snapshot written before bets were
  // timed, which is one process restart inside one round. Paying it is the
  // better of the two failures: the alternative drops a bet somebody really
  // did place, in front of them, with nothing to show why.
  //
  // `== null` rather than `=== null`, and it is not a style choice: a seat
  // restored from such a snapshot has the key *absent*, not null, because
  // rehydrate() runs no arcade migration. The types say the field is there
  // and for every seat this build writes it is; the one shape that reaches
  // here without it is the one shape this branch exists for.
  if (seat.placedAt == null) return true;
  const placedAt = seat.placedAt;
  switch (play.kind) {
    case "plan_apply": {
      // Same reasoning one field along: a pre-change `plan_apply` play has no
      // `finishedAt` at all, and an unguarded index on it throws inside
      // endRound — which settles the whole round, not just this seat.
      const crossedAt = play.finishedAt?.[backing];
      return crossedAt === undefined || placedAt < crossedAt;
    }
    case "unseal": {
      const ms = play.unsealedMs[backing];
      // Measured from the Floor opening, as `unsealedMs` is. A round with no
      // `startedAt` has not opened, so nothing has been unsealed in it.
      if (ms === undefined || startedAt === null) return true;
      return placedAt < startedAt + ms;
    }
    case "recruitment":
    case "tug_of_raft":
    case "gganbu":
    case "glass_bridge":
      return true;
  }
}

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
    case "unseal": {
      // Same shape, different numbers: the cheapest completion on this Floor
      // is a circle tin at 10, so the pair is halved. See
      // UNSEAL_BACKED_UNSEALS.
      const fastest = fastestUnseal(play);
      if (UNSEAL_SHAPES.some((shape) => fastest[shape] === backing)) {
        return UNSEAL_BACKED_FASTEST;
      }
      return play.unsealOrder.includes(backing) ? UNSEAL_BACKED_UNSEALS : 0;
    }
    case "tug_of_raft":
      // Nobody drains in Tug of Raft, so nobody is ever in the Lounge for it,
      // so there is nothing to pay. SPEC.md's table says the same with a dash.
      return 0;
    case "gganbu": {
      if (richestInTheRoom(play).includes(backing)) {
        return GGANBU_BACKED_RICHEST;
      }
      return aheadOfRival(play, backing) ? GGANBU_BACKED_AHEAD : 0;
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
 * What a bet placed from the Floor pays: the Lounge's awards, halved.
 *
 * Only the Bridge has such a bet — it is the only round where being on the
 * Floor and being able to play are different things — so every other round
 * pays nothing here rather than pretending to have a waiting wave.
 */
export function waitingPoints(
  play: ArcadePlay,
  backing: ParticipantId,
  backedStanding: ArcadeStanding | undefined,
): number {
  if (play.kind !== "glass_bridge") return 0;
  if (backedStanding !== "floor") return 0;
  if (fastestCrossing(play) === backing) return GLASS_WAITING_FASTEST;
  return play.crossOrder.includes(backing) ? GLASS_WAITING_CROSSES : 0;
}

/**
 * What one seat is paid when the round settles.
 *
 * The three rules in the order they apply: a bet that was placed after the
 * result it names is not a bet, a bet placed from the Floor pays the waiting
 * rate, and everything else is the Lounge's own table.
 */
export function betPoints(
  play: ArcadePlay,
  seat: LoungeSeat,
  backedStanding: ArcadeStanding | undefined,
  startedAt: number | null,
): number {
  const backing = seat.backing;
  if (backing === null) return 0;
  if (!betStands(play, seat, startedAt)) return 0;
  return seat.placedFrom === "floor"
    ? waitingPoints(play, backing, backedStanding)
    : loungePoints(play, backing, backedStanding);
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
    case "unseal":
      // The best tin on offer, unsealed fastest: 50 + 10 = 60.
      return (
        config.items.reduce(
          (best, i) => Math.max(best, UNSEAL_SHAPE_SCORE[i.shape]),
          0,
        ) + UNSEAL_FASTEST_BONUS
      );
    case "tug_of_raft":
      // Win every pull and lead your side every time: 3 × (10 + 5) = 45.
      return config.pulls * (TUG_PULL_WIN + TUG_LEADER_BONUS);
    case "gganbu":
      // A perfect run — five tokens on six prompts, all right — converts at
      // 1:1, plus the 10 for finishing above your rival: 10 + 30 + 10 = 50.
      return (
        config.startTokens +
        config.prompts.length * GGANBU_MAX_WAGER +
        GGANBU_AHEAD
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
 * cumulative — the better of the two, never their sum — and the tuning target
 * is that **completing the round on the Floor always beats a perfect Lounge**.
 *
 * The numbers differ per round because the Floors do. Plan / Apply and the
 * Bridge both make completion expensive: crossing the line means passing all
 * three checkpoints on the way (25 at worst) and reaching the far side means
 * six steps and the 15 (45 at worst), so a perfect Lounge of 15 sits well
 * under both. Unseal's cheapest completion is a circle tin at 10, and Gganbu's
 * is a player who wagered nothing and converts their opening ten; a Lounge of
 * 15 would beat either, so those two rounds use Plan / Apply's pair halved —
 * 5 and 8 — and a perfect Lounge there is 8.
 *
 * **SPEC.md's summary table still says 25 for Unseal and for Gganbu.** That
 * predates the decision that the awards do not stack, and those two rows need
 * correcting to 8. The Floor figures in that table are all correct and none of
 * them moved.
 *
 * The literal reading of SPEC's sentence still cannot hold for *every* Floor
 * outcome, and no choice of constants would make it: a player who survives the
 * whole round without reaching a single checkpoint banks nothing, and nothing
 * is less than a perfect Lounge. That is the intended shape, not a bug —
 * banked progress is what the Floor pays for, and someone who neither
 * progressed nor was drained has not done more than a backer who picked the
 * winner. Unseal has one more case of the same kind: a player who chooses to
 * halve their own score by reading the docs has chosen to score less, and
 * there is no constant that protects them from that either.
 */
export function loungeMax(round: ArcadeRoundKind): number {
  switch (round) {
    case "plan_apply":
      return Math.max(PLAN_APPLY_BACKED_CROSSES, PLAN_APPLY_BACKED_WINS);
    case "glass_bridge":
      return Math.max(GLASS_BACKED_CROSSES, GLASS_BACKED_FASTEST);
    case "unseal":
      return Math.max(UNSEAL_BACKED_UNSEALS, UNSEAL_BACKED_FASTEST);
    case "gganbu":
      return Math.max(GGANBU_BACKED_AHEAD, GGANBU_BACKED_RICHEST);
    // Neither of these drains, so neither has a Lounge to pay.
    case "recruitment":
    case "tug_of_raft":
      return 0;
  }
}

/**
 * Close the Floor: whatever this round still owes, before the Lounge is paid.
 *
 * Three of the six rounds bank everything as it happens and have nothing to do
 * here. The other three have an award that cannot be known until the round
 * stops moving:
 *
 * - **The Glass Bridge** has a last step with no `nextStep` after it, so the
 *   round's end is what closes it — draining whoever never stepped and
 *   publishing the pane that broke.
 * - **Unseal** cannot know who was fastest in a shape until nobody else can
 *   still be faster.
 * - **Tug of Raft** settles its last pull here, exactly as the Bridge settles
 *   its last step.
 * - **Gganbu** settles its last prompt here, and only then converts tokens to
 *   points: a stake is not a checkpoint, and a token count that went up and
 *   came back down has banked nothing.
 *
 * Idempotent in the ways that matter — `endRound` is refused unless a round is
 * running, so it runs once.
 */
export function closeRound(
  state: SessionState,
  arcade: ArcadeState,
  now: number,
): ArcadeState {
  const play = arcade.play;
  if (!play) return arcade;
  switch (play.kind) {
    case "recruitment":
    case "plan_apply":
      return arcade;
    case "glass_bridge": {
      const close = closeGlassStep(state, arcade, play, now);
      return {
        ...arcade,
        standing: close.standing,
        lounge: close.lounge,
        play: { ...play, broken: close.broken },
      };
    }
    case "unseal": {
      const banked: Record<ParticipantId, number> = { ...arcade.banked };
      for (const [pid, bonus] of Object.entries(unsealFastestBonuses(play))) {
        banked[pid] = (banked[pid] ?? 0) + bonus;
      }
      return { ...arcade, banked };
    }
    case "tug_of_raft": {
      const close = closePull(play);
      const banked: Record<ParticipantId, number> = { ...arcade.banked };
      for (const [pid, gain] of Object.entries(close.gained)) {
        banked[pid] = (banked[pid] ?? 0) + gain;
      }
      return { ...arcade, banked, play: { ...play, wins: close.wins } };
    }
    case "gganbu": {
      // The open prompt settles first — it is the sixth one, and the tokens it
      // moves are the tokens that convert.
      const settled = settleGganbuPrompt(play);
      const standing: Record<ParticipantId, ArcadeStanding> = {
        ...arcade.standing,
      };
      const lounge: Record<ParticipantId, LoungeSeat> = { ...arcade.lounge };
      for (const pid of settled.revoked) {
        standing[pid] = "drained";
        lounge[pid] = drainSeat(arcade.lounge[pid], now);
      }
      const closed: GganbuPlay = {
        ...play,
        tokens: settled.tokens,
        wagers: {},
      };
      // Tokens convert at the buzzer, 1:1, plus the 10 for finishing above
      // your rival. Everyone who was in the round converts, including the
      // revoked, who convert nothing.
      const banked: Record<ParticipantId, number> = { ...arcade.banked };
      // The standings fixed at `startRound`, plus anybody holding tokens who
      // is not in them — a latecomer, dealt in by their first wager.
      for (const pid of new Set([
        ...Object.keys(standing),
        ...Object.keys(closed.tokens),
      ])) {
        const points = gganbuFloorPoints(closed, pid);
        if (points > 0) banked[pid] = (banked[pid] ?? 0) + points;
      }
      return { ...arcade, standing, lounge, banked, play: closed };
    }
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
    const points = betPoints(
      arcade.play,
      seat,
      arcade.standing[seat.backing],
      arcade.startedAt,
    );
    if (points > 0) banked[pid] = (banked[pid] ?? 0) + points;
  }

  const totals: Record<ParticipantId, number> = { ...arcade.totals };
  // Everybody who was in the round: the standings fixed at `startRound`, plus
  // anybody who banked without being in them. That second half is a latecomer
  // — somebody who joined after the round started, was put on the Floor by
  // playing, and scored. Without them, a person who joined at minute two and
  // won the round would have their points quietly dropped on the floor.
  for (const pid of new Set([
    ...Object.keys(arcade.standing),
    ...Object.keys(banked),
  ])) {
    totals[pid] = (totals[pid] ?? 0) + (banked[pid] ?? 0);
  }

  return { banked, totals };
}
