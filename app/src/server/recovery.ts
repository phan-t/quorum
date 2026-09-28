/**
 * Restart recovery.
 *
 * ARCHITECTURE.md: "On start the process scans for sessions in `lobby` or
 * `running`, loads each `SNAPSHOT`, replays any `EVENT#` with `seq` greater
 * than the snapshot's (there should be none or one)".
 *
 * The snapshot is the fast path and the log is the slow one. Both go through
 * the same pure `replay()` the tests use, so recovery is not a second
 * implementation of the rules that can drift from the first.
 *
 * The hard part is not what comes back — it is what must not. A snapshot was
 * written while thirty phones were connected, so it says `connected: true` for
 * all of them, and the process it describes is dead. A rehydrated participant
 * is disconnected until they say so themselves, and the roster has to show
 * that rather than a room that is not there. The correction is applied as
 * `disconnect` events through the engine rather than by editing the state,
 * which keeps the one writer the one writer.
 */

import { newSession, replay } from "../engine/reducer.ts";
import { buildPlan, DEFAULT_AUTO_SECONDS } from "../engine/sendoff.ts";
import type { Event, RawScore, SendoffPhase, SessionState } from "../engine/types.ts";
import type { SessionRegistry, SessionRuntime } from "./runtime.ts";
import {
  REOPEN_WINDOW_MS,
  retiredByAge,
  SNAPSHOT_SELF_DESCRIBING_VERSION,
  SNAPSHOT_VERSION,
  type LoadedSession,
  type SessionStore,
} from "./store/types.ts";

export interface RecoveredSession {
  readonly sid: string;
  readonly runtime: SessionRuntime;
  /** How the state was reached, for the boot log. */
  readonly from: "snapshot" | "log";
  /** Events past the snapshot that had to be replayed. Normally none or one. */
  readonly replayed: number;
  readonly participants: number;
}

/**
 * What the row says about its own vintage, or null where it says nothing.
 *
 * The point of reading this is that a migration can *assert* rather than sniff.
 * It is not permission to skip the sniff — see {@link Vintage.selfDescribing}.
 */
export interface Vintage {
  /**
   * The writer's `SNAPSHOT_VERSION`, or null on a row that has none — a row
   * written before the version was read back, or a log-only rebuild with no
   * snapshot row at all.
   */
  readonly version: number | null;
  /** The writer's clock when the row was written, or null when it has none. */
  readonly writtenAt: number | null;
  /**
   * Whether the row can be believed about which fields it holds.
   *
   * False for an unversioned row and for anything below
   * `SNAPSHOT_SELF_DESCRIBING_VERSION`. When this is false a migration has
   * nothing to go on but the fields themselves, which is the situation every
   * shim below was written for and the situation they must keep handling.
   */
  readonly selfDescribing: boolean;
}

/**
 * Read a row's vintage without trusting a single thing about its shape.
 *
 * Deliberately parameterless-typed at `unknown`: this runs on a row that came
 * out of a table older than the type that describes it, and the one thing it
 * must never do is throw. A snapshot that is a number, a string, or null all
 * answer "no vintage", which is the truth.
 */
export function vintageOf(snapshot: unknown): Vintage {
  const row = typeof snapshot === "object" && snapshot !== null
    ? (snapshot as { version?: unknown; writtenAt?: unknown })
    : null;
  const version =
    typeof row?.version === "number" && Number.isFinite(row.version) ? row.version : null;
  const writtenAt =
    typeof row?.writtenAt === "number" && Number.isFinite(row.writtenAt)
      ? row.writtenAt
      : null;
  return {
    version,
    writtenAt,
    selfDescribing: version !== null && version >= SNAPSHOT_SELF_DESCRIBING_VERSION,
  };
}

/* ------------------------------------------------------------------ */
/* Retiring a migration on evidence                                     */
/* ------------------------------------------------------------------ */

/**
 * RETIREMENT — how "nothing older than this deploy is still in the table" is
 * established, rather than guessed.
 *
 * Every shim below is a field added to a round in flight, and every one of them
 * used to end with "deletable once nothing older than this deploy is still in
 * the table" with nothing measuring that. Two things measure it now.
 *
 * 1. **The boot log.** `recoverSessions` prints one line per boot naming, over
 *    every row it loaded: how many have no `version` at all, how many are below
 *    `SNAPSHOT_SELF_DESCRIBING_VERSION`, the minimum version present, and the
 *    oldest `writtenAt`. Grep CloudWatch for `snapshot vintage:`. A shim whose
 *    constant is at or below the reported minimum version, on every boot since
 *    the deploy that could still have written an old row, is dead code and can
 *    be deleted with that log line quoted in the commit message.
 *
 * 2. **The table, directly**, when the log is not enough — a row belonging to a
 *    session in a phase recovery does not scan, say. One read, no code:
 *
 *    ```
 *    aws dynamodb scan --table-name "$TABLE" \
 *      --filter-expression 'SK = :s AND (attribute_not_exists(version) OR version < :v)' \
 *      --expression-attribute-values '{":s":{"S":"SNAPSHOT"},":v":{"N":"2"}}' \
 *      --select COUNT
 *    ```
 *
 *    Zero, and no row predates version 2. Swap `:v` for the constant of the
 *    shim being retired. To name the rows still holding it up, replace
 *    `--select COUNT` with
 *
 *    ```
 *      --projection-expression 'PK,version,#a' \
 *      --expression-attribute-names '{"#a":"at"}'
 *    ```
 *
 *    `at` is a DynamoDB reserved word and has to be aliased — spelled
 *    literally it is a `ValidationException`, at the one moment somebody is
 *    following this procedure because something is wrong. `listAssets` in
 *    `store/dynamo.ts` aliases it for the same reason. `version` is not
 *    reserved.
 *
 *    The scan and the census can disagree about one row shape: a `version`
 *    attribute that is not a number compares false here and so is *not*
 *    counted, while `vintageOf` reads it as unknown vintage and does count
 *    it. Only a hand-written row can be that shape, and the census is the
 *    one to believe.
 *
 * What makes this converge rather than drift: `recoverSessions` writes every
 * recovered state straight back (see the note there), so **one boot re-stamps
 * every row it loaded at the current version**. A row can therefore only be
 * below the current version if it has not been through a boot since — which
 * during a blue/green deploy means the old task is still writing, and is exactly
 * why the answer is "no old row for N consecutive boots" rather than "no old row
 * once".
 *
 * One exception, added with #23: a `closed` session past `REOPEN_WINDOW_MS` is
 * skipped before it is rebuilt, so it is never re-stamped and its row keeps
 * whatever version it was written at until its `ttl` clears it. The census
 * still counts it — it runs over everything `loadRecoverable` returned, retired
 * or not — so the procedure stays honest and simply takes longer to converge:
 * the last thing holding a shim up may be a finished session waiting out its
 * retention rather than anything this process can re-stamp.
 *
 * A new field on a round in flight adds a constant here, one shim, and a
 * `SNAPSHOT_VERSION` bump. It does not add a function nobody can prove is dead.
 */

/**
 * The version from which a row is known to carry a dealt send-off plan.
 *
 * Both shims predate the version being read back, so both are simply "written
 * by code that has this file in it": a version 1 row, and a row with no version
 * at all, could be either side of the deploy that added the field, and can only
 * be sniffed. A field added *after* this lands gets a literal here — the version
 * it shipped in — and the assertion below gets sharp.
 */
const SENDOFF_PLAN_FROM = SNAPSHOT_SELF_DESCRIBING_VERSION;

/** The version from which a row is known to carry an Unseal crack record. */
const UNSEAL_CRACKED_FROM = SNAPSHOT_SELF_DESCRIBING_VERSION;

/**
 * The first version written *without* `spots` and without a `bench` score
 * status — the two things Spot Awards and Bench Credit left in the table.
 *
 * Sharp, unlike the two above, and the first constant here that can be: the
 * removal ships with `SNAPSHOT_VERSION` 3, so a row at 3 or better genuinely
 * cannot carry either field and a row below it may. That still does not make the
 * version the thing the migration *decides* on — see `migrateRetiredScoring`.
 */
const NO_RETIRED_SCORING_FROM = 3;

/**
 * Whether the row's own version says it already carries the field in question.
 *
 * Both halves matter and neither implies the other: an unversioned row cannot
 * claim anything at all, and a row at version 2 does not claim a field that
 * shipped in version 5. One function so that this shim, the next shim and the
 * shim after it all ask the question the same way — and so that the answer is
 * only ever used to *comment*. See the note at the sniff in `migrateSendoff`.
 */
function claimsField(vintage: Vintage, from: number): boolean {
  return vintage.selfDescribing && vintage.version !== null && vintage.version >= from;
}

/**
 * Rebuild one session's state from what the store had.
 *
 * Returns null when there is nothing usable: no snapshot and no events means
 * a session that was created and never opened, and inventing one from META
 * would put an empty lobby in the registry holding a live join code.
 *
 * `notes` is what the row's vintage disagreed with its contents about: empty in
 * the ordinary case, and never a reason to fail. Returned rather than logged so
 * the caller decides — `recoverSessions` prints them with the sid, the export
 * path has no log to print to.
 */
export function rehydrate(loaded: LoadedSession): {
  state: SessionState;
  from: "snapshot" | "log";
  replayed: number;
  notes: readonly string[];
} | null {
  const base =
    loaded.snapshot?.state ??
    (loaded.events.length > 0
      ? newSession({
          sid: loaded.meta.sid,
          title: loaded.meta.title,
          joinCode: loaded.meta.joinCode,
          // A log-only rebuild has no activity list to work from: the
          // snapshot is where it lives. The events still fold on, and any
          // score for an activity the engine does not know is refused rather
          // than silently kept, which is the honest failure.
          activities: [],
        })
      : null);
  if (!base) return null;

  const from: "snapshot" | "log" = loaded.snapshot ? "snapshot" : "log";
  const after = loaded.events.filter((e) => e.seq > (loaded.snapshot?.seq ?? 0));
  const vintage = vintageOf(loaded.snapshot);
  const notes: string[] = [];
  if (vintage.version !== null && vintage.version > SNAPSHOT_VERSION) {
    // A row from a newer deploy than this process: a rollback, or a blue/green
    // window with the new task already writing. Recorded and not refused — the
    // fields are read by name and an unknown extra one is harmless — but an
    // operator wants to know that a row was written by code this process is not.
    notes.push(
      `snapshot is version ${vintage.version}, newer than this code's ${SNAPSHOT_VERSION}`,
    );
  }
  const state = replay(
    migrateRetiredScoring(
      migrateUnseal(migrateSendoff(base, vintage, notes), vintage, notes),
      vintage,
      notes,
    ),
    withoutRetiredEvents(after, notes),
  );
  return { state, from, replayed: after.length, notes };
}

/**
 * Bring a send-off written by the old engine up to the current shape.
 *
 * A snapshot is trusted as state and replayed as-is, which is right until the
 * shape of the state changes under it. The send-off used to be an `opening`
 * montage followed by a `kudos` walk with no plan; it is now a dealt run, and
 * the first thing any surface does with one is read `plan`. Without this, one
 * closed session from last week is a TypeError on the first projection after
 * the deploy — and every session this process holds is in the same registry.
 *
 * The plan is rebuilt from seed 0 rather than a drawn one: this is a session
 * that has already happened, nobody is going to watch it again, and a stable
 * number is worth more here than a shuffle. The phase maps across as closely
 * as it can, landing a part-read set of messages on the right message.
 *
 * Deletable once no row below `SENDOFF_PLAN_FROM`, and no row with no version at
 * all, is left in the table — established by the boot log or the one-line scan
 * in RETIREMENT above, and quoted in the commit that deletes it. Not on a hunch.
 */
function migrateSendoff(
  state: SessionState,
  vintage: Vintage,
  notes: string[],
): SessionState {
  const so = state.sendoff as
    | (SessionState["sendoff"] & { openingStartedAt?: unknown })
    | null
    | undefined;
  // `== null` on purpose: a session created before the send-off existed has
  // no `sendoff` key at all, so this is `undefined` rather than `null`, and
  // `=== null` let it through to read `.plan` off nothing. That threw on the
  // first boot after the deploy — in `recoverSessions`, before the server
  // could listen, so every task died and the service never came up. A
  // migration runs against rows written by code that did not know it was
  // coming; it has to treat absent and empty as the same thing.
  if (so == null || Array.isArray(so.plan)) return state;

  // The fields decided that; the version only gets to comment on it.
  //
  // This order is not a style choice, it is the lesson of the nine-minute
  // outage. A version is a claim made by the code that wrote the row, and a row
  // written by code that did not know this migration was coming can claim
  // anything — including, once the field is optional, nothing at all. So the
  // sniff above is what decides whether to migrate, always, and the version
  // below is only ever allowed to say "that was surprising". A shim that skipped
  // its work because a row looked new enough would be the same bug again, with
  // a schema version standing in for `=== null`.
  if (claimsField(vintage, SENDOFF_PLAN_FROM)) {
    notes.push(
      `send-off has no plan on a version ${vintage.version} row, which should carry one ` +
        `(migrated anyway; SENDOFF_PLAN_FROM=${SENDOFF_PLAN_FROM} may be wrong)`,
    );
  }

  const legacy = so as unknown as { phase: string; at: number };
  const plan = buildPlan(so.content, 0);
  const phase: SendoffPhase =
    legacy.phase === "closing" ? "closing" : legacy.phase === "done" ? "done" : legacy.phase === "kudos" ? "run" : "title";
  const at =
    phase === "run"
      ? Math.max(
          0,
          plan.findIndex((s) => s.kind === "kudo" && s.at === legacy.at && s.part === 0),
        )
      : 0;

  return {
    ...state,
    sendoff: {
      content: so.content,
      phase,
      plan,
      at,
      auto: false,
      autoSeconds: DEFAULT_AUTO_SECONDS,
      slideAt: null,
    },
  };
}

/**
 * Give an Unseal round snapshotted by the one-strike engine its crack record.
 *
 * The same shape problem `migrateSendoff` exists for, and the same lesson: a
 * snapshot is trusted as state, so a field added to a round in flight arrives
 * missing on every row written before the deploy. Unseal is now two strikes and
 * `cracked` is read on every tap and every projection of the round — a session
 * recovered mid-Unseal without it is a TypeError in `recoverSessions`, before
 * the server can listen, which is how one absent send-off key took the whole
 * service down rather than one session.
 *
 * Empty is the honest value: the field records who has already had a wrong
 * letter, and a snapshot written by an engine that drained them on the first
 * one has nobody in that state to record. Anybody it did drain is drained in
 * `standing`, which this does not touch.
 *
 * Deletable once no row below `UNSEAL_CRACKED_FROM`, and no row with no version
 * at all, is left in the table — established by the boot log or the one-line
 * scan in RETIREMENT above, the same way `migrateSendoff` is.
 */
function migrateUnseal(
  state: SessionState,
  vintage: Vintage,
  notes: string[],
): SessionState {
  const arcade = state.arcade;
  const play = arcade?.play;
  if (!arcade || play?.kind !== "unseal") return state;
  // The field is either absent, on a row written before this deploy, or a
  // record — possibly an empty one, which is what a round nobody has gone wrong
  // in looks like. Only the absent case has anything to do, and the cast is
  // here because the type says it cannot happen and the table is older than the
  // type. `!= null` rather than `!== undefined` for migrateSendoff's reason: a
  // migration reads what was written, not what the current shape promises.
  if ((play.cracked as Readonly<Record<string, true>> | undefined) != null) {
    return state;
  }
  // As in `migrateSendoff`: the fields decide, the version comments. See the
  // note there for why that order is the whole point.
  if (claimsField(vintage, UNSEAL_CRACKED_FROM)) {
    notes.push(
      `Unseal round has no crack record on a version ${vintage.version} row, which should ` +
        `carry one (migrated anyway; UNSEAL_CRACKED_FROM=${UNSEAL_CRACKED_FROM} may be wrong)`,
    );
  }
  return {
    ...state,
    arcade: { ...arcade, play: { ...play, cracked: {} } },
  };
}

/**
 * Take Spot Awards and Bench Credit out of a snapshot written while they existed.
 *
 * Twelve live sessions carry one or both: a `spots` array on the state, and a
 * `scores[activityId][pid].status` of `"bench"`. Both are fields of the session
 * state, so they ride in the `SNAPSHOT` row, and `recoverSessions` loads every
 * one of those rows before the server listens.
 *
 * **The `spots` array is read by nothing now, and that is not enough.** An
 * unknown extra field is harmless to read, but a recovered state is written
 * straight back (see the note in `recoverSessions`), so an array nothing owns
 * would be copied forward through every `{ ...state }` in the engine and
 * re-stamped at the current version on every boot — a field that says a row is
 * newer than it is, forever. It is dropped here instead, once, on the way in.
 *
 * **A `bench` status is worse than dead weight.** `ScoreStatus` is now `played`
 * or `unset`, and a third value that the type says cannot exist reaches the wire
 * through `scoreRows` in views.ts, lands in the console's `data-status`, and is
 * excluded from normalisation without any surface saying why. Rewritten to
 * `unset` with a zeroed raw, which is what `setStatus` writes when a host clears
 * a cell and the closest honest reading of what a benched cell was: nobody typed
 * a score here, and nothing credits it. The participant's total changes — that
 * is the scoring-model change, not a migration bug, and SCORING.md's "Removed"
 * section is where it is written down.
 *
 * The fields decide, the version only comments — `migrateSendoff` has the long
 * version of why, and it is the lesson of the nine-minute outage. Even with a
 * sharp `NO_RETIRED_SCORING_FROM`, a row written by code that did not know this
 * was coming can claim anything.
 *
 * Deletable once no row below `NO_RETIRED_SCORING_FROM`, and no row with no
 * version at all, is left in the table — established by the boot log or the
 * one-line scan in RETIREMENT above, and quoted in the commit that deletes it.
 */
function migrateRetiredScoring(
  state: SessionState,
  vintage: Vintage,
  notes: string[],
): SessionState {
  // Cast, because the type no longer has the field and the table is older than
  // the type. `in` rather than a truthiness test: an empty `spots: []` is still a
  // field that would be copied forward, and a session that granted none wrote
  // exactly that.
  const loose = state as SessionState & { spots?: unknown };
  const hasSpots = "spots" in loose;

  // `Omit` then widen: intersecting `RawScore` with `{ status: string }` keeps
  // the narrow union and the comparison below becomes a type error rather than a
  // question about the table.
  type LooseScore = Omit<RawScore, "status"> & { status: string };
  const scores = state.scores as Readonly<
    Record<string, Readonly<Record<string, LooseScore>>>
  >;
  const benched: string[] = [];
  for (const activityId of Object.keys(scores)) {
    const bucket = scores[activityId];
    if (!bucket) continue;
    for (const pid of Object.keys(bucket)) {
      if (bucket[pid]?.status === "bench") benched.push(`${activityId}/${pid}`);
    }
  }

  if (!hasSpots && benched.length === 0) return state;

  // As in `migrateSendoff`: the fields decided, the version gets to comment.
  if (claimsField(vintage, NO_RETIRED_SCORING_FROM)) {
    notes.push(
      `snapshot is version ${vintage.version}, which should carry neither spots nor a ` +
        `bench status, and carries ${hasSpots ? "spots" : "no spots"} and ${benched.length} ` +
        `bench cell(s) (migrated anyway; NO_RETIRED_SCORING_FROM=${NO_RETIRED_SCORING_FROM} may be wrong)`,
    );
  }

  if (hasSpots) {
    const count = Array.isArray(loose.spots) ? loose.spots.length : "an unreadable";
    notes.push(`dropped ${count} Spot Award(s): the feature was removed`);
  }
  if (benched.length > 0) {
    notes.push(
      `cleared ${benched.length} Bench Credit cell(s) to unset (${benched.join(", ")}): ` +
        `the feature was removed, so the activity is worth nothing rather than a credited mean`,
    );
  }

  const nextScores: Record<string, Record<string, RawScore>> = {};
  for (const activityId of Object.keys(scores)) {
    const bucket = scores[activityId];
    if (!bucket) continue;
    const out: Record<string, RawScore> = {};
    for (const pid of Object.keys(bucket)) {
      const cell = bucket[pid];
      if (!cell) continue;
      out[pid] =
        cell.status === "bench" ? { raw: 0, status: "unset" } : (cell as RawScore);
    }
    nextScores[activityId] = out;
  }

  const next: SessionState & { spots?: unknown } = { ...loose, scores: nextScores };
  delete next.spots;
  return next;
}

/**
 * Drop the events the engine no longer has a case for, before they are replayed.
 *
 * This is the half of the removal that can actually take the service down, and
 * it is the shape of #16 exactly. `reduce` switches on `event.type` with no
 * `default` arm — the switch is exhaustive over `Event`, which is the right way
 * to write it — so an event type the engine has never heard of falls off the end
 * and `reduce` returns `undefined`. `replay` then reads `.state` off that, which
 * is a TypeError inside `recoverSessions`, before the server listens. Under ECS
 * that is a restart that recovers the same row, and it took the service down for
 * nine minutes the last time it happened.
 *
 * A snapshot normally covers everything, so the tail is "none or one" — but the
 * one can be a `grantSpot`, and a row with no snapshot at all replays its whole
 * log, which for any session that used Spot Awards is full of them.
 *
 * - `grantSpot` and `revokeSpot` are dropped. There is nothing left for them to
 *   write, and the points they carried are not in the model any more.
 * - `setStatus` with `status: "bench"` is rewritten to `unset`, which is what
 *   `migrateRetiredScoring` does to a stored bench cell. One mapping for both
 *   paths, so a session recovered from a snapshot and the same session recovered
 *   from its log do not end up on different totals.
 *
 * Every drop and rewrite is in `notes`, because a recovery that silently
 * discarded events would be indistinguishable from a store that lost them.
 */
function withoutRetiredEvents(
  events: readonly { readonly event: Event; readonly at: number }[],
  notes: string[],
): { event: Event; at: number }[] {
  // The cast is the point: these types are gone from `Event`, and what is in the
  // log is whatever the deploy before this one wrote.
  const out: { event: Event; at: number }[] = [];
  let dropped = 0;
  let rewritten = 0;
  for (const e of events) {
    const type = (e.event as { type?: unknown } | null | undefined)?.type;
    if (type === "grantSpot" || type === "revokeSpot") {
      dropped += 1;
      continue;
    }
    const loose = e.event as { type?: unknown; status?: unknown };
    if (type === "setStatus" && loose.status === "bench") {
      rewritten += 1;
      out.push({ event: { ...(e.event as object), status: "unset" } as Event, at: e.at });
      continue;
    }
    out.push({ event: e.event, at: e.at });
  }
  if (dropped > 0) {
    notes.push(`skipped ${dropped} retired Spot Award event(s) in the replayed tail`);
  }
  if (rewritten > 0) {
    notes.push(`rewrote ${rewritten} bench setStatus event(s) to unset in the replayed tail`);
  }
  return out;
}

/**
 * Everybody the snapshot thought was present is marked away.
 *
 * Run through the reducer, not by hand: `disconnect` is an event the engine
 * already knows, and going round it would be the first game rule to leak into
 * the driver.
 */
export function markEveryoneDisconnected(state: SessionState, now: number): SessionState {
  const present = Object.values(state.participants).filter(
    (p) => p.connected && !p.kicked,
  );
  return replay(
    state,
    present.map((p) => ({ event: { type: "disconnect" as const, pid: p.pid }, at: now })),
  );
}

/** What the rows in the table say about their vintage, in one object. */
export interface SnapshotCensus {
  /** Rows loaded, snapshot or not. */
  readonly rows: number;
  /** Rows with a snapshot to have a vintage at all. */
  readonly snapshots: number;
  /** Snapshots with no `version` attribute: written before it was read back. */
  readonly unversioned: number;
  /** Snapshots below `SNAPSHOT_SELF_DESCRIBING_VERSION`, `unversioned` aside. */
  readonly stale: number;
  /** Snapshots claiming a version this code has never written. */
  readonly ahead: number;
  /** The lowest version present, or null when nothing carries one. */
  readonly minVersion: number | null;
  /** The oldest `writtenAt` present, or null when nothing carries one. */
  readonly oldestWrittenAt: number | null;
}

/**
 * Count what is actually in the table, so a shim can be retired on evidence.
 *
 * Pure and exported for the tests: the number that matters is "how many rows
 * cannot say what shape they are", and a function returning it is worth more
 * than a log line nobody can assert on. See RETIREMENT above for how it is used.
 */
export function censusOfSnapshots(loaded: readonly LoadedSession[]): SnapshotCensus {
  let snapshots = 0;
  let unversioned = 0;
  let stale = 0;
  let ahead = 0;
  let minVersion: number | null = null;
  let oldestWrittenAt: number | null = null;
  const rows: readonly LoadedSession[] = Array.isArray(loaded) ? loaded : [];
  for (const row of rows) {
    // `row` may be anything: this walks what the store handed back, and the
    // point of the census is to survive the rows it is counting.
    const snapshot = (row as { snapshot?: unknown } | null | undefined)?.snapshot;
    if (typeof snapshot !== "object" || snapshot === null) continue;
    snapshots += 1;
    const v = vintageOf(snapshot);
    if (v.version === null) unversioned += 1;
    else {
      if (v.version < SNAPSHOT_SELF_DESCRIBING_VERSION) stale += 1;
      if (v.version > SNAPSHOT_VERSION) ahead += 1;
      minVersion = minVersion === null ? v.version : Math.min(minVersion, v.version);
    }
    if (v.writtenAt !== null) {
      oldestWrittenAt =
        oldestWrittenAt === null ? v.writtenAt : Math.min(oldestWrittenAt, v.writtenAt);
    }
  }
  return {
    rows: rows.length,
    snapshots,
    unversioned,
    stale,
    ahead,
    minVersion,
    oldestWrittenAt,
  };
}

/** The census as the one greppable line the boot log carries. */
export function describeCensus(c: SnapshotCensus): string {
  const when =
    c.oldestWrittenAt === null
      ? "no write time on any row"
      : `oldest written ${new Date(c.oldestWrittenAt).toISOString()}`;
  const version =
    c.minVersion === null ? "no version on any row" : `lowest version ${c.minVersion}`;
  return (
    `  recovery: snapshot vintage: ${c.snapshots} snapshot(s) of ${c.rows} row(s), ` +
    `${version}, ${c.unversioned} unversioned, ${c.stale} below v${SNAPSHOT_SELF_DESCRIBING_VERSION}, ` +
    `${c.ahead} ahead of this code's v${SNAPSHOT_VERSION}, ${when}` +
    (c.unversioned === 0 && c.stale === 0 && c.snapshots > 0
      ? " — every row can say what shape it is"
      : "")
  );
}

/**
 * Whatever this row calls itself, for a log line — and never a throw.
 *
 * The sid is read outside the rebuild's try/catch because the catch needs it:
 * `session.meta.sid` on a row whose `meta` is absent throws *inside* the handler,
 * which escapes the loop, escapes `recoverSessions`, and is the boot-time death
 * the per-session catch was added to prevent. A row too broken to name is still
 * a row that must not take the service down.
 */
function sidOf(row: unknown): string {
  const sid = (row as { meta?: { sid?: unknown } } | null | undefined)?.meta?.sid;
  return typeof sid === "string" && sid !== "" ? sid : "(a row with no sid)";
}

/**
 * Whether this row is a finished session old enough to leave where it is.
 *
 * Read off the row rather than off a rebuilt state, and read *before* the
 * rebuild, which is the point: a retired session is one this process should
 * not rehydrate, should not run the migration shims over, and should not write
 * back. Doing the age check after any of that would keep the cost it exists to
 * avoid. `sidOf`'s defensiveness for the same reason — this runs on whatever
 * the store handed back, and it must not be the thing that throws.
 */
function retiredRow(row: unknown, now: number): boolean {
  const meta = (row as { meta?: { phase?: unknown; updatedAt?: unknown } } | null | undefined)
    ?.meta;
  const phase = meta?.phase;
  const updatedAt = meta?.updatedAt;
  if (typeof phase !== "string" || typeof updatedAt !== "number") return false;
  return retiredByAge(phase as LoadedSession["meta"]["phase"], updatedAt, now);
}

export async function recoverSessions(
  store: SessionStore,
  registry: SessionRegistry,
  log: (line: string) => void = console.log,
  now: number = Date.now(),
): Promise<RecoveredSession[]> {
  let loaded: LoadedSession[];
  try {
    loaded = await store.loadRecoverable();
  } catch (err) {
    log(
      `  recovery: could not read the store (${String(err)}) — starting with no sessions`,
    );
    return [];
  }

  // The evidence line. Printed before the walk, so it is in the log even if a
  // later row is the one that goes wrong, and greppable because retiring a
  // migration means reading it across a run of boots — see RETIREMENT above.
  // `Array.isArray` because a store that answered with something other than a
  // list would otherwise take the boot down on the `for` below, which is the one
  // failure this whole function is shaped around.
  const rows = Array.isArray(loaded) ? loaded : [];
  try {
    log(describeCensus(censusOfSnapshots(rows)));
  } catch {
    // A census is a diagnostic. It does not get to be the reason a boot fails.
    log("  recovery: snapshot vintage: could not be read");
  }

  const out: RecoveredSession[] = [];
  const failed: { sid: string; why: string }[] = [];
  const retired: string[] = [];
  for (const session of rows) {
    const sid = sidOf(session);

    // A session that finished long enough ago is left in the table, and this
    // process does not take it on. #23.
    //
    // The registry used to hold every closed session for the life of the task,
    // because `loadRecoverable` returns them and this loop restored whatever it
    // was returned. Three things followed, and only the first is cosmetic: the
    // admin session listing became unreadable during the event it is used at;
    // the write below re-stamped `updatedAt` on every boot so the 90-day `ttl`
    // never arrived; and `shutdown` wrote all of them back on SIGTERM, which
    // re-created rows an operator had deleted by hand an hour earlier.
    //
    // Skipped *here*, before `rehydrate`, so the row is not replayed and not
    // put through the migration shims either — a session that finished in
    // August has no business being migrated on every restart.
    //
    // Not a failure and not a deletion. The row is untouched, its scores and
    // its event log are still downloadable by sid because the export path
    // reads the store directly, and its `ttl` is finally free to run out. The
    // only thing it loses is `reopen`, which is the capability this window is
    // sized around: see `REOPEN_WINDOW_MS`.
    if (retiredRow(session, now)) {
      retired.push(sid);
      continue;
    }
    // One row must not be able to take down the service.
    //
    // This loop runs inside `main.ts` *before* the server listens, so anything
    // thrown here is not a failed recovery — it is a process that exits, an
    // ECS task that dies, and a replacement that dies the same way on the same
    // row. A deploy in September 2026 did exactly that: a send-off migration
    // read `.plan` off a session created before send-offs existed, and a
    // four-day-old smoke test took the whole service down three hours before
    // an event.
    //
    // A session that cannot be rebuilt is one session lost, which is bad and
    // recoverable. Every session lost plus no service is neither. So the walk
    // is per-session, the failure is named with its sid, and the rest come up.
    try {
      const built = rehydrate(session);
      if (!built) {
        log(`  recovery: ${sid} has no snapshot and no events — skipped`);
        continue;
      }
      // What the row's version disagreed with the row's contents about. Empty in
      // the ordinary case, on either an old row or a current one: a note means a
      // migration fired where the version said it should not have, which is a
      // constant in this file being wrong, not a session being wrong.
      for (const note of built.notes) log(`  recovery: ${sid}: ${note}`);

      // Two sids are in play here and nothing used to check they agree.
      //
      // `sid` above is the META row's, and it is what every line in this log
      // is named by. `registry.restore` keys the live registry off the
      // *snapshot's* `state.sid` instead. In the ordinary case they are the
      // same string and the difference is invisible — which is the problem: a
      // partial write that lands META and not SNAPSHOT, or a snapshot restored
      // under another id, brings the session up under a key the boot log never
      // mentions. `bySessionId(<the sid in the log>)` then returns nothing, and
      // it returns nothing at the one moment the log is all you have.
      //
      // Refused rather than reconciled. Preferring one silently would be
      // picking which of two disagreeing records to believe about the question
      // "which session is this", and there is no basis for that choice; a row
      // whose own two halves disagree is a row nobody can reason about. So it
      // goes through the same door as any other unrebuildable row: named,
      // skipped, and the rest of the boot comes up without it. The throw is
      // deliberate — the catch below is what turns it into that.
      if (built.state.sid !== sid) {
        throw new Error(
          `the META row calls this session ${sid} but its snapshot calls it ` +
            `${built.state.sid}; the registry would have keyed it by the ` +
            `snapshot's and the log by META's, so no lookup would find it`,
        );
      }

      // And the same pair one field over, which is #22.
      //
      // The join code is recorded twice as well: `registry.restore` keys
      // `byCode` off the *snapshot's* `state.joinCode`, and META carries its
      // own, which is what a log-only rebuild seeds `newSession` with a few
      // lines up in `rehydrate`. So the two are read on different paths and
      // nothing used to make them agree.
      //
      // A divergence is worse here than the sid one reads, because it is
      // invisible from every surface: the session comes up, the console
      // works, the boot log is clean, and the join link printed on the card
      // in the host's hand resolves to nothing while the room is live under a
      // code nobody has. `byJoinCode` is the only lookup a phone ever does.
      //
      // Refused rather than reconciled, for the reason the sid check gives:
      // choosing which of two disagreeing records to believe about "what code
      // gets you into this room" is a choice with no basis, and getting it
      // wrong sends a phone into the wrong session rather than into none.
      const metaJoinCode = session.meta.joinCode;
      if (built.state.joinCode !== metaJoinCode) {
        throw new Error(
          `the META row gives this session the join code ${metaJoinCode} but ` +
            `its snapshot gives ${built.state.joinCode}; the registry would ` +
            `have keyed it by the snapshot's, so the code on META — the one a ` +
            `log-only rebuild would have used — would open nothing`,
        );
      }

      const state = markEveryoneDisconnected(built.state, now);
      const runtime = registry.restore(session, state);

      // Write the corrected state straight back. Until someone reconnects, the
      // stored snapshot would otherwise still claim a room full of people, and
      // a second restart would recover that claim all over again.
      //
      // It is also what makes the vintage converge: the row goes back at the
      // current `SNAPSHOT_VERSION`, so one clean boot re-stamps every row it
      // loaded and the census above is a measure of what has happened *since*.
      runtime.persistence.snapshot(state, now);
      runtime.persistence.meta(runtime.meta());

      out.push({
        // The sid the registry actually keyed this session by, which is the
        // one that answers a lookup. The check above has just established that
        // it equals META's, so this is the same string either way — written
        // this way because the log has to name the key, not the label, and a
        // future edit that relaxes the check should not silently change which
        // of the two this line reports.
        sid: state.sid,
        runtime,
        from: built.from,
        replayed: built.replayed,
        participants: Object.keys(state.participants).length,
      });
    } catch (err) {
      // Logged loudly rather than swallowed: a session that was live and did
      // not come back is something the host has to be told about, and the sid
      // is what makes it findable in the table afterwards. `sid` was read before
      // the try for this line's sake — see `sidOf`.
      failed.push({ sid, why: String(err) });
    }
  }

  for (const f of failed) {
    log(`  recovery: ${f.sid} COULD NOT BE REBUILT and was skipped — ${f.why}`);
  }
  if (failed.length > 0) {
    log(
      `  recovery: ${failed.length} session(s) failed to rebuild. The service is up ` +
        `without them; the rows are still in the table and nothing was deleted.`,
    );
  }
  if (retired.length > 0) {
    // One line, not one per session: the whole point is that these are rows
    // nobody has to think about. Named in full anyway, because the first
    // question about a session that is not in the listing is whether the
    // process dropped it or never saw it.
    const days = Math.round(REOPEN_WINDOW_MS / 86_400_000);
    log(
      `  recovery: ${retired.length} closed session(s) last changed more than ` +
        `${days} day(s) ago — left in the table, not restored, and no longer ` +
        `reopenable: ${retired.join(", ")}`,
    );
  }
  if (out.length === 0 && failed.length === 0 && retired.length === 0) {
    log("  recovery: no live sessions to restore");
  }
  for (const r of out) {
    log(
      `  recovery: ${r.sid} restored from ${r.from}` +
        (r.replayed > 0 ? ` +${r.replayed} event(s)` : "") +
        `, ${r.participants} participant(s), all disconnected until they reconnect`,
    );
  }
  return out;
}
