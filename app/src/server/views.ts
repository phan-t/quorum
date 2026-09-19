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
import type {
  ParticipantId,
  Question,
  SessionState,
  TriviaState,
} from "../engine/types.ts";
import type {
  ActivitySummary,
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
      },
    };
  }
  const mine =
    trivia && opts.pid ? triviaMineFor(trivia, opts.pid) : undefined;
  return {
    ...base,
    ...(own ? { own } : {}),
    ...(mine ? { triviaMine: mine } : {}),
  };
}
