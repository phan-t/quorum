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

/**
 * The shape version stamped on every `SNAPSHOT` row this code writes.
 *
 * Version 1 was written and never read back, which made it decoration: a row
 * said `version: 1` whether it was written before or after the send-off gained
 * a plan, so a migration could not ask the row what it was and had to sniff for
 * the absent field instead. Version 2 is the first that recovery reads, and its
 * contract is the useful one:
 *
 * > **A row at version N carries every field the state had at version N.**
 *
 * So a field added to a round in flight gets a constant in `server/recovery.ts`
 * naming the version it shipped in, the migration for it can *assert* what it is
 * looking at instead of guessing, and it can be retired against the table's own
 * minimum version and oldest write time rather than against a hunch. Bump this
 * whenever a field is added to `SessionState` that recovery has to fill in for
 * older rows, and add the constant next to the migration.
 *
 * Bumping it is not a compatibility break in either direction: older code reads
 * the row by its fields and ignores the number, and newer code treats anything
 * below {@link SNAPSHOT_SELF_DESCRIBING_VERSION} as unknown vintage.
 */
export const SNAPSHOT_VERSION = 2;

/**
 * The lowest version a row can claim and be believed.
 *
 * A row with no `version`, or with version 1, says nothing about which fields it
 * has — see above — so recovery treats both as unknown vintage and keeps
 * sniffing. Everything at or above this is self-describing.
 */
export const SNAPSHOT_SELF_DESCRIBING_VERSION = 2;

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
 * A ceiling on one send-off asset, held by both stores.
 *
 * 300,000 bytes, the same number as the promo card and for the same reason: a
 * DynamoDB item cannot exceed 400KB including its keys and attribute names,
 * and a photo is the only other thing written here big enough to approach it.
 * The headroom is not slack — it is what leaves room for the key, the content
 * type and the overhead of the item itself.
 *
 * The bytes are stored as DynamoDB **Binary**, not base64 in a string. Base64
 * inflates by a third, which would turn a 290KB photo into a 387KB attribute
 * and put a perfectly ordinary montage frame over the item limit.
 *
 * Staging downscales to about 1200px wide, which lands around 150KB — half of
 * this — so a photo that trips the limit is a photo that skipped the resize,
 * and being told so at staging is the entire point.
 */
export const MAX_ASSET_BYTES = 300_000;

/** Both stores refuse an oversized asset the same way, in the same words. */
export function checkAssetSize(key: string, bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(
      `asset ${key} is ${bytes.byteLength} bytes; the limit is ${MAX_ASSET_BYTES}`,
    );
  }
}

/** The longest an asset key may be. Well past `photos/` plus a filename. */
export const MAX_ASSET_KEY_CHARS = 200;

/**
 * Why a key is unusable, or null if it is fine.
 *
 * A key is a relative path under the event directory — `photos/p01.jpg` — and
 * it arrives twice: once inside a send-off file, and once as the tail of a URL
 * that staging and the Desktop both build. Both entry points run this, because
 * a key that passes the importer and fails the route is a montage with a hole
 * in it, and a key that reaches the filesystem side of staging with a `..` in
 * it is worse than that.
 */
export function assetKeyProblem(key: string): string | null {
  if (key === "") return "The key is blank.";
  if ([...key].length > MAX_ASSET_KEY_CHARS) {
    return `${[...key].length} characters; the limit is ${MAX_ASSET_KEY_CHARS}.`;
  }
  // Control characters would be a header-splitting attempt or a corrupt file,
  // and neither is a filename anybody typed.
  if (/[\u0000-\u001f\u007f]/.test(key)) return "The key has a control character in it.";
  if (key.includes("\\")) return "Use forward slashes, not backslashes.";
  if (key.startsWith("/")) return "The key is a path inside the event directory, so it cannot start with \"/\".";
  if (key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return "The key has an empty or relative path segment in it.";
  }
  return null;
}

/** Both stores refuse an unusable key the same way, in the same words. */
export function checkAssetKey(key: string): void {
  const problem = assetKeyProblem(key);
  if (problem !== null) throw new Error(`asset key ${JSON.stringify(key)}: ${problem}`);
}

/**
 * `SESSION#<sid>#ASSET` / `ASSET#<key>` — one photo, or the music file.
 *
 * `bytes` is what was uploaded, unchanged. `contentType` is what the uploader
 * declared: the server does not sniff it and does not correct it, because the
 * only thing it would be sniffing for is the thing it is about to serve with
 * `nosniff` anyway.
 */
export interface StoredAsset {
  readonly key: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly at: number;
}

/** One asset without its bytes: what a listing can afford to return. */
export interface AssetSummary {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly at: number;
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

/**
 * `SESSION#<sid>` / `SNAPSHOT` — the full state, as it was read back.
 *
 * `version` and `writtenAt` are optional because absence is the fact recovery
 * needs: a row written before either was read back has no vintage, and that is
 * exactly the row the migration shims in `server/recovery.ts` exist for. They
 * are left off rather than defaulted to `0` and `Date.now()`, because a default
 * would be a claim about a row nobody can make.
 */
export interface StoredSnapshot {
  readonly seq: number;
  readonly state: SessionState;
  /**
   * The writer's {@link SNAPSHOT_VERSION}. Absent on a row written before the
   * version was read back — see {@link SNAPSHOT_SELF_DESCRIBING_VERSION}.
   */
  readonly version?: number;
  /**
   * The writer's clock at the moment the row was written, in ms.
   *
   * The writer's clock, not the store's: this is the `at` handed to
   * `putSnapshot`, which is the `at` of the transition that produced the state.
   * Good enough to date a row to the minute, which is all retiring a migration
   * needs; not a thing to compare against another process's clock.
   */
  readonly writtenAt?: number;
}

/** Everything one session needs to come back. */
export interface LoadedSession {
  readonly meta: SessionMeta;
  /** The fast path. Null means the slow path: replay the log from scratch. */
  readonly snapshot: StoredSnapshot | null;
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

  /**
   * `SESSION#<sid>#ASSET` / `ASSET#<key>` — one send-off photo, or the music.
   *
   * Many per session, keyed by the filename the send-off file names, and
   * absent from {@link LoadedSession} for exactly the promo card's reason:
   * these are bytes served *beside* a session, never part of one. Forty-three
   * photos is seven megabytes, and the snapshot is replayed on recovery and
   * broadcast to every socket.
   *
   * Callers cap the size before it gets here; the stores check again, because
   * the limit belongs to the item this writes.
   */
  putAsset(
    sid: string,
    key: string,
    bytes: Uint8Array,
    contentType: string,
    at: number,
  ): Promise<void>;
  /** Null for an unknown key, and for a session that does not exist. */
  getAsset(sid: string, key: string): Promise<StoredAsset | null>;
  /**
   * Every asset key this session holds, without the bytes.
   *
   * Sizes and types only: staging asks what already landed so a re-run does
   * not re-upload seven megabytes, and pulling the bytes back to answer that
   * question would cost exactly what it is trying to save.
   */
  listAssets(sid: string): Promise<readonly AssetSummary[]>;
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

/**
 * The send-off assets' own partition, for the reason `promoPk` explains.
 *
 * All of a session's assets share one partition rather than taking one each,
 * so a listing is a single Query. They are still nowhere near the session's
 * own partition, which is the whole point: `loadSession` and `loadRecoverable`
 * read `sessionPk` and can therefore never drag seven megabytes of JPEG back
 * to discard it, and there is no `FilterExpression` for DynamoDB to refuse.
 */
export function assetPk(sid: string): string {
  return `${sessionPk(sid)}#ASSET`;
}

/** Sort key for one asset. */
export function assetSortKey(key: string): string {
  return `ASSET#${key}`;
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
