/**
 * The two join limits.
 *
 * One number could not tell a room from an attacker. The old limit — ten
 * hellos a minute per IP, checked before the code was read — counted a person
 * holding a valid code and a script holding none identically, so a team behind
 * one office NAT refused its own eleventh member. These pin the behaviour that
 * replaced it: generous on attempts, tight on failures, and the two counted
 * separately.
 *
 * The clock is passed in rather than read, so a window can be crossed without
 * a test that sleeps for a minute.
 */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  count,
  HELLO_FAIL_LIMIT,
  HELLO_FLOOD_LIMIT,
  HELLO_WINDOW_MS,
  note,
  rateLimited,
  resetLimits,
} from "./limits.ts";

/** What the hello path does, in the order main.ts does it. */
function hello(ip: string, valid: boolean, now: number): "ok" | "rate_limited" | "refused" {
  if (rateLimited(`hello:${ip}`, HELLO_FLOOD_LIMIT, HELLO_WINDOW_MS, now)) return "rate_limited";
  if (count(`helloFail:${ip}`, HELLO_WINDOW_MS, now) >= HELLO_FAIL_LIMIT) return "rate_limited";
  if (!valid) {
    note(`helloFail:${ip}`, HELLO_WINDOW_MS, now);
    return "refused";
  }
  return "ok";
}

describe("the join limits", () => {
  beforeEach(() => resetLimits());

  it("lets a room of a hundred join from one address", () => {
    // The case that was broken: one office, one public IP, everyone scanning
    // the code at once. Under the old limit the eleventh person was refused.
    const t = 1_000;
    const outcomes = Array.from({ length: 100 }, () => hello("office", true, t));
    assert.equal(outcomes.filter((o) => o === "ok").length, 100);
  });

  it("still stops a flood", () => {
    const t = 1_000;
    for (let i = 0; i < HELLO_FLOOD_LIMIT; i += 1) hello("flood", true, t);
    assert.equal(hello("flood", true, t), "rate_limited");
  });

  it("locks out a script with no valid code after a handful of tries", () => {
    const t = 1_000;
    for (let i = 0; i < HELLO_FAIL_LIMIT; i += 1) {
      assert.equal(hello("attacker", false, t), "refused", `try ${i + 1} should be a plain refusal`);
    }
    assert.equal(hello("attacker", false, t), "rate_limited", "the sixth try should be limited");
    // And it stays shut even if it suddenly produces a valid code.
    assert.equal(hello("attacker", true, t), "rate_limited");
  });

  it("does not charge a valid join for the failures of others on its address", () => {
    // Somebody mistypes the code four times; their colleague with the right
    // link still gets in. Under a single counter those share one budget.
    const t = 1_000;
    for (let i = 0; i < HELLO_FAIL_LIMIT - 1; i += 1) hello("shared", false, t);
    assert.equal(hello("shared", true, t), "ok");
    // A successful join must not push the failure counter along either.
    assert.equal(count("helloFail:shared", HELLO_WINDOW_MS, t), HELLO_FAIL_LIMIT - 1);
  });

  it("forgives once the window has passed", () => {
    const t = 1_000;
    for (let i = 0; i < HELLO_FAIL_LIMIT; i += 1) hello("typo", false, t);
    assert.equal(hello("typo", true, t), "rate_limited");
    assert.equal(hello("typo", true, t + HELLO_WINDOW_MS + 1), "ok", "a minute later they are in");
  });

  it("counts each address separately", () => {
    const t = 1_000;
    for (let i = 0; i < HELLO_FAIL_LIMIT; i += 1) hello("noisy", false, t);
    assert.equal(hello("noisy", true, t), "rate_limited");
    assert.equal(hello("quiet", true, t), "ok", "one bad address must not shut out another");
  });

  it("is tighter on failures than the limit it replaced", () => {
    assert.ok(HELLO_FAIL_LIMIT < 10, "a script gets fewer tries than it used to");
    assert.ok(HELLO_FAIL_LIMIT >= 3, "a typo or two should not lock somebody out");
    assert.ok(HELLO_FLOOD_LIMIT > HELLO_FAIL_LIMIT * 10, "the two buckets must stay far apart");
  });
});
