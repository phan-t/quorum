/**
 * Round 3, Tug of Raft. Every expected number is computed by hand from
 * SPEC.md "#### Round 3 — Tug of Raft" and the "Arcade scoring summary"
 * table, and never by calling the code under test.
 *
 * The heartbeat is 100 bpm, so a beat every 600 ms and a window of ±120 ms
 * around each one. Every instant below is written as `T0 + beat × 600 + k` so
 * that the arithmetic is on the page rather than in a helper.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  Activity,
  ArcadeState,
  Effect,
  Event,
  ParticipantId,
  RejectCode,
  SessionState,
} from "./types.ts";
import { newSession, reduce } from "./reducer.ts";
import {
  beatMsFor,
  beatToleranceMs,
  closePull,
  floorMax,
  lateSide,
  loungeMax,
  loungePoints,
  pullTotals,
  resolveBeat,
  TUG_BPM,
  TUG_ELECTION_MS,
  TUG_LEADER_BONUS,
  TUG_MISSES_TO_ELECTION,
  TUG_PULL_SECONDS,
  TUG_PULL_WIN,
  TUG_PULLS,
  tugLeader,
  tugRemainingMs,
  tugSides,
} from "./arcade.ts";
import { tugOfRaftRound } from "../arcade/tug-of-raft.ts";

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
  const codes = rejects(r.effects).map((e) => e.code);
  assert.ok(codes.includes(code), `expected ${code}, got [${codes.join(", ")}]`);
}

const ARCADE: Activity = {
  id: "arcade",
  title: "Hashi Arcade",
  kind: "arcade",
  spotCap: 2,
};

const T0 = 1000;
/** 60 000 ÷ 100 bpm. */
const BEAT = 600;
/** A fifth of a beat either side. */
const WINDOW = 120;
const SEED = 7;

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

/** Pull 1 is running from T0 and closes at T0 + 25 000. */
function pulling(n = 4, seed = SEED): SessionState {
  const s = accept(
    entered(n),
    { type: "startRound", round: "tug_of_raft", config: tugOfRaftRound(seed) },
    T0 - 1,
  );
  return accept(s, { type: "beginPlay" }, T0);
}

function arcadeOf(state: SessionState): ArcadeState {
  assert.ok(state.arcade, "expected the arcade to be open");
  return state.arcade;
}

function rope(s: SessionState) {
  const play = arcadeOf(s).play;
  assert.ok(play?.kind === "tug_of_raft", "expected a Tug of Raft round");
  return play;
}

const banked = (s: SessionState, pid: ParticipantId) => arcadeOf(s).banked[pid] ?? 0;
const total = (s: SessionState, pid: ParticipantId) => arcadeOf(s).totals[pid] ?? 0;

/** The instant of beat `n`, plus an offset. */
const beat = (n: number, offset = 0) => T0 + n * BEAT + offset;

/** Tap on the given beats, dead on each one. */
function tapBeats(
  s: SessionState,
  pid: ParticipantId,
  beats: readonly number[],
): SessionState {
  for (const n of beats) {
    s = accept(s, { type: "tapBeat", pid, at: beat(n) }, beat(n) + 5);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* The defaults                                                         */
/* ------------------------------------------------------------------ */

describe("the round the host gets", () => {
  test("three pulls of 25 seconds at 100 bpm", () => {
    assert.equal(TUG_PULLS, 3);
    assert.equal(TUG_PULL_SECONDS, 25);
    assert.equal(TUG_BPM, 100);
    assert.deepEqual(tugOfRaftRound(42), {
      kind: "tug_of_raft",
      pulls: 3,
      pullSeconds: 25,
      bpm: 100,
      seed: 42,
    });
  });

  test("a beat every 600 ms, with a window of ±120", () => {
    assert.equal(beatMsFor(100), BEAT);
    assert.equal(beatToleranceMs(BEAT), WINDOW);
    // Well under half a beat: no instant is on two beats, and no instant is on
    // the beat by accident.
    assert.ok(WINDOW * 2 < BEAT);
  });

  test("the Floor max is SPEC's 45", () => {
    // Win all three pulls and lead your side every time: 3 × (10 + 5).
    assert.equal(floorMax(tugOfRaftRound(1)), 45);
    assert.equal(TUG_PULL_WIN + TUG_LEADER_BONUS, 15);
  });

  test("nobody drains, so there is no Lounge to pay", () => {
    // SPEC's table writes this as a dash, and it is deliberate: "two
    // elimination rounds back-to-back is a downer".
    assert.equal(loungeMax("tug_of_raft"), 0);
    const s = pulling(4);
    assert.equal(loungePoints(rope(s), "p1", "floor"), 0);
    for (const pid of ["p1", "p2", "p3", "p4"]) {
      assert.equal(arcadeOf(s).standing[pid], "floor");
    }
    assert.deepEqual(arcadeOf(s).lounge, {});
  });

  test("a round with no pulls, no tempo or no seed is refused", () => {
    const s = entered(2);
    for (const [config, why] of [
      [{ kind: "tug_of_raft", pulls: 0, pullSeconds: 25, bpm: 100, seed: 1 }, "no pulls"],
      [{ kind: "tug_of_raft", pulls: 3, pullSeconds: 0, bpm: 100, seed: 1 }, "no time"],
      [{ kind: "tug_of_raft", pulls: 3, pullSeconds: 25, bpm: 0, seed: 1 }, "no tempo"],
      [
        { kind: "tug_of_raft", pulls: 3, pullSeconds: 25, bpm: 100, seed: NaN },
        "no seed",
      ],
    ] as const) {
      assertRefused(
        s,
        run(s, { type: "startRound", round: "tug_of_raft", config }, T0),
        "invalid_round_config",
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* The sides                                                            */
/* ------------------------------------------------------------------ */

describe("two clusters", () => {
  test("the sides are within one of each other, however odd the roster", () => {
    for (const n of [1, 2, 3, 5, 9, 27, 60]) {
      const pids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
      const sides = tugSides(pids, 12_345);
      assert.equal(Object.keys(sides).length, n);
      const a = Object.values(sides).filter((v) => v === 0).length;
      assert.ok(Math.abs(a - (n - a)) <= 1, `${n} players split ${a} / ${n - a}`);
    }
  });

  test("the same seed deals the same sides, and a different one does not", () => {
    const pids = ["p1", "p2", "p3", "p4", "p5", "p6"];
    assert.deepEqual(tugSides(pids, 99), tugSides(pids, 99));
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
      JSON.stringify(tugSides(pids, seed)),
    );
    assert.ok(new Set(seeds).size > 1, "the seed has to actually reshuffle");
  });

  test("a latecomer gets a side rather than being told to watch", () => {
    // Deterministic, and it does not move anybody else: re-dealing mid-pull
    // would change the sides under the whole room.
    assert.equal(lateSide(SEED, "px"), lateSide(SEED, "px"));
    let s = pulling(3);
    const before = rope(s).sides;
    assert.equal(before["p9"], undefined);
    s = accept(s, { type: "join", pid: "p9", nickname: "Late" }, T0 + 1_000);
    s = accept(s, { type: "tapBeat", pid: "p9", at: beat(2) }, beat(2) + 5);
    const after = rope(s).sides;
    assert.equal(after["p9"], lateSide(SEED, "p9"));
    for (const pid of ["p1", "p2", "p3"]) {
      assert.equal(after[pid], before[pid], "nobody else moved");
    }
    assert.equal(rope(s).onBeats["p9"], 1);
  });

  test("the sides are re-dealt for every pull", () => {
    let s = pulling(6);
    const first = rope(s).sides;
    s = accept(s, { type: "nextPull", seed: 4_242 }, T0 + 25_000);
    assert.deepEqual(
      rope(s).sides,
      tugSides(["p1", "p2", "p3", "p4", "p5", "p6"], 4_242),
    );
    assert.equal(rope(s).pull, 1);
    assert.notDeepEqual(rope(s).sides, first);
  });
});

/* ------------------------------------------------------------------ */
/* The heartbeat                                                        */
/* ------------------------------------------------------------------ */

describe("the heartbeat", () => {
  test("a tap on the beat pulls, and a tap off it does nothing", () => {
    let s = pulling(2);
    // Dead on beat 1, and 119 ms late on beat 2: both inside the window.
    s = accept(s, { type: "tapBeat", pid: "p1", at: beat(1) }, beat(1) + 5);
    assert.equal(rope(s).onBeats["p1"], 1);
    s = accept(s, { type: "tapBeat", pid: "p1", at: beat(2, 119) }, beat(2, 130));
    assert.equal(rope(s).onBeats["p1"], 2);
    // 200 ms after beat 3 is a third of a beat out. Nothing happens, and
    // nothing happening costs no state.
    const r = run(s, { type: "tapBeat", pid: "p1", at: beat(3, 200) }, beat(3, 210));
    assert.equal(r.applied, false);
    assert.equal(rope(s).onBeats["p1"], 2);
  });

  test("the window is symmetrical: early counts as well as late", () => {
    let s = pulling(2);
    s = accept(s, { type: "tapBeat", pid: "p1", at: beat(2, -120) }, beat(2));
    assert.equal(rope(s).onBeats["p1"], 1);
    const r = run(s, { type: "tapBeat", pid: "p1", at: beat(3, -121) }, beat(3));
    assert.equal(r.applied, false, "121 ms early is off the beat");
  });

  test("a drum roll on one beat is one pull", () => {
    let s = pulling(2);
    s = accept(s, { type: "tapBeat", pid: "p1", at: beat(1) }, beat(1) + 5);
    const r = run(s, { type: "tapBeat", pid: "p1", at: beat(1, 30) }, beat(1) + 40);
    assert.equal(r.applied, false, "the beat has already been credited");
    assert.equal(rope(s).onBeats["p1"], 1);
  });

  test("taps outside the pull do not count", () => {
    const s = pulling(2);
    assert.equal(rope(s).pullEndsAt, T0 + 25_000);
    assertRefused(
      s,
      run(s, { type: "tapBeat", pid: "p1", at: T0 + 25_000 }, T0 + 25_010),
      "floor_locked",
    );
    assert.equal(run(s, { type: "tapBeat", pid: "p1", at: T0 - 50 }, T0).applied, false);
  });
});

/* ------------------------------------------------------------------ */
/* Elections                                                            */
/* ------------------------------------------------------------------ */

describe("heartbeat timeouts", () => {
  test("three missed beats call an election that lasts two seconds", () => {
    assert.equal(TUG_MISSES_TO_ELECTION, 3);
    assert.equal(TUG_ELECTION_MS, 2_000);
    const play = rope(pulling(2));
    // Nothing since beat 0. Beats 1, 2 and 3 are missed, so the election
    // starts at beat 3 — T0 + 1 800 — and runs to T0 + 3 800.
    const swallowed = resolveBeat(play, 0, beat(4));
    assert.equal(swallowed.inElection, true);
    assert.equal(swallowed.electionEndsAt, beat(3) + 2_000);
    // A tap after it ends is judged normally. The node rejoins at the first
    // beat after T0 + 3 800, which is beat 7 (T0 + 4 200), so beat 7 is
    // nothing like three misses away.
    const back = resolveBeat(play, 0, beat(7));
    assert.equal(back.inElection, false);
    assert.equal(back.lastBeat, 6);
  });

  test("a tap during an election achieves nothing useful", () => {
    let s = pulling(2);
    s = accept(s, { type: "tapBeat", pid: "p1", at: beat(0) }, beat(0) + 5);
    assert.equal(rope(s).onBeats["p1"], 1);
    // Beat 4 is dead on the beat, and it is inside the election that beat 3
    // called. "Elections achieve nothing."
    const r = run(s, { type: "tapBeat", pid: "p1", at: beat(4) }, beat(4) + 5);
    assert.equal(r.applied, false);
    assert.equal(rope(s).onBeats["p1"], 1);
  });

  test("a node that says nothing all pull calls election after election", () => {
    // Elections chain: each one ends, the node rejoins, and three more missed
    // beats time it out again. The loop that works this out has to terminate,
    // and this is the case that would hang it.
    const play = rope(pulling(2));
    // Nothing since before beat 0. The chain, by hand: the first election runs
    // from beat 2 (1 200) to 3 200, so the node rejoins at beat 6; the next
    // runs from beat 8 (4 800) to 6 800, rejoining at beat 12; then beats 14,
    // 20, 26, 32 and 38. A tap at beat 40 — 24 000 — falls inside the one that
    // beat 38 called, which runs to 24 800.
    const late = resolveBeat(play, -1, beat(40));
    assert.equal(late.inElection, true);
    assert.equal(late.electionEndsAt, beat(38) + TUG_ELECTION_MS);
    assert.equal(late.lastBeat, 35, "the node has rejoined and missed again six times");
    // And a tap after that one ends is judged normally again.
    const after = resolveBeat(play, -1, beat(42));
    assert.equal(after.inElection, false);
    assert.equal(after.lastBeat, 41);
    // Every beat in between is either swallowed or a rejoin, and none of them
    // throws or spins.
    for (let n = 0; n <= 41; n++) {
      const j = resolveBeat(play, -1, beat(n));
      assert.equal(j.beat, n);
    }
  });

  test("the timeout is derived, so nothing has to be written while nobody taps", () => {
    // The engine has no clock: the only way it learns time has passed is an
    // event. An election therefore cannot be *stored* when it starts, and the
    // state carries only the last beat each node hit.
    const s = pulling(2);
    assert.deepEqual(Object.keys(rope(s)).sort(), [
      "beatMs",
      "creditedAt",
      "kind",
      "lastBeat",
      "onBeats",
      "pull",
      "pullEndsAt",
      "pullSeconds",
      "pullStartedAt",
      "pulls",
      "seed",
      "sides",
      "wins",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Settling a pull                                                      */
/* ------------------------------------------------------------------ */

describe("settling a pull", () => {
  /** Four players, sides fixed by hand so the arithmetic is readable. */
  function sided(): SessionState {
    const s = pulling(4);
    const play = rope(s);
    // Whatever the seed dealt, two are on each side; the test names them.
    const a = Object.keys(play.sides).filter((pid) => play.sides[pid] === 0);
    const b = Object.keys(play.sides).filter((pid) => play.sides[pid] === 1);
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    return s;
  }

  function sideOf(s: SessionState, side: 0 | 1): ParticipantId[] {
    const play = rope(s);
    return Object.keys(play.sides)
      .filter((pid) => play.sides[pid] === side)
      .sort();
  }

  test("every member of the winning side banks 10, tapping or not", () => {
    let s = sided();
    const [a1] = sideOf(s, 0);
    const [b1] = sideOf(s, 1);
    // a1 hits four beats, b1 hits one. Their partners do nothing at all.
    s = tapBeats(s, a1!, [1, 2, 3, 4]);
    s = tapBeats(s, b1!, [1]);
    assert.deepEqual(pullTotals(rope(s)), [4, 1]);

    s = accept(s, { type: "endRound" }, T0 + 25_000);
    const [, a2] = sideOf(s, 0);
    const [, b2] = sideOf(s, 1);
    assert.equal(banked(s, a1!), 15, "10 for the win, 5 for leading the side");
    assert.equal(banked(s, a2!), 10, "a member of the winning side who never tapped");
    assert.equal(banked(s, b1!), 5, "the losing side's leader is still the leader");
    assert.equal(banked(s, b2!), 0);
    assert.equal(total(s, a1!), 15);
  });

  test("an even pull pays nobody the 10, and both leaders keep their 5", () => {
    let s = sided();
    const [a1] = sideOf(s, 0);
    const [b1] = sideOf(s, 1);
    s = tapBeats(s, a1!, [1, 2]);
    s = tapBeats(s, b1!, [1, 2]);
    assert.deepEqual(pullTotals(rope(s)), [2, 2]);
    const close = closePull(rope(s));
    assert.equal(close.winner, null);
    assert.deepEqual(close.gained, { [a1!]: 5, [b1!]: 5 });
  });

  test("a pull nobody plays pays nobody anything", () => {
    const s = sided();
    const close = closePull(rope(s));
    assert.equal(close.winner, null);
    assert.deepEqual(close.gained, {}, "there is no leader in doing nothing");
    assert.deepEqual(close.leaders, [null, null]);
  });

  test("the leader is the best count, and a tie goes to whoever got there first", () => {
    let s = sided();
    const [a1, a2] = sideOf(s, 0);
    // Both hit the same two beats, so both are on two. a1 is dead on the beat
    // and a2 is 119 ms behind it — inside the window, and second.
    s = tapBeats(s, a1!, [1, 2]);
    s = accept(s, { type: "tapBeat", pid: a2!, at: beat(1, 119) }, beat(1, 130));
    s = accept(s, { type: "tapBeat", pid: a2!, at: beat(2, 119) }, beat(2, 130));
    assert.equal(rope(s).onBeats[a1!], 2);
    assert.equal(rope(s).onBeats[a2!], 2);
    assert.equal(tugLeader(rope(s), 0), a1);
  });

  test("three pulls, banked as they go, and the last one settles at the end", () => {
    let s = pulling(2);
    const [a1] = Object.keys(rope(s).sides).filter((p) => rope(s).sides[p] === 0);
    // Pull 1: a1 taps alone and wins it, 10 + 5.
    s = tapBeats(s, a1!, [1, 2]);
    s = accept(s, { type: "nextPull", seed: 11 }, T0 + 25_000);
    assert.equal(banked(s, a1!), 15);
    assert.deepEqual(rope(s).wins, [1, 0]);
    // The clocks are re-derived from the pull that is actually open.
    assert.equal(rope(s).pullStartedAt, T0 + 25_000);
    assert.equal(arcadeOf(s).endsAt, T0 + 25_000 + 25_000 + 25_000);
    assert.equal(tugRemainingMs(rope(s), 1), 25_000);
    // Pull 2: nobody taps. Pull 3: nobody taps either.
    s = accept(s, { type: "nextPull", seed: 12 }, T0 + 50_000);
    assert.equal(banked(s, a1!), 15, "an empty pull pays nothing");
    assertRefused(
      s,
      run(s, { type: "nextPull", seed: 13 }, T0 + 60_000),
      "wrong_round_phase",
    );
    s = accept(s, { type: "endRound" }, T0 + 75_000);
    assert.equal(total(s, a1!), 15);
  });

  test("a single player is a side of one, and can still win the rope", () => {
    let s = pulling(1);
    const side = rope(s).sides["p1"];
    assert.ok(side === 0 || side === 1);
    s = tapBeats(s, "p1", [1]);
    const close = closePull(rope(s));
    assert.equal(close.winner, side);
    assert.deepEqual(close.gained, { p1: 15 });
    s = accept(s, { type: "endRound" }, T0 + 25_000);
    assert.equal(total(s, "p1"), 15);
  });

  test("an empty roster does not settle anything", () => {
    const s = pulling(0);
    assert.deepEqual(rope(s).sides, {});
    const close = closePull(rope(s));
    assert.equal(close.winner, null);
    assert.deepEqual(close.gained, {});
  });
});

/* ------------------------------------------------------------------ */
/* Refusals                                                             */
/* ------------------------------------------------------------------ */

describe("refusals", () => {
  test("tapping outside a running rope round", () => {
    const carded = accept(
      entered(2),
      { type: "startRound", round: "tug_of_raft", config: tugOfRaftRound(1) },
      T0 - 1,
    );
    assertRefused(
      carded,
      run(carded, { type: "tapBeat", pid: "p1", at: T0 }, T0),
      "wrong_round_phase",
    );
    const s = pulling(2);
    assertRefused(
      s,
      run(s, { type: "tapBeat", pid: "ghost", at: beat(1) }, beat(1)),
      "unknown_participant",
    );
    assertRefused(
      s,
      run(s, { type: "nextPrompt" }, T0 + 100),
      "wrong_round_phase",
    );
  });

  test("outside the arcade entirely, a tap is refused", () => {
    let s = newSession({
      sid: "s",
      title: "Offsite",
      joinCode: "RAFT",
      activities: [ARCADE],
    });
    s = accept(s, { type: "open" }, 10);
    s = accept(s, { type: "start" }, 20);
    s = accept(s, { type: "join", pid: "p1", nickname: "Player 1" }, 30);
    assertRefused(
      s,
      run(s, { type: "tapBeat", pid: "p1", at: T0 }, T0),
      "not_in_arcade",
    );
    assertRefused(s, run(s, { type: "nextPull", seed: 1 }, T0), "not_in_arcade");
  });

  test("the round's own events are refused outside it", () => {
    const s = entered(2);
    assertRefused(s, run(s, { type: "nextPull", seed: 1 }, T0), "wrong_round_phase");
    const rope = pulling(2);
    assertRefused(
      rope,
      run(rope, { type: "nextPull", seed: NaN }, T0 + 1_000),
      "invalid_round_config",
    );
  });
});
