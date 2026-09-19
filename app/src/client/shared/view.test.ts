/**
 * The pure parts of the scoring surfaces: the hue an activity gets, the cells
 * of the points strip, and the segments of the stacked bar.
 *
 * Everything here is arithmetic and lookup — no DOM. The rendering itself is
 * checked by eye against the mock; these are the three things that would go
 * wrong quietly, in front of the room, and never look broken.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  activityHue,
  activityLabel,
  pointsStripCells,
  pointsStripText,
  stackedBar,
} from "./view.ts";
import type { ActivitySummary } from "../../protocol.ts";

const ACTIVITIES: readonly ActivitySummary[] = [
  { id: "ttx", title: "Agentic Security TTX", kind: "manual", spotCap: 2, spotsLeft: 2 },
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2, spotsLeft: 1 },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2, spotsLeft: 2 },
];

describe("activityHue", () => {
  it("gives each known activity its fixed accent", () => {
    assert.equal(activityHue(ACTIVITIES[0]!, 0), "var(--ttx)");
    assert.equal(activityHue(ACTIVITIES[1]!, 1), "var(--trivia)");
    assert.equal(activityHue(ACTIVITIES[2]!, 2), "var(--arcade)");
  });

  it("falls back to the kind, so a renamed activity keeps its colour", () => {
    assert.equal(
      activityHue({ id: "quiz-2", kind: "trivia" }, 3),
      "var(--trivia)",
    );
  });

  it("cycles the product hues for an activity it has never heard of", () => {
    const hue = activityHue({ id: "whiteboard", kind: "something-new" }, 1);
    assert.equal(hue, "var(--consul)");
    // Never invisible, and never the same as the Spot Award gold.
    assert.notEqual(hue, "var(--spot)");
  });

  it("labels an activity by id, short and tabular", () => {
    assert.equal(activityLabel({ id: "ttx" }), "TTX");
  });
});

describe("pointsStrip", () => {
  it("is empty when there are no own points — sealed shows nothing", () => {
    assert.deepEqual(pointsStripCells(null, ACTIVITIES), []);
    assert.equal(pointsStripText(null, ACTIVITIES), "YOU —");
  });

  it("follows the session's activity order, not the object's key order", () => {
    const own = {
      total: 163,
      byActivity: { arcade: 63, ttx: 100, trivia: null },
    };
    assert.deepEqual(
      pointsStripCells(own, ACTIVITIES).map((c) => c.label),
      ["TTX", "TRIVIA", "ARCADE"],
    );
    assert.equal(
      pointsStripText(own, ACTIVITIES),
      "YOU 163 · TTX 100 · TRIVIA — · ARCADE 63",
    );
  });

  it("shows an em dash for an activity with nothing scored yet", () => {
    const cells = pointsStripCells(
      { total: 0, byActivity: {} },
      ACTIVITIES,
    );
    assert.deepEqual(cells.map((c) => c.value), [null, null, null]);
  });
});

describe("stackedBar", () => {
  const row = {
    perActivity: { ttx: 100, trivia: 80, arcade: null },
    bench: ["trivia"],
    spot: 10,
  };

  it("draws a block per scored activity, then the Spot Awards", () => {
    const segs = stackedBar(row, ACTIVITIES, 190);
    assert.deepEqual(segs.map((s) => s.key), ["ttx", "trivia", "spot"]);
    assert.deepEqual(segs.map((s) => s.points), [100, 80, 10]);
    assert.equal(segs[2]?.hue, "var(--spot)");
  });

  it("marks the credited block as bench, so it can be drawn differently", () => {
    const segs = stackedBar(row, ACTIVITIES, 190);
    assert.equal(segs[0]?.bench, false);
    assert.equal(segs[1]?.bench, true);
  });

  it("scales against the leader, so rows compare to each other", () => {
    const leader = stackedBar(row, ACTIVITIES, 190);
    // 100 of a 190-point leader is a bar just over half the width.
    assert.ok(Math.abs((leader[0]?.percent ?? 0) - 52.63) < 0.01);
    const sum = leader.reduce((n, s) => n + s.percent, 0);
    assert.ok(Math.abs(sum - 100) < 0.01, "the leader's own bar fills the width");
  });

  it("never draws a positive contribution too small to see", () => {
    const tiny = stackedBar(
      { perActivity: { ttx: 1 }, bench: [], spot: 0 },
      ACTIVITIES,
      1000,
    );
    assert.equal(tiny[0]?.percent, 1);
  });

  it("draws nothing at all when nothing has been scored", () => {
    assert.deepEqual(
      stackedBar({ perActivity: { ttx: null }, bench: [], spot: 0 }, ACTIVITIES, 0),
      [],
    );
  });
});
