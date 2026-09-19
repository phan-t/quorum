/**
 * The write path: the driver side of the engine's `persist` effect.
 *
 * Three properties, in the order they matter:
 *
 * 1. **It never blocks the game.** `SessionRuntime.apply()` stays synchronous
 *    and returns before anything reaches the network. A store that has gone
 *    slow must not turn into a pause between a host clicking reveal and the
 *    room seeing it.
 * 2. **It is in order, per session.** Writes go through one promise chain per
 *    sid, so the snapshot for seq 41 can never land after the one for seq 40
 *    and leave the stored state older than the log.
 * 3. **It degrades rather than fails.** The in-memory state is the truth while
 *    the process runs; the store is what makes a restart survivable. A write
 *    that fails costs durability, and losing durability is strictly better
 *    than losing a participant's answer. Failures are counted, logged once per
 *    streak, and surfaced on `/healthz`.
 *
 * Snapshots coalesce. A snapshot is a full overwrite, so when three arrive
 * while the first is still in flight only the newest is worth writing — the
 * queue cannot grow without bound during a burst, and the stored state ends
 * up at the same place either way.
 */

import type { SessionState } from "../engine/types.ts";
import type {
  SessionMeta,
  SessionStore,
  StoredEvent,
  StoredParticipant,
} from "./store/types.ts";
import { describe } from "./store/index.ts";

/** What one session hands to the store. Handed to the runtime at construction. */
export interface SessionPersistence {
  meta(meta: SessionMeta): void;
  snapshot(state: SessionState, at: number): void;
  event(record: StoredEvent): void;
  participant(p: StoredParticipant): void;
  joinCode(code: string, sid: string): void;
  deleteJoinCode(code: string): void;
}

export interface PersistHealth {
  readonly kind: string;
  readonly pending: number;
  readonly failures: number;
  readonly degraded: boolean;
  readonly lastError?: string;
}

interface Chain {
  tail: Promise<void>;
  pendingSnapshot: { state: SessionState; at: number } | null;
  snapshotQueued: boolean;
}

export class Persister {
  private readonly chains = new Map<string, Chain>();
  private pending = 0;
  private failures = 0;
  private consecutive = 0;
  private lastError: string | undefined;

  readonly store: SessionStore;
  private readonly log: (line: string) => void;

  // Fields assigned in the body, not parameter properties: Node runs this
  // source by stripping types, and `constructor(private x: T)` is the one
  // piece of TypeScript that has no type-free equivalent to strip down to.
  constructor(store: SessionStore, log: (line: string) => void = console.warn) {
    this.store = store;
    this.log = log;
  }

  health(): PersistHealth {
    return {
      kind: this.store.kind,
      pending: this.pending,
      failures: this.failures,
      // One failure is a blip; a run of them means the room is playing on a
      // process whose death would cost the session.
      degraded: this.consecutive >= 3,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  private chain(sid: string): Chain {
    let c = this.chains.get(sid);
    if (!c) {
      c = { tail: Promise.resolve(), pendingSnapshot: null, snapshotQueued: false };
      this.chains.set(sid, c);
    }
    return c;
  }

  /** Append one write to a session's chain. Never throws, never awaited. */
  private enqueue(sid: string, what: string, run: () => Promise<void>): void {
    const c = this.chain(sid);
    this.pending += 1;
    c.tail = c.tail.then(async () => {
      try {
        await run();
        this.consecutive = 0;
      } catch (err) {
        this.failures += 1;
        this.consecutive += 1;
        this.lastError = `${what}: ${describe(err)}`;
        // Once per streak. A store that is down for a minute would otherwise
        // write a line per event and bury everything else in the log.
        if (this.consecutive === 1 || this.consecutive % 50 === 0) {
          this.log(
            `[persist] ${sid} ${what} failed (${this.consecutive} in a row): ${describe(err)} — ` +
              `the session continues in memory and will not survive a restart`,
          );
        }
      } finally {
        this.pending -= 1;
      }
    });
  }

  /** Everything queued has been written, or has failed and been logged. */
  async drain(): Promise<void> {
    // Two passes: a write can enqueue nothing further today, but draining in
    // one pass would still miss anything queued while the first was awaited.
    for (let i = 0; i < 2; i += 1) {
      await Promise.all([...this.chains.values()].map((c) => c.tail));
    }
  }

  forSession(sid: string): SessionPersistence {
    return {
      meta: (meta) => this.enqueue(sid, "meta", () => this.store.putMeta(meta)),
      snapshot: (state, at) => {
        const c = this.chain(sid);
        c.pendingSnapshot = { state, at };
        if (c.snapshotQueued) return;
        c.snapshotQueued = true;
        this.enqueue(sid, "snapshot", async () => {
          const next = c.pendingSnapshot;
          c.pendingSnapshot = null;
          c.snapshotQueued = false;
          if (next) await this.store.putSnapshot(sid, next.state, next.at);
        });
      },
      event: (record) =>
        this.enqueue(sid, `event#${record.seq}`, () =>
          this.store.appendEvent(sid, record),
        ),
      participant: (p) =>
        this.enqueue(sid, `participant#${p.pid}`, () =>
          this.store.putParticipant(sid, p),
        ),
      joinCode: (code, forSid) =>
        this.enqueue(sid, "joinCode", () => this.store.putJoinCode(code, forSid)),
      deleteJoinCode: (code) =>
        this.enqueue(sid, "deleteJoinCode", () => this.store.deleteJoinCode(code)),
    };
  }
}

/** A persistence handle that writes nowhere. The default for a bare runtime. */
export const NO_PERSISTENCE: SessionPersistence = {
  meta: () => {},
  snapshot: () => {},
  event: () => {},
  participant: () => {},
  joinCode: () => {},
  deleteJoinCode: () => {},
};
