/**
 * The wire protocol, shared by the server and all three clients.
 *
 * JSON text frames, every message `{ t: "<type>", ... }`. Server broadcasts
 * carry `seq`, a per-session monotonic counter: a client that sees a gap sends
 * `resync` and gets a full `state` back. Client messages carry `cid`, echoed
 * in `ack`, so a client can reconcile an optimistic update.
 *
 * Phase 1 covers connection, segments, roster, seal and host control. Trivia
 * and arcade messages arrive in Phase 3 and 4.
 */

import type {
  ParticipantId,
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
  | { name: "spot.revoke"; seq: number };

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
    default:
      return null;
  }
}
