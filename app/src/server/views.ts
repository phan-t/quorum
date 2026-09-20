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
import { checkpointsFor, glassFloorView, glassMeView } from "../engine/arcade.ts";
import type {
  ArcadeState,
  ParticipantId,
  Question,
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
  ArcadePlanApplyView,
  ArcadeRecruitmentView,
  ArcadeView,
  OwnPoints,
  RenderState,
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
 * - `answered`/`eligible` go to the surfaces that show a count.
 */
export function triviaViewFor(
  state: SessionState,
  trivia: TriviaState,
  role: Role,
): TriviaView | undefined {
  const question = trivia.questions[trivia.at];
  if (!question) return undefined;

  const isHost = role === "host";
  const revealed = trivia.phase === "revealed";
  // "idle" is a question the host has not opened. The room has not seen it.
  const visible = isHost || trivia.phase !== "idle";
  const winner = trivia.suddenDeathWinner;

  const base: TriviaView = {
    activityId: trivia.activityId,
    index: trivia.at,
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
    round: roundAt(trivia.questions, trivia.at),
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

/** Everyone who could be playing: the roster's filter, not the roster. */
function arcadeEligible(state: SessionState): number {
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
    // SPEC: "Six items, 20 seconds each". The item has its own deadline and
    // it is not the round's — the round's is the *last* item's — so a surface
    // that drew `endsAt` in the item-timer slot was counting down two minutes
    // at somebody who has twenty seconds. Absolute, like every other instant
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
 *   one that broke. Nothing here puts it back: `stepped` is not projected at
 *   all, and there is no per-player field that a break can be joined against.
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
  if (isHost || running) extra.step = floor.step;
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
    planApply = {
      resources: play.resources[pid] ?? 0,
      ...(place === -1 ? {} : { place: place + 1 }),
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
    ...(seat ? { drainedAt: seat.at } : {}),
    ...(recruitment ? { recruitment } : {}),
    ...(planApply ? { planApply } : {}),
    ...(glass ? { glass } : {}),
  };
}

export function renderStateFor(
  state: SessionState,
  opts: ViewOptions,
): RenderState {
  const all = computeStandings(state);
  const roster = rosterOf(state, opts.lastSeen, opts.now);

  // The host sees everything: they cannot run the session blind, and sealing
  // is about what the *room* sees.
  const rows =
    opts.role === "host"
      ? topFive(all) // the console may see an expanded tie
      : state.seal === "sealed"
        ? []
        : publicStandings(all); // the wire never carries more than five
  const visible: StandingRow[] = rows.map((s) => toRow(state, s));

  const activities: ActivitySummary[] = state.activities.map((a) => ({
    id: a.id,
    title: a.title,
    kind: a.kind,
    spotCap: a.spotCap,
    spotsLeft: spotsRemaining(state, a),
  }));

  let own: OwnPoints | undefined;
  if (opts.role === "participant" && opts.pid && state.seal !== "sealed") {
    const mine = all.find((s) => s.pid === opts.pid);
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

  const trivia = triviaStateOf(state);
  const triviaView = trivia ? triviaViewFor(state, trivia, opts.role) : undefined;
  const arcade = arcadeStateOf(state);
  const arcadeView = arcade ? arcadeViewFor(state, arcade, opts.role) : undefined;

  const base: RenderState = {
    sid: state.sid,
    title: state.title,
    phase: state.phase,
    segment: state.segment,
    seal: state.seal,
    holding: state.holding,
    roster,
    joinsLocked: state.joinsLocked,
    standings: visible,
    activities,
    ...(triviaView ? { trivia: triviaView } : {}),
    ...(arcadeView ? { arcade: arcadeView } : {}),
  };

  if (opts.role === "screen") {
    return { ...base, joinCode: state.joinCode };
  }
  if (opts.role === "host") {
    return {
      ...base,
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
    };
  }
  const mine =
    trivia && opts.pid ? triviaMineFor(trivia, opts.pid) : undefined;
  const arcadeMine =
    arcade && opts.pid ? arcadeMineFor(state, arcade, opts.pid) : undefined;
  return {
    ...base,
    ...(own ? { own } : {}),
    ...(mine ? { triviaMine: mine } : {}),
    ...(arcadeMine ? { arcadeMine } : {}),
  };
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
