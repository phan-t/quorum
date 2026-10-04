/**
 * The boundary `recoverSessions` relies on, and which used to end at the wrong
 * place.
 *
 * `recoverSessions` has a per-session try/catch so that one poisoned row is
 * skipped by name and the rest of the boot comes up. That catch returns long
 * before the timers it armed ever fire. Two holes lived in the gap:
 *
 * - **#16.** A row that recovered cleanly could still kill the process one tick
 *   later, because a timer callback throws into Node's event loop, which has no
 *   handler. Under ECS that is a restart, which recovers the same row, which
 *   arms the same timer. A crash loop that no log calls a failure, because
 *   recovery genuinely succeeded.
 * - **#14.** The registry keys a session by the snapshot's sid and the boot log
 *   names it by META's, with nothing asserting they agree — so a row whose two
 *   halves disagree comes up live under a key the log never mentions.
 * - **#22.** The same pair one field over. `joinCode` is recorded twice as
 *   well, the registry keys `byCode` off the snapshot's and a log-only rebuild
 *   seeds from META's, and a divergence is invisible from every surface: the
 *   session is live under a code nobody has while the link in the host's hand
 *   opens nothing.
 * - **#23.** The other direction — not a row that must not come back, but a
 *   row that must stop coming back. Every closed session was recovered for
 *   ever, re-stamped on every boot so its `ttl` never arrived, and written
 *   again on every SIGTERM, which re-created the rows an operator had just
 *   deleted.
 *
 * All of them are tested here rather than in `persistence.test.ts` because
 * none is about persistence working. They are about what happens when it has
 * not, and about what a boot has to refuse.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { newSession, replay } from "../engine/reducer.ts";
import type { Activity, Event, Question, SessionState } from "../engine/types.ts";
import { Persister } from "./persist.ts";
import { recoverSessions } from "./recovery.ts";
import { DEFAULT_ACTIVITIES, SessionRegistry } from "./runtime.ts";
import { assembleSession } from "./store/dynamo.ts";
import { MemoryStore } from "./store/memory.ts";
import {
  RECOVERABLE_PHASES,
  REOPEN_WINDOW_MS,
  retiredByAge,
  type SessionMeta,
} from "./store/types.ts";

/** Long enough for a `setTimeout(…, 0)` to have run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/**
 * `main.ts` with its comments taken out, for the structural tests.
 *
 * Module scope rather than inside one `describe` because two of them read it
 * now: the socket listeners and the SIGTERM write. `main.ts` cannot be
 * imported and poked at — it listens on a port and runs recovery at the top
 * level — so reading the source is what is available, and the property these
 * assert is only ever whether a guard is present.
 */
const mainSrc = (): string =>
  readFileSync(new URL("./main.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Comment-only lines as well, so a wrapper is not judged absent merely
    // because the line above it explains why it is there. Whole lines only:
    // a blanket `//` strip would eat the rest of any line holding a URL.
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

function metaFor(state: SessionState, at: number): SessionMeta {
  return {
    sid: state.sid,
    title: state.title,
    joinCode: state.joinCode,
    phase: state.phase,
    seal: state.seal,
    hostTokenHash: "h",
    screenTokenHash: "s",
    createdAt: at,
    updatedAt: at,
  };
}

const ACTIVITIES: readonly Activity[] = [
  { id: "trivia", title: "Trivia", kind: "trivia" },
];

const QUESTIONS: readonly Question[] = [
  {
    text: "Which product does secrets management?",
    answers: ["A", "B", "C", "D"],
    timeLimitSec: 20,
    correct: [1],
    note: null,
    round: "Round one",
    basePoints: 1000,
  },
];

/**
 * A session built by the engine, then written straight to the store.
 *
 * Built by replaying real events rather than by assembling a state literal,
 * because the row this is standing in for was written by a running process. A
 * hand-made `TriviaState` would prove the guard catches a shape the engine
 * never produces, which is the easier and less interesting claim.
 *
 * `overrides` then does the damage, after the engine is done and before the
 * store sees it. `metaSid` exists only for #14 and `metaJoinCode` only for
 * #22, where META and SNAPSHOT have to be made to disagree about one field
 * while agreeing about everything else.
 */
async function storeSession(
  store: MemoryStore,
  sid: string,
  at: number,
  events: readonly Event[] = [],
  overrides: (s: Record<string, unknown>) => void = () => {},
  metaSid?: string,
  metaJoinCode?: string,
): Promise<SessionState> {
  const base = newSession({
    sid,
    title: sid,
    joinCode: `hvs.${sid}padpadpadpadpadpadpad`,
    activities: ACTIVITIES,
  });
  const played = replay(
    base,
    events.map((event) => ({ event, at })),
  );
  const mutable = structuredClone(played) as SessionState;
  overrides(mutable as unknown as Record<string, unknown>);
  const meta = metaFor(mutable, at);
  await store.putMeta({
    ...meta,
    ...(metaSid === undefined ? {} : { sid: metaSid }),
    ...(metaJoinCode === undefined ? {} : { joinCode: metaJoinCode }),
  });
  await store.putSnapshot(metaSid ?? mutable.sid, mutable, at);
  return mutable;
}

/** Everything up to a question that is open and counting down. */
function openQuestionEvents(): readonly Event[] {
  return [
    { type: "open" },
    { type: "join", pid: "p1", nickname: "Priya" },
    { type: "start" },
    { type: "setSegment", segment: "trivia" },
    { type: "loadTrivia", activityId: "trivia", questions: QUESTIONS },
    { type: "openQuestion", suddenDeath: false },
  ];
}

/**
 * The exact row from #16: a question left open across a restart, whose stored
 * state no longer carries the questions it is open on.
 *
 * `armQuestionTimer` sees `phase: "open"` with a `closesAt` in the past and
 * fires immediately, which is what it is supposed to do — the deadline passed
 * while the process was away, and the room should land on the reveal rather
 * than on a question that stopped counting down. `settleQuestion` then reads
 * `trivia.questions[trivia.at]` off `undefined`.
 *
 * `questions` is deleted rather than emptied, deliberately. An empty array is
 * the same shape with nothing in it, and `settleQuestion` already guards that
 * with `if (!question)`. The failure is a *missing field*, which is what a
 * migration that has not run yet, or a row written by an engine version that
 * did not have the field, actually leaves behind.
 */
function loseTheQuestions(closesAt: number) {
  return (s: Record<string, unknown>): void => {
    const trivia = s["trivia"] as Record<string, unknown>;
    trivia["closesAt"] = closesAt;
    delete trivia["questions"];
  };
}

describe("a timer callback cannot take the process down (#16)", () => {
  it("survives the row that used to crash-loop the service", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(
      store,
      "ses_poisoned",
      now,
      openQuestionEvents(),
      loseTheQuestions(now - 60_000),
    );

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const lines: string[] = [];
    const recovered = await recoverSessions(store, registry, (l) => lines.push(l), now);

    // Recovery itself succeeds — that is the whole difficulty. Nothing in the
    // recovery log calls this row a failure, because as far as recovery is
    // concerned it is not one.
    assert.equal(recovered.length, 1, "the row recovers cleanly");
    assert.ok(
      !lines.some((l) => l.includes("COULD NOT BE REBUILT")),
      "recovery does not consider this row a failure",
    );

    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      await tick();
    } finally {
      console.error = realError;
    }

    // Reaching this line at all is most of the test: before the guard, the
    // throw escaped into the event loop and the process exited 1.
    const runtime = registry.bySessionId("ses_poisoned");
    assert.ok(runtime, "the session is still in the registry");
    assert.ok(runtime.fault, "the fault was recorded");
    assert.equal(runtime.fault?.label, "question timer");
    assert.match(runtime.fault?.why ?? "", /undefined/);
    assert.equal(registry.stalledCount(), 1);

    assert.equal(errors.length, 1, "exactly one line, not one per retry");
    assert.match(errors[0] ?? "", /ses_poisoned/, "the line names the session");
    assert.match(errors[0] ?? "", /question/, "and which clock stopped");
  });

  it("does not re-arm, so one bad row is one log line and not a loop", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(
      store,
      "ses_once",
      now,
      openQuestionEvents(),
      loseTheQuestions(now - 1000),
    );

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      await recoverSessions(store, registry, () => {}, now);
      await tick();
      await tick();
      await tick();
    } finally {
      console.error = realError;
    }

    // The callback clears its own timer field before anything downstream can
    // throw, so a fault leaves nothing armed. If this ever counts up, the
    // crash loop has come back wearing a try/catch.
    assert.equal(errors.length, 1, `fired ${errors.length} times, expected once`);
    assert.equal(registry.bySessionId("ses_once")?.armedCloseAt, null);
  });

  it("stops one session's clock and leaves every other session running", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(
      store,
      "ses_bad",
      now,
      openQuestionEvents(),
      loseTheQuestions(now - 1000),
    );
    await storeSession(store, "ses_good", now, openQuestionEvents());

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const realError = console.error;
    console.error = () => {};
    try {
      await recoverSessions(store, registry, () => {}, now);
      await tick();
    } finally {
      console.error = realError;
    }

    assert.equal(registry.stalledCount(), 1, "one stalled, not both");
    assert.ok(registry.bySessionId("ses_bad")?.fault);
    assert.equal(registry.bySessionId("ses_good")?.fault, null);
    // The healthy session is still fully live, not merely present.
    assert.equal(registry.bySessionId("ses_good")?.state.phase, "running");
  });

  it("reports nothing stalled on a boot where nothing threw", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(store, "ses_fine", now, openQuestionEvents());
    const registry = new SessionRegistry(new Persister(store, () => {}));
    await recoverSessions(store, registry, () => {}, now);
    await tick();
    assert.equal(registry.stalledCount(), 0);
    assert.equal(registry.bySessionId("ses_fine")?.fault, null);
  });
});

describe("META and SNAPSHOT must agree which session this is (#14)", () => {
  it("skips the row whose two halves disagree, and names both sids", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    // META filed under one sid, the snapshot inside it claiming another. The
    // registry would have keyed the session by the snapshot's; every log line
    // would have called it META's.
    await storeSession(
      store,
      "ses_snapshot_says",
      now,
      openQuestionEvents(),
      () => {},
      "ses_meta_says",
    );

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const lines: string[] = [];
    const recovered = await recoverSessions(store, registry, (l) => lines.push(l), now);

    assert.equal(recovered.length, 0, "the row is not recovered");
    assert.equal(registry.bySessionId("ses_meta_says"), undefined);
    assert.equal(registry.bySessionId("ses_snapshot_says"), undefined);

    const failure = lines.find((l) => l.includes("COULD NOT BE REBUILT"));
    assert.ok(failure, "the skip is logged loudly");
    assert.match(failure, /ses_meta_says/, "names the sid the log would have used");
    assert.match(failure, /ses_snapshot_says/, "and the one the registry would have");
  });

  it("lets the rest of the boot come up around it", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(
      store,
      "ses_mismatch_snap",
      now,
      openQuestionEvents(),
      () => {},
      "ses_mismatch_meta",
    );
    await storeSession(store, "ses_healthy", now, openQuestionEvents());

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const lines: string[] = [];
    const recovered = await recoverSessions(store, registry, (l) => lines.push(l), now);

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.sid, "ses_healthy");
    assert.ok(registry.bySessionId("ses_healthy"));
    assert.ok(lines.some((l) => l.includes("1 session(s) failed to rebuild")));
  });

  it("names the sid the registry keyed, which is the one a lookup answers", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    const state = await storeSession(store, "ses_agreed", now, openQuestionEvents());

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const recovered = await recoverSessions(store, registry, () => {}, now);

    assert.equal(recovered[0]?.sid, state.sid);
    assert.ok(registry.bySessionId(recovered[0]?.sid ?? ""), "the reported sid resolves");
  });
});

describe("META and SNAPSHOT must agree which code opens the room (#22)", () => {
  it("skips the row whose two halves give different join codes, and names both", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    // Everything agrees except the one field. The sid matches, so the #14
    // guard above waves this through and the join code is the only thing left
    // to catch it — which is the whole point of the issue: #14's fix does not
    // cover this pair, it just looks as though it should.
    await storeSession(
      store,
      "ses_two_codes",
      now,
      openQuestionEvents(),
      () => {},
      undefined,
      "hvs.metasaysadifferentcodeentirely",
    );

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const lines: string[] = [];
    const recovered = await recoverSessions(store, registry, (l) => lines.push(l), now);

    assert.equal(recovered.length, 0, "the row is not recovered");
    const failure = lines.find((l) => l.includes("COULD NOT BE REBUILT"));
    assert.ok(failure, "the skip is logged loudly");
    assert.match(failure, /hvs\.metasaysadifferentcodeentirely/, "names META's code");
    assert.match(
      failure,
      /hvs\.ses_two_codespadpadpadpadpadpadpad/,
      "and the snapshot's, which is the one the registry would have keyed",
    );
  });

  it("leaves neither code resolving, and brings the rest of the boot up", async () => {
    // The failure mode is not that the session is missing. It is that the
    // session is *there* under a code nobody was given, so a phone with the
    // right link gets nothing while the room is live. Both codes have to miss.
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(
      store,
      "ses_wrong_code",
      now,
      openQuestionEvents(),
      () => {},
      undefined,
      "hvs.thecodeonthecardinthehostshand",
    );
    await storeSession(store, "ses_code_ok", now, openQuestionEvents());

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const lines: string[] = [];
    const recovered = await recoverSessions(store, registry, (l) => lines.push(l), now);

    assert.equal(
      registry.byJoinCode("hvs.thecodeonthecardinthehostshand"),
      undefined,
      "META's code must not resolve",
    );
    assert.equal(
      registry.byJoinCode("hvs.ses_wrong_codepadpadpadpadpadpadpad"),
      undefined,
      "and neither must the snapshot's — that is the room nobody can reach",
    );
    assert.equal(registry.bySessionId("ses_wrong_code"), undefined);

    assert.equal(recovered.length, 1, "the healthy session still comes up");
    assert.equal(recovered[0]?.sid, "ses_code_ok");
    assert.ok(lines.some((l) => l.includes("1 session(s) failed to rebuild")));
  });

  it("keys the registry by the agreed code when the two halves agree", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    const state = await storeSession(store, "ses_one_code", now, openQuestionEvents());

    const registry = new SessionRegistry(new Persister(store, () => {}));
    await recoverSessions(store, registry, () => {}, now);

    assert.equal(registry.byJoinCode(state.joinCode)?.state.sid, "ses_one_code");
  });
});

describe("both stores recover the same phases (#14, secondary)", () => {
  it("brings back every phase on the list", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    for (const phase of RECOVERABLE_PHASES) {
      await storeSession(store, `ses_${phase}`, now, openQuestionEvents(), (s) => {
        s["phase"] = phase;
      });
    }
    const loaded = await store.loadRecoverable();
    assert.deepEqual(
      loaded.map((l) => l.meta.phase).sort(),
      [...RECOVERABLE_PHASES].sort(),
    );
  });

  it("drops a phase that is not on it", async () => {
    // The fifth phase this file's comment is about. `SessionPhase` has only
    // four members today, so the cast is the only way to write the case the
    // constant exists to survive — and without it this test could not exist
    // until the bug it guards had already shipped.
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(store, "ses_archived", now, openQuestionEvents(), (s) => {
      s["phase"] = "archived" as SessionState["phase"];
    });
    await storeSession(store, "ses_running", now, openQuestionEvents(), (s) => {
      s["phase"] = "running";
    });

    const loaded = await store.loadRecoverable();
    assert.deepEqual(
      loaded.map((l) => l.meta.sid),
      ["ses_running"],
      "the memory store used to take any defined phase, which is how it and " +
        "the DynamoDB scan could disagree without a test noticing",
    );
  });

  it("is the list the DynamoDB scan names, because it is the same array", () => {
    // Not a tautology: the scan builds its FilterExpression and its value map
    // by mapping this constant, so the only way the two can differ now is if
    // somebody writes a literal back into one of them.
    assert.deepEqual([...RECOVERABLE_PHASES], ["draft", "lobby", "running", "closed"]);
  });
});

describe("every timer in the runtime is guarded, not just the tested one", () => {
  /**
   * A structural test, and the honest reason for it.
   *
   * Adversarial verification of the first version of this fix found that nine
   * of the ten timer sites could be silently un-wrapped with the whole suite
   * still green: only the trivia `question` timer is reached by a behavioural
   * test, because the other nine need a poisoned arcade round staged through
   * the reducer to fire. A future `setTimeout` added bare would have gone
   * unnoticed the same way.
   *
   * Counting call sites in the source is a blunt instrument and it is not
   * pretending otherwise — it cannot tell whether a wrapper is correct, only
   * whether one is there. That is the property that was actually missing, and
   * a test that reads the file is worth more than a comment asking people to
   * remember.
   */
  it("routes every setTimeout through #onTimer", () => {
    const src = readFileSync(
      new URL("./runtime.ts", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const timers = [...src.matchAll(/setTimeout\(/g)].length;
    // One more than the call sites: the definition itself.
    const guards = [...src.matchAll(/#onTimer\(/g)].length - 1;
    assert.equal(
      guards,
      timers,
      `runtime.ts has ${timers} setTimeout call site(s) but ${guards} guarded ` +
        `one(s). Every timer callback must go through #onTimer: a bare one ` +
        `throws into the event loop, which has no handler, and the process ` +
        `exits 1 — under ECS that is a restart that recovers the same row.`,
    );
  });

  it("names a fault after the clock it came from", async () => {
    // The label is what tells an operator which of ten clocks stopped, and it
    // is composed rather than passed whole, so it is worth one assertion.
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(
      store,
      "ses_labelled",
      now,
      openQuestionEvents(),
      loseTheQuestions(now - 1000),
    );
    const registry = new SessionRegistry(new Persister(store, () => {}));
    const realError = console.error;
    console.error = () => {};
    try {
      await recoverSessions(store, registry, () => {}, now);
      await tick();
    } finally {
      console.error = realError;
    }
    assert.equal(registry.bySessionId("ses_labelled")?.fault?.label, "question timer");
  });
});

describe("a faulted session is quarantined, not merely logged", () => {
  it("refuses to be read again once it has thrown", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(
      store,
      "ses_quarantine",
      now,
      openQuestionEvents(),
      loseTheQuestions(now - 1000),
    );
    const registry = new SessionRegistry(new Persister(store, () => {}));
    const realError = console.error;
    console.error = () => {};
    try {
      await recoverSessions(store, registry, () => {}, now);
      await tick();
    } finally {
      console.error = realError;
    }

    const runtime = registry.bySessionId("ses_quarantine");
    assert.ok(runtime);
    // `faulted` is what `handleHello` checks before it builds a projection.
    // Without it the guard around the socket listeners turns a crash loop into
    // a busy loop: the state still throws, every reconnect still hits it, and
    // a room of thirty phones retrying every ten seconds spends the task on
    // catching the same exception.
    assert.equal(runtime.faulted, true);
  });

  it("logs the first fault in full and stays quiet after that", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(
      store,
      "ses_noisy",
      now,
      openQuestionEvents(),
      loseTheQuestions(now - 1000),
    );
    const registry = new SessionRegistry(new Persister(store, () => {}));
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await recoverSessions(store, registry, () => {}, now);
      await tick();
      const runtime = registry.bySessionId("ses_noisy");
      assert.ok(runtime);
      // Every later reader hits the same throw. A line each would bury the
      // one line that said what happened.
      for (let i = 0; i < 20; i += 1) {
        runtime.recordFault("a socket frame", new Error("again"));
      }
    } finally {
      console.error = realError;
    }
    assert.equal(errors.length, 1, `logged ${errors.length} times, expected once`);
    assert.match(errors[0] ?? "", /ses_noisy/);
    assert.match(errors[0] ?? "", /quarantined/);
  });

  it("survives an error that cannot be turned into a string", () => {
    // `String(Object.create(null))` throws "Cannot convert object to primitive
    // value". A report that throws while reporting a throw is the original bug
    // wearing a different hat, and the catch is the one place that must not.
    const store = new MemoryStore();
    const registry = new SessionRegistry(new Persister(store, () => {}));
    const { runtime } = registry.add(
      newSession({
        sid: "ses_unstringable",
        title: "t",
        joinCode: "hvs.unstringablepadpadpadpad",
        activities: ACTIVITIES,
      }),
    );
    const realError = console.error;
    console.error = () => {};
    try {
      runtime.recordFault("a socket frame", Object.create(null) as unknown);
    } finally {
      console.error = realError;
    }
    assert.equal(runtime.faulted, true);
    assert.match(runtime.fault?.why ?? "", /could not be converted/);
  });
});

describe("restore leaves no session half-registered", () => {
  it("does not leave a row live in the registry that the log called skipped", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    // A recruitment round whose `play.items` is gone. `#armItemTimer` reads
    // `play.items.length` and throws *synchronously*, inside `registry.restore`
    // — before any timer is scheduled, and after the registry had already
    // keyed the session. The row was logged COULD NOT BE REBUILT and was
    // simultaneously reachable by its join code.
    await storeSession(store, "ses_halfway", now, openQuestionEvents(), (s) => {
      s["arcade"] = {
        phase: "running",
        roundIndex: 0,
        endsAt: now - 1000,
        standing: {},
        lounge: [],
        play: { kind: "recruitment", at: 0, itemEndsAt: now - 1000, answered: {} },
      };
    });

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const lines: string[] = [];
    const realError = console.error;
    console.error = () => {};
    let recovered: Awaited<ReturnType<typeof recoverSessions>>;
    try {
      recovered = await recoverSessions(store, registry, (l) => lines.push(l), now);
      await tick();
    } finally {
      console.error = realError;
    }

    const skipped = lines.some((l) => l.includes("COULD NOT BE REBUILT"));
    if (skipped) {
      // If the log says it was skipped, it must not be reachable. The two
      // claims disagreeing is the bug; either answer alone is fine.
      assert.equal(recovered.length, 0);
      assert.equal(
        registry.bySessionId("ses_halfway"),
        undefined,
        "logged as skipped but still in the registry by sid",
      );
      assert.equal(
        registry.byJoinCode("hvs.ses_halfwaypadpadpadpadpadpadpad"),
        undefined,
        "logged as skipped but its join code still resolves",
      );
    } else {
      // Or it recovered, in which case it is a normal session and the fault
      // machinery above covers whatever its clocks do next.
      assert.ok(registry.bySessionId("ses_halfway"));
    }
  });
});

describe("the socket entry points are guarded too", () => {
  /**
   * The finding that made the first version of this fix insufficient.
   *
   * Guarding the timers stopped the row killing the process on the boot tick.
   * The same row then killed it on the first phone that reconnected, because a
   * `ws` listener that throws is **fatal** — the emitter calls it synchronously
   * and does not catch, and with no `uncaughtException` handler the process
   * exits 1. Measured with this project's own `ws`, not assumed. Browsers
   * reconnect forever with a ten second cap, so that is the same crash loop
   * with a longer period, and `/healthz` reports `ok: true` in the window
   * before each death.
   *
   * Structural for the same reason the timer count is: these listeners need a
   * live socket and a poisoned room to exercise behaviourally, and the
   * property that was missing is simply whether the wrapper is there.
   */
  it("routes the message and close listeners through the guard", () => {
    const src = mainSrc();
    for (const event of ["message", "close"]) {
      const at = src.indexOf(`socket.on("${event}"`);
      assert.notEqual(at, -1, `no ${event} listener found in main.ts`);
      const head = src.slice(at, at + 200);
      assert.match(
        head,
        /guarded\(/,
        `socket.on("${event}") must route through guarded(): a ws listener ` +
          `that throws exits the process, and the phone that sent the frame ` +
          `is still reconnecting`,
      );
    }
  });

  it("keeps a last line under everything else", () => {
    // The named guards above catch what is known to reach a session's state.
    // This catches what is left, which by construction is unpredicted.
    const src = mainSrc();
    assert.match(src, /process\.on\("uncaughtException"/);
    assert.match(src, /process\.on\("unhandledRejection"/);
    // And it must not exit: exiting is the restart this exists to avoid.
    const at = src.indexOf('process.on("uncaughtException"');
    assert.doesNotMatch(
      src.slice(at, at + 600),
      /process\.exit/,
      "the uncaughtException handler must not exit — a single stateful task " +
        "that exits drops every session and ECS recovers the same rows",
    );
  });

  it("refuses a quarantined session before building a projection", () => {
    // Order matters: the check has to come before anything reads the state,
    // or the refusal throws on its way to being sent.
    const src = mainSrc();
    assert.match(src, /if \(runtime\.faulted\) return quarantined\(\);/);
    const joinAt = src.indexOf("registry.byJoinCode(msg.joinCode)");
    const applyAt = src.indexOf('type: "join",', joinAt);
    const guardAt = src.indexOf("if (runtime.faulted) return quarantined();", joinAt);
    assert.ok(applyAt > joinAt, "found the join");
    assert.ok(guardAt > joinAt && guardAt < applyAt, "guard sits between lookup and join");
    // Reclaiming a released name reads the roster, which is the state a
    // faulted session cannot be trusted to have; it comes after the guard too.
    const reclaimAt = src.indexOf("runtime.releasedPidFor(msg.nickname)", joinAt);
    assert.ok(reclaimAt > guardAt && reclaimAt < applyAt, "the reclaim lookup is behind the guard");
  });
});

describe("the two stores hand back the same shape (#22, secondary)", () => {
  /**
   * `assembleSession` is the DynamoDB store's reader, pure and exported so it
   * can be run at all: the suite has no DynamoDB and never will, so anything
   * in that file which is only a method is a behaviour nothing exercises until
   * production does. That is not a hypothetical — a `FilterExpression` naming
   * a key attribute shipped once and broke every read, and the suite was green
   * throughout because the suite runs on the memory store.
   */
  const metaItem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    PK: "SESSION#ses_pk",
    SK: "META",
    sid: "ses_pk",
    title: "A session",
    joinCode: "hvs.assemblepadpadpadpadpadpad",
    phase: "running",
    seal: "live",
    hostTokenHash: "h",
    screenTokenHash: "s",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  });

  it("names the session by the partition it was queried, not by the attribute", () => {
    // A META row with no `sid` attribute used to assemble as `sid: ""`, which
    // recovery could only log as "(a row with no sid)". The PK is the one fact
    // about these items that cannot be wrong: they came back from a Query on
    // it.
    const row = metaItem();
    delete row["sid"];
    const loaded = assembleSession("ses_pk", [row]);
    assert.equal(loaded?.meta.sid, "ses_pk");
  });

  it("refuses a META row filed under one sid that calls itself another", () => {
    // Recovered, this session would be keyed by the attribute while its rows
    // sit in the other partition — so every write this process made for it
    // would land somewhere the next boot's scan finds a second time. One
    // divergence, two live partitions. Refused for #14's reason: choosing
    // between two records that disagree about which session this is has no
    // basis.
    const loaded = assembleSession("ses_pk", [metaItem({ sid: "ses_somewhere_else" })]);
    assert.equal(loaded, null);
  });

  it("drops an event with no event object and a participant with no pid", () => {
    const loaded = assembleSession("ses_pk", [
      metaItem(),
      { PK: "SESSION#ses_pk", SK: "EVENT#0000000001", seq: 1, event: null, at: 1 },
      {
        PK: "SESSION#ses_pk",
        SK: "EVENT#0000000002",
        seq: 2,
        event: { type: "open" },
        at: 2,
      },
      { PK: "SESSION#ses_pk", SK: "PARTICIPANT#", pid: "", nickname: "nobody" },
      { PK: "SESSION#ses_pk", SK: "PARTICIPANT#p1", pid: "p1", nickname: "Priya" },
    ]);
    assert.deepEqual(loaded?.events.map((e) => e.seq), [2]);
    assert.deepEqual(loaded?.participants.map((x) => x.pid), ["p1"]);
  });

  it("drops the same two in the memory store, which is what the suite runs", async () => {
    // The point of this one is parity, not the filter. Recovery is hardened
    // against both shapes, but the two stores had different output contracts
    // for the same interface and every test in this repo ran against the
    // laxer of them — so recovery could have come to depend on being handed
    // something only the memory store produces.
    const store = new MemoryStore();
    const now = Date.now();
    await storeSession(store, "ses_parity", now, openQuestionEvents());
    await store.putParticipant("ses_parity", {
      pid: "",
      nickname: "nobody",
      nicknameKey: "nobody",
      playerNumber: 0,
      joinedAt: now,
      kicked: false,
      rejoinTokenHashes: [],
    });

    const loaded = await store.loadSession("ses_parity");
    assert.ok(loaded);
    assert.equal(
      loaded.participants.some((x) => x.pid === ""),
      false,
      "a participant with no pid must not reach recovery from either store",
    );
  });
});

describe("a finished session is retired by age, not held for ever (#23)", () => {
  /** Open, start, close. A session that is over, with nothing left armed. */
  const finished = (): readonly Event[] => [
    { type: "open" },
    { type: "start" },
    { type: "close" },
  ];

  it("leaves a long-closed session in the table and out of the registry", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    const closedLongAgo = now - REOPEN_WINDOW_MS - 60_000;
    await storeSession(store, "ses_last_month", closedLongAgo, finished());

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const lines: string[] = [];
    const recovered = await recoverSessions(store, registry, (l) => lines.push(l), now);

    assert.equal(recovered.length, 0, "not recovered");
    assert.equal(registry.bySessionId("ses_last_month"), undefined, "not held");
    assert.ok(
      lines.some((l) => l.includes("left in the table") && l.includes("ses_last_month")),
      "the boot log names it, because the first question is whether it was dropped",
    );
    // Left where it was. Nothing here deletes a row: the scores stay
    // exportable by sid because the export path reads the store, and the row's
    // own `ttl` is what finally clears it.
    const still = await store.loadSession("ses_last_month");
    assert.ok(still, "the row is untouched");
    assert.equal(still.meta.updatedAt, closedLongAgo);
  });

  it("still restores one closed minutes ago, so reopen keeps working", async () => {
    // This capability exists because an accidental close happened and the
    // deploy that followed put the session out of reach. Retiring by age must
    // not be that bug again with a calendar attached.
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(store, "ses_oops", now - 5 * 60_000, finished());

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const recovered = await recoverSessions(store, registry, () => {}, now);

    assert.equal(recovered.length, 1);
    const back = registry.bySessionId("ses_oops");
    assert.ok(back, "a close from five minutes ago very much needs reopening");
    assert.equal(back.state.phase, "closed");
    assert.equal(back.apply({ type: "reopen" }, now).applied, true);
    assert.equal(back.state.phase, "running");
  });

  it("does not re-stamp updatedAt on a row it recovers, so the ttl can run out", async () => {
    // The half of #23 that is not about the registry at all. `ttl` is derived
    // from `updatedAt`, recovery writes every recovered row straight back, and
    // `meta()` used to stamp whatever clock the caller was holding — so every
    // deploy pushed every row's expiry out another ninety days and nothing in
    // the table could ever become old enough to be deleted by anything.
    const now = Date.now();
    const store = new MemoryStore();
    const closedYesterday = now - 24 * 60 * 60 * 1000;
    await storeSession(store, "ses_yesterday", closedYesterday, finished());

    const persister = new Persister(store, () => {});
    const registry = new SessionRegistry(persister);
    await recoverSessions(store, registry, () => {}, now);
    await persister.drain();

    const after = await store.loadSession("ses_yesterday");
    assert.equal(
      after?.meta.updatedAt,
      closedYesterday,
      "a boot that changed nothing must not claim the session changed",
    );
    assert.equal(registry.bySessionId("ses_yesterday")?.updatedAt, closedYesterday);
  });

  it("moves updatedAt when the session actually changes, and only then", async () => {
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(store, "ses_moves", now - 60 * 60 * 1000, finished());

    const persister = new Persister(store, () => {});
    const registry = new SessionRegistry(persister);
    await recoverSessions(store, registry, () => {}, now);
    const back = registry.bySessionId("ses_moves");
    assert.ok(back);

    back.apply({ type: "reopen" }, now);
    await persister.drain();
    assert.equal(back.updatedAt, now);
    assert.equal((await store.loadSession("ses_moves"))?.meta.updatedAt, now);
  });

  it("does not carry a zero updatedAt back out, which would write a ttl in the past", async () => {
    // The trap in reporting the stored clock instead of the write clock. The
    // DynamoDB store derives `ttl` from `updatedAt`, so a row with no usable
    // timestamp — written before the field existed, or by hand — would be
    // written back with an expiry ninety days after the epoch, and DynamoDB
    // would delete the session recovery had just rescued.
    const now = Date.now();
    const store = new MemoryStore();
    await storeSession(store, "ses_no_clock", 0, finished());

    const persister = new Persister(store, () => {});
    const registry = new SessionRegistry(persister);
    await recoverSessions(store, registry, () => {}, now);
    await persister.drain();

    const back = registry.bySessionId("ses_no_clock");
    assert.ok(back, "a row with no clock is still recovered, not retired");
    assert.ok(back.updatedAt > 0, "and is not left claiming the epoch");
    assert.ok(((await store.loadSession("ses_no_clock"))?.meta.updatedAt ?? 0) > 0);
  });

  it("never retires a draft, a lobby or a running session, however old", () => {
    // A draft that has sat for a month is a session somebody staged and has
    // not opened yet, and its join code is live — dropping one is the bug the
    // `draft` entry in RECOVERABLE_PHASES exists to record.
    const now = Date.now();
    const ancient = now - REOPEN_WINDOW_MS * 10;
    for (const phase of RECOVERABLE_PHASES) {
      assert.equal(
        retiredByAge(phase, ancient, now),
        phase === "closed",
        `${phase} should ${phase === "closed" ? "" : "never "}retire by age`,
      );
    }
  });

  it("treats a row with no usable updatedAt as not retired", () => {
    // Dropping a session because its clock is missing is a guess in the
    // direction that loses things.
    const now = Date.now();
    assert.equal(retiredByAge("closed", 0, now), false);
    assert.equal(retiredByAge("closed", Number.NaN, now), false);
    assert.equal(retiredByAge("closed", now - REOPEN_WINDOW_MS + 1000, now), false);
    assert.equal(retiredByAge("closed", now - REOPEN_WINDOW_MS - 1000, now), true);
  });

  it("guards the SIGTERM write with the same predicate the boot uses", () => {
    /**
     * Structural, for the reason the timer count is: `main.ts` listens on a
     * port and runs recovery at the top level, so `shutdown` cannot be
     * imported and called. The property that was missing is only whether the
     * guard is there — and it has to be there, because a rule applied at the
     * boot end alone leaves the dying task writing back every closed session
     * it is holding, which is the measured behaviour the issue opens with.
     */
    const src = mainSrc();
    const at = src.indexOf("async function shutdown(");
    assert.notEqual(at, -1, "no shutdown() found in main.ts");
    const body = src.slice(at, at + 2000);
    const guard = body.indexOf("retiredByAge(");
    const write = body.indexOf("r.persistence.snapshot(");
    assert.notEqual(write, -1, "shutdown no longer writes a snapshot at all");
    assert.ok(
      guard !== -1 && guard < write,
      "shutdown() must test retiredByAge before writing a session back: " +
        "without it every deploy re-creates the rows the last purge deleted, " +
        "at the SIGTERM timestamp, and the next boot recovers them again",
    );
  });
});
