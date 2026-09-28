/**
 * What each surface does when the server's frames changed shape under it.
 *
 * Three decisions live in `protocol-guard.ts` and none of them can be checked
 * by looking at a page:
 *
 * 1. **the split** — the phone reloads, the console and the Desktop do not;
 * 2. **the loop guard** — a client that reloads into the same mismatch stops;
 * 3. **halt** — a surface that is reloading does not first render the frame.
 *
 * The reload is injected for exactly this reason. `location.reload()` called
 * inline would have made (1) and (2) unassertable — the process a reload
 * restarts is the one running the assertion — and "the participant reloads" is
 * the decision the whole issue turns on. Here it is a function this file hands
 * in and then counts.
 *
 * Storage is injected the same way. `localStorage` is a browser global and
 * this repository has no DOM in its tests; more to the point, the loop guard
 * is a *rule* about a count and not a fact about `localStorage`, and the rule
 * is what is worth pinning. The one thing that is genuinely about the browser
 * — that the accessor itself throws rather than returning nothing — is
 * asserted against the *real* store, which under `node` is reaching for a
 * global that does not exist. See {@link unavailableStore}.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  browserStore,
  checkProtocol,
  reloadsFor,
  RELOAD_LIMIT,
  staleVerdict,
  type ProtocolAction,
  type ReloadStore,
  type Reloads,
  type StaleSurface,
} from "./protocol-guard.ts";
import { PROTOCOL_VERSION } from "../../protocol.ts";

/** A store in a variable, so a scenario can read back what was written. */
function memoryStore(initial: Reloads | null = null): ReloadStore & {
  now(): Reloads | null;
} {
  let held = initial;
  return {
    read: () => held,
    write: (v) => {
      held = v;
    },
    now: () => held,
  };
}

/**
 * The real `localStorage`-backed store, running where `localStorage` is not a
 * thing that exists.
 *
 * This is not a stand-in for a private window; it is the *same failure*. Under
 * `node --experimental-strip-types` there is no `localStorage` global at all,
 * so every access throws `ReferenceError` before any value comes back — which
 * is precisely the shape `theme.ts` learned to expect from a private window,
 * and the reason both files wrap the access rather than the parse. Using the
 * real store here means the defensiveness is what is being asserted, not a
 * test double's imitation of it.
 */
const unavailableStore: ReloadStore = browserStore;

interface Run {
  readonly action: ProtocolAction;
  /** How many times the surface asked to be reloaded. */
  readonly reloads: number;
  /** Every call to `show`, with whether a reload control came with it. */
  readonly shown: readonly boolean[];
  readonly cleared: number;
  readonly store: Reloads | null;
}

/**
 * Run one welcome against one surface.
 *
 * `press` fires the retry that the last `show` handed over, which is the
 * facilitator pressing Reload on the console's banner — the only way the
 * console's count ever moves, since the console never reloads by itself.
 */
function run(
  surface: StaleSurface["surface"],
  theirs: number,
  opts: { ours?: number; store?: ReloadStore; press?: number } = {},
): Run {
  const store = opts.store ?? memoryStore();
  let reloads = 0;
  const shown: boolean[] = [];
  let cleared = 0;
  // An array rather than a `let`: the compiler cannot see a write that happens
  // inside a callback, so a nullable variable assigned there stays narrowed to
  // `null` and calling it does not typecheck.
  const offered: (() => void)[] = [];

  const action = checkProtocol(
    {
      surface,
      ours: opts.ours ?? 2,
      store,
      reload: () => {
        reloads += 1;
      },
      show: (retry) => {
        shown.push(retry !== null);
        if (retry !== null) offered.push(retry);
      },
      clear: () => {
        cleared += 1;
      },
    },
    theirs,
  );

  for (let i = 0; i < (opts.press ?? 0); i++) {
    const retry = offered[offered.length - 1];
    if (retry === undefined) {
      throw new Error("nothing to press: `show` offered no retry");
    }
    retry();
  }

  return {
    action,
    reloads,
    shown,
    cleared,
    store: "now" in store ? (store as { now(): Reloads | null }).now() : null,
  };
}

/* ------------------------------------------------------------------ */

describe("the three surfaces answer a mismatch differently, on purpose", () => {
  test("a phone reloads itself and does not render the frame", () => {
    const r = run("participant", 3, { ours: 2 });
    assert.equal(r.reloads, 1, "the phone must ask to be reloaded");
    assert.deepEqual(r.shown, [], "and must not stop to explain first");
    assert.equal(r.action, "halt", "the frame must not be rendered on the way out");
  });

  test("the console does not reload itself — it offers", () => {
    const r = run("host", 3, { ours: 2 });
    assert.equal(r.reloads, 0, "a console must never reload under the host");
    assert.deepEqual(r.shown, [true], "a visible state, with a control on it");
    assert.equal(r.action, "continue", "and it keeps driving the session");
  });

  test("the console's control is what reloads it, when the host presses it", () => {
    const r = run("host", 3, { ours: 2, press: 1 });
    assert.equal(r.reloads, 1);
  });

  test("the Desktop does not reload itself and is not given a control", () => {
    const r = run("screen", 3, { ours: 2 });
    assert.equal(r.reloads, 0, "never in front of a room");
    assert.deepEqual(
      r.shown,
      [false],
      "visible, but with nothing to press: nobody is at that machine",
    );
    assert.equal(r.action, "continue");
  });

  test("nothing happens at all when the versions agree", () => {
    for (const surface of ["participant", "host", "screen"] as const) {
      const r = run(surface, 2, { ours: 2 });
      assert.equal(r.reloads, 0, surface);
      assert.deepEqual(r.shown, [], surface);
      assert.equal(r.cleared, 1, `${surface}: an earlier notice must come off`);
      assert.equal(r.action, "continue", surface);
    }
  });

  test("the verdict is the version comparison and not the direction of it", () => {
    // A client *newer* than the server is the shape a rollback takes, and it
    // is the same problem read the other way round.
    assert.equal(staleVerdict("participant", 3, 2, 0), "reload");
    assert.equal(staleVerdict("host", 3, 2, 0), "offer");
    assert.equal(staleVerdict("screen", 3, 2, 0), "tell");
    assert.equal(staleVerdict("participant", 2, 2, 0), "ok");
  });
});

describe("the loop guard, because a client that reloads into the same mismatch would do it for ever", () => {
  test("the count is written before the reload, not after", () => {
    // After does not exist: the page that would do the incrementing is the
    // page being replaced.
    const store = memoryStore();
    run("participant", 3, { ours: 2, store });
    assert.deepEqual(store.now(), { theirs: 3, n: 1 });
  });

  test("a phone stops reloading once it has spent its reloads", () => {
    const store = memoryStore({ theirs: 3, n: RELOAD_LIMIT });
    const r = run("participant", 3, { ours: 2, store });
    assert.equal(r.reloads, 0, "the loop has to stop somewhere");
    assert.deepEqual(r.shown, [false], "and say so rather than go quiet");
    assert.equal(r.action, "continue", "a phone that cannot reload still plays");
    assert.deepEqual(store.now(), { theirs: 3, n: RELOAD_LIMIT }, "and stops counting");
  });

  test("a phone reloads up to the limit and then stops", () => {
    const store = memoryStore();
    const asked: number[] = [];
    for (let i = 0; i < RELOAD_LIMIT + 3; i++) {
      asked.push(run("participant", 3, { ours: 2, store }).reloads);
    }
    assert.equal(
      asked.reduce((a, b) => a + b, 0),
      RELOAD_LIMIT,
      "exactly RELOAD_LIMIT reloads, however many welcomes arrive",
    );
  });

  test("a console the host reloads twice into the same mismatch stops offering", () => {
    const store = memoryStore();
    const first = run("host", 3, { ours: 2, store, press: 1 });
    assert.deepEqual(first.shown, [true]);
    const second = run("host", 3, { ours: 2, store, press: 1 });
    assert.deepEqual(second.shown, [true], "the second press is still allowed");
    const third = run("host", 3, { ours: 2, store });
    assert.deepEqual(
      third.shown,
      [false],
      "a button that has twice failed to help should stop implying it can",
    );
  });

  test("the count is keyed on the server's version, so a new mismatch starts fresh", () => {
    // Otherwise a surface that gave up on 2 → 3 would still be giving up when
    // the server reached 4, for a reason nobody could see.
    const store = memoryStore({ theirs: 3, n: RELOAD_LIMIT });
    assert.equal(run("participant", 4, { ours: 2, store }).reloads, 1);
  });

  test("a matching welcome forgets the count, so a later deploy is not pre-judged", () => {
    const store = memoryStore({ theirs: 3, n: RELOAD_LIMIT });
    run("participant", 2, { ours: 2, store });
    assert.equal(store.now(), null);
  });

  test("a hand-edited count is read as none spent rather than as a licence to loop", () => {
    assert.equal(reloadsFor(null, 3), 0);
    assert.equal(reloadsFor({ theirs: 3, n: 1 }, 3), 1);
    assert.equal(reloadsFor({ theirs: 2, n: 1 }, 3), 0);
    assert.equal(reloadsFor({ theirs: 3, n: -5 }, 3), 0);
    assert.equal(reloadsFor({ theirs: 3, n: 1.5 }, 3), 0);
    assert.equal(reloadsFor({ theirs: 3, n: Number.NaN }, 3), 0);
  });
});

describe("storage that is not there at all, which is what a private window amounts to", () => {
  test("the phone still reloads", () => {
    // The failure that matters: the reload is the move that usually works, so
    // a page that cannot count must not therefore refuse to make it.
    const r = run("participant", 3, { ours: 2, store: unavailableStore });
    assert.equal(r.reloads, 1);
    assert.equal(r.action, "halt");
  });

  test("the console still gets its banner and its control", () => {
    const r = run("host", 3, { ours: 2, store: unavailableStore, press: 1 });
    assert.deepEqual(r.shown, [true]);
    assert.equal(r.reloads, 1, "pressing it must not throw out of the handler");
  });

  test("the Desktop still says it needs reloading", () => {
    assert.deepEqual(run("screen", 3, { ours: 2, store: unavailableStore }).shown, [
      false,
    ]);
  });

  test("a matching welcome does not throw on the way to clearing nothing", () => {
    const r = run("host", 2, { ours: 2, store: unavailableStore });
    assert.equal(r.cleared, 1);
    assert.equal(r.action, "continue");
  });
});

describe("the compiled-in version", () => {
  test("is what checkProtocol uses when the caller does not say", () => {
    // The surfaces pass `ours` through from net.ts, which reads it from
    // protocol.ts. The default is what keeps the two in step for any caller
    // that does not.
    let reloads = 0;
    checkProtocol(
      {
        surface: "participant",
        store: memoryStore(),
        reload: () => {
          reloads += 1;
        },
        show: () => {},
      },
      PROTOCOL_VERSION + 1,
    );
    assert.equal(reloads, 1);

    checkProtocol(
      {
        surface: "participant",
        store: memoryStore(),
        reload: () => {
          reloads += 1;
        },
        show: () => {},
      },
      PROTOCOL_VERSION,
    );
    assert.equal(reloads, 1, "the server's own version is not a mismatch");
  });

  test("moves when a frame's shape narrows, and #32 narrowed one", () => {
    // Not a value test. `PROTOCOL_VERSION` was 1 from the first commit through
    // every change including #32, which took `bench` and `spot` off
    // `StandingRow` and left the old `stackedBar` reading `row.bench`. A
    // constant nothing ever moves is decoration, and this is the assertion
    // that says it has moved at least once — the rule beside it in protocol.ts
    // says when it moves next.
    assert.ok(
      PROTOCOL_VERSION > 1,
      "PROTOCOL_VERSION must be past its first-commit value",
    );
    assert.ok(Number.isInteger(PROTOCOL_VERSION));
  });
});
