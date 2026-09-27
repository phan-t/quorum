/**
 * The guard on the instrument.
 *
 * Two halves, because this has two ways to be wrong. The unit tests fix what
 * the verdict *says* for a given stream of events — that is the part a person
 * reads under a red build, and getting the wording or the arithmetic wrong
 * makes it worse than nothing. The spawned run at the bottom fixes that node
 * still *emits* those events, which is the part no fixture can assert and the
 * part a node upgrade can quietly take away.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  newTally,
  observe,
  verdict,
  type ReporterEvent,
  type SummaryCounts,
} from "./honest-summary.ts";

const COUNTS: SummaryCounts = { tests: 0, passed: 0, failed: 0, cancelled: 0, suites: 0 };

function summary(over: Partial<SummaryCounts>): ReporterEvent {
  return { type: "test:summary", data: { counts: { ...COUNTS, ...over } } };
}

function failed(
  name: string,
  type: "suite" | "test",
  failureType: string,
  message = `${name} blew up`,
): ReporterEvent {
  return {
    type: "test:fail",
    data: { name, file: `${process.cwd()}/src/example.test.ts`, details: { type, error: { message, failureType } } },
  };
}

/** Fold a run's worth of events and read back what it would print. */
function report(events: readonly ReporterEvent[]): string {
  const tally = newTally();
  for (const event of events) observe(tally, event);
  return verdict(tally);
}

describe("the verdict line", () => {
  test("a clean run says PASS and says what it counted", () => {
    const out = report([summary({ tests: 1597, passed: 1597, suites: 293 })]);
    assert.match(out, /^ℹ verdict PASS — 1597 tests, 293 suites, nothing uncounted$/m);
    assert.doesNotMatch(out, /✖/);
  });

  test("ordinary failures say FAIL, and their ancestor suites are not dead suites", () => {
    // node emits `test:fail` for the test *and* for every suite above it. All
    // three are one failure; a verdict that counted the suites would announce
    // two vanished suites on every ordinary red build, and a warning that
    // fires on every red build is read as noise.
    const out = report([
      failed("fails honestly", "test", "testCodeFailure"),
      failed("inner", "suite", "subtestsFailed", "1 subtest failed"),
      failed("outer", "suite", "subtestsFailed", "1 subtest failed"),
      summary({ tests: 12, passed: 11, failed: 1, suites: 4 }),
    ]);
    assert.match(out, /^ℹ verdict FAIL — 1 of 12 tests failed$/m);
    assert.doesNotMatch(out, /never registered/);
  });

  test("a suite that threw in its body is named, located and explained", () => {
    // The issue #15 shape exactly: node's own totals say nothing failed.
    const out = report([
      failed("thirty bots play the frozen acceptance set", "suite", "testCodeFailure", "Q1 time limit\n\n19 !== 20\n"),
      summary({ tests: 7, passed: 7, failed: 0, suites: 3 }),
    ]);
    assert.match(out, /^ℹ verdict FAIL — 1 suite never registered its tests$/m);
    assert.match(out, /1 suite threw outside of a test/);
    assert.match(out, /src\/example\.test\.ts › thirty bots play the frozen acceptance set/);
    // The first line of the throw, and only the first: the spec reporter has
    // already printed the diff and the stack above this.
    assert.match(out, /^ {6}Q1 time limit$/m);
    assert.doesNotMatch(out, /19 !== 20/);
  });

  test("a failed hook counts too, because cancelled tests also leave fail at 0", () => {
    const out = report([
      failed("registered, then cancelled", "test", "cancelledByParent", "test did not finish"),
      failed("a suite whose before hook throws", "suite", "hookFailed", "failed running before hook"),
      summary({ tests: 3, passed: 2, failed: 0, cancelled: 1, suites: 2 }),
    ]);
    assert.match(out, /1 test never ran/);
    assert.match(out, /1 suite never registered its tests/);
    assert.doesNotMatch(out, /PASS/);
  });

  test("several dead suites are all named, and the prose is not written for one", () => {
    const out = report([
      failed("first", "suite", "testCodeFailure"),
      failed("second", "suite", "hookFailed"),
      summary({ tests: 4, passed: 4, suites: 5 }),
    ]);
    assert.match(out, /2 suites threw outside of a test, so the tests inside them were never registered/);
    assert.match(out, /› first$/m);
    assert.match(out, /› second$/m);
    assert.match(out, /2 suites never registered their tests/);
  });

  test("no summary at all is a failure, not a pass", () => {
    // A runner killed part-way emits no run-wide summary. Defaulting that to
    // PASS would be the same bug this file exists to close, one level up.
    assert.match(report([]), /^ℹ verdict FAIL — the run never reached a summary/m);
  });
});

describe("the reporter against a real node run", () => {
  test("it catches what node's own summary reports as fail 0", () => {
    // `dead-suite.fixture.ts` fails in three ways on purpose. node's summary
    // for it says `fail 1` — only the ordinary failing test — while three
    // tests have silently gone missing or been cancelled.
    const reporter = fileURLToPath(new URL("./honest-summary.ts", import.meta.url));
    const fixture = fileURLToPath(new URL("./dead-suite.fixture.ts", import.meta.url));
    let out: string;
    try {
      out = execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          "--test",
          "--test-reporter",
          reporter,
          "--test-reporter-destination",
          "stdout",
          fixture,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          // `NODE_TEST_CONTEXT` is set by the test runner that is running
          // *this* test, and a child that sees it reports itself back to its
          // parent over v8 serialisation instead of writing anything a person
          // or this assertion could read. Handing the child a clean
          // environment is the whole reason this test works.
          env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        },
      );
    } catch (err) {
      // A fixture that fails on purpose makes the child exit 1, which is what
      // `execFileSync` throws on. Its stdout is what we came for.
      out = String((err as { stdout?: string }).stdout ?? "");
    }

    assert.match(out, /^ℹ verdict FAIL/m, out);
    assert.match(out, /a suite that throws while collecting/, out);
    assert.match(out, /thrown from the describe body/, out);
    assert.match(out, /a suite whose before hook throws/, out);
    assert.match(out, /2 suites never registered their tests/, out);
    // The control: the ordinary failure's two ancestor suites are still not
    // counted as dead. If node ever stops marking them `subtestsFailed`, this
    // is the line that goes red rather than the verdict going quietly wrong.
    assert.doesNotMatch(out, /ordinary failure/, out);
    assert.doesNotMatch(out, /two ancestors to miscount/, out);
  });
});
