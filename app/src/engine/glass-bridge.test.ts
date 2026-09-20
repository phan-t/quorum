/**
 * Round 5, The Glass Bridge. Every expected number is computed by hand from
 * SPEC.md "#### Round 5 — The Glass Bridge" and the "Arcade scoring summary"
 * table, and never by calling the code under test. Where SPEC.md is ambiguous
 * the test says which reading the engine took.
 *
 * As in arcade.test.ts, every call goes through `run`, which deep-freezes the
 * input state and checks it against a clone afterwards: the engine is pure.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  Activity,
  ArcadeState,
  Effect,
  Event,
  GlassStep,
  ParticipantId,
  RejectCode,
  SessionState,
} from "./types.ts";
import { newSession, reduce, replay } from "./reducer.ts";
import {
  bridgeRunners,
  closeGlassStep,
  fastestCrossing,
  floorMax,
  GLASS_BACKED_CROSSES,
  GLASS_BACKED_FASTEST,
  GLASS_BLIND_BONUS,
  GLASS_FAR_SIDE,
  GLASS_STEP_BANK,
  glassFloorView,
  glassMeView,
  glassRemainingMs,
  glassStepBank,
  loungeMax,
  loungePoints,
  splitBoard,
  waveCutsFor,
  waveOf,
} from "./arcade.ts";
import {
  GLASS_BRIDGE_STEPS,
  GLASS_BRIDGE_WAVE_SECONDS,
  glassBridgeRound,
} from "../arcade/glass-bridge.ts";

/* ------------------------------------------------------------------ */
/* Harness                                                              */
/* ------------------------------------------------------------------ */

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function run(state: SessionState, event: Event, now: number) {
  const snapshot = structuredClone(state);
  deepFreeze(state);
  const result = reduce(state, event, now);
  assert.deepEqual(state, snapshot, `reduce(${event.type}) mutated its input state`);
  return result;
}

function rejects(effects: readonly Effect[]) {
  return effects.filter(
    (e): e is Extract<Effect, { kind: "reject" }> => e.kind === "reject",
  );
}

function rejectCodes(effects: readonly Effect[]): RejectCode[] {
  return rejects(effects).map((e) => e.code);
}

function accept(state: SessionState, event: Event, now: number): SessionState {
  const r = run(state, event, now);
  assert.equal(r.state.seq, state.seq + 1, `expected ${event.type} to be accepted`);
  assert.ok(!rejects(r.effects).length, `expected ${event.type} not to be rejected`);
  return r.state;
}

function assertRefused(
  before: SessionState,
  r: { state: SessionState; effects: readonly Effect[] },
  code: RejectCode,
) {
  assert.deepEqual(r.state, before, "state must be unchanged");
  assert.equal(r.state.seq, before.seq, "seq must not bump");
  assert.ok(
    !r.effects.some((e) => e.kind === "persist" || e.kind === "broadcast"),
    "a refusal neither persists nor broadcasts",
  );
  const codes = rejectCodes(r.effects);
  assert.ok(codes.includes(code), `expected ${code}, got [${codes.join(", ")}]`);
}

const ARCADE: Activity = {
  id: "arcade",
  title: "Hashi Arcade",
  kind: "arcade",
  spotCap: 2,
};

const T0 = 1000;

/** `n` players, joined in order, in the arcade, numbers handed out. */
function entered(n: number): SessionState {
  let s = newSession({
    sid: "s",
    title: "Offsite",
    joinCode: "RAFT",
    activities: [ARCADE],
  });
  s = accept(s, { type: "open" }, 10);
  s = accept(s, { type: "start" }, 20);
  for (let i = 1; i <= n; i++) {
    s = accept(s, { type: "join", pid: `p${i}`, nickname: `Player ${i}` }, 100 + i);
  }
  return accept(s, { type: "enterArcade", activityId: "arcade" }, 500);
}

/** On the bridge: wave 1, step 0 open, at T0. */
function bridging(
  n = 9,
  steps: readonly GlassStep[] = GLASS_BRIDGE_STEPS,
): SessionState {
  let s = entered(n);
  s = accept(
    s,
    { type: "startRound", round: "glass_bridge", config: glassBridgeRound(steps) },
    T0 - 1,
  );
  return accept(s, { type: "beginPlay" }, T0);
}

function arcadeOf(state: SessionState): ArcadeState {
  assert.ok(state.arcade, "expected the arcade to be open");
  return state.arcade;
}

function bridge(s: SessionState) {
  const play = arcadeOf(s).play;
  assert.ok(play?.kind === "glass_bridge", "expected a Glass Bridge round");
  return play;
}

const banked = (s: SessionState, pid: ParticipantId) => arcadeOf(s).banked[pid] ?? 0;
const total = (s: SessionState, pid: ParticipantId) => arcadeOf(s).totals[pid] ?? 0;
const standing = (s: SessionState, pid: ParticipantId) => arcadeOf(s).standing[pid];

/** The real pane at `step` of the launch board. */
const realAt = (step: number) => GLASS_BRIDGE_STEPS[step]!.real;
/** The pane that breaks at `step`. */
const fakeAt = (step: number): 0 | 1 => (realAt(step) === 0 ? 1 : 0);

/** One player commits to `choice` at the open step. */
function stepOn(
  s: SessionState,
  pid: ParticipantId,
  choice: number,
  now: number,
): SessionState {
  return accept(s, { type: "stepPane", pid, step: bridge(s).step, choice }, now);
}

/** The instant the open step began. */
const stepStart = (s: SessionState) => bridge(s).stepStartedAt;

/**
 * Walk `pids` across the whole board, correctly, and stop with the last step
 * still open. `after` is how long each player takes to decide, in ms.
 */
function crossWave(
  s: SessionState,
  pids: readonly ParticipantId[],
  after: Readonly<Record<ParticipantId, number>> = {},
): SessionState {
  const secs = bridge(s).waveSeconds[bridge(s).wave - 1]!;
  const last = bridge(s).board.length - 1;
  for (let step = bridge(s).step; step <= last; step++) {
    assert.equal(bridge(s).step, step, "the wave walks one step at a time");
    for (const pid of pids) {
      s = stepOn(s, pid, realAt(step), stepStart(s) + (after[pid] ?? 500));
    }
    if (step < last) s = accept(s, { type: "nextStep" }, stepStart(s) + secs * 1000);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Content                                                              */
/* ------------------------------------------------------------------ */

describe("the launch content", () => {
  test("six steps, six products, two panes each", () => {
    assert.equal(GLASS_BRIDGE_STEPS.length, 6);
    const products = GLASS_BRIDGE_STEPS.map((s) => s.product);
    assert.deepEqual([...new Set(products)].length, 6, "one step per product");
    for (const step of GLASS_BRIDGE_STEPS) {
      assert.equal(step.panes.length, 2);
      assert.ok(step.real === 0 || step.real === 1);
      for (const pane of step.panes) {
        assert.ok(pane.label.trim().length > 0);
        assert.ok(pane.note.trim().length > 0, `${pane.label} needs a reveal note`);
        assert.ok(
          pane.label.startsWith(`${step.product} `),
          `${pane.label} is not a ${step.product} pane — SPEC pairs within a product`,
        );
      }
    }
  });

  test("the existing three reals and three fakes survive verbatim", () => {
    // SPEC.md: "the existing three real and three fake Real-or-Fake items".
    // These six strings are the team-building artifact's, character for
    // character, which is the whole point of reusing them.
    const existing: readonly [string, string][] = [
      [
        "Vault Transit Secrets Engine",
        "Encryption as a service — apps send plaintext, Vault returns ciphertext, keys never leave.",
      ],
      [
        "Consul Gossip Pool",
        "Consul agents use LAN and WAN gossip pools for membership and failure detection.",
      ],
      [
        "Boundary Host Catalog",
        "A host catalog is how Boundary groups the hosts behind a target.",
      ],
      ["Terraform Drift Guard", "Drift detection is real; this product name is not."],
      ["Packer Provisioner Mesh", "Packer has provisioners. It does not have a mesh."],
      [
        "Nomad Sentinel Scheduler",
        "Nomad has a scheduler and Sentinel is real — but not this.",
      ],
    ];
    const panes = GLASS_BRIDGE_STEPS.flatMap((s) => s.panes);
    for (const [label, note] of existing) {
      const pane = panes.find((p) => p.label === label);
      assert.ok(pane, `${label} is missing from the board`);
      assert.equal(pane.note, note, `${label}'s note was rewritten`);
    }
  });

  test("the three existing reals are real and the three existing fakes are fake", () => {
    const realLabels = GLASS_BRIDGE_STEPS.map((s) => s.panes[s.real].label);
    for (const label of [
      "Vault Transit Secrets Engine",
      "Consul Gossip Pool",
      "Boundary Host Catalog",
    ]) {
      assert.ok(realLabels.includes(label), `${label} must be the real pane`);
    }
    for (const label of [
      "Terraform Drift Guard",
      "Packer Provisioner Mesh",
      "Nomad Sentinel Scheduler",
    ]) {
      assert.ok(!realLabels.includes(label), `${label} must be the fake pane`);
    }
  });

  test("the real pane is not always on the same side", () => {
    // A player who notices that the answer is always the left pane has not
    // played the round.
    const sides = new Set(GLASS_BRIDGE_STEPS.map((s) => s.real));
    assert.equal(sides.size, 2, "both sides must be used");
  });

  test("twelve items, not nine: the pairing reading", () => {
    // SPEC.md says "made up to six pairs with three additions", which cannot
    // be reconciled with "re-paired within a product" — within-product pairing
    // needs a real and a fake for each of six products, so twelve items and
    // therefore six additions. The engine took the within-product reading,
    // which is the constraint with a reason behind it.
    assert.equal(GLASS_BRIDGE_STEPS.flatMap((s) => s.panes).length, 12);
    const labels = GLASS_BRIDGE_STEPS.flatMap((s) => s.panes.map((p) => p.label));
    assert.equal(new Set(labels).size, 12, "no label appears twice");
  });

  test("12 / 9 / 6 seconds a step, which is SPEC's 3.5 minute round", () => {
    assert.deepEqual([...GLASS_BRIDGE_WAVE_SECONDS], [12, 9, 6]);
    const floorSeconds =
      GLASS_BRIDGE_STEPS.length *
      GLASS_BRIDGE_WAVE_SECONDS.reduce((a, b) => a + b, 0);
    assert.equal(floorSeconds, 162);
    // Plus the 20 s round card and the 20 s reveal that the round table says
    // the timings include: 202 s, inside 3.5 minutes.
    assert.ok(floorSeconds + 40 <= 3.5 * 60);
  });

  test("splitBoard leaves no answer in the half that is shown", () => {
    const { board, key } = splitBoard(GLASS_BRIDGE_STEPS);
    assert.equal(board.length, 6);
    assert.equal(key.length, 6);
    const shown = JSON.stringify(board);
    for (const step of GLASS_BRIDGE_STEPS) {
      for (const pane of step.panes) {
        assert.ok(shown.includes(pane.label), "both labels are shown");
        assert.ok(!shown.includes(pane.note), `${pane.label}'s note escaped`);
      }
    }
    assert.ok(!shown.includes('"real"'), "the board carries no real index");
    assert.deepEqual(
      key.map((k) => k.real),
      GLASS_BRIDGE_STEPS.map((s) => s.real),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Waves                                                                */
/* ------------------------------------------------------------------ */

describe("wave assignment", () => {
  /** Wave sizes for a roster numbered 1..n. */
  function sizes(n: number): [number, number, number] {
    const cuts = waveCutsFor(Array.from({ length: n }, (_, i) => i + 1));
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 1; i <= n; i++) {
      const w = waveOf(i, cuts);
      if (w === 1) out[0] += 1;
      else if (w === 2) out[1] += 1;
      else out[2] += 1;
    }
    return out;
  }

  test("contiguous thirds by player number, earlier waves take the remainder", () => {
    // Hand-computed from floor(i × 3 / n).
    assert.deepEqual(sizes(3), [1, 1, 1]);
    assert.deepEqual(sizes(6), [2, 2, 2]);
    assert.deepEqual(sizes(9), [3, 3, 3]);
    assert.deepEqual(sizes(30), [10, 10, 10]);
  });

  test("awkward roster sizes", () => {
    assert.deepEqual(sizes(1), [1, 0, 0], "one player crosses alone, in wave 1");
    assert.deepEqual(sizes(2), [1, 1, 0], "wave 3 is empty, which is allowed");
    assert.deepEqual(sizes(4), [2, 1, 1]);
    assert.deepEqual(sizes(5), [2, 2, 1]);
    assert.deepEqual(sizes(7), [3, 2, 2]);
    assert.deepEqual(sizes(11), [4, 4, 3]);
  });

  test("an empty roster puts everyone who turns up later in wave 3", () => {
    const cuts = waveCutsFor([]);
    assert.deepEqual([...cuts], [0, 0]);
    assert.equal(waveOf(1, cuts), 3);
  });

  test("the waves are contiguous: no number is in an earlier wave than a lower one", () => {
    for (let n = 1; n <= 40; n++) {
      const cuts = waveCutsFor(Array.from({ length: n }, (_, i) => i + 1));
      let last = 0;
      for (let i = 1; i <= n; i++) {
        const w = waveOf(i, cuts);
        assert.ok(w >= last, `player ${i} of ${n} went backwards`);
        last = w;
      }
    }
  });

  test("a number nobody has been given yet is wave 3", () => {
    const cuts = waveCutsFor([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual([...cuts], [3, 6]);
    assert.equal(waveOf(undefined, cuts), 3, "a latecomer joins the last wave");
    assert.equal(waveOf(10, cuts), 3);
  });

  test("the round fixes the cuts at startRound, from the roster in the room", () => {
    const s = bridging(9);
    assert.deepEqual([...bridge(s).waveCuts], [3, 6]);
    assert.equal(waveOf(arcadeOf(s).playerNumbers["p1"], bridge(s).waveCuts), 1);
    assert.equal(waveOf(arcadeOf(s).playerNumbers["p4"], bridge(s).waveCuts), 2);
    assert.equal(waveOf(arcadeOf(s).playerNumbers["p9"], bridge(s).waveCuts), 3);
  });
});

/* ------------------------------------------------------------------ */
/* Clocks                                                               */
/* ------------------------------------------------------------------ */

describe("clocks", () => {
  test("the round's clocks start at beginPlay, not at the round card", () => {
    let s = entered(9);
    s = accept(
      s,
      { type: "startRound", round: "glass_bridge", config: glassBridgeRound() },
      T0 - 1,
    );
    const carded = bridge(s);
    assert.equal(carded.stepEndsAt, 0, "nobody is playing against the card");
    assert.equal(carded.waveStartedAt, 0);
    assert.equal(arcadeOf(s).endsAt, null);

    s = accept(s, { type: "beginPlay" }, T0);
    const play = bridge(s);
    assert.equal(play.wave, 1);
    assert.equal(play.step, 0);
    assert.equal(play.waveStartedAt, T0);
    assert.equal(play.stepStartedAt, T0);
    assert.equal(play.stepEndsAt, T0 + 12_000, "wave 1 gets twelve seconds");
  });

  test("the step has its own clock, which is not the round's", () => {
    const s = bridging();
    // 6 × 12 + 6 × 9 + 6 × 6 = 162 s of Floor.
    assert.equal(arcadeOf(s).endsAt, T0 + 162_000);
    assert.notEqual(bridge(s).stepEndsAt, arcadeOf(s).endsAt);
  });

  test("each step re-derives the round's end, so lag does not eat the last one", () => {
    let s = bridging();
    // The timer that opens step 2 fires 300 ms late, as timers do.
    s = accept(s, { type: "nextStep" }, T0 + 12_300);
    const play = bridge(s);
    assert.equal(play.step, 1);
    assert.equal(play.stepStartedAt, T0 + 12_300);
    assert.equal(play.stepEndsAt, T0 + 12_300 + 12_000);
    // 4 steps of wave 1 left after this one, then waves 2 and 3 whole.
    assert.equal(
      arcadeOf(s).endsAt,
      T0 + 12_300 + 12_000 + 4 * 12_000 + 6 * 9_000 + 6 * 6_000,
    );
  });

  test("a wave starts its own clock", () => {
    let s = crossWave(bridging(), ["p1", "p2", "p3"]);
    s = accept(s, { type: "nextWave" }, T0 + 100_000);
    const play = bridge(s);
    assert.equal(play.wave, 2);
    assert.equal(play.step, 0);
    assert.equal(play.waveStartedAt, T0 + 100_000);
    assert.equal(play.stepEndsAt, T0 + 100_000 + 9_000, "wave 2 gets nine seconds");
    assert.equal(
      arcadeOf(s).endsAt,
      T0 + 100_000 + 9_000 + 5 * 9_000 + 6 * 6_000,
    );
  });

  test("glassRemainingMs counts this wave's remainder and every later wave", () => {
    const play = bridge(bridging());
    // After the open step of wave 1: 5 more wave-1 steps, then 6 + 6.
    assert.equal(glassRemainingMs(play, 1, 0), 5 * 12_000 + 6 * 9_000 + 6 * 6_000);
    assert.equal(glassRemainingMs(play, 3, 5), 0, "the last step of the last wave");
    assert.equal(glassRemainingMs(play, 2, 0), 5 * 9_000 + 6 * 6_000);
  });
});

/* ------------------------------------------------------------------ */
/* Crossing, and what it banks                                          */
/* ------------------------------------------------------------------ */

describe("the Floor", () => {
  test("one step on the real pane banks 5, and 8 in wave 1", () => {
    assert.equal(GLASS_STEP_BANK, 5);
    assert.equal(GLASS_BLIND_BONUS, 3);
    assert.equal(glassStepBank(1), 8);
    assert.equal(glassStepBank(2), 5);
    assert.equal(glassStepBank(3), 5);

    let s = bridging();
    s = stepOn(s, "p1", realAt(0), T0 + 500);
    assert.equal(banked(s, "p1"), 8, "wave 1: 5 for the step, 3 for going blind");
    assert.equal(bridge(s).position["p1"], 1);
    assert.equal(standing(s, "p1"), "floor");
  });

  test("a wave 1 crossing is 63, which is SPEC's Floor max", () => {
    // 6 steps × (5 + 3) + 15 for the far side = 30 + 18 + 15 = 63.
    const s = crossWave(bridging(), ["p1"]);
    assert.equal(banked(s, "p1"), 63);
    assert.equal(bridge(s).position["p1"], 6);
    assert.deepEqual([...bridge(s).crossOrder], ["p1"]);
    assert.equal(floorMax(glassBridgeRound()), 63);
  });

  test("a later wave's crossing is 45: the blind bonus is what wave 1 is paid", () => {
    let s = crossWave(bridging(), ["p1"]);
    s = accept(s, { type: "nextWave" }, T0 + 100_000);
    s = crossWave(s, ["p4"]);
    // 6 × 5 + 15 = 45.
    assert.equal(banked(s, "p4"), 45);
    assert.equal(banked(s, "p1") - banked(s, "p4"), 6 * GLASS_BLIND_BONUS);
  });

  test("the wrong pane drains you and keeps everything banked", () => {
    let s = bridging();
    s = stepOn(s, "p1", realAt(0), T0 + 500);
    s = accept(s, { type: "nextStep" }, T0 + 12_000);
    s = stepOn(s, "p1", realAt(1), T0 + 12_500);
    assert.equal(banked(s, "p1"), 16, "two blind steps");
    s = accept(s, { type: "nextStep" }, T0 + 24_000);
    s = stepOn(s, "p1", fakeAt(2), T0 + 24_500);
    assert.equal(standing(s, "p1"), "drained");
    assert.equal(banked(s, "p1"), 16, "banked is banked");
    assert.equal(bridge(s).position["p1"], 2, "they do not advance onto a fake");
    assert.ok("p1" in arcadeOf(s).lounge, "and the Lounge opens");
  });

  test("the far side is worth 15 and is paid once", () => {
    assert.equal(GLASS_FAR_SIDE, 15);
    let s = crossWave(bridging(), ["p1"]);
    const before = banked(s, "p1");
    // A stray frame from a player already across is not a fall and not a
    // second payment.
    const r = run(s, { type: "stepPane", pid: "p1", step: 5, choice: 0 }, stepStart(s) + 600);
    assert.equal(r.state.seq, s.seq, "a no-op, not an event");
    assert.equal(banked(r.state, "p1"), before);
    s = r.state;
    assert.equal(standing(s, "p1"), "floor");
  });

  test("failing to step drains you when the step closes", () => {
    let s = bridging();
    s = stepOn(s, "p1", realAt(0), T0 + 500);
    // p2 and p3 freeze. p4..p9 are not in wave 1 and are not on the bridge.
    s = accept(s, { type: "nextStep" }, T0 + 12_000);
    assert.equal(standing(s, "p1"), "floor");
    assert.equal(standing(s, "p2"), "drained");
    assert.equal(standing(s, "p3"), "drained");
    assert.equal(standing(s, "p4"), "floor", "wave 2 is still waiting its turn");
    assert.equal(banked(s, "p2"), 0);
  });

  test("bridgeRunners is only the wave on the bridge, minus whoever is across", () => {
    let s = bridging();
    assert.deepEqual([...bridgeRunners(s, arcadeOf(s), bridge(s))], ["p1", "p2", "p3"]);
    s = crossWave(s, ["p1"]);
    // p2 and p3 were drained at the first close; p1 is across.
    assert.deepEqual([...bridgeRunners(s, arcadeOf(s), bridge(s))], []);
  });

  test("a whole wave crosses together and the next one follows", () => {
    let s = crossWave(bridging(), ["p1", "p2", "p3"]);
    assert.deepEqual([...bridge(s).crossOrder], ["p1", "p2", "p3"]);
    s = accept(s, { type: "nextWave" }, T0 + 80_000);
    assert.equal(bridge(s).wave, 2);
    assert.equal(bridge(s).step, 0);
    assert.deepEqual(bridge(s).stepped, {}, "the new wave has committed nothing");
    assert.equal(standing(s, "p1"), "floor", "the crossers are not drained");
  });
});

/* ------------------------------------------------------------------ */
/* The leak                                                             */
/* ------------------------------------------------------------------ */

describe("what a player may know, and when", () => {
  test("a pane that has just broken is not published to the wave standing on it", () => {
    let s = bridging();
    // p1 falls at step 0, eleven and a half seconds before p2 and p3 have to
    // choose. If that reached them the round would be over.
    s = stepOn(s, "p1", fakeAt(0), T0 + 500);
    assert.equal(standing(s, "p1"), "drained");
    assert.equal(bridge(s).broken[0], null, "nothing is published mid-step");
    assert.equal(glassFloorView(bridge(s)).broken[0], null);
    assert.deepEqual(
      [...bridge(s).broken],
      [null, null, null, null, null, null],
      "and nothing anywhere else either",
    );
  });

  test("it is published when the step closes, and then it is the answer", () => {
    let s = bridging();
    s = stepOn(s, "p1", fakeAt(0), T0 + 500);
    s = stepOn(s, "p2", realAt(0), T0 + 600);
    s = accept(s, { type: "nextStep" }, T0 + 12_000);
    assert.equal(bridge(s).broken[0], fakeAt(0));
    assert.equal(bridge(s).broken[1], null, "only the step that closed");
  });

  test("a step nobody fell at stays unknown, which is wave 2's problem", () => {
    let s = bridging();
    s = stepOn(s, "p1", realAt(0), T0 + 500);
    s = stepOn(s, "p2", realAt(0), T0 + 600);
    s = stepOn(s, "p3", realAt(0), T0 + 700);
    s = accept(s, { type: "nextStep" }, T0 + 12_000);
    assert.equal(
      bridge(s).broken[0],
      null,
      "a pane that held is never published — only a pane that broke",
    );
  });

  test("the published breaks are exactly the steps an earlier wave has closed", () => {
    // The round's whole secrecy rule, asserted at every instant of a full
    // three-wave round: `broken[j]` is non-null only for a step that the
    // active wave has already left, or that an earlier wave closed.
    // Eighteen players, six per wave, so one can fall at every step of every
    // wave and there is always something that could leak.
    let s = bridging(18);
    const seen: number[] = [];
    const check = (st: SessionState) => {
      const play = bridge(st);
      for (let j = 0; j < play.board.length; j++) {
        if (play.broken[j] === null) continue;
        assert.ok(
          j < play.step || seen.includes(j),
          `step ${j + 1} was published while wave ${play.wave} was on step ${play.step + 1}`,
        );
      }
    };

    for (let w = 0; w < 3; w++) {
      const wave = Array.from({ length: 6 }, (_, i) => `p${w * 6 + i + 1}`);
      const secs = bridge(s).waveSeconds[bridge(s).wave - 1]!;
      for (let step = 0; step < 6; step++) {
        // The step-th member steps on the fake; everyone behind them survives.
        s = stepOn(s, wave[step]!, fakeAt(step), stepStart(s) + 100);
        check(s);
        for (let i = step + 1; i < 6; i++) {
          s = stepOn(s, wave[i]!, realAt(step), stepStart(s) + 200 + i);
        }
        check(s);
        if (step < 5) {
          s = accept(s, { type: "nextStep" }, stepStart(s) + secs * 1000);
          seen.push(step);
          check(s);
        }
      }
      if (bridge(s).wave < 3) {
        s = accept(s, { type: "nextWave" }, stepStart(s) + secs * 1000);
        seen.push(5);
        check(s);
      }
    }
    s = accept(s, { type: "endRound" }, stepStart(s) + 6_000);
    assert.deepEqual(
      [...bridge(s).broken],
      [0, 1, 2, 3, 4, 5].map(fakeAt),
      "by the end every step has been paid for by somebody",
    );
  });

  test("the public view carries no answer at all", () => {
    let s = bridging();
    s = stepOn(s, "p1", realAt(0), T0 + 500);
    const view = glassFloorView(bridge(s));
    assert.ok(!("key" in view), "the key is not in the public view");
    const json = JSON.stringify(view);
    for (const step of GLASS_BRIDGE_STEPS) {
      for (const pane of step.panes) {
        assert.ok(!json.includes(pane.note), `${pane.label}'s note is in the view`);
      }
    }
    assert.ok(!json.includes('"real"'));
  });

  test("no projection can say which pane anybody chose, because nothing records it", () => {
    let s = bridging();
    s = stepOn(s, "p1", realAt(0), T0 + 500);
    s = stepOn(s, "p2", fakeAt(0), T0 + 600);
    // The entire play state, key aside, contains no pane index attributable
    // to a player: `stepped` is held-or-broke, and that is as far as it goes.
    const play = bridge(s);
    assert.deepEqual(play.stepped, { p1: true, p2: false });
    assert.equal(play.position["p1"], 1);
    assert.equal(play.position["p2"], undefined);
    const view = glassFloorView(play);
    assert.ok(!("stepped" in view), "even held-or-broke stays off the big screen");
  });

  test("a fallen player's own view tells them about themselves and nobody else", () => {
    let s = bridging();
    s = stepOn(s, "p2", fakeAt(0), T0 + 600);
    const me = glassMeView(arcadeOf(s), bridge(s), "p2");
    assert.deepEqual(me, {
      wave: 1,
      onTheBridge: false,
      step: 0,
      committed: true,
      held: false,
      across: false,
    });
    const waiting = glassMeView(arcadeOf(s), bridge(s), "p7");
    assert.equal(waiting.wave, 3);
    assert.equal(waiting.onTheBridge, false, "wave 3 is watching");
    assert.equal(waiting.committed, false);
    assert.equal(waiting.held, null);
  });
});

/* ------------------------------------------------------------------ */
/* Refusals                                                             */
/* ------------------------------------------------------------------ */

describe("refusals", () => {
  test("stepping before the arcade is open", () => {
    let s = newSession({
      sid: "s",
      title: "Offsite",
      joinCode: "RAFT",
      activities: [ARCADE],
    });
    s = accept(s, { type: "open" }, 10);
    s = accept(s, { type: "start" }, 20);
    s = accept(s, { type: "join", pid: "p1", nickname: "One" }, 30);
    assertRefused(
      s,
      run(s, { type: "stepPane", pid: "p1", step: 0, choice: 0 }, 40),
      "not_in_arcade",
    );
    assertRefused(s, run(s, { type: "nextStep" }, 40), "not_in_arcade");
    assertRefused(s, run(s, { type: "nextWave" }, 40), "not_in_arcade");
  });

  test("stepping in a round that is not a bridge", () => {
    const s = entered(3);
    assertRefused(
      s,
      run(s, { type: "stepPane", pid: "p1", step: 0, choice: 0 }, T0),
      "wrong_round_phase",
    );
    assertRefused(s, run(s, { type: "nextStep" }, T0), "wrong_round_phase");
    assertRefused(s, run(s, { type: "nextWave" }, T0), "wrong_round_phase");
  });

  test("stepping while the round card is still up", () => {
    let s = entered(9);
    s = accept(
      s,
      { type: "startRound", round: "glass_bridge", config: glassBridgeRound() },
      T0 - 1,
    );
    assertRefused(
      s,
      run(s, { type: "stepPane", pid: "p1", step: 0, choice: 0 }, T0),
      "wrong_round_phase",
    );
  });

  test("a participant nobody has heard of", () => {
    const s = bridging();
    assertRefused(
      s,
      run(s, { type: "stepPane", pid: "nope", step: 0, choice: 0 }, T0 + 500),
      "unknown_participant",
    );
  });

  test("stepping after you have been drained", () => {
    let s = bridging();
    s = stepOn(s, "p1", fakeAt(0), T0 + 500);
    s = accept(s, { type: "nextStep" }, T0 + 12_000);
    assertRefused(
      s,
      run(s, { type: "stepPane", pid: "p1", step: 1, choice: realAt(1) }, T0 + 12_500),
      "not_on_the_floor",
    );
  });

  test("stepping out of your wave, in both directions", () => {
    let s = bridging();
    assertRefused(
      s,
      run(s, { type: "stepPane", pid: "p7", step: 0, choice: 0 }, T0 + 500),
      "not_your_wave",
    );
    s = crossWave(s, ["p1", "p2", "p3"]);
    s = accept(s, { type: "nextWave" }, T0 + 80_000);
    assertRefused(
      s,
      run(s, { type: "stepPane", pid: "p1", step: 0, choice: 0 }, T0 + 80_500),
      "not_your_wave",
    );
  });

  test("stepping after the step has closed", () => {
    const s = bridging();
    assertRefused(
      s,
      run(s, { type: "stepPane", pid: "p1", step: 0, choice: 0 }, T0 + 12_000),
      "floor_locked",
    );
  });

  test("a frame that arrived a step late", () => {
    let s = bridging();
    s = stepOn(s, "p1", realAt(0), T0 + 500);
    s = accept(s, { type: "nextStep" }, T0 + 12_000);
    assertRefused(
      s,
      run(s, { type: "stepPane", pid: "p1", step: 0, choice: realAt(0) }, T0 + 12_500),
      "wrong_step",
    );
  });

  test("two panes in one step", () => {
    let s = bridging();
    s = stepOn(s, "p1", realAt(0), T0 + 500);
    assertRefused(
      s,
      run(s, { type: "stepPane", pid: "p1", step: 0, choice: fakeAt(0) }, T0 + 600),
      "already_stepped",
    );
  });

  test("a pane that is not one of the two", () => {
    const s = bridging();
    for (const choice of [2, -1, 1.5, NaN]) {
      assertRefused(
        s,
        run(s, { type: "stepPane", pid: "p1", step: 0, choice }, T0 + 500),
        "invalid_choice",
      );
    }
  });

  test("advancing past the last step, and past the last wave", () => {
    let s = crossWave(bridging(), ["p1", "p2", "p3"]);
    assertRefused(s, run(s, { type: "nextStep" }, T0 + 80_000), "wrong_round_phase");
    s = accept(s, { type: "nextWave" }, T0 + 80_000);
    s = crossWave(s, ["p4", "p5", "p6"]);
    s = accept(s, { type: "nextWave" }, T0 + 160_000);
    s = crossWave(s, ["p7", "p8", "p9"]);
    assertRefused(s, run(s, { type: "nextWave" }, T0 + 200_000), "wrong_round_phase");
  });

  test("a bridge with no steps, or a step with a pane that does not exist", () => {
    const s = entered(3);
    assertRefused(
      s,
      run(
        s,
        {
          type: "startRound",
          round: "glass_bridge",
          config: { kind: "glass_bridge", steps: [], waveSeconds: [12, 9, 6] },
        },
        T0,
      ),
      "invalid_round_config",
    );
    const bad = [
      {
        product: "Vault",
        panes: [
          { label: "A", note: "n" },
          { label: "B", note: "n" },
        ],
        real: 2,
      },
    ] as unknown as readonly GlassStep[];
    assertRefused(
      s,
      run(
        s,
        {
          type: "startRound",
          round: "glass_bridge",
          config: { kind: "glass_bridge", steps: bad, waveSeconds: [12, 9, 6] },
        },
        T0,
      ),
      "invalid_round_config",
    );
  });

  test("a wave timer of zero", () => {
    const s = entered(3);
    assertRefused(
      s,
      run(
        s,
        {
          type: "startRound",
          round: "glass_bridge",
          config: {
            kind: "glass_bridge",
            steps: GLASS_BRIDGE_STEPS,
            waveSeconds: [12, 0, 6],
          },
        },
        T0,
      ),
      "invalid_round_config",
    );
  });

  test("a bridge config handed to another round, and vice versa", () => {
    const s = entered(3);
    assertRefused(
      s,
      run(
        s,
        { type: "startRound", round: "plan_apply", config: glassBridgeRound() },
        T0,
      ),
      "invalid_round_config",
    );
    assertRefused(
      s,
      run(
        s,
        {
          type: "startRound",
          round: "glass_bridge",
          config: { kind: "plan_apply", target: 120, seconds: 75 },
        },
        T0,
      ),
      "invalid_round_config",
    );
  });

  test("the three rounds that are still not built", () => {
    const s = entered(3);
    for (const round of ["unseal", "tug_of_raft", "gganbu"] as const) {
      assertRefused(
        s,
        run(s, { type: "startRound", round, config: glassBridgeRound() }, T0),
        "round_not_built",
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* The Lounge                                                           */
/* ------------------------------------------------------------------ */

describe("the Lounge", () => {
  /** p1 falls at the first step; wave 1's survivors cross. */
  function drained(): SessionState {
    let s = bridging(9);
    s = stepOn(s, "p1", fakeAt(0), T0 + 500);
    return s;
  }

  test("a drained player backs a later wave", () => {
    let s = drained();
    s = accept(s, { type: "backPlayer", pid: "p1", backing: "p7" }, T0 + 1_000);
    assert.equal(arcadeOf(s).lounge["p1"]?.backing, "p7");
  });

  test("backing someone in the wave that is on the bridge is refused", () => {
    // SPEC: "Drained players back someone in a later wave." Without this, a
    // backer waits for a wave 1 crosser — who is still on the Floor, never
    // having been drained — and collects the 10 as a certainty.
    const s = drained();
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p1", backing: "p2" }, T0 + 1_000),
      "must_back_a_later_wave",
    );
  });

  test("backing a wave that has already crossed is refused", () => {
    let s = crossWave(drained(), ["p2", "p3"]);
    s = accept(s, { type: "nextWave" }, T0 + 80_000);
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p1", backing: "p2" }, T0 + 80_500),
      "must_back_a_later_wave",
    );
  });

  test("the bet stands once your runner is on the bridge", () => {
    let s = drained();
    s = accept(s, { type: "backPlayer", pid: "p1", backing: "p4" }, T0 + 1_000);
    // Freely changeable while p4 is still waiting.
    s = accept(s, { type: "backPlayer", pid: "p1", backing: "p5" }, T0 + 2_000);
    s = crossWave(s, ["p2", "p3"]);
    s = accept(s, { type: "nextWave" }, T0 + 80_000);
    // Now wave 2 is crossing and p1 cannot move to a wave 3 runner after
    // watching p5 fall.
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p1", backing: "p7" }, T0 + 80_500),
      "backing_locked",
    );
  });

  test("the old refusals still apply", () => {
    const s = drained();
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p1", backing: "p1" }, T0 + 1_000),
      "cannot_back_yourself",
    );
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p2", backing: "p7" }, T0 + 1_000),
      "not_in_the_lounge",
    );
    let t = stepOn(s, "p2", fakeAt(0), T0 + 600);
    assertRefused(
      t,
      run(t, { type: "backPlayer", pid: "p1", backing: "p2" }, T0 + 1_000),
      "cannot_back_a_drained_player",
    );
  });

  test("backing a runner who crosses pays 10", () => {
    assert.equal(GLASS_BACKED_CROSSES, 10);
    let s = drained();
    s = accept(s, { type: "backPlayer", pid: "p1", backing: "p8" }, T0 + 1_000);
    s = crossWave(s, ["p2", "p3"]);
    s = accept(s, { type: "nextWave" }, T0 + 80_000);
    s = crossWave(s, ["p4"]);
    s = accept(s, { type: "nextWave" }, T0 + 160_000);
    // p7 is quicker than p8, so p8 crosses but is not the fastest.
    s = crossWave(s, ["p7", "p8"], { p7: 200, p8: 3_000 });
    s = accept(s, { type: "endRound" }, T0 + 200_000);
    assert.equal(fastestCrossing(bridge(s)), "p7");
    // p1 banked 0 on the Floor — they fell at the first step — so the round
    // is the Lounge award alone.
    assert.equal(banked(s, "p1"), GLASS_BACKED_CROSSES);
  });

  test("backing the fastest full crossing pays 15, and not 25", () => {
    assert.equal(GLASS_BACKED_FASTEST, 15);
    let s = drained();
    s = accept(s, { type: "backPlayer", pid: "p1", backing: "p7" }, T0 + 1_000);
    s = crossWave(s, ["p2", "p3"], { p2: 5_000, p3: 5_000 });
    s = accept(s, { type: "nextWave" }, T0 + 80_000);
    s = crossWave(s, ["p4"], { p4: 4_000 });
    s = accept(s, { type: "nextWave" }, T0 + 160_000);
    s = crossWave(s, ["p7", "p8"], { p7: 100, p8: 3_000 });
    s = accept(s, { type: "endRound" }, T0 + 200_000);
    assert.equal(fastestCrossing(bridge(s)), "p7");
    assert.equal(
      banked(s, "p1"),
      GLASS_BACKED_FASTEST,
      "the better of the two, never their sum — 15, not 10 + 15",
    );
  });

  test("a decisive wave 1 runner can hold the fastest crossing against wave 3", () => {
    // Which is the point of measuring decision time rather than wall-clock or
    // elapsed-since-your-wave-started: either of those would hand this award
    // to the same wave every single time.
    let s = bridging(9);
    s = crossWave(s, ["p1"], { p1: 300 });
    s = accept(s, { type: "nextWave" }, T0 + 80_000);
    s = crossWave(s, ["p4"], { p4: 2_000 });
    s = accept(s, { type: "nextWave" }, T0 + 160_000);
    s = crossWave(s, ["p7"], { p7: 1_000 });
    assert.equal(bridge(s).elapsedMs["p1"], 6 * 300);
    assert.equal(bridge(s).elapsedMs["p7"], 6 * 1_000);
    assert.equal(fastestCrossing(bridge(s)), "p1");
  });

  test("a tie on decision time goes to whoever got across first", () => {
    let s = bridging(9);
    s = crossWave(s, ["p1", "p2"], { p1: 400, p2: 400 });
    assert.deepEqual([...bridge(s).crossOrder], ["p1", "p2"]);
    assert.equal(bridge(s).elapsedMs["p1"], bridge(s).elapsedMs["p2"]);
    assert.equal(fastestCrossing(bridge(s)), "p1");
  });

  test("backing a runner who falls pays nothing", () => {
    let s = drained();
    s = accept(s, { type: "backPlayer", pid: "p1", backing: "p7" }, T0 + 1_000);
    s = crossWave(s, ["p2", "p3"]);
    s = accept(s, { type: "nextWave" }, T0 + 80_000);
    s = crossWave(s, ["p4", "p5", "p6"]);
    s = accept(s, { type: "nextWave" }, T0 + 160_000);
    s = stepOn(s, "p7", fakeAt(0), T0 + 160_500);
    s = accept(s, { type: "endRound" }, T0 + 170_000);
    assert.equal(banked(s, "p1"), 0);
  });

  test("a backer with nobody left to back scores nothing, and that is the shape", () => {
    // Drained during wave 3 there is no later wave to back, so the Lounge
    // cannot pay. SPEC's rule is what produces this, not a special case.
    let s = bridging(9);
    s = crossWave(s, ["p1", "p2", "p3"]);
    s = accept(s, { type: "nextWave" }, T0 + 80_000);
    s = crossWave(s, ["p4", "p5", "p6"]);
    s = accept(s, { type: "nextWave" }, T0 + 160_000);
    s = stepOn(s, "p7", fakeAt(0), T0 + 160_500);
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p7", backing: "p8" }, T0 + 161_000),
      "must_back_a_later_wave",
    );
  });

  test("loungePoints pays the better of the two and never their sum", () => {
    let s = bridging(9);
    s = crossWave(s, ["p1", "p2"], { p1: 100, p2: 900 });
    const play = bridge(s);
    assert.equal(loungePoints(play, "p1", "floor"), GLASS_BACKED_FASTEST);
    assert.equal(loungePoints(play, "p2", "floor"), GLASS_BACKED_CROSSES);
    assert.equal(loungePoints(play, "p3", "drained"), 0);
    assert.equal(loungePoints(play, "p9", "floor"), 0, "never left the near side");
    assert.notEqual(
      loungePoints(play, "p1", "floor"),
      GLASS_BACKED_CROSSES + GLASS_BACKED_FASTEST,
    );
  });
});

/* ------------------------------------------------------------------ */
/* The scoring table, and the tuning rule                               */
/* ------------------------------------------------------------------ */

describe("SPEC's arcade scoring summary", () => {
  test("Floor max 63, Lounge max 15", () => {
    assert.equal(floorMax(glassBridgeRound()), 63);
    assert.equal(loungeMax("glass_bridge"), 15);
  });

  test("crossing the bridge always beats a perfect Lounge", () => {
    // SPEC's tuning target, checked rather than asserted in a comment.
    //
    // The worst crossing there is: a wave 2 or wave 3 player, who gets no
    // blind bonus, banks 6 × 5 + 15 = 45. A perfect Lounge round is the
    // better of 10 and 15, which is 15. 45 > 15, with 30 to spare, and the
    // best crossing — wave 1, 63 — beats it by 48.
    const worstCrossing =
      GLASS_BRIDGE_STEPS.length * GLASS_STEP_BANK + GLASS_FAR_SIDE;
    assert.equal(worstCrossing, 45);
    assert.equal(floorMax(glassBridgeRound()), 63);
    assert.equal(loungeMax("glass_bridge"), 15);
    assert.ok(worstCrossing > loungeMax("glass_bridge"));
    assert.ok(floorMax(glassBridgeRound()) > loungeMax("glass_bridge"));
    // And a perfect Lounge is always worth having.
    assert.ok(loungeMax("glass_bridge") > 0);
  });

  test("the Lounge cannot lift a drained player past a crossing in their own wave", () => {
    // The Plan / Apply failure this rule was written for: there, a player
    // drained at 90 resources who backed the winner tied the Floor winner. The
    // worst case here is a wave 1 player drained on the very last step — five
    // blind steps, 40 — plus a perfect Lounge, 15: 55, still short of the 63
    // a wave 1 crossing pays.
    const drainedOnTheLastStep = 5 * glassStepBank(1);
    assert.equal(drainedOnTheLastStep, 40);
    assert.ok(drainedOnTheLastStep + loungeMax("glass_bridge") < 63);
  });

  test("end to end: three waves, hand-computed totals", () => {
    let s = bridging(9);
    // Wave 1: p1 crosses, p2 falls at step 2 (one blind step banked), p3
    // freezes at step 0 and is drained by the close.
    s = stepOn(s, "p1", realAt(0), T0 + 500);
    s = stepOn(s, "p2", realAt(0), T0 + 600);
    s = accept(s, { type: "nextStep" }, T0 + 12_000);
    s = stepOn(s, "p1", realAt(1), T0 + 12_500);
    s = stepOn(s, "p2", fakeAt(1), T0 + 12_600);
    assert.equal(standing(s, "p3"), "drained");
    s = accept(s, { type: "backPlayer", pid: "p2", backing: "p7" }, T0 + 13_000);
    s = accept(s, { type: "backPlayer", pid: "p3", backing: "p4" }, T0 + 13_000);
    for (let step = 2; step <= 5; step++) {
      s = accept(s, { type: "nextStep" }, stepStart(s) + 12_000);
      s = stepOn(s, "p1", realAt(step), stepStart(s) + 500);
    }
    assert.equal(banked(s, "p1"), 63);
    assert.equal(banked(s, "p2"), 8, "one blind step");
    assert.equal(banked(s, "p3"), 0);

    // Wave 2: p4 falls at step 0, p5 and p6 cross.
    s = accept(s, { type: "nextWave" }, stepStart(s) + 12_000);
    s = stepOn(s, "p4", fakeAt(0), stepStart(s) + 500);
    s = crossWave(s, ["p5", "p6"], { p5: 800, p6: 800 });
    assert.equal(banked(s, "p5"), 45);
    assert.equal(banked(s, "p6"), 45);

    // Wave 3: p7 crosses fastest of all, p8 and p9 freeze.
    s = accept(s, { type: "nextWave" }, stepStart(s) + 9_000);
    s = crossWave(s, ["p7"], { p7: 100 });
    s = accept(s, { type: "endRound" }, stepStart(s) + 6_000);

    assert.equal(standing(s, "p8"), "drained", "the round's end closes the last step");
    assert.equal(standing(s, "p9"), "drained");
    assert.equal(fastestCrossing(bridge(s)), "p7", "600 ms of deciding");

    // Floor.
    assert.equal(banked(s, "p1"), 63);
    assert.equal(banked(s, "p5"), 45);
    assert.equal(banked(s, "p7"), 45);
    // Lounge: p2 backed p7, who made the fastest crossing — 8 + 15. p3 backed
    // p4, who fell — 0 + 0. p4 never backed anybody.
    assert.equal(banked(s, "p2"), 8 + 15);
    assert.equal(banked(s, "p3"), 0);
    assert.equal(banked(s, "p4"), 0);

    // And the round folds into the arcade raw, which reaches `scores` at the
    // reveal and not before.
    assert.equal(total(s, "p1"), 63);
    assert.equal(total(s, "p2"), 23);
    assert.equal(state_score(s, "p1"), undefined);
    s = accept(s, { type: "revealRound" }, T0 + 300_000);
    assert.deepEqual(state_score(s, "p1"), { raw: 63, status: "played" });
    assert.deepEqual(state_score(s, "p3"), { raw: 0, status: "played" });
  });
});

function state_score(s: SessionState, pid: ParticipantId) {
  return s.scores["arcade"]?.[pid];
}

/* ------------------------------------------------------------------ */
/* Purity                                                               */
/* ------------------------------------------------------------------ */

describe("the engine stays pure", () => {
  test("the same log replays to the same state", () => {
    const events: { event: Event; at: number }[] = [
      { event: { type: "open" }, at: 10 },
      { event: { type: "start" }, at: 20 },
      { event: { type: "join", pid: "p1", nickname: "One" }, at: 30 },
      { event: { type: "join", pid: "p2", nickname: "Two" }, at: 31 },
      { event: { type: "join", pid: "p3", nickname: "Three" }, at: 32 },
      { event: { type: "enterArcade", activityId: "arcade" }, at: 40 },
      {
        event: {
          type: "startRound",
          round: "glass_bridge",
          config: glassBridgeRound(),
        },
        at: 50,
      },
      { event: { type: "beginPlay" }, at: T0 },
      {
        event: { type: "stepPane", pid: "p1", step: 0, choice: realAt(0) },
        at: T0 + 400,
      },
      { event: { type: "nextStep" }, at: T0 + 12_000 },
      { event: { type: "backPlayer", pid: "p2", backing: "p3" }, at: T0 + 12_500 },
      { event: { type: "endRound" }, at: T0 + 20_000 },
      { event: { type: "revealRound" }, at: T0 + 21_000 },
    ];
    const base = newSession({
      sid: "s",
      title: "Offsite",
      joinCode: "RAFT",
      activities: [ARCADE],
    });
    assert.deepEqual(replay(base, events), replay(base, events));
  });

  test("closeGlassStep does not mutate what it is handed", () => {
    let s = bridging(9);
    s = stepOn(s, "p1", fakeAt(0), T0 + 500);
    const arcade = deepFreeze(structuredClone(arcadeOf(s)));
    const play = arcade.play;
    assert.ok(play?.kind === "glass_bridge");
    const close = closeGlassStep(s, arcade, play, T0 + 12_000);
    assert.deepEqual([...close.drained].sort(), ["p2", "p3"]);
    assert.equal(close.broken[0], fakeAt(0));
    assert.equal(play.broken[0], null, "the input is untouched");
  });
});
