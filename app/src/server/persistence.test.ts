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
import {
  censusOfSnapshots,
  describeCensus,
  recoverSessions,
  rehydrate,
  vintageOf,
} from "./recovery.ts";
import { DEFAULT_ACTIVITIES, SessionRegistry } from "./runtime.ts";
import { MemoryStore } from "./store/memory.ts";
import {
  eventSortKey,
  SNAPSHOT_SELF_DESCRIBING_VERSION,
  SNAPSHOT_VERSION,
  type LoadedSession,
  type SessionMeta,
  type StoredSnapshot,
} from "./store/types.ts";

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

  it("recovers a session in every phase, closed included", async () => {
    // A draft session is one created but not yet opened, which is exactly
    // when a host sets one up in advance. Leaving it out meant a deploy — or
    // ECS replacing a task — rebuilt the registry without it, and a correct
    // console link answered `bad_token`. The rows were all still in the
    // store, so the CSV export kept working while the socket did not, which
    // is what made it confusing. This happened for real the day before an
    // event; the test that used to be here asserted the behaviour that broke
    // it.
    //
    // A closed one comes back too, because `reopen` exists to undo an
    // accidental close and could not reach a session the restart had dropped.
    // The worry was a retention window full of finished sessions; the table
    // held two rows. If that changes, bound it by `updatedAt`, not by phase.
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    s.created.runtime.apply({ type: "close" }, Date.now());
    const draft = freshSession(store); // never opened: still draft
    await s.persister.drain();

    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    const recovered = await recoverSessions(store, registry2, () => {});

    assert.equal(recovered.length, 2, "the draft one and the closed one");
    assert.ok(
      registry2.bySessionId(draft.sid),
      "a draft session is reachable after a restart — that is when a host sets one up",
    );
    assert.ok(
      registry2.bySessionId(s.sid),
      "and a closed one, or an accidental close outlives the process and cannot be undone",
    );
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

/**
 * A restart has to survive a restart.
 *
 * `restartSession` is an ordinary event: it emits a `persist` effect, so the
 * snapshot and the log entry go down the same path every other transition
 * uses. What is worth testing out here is the two things the engine cannot
 * know about — that the stored META's `phase` moves back to something
 * `loadRecoverable` scans for, and that the join code goes back in the table
 * after a close took it out. Without either, the session comes back as a
 * lobby nobody can reach.
 */
describe("restarting a session, durably", () => {
  it("snapshots the wipe and appends it to the log", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    const before = (await store.loadSession(s.sid))?.events.length ?? 0;

    s.created.runtime.apply({ type: "restartSession" }, Date.now());
    await s.persister.drain();

    const loaded = await store.loadSession(s.sid);
    assert.equal(loaded?.events.length, before + 1);
    assert.equal(
      loaded?.events.at(-1)?.event.type,
      "restartSession",
      "the wipe is in the audit trail like everything else",
    );
    assert.deepEqual(loaded?.snapshot?.state.scores["trivia"], {});
    assert.equal(loaded?.snapshot?.state.spots.length, 0);
    assert.equal(loaded?.snapshot?.state.phase, "lobby");
    assert.equal(loaded?.meta.phase, "lobby", "META is what a restart scans on");
  });

  it("comes back from a process restart as the clean lobby, with the room in it", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    s.created.runtime.apply({ type: "restartSession" }, Date.now());
    await s.persister.drain();

    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    const recovered = await recoverSessions(store, registry2, () => {});
    assert.equal(recovered.length, 1, "a restarted session is still recoverable");

    const back = registry2.bySessionId(s.sid);
    assert.ok(back);
    assert.equal(back.state.phase, "lobby");
    assert.equal(back.state.seal, "live");
    assert.deepEqual(back.state.scores["trivia"], {});
    assert.equal(back.state.spots.length, 0);
    assert.deepEqual(computeStandings(back.state).map((x) => x.total), [0, 0]);
    // And the room is still the room.
    assert.deepEqual(Object.keys(back.state.participants).sort(), ["p1", "p2"]);
    assert.equal(back.state.participants["p1"]?.playerNumber, 1);
    assert.equal(back.pidForRejoin(s.token), "p1", "phones still come back as themselves");
    assert.equal(registry2.byJoinCode(back.state.joinCode)?.state.sid, s.sid);
  });

  it("puts the join code back when a closed session is restarted", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    s.created.runtime.apply({ type: "close" }, Date.now());
    await s.persister.drain();
    assert.equal(store.codeCount(), 0, "closing drops it");

    s.created.runtime.apply({ type: "restartSession" }, Date.now());
    await s.persister.drain();
    assert.equal(store.codeCount(), 1, "restarting puts it back");
  });

  it("puts the join code back on a reopen too, keeping every score", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    const wanted = computeStandings(s.created.runtime.state);
    s.created.runtime.apply({ type: "close" }, Date.now());
    await s.persister.drain();

    s.created.runtime.apply({ type: "reopen" }, Date.now());
    await s.persister.drain();
    assert.equal(store.codeCount(), 1);

    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    await recoverSessions(store, registry2, () => {});
    const back = registry2.bySessionId(s.sid);
    assert.equal(back?.state.phase, "running");
    assert.deepEqual(computeStandings(back!.state), wanted);
  });

  it("recovers by replaying the wipe when the snapshot is older than it", async () => {
    // The slow path, and the one that would show an off-by-one: a snapshot
    // from before the restart, plus the log entry for the restart itself.
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    const stale = await store.loadSession(s.sid);
    assert.ok(stale?.snapshot);

    s.created.runtime.apply({ type: "restartSession" }, Date.now());
    await s.persister.drain();
    const fresh = await store.loadSession(s.sid);
    assert.ok(fresh);

    const rebuilt = rehydrate({ ...fresh, snapshot: stale.snapshot });
    assert.ok(rebuilt);
    assert.ok(rebuilt.replayed >= 1, "the restart had to be replayed");
    assert.equal(rebuilt.state.phase, "lobby");
    assert.deepEqual(rebuilt.state.scores["trivia"], {});
    assert.deepEqual(rebuilt.state, fresh.snapshot?.state);
  });
});

describe("a row that cannot be rebuilt", () => {
  /**
   * The failure this guards against is not "one session is lost".
   *
   * `recoverSessions` runs before the server listens, so a throw in the walk
   * is a process that exits, an ECS task that dies, and a replacement that
   * dies on the same row. A deploy in September 2026 did exactly that: a
   * send-off migration read `.plan` off a session created before send-offs
   * existed, and one four-day-old smoke test took the service down for nine
   * minutes three hours before an event.
   */
  it("is skipped, and every other session still comes up", async () => {
    const store = new MemoryStore();
    const good = await playAnAfternoon(store);

    // A row the rebuild cannot survive. `state` is not a session at all, which
    // is the shape of the real failure: something the code of the day did not
    // expect, reached into without checking.
    const poisoned = await store.loadRecoverable();
    const original = store.loadRecoverable.bind(store);
    store.loadRecoverable = async () => [
      {
        meta: { sid: "ses_poison", title: "t", joinCode: "hvs.x" },
        snapshot: { seq: 1, state: { participants: null } as never },
        events: [],
      } as never,
      ...(await original()),
    ];
    assert.equal(poisoned.length, 1, "fixture should start with one session");

    const lines: string[] = [];
    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    const recovered = await recoverSessions(store, registry2, (l) => lines.push(l));

    // The healthy session is up.
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.sid, good.sid);
    assert.ok(registry2.bySessionId(good.sid), "the good session did not come back");

    // The poisoned one is not, and said so with its sid.
    assert.equal(registry2.bySessionId("ses_poison"), undefined);
    const shout = lines.find((l) => l.includes("ses_poison"));
    assert.ok(shout, `the failure was not logged: ${lines.join(" | ")}`);
    assert.match(shout, /COULD NOT BE REBUILT/);
  });

  it("comes up with no sessions at all rather than not coming up", async () => {
    const store = new MemoryStore();
    store.loadRecoverable = async () =>
      [
        {
          meta: { sid: "ses_poison", title: "t", joinCode: "hvs.x" },
          snapshot: { seq: 1, state: { participants: null } as never },
          events: [],
        },
      ] as never;

    const lines: string[] = [];
    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    const recovered = await recoverSessions(store, registry2, (l) => lines.push(l));
    assert.deepEqual(recovered, [], "nothing should have been recovered");
    assert.ok(
      lines.some((l) => l.includes("failed to rebuild")),
      "the summary line is what tells an operator to go looking",
    );
  });
});

/* ------------------------------------------------------------------ */
/* What a snapshot row says about itself                                */
/* ------------------------------------------------------------------ */

/**
 * The migration coverage a reader comes here looking for.
 *
 * `migrateSendoff` and `migrateUnseal` are exercised in full from
 * `engine/sendoff.test.ts` and `engine/unseal.test.ts`, where each round's own
 * harness lives and where a legacy round can be built honestly. What is here is
 * the part that belongs to the store rather than to a round: that a row can say
 * which shape it is, that a row which cannot say is still recovered, and that
 * what a row says is never allowed to decide whether a migration runs.
 */
const LEGACY_SENDOFF_CONTENT = {
  name: "Sai Linn Thu",
  subtitle: "Last day 20 March 2026",
  opening: { photos: ["p01.jpg", "p02.jpg"], seconds: 40, music: null },
  kudos: [
    { from: "Jessica Ang", message: "one" },
    { from: "Yong Wen", message: "two" },
  ],
  closing: { photos: [], line: "Thank you, Sai." },
};

function vintageBase() {
  return newSession({
    sid: "ses_vintage",
    title: "Vintage",
    joinCode: "hvs.vintagevintagevintagevin",
    activities: DEFAULT_ACTIVITIES,
  });
}

function metaOf(sid: string): SessionMeta {
  return {
    sid,
    title: "Vintage",
    joinCode: "hvs.vintagevintagevintagevin",
    phase: "running",
    seal: "live",
    hostTokenHash: "h",
    screenTokenHash: "s",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** One loaded row around a state, with whatever vintage the test is about. */
function rowOf(state: unknown, snap: Partial<StoredSnapshot> = {}): LoadedSession {
  return {
    meta: metaOf("ses_vintage"),
    snapshot: { seq: 1, state: state as never, ...snap },
    events: [],
    participants: [],
  };
}

/** A send-off in the shape the engine wrote before the run existed. */
function legacySendoffState() {
  return {
    ...vintageBase(),
    sendoff: {
      content: LEGACY_SENDOFF_CONTENT,
      phase: "kudos",
      at: 1,
      openingStartedAt: null,
    },
  };
}

/** An Unseal round in the shape the one-strike engine wrote: no `cracked`. */
function legacyUnsealState() {
  return {
    ...vintageBase(),
    arcade: { play: { kind: "unseal", at: 0 } },
  };
}

/** The row as the code before the version was read back wrote it. */
function asWrittenByTheOldCode(loaded: LoadedSession): LoadedSession {
  assert.ok(loaded.snapshot, "the fixture has no snapshot to age");
  // seq and state, and nothing else: no `version`, no `writtenAt`. Not set to
  // null — absent, which is what the row in the table actually looks like and
  // the distinction the September outage turned on.
  return { ...loaded, snapshot: { seq: loaded.snapshot.seq, state: loaded.snapshot.state } };
}

describe("the snapshot's vintage", () => {
  it("stamps every row this code writes with its version and its write time", async () => {
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    const loaded = await store.loadSession(s.sid);
    assert.ok(loaded?.snapshot);

    assert.equal(loaded.snapshot.version, SNAPSHOT_VERSION);
    assert.equal(typeof loaded.snapshot.writtenAt, "number");
    const v = vintageOf(loaded.snapshot);
    assert.equal(v.selfDescribing, true, "a row this code wrote cannot say what it is");
    assert.equal(v.version, SNAPSHOT_VERSION);
  });

  it("reads no vintage off a row that has none, and invents neither", () => {
    const v = vintageOf(asWrittenByTheOldCode(rowOf(vintageBase())).snapshot);
    assert.deepEqual(v, { version: null, writtenAt: null, selfDescribing: false });
  });

  it("refuses a vintage that is not a number rather than believing it", () => {
    // A row can hold anything; the table is older than the type. A version of
    // `"2"` is not a version, and treating it as one would let the assertion
    // below fire on a row that never made the claim.
    const v = vintageOf({ version: "2", writtenAt: "yesterday" });
    assert.deepEqual(v, { version: null, writtenAt: null, selfDescribing: false });
    for (const junk of [null, undefined, 7, "SNAPSHOT", [], { version: NaN }]) {
      assert.equal(vintageOf(junk).selfDescribing, false, `believed ${String(junk)}`);
    }
  });

  it("counts what the table holds, so a shim can be retired on evidence", () => {
    const base = vintageBase();
    const census = censusOfSnapshots([
      asWrittenByTheOldCode(rowOf(base)),
      rowOf(base, { version: 1, writtenAt: 9_000 }),
      rowOf(base, { version: SNAPSHOT_VERSION, writtenAt: 5_000 }),
      { meta: metaOf("ses_logonly"), snapshot: null, events: [], participants: [] },
    ]);
    assert.equal(census.rows, 4);
    assert.equal(census.snapshots, 3, "the log-only row has no vintage to count");
    assert.equal(census.unversioned, 1);
    assert.equal(census.stale, 1, `version 1 is below v${SNAPSHOT_SELF_DESCRIBING_VERSION}`);
    assert.equal(census.ahead, 0);
    assert.equal(census.minVersion, 1);
    assert.equal(census.oldestWrittenAt, 5_000);

    // The line an operator greps for, and the sentence that says the shims are
    // ready to go.
    const line = describeCensus(census);
    assert.match(line, /snapshot vintage:/);
    assert.match(line, /1 unversioned/);
    assert.ok(
      !line.includes("every row can say what shape it is"),
      "claimed the table was clean while holding an unversioned row",
    );
    assert.match(
      describeCensus(censusOfSnapshots([rowOf(base, { version: SNAPSHOT_VERSION, writtenAt: 1 })])),
      /every row can say what shape it is/,
    );
  });

  it("notices a row written by a newer deploy than this process", () => {
    const built = rehydrate(
      rowOf(vintageBase(), { version: SNAPSHOT_VERSION + 1, writtenAt: 1 }),
    );
    assert.ok(built, "a row from the future is still a row to recover");
    assert.equal(built.notes.length, 1);
    assert.match(built.notes[0] ?? "", /newer than this code/);
  });

  it("prints the vintage at boot, which is where the evidence comes from", async () => {
    const store = new MemoryStore();
    await playAnAfternoon(store);
    const lines: string[] = [];
    await recoverSessions(store, new SessionRegistry(new Persister(store, () => {})), (l) =>
      lines.push(l),
    );
    const line = lines.find((l) => l.includes("snapshot vintage:"));
    assert.ok(line, `no vintage line in the boot log: ${lines.join(" | ")}`);
    assert.match(line, new RegExp(`lowest version ${SNAPSHOT_VERSION}`));
    assert.match(line, /0 unversioned/);
  });
});

describe("a snapshot written before the version field existed", () => {
  it("round-trips through recovery with everything it was holding", async () => {
    // The entire reason the shims exist is a row written before the deploy, so
    // a version that broke one would have defeated its own purpose. This is a
    // real session, played and persisted, with its vintage taken back off.
    const store = new MemoryStore();
    const s = await playAnAfternoon(store);
    const wanted = computeStandings(s.created.runtime.state);
    const fresh = await store.loadSession(s.sid);
    assert.ok(fresh);
    const old = asWrittenByTheOldCode(fresh);
    store.loadRecoverable = async () => [old];

    const lines: string[] = [];
    const persister2 = new Persister(store, () => {});
    const registry2 = new SessionRegistry(persister2);
    const recovered = await recoverSessions(store, registry2, (l) => lines.push(l));

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.from, "snapshot");
    assert.equal(recovered[0]?.replayed, 0);
    const back = registry2.bySessionId(s.sid);
    assert.ok(back, "an unversioned row did not come back");
    assert.deepEqual(computeStandings(back.state), wanted);
    assert.equal(back.state.seal, "sealed");
    assert.deepEqual(Object.keys(back.state.participants).sort(), ["p1", "p2"]);
    assert.equal(
      back.state.spots.filter((a) => a.pid === "p2").length,
      1,
      "the spot award did not survive",
    );

    // And the boot said what it was looking at, rather than recovering it
    // silently and leaving nobody able to tell.
    const line = lines.find((l) => l.includes("snapshot vintage:"));
    assert.match(line ?? "", /1 unversioned/);
    assert.match(line ?? "", /no version on any row/);

    // One boot re-stamps it. This is what makes the census converge, and
    // therefore what makes "no old row for N boots" an argument rather than a
    // hope — see RETIREMENT in recovery.ts.
    await persister2.drain();
    const after = await store.loadSession(s.sid);
    assert.equal(after?.snapshot?.version, SNAPSHOT_VERSION);
    assert.equal(typeof after?.snapshot?.writtenAt, "number");
  });

  it("still gets the send-off migration, because the fields decide, not the version", () => {
    const built = rehydrate(asWrittenByTheOldCode(rowOf(legacySendoffState())));
    const so = built?.state.sendoff;
    assert.ok(so, "the session did not come back");
    assert.ok(Array.isArray(so.plan) && so.plan.length > 0, "no plan was built");
    assert.equal(so.phase, "run");
    assert.deepEqual(built?.notes, [], "an old row is not an anomaly, it is the point");
  });

  it("still gets the Unseal migration, for the same reason", () => {
    const built = rehydrate(asWrittenByTheOldCode(rowOf(legacyUnsealState())));
    const play = built?.state.arcade?.play as { cracked?: unknown } | undefined;
    assert.deepEqual(play?.cracked, {}, "the crack record was not filled in");
    assert.deepEqual(built?.notes, []);
  });

  it("gets both migrations on a row whose vintage is itself garbage", () => {
    const state = { ...legacySendoffState(), arcade: { play: { kind: "unseal", at: 0 } } };
    const built = rehydrate(
      rowOf(state, { version: "2" as never, writtenAt: {} as never }),
    );
    assert.ok(Array.isArray(built?.state.sendoff?.plan), "no plan was built");
    assert.deepEqual(
      (built?.state.arcade?.play as { cracked?: unknown }).cracked,
      {},
      "the crack record was not filled in",
    );
  });
});

describe("a version that claims more than the row holds", () => {
  /**
   * The safety property of the whole design, and the one worth breaking a build
   * over: the version is allowed to *comment* on a row, never to decide whether
   * a migration runs. A shim that skipped its work because the row looked new
   * enough would be the nine-minute outage again with a schema version standing
   * in for `=== null`.
   */
  it("migrates the send-off anyway, and says the version was wrong", () => {
    const built = rehydrate(
      rowOf(legacySendoffState(), { version: SNAPSHOT_VERSION, writtenAt: 1 }),
    );
    assert.ok(
      Array.isArray(built?.state.sendoff?.plan),
      "the shape was left broken because the row claimed it was fine",
    );
    assert.equal(built?.notes.length, 1);
    assert.match(built.notes[0] ?? "", /send-off has no plan on a version/);
    assert.match(built.notes[0] ?? "", /SENDOFF_PLAN_FROM/);
  });

  it("migrates the Unseal round anyway, and says the version was wrong", () => {
    const built = rehydrate(
      rowOf(legacyUnsealState(), { version: SNAPSHOT_VERSION, writtenAt: 1 }),
    );
    assert.deepEqual(
      (built?.state.arcade?.play as { cracked?: unknown } | undefined)?.cracked,
      {},
      "the shape was left broken because the row claimed it was fine",
    );
    assert.equal(built?.notes.length, 1);
    assert.match(built.notes[0] ?? "", /UNSEAL_CRACKED_FROM/);
  });

  it("carries the anomaly into the boot log with the sid beside it", async () => {
    const store = new MemoryStore();
    store.loadRecoverable = async () => [
      rowOf(legacySendoffState(), { version: SNAPSHOT_VERSION, writtenAt: 1 }),
    ];
    const lines: string[] = [];
    await recoverSessions(store, new SessionRegistry(new Persister(store, () => {})), (l) =>
      lines.push(l),
    );
    const shout = lines.find((l) => l.includes("send-off has no plan"));
    assert.ok(shout, `the anomaly was not logged: ${lines.join(" | ")}`);
    assert.match(shout, /ses_vintage/);
  });
});

describe("every shape a stored row can be in", () => {
  /**
   * Boot survives all of it. Not "recovers all of it" — most of these are rows
   * nothing could rebuild — but `recoverSessions` resolves, the healthy session
   * comes up, and each failure is named with whatever the row could be called.
   *
   * The failure being guarded is not one lost session: this walk runs before the
   * server listens, so a throw is an ECS task that dies and a replacement that
   * dies the same way on the same row. That is a nine-minute outage three hours
   * before an event, and it happened.
   */
  it("is survivable, one row at a time", async () => {
    const base = vintageBase();
    const rows: unknown[] = [
      null,
      undefined,
      42,
      "SNAPSHOT",
      {},
      { meta: null, snapshot: null, events: [] },
      { meta: { sid: 7 }, snapshot: null, events: [] },
      { meta: metaOf("g_state_null"), snapshot: { seq: 1, state: null }, events: [] },
      { meta: metaOf("g_state_number"), snapshot: { seq: 1, state: 7 }, events: [] },
      { meta: metaOf("g_state_array"), snapshot: { seq: 1, state: [] }, events: [] },
      { meta: metaOf("g_snapshot_string"), snapshot: "SNAPSHOT", events: [] },
      { meta: metaOf("g_seq_nan"), snapshot: { seq: NaN, state: base }, events: [] },
      {
        meta: metaOf("g_participants_null"),
        snapshot: { seq: 1, state: { ...base, participants: null } },
        events: [],
      },
      {
        meta: metaOf("g_participant_null"),
        snapshot: { seq: 1, state: { ...base, participants: { p1: null } } },
        events: [],
      },
      // The migrations' own blind spots: a `sendoff` that is neither absent,
      // null, nor a send-off, and a `cracked` that is not a record.
      {
        meta: metaOf("g_sendoff_num"),
        snapshot: { seq: 1, state: { ...base, sendoff: 42 } },
        events: [],
      },
      {
        meta: metaOf("g_sendoff_str"),
        snapshot: { seq: 1, state: { ...base, sendoff: "kudos" } },
        events: [],
      },
      {
        meta: metaOf("g_sendoff_empty"),
        snapshot: { seq: 1, state: { ...base, sendoff: { phase: "kudos", at: 0 } } },
        events: [],
      },
      {
        meta: metaOf("g_cracked_num"),
        snapshot: { seq: 1, state: { ...base, arcade: { play: { kind: "unseal", cracked: 5 } } } },
        events: [],
      },
      {
        meta: metaOf("g_arcade_string"),
        snapshot: { seq: 1, state: { ...base, arcade: "unseal" } },
        events: [],
      },
      { meta: metaOf("g_events_string"), snapshot: { seq: 1, state: base }, events: "nope" },
      { meta: metaOf("g_events_null"), snapshot: { seq: 1, state: base }, events: null },
      { meta: metaOf("g_event_items"), snapshot: null, events: [null, 3, { seq: "x" }] },
      { meta: metaOf("g_no_participants"), snapshot: { seq: 1, state: base }, events: [] },
      {
        meta: metaOf("g_vintage_junk"),
        snapshot: { seq: 1, state: base, version: {}, writtenAt: [] },
        events: [],
      },
    ];

    const store = new MemoryStore();
    const good = await playAnAfternoon(store);
    const real = await store.loadRecoverable();
    store.loadRecoverable = async () => [...rows, ...real] as never;

    const lines: string[] = [];
    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    let thrown: unknown = null;
    let recovered: Awaited<ReturnType<typeof recoverSessions>> = [];
    try {
      recovered = await recoverSessions(store, registry2, (l) => lines.push(l));
    } catch (err) {
      thrown = err;
    }
    // The assertion the file exists for.
    assert.equal(
      thrown,
      null,
      `recovery threw, so the service would not have started: ${String(thrown)}`,
    );

    // The healthy session is up, behind every one of those rows.
    assert.ok(
      recovered.some((r) => r.sid === good.sid),
      "the good session did not come back",
    );
    assert.ok(registry2.bySessionId(good.sid), "the good session is not in the registry");

    // The rows that could not be rebuilt said so, and a row too broken to name
    // is still named something rather than crashing the log line.
    assert.ok(
      lines.some((l) => l.includes("COULD NOT BE REBUILT")),
      "nothing was reported as unrebuildable",
    );
    assert.ok(
      lines.some((l) => l.includes("(a row with no sid)")),
      `an unnameable row was not named: ${lines.join(" | ")}`,
    );
    assert.ok(lines.some((l) => l.includes("failed to rebuild")));
    assert.ok(lines.some((l) => l.includes("snapshot vintage:")));
  });

  it("survives a store that answers with something that is not a list", async () => {
    // Belt and braces for the same failure mode: the `for` over the rows is
    // outside any per-row catch, so a non-iterable answer would take the boot
    // down before the first row was even looked at.
    const store = new MemoryStore();
    store.loadRecoverable = async () => ({ Items: [] }) as never;
    const lines: string[] = [];
    const recovered = await recoverSessions(
      store,
      new SessionRegistry(new Persister(store, () => {})),
      (l) => lines.push(l),
    );
    assert.deepEqual(recovered, []);
    assert.ok(lines.some((l) => l.includes("no live sessions to restore")));
  });

  it("survives a store that cannot be read at all", async () => {
    const store = new MemoryStore();
    store.loadRecoverable = async () => {
      throw new Error("dynamodb is having a day");
    };
    const lines: string[] = [];
    const recovered = await recoverSessions(
      store,
      new SessionRegistry(new Persister(store, () => {})),
      (l) => lines.push(l),
    );
    assert.deepEqual(recovered, []);
    assert.ok(lines.some((l) => l.includes("could not read the store")));
  });
});

describe("the DynamoDB row, both directions", () => {
  /**
   * The memory store cannot prove this, and that matters here more than usual:
   * every storage bug this file's comments record was a DynamoDB-only bug that
   * the suite missed because the suite runs on memory. The write is stubbed at
   * the document client, which is the lowest seam that needs no AWS.
   */
  async function stubbed(answer: (command: unknown) => unknown) {
    const { DynamoStore } = await import("./store/dynamo.ts");
    const store = new DynamoStore({ table: "quorum-test", region: "us-east-1" });
    const sent: unknown[] = [];
    (store as unknown as { doc: { send: (c: unknown) => Promise<unknown> } }).doc = {
      send: async (command: unknown) => {
        sent.push(command);
        return answer(command);
      },
    };
    return { store, sent };
  }

  it("writes the version, and the write time it is dated by", async () => {
    const { store, sent } = await stubbed(() => ({}));
    const state = vintageBase();
    await store.putSnapshot("ses_dynamo", state, 1_760_000_000_000);
    const item = (sent[0] as { input: { Item: Record<string, unknown> } }).input.Item;
    assert.equal(item["SK"], "SNAPSHOT");
    assert.equal(item["version"], SNAPSHOT_VERSION);
    assert.equal(item["at"], 1_760_000_000_000);
  });

  it("reads the version and the write time back off the row", async () => {
    const { store } = await stubbed(() => ({
      Items: [
        { PK: "SESSION#ses_dynamo", SK: "META", sid: "ses_dynamo", phase: "running" },
        {
          PK: "SESSION#ses_dynamo",
          SK: "SNAPSHOT",
          seq: 4,
          version: SNAPSHOT_VERSION,
          at: 1_760_000_000_000,
          state: vintageBase(),
        },
      ],
    }));
    const loaded = await store.loadSession("ses_dynamo");
    assert.equal(loaded?.snapshot?.version, SNAPSHOT_VERSION);
    assert.equal(loaded?.snapshot?.writtenAt, 1_760_000_000_000);
    assert.equal(vintageOf(loaded?.snapshot).selfDescribing, true);
  });

  it("leaves an old row's vintage absent rather than defaulting it", async () => {
    // The row the shims exist for: written before the version was read back, so
    // it has no `version` at all. A zero default would make it claim version 0
    // and a `Date.now()` default would make it claim it was written today —
    // either one turns "I do not know" into a false answer, and retiring a
    // migration on a false answer is how the field arrives missing again.
    const { store } = await stubbed(() => ({
      Items: [
        { PK: "SESSION#ses_old", SK: "META", sid: "ses_old", phase: "running" },
        { PK: "SESSION#ses_old", SK: "SNAPSHOT", seq: 4, state: vintageBase() },
      ],
    }));
    const loaded = await store.loadSession("ses_old");
    assert.ok(loaded?.snapshot, "the row did not load");
    assert.equal("version" in loaded.snapshot, false);
    assert.equal("writtenAt" in loaded.snapshot, false);
    assert.deepEqual(vintageOf(loaded.snapshot), {
      version: null,
      writtenAt: null,
      selfDescribing: false,
    });
    // And it still recovers.
    assert.ok(rehydrate(loaded), "an old DynamoDB row did not rehydrate");
  });

  it("ignores a version or a write time that is not a number", async () => {
    const { store } = await stubbed(() => ({
      Items: [
        { PK: "SESSION#ses_junk", SK: "META", sid: "ses_junk", phase: "running" },
        {
          PK: "SESSION#ses_junk",
          SK: "SNAPSHOT",
          seq: 4,
          version: "2",
          at: "yesterday",
          state: vintageBase(),
        },
      ],
    }));
    const loaded = await store.loadSession("ses_junk");
    assert.equal(loaded?.snapshot?.version, undefined);
    assert.equal(loaded?.snapshot?.writtenAt, undefined);
  });
});
