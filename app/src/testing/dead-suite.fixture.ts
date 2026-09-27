/**
 * A test file that fails in the three ways that matter, run on purpose.
 *
 * Not named `*.test.ts`, so `npm test` does not collect it. It exists to be
 * spawned by `honest-summary.test.ts` as a child `node --test` run, because the
 * one thing a hand-written event fixture cannot prove is that node still emits
 * the events {@link honestSummary} keys off. That is the part of this guard
 * most likely to rot: `failureType` is not API anybody promised, and a node
 * upgrade that renamed `"subtestsFailed"` would turn the verdict line into a
 * confident lie about every ordinary failure.
 *
 * The three shapes, and what each is here to pin:
 *
 *   - **A suite that throws in its `describe` body.** The bug in issue #15.
 *     Its two tests are never registered; node reports `fail 0`.
 *   - **A suite whose `before` hook throws.** The near-miss: its tests *are*
 *     registered, then cancelled, and node still reports `fail 0`. This is why
 *     moving describe-body work into a hook is not on its own a fix.
 *   - **An ordinary failing test.** The control. Its ancestor suites also emit
 *     `test:fail`, and the verdict must not count them as dead suites — if it
 *     did, every red build would claim suites had vanished and the signal
 *     would be worth nothing.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

describe("a suite that throws while collecting", () => {
  // `assert.equal` rather than `assert.fail`, whose `never` return type would
  // make the two `test()` calls below unreachable to a reader and to tsc. The
  // point of the fixture is that they are reached — and dropped anyway.
  assert.equal(1, 2, "thrown from the describe body");
  test("never registered", () => assert.ok(true));
  test("also never registered", () => assert.ok(true));
});

describe("a suite whose before hook throws", () => {
  before(() => assert.fail("thrown from the before hook"));
  test("registered, then cancelled", () => assert.ok(true));
});

describe("a suite with an ordinary failure", () => {
  describe("nested, so there are two ancestors to miscount", () => {
    test("fails honestly", () => assert.equal(1, 2));
    test("passes", () => assert.ok(true));
  });
});
