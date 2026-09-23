/**
 * The arcade running order.
 *
 * This list decides what the primary button says next during the one segment
 * where the console used to stop and ask. It is worth tests: everything else
 * new on the console is a widget, and this is a rule.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  ARCADE_PLAYABLE,
  defaultPlan,
  isLastIncluded,
  movePlan,
  nextRound,
  parseSetup,
  planIncluded,
  planSummary,
  togglePlan,
  type ArcadePick,
} from "./plan.ts";

const LABEL: Readonly<Record<ArcadePick, string>> = {
  recruitment: "Recruitment",
  plan_apply: "Plan / Apply",
  glass_bridge: "The Glass Bridge",
};

describe("the arcade running order", () => {
  it("starts with all three built rounds, in SPEC order", () => {
    assert.deepEqual(planIncluded(defaultPlan()), [...ARCADE_PLAYABLE]);
  });

  it("moves a round one place at a time", () => {
    const moved = movePlan(defaultPlan(), "glass_bridge", -1);
    assert.deepEqual(planIncluded(moved), [
      "recruitment",
      "glass_bridge",
      "plan_apply",
    ]);
  });

  it("does not wrap off either end", () => {
    const plan = defaultPlan();
    assert.deepEqual(movePlan(plan, "recruitment", -1), plan);
    assert.deepEqual(movePlan(plan, "glass_bridge", 1), plan);
  });

  it("takes a round out of the order and puts it back", () => {
    const without = togglePlan(defaultPlan(), "plan_apply");
    assert.deepEqual(planIncluded(without), ["recruitment", "glass_bridge"]);
    assert.deepEqual(planIncluded(togglePlan(without, "plan_apply")), [
      "recruitment",
      "plan_apply",
      "glass_bridge",
    ]);
  });

  it("refuses to empty the order — the button would have nothing to name", () => {
    let plan = togglePlan(defaultPlan(), "plan_apply");
    plan = togglePlan(plan, "glass_bridge");
    assert.deepEqual(planIncluded(plan), ["recruitment"]);
    assert.equal(isLastIncluded(plan, "recruitment"), true);
    assert.deepEqual(togglePlan(plan, "recruitment"), plan);
  });

  it("offers the first round that is in and not yet played", () => {
    const plan = defaultPlan();
    assert.equal(nextRound(plan, new Set()), "recruitment");
    assert.equal(nextRound(plan, new Set(["recruitment"])), "plan_apply");
    assert.equal(
      nextRound(plan, new Set(["recruitment", "plan_apply"])),
      "glass_bridge",
    );
  });

  it("skips a round the host took out", () => {
    const plan = togglePlan(defaultPlan(), "plan_apply");
    assert.equal(nextRound(plan, new Set(["recruitment"])), "glass_bridge");
  });

  it("runs out, so the console can offer the standings instead", () => {
    const played = new Set<ArcadePick>(ARCADE_PLAYABLE);
    assert.equal(nextRound(defaultPlan(), played), null);
  });

  it("says the order in words for the checklist", () => {
    assert.equal(
      planSummary(defaultPlan(), LABEL),
      "Recruitment, Plan / Apply, then The Glass Bridge",
    );
    assert.equal(
      planSummary(togglePlan(togglePlan(defaultPlan(), "plan_apply"), "glass_bridge"), LABEL),
      "Recruitment",
    );
  });
});

describe("the order, across a refresh", () => {
  it("round-trips what was stored", () => {
    const plan = movePlan(togglePlan(defaultPlan(), "plan_apply"), "glass_bridge", -1);
    const stored = JSON.stringify({ plan, timings: { seconds: 25 } });
    const back = parseSetup(stored);
    assert.notEqual(back, null);
    assert.deepEqual(back?.plan, plan);
    assert.equal(back?.timings["seconds"], 25);
  });

  it("is null for nothing stored, and for junk", () => {
    assert.equal(parseSetup(null), null);
    assert.equal(parseSetup(""), null);
    assert.equal(parseSetup("{not json"), null);
    assert.equal(parseSetup("[]"), null);
  });

  it("appends a round the stored order has never heard of", () => {
    const back = parseSetup(
      JSON.stringify({ plan: [{ kind: "plan_apply", included: true }] }),
    );
    assert.deepEqual(
      back?.plan.map((e) => e.kind),
      ["plan_apply", "recruitment", "glass_bridge"],
    );
  });

  it("drops a round that no longer exists, and a duplicate", () => {
    const back = parseSetup(
      JSON.stringify({
        plan: [
          { kind: "gganbu", included: true },
          { kind: "recruitment", included: false },
          { kind: "recruitment", included: true },
        ],
      }),
    );
    assert.deepEqual(
      back?.plan.map((e) => e.kind),
      ["recruitment", "plan_apply", "glass_bridge"],
    );
    assert.equal(back?.plan[0]?.included, false);
  });

  it("never comes back with an empty order", () => {
    const back = parseSetup(
      JSON.stringify({
        plan: ARCADE_PLAYABLE.map((kind) => ({ kind, included: false })),
      }),
    );
    assert.equal(planIncluded(back?.plan ?? []).length, 3);
  });

  it("ignores a timing that is not a positive number", () => {
    const back = parseSetup(
      JSON.stringify({ plan: [], timings: { a: -1, b: "20", c: 0, d: 12 } }),
    );
    assert.deepEqual(back?.timings, { d: 12 });
  });
});
