/**
 * The persistence seam.
 *
 * The engine emits a `persist` effect and knows nothing else about storage.
 * The runtime sees that effect and hands the new state to a `SessionStore`.
 * Everything AWS-shaped lives behind this interface, which is why the tests
 * and `npm run dev` can run without credentials, a container, or a network.
 *
 * Item shapes follow ARCHITECTURE.md's "Data model" table. The deviations are
 * recorded next to the item they affect.
 */

import type { Event, SessionState } from "../../engine/types.ts";

/** Bumped if the snapshot shape ever stops being readable by the old code. */
export const SNAPSHOT_VERSION = 1;

/** 90 days, per ARCHITECTURE.md "Retention". */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * A ceiling on the promo card, held by both stores.
 *
 * A DynamoDB item cannot exceed 400KB, and a card is a whole self-contained
 * page with its images inlined — the only thing written here big enough to
 * reach that limit. A card refused at the door costs the room a poster; a card
 * whose size is only discovered by DynamoDB costs the write, and reports it as
 * a ValidationException that names none of this.
 */
export const MAX_PROMO_CHARS = 300_000;

/** Both stores refuse an oversized card the same way, in the same words. */
export function checkPromoSize(html: string): void {
  if (html.length > MAX_PROMO_CHARS) {
    throw new Error(
      `promo card is ${html.length} characters; the limit is ${MAX_PROMO_CHARS}`,
    );
  }
}

/**
 * `SESSION#<sid>` / `META`.
 *
 * The token hashes are the reason this item is not just a slice of the
 * snapshot: they live in the runtime, not in `SessionState`, because the
 * engine is pure and has no business holding secrets. Without them a restart
 * would come back with the scores intact and no way for the host to log in.
 */
export interface SessionMeta {
  readonly sid: string;
  readonly title: string;
  readonly joinCode: string;
  readonly phase: SessionState["phase"];
  readonly seal: SessionState["seal"];
  readonly hostTokenHash: string;
  readonly screenTokenHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * Console setup, staged with the session and handed back to the console.
   *
   * Holding cards, the runbook order and the arcade running order are things a
   * host decides beforehand, and until now they lived only in one browser's
   * `localStorage` — clear your site data, or drive from a second profile, and
   * the console had forgotten them. Staging writes them here so the setup
   * belongs to the *session* rather than to a browser.
   *
   * Stored as the JSON text the host staged, verbatim and unparsed. The server
   * has no opinion about its contents and never acts on them: it is the
   * console's own vocabulary, versioned by the console, and a server that
   * understood it would be a second place to change when the console's storage
   * format moves. It is handed back only to the host token.
   */
  readonly setup?: string | null;
}

/**
 * `SESSION#<sid>` / `PARTICIPANT#<pid>`.
 *
 * Carries the rejoin token hashes, which are the other thing the snapshot
 * cannot hold. A phone gets a fresh token on every `hello`, so a participant
 * accumulates them; the list is capped because only the recent ones are on a
 * device anybody still has.
 */
export interface StoredParticipant {
  readonly pid: string;
  readonly nickname: string;
  readonly nicknameKey: string;
  readonly playerNumber: number;
  readonly joinedAt: number;
  readonly kicked: boolean;
  readonly rejoinTokenHashes: readonly string[];
}

/** `SESSION#<sid>` / `EVENT#<seq:010d>` — append-only, the audit trail. */
export interface StoredEvent {
  readonly seq: number;
  readonly event: Event;
  readonly at: number;
}

/** Everything one session needs to come back. */
export interface LoadedSession {
  readonly meta: SessionMeta;
  /** The fast path. Null means the slow path: replay the log from scratch. */
  readonly snapshot: { readonly seq: number; readonly state: SessionState } | null;
  /** Ordered by seq. On recovery only those past the snapshot are replayed. */
  readonly events: readonly StoredEvent[];
  readonly participants: readonly StoredParticipant[];
}

export interface SessionStore {
  /** For `/healthz` and the log line at boot. */
  readonly kind: "memory" | "dynamodb";

  /** Local development creates the table here; production is Terraform's job. */
  init(): Promise<void>;

  putMeta(meta: SessionMeta): Promise<void>;
  putSnapshot(sid: string, state: SessionState, at: number): Promise<void>;

  /**
   * `SESSION#<sid>` / `PROMO` — the event's promo card, a whole HTML page.
   *
   * Its own row, beside `META` and `SNAPSHOT`, and deliberately absent from
   * {@link LoadedSession}. It is content served *beside* a session and never
   * part of one: no event produces it, the reducer has never heard of it, and
   * it is in neither the snapshot nor the event log — both of which are
   * replayed on recovery and broadcast to every socket, and neither of which
   * should be carrying a quarter-megabyte poster to do it.
   *
   * Callers cap the text before it gets here; the stores check again, because
   * the limit belongs to the item this writes.
   */
  putPromo(sid: string, html: string, at: number): Promise<void>;
  /** Null for a session with no card, and for a session that does not exist. */
  getPromo(sid: string): Promise<string | null>;
  appendEvent(sid: string, record: StoredEvent): Promise<void>;
  putParticipant(sid: string, participant: StoredParticipant): Promise<void>;

  /** `CODE#<joinCode>` / `ACTIVE` — exists only while the session is joinable. */
  putJoinCode(joinCode: string, sid: string): Promise<void>;
  deleteJoinCode(joinCode: string): Promise<void>;

  /** Sessions in `lobby` or `running`: what a restart has to bring back. */
  loadRecoverable(): Promise<LoadedSession[]>;
  /** One session by id, whatever its phase — the export path after a restart. */
  loadSession(sid: string): Promise<LoadedSession | null>;

  close(): Promise<void>;
}

/** Sort key for an event. Zero-padded so lexical order is numeric order. */
export function eventSortKey(seq: number): string {
  return `EVENT#${String(seq).padStart(10, "0")}`;
}

/**
 * The promo card's own partition.
 *
 * Not `SESSION#<sid>` with a `PROMO` sort key, which is where it started. A
 * Query cannot exclude it — DynamoDB refuses a `FilterExpression` naming a key
 * attribute, `ValidationException: Filter Expression can only contain
 * non-primary key attributes` — so the only ways to keep a quarter-megabyte
 * poster out of every recovery and every export were to drag it across the
 * wire and discard it, or to put it somewhere the partition read never looks.
 * This is the second. The read is a `GetCommand` by exact key either way, so
 * it costs nothing.
 */
export function promoPk(sid: string): string {
  return `${sessionPk(sid)}#PROMO`;
}

export function sessionPk(sid: string): string {
  return `SESSION#${sid}`;
}

export function codePk(joinCode: string): string {
  return `CODE#${joinCode}`;
}

/** Expiry stamp, in whole seconds, as DynamoDB's TTL wants it. */
export function ttlAt(now: number): number {
  return Math.floor((now + RETENTION_MS) / 1000);
}

/** The most recent rejoin tokens worth keeping for one participant. */
export const MAX_REJOIN_TOKENS = 8;
