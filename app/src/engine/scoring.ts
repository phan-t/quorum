/**
 * Scoring. See SCORING.md — this file implements it and nothing else.
 *
 * The whole system is one rule applied per activity: the top raw score becomes
 * 100 and everyone else scales against it. Raw scores are never added across
 * activities, because activities score in wildly different units.
 *
 * Every function here is pure.
 */

import type {
  Activity,
  ActivityId,
  ParticipantId,
  SessionState,
  SpotAward,
} from "./types.ts";

export const SPOT_AWARD_POINTS = 10;

/** What a participant scored in one activity, and how that number was reached. */
export interface ActivityPoints {
  /** Normalised 0–100, or null when there is nothing to show yet. */
  readonly points: number | null;
  readonly source: "normalised" | "bench" | "unset";
  /** The raw score this came from. Null for bench and unset. */
  readonly raw: number | null;
}

export interface Standing {
  readonly pid: ParticipantId;
  readonly nickname: string;
  readonly perActivity: Readonly<Record<ActivityId, ActivityPoints>>;
  readonly spotPoints: number;
  readonly spotCount: number;
  /** Sum of activity points (treating null as 0) plus spot points. */
  readonly total: number;
  /** 1-based. Ties share a rank and the next rank skips accordingly. */
  readonly rank: number;
}

/**
 * Normalise one activity: top raw among `played` participants becomes 100.
 *
 * Participants on `bench` are excluded from the top calculation — a
 * facilitator's absence must not define the ceiling for everyone else.
 * Returns points only for `played` participants.
 */
export function normaliseActivity(
  state: SessionState,
  activityId: ActivityId,
): Record<ParticipantId, number> {
  const scores = state.scores[activityId] ?? {};
  const counts = (pid: ParticipantId): boolean => {
    const s = scores[pid];
    if (!s || s.status !== "played") return false;
    // A kicked participant must not set the ceiling. Someone removed for
    // joining under an offensive name would otherwise scale the whole room
    // down against a score nobody can see.
    return state.participants[pid]?.kicked !== true;
  };

  let top = 0;
  for (const pid of Object.keys(scores)) {
    if (!counts(pid)) continue;
    const s = scores[pid];
    if (s && s.raw > top) top = s.raw;
  }

  const out: Record<ParticipantId, number> = {};
  for (const pid of Object.keys(scores)) {
    if (!counts(pid)) continue;
    const s = scores[pid];
    if (!s) continue;
    // A top of 0 means nobody scored. Everyone gets 0 rather than NaN.
    out[pid] = top > 0 ? Math.round((100 * s.raw) / top) : 0;
  }
  return out;
}

/**
 * Bench Credit: the mean of this participant's normalised points across the
 * activities they played in full.
 *
 * Returns null when they have played nothing yet — the console shows "—"
 * rather than a misleading zero.
 *
 * The mean is rounded half-up, matching normalisation: 90 and 75 gives 83.
 * Exact halves are common (a raw of 1 against a top of 8), so the rule needs
 * to be stated rather than left to whatever the runtime does.
 */
function benchCredit(
  played: readonly number[],
): number | null {
  if (played.length === 0) return null;
  const sum = played.reduce((a, b) => a + b, 0);
  return Math.round(sum / played.length);
}

/**
 * Spot Awards a participant actually holds.
 *
 * An award for an activity they are on bench credit for does not count.
 * Granting is refused while benched, but benching *after* a grant would
 * otherwise be a back door to keeping it.
 */
function spotsFor(
  state: SessionState,
  pid: ParticipantId,
): { points: number; count: number } {
  const count = state.spots.filter(
    (s) =>
      s.pid === pid && state.scores[s.activityId]?.[pid]?.status !== "bench",
  ).length;
  return { points: count * SPOT_AWARD_POINTS, count };
}

/**
 * Full standings, ranked. Ties share a rank; the following rank skips
 * (two firsts are followed by a third, not a second).
 *
 * Order within a tie is stable and alphabetical, which matters only for
 * display — the tiebreak that decides a prize is {@link breakTie}.
 */
export function computeStandings(state: SessionState): Standing[] {
  const normalised = new Map<ActivityId, Record<ParticipantId, number>>();
  for (const a of state.activities) {
    normalised.set(a.id, normaliseActivity(state, a.id));
  }

  const rows: Omit<Standing, "rank">[] = [];

  for (const pid of Object.keys(state.participants)) {
    const p = state.participants[pid];
    if (!p || p.kicked) continue;

    // First pass: everything they actually played, so bench credit has a base.
    const playedPoints: number[] = [];
    for (const a of state.activities) {
      const pts = normalised.get(a.id)?.[pid];
      if (pts !== undefined) playedPoints.push(pts);
    }
    const credit = benchCredit(playedPoints);

    const perActivity: Record<ActivityId, ActivityPoints> = {};
    for (const a of state.activities) {
      const score = state.scores[a.id]?.[pid];
      const pts = normalised.get(a.id)?.[pid];

      if (pts !== undefined && score) {
        perActivity[a.id] = { points: pts, source: "normalised", raw: score.raw };
      } else if (score?.status === "bench") {
        perActivity[a.id] = { points: credit, source: "bench", raw: null };
      } else {
        perActivity[a.id] = { points: null, source: "unset", raw: null };
      }
    }

    const spot = spotsFor(state, pid);
    const total =
      state.activities.reduce(
        (sum, a) => sum + (perActivity[a.id]?.points ?? 0),
        0,
      ) + spot.points;

    rows.push({
      pid,
      nickname: p.nickname,
      perActivity,
      spotPoints: spot.points,
      spotCount: spot.count,
      total,
    });
  }

  rows.sort((a, b) => b.total - a.total || a.nickname.localeCompare(b.nickname));

  const out: Standing[] = [];
  let rank = 0;
  let seen = 0;
  let prev: number | null = null;
  for (const r of rows) {
    seen += 1;
    if (prev === null || r.total !== prev) {
      rank = seen;
      prev = r.total;
    }
    out.push({ ...r, rank });
  }
  return out;
}

/**
 * Top five, expanding a tie at fifth rather than cutting it alphabetically.
 *
 * **Console and export only.** Expanding the tie is fair to show a host, but
 * it is not safe to send: with everyone on zero — the state of every session
 * before the first score — "the tie at fifth" is the entire room, and sending
 * it puts the full ranking on thirty phones. Participant-facing surfaces use
 * {@link publicStandings}, which caps hard.
 */
export function publicStandings(standings: readonly Standing[]): Standing[] {
  // Before anyone has scored there is no leaderboard, only an alphabetical
  // slice of the room. Show nothing rather than a meaningless five.
  if (!standings.some((s) => s.total > 0)) return [];
  // Hard cap: SCORING.md's rule is "top five only, never the full ranking",
  // and privacy beats the tie-fairness argument that shapes topFive().
  return topFive(standings).slice(0, 5);
}

export function topFive(standings: readonly Standing[]): Standing[] {
  if (standings.length <= 5) return [...standings];
  const fifth = standings[4];
  if (!fifth) return [...standings];
  return standings.filter((s) => s.total >= fifth.total);
}

/**
 * Decide a tie for first place.
 *
 * Walks `tiebreakOrder`, comparing normalised points in each named activity.
 * Returns the winning pid, or null when still tied — which is the signal to
 * run sudden death. There is deliberately no coin flip.
 */
export function breakTie(
  state: SessionState,
  standings: readonly Standing[],
): { winner: ParticipantId | null; tied: ParticipantId[] } {
  const first = standings[0];
  if (!first) return { winner: null, tied: [] };

  const tied = standings.filter((s) => s.rank === 1).map((s) => s.pid);
  if (tied.length <= 1) return { winner: first.pid, tied };

  let contenders = tied;
  for (const activityId of state.tiebreakOrder) {
    const byPid = new Map(standings.map((s) => [s.pid, s]));
    let best = -Infinity;
    for (const pid of contenders) {
      const pts = byPid.get(pid)?.perActivity[activityId]?.points ?? 0;
      if (pts > best) best = pts;
    }
    const next = contenders.filter(
      (pid) => (byPid.get(pid)?.perActivity[activityId]?.points ?? 0) === best,
    );
    if (next.length === 1) return { winner: next[0] ?? null, tied };
    contenders = next;
  }
  return { winner: null, tied: contenders };
}

/** How many Spot Awards remain for an activity. */
export function spotsRemaining(
  state: SessionState,
  activity: Activity,
): number {
  const granted = state.spots.filter((s) => s.activityId === activity.id).length;
  return Math.max(0, activity.spotCap - granted);
}
