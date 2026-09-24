/**
 * The in-memory store.
 *
 * Not a test double bolted on afterwards: it is the default store, so the
 * suite, the bot harness and a first `npm run dev` all run with no container,
 * no credentials and no network. The DynamoDB implementation is the one that
 * has to earn its place, and it is held to this file's behaviour.
 *
 * Values are deep-copied on the way in and out, because the point of a store
 * is that what you read back is what was written, not a live reference to the
 * object the caller has since replaced.
 */

import type { SessionState } from "../../engine/types.ts";
import {
  type LoadedSession,
  type SessionMeta,
  type SessionStore,
  type StoredEvent,
  type StoredParticipant,
} from "./types.ts";

interface Row {
  meta: SessionMeta | null;
  snapshot: { seq: number; state: SessionState } | null;
  events: Map<number, StoredEvent>;
  participants: Map<string, StoredParticipant>;
}

const copy = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements SessionStore {
  readonly kind = "memory" as const;

  private readonly rows = new Map<string, Row>();
  private readonly codes = new Map<string, string>();

  /**
   * Set to fail the next writes. The persist path is supposed to degrade to
   * in-memory rather than drop a participant's answer, and that claim is only
   * worth making if something proves it.
   */
  failWrites = false;

  async init(): Promise<void> {
    /* nothing to create */
  }

  private row(sid: string): Row {
    let r = this.rows.get(sid);
    if (!r) {
      r = { meta: null, snapshot: null, events: new Map(), participants: new Map() };
      this.rows.set(sid, r);
    }
    return r;
  }

  private guard(): void {
    if (this.failWrites) throw new Error("memory store: writes disabled");
  }

  async putMeta(meta: SessionMeta): Promise<void> {
    this.guard();
    this.row(meta.sid).meta = copy(meta);
  }

  async putSnapshot(sid: string, state: SessionState, _at: number): Promise<void> {
    this.guard();
    this.row(sid).snapshot = { seq: state.seq, state: copy(state) };
  }

  async appendEvent(sid: string, record: StoredEvent): Promise<void> {
    this.guard();
    // Keyed by seq, like the real sort key: a retried append is the same item
    // twice, not two items.
    this.row(sid).events.set(record.seq, copy(record));
  }

  async putParticipant(sid: string, participant: StoredParticipant): Promise<void> {
    this.guard();
    this.row(sid).participants.set(participant.pid, copy(participant));
  }

  async putJoinCode(joinCode: string, sid: string): Promise<void> {
    this.guard();
    this.codes.set(joinCode, sid);
  }

  async deleteJoinCode(joinCode: string): Promise<void> {
    this.guard();
    this.codes.delete(joinCode);
  }

  private assemble(sid: string, row: Row): LoadedSession | null {
    if (!row.meta) return null;
    return {
      meta: copy(row.meta),
      snapshot: row.snapshot ? copy(row.snapshot) : null,
      events: [...row.events.values()].sort((a, b) => a.seq - b.seq).map(copy),
      participants: [...row.participants.values()].map(copy),
    };
  }

  async loadRecoverable(): Promise<LoadedSession[]> {
    const out: LoadedSession[] = [];
    for (const [sid, row] of this.rows) {
      // Mirrors the DynamoDB scan, `draft` included — see the note there.
      // These two must agree, or the tests pass against behaviour production
      // does not have.
      const phase = row.meta?.phase;
      if (phase === undefined) continue;
      const s = this.assemble(sid, row);
      if (s) out.push(s);
    }
    return out;
  }

  async loadSession(sid: string): Promise<LoadedSession | null> {
    const row = this.rows.get(sid);
    return row ? this.assemble(sid, row) : null;
  }

  async close(): Promise<void> {
    /* nothing to close */
  }

  /** Test affordances: what is on disk, for asserting on the write path. */
  sids(): string[] {
    return [...this.rows.keys()];
  }

  codeCount(): number {
    return this.codes.size;
  }
}
