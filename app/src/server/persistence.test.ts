/**
 * Durability: what a session leaves behind, and what comes back.
 *
 * Expected behaviour comes from ARCHITECTURE.md ("Data model", "Durability and
 * restart") — the snapshot is the fast path, the event log is the audit trail,
 * socket-level state is explicitly *not* durable, and a write that fails must
 * cost durability rather than the game.
 *
 * Everything here runs against the in-memory store, which is the same object
 * the DynamoDB implementation is written to match. Nothing needs AWS, a
 * container, or a network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newSession } from "../engine/reducer.ts";
import { computeStandings } from "../engine/scoring.ts";
import { Persister } from "./persist.ts";
import { recoverSessions, rehydrate } from "./recovery.ts";
import { DEFAULT_ACTIVITIES, SessionRegistry } from "./runtime.ts";
import { MemoryStore } from "./store/memory.ts";
import { eventSortKey } from "./store/types.ts";

let n = 0;

function freshSession(store: MemoryStore) {
  n += 1;
  const persister = new Persister(store, () => {});
  const registry = new SessionRegistry(persister);
  const created = registry.add(
    newSession({
      sid: `ses_p_${n}`,
      title: `Persist ${n}`,
      joinCode: `hvs.persist${String(n).padStart(3, "0")}xxxxxxxxxxxxx`,
      activities: DEFAULT_ACTIVITIES,
    }),
  );
  return { registry, persister, created, sid: created.runtime.state.sid };
}

/** A session with two players, scores, a spot award and a sealed board. */
async function playAnAfternoon(store: MemoryStore) {
  const s = freshSession(store);
  const { runtime } = s.created;
  const now = Date.now();
  runtime.apply({ type: "open" }, now);
  runtime.apply({ type: "start" }, now);
  runtime.apply({ type: "join", pid: "p1", nickname: "Priya" }, now);
  runtime.apply({ type: "join", pid: "p2", nickname: "Kenji" }, now);
  const token = runtime.issueRejoinToken("p1");
  runtime.apply({ type: "setScore", activityId: "trivia", pid: "p1", raw: 18400 }, now);
  runtime.apply({ type: "setScore", activityId: "trivia", pid: "p2", raw: 14720 }, now);
  runtime.apply(
    { type: "grantSpot", pid: "p2", activityId: "trivia", reason: "best recovery" },
    now,
  );
  runtime.apply({ type: "setSeal", seal: "sealed" }, now);
  await s.persister.drain();
  return { ...s, token };
}

describe("the write path", () => {
  it("writes META at creation, with the token hashes the snapshot cannot hold", async () => {
    const store = new MemoryStore();
    const s = freshSession(store);
    await s.persister.drain();

    const loaded = await store.loadSession(s.sid);
    assert.ok(loaded, "the session should be on disk before anything happens to it");
    assert.equal(loaded.meta.joinCode, s.created.runtime.state.joinCode);
    assert.equal(loaded.meta.hostTokenHash, s.created.runtime.secrets.hostTokenHash);
    assert.equal(loaded.meta.screenTokenHash, s.created.runtime.secrets.screenTokenHash);
    assert.notEqual(loaded.meta.hostTokenHash, "");
  });

  it("writes the snapshot and appends the event on every accepted transition", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    const loaded = await store.loadSession(s.sid);
    assert.ok(loaded?.snapshot);

    assert.equal(loaded.snapshot.seq, s.created.runtime.state.seq);
    assert.equal(loaded.snapshot.state.seal, "sealed");
    assert.deepEqual(
      loaded.events.map((e) => e.event.type),
      ["open", "start", "join", "join", "setScore", "setScore", "grantSpot", "setSeal"],
    );
    // Append-only, and in seq order. The log is sparse in seq rather than
    // contiguous — an event the engine accepted without asking for a persist
    // (a disconnect) moves the counter and writes nothing — so what matters
    // is that the order is the engine's order, which the sort key guarantees.
    assert.deepEqual(
      loaded.events.map((e) => e.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  });

  it("does not persist connection churn — who is connected is not durable", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    const before = (await store.loadSession(s.sid))?.events.length ?? 0;

    s.created.runtime.apply({ type: "disconnect", pid: "p1" }, Date.now());
    s.created.runtime.apply({ type: "reconnect", pid: "p1" }, Date.now());
    await s.persister.drain();

    const after = await store.loadSession(s.sid);
    assert.equal(after?.events.length, before);
  });

  it("drops the join code when the session closes", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    assert.equal(store.codeCount(), 1);
    s.created.runtime.apply({ type: "close" }, Date.now());
    await s.persister.drain();
    assert.equal(store.codeCount(), 0, "a finished session should not still be joinable");
  });

  it("does not block the game when the store is failing", async () => {
    const store = new MemoryStore();
    const lines: string[] = [];
    const persister = new Persister(store, (l) => lines.push(l));
    const registry = new SessionRegistry(persister);
    const created = registry.add(
      newSession({
        sid: "ses_fail",
        title: "Failing",
        joinCode: "hvs.failfailfailfailfailfail",
        activities: DEFAULT_ACTIVITIES,
      }),
    );
    store.failWrites = true;

    const now = Date.now();
    created.runtime.apply({ type: "open" }, now);
    created.runtime.apply({ type: "start" }, now);
    created.runtime.apply({ type: "join", pid: "p1", nickname: "Priya" }, now);
    const out = created.runtime.apply(
      { type: "setScore", activityId: "trivia", pid: "p1", raw: 900 },
      now,
    );
    await persister.drain();

    // The answer landed. That is the whole point: durability degrades, the
    // game does not.
    assert.equal(out.applied, true);
    assert.equal(created.runtime.state.scores["trivia"]?.["p1"]?.raw, 900);
    assert.ok(persister.health().failures > 0);
    assert.equal(persister.health().degraded, true);
    // Logged, and logged once per streak rather than once per event.
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /will not survive a restart/);

    // And it heals: the next snapshot is a full overwrite, so one successful
    // write brings the stored state all the way back up to date.
    store.failWrites = false;
    created.runtime.apply({ type: "setSeal", seal: "sealed" }, Date.now());
    await persister.drain();
    const loaded = await store.loadSession("ses_fail");
    assert.equal(loaded?.snapshot?.state.scores["trivia"]?.["p1"]?.raw, 900);
    assert.equal(persister.health().degraded, false);
  });
});

describe("restart recovery", () => {
  it("brings a mid-flight session back with its scores, roster and seal", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    const wanted = computeStandings(s.created.runtime.state);

    // The process dies. A new one boots against the same table.
    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    const recovered = await recoverSessions(store, registry2, () => {});
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.from, "snapshot");
    assert.equal(recovered[0]?.replayed, 0);

    const back = registry2.bySessionId(s.sid);
    assert.ok(back);
    assert.equal(back.state.phase, "running");
    assert.equal(back.state.seal, "sealed");
    assert.equal(back.state.title, s.created.runtime.state.title);
    assert.deepEqual(Object.keys(back.state.participants).sort(), ["p1", "p2"]);
    assert.equal(back.state.participants["p1"]?.playerNumber, 1);
    assert.equal(back.state.spots.length, 1);
    assert.deepEqual(computeStandings(back.state), wanted);
  });

  it("marks everyone disconnected — a socket cannot survive the process", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    assert.equal(s.created.runtime.state.participants["p1"]?.connected, true);

    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    await recoverSessions(store, registry2, () => {});
    const back = registry2.bySessionId(s.sid);

    for (const p of Object.values(back?.state.participants ?? {})) {
      assert.equal(p.connected, false, `${p.nickname} should be away until they reconnect`);
    }
  });

  it("writes the corrected roster back, so a second restart does not re-learn it", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);

    const p2 = new Persister(store, () => {});
    const registry2 = new SessionRegistry(p2);
    await recoverSessions(store, registry2, () => {});
    await p2.drain();

    const loaded = await store.loadSession(s.sid);
    assert.equal(loaded?.snapshot?.state.participants["p1"]?.connected, false);
  });

  it("keeps rejoin tokens, so a phone comes back as itself", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);

    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    await recoverSessions(store, registry2, () => {});
    const back = registry2.bySessionId(s.sid);

    assert.equal(back?.pidForRejoin(s.token), "p1");
    assert.equal(back?.pidForRejoin("hvs.notatoken"), undefined);
  });

  it("keeps the host and screen tokens, and the join code lookup", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);

    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    await recoverSessions(store, registry2, () => {});

    const back = registry2.byJoinCode(s.created.runtime.state.joinCode);
    assert.equal(back?.state.sid, s.sid);
    assert.equal(back?.secrets.hostTokenHash, s.created.runtime.secrets.hostTokenHash);
  });

  it("leaves closed and draft sessions where they are", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    s.created.runtime.apply({ type: "close" }, Date.now());
    freshSession(store); // never opened: still draft
    await s.persister.drain();

    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    const recovered = await recoverSessions(store, registry2, () => {});
    assert.deepEqual(recovered, []);
  });

  it("replays events written after the snapshot", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);

    // The shape of a crash between the snapshot write and the event write
    // landing: the log is one ahead of the snapshot. ARCHITECTURE.md says
    // "there should be none or one".
    const runtime = s.created.runtime;
    const seq = runtime.state.seq + 1;
    await store.appendEvent(s.sid, {
      seq,
      event: { type: "setScore", activityId: "trivia", pid: "p2", raw: 18400 },
      at: Date.now(),
    });

    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    const recovered = await recoverSessions(store, registry2, () => {});
    assert.equal(recovered[0]?.replayed, 1);
    assert.equal(
      registry2.bySessionId(s.sid)?.state.scores["trivia"]?.["p2"]?.raw,
      18400,
    );
  });

  it("falls back to the log when the snapshot is missing", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    const loaded = await store.loadSession(s.sid);
    assert.ok(loaded);

    const bare = { ...loaded, snapshot: null };
    const built = rehydrate(bare);
    // Activities are not in the log, so scores for them cannot be replayed —
    // the slow path recovers the lifecycle and the roster, and the snapshot
    // is what carries the rest. Recorded here because it is a real limit.
    assert.equal(built?.from, "log");
    assert.equal(built?.state.phase, "running");
    assert.equal(built?.state.seal, "sealed");
    assert.deepEqual(Object.keys(built?.state.participants ?? {}).sort(), ["p1", "p2"]);
  });

  it("skips a session with neither snapshot nor log rather than inventing one", () => {
    const built = rehydrate({
      meta: {
        sid: "ses_empty",
        title: "Empty",
        joinCode: "hvs.emptyemptyemptyemptyempt",
        phase: "lobby",
        seal: "live",
        hostTokenHash: "h",
        screenTokenHash: "s",
        createdAt: 0,
        updatedAt: 0,
      },
      snapshot: null,
      events: [],
      participants: [],
    });
    assert.equal(built, null);
  });
});

describe("the key layout", () => {
  it("pads the event sort key so lexical order is numeric order", () => {
    assert.equal(eventSortKey(7), "EVENT#0000000007");
    assert.ok(eventSortKey(9) < eventSortKey(10), "9 must sort before 10");
    assert.ok(eventSortKey(99) < eventSortKey(100));
  });
});
