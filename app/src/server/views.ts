/**
 * Projection: SessionState -> what one role is allowed to see.
 *
 * The seal and the top-five rule are enforced *here*, not in the client.
 * Sending thirty phones the full ranking and asking them to render five of it
 * would make the rule a suggestion — anyone with devtools could read the rest,
 * and a sealed board would still be sitting in the page's memory.
 */

import {
  computeStandings,
  publicStandings,
  spotsRemaining,
  topFive,
  type Standing,
} from "../engine/scoring.ts";
import {
  UNSEAL_SHAPES,
  UNSEAL_SHAPE_SCORE,
  TUG_ELECTION_MS,
  TUG_MISSES_TO_ELECTION,
  beatToleranceMs,
  checkpointsFor,
  glassFloorView,
  glassMeView,
  pullTotals,
  tugLeader,
  unsealFloorView,
  unsealMeView,
} from "../engine/arcade.ts";
import { currentQuestion } from "../engine/trivia.ts";
import { longestSlide, partsOf, slideMs } from "../engine/sendoff.ts";
import type {
  ArcadeState,
  ParticipantId,
  Question,
  SendoffState,
  SessionState,
  TriviaState,
} from "../engine/types.ts";
import type {
  ActivitySummary,
  ArcadeCell,
  ArcadeGlassRecapStep,
  ArcadeGlassStep,
  ArcadeGlassView,
  ArcadeMine,
  ArcadeMineGlass,
  ArcadeMinePlanApply,
  ArcadeMineRecruitment,
  ArcadeMineTug,
  ArcadeMineUnseal,
  ArcadePlanApplyRunner,
  ArcadePlanApplyView,
  ArcadeRecruitmentView,
  ArcadeTugView,
  ArcadeUnsealRecap,
  ArcadeUnsealShape,
  ArcadeUnsealView,
  ArcadeView,
  OwnPoints,
  RenderState,
  SendoffView,
  Role,
  RosterEntry,
  ScoreRow,
  StandingRow,
  TriviaMine,
  TriviaPodiumRow,
  TriviaRound,
  TriviaView,
} from "../protocol.ts";

/** Silent for this long and the console shows amber. Not a disconnect. */
export const AWAY_AFTER_MS = 30_000;

export function rosterOf(
  state: SessionState,
  lastSeen: ReadonlyMap<ParticipantId, number>,
  now: number,
): RosterEntry[] {
  return Object.values(state.participants)
    // Kicked, or released: released clears the collision key, and until the
    // person rejoins they are not in the room. Their score is kept on the
    // record so a phone swap does not cost them anything.
    .filter((p) => !p.kicked && p.nicknameKey !== "")
    .sort((a, b) => a.playerNumber - b.playerNumber)
    .map((p) => {
      const seen = lastSeen.get(p.pid) ?? 0;
      const away = !p.connected || now - seen > AWAY_AFTER_MS;
      return {
        pid: p.pid,
        nickname: p.nickname,
        playerNumber: p.playerNumber,
        conn: away ? ("away" as const) : ("on" as const),
      };
    });
}

export interface ViewOptions {
  readonly role: Role;
  readonly pid?: ParticipantId;
  readonly lastSeen: ReadonlyMap<ParticipantId, number>;
  readonly now: number;
}

function toRow(state: SessionState, s: Standing): StandingRow {
  const perActivity: Record<string, number | null> = {};
  const bench: string[] = [];
  for (const a of state.activities) {
    const cell = s.perActivity[a.id];
    perActivity[a.id] = cell?.points ?? null;
    if (cell?.source === "bench") bench.push(a.id);
  }
  return {
    rank: s.rank,
    nickname: s.nickname,
    total: s.total,
    perActivity,
    bench,
    spot: s.spotPoints,
  };
}

/** The console's grid: raw, status, points and totals for everyone. */
function scoreRows(state: SessionState, all: readonly Standing[]): ScoreRow[] {
  return all.map((s) => {
    const raw: Record<string, number | null> = {};
    const status: Record<string, "played" | "bench" | "unset"> = {};
    const points: Record<string, number | null> = {};
    for (const a of state.activities) {
      const cell = state.scores[a.id]?.[s.pid];
      raw[a.id] = cell && cell.status === "played" ? cell.raw : null;
      status[a.id] = cell?.status ?? "unset";
      points[a.id] = s.perActivity[a.id]?.points ?? null;
    }
    return {
      pid: s.pid,
      nickname: s.nickname,
      playerNumber: state.participants[s.pid]?.playerNumber ?? 0,
      raw,
      status,
      points,
      spot: s.spotPoints,
      total: s.total,
      rank: s.rank,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Trivia                                                              */
/* ------------------------------------------------------------------ */

/** Null until `loadTrivia`. Named so the call sites read as a question. */
export function triviaStateOf(state: SessionState): TriviaState | null {
  return state.trivia;
}

/**
 * Everyone who could answer: the "27" in "24 of 27 answered".
 *
 * The roster's filter, not the roster itself, because this must not depend on
 * whether a phone happens to be showing amber — a participant whose socket
 * went quiet ten seconds ago is still someone the host is waiting for.
 */
function eligibleCount(state: SessionState): number {
  return Object.values(state.participants).filter(
    (p) => !p.kicked && p.nicknameKey !== "",
  ).length;
}

/**
 * The run of consecutive questions sharing a `Round` value that `index` sits
 * in. Null when the question has no round, or when it is alone in its run —
 * a "round" of one question is a card with nothing behind it.
 */
export function roundAt(
  questions: readonly Question[],
  index: number,
): TriviaRound | null {
  const here = questions[index];
  if (!here || here.round === null || here.round === "") return null;
  let first = index;
  while (first > 0 && questions[first - 1]?.round === here.round) first -= 1;
  let last = index;
  while (last + 1 < questions.length && questions[last + 1]?.round === here.round) {
    last += 1;
  }
  const size = last - first + 1;
  if (size < 2) return null;
  return {
    name: here.round,
    position: index - first + 1,
    size,
    startsHere: index === first,
  };
}

/** Counts per answer index. Length matches `answers`, so a zero is drawn. */
export function distributionOf(
  trivia: TriviaState,
  answerCount: number,
): number[] {
  const out = new Array<number>(answerCount).fill(0);
  for (const answer of Object.values(trivia.answers)) {
    const at = out[answer.choice];
    if (at !== undefined) out[answer.choice] = at + 1;
  }
  return out;
}

/**
 * The activity's own top five, from the trivia totals.
 *
 * SPEC is explicit that this survives the seal — "the trivia's own top five
 * after each question is the trivia; it says who is winning *this activity*,
 * not the session" — so `state.seal` is deliberately not consulted here.
 *
 * Empty until somebody has scored: an unscored board sorted by nickname is an
 * alphabetical slice of the room, not a podium.
 */
export function triviaPodium(
  state: SessionState,
  trivia: TriviaState,
): TriviaPodiumRow[] {
  const rows = Object.entries(trivia.totals)
    .map(([pid, points]) => ({ pid, points, p: state.participants[pid] }))
    .filter((r) => r.p !== undefined && !r.p.kicked)
    .sort((a, b) => b.points - a.points || (a.p?.nickname ?? "").localeCompare(b.p?.nickname ?? ""));
  if (!rows.some((r) => r.points > 0)) return [];

  const out: TriviaPodiumRow[] = [];
  let rank = 0;
  let seen = 0;
  let prev: number | null = null;
  for (const r of rows) {
    seen += 1;
    if (prev === null || r.points !== prev) {
      rank = seen;
      prev = r.points;
    }
    // A hard five. Ties at fifth are cut rather than expanded: the phone and
    // the big screen both have exactly five slots drawn for this.
    if (out.length === 5) break;
    out.push({ rank, nickname: r.p?.nickname ?? "", points: r.points });
  }
  return out;
}

/**
 * One question, projected for one role.
 *
 * Everything conditional in here is a rule from SPEC, and every one of them is
 * enforced by *omission* rather than by a renderer choosing not to draw it:
 *
 * - The question text and the answers do not exist on the wire until the host
 *   opens the question. Before that only the host has them, because the host
 *   is the one about to read it out.
 * - `correct` and `note` reach the room at the reveal and not one frame
 *   earlier. The host has them throughout.
 * - `distribution` is a big-screen thing (DESIGN: "the phone is for *your*
 *   answer"), so a participant never receives it at all.
 * - `answered`/`eligible` go to the surfaces that show a count. The host and
 *   the big screen always. A phone gets them too, but only once *that* phone
 *   has locked in, which is a rule about one participant rather than about a
 *   role, so it is applied in {@link prepareViews} where the pid is known and
 *   not here. It is safe to send: the count says how many people have
 *   answered and never what any of them chose, so there is no choice in it to
 *   leak. Holding it back until the tap is not secrecy either — see
 *   {@link prepareViews}.
 */
export function triviaViewFor(
  state: SessionState,
  trivia: TriviaState,
  role: Role,
): TriviaView | undefined {
  // `currentQuestion`, not `questions[at]`: a sudden-death tiebreaker is not in
  // the scored set, and `at` is deliberately parked out of range while one
  // runs. Reading the array directly used to put the *next unasked* question's
  // text on every phone during a tiebreak, judge the taps against a different
  // question, and read that question's answer out at the reveal.
  const question = currentQuestion(trivia);
  if (!question) return undefined;

  const isHost = role === "host";
  const revealed = trivia.phase === "revealed";
  // "idle" is a question the host has not opened. The room has not seen it.
  const visible = isHost || trivia.phase !== "idle";
  const winner = trivia.suddenDeathWinner;

  const base: TriviaView = {
    activityId: trivia.activityId,
    // A tiebreaker is not "question 4 of 20". It is outside the set, and the
    // surfaces say so by being given no position in it.
    index: trivia.suddenDeath ? -1 : trivia.at,
    of: trivia.questions.length,
    phase: trivia.phase,
    text: visible ? question.text : "",
    answers: visible ? question.answers : [],
    opensAt: trivia.opensAt,
    closesAt: trivia.closesAt,
    timeLimitSec: question.timeLimitSec,
    basePoints: question.basePoints,
    suddenDeath: trivia.suddenDeath,
    suddenDeathWinner:
      winner === null ? null : (state.participants[winner]?.nickname ?? null),
    round: trivia.suddenDeath ? null : roundAt(trivia.questions, trivia.at),
  };

  const extra: {
    correct?: readonly number[];
    distribution?: readonly number[];
    note?: string;
    podium?: readonly TriviaPodiumRow[];
    answered?: number;
    eligible?: number;
  } = {};

  if (isHost || revealed) {
    extra.correct = question.correct;
    if (question.note !== null) extra.note = question.note;
  }
  if (isHost || (role === "screen" && revealed)) {
    extra.distribution = distributionOf(trivia, question.answers.length);
  }
  if (revealed) extra.podium = triviaPodium(state, trivia);
  if (isHost || role === "screen") {
    extra.answered = Object.keys(trivia.answers).length;
    extra.eligible = eligibleCount(state);
  }

  return { ...base, ...extra };
}

/**
 * The participant's own line. Three states, and the middle one is the point:
 * see {@link TriviaMine}. Nothing here reads `question.correct`.
 */
export function triviaMineFor(
  trivia: TriviaState,
  pid: ParticipantId,
): TriviaMine {
  const mine = trivia.answers[pid];
  if (trivia.phase !== "revealed") {
    return mine === undefined
      ? { state: "unanswered" }
      : { state: "locked", choice: mine.choice };
  }
  return {
    state: "revealed",
    choice: mine?.choice ?? null,
    correct: mine?.correct ?? false,
    points: mine?.points ?? 0,
    streakBonus: mine?.streakBonus ?? 0,
    streak: trivia.streaks[pid] ?? 0,
    total: trivia.totals[pid] ?? 0,
  };
}


/* ------------------------------------------------------------------ */
/* Hashi Arcade                                                        */
/* ------------------------------------------------------------------ */

/**
 * How long before the lock the doll's head starts to turn.
 *
 * SPEC.md: "the big screen shows the head beginning to turn 400 ms before the
 * lock". It lives here rather than in the client because it goes on the wire
 * as an absolute epoch — see {@link arcadePlanApplyFor}.
 */
export const LIGHT_TELEGRAPH_MS = 400;

/**
 * How many runners the big screen's ticker carries.
 *
 * A projection decision rather than a styling one, so it is made here: the
 * wire does not carry sixty rows for a corner of the light that has room for a
 * handful. Five is what fits beside the sign at a legible size — the rows are
 * 34 px against DESIGN.md's 32 px floor, next to a 96 px word — and it is the
 * same five the top-five rule uses everywhere else in the product, so the room
 * is not learning a second convention for how long a leaderboard is.
 */
export const PLAN_APPLY_TICKER_ROWS = 5;

/** Null until `enterArcade`. Named so the call sites read as a question. */
export function arcadeStateOf(state: SessionState): ArcadeState | null {
  return state.arcade;
}

/**
 * The dormitory grid: every player number, in arcade order.
 *
 * The same filter as the roster — kicked and released people are not in the
 * room — and sorted by the arcade number rather than by join order, because
 * the grid is read as a grid and 007 sitting between 041 and 012 is not.
 */
export function arcadeGrid(state: SessionState, arcade: ArcadeState): ArcadeCell[] {
  // A drain lasts exactly one round, so "drained" and "drained this round"
  // are the same set, full stop: `startRound` puts everybody back on the
  // Floor, so the strike comes off when the next round's card goes up and not
  // one moment before.
  //
  // It used to be gated on `phase === "running" || "reveal"` as well, and
  // that gate had a hole in the middle of it: `endRound` leaves the phase
  // `idle`, so the strike came off at the end of the round and back on at the
  // reveal a few seconds later. On the big screen that is a grid of pink
  // strikes blinking out and in while the host is talking. The standing is
  // the whole rule; the phase adds nothing to it.
  const backers: Record<ParticipantId, number> = {};
  for (const seat of Object.values(arcade.lounge)) {
    if (seat.backing === null) continue;
    backers[seat.backing] = (backers[seat.backing] ?? 0) + 1;
  }
  return Object.values(state.participants)
    .filter((p) => !p.kicked && p.nicknameKey !== "")
    .map((p) => {
      const standing = arcade.standing[p.pid] ?? "floor";
      return {
        pid: p.pid,
        // The arcade's own number, which is gapless; `playerNumber` is join
        // order and has a hole in it for everyone who was ever kicked.
        playerNumber: arcade.playerNumbers[p.pid] ?? p.playerNumber,
        standing,
        backers: backers[p.pid] ?? 0,
        struck: standing === "drained",
      };
    })
    .sort((a, b) => a.playerNumber - b.playerNumber);
}

/**
 * Everyone who could be playing: the roster's filter, not the roster.
 *
 * Exported because it is the "9" in the Desktop's "9 of 9 answered", and the
 * item timer closes a Recruitment item on that count reaching itself. Two
 * copies of this filter would be the boundary ending the beat on arithmetic
 * the room is not reading.
 */
export function arcadeEligible(state: SessionState): number {
  return Object.values(state.participants).filter(
    (p) => !p.kicked && p.nicknameKey !== "",
  ).length;
}

function numbersOf(
  arcade: ArcadeState,
  state: SessionState,
  pids: readonly ParticipantId[],
): number[] {
  return pids.map(
    (pid) => arcade.playerNumbers[pid] ?? state.participants[pid]?.playerNumber ?? 0,
  );
}

/**
 * Recruitment, projected.
 *
 * `answer` is the entire game: the item is two emoji and a text field, so a
 * phone that has been sent the word has won it. It is therefore sent to the
 * host — who reads it out — and to everybody else at the reveal, and it is
 * *omitted* in between rather than blanked, so the word is not in the bytes.
 *
 * The cue itself waits for the Floor to open. While the round card is up the
 * room is looking at the card, and an emoji pair sitting in a phone's JSON
 * twenty seconds early is twenty seconds of thinking time for one person.
 */
export function arcadeRecruitmentFor(
  state: SessionState,
  arcade: ArcadeState,
  role: Role,
): ArcadeRecruitmentView | undefined {
  const play = arcade.play;
  if (play?.kind !== "recruitment") return undefined;
  const isHost = role === "host";
  const open = arcade.phase === "running" || arcade.phase === "reveal";
  const revealed = arcade.phase === "reveal";
  const item = play.items[play.at];

  const base: ArcadeRecruitmentView = {
    at: play.at,
    of: play.items.length,
    // SPEC: "Six items, 20 seconds each", and the board ships seven. The item
    // has its own deadline and it is not the round's — the round's is the *last*
    // item's — so a surface that drew `endsAt` in the item-timer slot was
    // counting down the whole round at somebody who has twenty seconds. Absolute, like every other instant
    // on this wire, so a frame that arrived late still lines up. Omitted
    // rather than nulled while the round card is up or at the reveal: there is
    // no item running then, and the key is simply not in the bytes.
    ...(arcade.phase === "running" ? { itemEndsAt: play.itemEndsAt } : {}),
  };
  const extra: {
    cue?: string;
    answer?: string;
    note?: string;
    recap?: readonly { cue: string; answer: string; note: string }[];
    answered?: number;
    eligible?: number;
    solved?: number;
    firstThree?: readonly number[];
  } = {};

  if (item && (isHost || open)) extra.cue = item.cue;
  if (item && (isHost || revealed)) {
    extra.answer = item.answer;
    extra.note = item.note;
  }
  if (isHost || revealed) {
    extra.recap = play.items.map((i) => ({
      cue: i.cue,
      answer: i.answer,
      note: i.note,
    }));
  }
  if (isHost || role === "screen") {
    extra.answered = Object.keys(play.answered).length;
    extra.eligible = arcadeEligible(state);
    extra.solved = Object.values(play.answered).filter(Boolean).length;
  }
  // The first three correct, as player numbers, because that is how the
  // announcer says it and the only other way to say it is a nickname in the
  // one place DESIGN.md will not have one.
  if (isHost || revealed) {
    extra.firstThree = numbersOf(arcade, state, play.solvedOrder.slice(0, 3));
  }
  return { ...base, ...extra };
}

/**
 * Plan / Apply, projected. This is the projection the round lives or dies on.
 *
 * `nextChangeAt` is when the light turns, and a phone holding it does not have
 * to watch the screen, does not have to react, and cannot be caught: it can
 * tap flat out and stop 401 ms early, every time. So it is absent from a
 * participant's frame — absent, not null, so there is no key to forget to
 * strip and nothing for devtools to read out to the room.
 *
 * `headTurnsAt` is the same instant minus 400 ms and is sent for the same
 * reason the countdown is sent as `closesAt`: the big screen has to start the
 * wipe at an instant, not after a duration it measured from whenever the
 * frame happened to arrive. It exists only for a turn *into* the lock —
 * going back to PLAN is not a warning, it is a relief.
 *
 * `lightChangedAt` *is* sent. It is the instant the participant is already
 * looking at, it lets a surface fire the light's change exactly once rather
 * than on every repaint (participants join on laptops, so that cue is visual
 * — nothing may depend on a haptic), and it predicts nothing: the next
 * duration is drawn fresh and uniformly between two and six seconds.
 *
 * `leaders` is the ticker, and it goes exactly where `finishOrder` goes.
 * SPEC.md names Plan / Apply's finish order as its example of a Floor being a
 * public surface, so the room is already allowed to read who has crossed; who
 * is on 90 with the light about to turn is less than that and not more,
 * because it is not a result yet. The bet stays a bet at the engine, where
 * `betStands` refuses one placed after the crossing it is betting on, and no
 * field on this view can reach past that.
 */
export function arcadePlanApplyFor(
  state: SessionState,
  arcade: ArcadeState,
  role: Role,
): ArcadePlanApplyView | undefined {
  const play = arcade.play;
  if (play?.kind !== "plan_apply") return undefined;
  const privileged = role === "host" || role === "screen";

  const base: ArcadePlanApplyView = {
    light: play.light,
    lightChangedAt: play.lightChangedAt,
    target: play.target,
    checkpoints: checkpointsFor(play.target),
  };
  if (!privileged) return base;
  return {
    ...base,
    nextChangeAt: play.nextChangeAt,
    ...(play.light === "plan"
      ? { headTurnsAt: play.nextChangeAt - LIGHT_TELEGRAPH_MS }
      : {}),
    crossed: play.finishOrder.length,
    finishOrder: numbersOf(arcade, state, play.finishOrder),
    leaders: planApplyLeaders(state, arcade, play),
  };
}

/**
 * The leading runners, for the ticker in the corner of the light.
 *
 * **Only the Floor.** A drained player's count froze at the instant they were
 * caught, and a frozen 90 sitting at the top of a live leaderboard is a lie
 * about who is about to cross — the more so in this round, where the light
 * covers the dormitory grid and the ticker is the only progress the room can
 * read. Where they went is announced over the light by the drain log, in the
 * error, verbatim, which is the beat DESIGN.md writes for it.
 *
 * Ties break on the player number rather than on whatever order
 * `Object.entries` hands back, so two runners on 60 do not swap places
 * between frames — which at ten taps a second in a room of sixty is a corner
 * of the screen that flickers for no reason anybody watching could name.
 *
 * Runners who have crossed stay on it, on a full bar. They are the round's
 * good news and the ticker is always the *top* few, never the bottom few: a
 * list that turned into the stragglers as the room finished would be a line
 * about specific people that is not something they did well, which DESIGN.md
 * rules out.
 */
function planApplyLeaders(
  state: SessionState,
  arcade: ArcadeState,
  play: Extract<NonNullable<ArcadeState["play"]>, { kind: "plan_apply" }>,
): ArcadePlanApplyRunner[] {
  const rows: ArcadePlanApplyRunner[] = [];
  for (const [pid, resources] of Object.entries(play.resources)) {
    if (resources <= 0) continue;
    if ((arcade.standing[pid] ?? "floor") !== "floor") continue;
    const p = state.participants[pid];
    if (!p || p.kicked || p.nicknameKey === "") continue;
    rows.push({
      playerNumber: arcade.playerNumbers[pid] ?? p.playerNumber,
      resources,
    });
  }
  rows.sort((a, b) =>
    b.resources - a.resources || a.playerNumber - b.playerNumber,
  );
  return rows.slice(0, PLAN_APPLY_TICKER_ROWS);
}

/**
 * Unseal, projected.
 *
 * Built from {@link unsealFloorView}, which is the round's **only public
 * view**, plus one read of `play.key` for the host and for the reveal — the
 * same shape as the bridge below and for the same reason.
 *
 * The round's secret is one thing and it is absolute: **the word in each
 * tin**. It reaches one phone at a time through `unsealMeView`, and never a
 * public surface until `revealRound`. Three things follow, and none of them
 * is absent by being deleted afterwards:
 *
 * - **no cue, anywhere on this view.** The scrambled letters are the word
 *   with the order taken off, and a room that can see all nine cues has a
 *   room that can solve somebody else's tin out loud. `unsealFloorView` does
 *   not carry them and cannot be made to by adding a field to `play`.
 * - **no per-player shape.** `picked` is a count, exactly as the engine makes
 *   it. A shape is a word length, and "Player 017 picked the umbrella" on a
 *   screen three metres from Player 017 is a hint they did not agree to give.
 * - **no length on the picker.** The shapes *are* the lengths, and finding
 *   that out is what choosing one buys you. SPEC.md: "Pick your shape before
 *   you know the word."
 *
 * What *is* public is the score behind each shape — 10 / 20 / 35 / 50 — which
 * is the bet stated in advance, and the counts, which are the round's theatre.
 */
export function arcadeUnsealFor(
  state: SessionState,
  arcade: ArcadeState,
  role: Role,
): ArcadeUnsealView | undefined {
  const play = arcade.play;
  if (play?.kind !== "unseal") return undefined;
  const isHost = role === "host";
  const privileged = isHost || role === "screen";
  const revealed = arcade.phase === "reveal";

  // The only public view there is. Everything below is a subset of it.
  const floor = unsealFloorView(play);
  const has = new Set(play.tins.map((t) => t.shape));

  const shapes: ArcadeUnsealShape[] = UNSEAL_SHAPES.map((shape) => {
    const fastest = floor.fastest[shape];
    return {
      shape,
      available: has.has(shape),
      score: UNSEAL_SHAPE_SCORE[shape],
      picked: floor.picks[shape],
      unsealed: floor.unsealed[shape],
      // The +10 board: the console's running read, and the big screen's
      // *reveal* — never the big screen while the Floor is open. Who is
      // fastest in a shape is a result, and a result on a screen the room can
      // see is a result the Lounge can bet on: back the number the screen has
      // just named and the 8 is a certainty rather than a bet. The engine
      // refuses that bet as well (see betStands), and neither half is
      // sufficient on its own — the rule is that a result does not reach the
      // room before the reveal, and this is where the room is served.
      //
      // Omitted rather than nulled where nobody qualified, so the key is not
      // in the bytes.
      ...((isHost || revealed) && fastest !== null
        ? { fastest: numbersOf(arcade, state, [fastest])[0] ?? 0 }
        : {}),
    };
  });

  const base: ArcadeUnsealView = {
    shapes,
    picked: shapes.reduce((n, s2) => n + s2.picked, 0),
    unsealed: shapes.reduce((n, s2) => n + s2.unsealed, 0),
  };

  const extra: {
    unsealOrder?: readonly number[];
    progress?: Readonly<Record<ParticipantId, number>>;
    docs?: readonly number[];
    cracked?: readonly number[];
    recap?: readonly ArcadeUnsealRecap[];
  } = {};

  if (privileged) {
    extra.unsealOrder = numbersOf(arcade, state, floor.unsealOrder);
  }
  if (isHost) {
    // Counts, never letters: a letter is the prefix of somebody's word. It is
    // on the console because the host is the only reader not in the room.
    extra.progress = floor.progress;
    extra.docs = numbersOf(arcade, state, Object.keys(play.docs));
    // The two damage lists travel together because they are charged together:
    // a cracked tin is halved by the same rule Read the docs pays, so a
    // console holding only the readers would tell the facilitator the wrong
    // set of halved players. It stops at the host for the reason the crack
    // stops before `unsealFloorView` — one tap from draining is a result the
    // Lounge would otherwise get to bet against.
    extra.cracked = numbersOf(arcade, state, Object.keys(play.cracked));
  }
  // The one read of the answer key in this function, and the only one outside
  // the engine. Everything above was built from the public view.
  if (isHost || revealed) {
    extra.recap = play.tins.map((tin, i) => {
      const answer = play.key[i];
      return {
        shape: tin.shape,
        cue: tin.cue,
        answer: answer?.answer ?? "",
        note: answer?.note ?? "",
      };
    });
  }
  return { ...base, ...extra };
}

/**
 * Tug of Raft, projected — which is to say, the heartbeat put on the wire.
 *
 * Nothing here is a secret. Nobody drains, there is no answer and no
 * information asymmetry: SPEC.md builds the round that way deliberately, and
 * the projection's job is a different one. It has to make every surface count
 * **the same beats**.
 *
 * So the beat travels as a grid, not as a tempo. `pullStartedAt` is beat 0
 * and beat *n* is `pullStartedAt + n * beatMs`, absolute server epochs
 * against the client's corrected clock — the same rule as `closesAt` in
 * trivia, `itemEndsAt` in Recruitment and `stepEndsAt` on the bridge, and for
 * a sharper reason than any of them. A surface handed "100 bpm" would start
 * its own interval on whichever frame it happened to receive, drift a little
 * further from the server's grid with every beat of a 25-second pull, and
 * spend the back half of the pull inviting taps against a beat the server is
 * not judging by. There is one clock in this round and it is the server's;
 * every surface draws the same arithmetic on it.
 *
 * `toleranceMs`, `missesToElection` and `electionMs` ride along for the
 * reason `checkpoints` does in Plan / Apply: they are the rule, the engine
 * owns them, and a phone with its own copy is a phone that will one day draw
 * a window the server does not judge by.
 *
 * The three things withheld are withheld out of tidiness rather than secrecy,
 * and the line is DESIGN.md's — every number on the console and nowhere else:
 * everybody's side and the two leaders go to the surfaces that draw the room
 * (the Desktop and the console), and the per-player beat counts the leader is
 * read off go to the console alone. A phone gets its own side and its own
 * count, on {@link ArcadeMineTug}.
 */
export function arcadeTugFor(
  state: SessionState,
  arcade: ArcadeState,
  role: Role,
): ArcadeTugView | undefined {
  const play = arcade.play;
  if (play?.kind !== "tug_of_raft") return undefined;
  const isHost = role === "host";
  const privileged = isHost || role === "screen";
  const running = arcade.phase === "running";
  const [a, b] = pullTotals(play);

  const base: ArcadeTugView = {
    pull: play.pull,
    pulls: play.pulls,
    pullSeconds: play.pullSeconds,
    beatMs: play.beatMs,
    toleranceMs: beatToleranceMs(play.beatMs),
    missesToElection: TUG_MISSES_TO_ELECTION,
    electionMs: TUG_ELECTION_MS,
    // Omitted rather than nulled while the round card is up: the play state
    // carries zeroes until `beginPlay`, and a surface handed a zero would
    // start a heartbeat in 1970 and show every node in an election.
    ...(running
      ? { pullStartedAt: play.pullStartedAt, pullEndsAt: play.pullEndsAt }
      : {}),
    totals: [a, b],
    wins: play.wins,
  };
  if (!privileged) return base;

  const leaders = [tugLeader(play, 0), tugLeader(play, 1)] as const;
  return {
    ...base,
    sides: play.sides,
    leaders: [
      leaders[0] === null ? null : (numbersOf(arcade, state, [leaders[0]])[0] ?? 0),
      leaders[1] === null ? null : (numbersOf(arcade, state, [leaders[1]])[0] ?? 0),
    ],
    ...(isHost ? { onBeats: play.onBeats } : {}),
  };
}

/**
 * The Glass Bridge, projected. This is the round's whole security surface.
 *
 * Built from {@link glassFloorView}, not from `play`, and that is the point
 * rather than a style. `glassFloorView()` is the round's **only public view**:
 * there is no screen-only secret in a room with a projector in it, because
 * the big screen is three metres from the people who have not stepped yet and
 * is the surface waves 2 and 3 are told to read. So every role below takes a
 * *subset* of that one value, and the only thing this function reaches past
 * it for is `play.key`, once, for the host and for the reveal.
 *
 * Two things are therefore absent from every frame before `revealRound`, and
 * neither is absent by being deleted:
 *
 * - **the answer.** `real` and the two notes live in `ArcadePlay.key`, which
 *   `glassFloorView()` does not carry and cannot be made to carry by adding a
 *   field to the play state. The reveal is the one read of it in this file.
 * - **which pane anybody chose.** The engine does not store it, because with
 *   two panes a pane that *held* identifies the real pane exactly as well as
 *   one that broke. Nothing here puts it back: the per-player `stepped` map is
 *   not projected, and there is no per-player field that a break can be joined
 *   against. Its size goes out as `onPanes`, which names nobody and says
 *   nothing the room cannot count off the grid — the phone needs it to draw a
 *   waiting wave's bet under the same lock the engine enforces.
 *
 * `broken` is public on every surface and that is safe because of *when* the
 * engine writes it — only as a step closes, never as a player falls — so by
 * the time an entry is non-null everyone who could have used it has stepped
 * past it. `position` is public for the same reason read the other way round:
 * "X survived step 3" only becomes "X chose pane 0" once `broken[3]` is
 * published, and by then step 3's answer is public anyway.
 *
 * `board` waits for the Floor to open, exactly as Recruitment's cue does. The
 * room is looking at the round card, and eighteen pane labels sitting in a
 * phone's JSON twenty seconds early is twenty seconds of reading that
 * whoever has devtools open gets and nobody else does.
 */
export function arcadeGlassFor(
  state: SessionState,
  arcade: ArcadeState,
  role: Role,
): ArcadeGlassView | undefined {
  const play = arcade.play;
  if (play?.kind !== "glass_bridge") return undefined;
  const isHost = role === "host";
  const privileged = isHost || role === "screen";
  const running = arcade.phase === "running";
  const revealed = arcade.phase === "reveal";
  // The round card is not the bridge. Everything the room reads off the
  // bridge waits for the Floor to open; the host has it throughout, because
  // the host is the one setting the round up.
  const shown = isHost || running || revealed;

  // The only public view there is. Everything below is a subset of it.
  const floor = glassFloorView(play);

  const board: readonly ArcadeGlassStep[] = floor.board.map((b) => ({
    product: b.product,
    labels: b.labels,
  }));

  const base: ArcadeGlassView = {
    wave: floor.wave,
    waveCuts: floor.waveCuts,
    waveSeconds: play.waveSeconds,
    of: floor.board.length,
    broken: floor.broken,
  };

  const extra: {
    board?: readonly ArcadeGlassStep[];
    step?: number;
    onPanes?: number;
    waveStartedAt?: number;
    stepStartedAt?: number;
    stepEndsAt?: number;
    position?: Readonly<Record<ParticipantId, number>>;
    crossed?: readonly number[];
    fastest?: number;
    elapsedMs?: Readonly<Record<ParticipantId, number>>;
    recap?: readonly ArcadeGlassRecapStep[];
  } = {};

  if (shown) {
    extra.board = board;
    extra.position = floor.position;
  }
  // Which step the bridge is on is a fact the host wants while the round card
  // is up — it is what they are about to read out — so it follows `board`.
  if (isHost || running) {
    extra.step = floor.step;
    extra.onPanes = floor.onPanes;
  }
  // The three clocks are omitted rather than nulled when no step is open, and
  // that includes for the host. The play state carries zeroes until
  // `beginPlay`, and a surface handed a zero draws `00:00` at a room that is
  // looking at a round card — which is what the console did until it did not.
  if (running) {
    extra.waveStartedAt = floor.waveStartedAt;
    extra.stepStartedAt = floor.stepStartedAt;
    extra.stepEndsAt = floor.stepEndsAt;
  }
  if (privileged) {
    // The room's results, which belong on the big screen and the console —
    // the same set `planApply.finishOrder` goes to, and for the same reason:
    // the phone shows one person's round. It is not withheld as a secret,
    // and could not be: `position` already says who is across.
    extra.crossed = numbersOf(arcade, state, floor.crossed);
    if (floor.fastest !== null) {
      extra.fastest =
        arcade.playerNumbers[floor.fastest] ??
        state.participants[floor.fastest]?.playerNumber ??
        0;
    }
  }
  if (isHost) extra.elapsedMs = floor.elapsedMs;
  // The one read of the answer key in this file, and the only one anywhere
  // outside the engine. Everything above was built from the public view.
  if (isHost || revealed) {
    extra.recap = play.board.map((b, i) => {
      const answer = play.key[i];
      return {
        product: b.product,
        labels: b.labels,
        real: answer?.real ?? 0,
        notes: answer?.notes ?? ["", ""],
      };
    });
  }
  return { ...base, ...extra };
}

export function arcadeViewFor(
  state: SessionState,
  arcade: ArcadeState,
  role: Role,
): ArcadeView {
  const grid = arcadeGrid(state, arcade);
  const recruitment = arcadeRecruitmentFor(state, arcade, role);
  const planApply = arcadePlanApplyFor(state, arcade, role);
  const unseal = arcadeUnsealFor(state, arcade, role);
  const tug = arcadeTugFor(state, arcade, role);
  const glass = arcadeGlassFor(state, arcade, role);
  return {
    activityId: arcade.activityId,
    round: arcade.round,
    roundIndex: arcade.roundIndex,
    phase: arcade.phase,
    startedAt: arcade.startedAt,
    endsAt: arcade.endsAt,
    grid,
    onFloor: grid.filter((c) => c.standing === "floor").length,
    inLounge: grid.filter((c) => c.standing === "drained").length,
    ...(recruitment ? { recruitment } : {}),
    ...(planApply ? { planApply } : {}),
    ...(unseal ? { unseal } : {}),
    ...(tug ? { tug } : {}),
    ...(glass ? { glass } : {}),
  };
}

/**
 * The participant's own line: their number, where they are, what they have
 * banked, and nothing about anybody else's score.
 */
export function arcadeMineFor(
  state: SessionState,
  arcade: ArcadeState,
  pid: ParticipantId,
): ArcadeMine {
  const seat = arcade.lounge[pid];
  const play = arcade.play;

  let recruitment: ArcadeMineRecruitment | undefined;
  if (play?.kind === "recruitment") {
    const answered = play.answered[pid];
    recruitment =
      answered === undefined
        ? { state: "unanswered" }
        : { state: "locked", correct: answered };
  }

  let planApply: ArcadeMinePlanApply | undefined;
  if (play?.kind === "plan_apply") {
    const place = play.finishOrder.indexOf(pid);
    const backed = seat?.backing ?? null;
    planApply = {
      resources: play.resources[pid] ?? 0,
      ...(place === -1 ? {} : { place: place + 1 }),
      // The one number about somebody else on this frame, and it is the one
      // this phone has already staked points on. Present from the moment the
      // bet is placed, including at nought, because "017 · 0" is the news that
      // your runner has not moved and is the whole reason the Lounge card was
      // silent before this.
      ...(backed === null ? {} : { backedResources: play.resources[backed] ?? 0 }),
    };
  }

  // Unseal, straight off the engine's own per-player view — which is the only
  // way a cue leaves the server at all. Their shape, their letters, the prefix
  // they have already tapped, and nothing whatever about the rest of the word
  // or about anybody else's tin.
  let unseal: ArcadeMineUnseal | undefined;
  if (play?.kind === "unseal") {
    const me = unsealMeView(arcade, play, pid);
    unseal = {
      shape: me.shape,
      cue: me.cue,
      length: me.length,
      progress: me.progress,
      solved: me.solved,
      docs: me.docs,
      unsealed: me.unsealed,
      cracked: me.cracked,
      shattered: me.shattered,
    };
  }

  // Tug of Raft: their end of the rope, their beats, and the last one they
  // hit. `lastBeat` is not a decoration — it is what the phone derives its own
  // election window from, with the same arithmetic the engine uses, because
  // the engine has no clock to store one with. See `resolveBeat`.
  let tug: ArcadeMineTug | undefined;
  if (play?.kind === "tug_of_raft") {
    tug = {
      // Somebody who joined after the sides were dealt has no entry until
      // their first tap deals them one. Side 0 until then, rather than a
      // phone with no rope to pull.
      side: play.sides[pid] ?? 0,
      onBeats: play.onBeats[pid] ?? 0,
      lastBeat: play.lastBeat[pid] ?? -1,
    };
  }

  // The Glass Bridge, straight off the engine's own per-player view, which is
  // exported as the leak-free default: it carries their wave, whether it is
  // their turn, how far along they are and whether their own pane held. It
  // does not carry which pane that was — the engine never stored it — so
  // there is nothing here to strip.
  //
  // `held` is nulled by `glassMeView` until they commit and *omitted* here,
  // so the key is not in the bytes rather than sitting there as null.
  let glass: ArcadeMineGlass | undefined;
  if (play?.kind === "glass_bridge") {
    const me = glassMeView(arcade, play, pid);
    glass = {
      wave: me.wave,
      onTheBridge: me.onTheBridge,
      step: me.step,
      committed: me.committed,
      ...(me.held === null ? {} : { held: me.held }),
      across: me.across,
    };
  }

  return {
    playerNumber:
      arcade.playerNumbers[pid] ?? state.participants[pid]?.playerNumber ?? 0,
    standing: arcade.standing[pid] ?? "floor",
    banked: arcade.banked[pid] ?? 0,
    total: arcade.totals[pid] ?? 0,
    ...(seat?.backing ? { backing: seat.backing } : {}),
    // A seat is not always a drain any more — a waiting wave on the Bridge
    // takes one to place a bet from the Floor — and a `drainedAt` on a player
    // who has not been drained would be a lie a surface could draw.
    ...(seat && seat.at !== null ? { drainedAt: seat.at } : {}),
    ...(recruitment ? { recruitment } : {}),
    ...(planApply ? { planApply } : {}),
    ...(unseal ? { unseal } : {}),
    ...(tug ? { tug } : {}),
    ...(glass ? { glass } : {}),
  };
}

/**
 * The send-off, projected for one surface.
 *
 * `next` is the whole reason this is a projection rather than the state: the
 * host sees the message after this one and nobody else does. Kudos are written
 * by people who did not know the room they would be read into, and one of them
 * will be a joke that does not survive a farewell — a host who can read ahead
 * can skip it without anyone knowing there was something to skip.
 */
export function sendoffViewFor(
  state: SessionState,
  role: ViewOptions["role"],
): SendoffView | undefined {
  const so = state.sendoff;
  if (!so) return undefined;
  const { content, phase, plan } = so;

  // Where the messages fall in the running order, so "9 of 13" counts the
  // room's experience rather than the file's. Cheap enough to walk: the plan
  // is a few dozen slides and this runs once per broadcast per surface.
  const messageSlides: number[] = [];
  plan.forEach((slide, i) => {
    if (slide.kind === "kudo" && slide.part === 0) messageSlides.push(i);
  });

  const here = phase === "run" ? plan[so.at] : undefined;
  const kudoSlide = here?.kind === "kudo" ? here : null;
  const kudo = kudoSlide === null ? null : (content.kudos[kudoSlide.at] ?? null);
  const parts = kudo === null ? null : partsOf(kudo);

  // The ordinal of the message on screen: how many messages have begun at or
  // before this slide.
  const ordinal =
    kudoSlide === null ? 0 : messageSlides.filter((i) => i <= so.at).length;

  const advanceAt =
    phase === "run" && so.auto && so.slideAt !== null && here !== undefined
      ? so.slideAt + slideMs(here, content, so.autoSeconds)
      : null;

  const view: SendoffView = {
    name: content.name,
    subtitle: content.subtitle,
    phase,
    index: ordinal,
    total: content.kudos.length,
    part: kudoSlide === null ? 1 : kudoSlide.part + 1,
    parts: kudoSlide === null ? 1 : kudoSlide.parts,
    kudo:
      kudoSlide === null || kudo === null || kudo === undefined
        ? null
        : { from: kudo.from, message: parts?.[kudoSlide.part] ?? kudo.message },
    longest: longestSlide(content),
    photo: here?.kind === "photo" ? here.key : null,
    photos:
      phase === "closing"
        ? content.closing.photos
        : phase === "run"
          ? plan.flatMap((s) => (s.kind === "photo" ? [s.key] : []))
          : [],
    seconds: content.opening.seconds,
    // Only ever under the photographs, and only before the first message: a
    // track still playing while somebody's words are on the screen is the
    // failure docs/sendoff.md's music section is entirely about.
    // The whole run, not just the photographs before the first message.
    //
    // docs/sendoff.md scoped it to the opening because a track under somebody
    // reading aloud means neither is heard — which is still true, and is why
    // this is a decision about how the room is run rather than a default. The
    // host asked for it across the run, so the messages are read in silence
    // by the people they are for rather than aloud by the host. The element
    // loops, so a clip shorter than the run repeats; see the note in the file
    // about how short a clip the 300KB asset ceiling forces.
    music: phase === "run" ? content.opening.music : null,
    line: phase === "closing" || phase === "done" ? content.closing.line : null,
    auto: so.auto,
    autoSeconds: so.autoSeconds,
    advanceAt,
  };
  if (role !== "host") return view;

  // The next message the room has not had, in running order. At the title
  // card that is the first one; past the last it is nothing, rather than
  // wrapping round to message one and inviting the host to read the set
  // twice.
  const after = messageSlides.find((i) => i > (phase === "run" ? so.at : -1));
  const nextKudo =
    phase === "closing" || phase === "done"
      ? null
      : after === undefined
        ? null
        : content.kudos[(plan[after] as { at: number }).at];
  return {
    ...view,
    next:
      nextKudo === undefined || nextKudo === null
        ? null
        : { from: nextKudo.from, message: nextKudo.message },
  };
}


/**
 * One broadcast's worth of projection, prepared once and handed to every
 * socket.
 *
 * Standings, the roster, the activity list and the trivia, arcade and
 * send-off views are functions of `(state, role)` and of nothing else. Only
 * `own`, `triviaMine`, `arcadeMine` and the trivia answered count differ
 * between two phones, and the count has exactly two values for the room — on
 * for a phone that has locked in, absent for one that has not. Projecting
 * straight per socket therefore recomputed the same standings once per
 * client: at a hundred phones that is a hundred passes over the same scores
 * to produce a hundred byte-identical top fives, on the one path — a credited
 * beat in Tug of Raft — that already runs several times a second. Prepared
 * once, the role-level work happens at most three times per broadcast and the
 * per-phone work is the three fields that are genuinely per-phone.
 *
 * Deliberately not cached *across* broadcasts. `now` is an input — the away
 * flag, the send-off's slide clock and the arcade's timers all read it — so a
 * projection that outlived the instant it was taken at would quietly hand a
 * phone a frame from the past.
 */
export interface PreparedViews {
  /** The console's frame. The host sees everything; they cannot run blind. */
  host(): RenderState;
  /** The big screen's frame. */
  screen(): RenderState;
  /** One phone's frame. `pid` is absent only on a socket still joining. */
  participant(pid?: ParticipantId): RenderState;
}

export function prepareViews(
  state: SessionState,
  lastSeen: ReadonlyMap<ParticipantId, number>,
  now: number,
): PreparedViews {
  const all = computeStandings(state);
  const roster = rosterOf(state, lastSeen, now);

  const activities: ActivitySummary[] = state.activities.map((a) => ({
    id: a.id,
    title: a.title,
    kind: a.kind,
    spotCap: a.spotCap,
    spotsLeft: spotsRemaining(state, a),
  }));

  const trivia = triviaStateOf(state);
  const arcade = arcadeStateOf(state);

  function baseFor(role: Role): RenderState {
    // The host sees everything: they cannot run the session blind, and sealing
    // is about what the *room* sees.
    const rows =
      role === "host"
        ? topFive(all) // the console may see an expanded tie
        : state.seal === "sealed"
          ? []
          : publicStandings(all); // the wire never carries more than five
    const visible: StandingRow[] = rows.map((s) => toRow(state, s));

    const triviaView = trivia ? triviaViewFor(state, trivia, role) : undefined;
    const arcadeView = arcade ? arcadeViewFor(state, arcade, role) : undefined;
    const sendoffView = sendoffViewFor(state, role);

    return {
      sid: state.sid,
      title: state.title,
      subtitle: state.subtitle,
      phase: state.phase,
      segment: state.segment,
      seal: state.seal,
      practice: state.practice,
      ...(sendoffView === undefined ? {} : { sendoff: sendoffView }),
      holding: state.holding,
      roster,
      joinsLocked: state.joinsLocked,
      standings: visible,
      activities,
      ...(triviaView ? { trivia: triviaView } : {}),
      ...(arcadeView ? { arcade: arcadeView } : {}),
    };
  }

  let hostFrame: RenderState | null = null;
  let screenFrame: RenderState | null = null;
  let phoneBase: RenderState | null = null;
  // The trivia block as a phone that has locked in sees it.
  //
  // DESIGN puts "24 of 27 answered" on the console and the Desktop, and over a
  // compressed video call the Desktop is a small tile — so the one piece of
  // tension available to somebody who answered in three seconds and has
  // seventeen left to wait was on the surface they were least able to read. It
  // is a count of how many have answered and never of what anybody answered,
  // so it crosses to the phone carrying nothing with it.
  //
  // It waits for the tap because of what it would do before one, not because
  // of what it could give away: a number climbing under a question somebody is
  // still reading is a second clock, and SPEC already gave them the first one.
  // Every phone that has locked in sees the same numbers, so this is the
  // second and last participant-level variant rather than a spread per socket.
  let phoneCounted: TriviaView | null = null;
  // Built on first use rather than always: the linear scan it replaces was
  // once per phone, and a room that is all screen and console never pays for
  // either.
  let standingByPid: Map<ParticipantId, Standing> | null = null;

  return {
    host(): RenderState {
      return (hostFrame ??= {
        ...baseFor("host"),
        joinCode: state.joinCode,
        hostExtras: {
          joinCode: state.joinCode,
          participantCount: roster.length,
          awayCount: roster.filter((r) => r.conn === "away").length,
          scores: scoreRows(state, all),
          spots: state.spots.map((sp) => ({
            seq: sp.seq,
            pid: sp.pid,
            activityId: sp.activityId,
            reason: sp.reason,
          })),
          ...(trivia
            ? {
                trivia: {
                  answeredBy: Object.keys(trivia.answers),
                  loaded: trivia.questions.length,
                },
              }
            : {}),
          ...(arcade ? { arcade: hostArcade(arcade) } : {}),
        },
      });
    },

    screen(): RenderState {
      // The screen puts the join URL and a QR on the lobby, so it needs the
      // code; a participant has already used it.
      return (screenFrame ??= { ...baseFor("screen"), joinCode: state.joinCode });
    },

    participant(pid?: ParticipantId): RenderState {
      const base = (phoneBase ??= baseFor("participant"));
      let own: OwnPoints | undefined;
      if (pid && state.seal !== "sealed") {
        standingByPid ??= new Map(all.map((s) => [s.pid, s]));
        const mine = standingByPid.get(pid);
        if (mine) {
          own = {
            total: mine.total,
            byActivity: Object.fromEntries(
              state.activities.map((a) => [
                a.id,
                mine.perActivity[a.id]?.points ?? null,
              ]),
            ),
          };
        }
      }
      const mine = trivia && pid ? triviaMineFor(trivia, pid) : undefined;
      const counted =
        trivia && base.trivia && pid && trivia.answers[pid] !== undefined
          ? (phoneCounted ??= {
              ...base.trivia,
              answered: Object.keys(trivia.answers).length,
              eligible: eligibleCount(state),
            })
          : undefined;
      const arcadeMine =
        arcade && pid ? arcadeMineFor(state, arcade, pid) : undefined;
      return {
        ...base,
        ...(counted ? { trivia: counted } : {}),
        ...(own ? { own } : {}),
        ...(mine ? { triviaMine: mine } : {}),
        ...(arcadeMine ? { arcadeMine } : {}),
      };
    },
  };
}

/**
 * One socket's frame, prepared and taken in a single step.
 *
 * The shape every caller outside a broadcast wants — a reconnect, a test, an
 * export. A fan-out uses {@link prepareViews} directly and shares the
 * role-level half.
 */
export function renderStateFor(
  state: SessionState,
  opts: ViewOptions,
): RenderState {
  const views = prepareViews(state, opts.lastSeen, opts.now);
  if (opts.role === "host") return views.host();
  if (opts.role === "screen") return views.screen();
  return views.participant(opts.pid);
}

/**
 * The console's copy of the arcade: every number, for the one surface that is
 * allowed all of them. The host settles the raw score at the end of the
 * arcade, and a host who cannot see who banked what cannot do it.
 */
function hostArcade(arcade: ArcadeState): NonNullable<
  NonNullable<RenderState["hostExtras"]>["arcade"]
> {
  const play = arcade.play;
  const backing: Record<ParticipantId, ParticipantId> = {};
  for (const [pid, seat] of Object.entries(arcade.lounge)) {
    if (seat.backing !== null) backing[pid] = seat.backing;
  }
  return {
    // Who has committed at whatever is open. On the bridge that is the keys
    // of `stepped` and never its values: the value is whether their pane
    // held, and "X survived this step" next to a published break is the one
    // join this round exists to prevent. The host wants to know whether
    // anybody is still deciding, which the keys answer on their own.
    answeredBy:
      play?.kind === "recruitment"
        ? Object.keys(play.answered)
        : play?.kind === "glass_bridge"
          ? Object.keys(play.stepped)
          : // Unseal: who is holding a tin. *Who*, never which tin — the value
            // is an index into the words, and the host's question is only
            // whether anybody is still choosing.
            play?.kind === "unseal"
            ? Object.keys(play.pick)
            : [],
    drained: Object.entries(arcade.standing)
      .filter(([, st]) => st === "drained")
      .map(([pid]) => pid),
    backing,
    banked: { ...arcade.banked },
    totals: { ...arcade.totals },
    resources: play?.kind === "plan_apply" ? { ...play.resources } : {},
  };
}
