/**
 * The wire protocol, shared by the server and all three clients.
 *
 * JSON text frames, every message `{ t: "<type>", ... }`. Server broadcasts
 * carry `seq`, a per-session monotonic counter: a client that sees a gap sends
 * `resync` and gets a full `state` back. Client messages carry `cid`, echoed
 * in `ack`, so a client can reconcile an optimistic update.
 *
 * Phase 1 covers connection, segments, roster, seal and host control. Phase 3
 * adds trivia; arcade messages arrive in Phase 4.
 */

import type {
  ParticipantId,
  QuestionPhase,
  Seal,
  ScoreStatus,
  Segment,
  SessionPhase,
} from "./engine/types.ts";

export const PROTOCOL_VERSION = 1;

export type Role = "participant" | "host" | "screen";

/** Why a socket was refused. Distinct from engine RejectCodes on purpose: */
export type RefusedReason =
  | "no_such_code"
  | "nickname_taken"
  | "invalid_nickname"
  | "lobby_locked"
  | "kicked"
  | "bad_token"
  | "not_joinable"
  | "rate_limited"
  | "malformed";

/* ------------------------------------------------------------------ */
/* Client → server                                                     */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  | {
      t: "hello";
      role: "participant";
      joinCode: string;
      nickname: string;
      /** Present on a reconnect; lets the server restore the same pid. */
      rejoinToken?: string;
    }
  | { t: "hello"; role: "host"; hostToken: string }
  | { t: "hello"; role: "screen"; screenToken: string }
  | { t: "resync" }
  | { t: "ping"; t0: number }
  /**
   * One tap, and it is final. Participants only.
   *
   * There is deliberately no timestamp on this frame. The response time is
   * measured at the socket boundary from the server's own clock and its own
   * latency estimate for this socket — a client-supplied `at` would be a
   * number worth points, which is a number worth forging.
   *
   * `index` is the question the tap was meant for. A tap sent as the host
   * closes and advances would otherwise land on the *next* question, which is
   * the one race a phone can lose without anyone noticing.
   */
  | { t: "trivia.answer"; cid: string; index: number; choice: number }
  /**
   * `cmd` is null when the command could not be parsed. The frame still
   * arrives so the server can answer with `refusedCmd` on that `cid` — a
   * console that gets silence cannot tell a rejected click from a dropped one.
   */
  | { t: "host.cmd"; cid: string; cmd: HostCommand | null };

/** Mirrors the console's buttons one to one. Phase 1 subset. */
export type HostCommand =
  /** draft -> lobby: the join code goes live and people can arrive. */
  | { name: "open" }
  | { name: "start" }
  | { name: "close" }
  | { name: "segment"; kind: Segment }
  | { name: "holding"; title: string; line: string }
  | { name: "seal"; state: Seal }
  | { name: "lobby.lock"; locked: boolean }
  | { name: "participant.kick"; pid: ParticipantId }
  | { name: "participant.release"; pid: ParticipantId }
  /* ---- scoring (phase 2) ---- */
  /** Raw score for one person in one activity. Whatever it scored out of. */
  | { name: "score.set"; activityId: string; pid: ParticipantId; raw: number }
  /** played / bench / unset. Bench is what triggers Bench Credit. */
  | {
      name: "score.status";
      activityId: string;
      pid: ParticipantId;
      status: ScoreStatus;
    }
  /** 10 points, and the reason is required — it gets read out. */
  | {
      name: "spot.grant";
      pid: ParticipantId;
      activityId: string;
      reason: string;
    }
  | { name: "spot.revoke"; seq: number }
  /* ---- trivia (phase 3) ---- */
  /**
   * Open the current question. The timer starts on the server and every
   * surface counts down to the same absolute `closesAt`.
   *
   * `suddenDeath` rides on the open rather than being its own command because
   * the engine has no event for arming it: `openQuestion` carries it, so the
   * console's toggle is a pre-arm and the mode is fixed for the question at
   * the moment it opens. Flipping it mid-question would change the rules
   * under people who have already answered.
   */
  | { name: "trivia.open"; suddenDeath: boolean }
  /** Close early. The server's timer sends the identical event at `closesAt`. */
  | { name: "trivia.close" }
  | { name: "trivia.reveal" }
  | { name: "trivia.next" };

/* ------------------------------------------------------------------ */
/* Server → client                                                     */
/* ------------------------------------------------------------------ */

export interface RosterEntry {
  readonly pid: ParticipantId;
  readonly nickname: string;
  readonly playerNumber: number;
  /** `away` after 30s of silence — amber on the console, not a disconnect. */
  readonly conn: "on" | "away";
}

/** The participant's own points strip. Omitted entirely while sealed. */
export interface OwnPoints {
  readonly total: number;
  readonly byActivity: Readonly<Record<string, number | null>>;
}

export interface StandingRow {
  readonly rank: number;
  readonly nickname: string;
  readonly total: number;
  /**
   * Points per activity, so the big screen can draw the stacked bar in
   * activity hues. Null where nothing has been scored yet; a bench credit
   * reads as a number like any other, with `bench` saying where it came from.
   */
  readonly perActivity: Readonly<Record<string, number | null>>;
  readonly bench: readonly string[];
  readonly spot: number;
}

/** One row of the console's scoring grid. Host only. */
export interface ScoreRow {
  readonly pid: ParticipantId;
  readonly nickname: string;
  readonly playerNumber: number;
  /** activityId -> what was typed, and whether they played it. */
  readonly raw: Readonly<Record<string, number | null>>;
  readonly status: Readonly<Record<string, ScoreStatus>>;
  readonly points: Readonly<Record<string, number | null>>;
  readonly spot: number;
  readonly total: number;
  readonly rank: number;
}

export interface ActivitySummary {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly spotCap: number;
  readonly spotsLeft: number;
}

/* ------------------------------------------------------------------ */
/* Trivia                                                              */
/* ------------------------------------------------------------------ */

/**
 * A run of consecutive questions sharing a CSV `Round` value.
 *
 * SPEC: "Consecutive questions with the same value get a round card between
 * them." So the card belongs to the *first* question of a run, and the run is
 * computed once, on the server, rather than three times by three surfaces
 * looking at a question list two of them are never sent.
 */
export interface TriviaRound {
  readonly name: string;
  /** 1-based position of this question within the run. */
  readonly position: number;
  readonly size: number;
  /** True on the first question of the run: the console offers the card. */
  readonly startsHere: boolean;
}

/** One line of the activity's own podium. Five at most, on every surface. */
export interface TriviaPodiumRow {
  readonly rank: number;
  readonly nickname: string;
  readonly points: number;
}

/**
 * The question, as the room may see it *right now*.
 *
 * The optional fields are the whole point of this type. They are absent —
 * not null — for a role that may not have them yet, so the word never appears
 * in the JSON on that socket and "was it sent?" is a question about the wire
 * rather than about a renderer's discipline:
 *
 * | field | participant | screen | host |
 * | --- | --- | --- | --- |
 * | `correct` | reveal | reveal | always |
 * | `distribution` | never | reveal | always |
 * | `note` | reveal | reveal | always |
 * | `podium` | reveal | reveal | reveal |
 * | `answered` / `eligible` | never | always | always |
 *
 * A phone that learns the correct answer while the question is open has lost
 * the game for the person sitting next to its owner, and a phone that learns
 * the distribution is showing a big-screen thing on a 360px surface. The host
 * sees everything, always, because they are reading the answer out.
 */
export interface TriviaView {
  readonly activityId: string;
  /** 0-based index into the loaded set. */
  readonly index: number;
  readonly of: number;
  readonly phase: QuestionPhase;
  readonly text: string;
  /** Two to four. A blank CSV column is a question with fewer answers. */
  readonly answers: readonly string[];
  /**
   * Absolute server epochs, never durations: a client that receives this late
   * still counts down to the right instant. `closesAt` is null in sudden
   * death, which has no timer at all.
   */
  readonly opensAt: number | null;
  readonly closesAt: number | null;
  readonly timeLimitSec: number;
  readonly basePoints: number;
  readonly suddenDeath: boolean;
  /** A nickname, once someone has taken it. Sudden death only. */
  readonly suddenDeathWinner: string | null;
  readonly round: TriviaRound | null;
  /** 0-based, Kahoot semantics: more than one means any of them counts. */
  readonly correct?: readonly number[];
  /** Counts per answer index, same length as `answers`. */
  readonly distribution?: readonly number[];
  readonly note?: string;
  readonly podium?: readonly TriviaPodiumRow[];
  readonly answered?: number;
  /** Everyone in the room who could have answered — the "of 27". */
  readonly eligible?: number;
}

/**
 * The participant's own standing in the current question. Participants only.
 *
 * Three states and no fourth, because the middle one is a security property:
 * while the question is open the phone is told that it is locked in and
 * **nothing else**. There is no `correct` field on `locked` to forget to
 * strip, no `points` to render by accident, and nothing in the JSON for
 * someone with devtools to read out to the room. SPEC: "the phone shows
 * 'locked in' and nothing else … a phone that turns green is visible to the
 * person next to you."
 */
export type TriviaMine =
  | { readonly state: "unanswered" }
  | { readonly state: "locked"; readonly choice: number }
  | {
      readonly state: "revealed";
      /** Null when they did not answer at all. */
      readonly choice: number | null;
      readonly correct: boolean;
      /** For this question. Zero when wrong, absent, or a warm-up. */
      readonly points: number;
      readonly streakBonus: number;
      /** Consecutive correct answers *including* this one. */
      readonly streak: number;
      /** Their running trivia total, which is the raw score for the activity. */
      readonly total: number;
    };

/**
 * What a client renders. The server sends the view for that role — a
 * participant is never sent the full ranking, because the rule is that only
 * the top five is ever visible and enforcing it in the client would mean
 * shipping the rest of the list to the phone.
 */
export interface RenderState {
  readonly sid: string;
  readonly title: string;
  readonly phase: SessionPhase;
  readonly segment: Segment;
  readonly seal: Seal;
  readonly holding: { title: string; line: string } | null;
  readonly roster: readonly RosterEntry[];
  readonly joinsLocked: boolean;
  /** Top five, or empty while sealed. */
  readonly standings: readonly StandingRow[];
  /** Participant only, and only while not sealed. */
  readonly own?: OwnPoints;
  /**
   * Host and screen only. The screen puts the join URL and a QR on the lobby,
   * so it needs the code; a participant has already used it.
   */
  readonly joinCode?: string;
  /** Every surface needs the activity list to label a breakdown. */
  readonly activities: readonly ActivitySummary[];
  /** Absent until a question set is loaded. Projected per role: {@link TriviaView}. */
  readonly trivia?: TriviaView;
  /** Participant only, and only while a question set is loaded. */
  readonly triviaMine?: TriviaMine;
  /** Host only. */
  readonly hostExtras?: {
    readonly joinCode: string;
    readonly participantCount: number;
    readonly awayCount: number;
    /** The full grid, unsealed — the host cannot run the session blind. */
    readonly scores: readonly ScoreRow[];
    readonly spots: readonly {
      readonly seq: number;
      readonly pid: ParticipantId;
      readonly activityId: string;
      readonly reason: string;
    }[];
    /**
     * Per-participant answer state, which ARCHITECTURE gives the host and
     * nobody else. *Who* has answered, never *what* they answered: the
     * console's job is to decide whether to wait, and a grid of choices would
     * be the answer key on a screen the host sometimes shares by accident.
     */
    readonly trivia?: {
      readonly answeredBy: readonly ParticipantId[];
      /** How many questions are loaded. Zero means the CSV has not landed. */
      readonly loaded: number;
    };
  };
}

export type ServerMessage =
  | {
      t: "welcome";
      role: Role;
      sid: string;
      pid?: ParticipantId;
      rejoinToken?: string;
      serverTime: number;
      protocol: number;
    }
  | { t: "refused"; reason: RefusedReason; message: string }
  | { t: "state"; seq: number; state: RenderState }
  | { t: "roster"; seq: number; roster: readonly RosterEntry[] }
  | { t: "seal"; seq: number; state: Seal }
  | { t: "toast"; seq: number; kind: "spot" | "text"; text: string }
  | { t: "ack"; cid: string; applied: boolean }
  | {
      t: "refusedCmd";
      cid: string;
      code: string;
      message: string;
    }
  | { t: "pong"; t0: number; t1: number };

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parse a client frame. Returns null for anything malformed.
 *
 * Everything arriving on a socket is untrusted: this is the only place that
 * turns bytes into a typed message, and it never throws.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof m[k] === "string" ? (m[k] as string) : null;

  switch (m["t"]) {
    case "hello": {
      if (m["role"] === "participant") {
        const joinCode = str("joinCode");
        const nickname = str("nickname");
        if (joinCode === null || nickname === null) return null;
        const rejoinToken = str("rejoinToken");
        return rejoinToken !== null
          ? { t: "hello", role: "participant", joinCode, nickname, rejoinToken }
          : { t: "hello", role: "participant", joinCode, nickname };
      }
      if (m["role"] === "host") {
        const hostToken = str("hostToken");
        return hostToken === null ? null : { t: "hello", role: "host", hostToken };
      }
      if (m["role"] === "screen") {
        const screenToken = str("screenToken");
        return screenToken === null
          ? null
          : { t: "hello", role: "screen", screenToken };
      }
      return null;
    }
    case "resync":
      return { t: "resync" };
    case "ping":
      return typeof m["t0"] === "number" ? { t: "ping", t0: m["t0"] } : null;
    case "trivia.answer": {
      const cid = str("cid");
      const index = m["index"];
      const choice = m["choice"];
      // Non-negative integers or nothing. The engine refuses an out-of-range
      // choice as well, but a fractional index that reached the boundary's
      // `===` comparison would simply never match, which is a silent drop.
      if (
        cid === null ||
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        typeof choice !== "number" ||
        !Number.isInteger(choice) ||
        choice < 0
      ) {
        return null;
      }
      return { t: "trivia.answer", cid, index, choice };
    }
    case "host.cmd": {
      const cid = str("cid");
      if (cid === null) return null;
      return { t: "host.cmd", cid, cmd: parseHostCommand(m["cmd"]) };
    }
    default:
      return null;
  }
}

function parseHostCommand(v: unknown): HostCommand | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  const name = c["name"];
  const str = (k: string): string | null =>
    typeof c[k] === "string" ? (c[k] as string) : null;

  const SEGMENTS: readonly Segment[] = [
    "lobby", "holding", "trivia", "arcade", "standings", "final",
  ];
  const SEALS: readonly Seal[] = ["live", "sealed", "revealed"];

  switch (name) {
    case "open":
      return { name: "open" };
    case "start":
      return { name: "start" };
    case "close":
      return { name: "close" };
    case "segment": {
      const kind = c["kind"];
      return SEGMENTS.includes(kind as Segment)
        ? { name: "segment", kind: kind as Segment }
        : null;
    }
    case "holding": {
      const title = str("title");
      const line = str("line");
      return title !== null && line !== null
        ? { name: "holding", title, line }
        : null;
    }
    case "seal": {
      const st = c["state"];
      return SEALS.includes(st as Seal) ? { name: "seal", state: st as Seal } : null;
    }
    case "lobby.lock":
      return typeof c["locked"] === "boolean"
        ? { name: "lobby.lock", locked: c["locked"] }
        : null;
    case "participant.kick": {
      const pid = str("pid");
      return pid === null ? null : { name: "participant.kick", pid };
    }
    case "participant.release": {
      const pid = str("pid");
      return pid === null ? null : { name: "participant.release", pid };
    }
    case "score.set": {
      const activityId = str("activityId");
      const pid = str("pid");
      const raw = c["raw"];
      // Finite and non-negative is the engine's rule too; refusing here keeps
      // a NaN off the wire rather than relying on the reducer to catch it.
      return activityId !== null &&
        pid !== null &&
        typeof raw === "number" &&
        Number.isFinite(raw) &&
        raw >= 0
        ? { name: "score.set", activityId, pid, raw }
        : null;
    }
    case "score.status": {
      const activityId = str("activityId");
      const pid = str("pid");
      const st = c["status"];
      const OK: readonly ScoreStatus[] = ["played", "bench", "unset"];
      return activityId !== null && pid !== null && OK.includes(st as ScoreStatus)
        ? { name: "score.status", activityId, pid, status: st as ScoreStatus }
        : null;
    }
    case "spot.grant": {
      const pid = str("pid");
      const activityId = str("activityId");
      const reason = str("reason");
      return pid !== null && activityId !== null && reason !== null
        ? { name: "spot.grant", pid, activityId, reason }
        : null;
    }
    case "spot.revoke": {
      const seq = c["seq"];
      return typeof seq === "number" && Number.isInteger(seq)
        ? { name: "spot.revoke", seq }
        : null;
    }
    case "trivia.open":
      // Explicit, never defaulted: "sudden death was off, wasn't it?" is not a
      // question anyone should be asking after the question is on the wall.
      return typeof c["suddenDeath"] === "boolean"
        ? { name: "trivia.open", suddenDeath: c["suddenDeath"] }
        : null;
    case "trivia.close":
      return { name: "trivia.close" };
    case "trivia.reveal":
      return { name: "trivia.reveal" };
    case "trivia.next":
      return { name: "trivia.next" };
    default:
      return null;
  }
}
