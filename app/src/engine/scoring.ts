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
  ActivityId,
  ParticipantId,
  SessionState,
} from "./types.ts";

/** What a participant scored in one activity, and how that number was reached. */
export interface ActivityPoints {
  /** Normalised 0–100, or null when there is nothing to show yet. */
  readonly points: number | null;
  /**
   * Two sources, not three. There was a `bench`, which carried Bench Credit's
   * mean of what somebody scored elsewhere; it came out with Bench Credit. An
   * activity a participant did not play is `unset` and worth nothing.
   */
  readonly source: "normalised" | "unset";
  /** The raw score this came from. Null when unset. */
  readonly raw: number | null;
}

export interface Standing {
  readonly pid: ParticipantId;
  readonly nickname: string;
  readonly perActivity: Readonly<Record<ActivityId, ActivityPoints>>;
  /**
   * Sum of activity points, treating null as 0, and nothing else.
   *
   * Spot Awards used to be added here — 10 a piece, on top of the 300 — and
   * removing them is why this is now the sum of the normalisation and full
   * stop. SCORING.md's "Removed" section has the rest.
   */
  readonly total: number;
  /** 1-based. Ties share a rank and the next rank skips accordingly. */
  readonly rank: number;
}

/**
 * Normalise one activity: top raw among `played` participants becomes 100.
 *
 * Returns points only for `played` participants. A cell nobody has typed into
 * is `unset`, contributes no raw and cannot set the ceiling — which used to be
 * true of a benched facilitator too, for the sharper reason that their absence
 * must not scale the room down.
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

    const perActivity: Record<ActivityId, ActivityPoints> = {};
    for (const a of state.activities) {
      const score = state.scores[a.id]?.[pid];
      const pts = normalised.get(a.id)?.[pid];

      if (pts !== undefined && score) {
        perActivity[a.id] = { points: pts, source: "normalised", raw: score.raw };
      } else {
        perActivity[a.id] = { points: null, source: "unset", raw: null };
      }
    }

    const total = state.activities.reduce(
      (sum, a) => sum + (perActivity[a.id]?.points ?? 0),
      0,
    );

    rows.push({ pid, nickname: p.nickname, perActivity, total });
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
