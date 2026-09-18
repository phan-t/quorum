/**
 * Projection: SessionState -> what one role is allowed to see.
 *
 * The seal and the top-five rule are enforced *here*, not in the client.
 * Sending thirty phones the full ranking and asking them to render five of it
 * would make the rule a suggestion — anyone with devtools could read the rest,
 * and a sealed board would still be sitting in the page's memory.
 */

import { computeStandings, publicStandings, topFive } from "../engine/scoring.ts";
import type { ParticipantId, SessionState } from "../engine/types.ts";
import type {
  OwnPoints,
  RenderState,
  Role,
  RosterEntry,
  StandingRow,
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
  const visible: StandingRow[] = rows.map((s) => ({
    rank: s.rank,
    nickname: s.nickname,
    total: s.total,
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
      },
    };
  }
  return own ? { ...base, own } : base;
}
