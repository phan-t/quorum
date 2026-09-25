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
  answerKeyIndex,
  answerTiles,
  bridgeEntries,
  bridgeSteps,
  floorEntries,
  formatCountdown,
  glassBackable,
  glassCrossing,
  gridEntries,
  isTapKey,
  itemEndsAt,
  latestCheckpoint,
  msToTurn,
  nextSegment,
  paneKeyIndex,
  playerName,
  unsealLetterKey,
  unsealRevealHead,
  unsealTiles,
  playerTag,
  pointsStripCells,
  pointsStripText,
  questionLabel,
  remainingMs,
  resourceBar,
  stackedBar,
  stepFraction,
  timerFraction,
  finalRevealMs,
  waveOfNumber,
  waveRosters,
  wipeFraction,
  ARCADE_ROUND_CARD,
  ARCADE_ROUND_NUMBER,
  FINAL_DWELL_MS,
  FINAL_EMPTY_FIRST_HOLD_MS,
  HOUSE,
  KEY_HINT,
  LIGHT_FACE,
  RUN_OF_SHOW,
  SEGMENT_BUILT,
} from "./view.ts";
// The round's content, imported here and nowhere in the client itself: the
// tins never reach a browser, but the number of them is what the reveal
// header claims, and a test is the only place the two can be held together.
import { UNSEAL_ITEMS } from "../../arcade/unseal.ts";
import type {
  ActivitySummary,
  ArcadeGlassView,
  ArcadeView,
  RosterEntry,
  StandingRow,
  TriviaView,
} from "../../protocol.ts";

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

describe("the final reveal's pace", () => {
  const standings = (n: number): StandingRow[] =>
    Array.from({ length: n }, (_, i) => ({
      rank: i + 1,
      nickname: `player ${i + 1}`,
      total: 100 - i,
      perActivity: { ttx: 100 - i },
      bench: [],
      spot: 0,
    }));

  it("lands the winner when the Desktop's climb and hold are both over", () => {
    // Four steps at four seconds, then seven on the empty first place: the
    // twenty-three seconds a room actually sits through.
    assert.equal(finalRevealMs(standings(5)), 23_000);
    assert.equal(
      finalRevealMs(standings(5)),
      4 * FINAL_DWELL_MS + FINAL_EMPTY_FIRST_HOLD_MS,
    );
  });

  it("shortens with the field, because a short climb is a short climb", () => {
    assert.equal(finalRevealMs(standings(3)), 2 * FINAL_DWELL_MS + FINAL_EMPTY_FIRST_HOLD_MS);
    // One player: nothing to climb, and the hold on the empty slot is the
    // whole reveal.
    assert.equal(finalRevealMs(standings(1)), FINAL_EMPTY_FIRST_HOLD_MS);
  });

  it("is immediate when there is nothing to reveal", () => {
    // Both surfaces say "no scores were recorded" in words; pacing a reveal
    // of an empty list would be twenty-three seconds of a blank screen.
    assert.equal(finalRevealMs([]), 0);
  });

  it("counts joint places by rank and not by position", () => {
    // Two firsts is one step fewer to climb, and the phone must wait exactly
    // as long as the Desktop takes rather than as long as the list is.
    const tied = standings(5).map((r, i) => ({ ...r, rank: i === 1 ? 1 : r.rank }));
    assert.equal(finalRevealMs(tied), 3 * FINAL_DWELL_MS + FINAL_EMPTY_FIRST_HOLD_MS);
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
  it("includes the arcade now that it exists", () => {
    // A segment joins the space bar's walk when its surface is real. Both
    // activities are now built, so the primary button walks the whole
    // afternoon and never lands on a placeholder.
    assert.ok(RUN_OF_SHOW.includes("trivia"));
    assert.ok(RUN_OF_SHOW.includes("arcade"));
    assert.equal(nextSegment("holding"), "trivia");
    assert.equal(nextSegment("trivia"), "arcade");
    assert.equal(nextSegment("arcade"), "standings");
    assert.equal(SEGMENT_BUILT.trivia, true);
    assert.equal(SEGMENT_BUILT.arcade, true);
  });

  it("still comes back to the board from anywhere off-piste", () => {
    // Nothing is off the run of show today, but the fallback is the reason a
    // host can hand-pick a segment and still find the space bar useful.
    assert.equal(nextSegment("final"), null);
  });
});

/* ------------------------------------------------------------------ */
/* The arcade register                                                 */
/* ------------------------------------------------------------------ */

const ROSTER: readonly RosterEntry[] = [
  { pid: "p1", nickname: "Priya", playerNumber: 1, conn: "on" },
  { pid: "p2", nickname: "Kenji", playerNumber: 2, conn: "away" },
  { pid: "p3", nickname: "Ade", playerNumber: 3, conn: "on" },
];

function arcade(over: Partial<ArcadeView> = {}): ArcadeView {
  return {
    activityId: "arcade",
    round: "plan_apply",
    roundIndex: 1,
    phase: "running",
    startedAt: 1_000,
    endsAt: 76_000,
    grid: [
      { pid: "p1", playerNumber: 1, standing: "floor", backers: 2, struck: false },
      { pid: "p2", playerNumber: 2, standing: "drained", backers: 0, struck: true },
      { pid: "p3", playerNumber: 17, standing: "floor", backers: 0, struck: false },
    ],
    onFloor: 2,
    inLounge: 1,
    ...over,
  };
}

describe("player numbers", () => {
  it("are three digits, because the announcer says three digits", () => {
    // DESIGN.md: "Three digits, Plex Mono 600, on a green badge." And the
    // copy is *Player 017 has been drained*, never a colleague's name in red.
    assert.equal(playerTag(17), "017");
    assert.equal(playerTag(1), "001");
    assert.equal(playerTag(140), "140");
    assert.equal(playerName(17), "Player 017");
    // Above 999 the badge simply gets longer: a wrapped-around number would
    // be two people with the same name.
    assert.equal(playerTag(1_000), "1000");
  });
});

describe("the light", () => {
  it("is never distinguished by colour alone", () => {
    // DESIGN.md's floor, and a green/pink pair is the exact case that fails
    // it. Each light carries a word, a button label and a glyph before any
    // hue is involved, and the two must differ on every one of them.
    const plan = LIGHT_FACE.plan;
    const apply = LIGHT_FACE.apply;
    assert.notEqual(plan.sign, apply.sign);
    assert.notEqual(plan.button, apply.button);
    assert.notEqual(plan.glyph, apply.glyph);
    assert.notEqual(plan.fill, apply.fill);
    assert.notEqual(plan.announce, apply.announce);
    // SPEC.md's words, verbatim: they are read out and they are the joke.
    assert.equal(plan.sign, "PLAN");
    assert.equal(apply.sign, "APPLY IN PROGRESS — STATE LOCKED");
  });

  it("has no exclamation marks anywhere in the register", () => {
    // DESIGN.md: "Short sentences. No exclamation marks, ever."
    for (const lines of Object.values(ARCADE_ROUND_CARD)) {
      for (const line of lines) {
        assert.ok(!line.includes("!"), `"${line}" raises its voice`);
      }
    }
  });
});

describe("the wipe", () => {
  const TURN = 10_000;
  const pa = { headTurnsAt: TURN - 400, nextChangeAt: TURN };

  it("runs from the telegraph to the lock, off absolute epochs", () => {
    // Never a duration measured from whenever the frame arrived: a screen
    // 300 ms behind must still finish the wipe when the lock lands.
    assert.equal(wipeFraction(pa, TURN - 500), null);
    assert.equal(wipeFraction(pa, TURN - 400), 0);
    assert.equal(wipeFraction(pa, TURN - 200), 0.5);
    assert.equal(wipeFraction(pa, TURN), 1);
    assert.equal(wipeFraction(pa, TURN + 1_000), 1);
  });

  it("draws nothing at all on a surface that was not told", () => {
    // Which is every phone in the room, and that is the whole projection:
    // no schedule, no wipe, no way to know the lock is coming.
    assert.equal(wipeFraction({}, TURN), null);
    assert.equal(msToTurn({}, TURN), null);
    assert.equal(msToTurn(pa, TURN - 900), 500);
  });
});

describe("the resource bar", () => {
  it("puts its ticks where the points are banked", () => {
    const bar = resourceBar({ target: 120, checkpoints: [30, 60, 90] }, 45);
    assert.equal(bar.fraction, 0.375);
    assert.deepEqual(bar.ticks, [0.25, 0.5, 0.75]);
  });

  it("never runs past the end of itself", () => {
    assert.equal(resourceBar({ target: 120, checkpoints: [] }, 400).fraction, 1);
    assert.equal(resourceBar({ target: 0, checkpoints: [] }, 0).fraction, 0);
  });
});

describe("the grid", () => {
  it("joins the cell to the roster the same socket already carried", () => {
    const entries = gridEntries(arcade(), ROSTER);
    assert.deepEqual(
      entries.map((e) => e.tag),
      ["001", "002", "017"],
    );
    // Away comes from the roster, not from the cell: nothing about who is
    // connected belongs in the arcade's own state.
    assert.equal(entries[1]?.away, true);
    assert.equal(entries[1]?.struck, true);
    assert.equal(entries[0]?.backers, 2);
  });

  it("offers the Lounge everyone still on the Floor, and not themselves", () => {
    const floor = floorEntries(arcade(), ROSTER, "p3");
    assert.deepEqual(
      floor.map((e) => e.pid),
      ["p1"],
    );
    // The nickname is here because this list is on a phone. The big screen
    // renders the tag and never reads this field.
    assert.equal(floor[0]?.nickname, "Priya");
  });
});

/* ------------------------------------------------------------------ */
/* The Glass Bridge                                                    */
/* ------------------------------------------------------------------ */

/**
 * Six people, two per wave, mid-crossing: 001 has taken two steps, 002 fell,
 * 003 is facing step 1 and everybody else is waiting.
 */
const BRIDGE_ROSTER: readonly RosterEntry[] = [
  { pid: "p1", nickname: "Priya", playerNumber: 1, conn: "on" },
  { pid: "p2", nickname: "Kenji", playerNumber: 2, conn: "on" },
  { pid: "p3", nickname: "Ade", playerNumber: 3, conn: "on" },
  { pid: "p4", nickname: "Grace", playerNumber: 4, conn: "on" },
  { pid: "p5", nickname: "Tobias", playerNumber: 5, conn: "away" },
  { pid: "p6", nickname: "Yuki", playerNumber: 6, conn: "on" },
];

function glass(over: Partial<ArcadeGlassView> = {}): ArcadeGlassView {
  return {
    wave: 2,
    waveCuts: [2, 4],
    waveSeconds: [12, 9, 6],
    of: 3,
    broken: [1, null, null],
    board: [
      { product: "Vault", labels: ["Transit", "Lease Broker Mesh"] },
      { product: "Consul", labels: ["Anti-Entropy Beacon", "Gossip Pool"] },
      { product: "Nomad", labels: ["Task Drivers", "Sentinel Scheduler"] },
    ],
    step: 1,
    waveStartedAt: 10_000,
    stepStartedAt: 10_000,
    stepEndsAt: 19_000,
    position: { p1: 3, p2: 0, p3: 1, p4: 0 },
    ...over,
  };
}

function bridgeArcade(g: ArcadeGlassView = glass()): ArcadeView {
  return arcade({
    round: "glass_bridge",
    glass: g,
    grid: [
      { pid: "p1", playerNumber: 1, standing: "floor", backers: 0, struck: false },
      { pid: "p2", playerNumber: 2, standing: "drained", backers: 1, struck: true },
      { pid: "p3", playerNumber: 3, standing: "floor", backers: 1, struck: false },
      { pid: "p4", playerNumber: 4, standing: "floor", backers: 0, struck: false },
      { pid: "p5", playerNumber: 5, standing: "floor", backers: 0, struck: false },
      { pid: "p6", playerNumber: 6, standing: "floor", backers: 0, struck: false },
    ],
    onFloor: 5,
    inLounge: 1,
  });
}

describe("the waves", () => {
  it("are read off the two cuts, which is the arithmetic the room does", () => {
    // SPEC.md has the waves "by player number", and the cuts are on the big
    // screen precisely so anybody can check their own badge against them.
    assert.equal(waveOfNumber(1, [2, 4]), 1);
    assert.equal(waveOfNumber(2, [2, 4]), 1);
    assert.equal(waveOfNumber(3, [2, 4]), 2);
    assert.equal(waveOfNumber(4, [2, 4]), 2);
    assert.equal(waveOfNumber(5, [2, 4]), 3);
    // A latecomer's number is above both cuts, so they are wave 3 by
    // arithmetic rather than by being reassigned mid-round.
    assert.equal(waveOfNumber(99, [2, 4]), 3);
  });

  it("carry their own step length, which is what going first is paid for", () => {
    const waves = waveRosters(bridgeArcade(), BRIDGE_ROSTER, glass());
    assert.deepEqual(
      waves.map((w) => [w.wave, w.seconds, w.members.map((m) => m.tag)]),
      [
        [1, 12, ["001", "002"]],
        [2, 9, ["003", "004"]],
        [3, 6, ["005", "006"]],
      ],
    );
  });
});

describe("the bridge", () => {
  it("places everybody: on it, waiting for it, or across", () => {
    const entries = bridgeEntries(bridgeArcade(), BRIDGE_ROSTER, glass());
    const by = new Map(entries.map((e) => [e.pid, e]));
    // Across, and still on the Floor — they were never drained.
    assert.equal(by.get("p1")?.across, true);
    assert.equal(by.get("p1")?.onBridge, false);
    // Drained: not on the bridge and not waiting for it.
    assert.equal(by.get("p2")?.onBridge, false);
    assert.equal(by.get("p2")?.waiting, false);
    // Wave 2 is the wave that is crossing.
    assert.equal(by.get("p3")?.onBridge, true);
    assert.equal(by.get("p3")?.position, 1);
    // Wave 3 is watching, which SPEC.md says is worth doing.
    assert.equal(by.get("p5")?.waiting, true);
    assert.equal(by.get("p5")?.onBridge, false);
    // Away comes from the roster, exactly as it does for the grid.
    assert.equal(by.get("p5")?.away, true);
  });

  it("shows the panes that broke behind the wave, and only those", () => {
    const { steps, across } = bridgeSteps(bridgeArcade(), BRIDGE_ROSTER, glass());
    assert.deepEqual(
      steps.map((s) => s.broken),
      [1, null, null],
    );
    // The open step is the one the wave is deciding, and it is not the one
    // with a break on it — a break only ever appears behind them.
    assert.equal(steps[1]?.open, true);
    assert.equal(steps[1]?.broken, null);
    // Who is standing where. p4 has not stepped yet, p3 has taken one.
    assert.deepEqual(steps[0]?.standing.map((e) => e.tag), ["004"]);
    assert.deepEqual(steps[1]?.standing.map((e) => e.tag), ["003"]);
    assert.deepEqual(across.map((e) => e.tag), ["001"]);
  });

  it("draws the bridge before the panes exist, because the card comes first", () => {
    // The server withholds `board` while the round card is up, for the reason
    // it withholds Recruitment's cue. The row still draws.
    // Built by omission, which is how the frame arrives: the keys are not in
    // the bytes rather than sitting there as undefined.
    const full = glass();
    const card: ArcadeGlassView = {
      wave: full.wave,
      waveCuts: full.waveCuts,
      waveSeconds: full.waveSeconds,
      of: full.of,
      broken: [null, null, null],
    };
    const { steps } = bridgeSteps(bridgeArcade(card), BRIDGE_ROSTER, card);
    assert.equal(steps.length, 3);
    assert.deepEqual(steps[0]?.labels, ["", ""]);
    assert.equal(steps[0]?.open, false);
    assert.equal(stepFraction(card, 10_000), null);
  });

  it("empties the step's bar off the two epochs the server sent", () => {
    const g = glass();
    assert.equal(stepFraction(g, 10_000), 1);
    assert.equal(stepFraction(g, 14_500), 0.5);
    assert.equal(stepFraction(g, 19_000), 0);
    assert.equal(stepFraction(g, 30_000), 0);
    // Nothing to draw when no step is open — the card, and the reveal.
    assert.equal(stepFraction({}, 10_000), null);
  });
});

describe("the Lounge on the bridge", () => {
  it("offers only a later wave, because SPEC narrows it to one", () => {
    // Backing a runner who is already on the bridge is a certainty rather
    // than a bet, and a chip that is refused when pressed should not have
    // been drawn.
    const backable = glassBackable(bridgeArcade(), BRIDGE_ROSTER, glass(), "p2");
    assert.deepEqual(
      backable.map((e) => e.tag),
      ["005", "006"],
    );
  });

  it("offers nobody once the last wave is on the bridge", () => {
    const g = glass({ wave: 3 });
    assert.deepEqual(glassBackable(bridgeArcade(g), BRIDGE_ROSTER, g, "p2"), []);
  });

  it("offers a waiting wave the runners in front of them, and nobody else", () => {
    // The other side of the same list: wave 3 is watching wave 2 cross, and
    // the people they may bet on are the ones actually on the bridge — not
    // the player already across, not the drained one, and not each other.
    const crossing = glassCrossing(bridgeArcade(), BRIDGE_ROSTER, glass());
    assert.deepEqual(
      crossing.map((e) => e.tag),
      ["003", "004"],
    );
  });
});

describe("the bridge's register", () => {
  it("names the step and never the pane", () => {
    // DESIGN.md: `> Pane 4 was not tempered. Player 017 drained.` "Pane 4" is
    // the fourth *step*: the line goes on the big screen, in a room that
    // still contains two waves who have not crossed, and saying which of the
    // two panes broke would be saying which one is real.
    assert.equal(HOUSE.glassFall(4, 17), "Pane 4 was not tempered. Player 017 drained.");
    assert.equal(HOUSE.glassPane(4), "Pane 4 was not tempered.");
    // The other way off the bridge, which is not a pane anybody stood on.
    assert.equal(HOUSE.glassTimeout(4, 17), "Pane 4 was not chosen. Player 017 drained.");
    assert.equal(
      HOUSE.glassCrossed(17),
      "Player 017 has reached the far side. It is not very interesting there.",
    );
    for (const line of [
      HOUSE.glassFall(4, 17),
      HOUSE.glassTimeout(4, 17),
      HOUSE.glassCrossed(17),
    ]) {
      assert.ok(!line.includes("!"), `"${line}" raises its voice`);
      assert.ok(!/left|right/i.test(line), `"${line}" says which pane`);
    }
  });

  it("says on screen that the two keys work, because nobody guesses it", () => {
    assert.equal(KEY_HINT.glass, "← and → step onto a pane");
  });
});

describe("the two panes on a keyboard", () => {
  const ev = (key: string, over: Record<string, boolean> = {}) => ({
    key,
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...over,
  });

  it("maps left and right, and the two digits, to the two panes", () => {
    // Wave 3 gets six seconds a step. A control that needs a trackpad, a hunt
    // for the target and a click inside six seconds costs somebody the round
    // for owning the wrong hardware.
    assert.equal(paneKeyIndex(ev("ArrowLeft")), 0);
    assert.equal(paneKeyIndex(ev("ArrowRight")), 1);
    assert.equal(paneKeyIndex(ev("1")), 0);
    assert.equal(paneKeyIndex(ev("2")), 1);
  });

  it("ignores everything else, and a key the OS is repeating", () => {
    assert.equal(paneKeyIndex(ev("ArrowUp")), null);
    assert.equal(paneKeyIndex(ev("3")), null);
    assert.equal(paneKeyIndex(ev(" ")), null);
    assert.equal(paneKeyIndex(ev("ArrowLeft", { repeat: true })), null);
    // A browser shortcut is not a step.
    assert.equal(paneKeyIndex(ev("ArrowLeft", { metaKey: true })), null);
    assert.equal(paneKeyIndex(ev("ArrowRight", { ctrlKey: true })), null);
  });
});

/* ------------------------------------------------------------------ */
/* The keyboard                                                        */
/* ------------------------------------------------------------------ */

const key = (
  k: string,
  over: Partial<{ repeat: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {},
): { key: string; repeat: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean } => ({
  key: k,
  repeat: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

describe("the tap key", () => {
  it("answers to space and enter, and to nothing else", () => {
    assert.deepEqual(isTapKey(key(" ")), { handled: true, taps: true });
    assert.deepEqual(isTapKey(key("Enter")), { handled: true, taps: true });
    assert.deepEqual(isTapKey(key("Spacebar")), { handled: true, taps: true });
    assert.deepEqual(isTapKey(key("a")), { handled: false, taps: false });
    assert.deepEqual(isTapKey(key("Tab")), { handled: false, taps: false });
  });

  /**
   * The whole point of the repeat rule: a held key is claimed — so the page
   * does not scroll and the button is not activated underneath — but it does
   * not add a resource. One physical press, one tap, exactly like one click.
   */
  it("claims a held key without counting it", () => {
    assert.deepEqual(isTapKey(key(" ", { repeat: true })), {
      handled: true,
      taps: false,
    });
  });

  it("keeps its hands off the browser's own shortcuts", () => {
    assert.equal(isTapKey(key(" ", { metaKey: true })).handled, false);
    assert.equal(isTapKey(key("Enter", { ctrlKey: true })).handled, false);
    assert.equal(isTapKey(key(" ", { altKey: true })).handled, false);
  });
});

describe("the answer keys", () => {
  it("maps 1-4 onto the tiles that exist", () => {
    assert.equal(answerKeyIndex("1", 4), 0);
    assert.equal(answerKeyIndex("4", 4), 3);
    // A two-answer question has no tile 3, and pressing 3 must do nothing
    // rather than throw or lock in a choice nobody can see.
    assert.equal(answerKeyIndex("3", 2), null);
    assert.equal(answerKeyIndex("0", 4), null);
    assert.equal(answerKeyIndex("5", 4), null);
    assert.equal(answerKeyIndex("Enter", 4), null);
    assert.equal(answerKeyIndex(" ", 4), null);
  });
});

/* ------------------------------------------------------------------ */
/* The arcade's numbers and clocks                                     */
/* ------------------------------------------------------------------ */

describe("the round number", () => {
  /**
   * SPEC.md's table, not the position in the run: the host picks the order,
   * so numbering off `roundIndex` had the console saying ROUND 1 ·
   * RECRUITMENT while the room's card said Game 1 — Plan / Apply.
   */
  it("is the round's own, and matches the card the room is shown", () => {
    assert.equal(ARCADE_ROUND_NUMBER.recruitment, 0);
    assert.equal(ARCADE_ROUND_NUMBER.plan_apply, 1);
    assert.equal(ARCADE_ROUND_NUMBER.glass_bridge, 5);
    for (const [kind, lines] of Object.entries(ARCADE_ROUND_CARD)) {
      const n = ARCADE_ROUND_NUMBER[kind as keyof typeof ARCADE_ROUND_NUMBER];
      if (n === 0) continue; // Recruitment's card does not name a game number
      assert.equal(lines[0]?.startsWith(`Game ${n} —`), true, kind);
    }
  });
});

describe("the checkpoint line", () => {
  it("names the checkpoint that was crossed, not the running count", () => {
    assert.equal(latestCheckpoint([30, 60, 90], 0), null);
    assert.equal(latestCheckpoint([30, 60, 90], 29), null);
    assert.equal(latestCheckpoint([30, 60, 90], 30), 30);
    assert.equal(latestCheckpoint([30, 60, 90], 59), 30);
    assert.equal(latestCheckpoint([30, 60, 90], 119), 90);
  });

  it("does not assume the wire sent them in order", () => {
    assert.equal(latestCheckpoint([90, 30, 60], 61), 60);
    assert.equal(latestCheckpoint([], 500), null);
  });
});

describe("the item clock", () => {
  /**
   * The item's deadline, never the round's. The round's `endsAt` is the last
   * item's, so drawing it in the item slot counted two and a half minutes
   * down at somebody who had twenty seconds.
   */
  it("is the item's own instant", () => {
    assert.equal(itemEndsAt({ at: 0, of: 6, itemEndsAt: 1_700 }), 1_700);
  });

  it("is nothing at all when no item is running", () => {
    // The round card and the reveal: the server omits the key rather than
    // nulling it, and a timer with nothing behind it shows nothing.
    assert.equal(itemEndsAt({ at: 5, of: 6 }), null);
    assert.equal(itemEndsAt(undefined), null);
  });
});

describe("Unseal's reveal header", () => {
  /**
   * This header shipped as the literal "NINE TINS. NINE WORDS." and then a
   * tenth tin was added to the circle tier without it, so for one commit the
   * shared screen told the room a number the board under it disagreed with.
   * The count now comes from the recap, and this is the test that notices
   * when the content and the copy part company again.
   */
  it("counts the tins the room was actually dealt", () => {
    assert.equal(unsealRevealHead(UNSEAL_ITEMS.length), "TEN TINS. TEN WORDS.");
    assert.equal(unsealRevealHead(9), "NINE TINS. NINE WORDS.");
    assert.equal(unsealRevealHead(11), "ELEVEN TINS. ELEVEN WORDS.");
  });

  /**
   * A one-tin Floor is not a shape the arcade deals today, but the header is
   * a sentence and "ONE TINS" is the kind of thing a room reads out loud.
   */
  it("is a sentence at one tin, and digits past the words it knows", () => {
    assert.equal(unsealRevealHead(1), "ONE TIN. ONE WORD.");
    assert.equal(unsealRevealHead(21), "21 TINS. 21 WORDS.");
  });
});

describe("Unseal's letter tiles", () => {
  /**
   * The consumption is a multiset, and this is the whole reason the helper
   * exists. GOSSIP has two Ss: after the first S is tapped exactly one of the
   * two S tiles must go dim. "Every tile whose letter is in the solved
   * prefix" would grey out both and leave somebody looking at a word they
   * cannot finish.
   */
  it("spends one tile per solved letter, not every tile with that letter", () => {
    const tiles = unsealTiles("S I P G O S", "GOS");
    assert.equal(tiles.map((t) => t.letter).join(""), "SIPGOS");
    assert.equal(tiles.filter((t) => t.used).length, 3);
    // One S is spent and one is still there to tap.
    const esses = tiles.filter((t) => t.letter === "S");
    assert.deepEqual(
      esses.map((t) => t.used).sort(),
      [false, true],
    );
  });

  it("spends nothing before the first tap, and everything at the end", () => {
    assert.equal(unsealTiles("T F A R", "").every((t) => !t.used), true);
    assert.equal(unsealTiles("T F A R", "RAFT").every((t) => t.used), true);
  });

  it("drops the spaces the cue is written with", () => {
    assert.equal(unsealTiles("T F A R", "").length, 4);
  });
});

describe("Unseal's keyboard", () => {
  const key = (over: Partial<Parameters<typeof unsealLetterKey>[0]>) =>
    unsealLetterKey({
      key: "a",
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      ...over,
    });

  it("turns a letter key into the letter it taps, in upper case", () => {
    assert.equal(key({ key: "a" }), "A");
    assert.equal(key({ key: "Q" }), "Q");
  });

  it("is not a chord, a digit, or a named key", () => {
    assert.equal(key({ key: "a", metaKey: true }), null);
    assert.equal(key({ key: "4" }), null);
    assert.equal(key({ key: "Enter" }), null);
    assert.equal(key({ key: " " }), null);
  });

  /**
   * A held key would send the same letter thirty times a second, and in this
   * round the second one of those is always the wrong letter — which cracks
   * the tin. `repeat` is the difference between an accommodation and a way to
   * lose the round by resting a finger on a key.
   */
  it("is not an OS key repeat", () => {
    assert.equal(key({ key: "a", repeat: true }), null);
  });
});
