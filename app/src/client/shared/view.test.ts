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
  backedProgress,
  bridgeEntries,
  bridgeSteps,
  clipName,
  floorEntries,
  formatCountdown,
  glassBackable,
  glassCrossing,
  gridEntries,
  isTapKey,
  itemEndsAt,
  latestCheckpoint,
  lobbyAdmission,
  lobbyRoom,
  msToTurn,
  nextSegment,
  nickKey,
  paneKeyIndex,
  playerName,
  raftArrival,
  raftDrain,
  tugPullWinner,
  unsealSlot,
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
  HOW_TO_PLAY,
  KEY_HINT,
  LIGHT_FACE,
  LOBBY_CHIP_MAX,
  RAFT_NAME_MAX,
  RAFT_QUEUE_MAX,
  RUN_OF_SHOW,
  SEGMENT_BUILT,
  UNSEAL_NOTHING_SAID,
  type RaftEntry,
  type RaftPlan,
} from "./view.ts";
// The round's content, imported here and nowhere in the client itself: the
// tins never reach a browser, but the number of them is what the reveal
// header claims, and a test is the only place the two can be held together.
import { UNSEAL_ITEMS } from "../../arcade/unseal.ts";
import type {
  ActivitySummary,
  ArcadeGlassView,
  ArcadeMine,
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

describe("the backed runner's line on the Lounge card", () => {
  function mine(over: Partial<ArcadeMine> = {}): ArcadeMine {
    return {
      playerNumber: 2,
      standing: "drained",
      banked: 10,
      total: 10,
      ...over,
    };
  }

  const planApply = { light: "plan" as const, lightChangedAt: 0, target: 120, checkpoints: [30, 60, 90] };

  it("says nothing at all to a phone with no bet placed", () => {
    // There is no card to put a line under, and a fraction with no runner would
    // be a bar drawn against nobody.
    assert.equal(backedProgress(arcade({ planApply }), mine()), null);
  });

  it("gives Plan / Apply the count against the target, and the bar with it", () => {
    // This is the whole of the fix: the Lounge could read PLAN, LOCKED and
    // "N of M across" and learn nothing about the runner it had bet on.
    const got = backedProgress(
      arcade({ planApply }),
      mine({ backing: "p1", planApply: { resources: 40, backedResources: 90 } }),
    );
    assert.deepEqual(got, { line: "90 of 120 resources", fraction: 0.75 });
  });

  it("says Across rather than 120 of 120, because that is the news", () => {
    const got = backedProgress(
      arcade({ planApply }),
      mine({ backing: "p1", planApply: { resources: 40, backedResources: 120 } }),
    );
    assert.deepEqual(got, { line: "Across · 120 resources", fraction: 1 });
  });

  it("draws nought as nought, because a runner who has not moved is the news too", () => {
    const got = backedProgress(
      arcade({ planApply }),
      mine({ backing: "p1", planApply: { resources: 40, backedResources: 0 } }),
    );
    assert.deepEqual(got, { line: "0 of 120 resources", fraction: 0 });
  });

  it("names the pane the backed runner is standing on, on the bridge", () => {
    // `position` is steps *completed*, so a runner on 1 of 3 is standing on
    // pane 2 — which is the pane the room is watching them decide.
    const got = backedProgress(bridgeArcade(), mine({ backing: "p3" }));
    assert.deepEqual(got, { line: "Standing on pane 2 of 3", fraction: 1 / 3 });
  });

  it("says Across on the bridge once they have reached the far side", () => {
    const got = backedProgress(bridgeArcade(), mine({ backing: "p1" }));
    assert.deepEqual(got, { line: "Across · 3 of 3 panes", fraction: 1 });
  });

  it("says the backed runner fell, rather than leaving them standing on a pane", () => {
    // The engine does not clear the seat when its runner drains — the bet has
    // to stand to be settled — and the chip is drawn from the whole grid, so
    // before this the phone told a backer their runner was standing on a pane
    // for the rest of a round they had fallen out of. p2 is drained on 0 steps,
    // which is a fall at the first pane.
    const got = backedProgress(bridgeArcade(), mine({ backing: "p2" }));
    assert.deepEqual(got, { line: "Drained at pane 1 of 3", fraction: null });
  });

  it("drops the bar with the runner, because a stopped bar reads as a moving one", () => {
    // The same rule the big screen's ticker follows when it drops a drained
    // runner: a fraction is a live reading, and there is nothing live left.
    const g = glass({ position: { p1: 3, p2: 0, p3: 2, p4: 0 } });
    const grid = bridgeArcade(g).grid.map((c) =>
      c.pid === "p3" ? { ...c, standing: "drained" as const, struck: true } : c,
    );
    const got = backedProgress({ ...bridgeArcade(g), grid }, mine({ backing: "p3" }));
    assert.deepEqual(got, { line: "Drained at pane 3 of 3", fraction: null });
  });

  it("does not stand a waiting wave on pane 1 before they have walked on", () => {
    // p5 is wave 3 with wave 2 crossing, so `position` has no entry for them
    // yet — which is nought, which would have read as pane 1 of 3. The Lounge
    // bets only on a later wave, so this is the state every Lounge bet on this
    // bridge starts in.
    const got = backedProgress(bridgeArcade(), mine({ backing: "p5" }));
    assert.deepEqual(got, { line: "Wave 3 · not on the bridge yet", fraction: 0 });
  });

  it("stands the crossing wave on pane 1 at nought, because that one is true", () => {
    // The other side of the same test: p4 is in the wave on the bridge and has
    // completed no steps, so pane 1 is the pane they are deciding.
    const got = backedProgress(bridgeArcade(), mine({ backing: "p4" }));
    assert.deepEqual(got, { line: "Standing on pane 1 of 3", fraction: 0 });
  });

  it("says the backed runner was drained in Plan / Apply too", () => {
    // The Lounge's chip list hides a drained runner during this round, so no
    // phone reaches this today; the line is in the past tense anyway rather
    // than resting on a filter two files away.
    const a = arcade({ planApply });
    const got = backedProgress(
      a,
      mine({ backing: "p2", planApply: { resources: 40, backedResources: 90 } }),
    );
    assert.deepEqual(got, { line: "Drained at 90 resources", fraction: null });
  });

  it("says nothing about a runner who has left the room", () => {
    // A kicked or released player is out of the grid, and both chips that draw
    // this line look their runner up there as well, so a line would be a line
    // under nothing.
    const got = backedProgress(
      arcade({ planApply }),
      mine({ backing: "gone", planApply: { resources: 40, backedResources: 90 } }),
    );
    assert.equal(got, null);
  });

  it("says nothing while the round card is up, because the board is not on the wire yet", () => {
    // The server omits `position` until the Floor opens, and a zero drawn
    // against a card nobody has walked on is a zero presented as progress.
    const g = glass();
    const card: ArcadeGlassView = {
      wave: g.wave,
      waveCuts: g.waveCuts,
      waveSeconds: g.waveSeconds,
      of: g.of,
      broken: g.broken,
    };
    assert.equal(backedProgress(bridgeArcade(card), mine({ backing: "p3" })), null);
  });

  it("says nothing in Unseal, where progress is a prefix of somebody's word", () => {
    // The server does not send it to the room for exactly that reason, and this
    // is the client agreeing rather than reaching for whatever is on the frame.
    const got = backedProgress(
      arcade({ round: "unseal" }),
      mine({ backing: "p1" }),
    );
    assert.equal(got, null);
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

describe("the House when somebody wins", () => {
  /**
   * The announcer narrated every way to lose and one way to win. These are the
   * two lines that were missing, and they are here rather than in a round's own
   * describe because what is being asserted is the register, not the round.
   */
  it("has a line for the tin coming open", () => {
    assert.equal(HOUSE.unsealOpened, "Sealed: false.");
    // `vault status` with the seal off, which is the joke and is also literally
    // what happened.
    //
    // *Not* split the way the shatter is. The shatter has a named half because
    // the big screen says who was drained; this round's Desktop is counts and
    // never people until the reveal, so there is no `unsealOpen(n)` to pair
    // with, and a "Player 017 opened the tin" catalogued here with nowhere to go
    // is a line that gets wired onto that surface by somebody who did not read
    // why it must not be. The phone says this one; see `paintUnseal`.
    assert.ok(!HOUSE.unsealOpened.includes("Player"));
    assert.ok(!("unsealOpen" in HOUSE), "the Desktop's half needs a surface first");
    assert.ok(HOUSE.unsealShatter(17).startsWith(HOUSE.unsealShattered));
  });

  /**
   * The round is two strikes, so it has two lines, and only one of them names
   * anybody. DESIGN.md's sentence — *The tin has cracked.* — said the round was
   * over, because it was; it now belongs to the tin that is damaged and still
   * being tapped, and the drain says the tin is gone.
   */
  it("says the tin cracked without saying the round is over", () => {
    assert.ok(HOUSE.unsealCracked.startsWith("The tin has cracked."));
    // Three clauses, the shape `unsealDocs` uses in the same slot on the same
    // phone: what happened, what it cost, and what the next tap means.
    assert.ok(HOUSE.unsealCracked.includes("Score halved."));
    assert.ok(HOUSE.unsealCracked.includes("shatters"));
    // Nothing about being drained, because they are not, and nobody else's
    // player number, because a crack stays between the tin and the phone
    // holding it — the Desktop is never told about this beat.
    assert.ok(!HOUSE.unsealCracked.includes("drained"));
    assert.ok(!HOUSE.unsealCracked.includes("Player"));
    assert.ok(!("unsealCrack" in HOUSE), "the Desktop has no half of the crack");
    // And the ending is its own sentence: the same words twice, once as a
    // warning and once as a drain, would be the phone saying nothing.
    assert.notEqual(HOUSE.unsealShattered, HOUSE.unsealCracked);
    assert.ok(HOUSE.unsealShatter(17).includes("drained"));
  });

  it("has a line for the rope, and it does not say anybody won", () => {
    assert.equal(HOUSE.tugPullWon(0), "Side A has the rope. The entry is committed.");
    assert.equal(HOUSE.tugPullWon(1), "Side B has the rope. The entry is committed.");
    // Nobody is drained in this round, so nobody loses one either: a pull is a
    // log entry that committed. "SIDE A" and "SIDE B" are what both the big
    // screen and the phone already call the two clusters.
    for (const side of [0, 1] as const) {
      assert.ok(!/\b(win|won|lose|lost|beat)\b/i.test(HOUSE.tugPullWon(side)));
    }
  });

  it("raises its voice nowhere, including in the lines that are functions", () => {
    // DESIGN.md: "no exclamation marks, ever". Read off the object rather than
    // listed, so a line added later cannot arrive without being checked.
    const spoken = Object.values(HOUSE).map((v) =>
      typeof v === "function"
        ? (v as unknown as (a: number, b: number) => string)(4, 17)
        : v,
    );
    assert.ok(spoken.length >= 20, `only ${spoken.length} lines`);
    for (const line of spoken) {
      assert.ok(line.trim() !== "", "an empty announcer line");
      assert.ok(!line.includes("!"), `"${line}" raises its voice`);
    }
  });
});

describe("how to play", () => {
  it("never says anybody is out, because nobody is", () => {
    // The arcade's one promise is that being drained is not being eliminated:
    // you go to the Lounge, you bet on a runner, and you can still finish
    // ahead of a cautious survivor. Three of these lines used to end "and you
    // are out", on the surface where the room learns which game it is in.
    for (const [round, lines] of Object.entries(HOW_TO_PLAY)) {
      for (const line of lines) {
        assert.ok(!/\byou are out\b/i.test(line), `${round}: "${line}"`);
        assert.ok(!line.includes("!"), `${round}: "${line}" raises its voice`);
      }
    }
    // The three rounds that drain say so, and say where you go.
    for (const round of ["plan_apply", "unseal", "gganbu"] as const) {
      const lines = HOW_TO_PLAY[round];
      assert.ok(
        lines.some((l) => /drain/i.test(l)),
        `${round} does not say what ends your round`,
      );
      assert.ok(
        lines.some((l) => l.includes("Lounge")),
        `${round} does not say where you go`,
      );
    }
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
    assert.equal(unsealRevealHead(UNSEAL_ITEMS.length), "SEVENTEEN TINS. SEVENTEEN WORDS.");
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

/* ------------------------------------------------------------------ */
/* The lobby                                                           */
/* ------------------------------------------------------------------ */

/**
 * The lobby is the one screen where a bug costs somebody the only thing they
 * have asked the product for so far: their name, on the list, so they know the
 * join worked. Everything below is a way that has gone wrong.
 */
const room = (n: number, from = 1): RosterEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    pid: `p${i + from}`,
    nickname: `Player ${i + from}`,
    playerNumber: i + from,
    conn: "on" as const,
  }));

const everyone = (roster: readonly RosterEntry[]): Set<string> =>
  new Set(roster.map((r) => r.pid));

describe("the lobby's list of names", () => {
  it("draws the people the cluster has committed and not the people the server has", () => {
    // The hold is the whole point of the cluster: for about a second and a
    // half a joiner's name is travelling into the leader instead of sitting in
    // the list. A list drawn off the roster would be a second, faster answer
    // to the same question sitting a few pixels away from the first.
    const roster = room(3);
    const drawn = lobbyRoom(roster, new Set(["p1", "p3"]), null);
    assert.equal(drawn.count, 2);
    assert.deepEqual(drawn.shown.map((r) => r.nickname), ["Player 1", "Player 3"]);
  });

  it("counts everybody it is not drawing, so the head count never contradicts the chips", () => {
    // `over` is not decoration. The chips box clips from the bottom, so this
    // number is the only thing on the screen that admits somebody is missing —
    // and it has to be exactly who is missing, or a person counting chips to
    // find themselves is being lied to by a smaller number.
    const roster = room(40);
    const drawn = lobbyRoom(roster, everyone(roster), null);
    assert.equal(drawn.over + drawn.shown.length, drawn.count);
    assert.equal(drawn.shown.length, LOBBY_CHIP_MAX);
    assert.equal(drawn.over, 40 - LOBBY_CHIP_MAX);
  });

  it("keeps the last names, because a latecomer is the only one for whom the list is news", () => {
    // This took the *first* names, which meant that in any room over the cap
    // every latecomer — exactly the people the cluster had just animated — fell
    // into the counter and never appeared at all. The lobby was animating names
    // into a list with no room for them.
    const roster = room(26);
    const drawn = lobbyRoom(roster, everyone(roster), null);
    assert.equal(drawn.shown[0]?.nickname, "Player 3");
    assert.equal(drawn.shown.at(-1)?.nickname, "Player 26");
  });

  it("pins your own name in front of the others and spends a place on it", () => {
    // Flow order, because the box clips from the bottom. Your own chip and the
    // "+N earlier" counter used to sit at the *end*, so in a short window they
    // were the first two things cut: the list lost its truncation notice and
    // you lost the one name you were looking for.
    const roster = room(30);
    const drawn = lobbyRoom(roster, everyone(roster), "Player 4");
    assert.equal(drawn.you?.nickname, "Player 4");
    assert.equal(drawn.shown.includes(drawn.you!), false);
    // One fewer place for everybody else, and the counter absorbs the difference.
    assert.equal(drawn.shown.length, LOBBY_CHIP_MAX - 1);
    assert.equal(drawn.over + drawn.shown.length + 1, drawn.count);
  });

  it("finds your chip whatever case and spacing your nickname was typed with", () => {
    // The nickname this surface holds came back from the server round trip and
    // the roster's copy came from another one. A mismatch here does not look
    // like a bug: it looks like your name being in the list twice, once pinned
    // and once not, or not pinned at all in a room over the cap.
    const roster = room(3);
    const drawn = lobbyRoom(roster, everyone(roster), "  player   2 ");
    assert.equal(drawn.you?.nickname, "Player 2");
  });

  it("has no pinned chip on the console's preview, which is nobody's phone", () => {
    const roster = room(3);
    const drawn = lobbyRoom(roster, everyone(roster), null);
    assert.equal(drawn.you, null);
    assert.equal(drawn.shown.length, 3);
  });

  it("draws an empty room as nothing at all rather than as a counter", () => {
    const drawn = lobbyRoom([], new Set(), "Player 1");
    assert.deepEqual(drawn, { count: 0, you: null, shown: [], over: 0 });
  });
});

describe("a nickname's matching key", () => {
  /**
   * Deliberately finer than the engine's `nicknameKey`, which also strips
   * combining marks and non-alphanumerics. Finer is the safe direction: two
   * names equal here are necessarily equal there, so a collision here would
   * already have been refused at the door.
   */
  it("ignores the case and the spacing somebody typed", () => {
    assert.equal(nickKey("Sam "), nickKey("sam"));
    assert.equal(nickKey("  Sam   Vimes "), nickKey("sam vimes"));
  });

  it("does not make two different people the same person", () => {
    assert.notEqual(nickKey("Sam"), nickKey("Samm"));
    assert.notEqual(nickKey("Sám"), nickKey("Sam"));
  });
});

describe("what the lobby admits on a render", () => {
  it("holds the room it arrived into and plays only your own commit", () => {
    // Arriving into a room of eleven should not replay eleven commits; it
    // should say eleven are committed. The one commit that plays is yours,
    // because it is the only arrival that just happened.
    const roster = room(11);
    const got = lobbyAdmission(roster, null, "Player 7", false);
    assert.equal(got.yours, true);
    assert.deepEqual(got.commit, [{ who: "Player 7", pid: "p7" }]);
    assert.equal(got.hold.length, 10);
    // Your own pid is the one that is *not* held: the list must not already
    // contain the name the cluster is about to deliver.
    assert.equal(got.hold.includes("p7"), false);
  });

  it("plays it once per session, and commits the room as one after that", () => {
    // `buildScene` makes a fresh lobby every time the host changes what is on
    // screen, so without the guard the welcome replays each time the room comes
    // back from a holding card — and the third time somebody watches themselves
    // join they are not being welcomed, they are watching a loop.
    const roster = room(11);
    const again = lobbyAdmission(roster, null, "Player 7", true);
    assert.equal(again.yours, false);
    assert.deepEqual(again.commit, [{ who: null, pid: null }]);
    // And everybody is in the list immediately, including you.
    assert.equal(again.hold.length, 11);
    assert.equal(again.hold.includes("p7"), true);
  });

  it("commits the room as one on the console's preview, which has no name of its own", () => {
    const roster = room(4);
    const got = lobbyAdmission(roster, null, null, false);
    assert.equal(got.yours, false);
    assert.deepEqual(got.commit, [{ who: null, pid: null }]);
    assert.equal(got.hold.length, 4);
  });

  it("commits nothing into an empty room", () => {
    // "Appending" nobody into a cluster of nobody is a sentence about nothing,
    // and the console's lobby preview opens on exactly that.
    const got = lobbyAdmission([], null, null, false);
    assert.deepEqual(got, { hold: [], commit: [], yours: false });
  });

  it("commits only the pids that are new, on every render after the first", () => {
    const first = room(2);
    const later = [...first, ...room(2, 3)];
    const got = lobbyAdmission(later, everyone(first), "Player 1", true);
    assert.deepEqual(got.commit, [
      { who: "Player 3", pid: "p3" },
      { who: "Player 4", pid: "p4" },
    ]);
    // Nothing is held on a later render: a new pid earns its commit, and the
    // commit is what puts it in the list.
    assert.deepEqual(got.hold, []);
  });

  it("says nothing on a render where nobody joined", () => {
    // The lobby re-renders on anything — somebody going away, the host locking
    // joins — and animating those would make the picture mean "a frame arrived"
    // rather than "somebody joined".
    const roster = room(3);
    assert.deepEqual(lobbyAdmission(roster, everyone(roster), "Player 1", true).commit, []);
    // Including a render where somebody *left*: two pids in, one out, and the
    // one that stayed must not commit a second time.
    const fewer = room(2);
    assert.deepEqual(lobbyAdmission(fewer, everyone(roster), "Player 1", true).commit, []);
  });

  it("finds you by the same key the chips use, not by the exact string", () => {
    // If these two disagree, the arrival plays for you as though you were
    // somebody else — a nameless "entry appended" — while your name sits in the
    // list from the first frame. That is the moment shown to everyone it does
    // not belong to, which is the bug the hold exists to fix.
    const roster = room(3);
    const got = lobbyAdmission(roster, null, " player 2 ", false);
    assert.equal(got.yours, true);
    assert.deepEqual(got.commit, [{ who: "Player 2", pid: "p2" }]);
  });
});

describe("the lobby cluster's queue", () => {
  const mood = (over: Partial<{ unseen: boolean; still: boolean; running: boolean }> = {}) => ({
    unseen: false,
    still: false,
    running: false,
    ...over,
  });
  const join = (pid: string): RaftEntry => ({ who: pid.toUpperCase(), pid });

  it("draws an arrival at once when the cluster is idle", () => {
    const plan = raftArrival([], join("p1"), mood());
    assert.deepEqual(plan.begin, join("p1"));
    assert.deepEqual(plan.release, []);
    assert.deepEqual(plan.queue, []);
  });

  it("makes an arrival wait behind the commit already on screen", () => {
    const plan = raftArrival([], join("p2"), mood({ running: true }));
    assert.equal(plan.begin, null);
    assert.deepEqual(plan.release, []);
    assert.deepEqual(plan.queue, [join("p2")]);
  });

  it("lets the oldest waiting name through when the queue is full, rather than dropping the newest", () => {
    // Dropping was fine while this only drove a picture. Now that it gates the
    // list, a dropped entry is somebody who joined and whose name never
    // arrived — so over the cap the oldest waiter gives up its animation and
    // goes straight into the list, and nothing is ever thrown away.
    const full = [join("p2"), join("p3"), join("p4")];
    assert.equal(full.length, RAFT_QUEUE_MAX);
    const plan = raftArrival(full, join("p5"), mood({ running: true }));
    assert.deepEqual(plan.release, ["p2"]);
    assert.deepEqual(plan.queue, [join("p3"), join("p4"), join("p5")]);
    assert.equal(plan.begin, null);
  });

  it("holds nobody back while nobody is watching", () => {
    // A hidden tab, or a window with no room to draw the cluster in. There is
    // no moment to wait for, so waiting only costs a person their place in the
    // list. This is the case that was missing: a commit ran its full two and a
    // half seconds behind a `display: none`, holding a name back for an
    // animation that was not being drawn.
    const arrival = raftArrival([join("p2")], join("p3"), mood({ unseen: true, running: true }));
    assert.deepEqual(arrival.release, ["p3"]);
    assert.equal(arrival.begin, null);
    const drain = raftDrain([join("p2"), join("p3")], mood({ unseen: true }));
    assert.deepEqual(drain.release, ["p2", "p3"]);
    assert.deepEqual(drain.queue, []);
    assert.equal(drain.begin, null);
  });

  it("never queues under reduced motion, and drains a queue it already had all at once", () => {
    // A queue is for keeping an animation readable, and reduced motion has no
    // animation to keep readable. The conditions are re-asked at the drain on
    // purpose: turning the preference on mid-rush used to animate the three
    // names already waiting in full, the last of them seven seconds later.
    const arrival = raftArrival([join("p2")], join("p3"), mood({ still: true, running: true }));
    assert.deepEqual(arrival.begin, join("p3"));
    const drain = raftDrain([join("p2"), join("p3"), join("p4")], mood({ still: true }));
    // Everyone arrives together, and the last of them carries the one state
    // change so that the picture still says the word once.
    assert.deepEqual(drain.release, ["p2", "p3"]);
    assert.deepEqual(drain.begin, join("p4"));
    assert.deepEqual(drain.queue, []);
  });

  it("has nothing to draw when the queue runs out, which is how the caption clears", () => {
    const plan = raftDrain([], mood());
    assert.equal(plan.begin, null);
    assert.deepEqual(plan.release, []);
  });

  /**
   * The invariant the two functions exist to hold, and the only one worth
   * calling a bug: **every pid handed in is accounted for.** Released, begun,
   * or still waiting — a pid that falls out of all three is a person who
   * joined and whose name never appeared, which is worse than any animation
   * is good.
   */
  it("accounts for every pid in a room that all scans the code at once", () => {
    const joins = room(20).map((r) => r.pid);
    const released: string[] = [];
    let queue: readonly RaftEntry[] = [];
    let running = false;
    let drawn = 0;
    const take = (plan: RaftPlan): void => {
      released.push(...plan.release);
      queue = plan.queue;
      if (plan.begin === null) return;
      running = true;
      drawn += 1;
      // What `play` does at the majority moment: the pid becomes a name in the
      // list, and the rest of the commit is only the picture catching up.
      if (plan.begin.pid !== null) released.push(plan.begin.pid);
    };
    for (const pid of joins) take(raftArrival(queue, join(pid), { ...mood(), running }));
    // Then each commit finishes in turn until nothing is waiting.
    while (running) {
      running = false;
      take(raftDrain(queue, mood()));
    }
    assert.deepEqual([...released].sort(), [...joins].sort());
    // Twenty people get four animations and sixteen names, which is the right
    // way round: the names are the promise and the picture is the decoration.
    assert.equal(drawn, 4);
  });
});

describe("a name on an arriving entry", () => {
  it("leaves a name that fits exactly as it was typed", () => {
    assert.equal(clipName("Sam"), "Sam");
    assert.equal(clipName("A".repeat(RAFT_NAME_MAX)), "A".repeat(RAFT_NAME_MAX));
  });

  it("is never longer than the cap, ellipsis included", () => {
    // The cap is what keeps the name inside a 240-unit viewBox; a name that
    // overran it crossed the leader and the links.
    const clipped = clipName("A".repeat(40));
    assert.equal([...clipped].length, RAFT_NAME_MAX);
    assert.equal(clipped.endsWith("…"), true);
  });

  it("never cuts an emoji in half", () => {
    // `slice` counts UTF-16 code units, so this cut "Sam 🎉" through the middle
    // of the emoji and rendered a lone high surrogate as a replacement
    // character — on the one screen whose job is to show a person their own
    // name back to them.
    assert.equal(clipName(`Sam${"\u{1F389}".repeat(11)}`), `Sam${"\u{1F389}".repeat(9)}…`);
    assert.match(clipName(`Sam${"\u{1F389}".repeat(11)}`), /^[^\uD800-\uDFFF]*(?:[\uD800-\uDBFF][\uDC00-\uDFFF])*…$/);
  });

  it("counts a family emoji as one character rather than four people", () => {
    // Four code points joined by ZWJ. Counting code points keeps the surrogate
    // pairs together but still splits the family, which renders as the first
    // one or two members of it and a stray joiner.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    assert.equal(clipName(`${"A".repeat(11)}${family}BC`), `${"A".repeat(11)}${family}…`);
  });
});

/* ------------------------------------------------------------------ */
/* The two lines the House says about a round's own ending             */
/* ------------------------------------------------------------------ */

describe("the tin's House slot", () => {
  const nothing = { docs: false, cracked: false, opened: false };

  it("says the docs line the frame it becomes true", () => {
    const slot = unsealSlot({ ...nothing, docs: true }, UNSEAL_NOTHING_SAID);
    assert.equal(slot.line, HOUSE.unsealDocs);
    assert.deepEqual(slot.said, { docs: true, cracked: false, opened: false });
  });

  it("says each beat once, and nothing at all on the next frame", () => {
    // `paintUnseal` runs on every frame the server sends and the letters stay
    // live underneath these lines. A repaint that re-set the slot would
    // re-announce the warning to a screen reader several times a second.
    const flags = { docs: true, cracked: true, opened: false };
    const first = unsealSlot(flags, UNSEAL_NOTHING_SAID);
    assert.equal(first.line, HOUSE.unsealCracked);
    const second = unsealSlot(flags, first.said);
    assert.equal(second.line, null);
    assert.deepEqual(second.said, first.said);
    // And on the twentieth frame, too.
    assert.equal(unsealSlot(flags, second.said).line, null);
  });

  it("gives the slot to the later beat when two land on the same frame", () => {
    // A player who read the docs, cracked the tin and then finished anyway has
    // had the first two said to them already, so the last thing the slot holds
    // is the thing that just happened.
    assert.equal(
      unsealSlot({ docs: true, cracked: true, opened: true }, UNSEAL_NOTHING_SAID).line,
      HOUSE.unsealOpened,
    );
    assert.equal(
      unsealSlot({ docs: true, cracked: true, opened: false }, UNSEAL_NOTHING_SAID).line,
      HOUSE.unsealCracked,
    );
  });

  it("marks the beats it did not say, so an earlier one cannot arrive later", () => {
    // Otherwise the frame after a tin opens says the crack line — a warning
    // about the next wrong letter, on a tin that is already open.
    const said = unsealSlot({ docs: true, cracked: true, opened: true }, UNSEAL_NOTHING_SAID).said;
    assert.deepEqual(said, { docs: true, cracked: true, opened: true });
    assert.equal(unsealSlot({ docs: true, cracked: true, opened: true }, said).line, null);
  });

  it("says the tin coming open, which the round used not to narrate at all", () => {
    // Losing a tin put a line on this screen and on the big one; getting a word
    // out put a number in a total and said nothing, which is a House that only
    // speaks when somebody loses.
    const slot = unsealSlot({ ...nothing, opened: true }, UNSEAL_NOTHING_SAID);
    assert.equal(slot.line, HOUSE.unsealOpened);
  });

  it("starts a new tin having said nothing", () => {
    // A new round resets the latch. Without that, the second tin of the
    // session opens in silence because the first one already said the line.
    assert.deepEqual(UNSEAL_NOTHING_SAID, nothing);
    assert.equal(unsealSlot({ ...nothing, opened: true }, UNSEAL_NOTHING_SAID).line, HOUSE.unsealOpened);
  });
});

describe("Tug of Raft's win line", () => {
  it("names the side whose pull count went up", () => {
    assert.equal(tugPullWinner([0, 0], [1, 0]), 0);
    assert.equal(tugPullWinner([1, 1], [1, 2]), 1);
  });

  it("says nothing about a pull that finished level", () => {
    // A level pull increments neither side. The House does not narrate a draw:
    // there is no side to name, and "nobody has the rope" is a joke about the
    // round rather than the round's own voice.
    assert.equal(tugPullWinner([1, 1], [1, 1]), null);
    assert.equal(tugPullWinner([0, 0], [0, 0]), null);
  });

  it("says nothing on the hundreds of frames that carry no change", () => {
    // This surface repaints continuously off the server's beat grid. A win line
    // read off the rope rather than off a diff would be re-announced every
    // frame, talking over the pull that had already started.
    assert.equal(tugPullWinner([2, 1], [2, 1]), null);
  });

  it("says nothing when a new round takes the counts back to zero", () => {
    // The client forgets the last round's result when the round card comes up,
    // and the server's `wins` restart too. Neither may be read as a win — least
    // of all as a win for whoever is now nominally ahead at 0–0.
    assert.equal(tugPullWinner([2, 1], [0, 0]), null);
    // And the first pull of the new round is announced normally afterwards.
    assert.equal(tugPullWinner([0, 0], [0, 1]), 1);
  });

  it("names one side when a dropped frame carries two pulls at once", () => {
    // Only one line fits in the slot, so the earlier side gets it. Worth
    // stating rather than discovering: a phone that came back from a lock
    // screen mid-round is the case, and naming somebody is better than a
    // silence that reads as a draw.
    assert.equal(tugPullWinner([0, 0], [1, 1]), 0);
  });
});
