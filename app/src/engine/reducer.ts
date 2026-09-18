/**
 * The game engine: `reduce(state, event, now) -> {state, effects}`.
 *
 * Pure. No I/O, no clock, no randomness — `now` and any generated id arrive on
 * the event. That is what makes a session replayable from its event log, and
 * what lets the rules be tested with a fake clock.
 *
 * A rejected event returns the state unchanged plus a `reject` effect. The
 * caller decides what to do with it; the engine never throws for a rule
 * violation.
 */

import type {
  Activity,
  ActivityId,
  Audience,
  Effect,
  Event,
  Participant,
  RawScore,
  ReduceResult,
  RejectCode,
  SessionState,
} from "./types.ts";
import { spotsRemaining } from "./scoring.ts";

/**
 * Fold a nickname for collision detection.
 *
 * NFKD-normalise, drop combining marks, lowercase, then keep letters and
 * digits **from any script**. The earlier version kept only `[a-z0-9]`, which
 * folded every non-Latin name to the empty string — so a colleague typing
 * their name in Japanese, Hindi or Chinese was told to pick a different one.
 * For an APJ team that is not an edge case.
 *
 * Dropping marks rather than deleting the character also fixes the accent
 * handling, which was backwards: "José" folded to "jos" (so it did *not*
 * collide with "Jose") while "Zoë" folded to "zo" (so it *did* collide with
 * "Zo"). Now "José" and "Jose" collide, and "Zoë" and "Zo" do not.
 *
 * Punctuation and whitespace are still folded away, so "Ann-Marie" collides
 * with "Annmarie" and "A M A R A" with "Amara". That is stronger than SPEC.md
 * describes, and deliberate: near-identical names in a live game are a
 * scorekeeping problem, not a feature.
 */
/**
 * Strip control characters and collapse interior whitespace.
 *
 * ARCHITECTURE.md requires this at the edge. A tab or a newline in a nickname
 * breaks every aligned surface — the console roster, the big screen, the CSV
 * export — and a bidi override can reorder text around it on someone else's
 * screen. The display string is sanitised, not just the collision key.
 */
export function sanitiseNickname(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function nicknameKey(nickname: string): string {
  return nickname
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Shortest usable nickname, in code points. See SPEC.md "Identity". */
export const MIN_NICKNAME_LENGTH = 2;

/**
 * Longest usable nickname, in code points. ARCHITECTURE.md caps these at 24.
 * Enforced here rather than in the client: the client can be bypassed, and
 * every surface would otherwise need its own truncation.
 */
export const MAX_NICKNAME_LENGTH = 24;

export interface NewSessionInput {
  readonly sid: string;
  readonly title: string;
  readonly joinCode: string;
  readonly activities: readonly Activity[];
  readonly tiebreakOrder?: readonly ActivityId[];
}

export function newSession(input: NewSessionInput): SessionState {
  return {
    sid: input.sid,
    title: input.title,
    joinCode: input.joinCode,
    phase: "draft",
    segment: "lobby",
    seal: "live",
    activities: input.activities,
    tiebreakOrder: input.tiebreakOrder ?? input.activities.map((a) => a.id),
    participants: {},
    scores: Object.fromEntries(input.activities.map((a) => [a.id, {}])),
    spots: [],
    holding: null,
    joinsLocked: false,
    seq: 0,
    nextPlayerNumber: 1,
  };
}

function reject(to: Audience, code: RejectCode, message: string): Effect[] {
  return [{ kind: "reject", to, code, message }];
}

const BROADCAST_STATE: Effect = { kind: "broadcast", to: "all", what: "state" };
const PERSIST: Effect = { kind: "persist", what: "snapshot" };

/** Standings changed: everyone needs them, and the console always does. */
const BROADCAST_STANDINGS: Effect[] = [
  { kind: "broadcast", to: "all", what: "standings" },
  { kind: "broadcast", to: "host", what: "standings" },
];

export function reduce(
  state: SessionState,
  event: Event,
  now: number,
): ReduceResult {
  const bump = (next: Omit<SessionState, "seq">): SessionState =>
    ({ ...next, seq: state.seq + 1 }) as SessionState;
  const unchanged = (effects: readonly Effect[] = []): ReduceResult => ({
    state,
    effects,
    applied: false,
  });
  const applied = (
    next: Omit<SessionState, "seq">,
    effects: readonly Effect[],
  ): ReduceResult => ({ state: bump(next), effects, applied: true });

  // A closed session is frozen. Only connection churn still lands — people
  // close laptops after the winner is announced, and that is not a rule change.
  if (
    state.phase === "closed" &&
    event.type !== "disconnect" &&
    event.type !== "reconnect" &&
    event.type !== "close" // closing twice is idempotent, not an error
  ) {
    return unchanged(
      reject("host", "session_closed", "The session is closed."),
    );
  }

  switch (event.type) {
    /* ---------------- participants ---------------- */

    case "join": {
      // Look the participant up first: a rejoin is not a new join and must
      // survive a locked lobby. A *kicked* participant rejoining is a new
      // join though — SPEC.md: they "can rejoin under a different nickname
      // unless the lobby is locked".
      const existing = state.participants[event.pid];

      if (state.phase === "draft" || state.phase === "closed") {
        return unchanged(
          reject({ pid: event.pid }, "not_joinable", "The session is not open."),
        );
      }
      if (state.joinsLocked && (!existing || existing.kicked)) {
        return unchanged(
          reject(
            { pid: event.pid },
            "joins_locked",
            "The host has locked joining.",
          ),
        );
      }

      const nickname = sanitiseNickname(event.nickname);
      const key = nicknameKey(nickname);
      if (key === "") {
        return unchanged(
          reject({ pid: event.pid }, "invalid_nickname", "Pick a nickname."),
        );
      }
      const glyphs = [...nickname].length;
      if (glyphs < MIN_NICKNAME_LENGTH) {
        return unchanged(
          reject(
            { pid: event.pid },
            "invalid_nickname",
            `Nicknames need at least ${MIN_NICKNAME_LENGTH} characters.`,
          ),
        );
      }
      if (glyphs > MAX_NICKNAME_LENGTH) {
        return unchanged(
          reject(
            { pid: event.pid },
            "invalid_nickname",
            `Nicknames are at most ${MAX_NICKNAME_LENGTH} characters.`,
          ),
        );
      }

      // Kicked: they may come back, but not under the name they were kicked
      // for. SPEC.md — "can rejoin under a different nickname".
      if (existing?.kicked && existing.nicknameKey === key) {
        return unchanged(
          reject(
            { pid: event.pid },
            "kicked",
            "Pick a different nickname to rejoin.",
          ),
        );
      }

      // A kicked name is freed for other people. Burning it forever would
      // punish a real colleague who happens to share it, and it does not stop
      // the person who was kicked: without their rejoin token they are
      // indistinguishable from a new arrival. Nickname-only identity cannot
      // tell those two apart, and pretending otherwise would be theatre. The
      // host's actual tool for a determined troll is locking the lobby.
      const clash = Object.values(state.participants).find(
        (p) => p.nicknameKey === key && p.pid !== event.pid && !p.kicked,
      );
      if (clash) {
        return unchanged(
          reject(
            { pid: event.pid },
            "nickname_taken",
            `${nickname} is already here. Pick another, or ask the host to release it.`,
          ),
        );
      }

      // A rejoin keeps the participant's stored nickname. Renaming is
      // host-only, and a phone reconnecting with whatever is in its text box
      // would otherwise be a rename anyone could perform on themselves —
      // including undoing a rename the host just made.
      const participant: Participant = existing
        ? {
            ...existing,
            ...(existing.kicked ? { nickname, nicknameKey: key } : {}),
            connected: true,
            kicked: false,
          }
        : {
            pid: event.pid,
            nickname,
            nicknameKey: key,
            playerNumber: state.nextPlayerNumber,
            joinedAt: now,
            connected: true,
            kicked: false,
          };

      return applied(
        {
          ...state,
          participants: { ...state.participants, [event.pid]: participant },
          nextPlayerNumber: existing
            ? state.nextPlayerNumber
            : state.nextPlayerNumber + 1,
        },
        [BROADCAST_STATE, ...BROADCAST_STANDINGS, PERSIST],
      );
    }

    case "disconnect":
    case "reconnect": {
      const p = state.participants[event.pid];
      if (!p) return unchanged();
      // A kicked participant does not come back by reconnecting; they rejoin
      // under a new nickname, which is the whole point of the kick.
      if (p.kicked) return unchanged();
      const connected = event.type === "reconnect";
      if (p.connected === connected) return unchanged();
      return applied(
        {
          ...state,
          participants: {
            ...state.participants,
            [event.pid]: { ...p, connected },
          },
        },
        // A connection blip is not news to anyone but the host.
        [{ kind: "broadcast", to: "host", what: "state" }],
      );
    }

    case "kick": {
      const p = state.participants[event.pid];
      if (!p || p.kicked) return unchanged();
      return applied(
        {
          ...state,
          participants: {
            ...state.participants,
            [event.pid]: { ...p, kicked: true, connected: false },
          },
        },
        [BROADCAST_STATE, ...BROADCAST_STANDINGS, PERSIST],
      );
    }

    case "releaseNickname": {
      const p = state.participants[event.pid];
      if (!p || p.nicknameKey === "") return unchanged();
      return applied(
        {
          ...state,
          participants: {
            ...state.participants,
            [event.pid]: { ...p, nicknameKey: "", connected: false },
          },
        },
        [{ kind: "broadcast", to: "host", what: "state" }, PERSIST],
      );
    }

    /* ---------------- lifecycle ---------------- */

    case "open": {
      if (state.phase !== "draft") {
        return unchanged(
          reject("host", "wrong_phase", "The session is already open."),
        );
      }
      return applied({ ...state, phase: "lobby", segment: "lobby" }, [
        BROADCAST_STATE,
        PERSIST,
      ]);
    }

    case "start": {
      if (state.phase !== "lobby") {
        return unchanged(
          reject(
            "host",
            "wrong_phase",
            state.phase === "running"
              ? "The session is already running."
              : "Open the session before starting it.",
          ),
        );
      }
      return applied({ ...state, phase: "running" }, [
        BROADCAST_STATE,
        PERSIST,
      ]);
    }

    case "close": {
      // Closing an unopened session is meaningless; closing a lobby that never
      // started is a real thing a host does when an event is abandoned.
      if (state.phase === "closed") return unchanged();
      if (state.phase === "draft") {
        return unchanged(
          reject("host", "wrong_phase", "The session was never opened."),
        );
      }
      return applied(
        {
          ...state,
          phase: "closed",
          segment: "final",
          seal: "revealed",
          joinsLocked: true,
        },
        [BROADCAST_STATE, ...BROADCAST_STANDINGS, PERSIST],
      );
    }

    case "setSegment": {
      if (state.segment === event.segment) return unchanged();
      return applied({ ...state, segment: event.segment }, [
        BROADCAST_STATE,
        PERSIST,
      ]);
    }

    case "setSeal": {
      if (state.seal === event.seal) return unchanged();
      // Sealing changes what every surface may show, so standings go with it.
      return applied({ ...state, seal: event.seal }, [
        BROADCAST_STATE,
        ...BROADCAST_STANDINGS,
        PERSIST,
      ]);
    }

    case "setHolding": {
      const a = state.holding;
      const b = event.holding;
      const same =
        a === b ||
        (a !== null &&
          b !== null &&
          a.title === b.title &&
          a.line === b.line);
      if (same) return unchanged();
      return applied({ ...state, holding: b }, [BROADCAST_STATE, PERSIST]);
    }

    case "setJoinsLocked": {
      if (state.joinsLocked === event.locked) return unchanged();
      return applied({ ...state, joinsLocked: event.locked }, [
        { kind: "broadcast", to: "host", what: "state" },
        PERSIST,
      ]);
    }

    /* ---------------- scoring ---------------- */

    case "setScore": {
      const activity = state.activities.find((a) => a.id === event.activityId);
      if (!activity) {
        return unchanged(
          reject("host", "unknown_activity", `No activity ${event.activityId}.`),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject("host", "unknown_participant", `No participant ${event.pid}.`),
        );
      }
      // NaN and Infinity poison every downstream comparison: the sort
      // comparator returns NaN and the ranking order becomes undefined.
      if (!Number.isFinite(event.raw) || event.raw < 0) {
        return unchanged(
          reject(
            "host",
            "invalid_score",
            "A raw score must be a finite number, zero or above.",
          ),
        );
      }

      const prev = state.scores[event.activityId]?.[event.pid];
      // Scoring someone who is on bench credit is refused rather than stored:
      // storing it would let the raw reappear if they were ever un-benched.
      if (prev?.status === "bench") {
        return unchanged(
          reject(
            "host",
            "bench_cannot_receive_spot",
            `${p.nickname} is on bench credit for ${activity.title}.`,
          ),
        );
      }

      const next: RawScore = { raw: event.raw, status: "played" };
      if (prev && prev.raw === next.raw && prev.status === next.status) {
        return unchanged();
      }
      return applied(
        {
          ...state,
          scores: {
            ...state.scores,
            [event.activityId]: {
              ...(state.scores[event.activityId] ?? {}),
              [event.pid]: next,
            },
          },
        },
        [...BROADCAST_STANDINGS, PERSIST],
      );
    }

    case "setStatus": {
      const activity = state.activities.find((a) => a.id === event.activityId);
      if (!activity) {
        return unchanged(
          reject("host", "unknown_activity", `No activity ${event.activityId}.`),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject("host", "unknown_participant", `No participant ${event.pid}.`),
        );
      }
      const prev = state.scores[event.activityId]?.[event.pid];
      if ((prev?.status ?? "unset") === event.status) return unchanged();

      // Benching discards the raw score: it is no longer meaningful, and
      // leaving it would let it reappear if the status flipped back.
      const next: RawScore = {
        raw: event.status === "played" ? (prev?.raw ?? 0) : 0,
        status: event.status,
      };
      return applied(
        {
          ...state,
          scores: {
            ...state.scores,
            [event.activityId]: {
              ...(state.scores[event.activityId] ?? {}),
              [event.pid]: next,
            },
          },
        },
        [...BROADCAST_STANDINGS, PERSIST],
      );
    }

    case "grantSpot": {
      const activity = state.activities.find((a) => a.id === event.activityId);
      if (!activity) {
        return unchanged(
          reject("host", "unknown_activity", `No activity ${event.activityId}.`),
        );
      }
      const p = state.participants[event.pid];
      if (!p || p.kicked) {
        return unchanged(
          reject("host", "unknown_participant", `No participant ${event.pid}.`),
        );
      }
      if (event.reason.trim() === "") {
        return unchanged(
          reject(
            "host",
            "reason_required",
            "A Spot Award needs a reason — it gets read out.",
          ),
        );
      }
      if (state.scores[event.activityId]?.[event.pid]?.status === "bench") {
        return unchanged(
          reject(
            "host",
            "bench_cannot_receive_spot",
            "They are on bench credit for this activity.",
          ),
        );
      }
      if (spotsRemaining(state, activity) <= 0) {
        return unchanged(
          reject(
            "host",
            "spot_cap_reached",
            `No Spot Awards left for ${activity.title}.`,
          ),
        );
      }
      return applied(
        {
          ...state,
          spots: [
            ...state.spots,
            {
              seq: state.seq + 1,
              pid: event.pid,
              activityId: event.activityId,
              reason: event.reason.trim(),
              at: now,
            },
          ],
        },
        [
          ...BROADCAST_STANDINGS,
          {
            kind: "broadcast",
            to: "all",
            what: "toast",
            detail: event.reason.trim(),
          },
          PERSIST,
        ],
      );
    }

    case "revokeSpot": {
      if (!state.spots.some((sp) => sp.seq === event.seq)) return unchanged();
      return applied(
        { ...state, spots: state.spots.filter((sp) => sp.seq !== event.seq) },
        [...BROADCAST_STANDINGS, PERSIST],
      );
    }
  }
}

/** Replay an event log onto a starting state. Used by restart recovery. */
export function replay(
  initial: SessionState,
  events: readonly { event: Event; at: number }[],
): SessionState {
  return events.reduce((s, e) => reduce(s, e.event, e.at).state, initial);
}
