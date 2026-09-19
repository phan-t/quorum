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
  answerTiles,
  formatCountdown,
  nextSegment,
  pointsStripCells,
  pointsStripText,
  questionLabel,
  remainingMs,
  stackedBar,
  timerFraction,
  RUN_OF_SHOW,
  SEGMENT_BUILT,
} from "./view.ts";
import type { ActivitySummary, TriviaView } from "../../protocol.ts";

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

/* ------------------------------------------------------------------ */
/* Trivia                                                              */
/* ------------------------------------------------------------------ */

const OPEN_AT = 1_700_000_000_000;

function question(over: Partial<TriviaView> = {}): TriviaView {
  return {
    activityId: "trivia",
    index: 6,
    of: 20,
    phase: "open",
    text: "Which product does secrets management?",
    answers: ["Consul", "Boundary", "Vault", "Nomad"],
    opensAt: OPEN_AT,
    closesAt: OPEN_AT + 20_000,
    timeLimitSec: 20,
    basePoints: 1000,
    suddenDeath: false,
    suddenDeathWinner: null,
    round: null,
    ...over,
  };
}

describe("answerTiles", () => {
  it("gives each answer a shape as well as a colour", () => {
    // DESIGN.md: "every answer has a shape as well as a colour". The shape is
    // what makes the tile identifiable on a compressed video tile, and to
    // anyone who cannot tell the pink one from the purple one.
    const tiles = answerTiles(["Consul", "Boundary", "Vault", "Nomad"]);
    assert.deepEqual(tiles.map((t) => t.shape), ["▲", "◆", "●", "■"]);
    assert.equal(new Set(tiles.map((t) => t.hue)).size, 4);
    assert.deepEqual(tiles.map((t) => t.index), [0, 1, 2, 3]);
  });

  it("uses the product hues and nothing else", () => {
    const hues = answerTiles(["a", "b", "c", "d"]).map((t) => t.hue);
    assert.deepEqual(hues, [
      "var(--terraform)",
      "var(--consul)",
      "var(--nomad)",
      "var(--vault)",
    ]);
  });

  it("puts dark ink on the light fills", () => {
    // DESIGN.md asks for white text on all four; white on --nomad is 2.1:1
    // and white on --vault is worse, against the same document's 4.5:1 floor.
    // The accessibility rule wins. See the report.
    const tiles = answerTiles(["a", "b", "c", "d"]);
    assert.equal(tiles[0]!.ink, "var(--on-fill-light)"); // terraform, 6.4:1
    for (const t of tiles.slice(1)) assert.equal(t.ink, "var(--on-fill-dark)");
  });

  it("handles a two-answer question without inventing two more", () => {
    // SPEC.md: "Two- and three-answer questions are allowed by leaving answer
    // columns blank."
    assert.equal(answerTiles(["Yes", "No"]).length, 2);
    assert.equal(answerTiles(["a", "b", "c"]).length, 3);
  });
});

describe("countdowns", () => {
  it("counts down to the absolute instant, not from a duration", () => {
    assert.equal(remainingMs(OPEN_AT + 20_000, OPEN_AT), 20_000);
    // A client that received the frame five seconds late still lands on the
    // same instant, which is the whole reason the wire carries an epoch.
    assert.equal(remainingMs(OPEN_AT + 20_000, OPEN_AT + 5_000), 15_000);
  });

  it("never goes past zero, and has nothing to show without a deadline", () => {
    assert.equal(remainingMs(OPEN_AT, OPEN_AT + 9_000), 0);
    assert.equal(remainingMs(null, OPEN_AT), null);
  });

  it("formats as mm:ss, rounding up so the last second is a 1", () => {
    assert.equal(formatCountdown(20_000), "00:20");
    assert.equal(formatCountdown(14_200), "00:15");
    assert.equal(formatCountdown(1), "00:01");
    assert.equal(formatCountdown(0), "00:00");
    assert.equal(formatCountdown(95_000), "01:35");
  });

  it("empties the bar over the question's actual life", () => {
    const q = question();
    assert.equal(timerFraction(q, OPEN_AT), 1);
    assert.equal(timerFraction(q, OPEN_AT + 10_000), 0.5);
    assert.equal(timerFraction(q, OPEN_AT + 25_000), 0);
    // Sudden death has no timer at all, so it draws no bar rather than a full
    // one that looks stuck.
    assert.equal(timerFraction(question({ closesAt: null }), OPEN_AT), null);
  });

  it("labels the question one-based, because people count from one", () => {
    assert.equal(questionLabel(question()), "Q7 of 20");
  });
});

describe("the run of show", () => {
  it("includes trivia now that it exists", () => {
    // A segment joins the space bar's walk when its surface is real. The
    // arcade is still a placeholder and still out.
    assert.ok(RUN_OF_SHOW.includes("trivia"));
    assert.ok(!RUN_OF_SHOW.includes("arcade"));
    assert.equal(nextSegment("holding"), "trivia");
    assert.equal(nextSegment("trivia"), "standings");
    assert.equal(SEGMENT_BUILT.trivia, true);
    assert.equal(SEGMENT_BUILT.arcade, false);
  });
});
