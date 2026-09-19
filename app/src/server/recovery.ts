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
import type { SessionState } from "../engine/types.ts";
import type { SessionRegistry, SessionRuntime } from "./runtime.ts";
import type { LoadedSession, SessionStore } from "./store/types.ts";

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
 * Rebuild one session's state from what the store had.
 *
 * Returns null when there is nothing usable: no snapshot and no events means
 * a session that was created and never opened, and inventing one from META
 * would put an empty lobby in the registry holding a live join code.
 */
export function rehydrate(loaded: LoadedSession): {
  state: SessionState;
  from: "snapshot" | "log";
  replayed: number;
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
  const state = replay(
    base,
    after.map((e) => ({ event: e.event, at: e.at })),
  );
  return { state, from, replayed: after.length };
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

  const out: RecoveredSession[] = [];
  for (const session of loaded) {
    const built = rehydrate(session);
    if (!built) {
      log(`  recovery: ${session.meta.sid} has no snapshot and no events — skipped`);
      continue;
    }
    const state = markEveryoneDisconnected(built.state, now);
    const runtime = registry.restore(session, state);

    // Write the corrected state straight back. Until someone reconnects, the
    // stored snapshot would otherwise still claim a room full of people, and
    // a second restart would recover that claim all over again.
    runtime.persistence.snapshot(state, now);
    runtime.persistence.meta(runtime.meta(now));

    out.push({
      sid: session.meta.sid,
      runtime,
      from: built.from,
      replayed: built.replayed,
      participants: Object.keys(state.participants).length,
    });
  }

  if (out.length === 0) log("  recovery: no live sessions to restore");
  for (const r of out) {
    log(
      `  recovery: ${r.sid} restored from ${r.from}` +
        (r.replayed > 0 ? ` +${r.replayed} event(s)` : "") +
        `, ${r.participants} participant(s), all disconnected until they reconnect`,
    );
  }
  return out;
}
