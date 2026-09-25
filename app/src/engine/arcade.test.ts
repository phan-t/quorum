/**
 * Arcade tests. Every expected number is computed by hand from SPEC.md
 * "Hashi Arcade" — the round texts and the "Arcade scoring summary" table —
 * and never by calling the code under test. Where SPEC.md is ambiguous the
 * test says which reading the engine took.
 *
 * As in reducer.test.ts, every call goes through `run`, which deep-freezes the
 * input state and checks it against a clone afterwards: the engine is pure.
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
import { newSession, reduce, replay } from "./reducer.ts";
import { computeStandings } from "./scoring.ts";
import {
  checkpointBank,
  checkpointsFor,
  finishBonus,
  floorMax,
  foldAnswer,
  formatPlayerNumber,
  loungeMax,
  matchesItem,
  PLAN_APPLY_BACKED_CROSSES,
  PLAN_APPLY_BACKED_WINS,
  PLAN_APPLY_CHECKPOINT_BANK,
  PLAN_APPLY_CROSS,
  RECRUITMENT_CORRECT,
  RECRUITMENT_FIRST_BONUS,
} from "./arcade.ts";
import {
  RECRUITMENT_ITEMS,
  RECRUITMENT_SECONDS_PER_ITEM,
  recruitmentRound,
} from "../arcade/recruitment.ts";
import { unsealRound } from "../arcade/unseal.ts";
import { tugOfRaftRound } from "../arcade/tug-of-raft.ts";
import { gganbuRound } from "../arcade/gganbu.ts";
import { glassBridgeRound } from "../arcade/glass-bridge.ts";

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

function run(state: SessionState, event: Event, now = 1000) {
  const snapshot = structuredClone(state);
  deepFreeze(state);
  const result = reduce(state, event, now);
  assert.deepEqual(state, snapshot, `reduce(${event.type}) mutated its input state`);
  return result;
}

function rejects(effects: readonly Effect[]) {
  return effects.filter((e): e is Extract<Effect, { kind: "reject" }> => e.kind === "reject");
}

function rejectCodes(effects: readonly Effect[]): RejectCode[] {
  return rejects(effects).map((e) => e.code);
}

function accept(state: SessionState, events: readonly Event[], now = 1000): SessionState {
  return events.reduce((s, e) => {
    const r = run(s, e, now);
    assert.equal(r.state.seq, s.seq + 1, `expected ${e.type} to be accepted`);
    assert.ok(!rejects(r.effects).length, `expected ${e.type} not to be rejected`);
    return r.state;
  }, state);
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

/** A running session with `pids` joined, in that order. */
function lobby(pids: readonly ParticipantId[]): SessionState {
  const base = accept(
    newSession({ sid: "s", title: "Offsite", joinCode: "RAFT", activities: [ARCADE] }),
    [{ type: "open" }, { type: "start" }],
  );
  return pids.reduce(
    (s, pid, i) => accept(s, [{ type: "join", pid, nickname: `Player ${pid}` }], 100 + i),
    base,
  );
}

/** …and in the arcade, numbers handed out. */
function entered(pids: readonly ParticipantId[]): SessionState {
  return accept(lobby(pids), [{ type: "enterArcade", activityId: "arcade" }]);
}

function arcadeOf(state: SessionState): ArcadeState {
  assert.ok(state.arcade, "expected the arcade to be open");
  return state.arcade;
}

/** Recruitment, on the Floor, item 0 open. Round starts at t = 1000. */
const T0 = 1000;
function recruiting(pids: readonly ParticipantId[], items = RECRUITMENT_ITEMS): SessionState {
  return accept(
    entered(pids),
    [
      { type: "startRound", round: "recruitment", config: recruitmentRound(items) },
      { type: "beginPlay" },
    ],
    T0,
  );
}

/** Plan / Apply, on the Floor, light green. Round starts at t = 1000. */
function planning(pids: readonly ParticipantId[], target = 120, seconds = 75): SessionState {
  return accept(
    entered(pids),
    [
      { type: "startRound", round: "plan_apply", config: { kind: "plan_apply", target, seconds } },
      { type: "beginPlay" },
    ],
    T0,
  );
}

/** n taps by one player, all at instant `at`. */
function taps(state: SessionState, pid: ParticipantId, n: number, at = T0 + 1000): SessionState {
  let s = state;
  for (let i = 0; i < n; i++) s = accept(s, [{ type: "tap", pid, at }], at);
  return s;
}

function recruitmentPlay(s: SessionState) {
  const play = arcadeOf(s).play;
  assert.ok(play?.kind === "recruitment", "expected a recruitment round");
  return play;
}

function planPlay(s: SessionState) {
  const play = arcadeOf(s).play;
  assert.ok(play?.kind === "plan_apply", "expected a Plan / Apply round");
  return play;
}

const banked = (s: SessionState, pid: ParticipantId) => arcadeOf(s).banked[pid] ?? 0;
const total = (s: SessionState, pid: ParticipantId) => arcadeOf(s).totals[pid] ?? 0;

/* ------------------------------------------------------------------ */
/* The frame                                                            */
/* ------------------------------------------------------------------ */

describe("player numbers", () => {
  test("three digits, roster order, zero-padded", () => {
    const s = entered(["p1", "p2", "p3"]);
    assert.deepEqual(arcadeOf(s).playerNumbers, { p1: 1, p2: 2, p3: 3 });
    assert.equal(formatPlayerNumber(1), "001");
    assert.equal(formatPlayerNumber(17), "017");
    assert.equal(formatPlayerNumber(120), "120");
  });

  test("kicked and released people leave no hole in the grid", () => {
    // p2 joined second and is gone by the time the arcade opens, so the grid
    // runs 001, 002 over the two people actually in the room.
    const s = accept(lobby(["p1", "p2", "p3"]), [
      { type: "kick", pid: "p2" },
      { type: "enterArcade", activityId: "arcade" },
    ]);
    assert.deepEqual(arcadeOf(s).playerNumbers, { p1: 1, p3: 2 });
  });

  test("assigned once: a latecomer is appended and nobody is renumbered", () => {
    let s = entered(["p1", "p2"]);
    s = accept(s, [{ type: "join", pid: "p9", nickname: "Late" }], 500);
    s = accept(s, [{ type: "enterArcade", activityId: "arcade" }]);
    assert.deepEqual(arcadeOf(s).playerNumbers, { p1: 1, p2: 2, p9: 3 });
    // And re-entering with nobody new is a no-op, not a renumbering.
    const again = run(s, { type: "enterArcade", activityId: "arcade" });
    assert.equal(again.applied, false);
    assert.deepEqual(again.state, s);
  });

  test("enterArcade needs a real activity and a running session", () => {
    const s = lobby(["p1"]);
    assertRefused(s, run(s, { type: "enterArcade", activityId: "nope" }), "unknown_activity");

    const draft = newSession({ sid: "s", title: "T", joinCode: "RAFT", activities: [ARCADE] });
    const open = accept(draft, [{ type: "open" }]);
    assertRefused(open, run(open, { type: "enterArcade", activityId: "arcade" }), "wrong_phase");
  });

  /**
   * `state.arcade` is one slot, not a map keyed by activity.
   *
   * This is the behaviour behind the rule that a session may configure at most
   * one `arcade` activity — `src/activities/import.ts` refuses a second one,
   * and this test is what that rule is protecting against. A second arcade
   * activity cannot be entered at all once the first has been, and the refusal
   * talks about the phase, which is not a sentence anybody can act on with a
   * room waiting. If the engine ever grows a slot per activity, this test
   * fails and that rule should be revisited rather than kept out of habit.
   */
  test("a second arcade activity can never be entered — the slot is single", () => {
    const second: Activity = { id: "arcade-2", title: "Arcade II", kind: "arcade", spotCap: 2 };
    const base = accept(
      newSession({ sid: "s", title: "Offsite", joinCode: "RAFT", activities: [ARCADE, second] }),
      [{ type: "open" }, { type: "start" }, { type: "join", pid: "p1", nickname: "Player one" }],
    );
    const s = accept(base, [{ type: "enterArcade", activityId: "arcade" }]);
    assert.equal(arcadeOf(s).activityId, "arcade");
    assertRefused(s, run(s, { type: "enterArcade", activityId: "arcade-2" }), "wrong_phase");
  });

  test("every arcade event before enterArcade is not_in_arcade", () => {
    const s = lobby(["p1", "p2"]);
    const events: Event[] = [
      { type: "startRound", round: "recruitment", config: recruitmentRound() },
      { type: "beginPlay" },
      { type: "submitAnswer", pid: "p1", answer: "vault" },
      { type: "nextItem" },
      { type: "setLight", light: "apply", until: 5000 },
      { type: "tap", pid: "p1", at: 2000 },
      { type: "backPlayer", pid: "p1", backing: "p2" },
      { type: "endRound" },
      { type: "revealRound" },
    ];
    for (const e of events) assertRefused(s, run(s, e), "not_in_arcade");
  });
});

describe("the round frame", () => {
  test("a round card puts everyone on the Floor and banks nothing", () => {
    const s = accept(entered(["p1", "p2"]), [
      { type: "startRound", round: "recruitment", config: recruitmentRound() },
    ]);
    const a = arcadeOf(s);
    assert.equal(a.phase, "card");
    assert.equal(a.roundIndex, 0);
    assert.deepEqual(a.standing, { p1: "floor", p2: "floor" });
    assert.deepEqual(a.banked, {});
    // The clock does not start until the card comes down.
    assert.equal(a.startedAt, null);
    assert.equal(a.endsAt, null);
  });

  test("beginPlay starts the clock; the round index counts from 0", () => {
    let s = recruiting(["p1"], RECRUITMENT_ITEMS.slice(0, 2));
    const a = arcadeOf(s);
    assert.equal(a.phase, "running");
    assert.equal(a.startedAt, T0);
    assert.equal(a.endsAt, T0 + 2 * RECRUITMENT_SECONDS_PER_ITEM * 1000);

    s = accept(s, [{ type: "endRound" }, { type: "revealRound" }], T0 + 50_000);
    s = accept(
      s,
      [{ type: "startRound", round: "plan_apply", config: { kind: "plan_apply", target: 120, seconds: 75 } }],
      T0 + 60_000,
    );
    assert.equal(arcadeOf(s).roundIndex, 1);
  });

  test("a config for the wrong round, and a round nobody can play, are refused", () => {
    const s = entered(["p1"]);
    assertRefused(
      s,
      run(s, { type: "startRound", round: "unseal", config: recruitmentRound() }),
      // All six rounds are built, so this is no longer "that round does not
      // exist yet" — it is the one mistake left at this door, which is naming
      // one round and passing another's configuration.
      "invalid_round_config",
    );
    assertRefused(
      s,
      run(s, {
        type: "startRound",
        round: "plan_apply",
        config: recruitmentRound(),
      }),
      "invalid_round_config",
    );
    assertRefused(
      s,
      run(s, { type: "startRound", round: "recruitment", config: recruitmentRound([]) }),
      "wrong_phase",
    );
    assertRefused(
      s,
      run(s, {
        type: "startRound",
        round: "plan_apply",
        config: { kind: "plan_apply", target: 0, seconds: 75 },
      }),
      "wrong_phase",
    );
  });

  test("a second round cannot start while one is in play", () => {
    const s = recruiting(["p1"]);
    assertRefused(
      s,
      run(s, { type: "startRound", round: "recruitment", config: recruitmentRound() }),
      "wrong_round_phase",
    );
    assertRefused(s, run(s, { type: "beginPlay" }), "wrong_round_phase");
  });

  test("reveal follows the end of the round, never replaces it", () => {
    const s = recruiting(["p1"]);
    assertRefused(s, run(s, { type: "revealRound" }, T0), "wrong_round_phase");
    const ended = accept(s, [{ type: "endRound" }], T0 + 1000);
    assertRefused(ended, run(ended, { type: "endRound" }, T0 + 2000), "wrong_round_phase");
    const revealed = accept(ended, [{ type: "revealRound" }], T0 + 2000);
    assert.equal(arcadeOf(revealed).phase, "reveal");
    assertRefused(revealed, run(revealed, { type: "revealRound" }, T0 + 3000), "wrong_round_phase");
  });
});

/* ------------------------------------------------------------------ */
/* Round 0 — Recruitment                                                */
/* ------------------------------------------------------------------ */

describe("recruitment answers", () => {
  test("folding is lowercase, letters only", () => {
    assert.equal(foldAnswer("  Terra-Form! "), "terraform");
    assert.equal(foldAnswer("VAULT"), "vault");
    assert.equal(foldAnswer("!!!"), "");
  });

  const item = (answer: string) => {
    const found = RECRUITMENT_ITEMS.find((i) => i.answer === answer);
    assert.ok(found, `no item for ${answer}`);
    return found;
  };

  test("the accept list takes tf for Terraform and nothing else", () => {
    const terraform = item("Terraform");
    for (const typed of ["Terraform", "terraform", " TERRA FORM ", "tf", "TF!"]) {
      assert.ok(matchesItem(terraform, typed), `${typed} should be Terraform`);
    }
    for (const typed of ["terrafrom", "terra", "", "   "]) {
      assert.ok(!matchesItem(terraform, typed), `${typed} should not be Terraform`);
    }
    // The accept list is per item: `tf` is not an answer to any other cue.
    assert.ok(!matchesItem(item("Vault"), "tf"));
    assert.ok(!matchesItem(item("Nomad"), "tf"));
  });
});

describe("recruitment scoring", () => {
  test("10 for correct, +5 for each of the first three in the room, per item", () => {
    let s = recruiting(["p1", "p2", "p3", "p4", "p5"]);
    const say = (pid: ParticipantId, answer: string, at: number) =>
      accept(s, [{ type: "submitAnswer", pid, answer }], at);

    s = say("p1", "Vault", T0 + 1000);
    s = say("p2", "vault", T0 + 2000);
    s = say("p3", "VAULT!", T0 + 3000);
    s = say("p4", "vault", T0 + 4000);
    s = say("p5", "consul", T0 + 5000);

    assert.equal(banked(s, "p1"), 15);
    assert.equal(banked(s, "p2"), 15);
    assert.equal(banked(s, "p3"), 15);
    // Fourth correct: the 10 without the bonus.
    assert.equal(banked(s, "p4"), 10);
    // Wrong: nothing, and no entry at all.
    assert.equal(arcadeOf(s).banked["p5"], undefined);
    assert.deepEqual(recruitmentPlay(s), {
      kind: "recruitment",
      items: RECRUITMENT_ITEMS,
      at: 0,
      secondsPerItem: RECRUITMENT_SECONDS_PER_ITEM,
      itemEndsAt: T0 + RECRUITMENT_SECONDS_PER_ITEM * 1000,
      solvedOrder: ["p1", "p2", "p3", "p4"],
      answered: { p1: true, p2: true, p3: true, p4: true, p5: false },
    });
  });

  test("the first three are a fresh three on every item", () => {
    let s = recruiting(["p1", "p2"]);
    s = accept(s, [{ type: "submitAnswer", pid: "p1", answer: "Vault" }], T0 + 1000);
    s = accept(s, [{ type: "nextItem" }], T0 + 20_000);
    assert.deepEqual(arcadeOf(s).play, {
      kind: "recruitment",
      items: RECRUITMENT_ITEMS,
      at: 1,
      secondsPerItem: RECRUITMENT_SECONDS_PER_ITEM,
      itemEndsAt: T0 + 20_000 + RECRUITMENT_SECONDS_PER_ITEM * 1000,
      solvedOrder: [],
      answered: {},
    });
    // p2 was not first on item 0; they are first on item 1, and get the bonus.
    s = accept(s, [{ type: "submitAnswer", pid: "p2", answer: "tf" }], T0 + 21_000);
    assert.equal(banked(s, "p2"), 15);
  });

  test("a perfect Floor is 6 × 15 = 90, and that is SPEC's Floor max", () => {
    let s = recruiting(["p1"]);
    let at = T0;
    for (const [i, entry] of RECRUITMENT_ITEMS.entries()) {
      s = accept(s, [{ type: "submitAnswer", pid: "p1", answer: entry.answer }], at + 1000);
      if (i < RECRUITMENT_ITEMS.length - 1) {
        at += RECRUITMENT_SECONDS_PER_ITEM * 1000;
        s = accept(s, [{ type: "nextItem" }], at);
      }
    }
    assert.equal(banked(s, "p1"), 90);
    assert.equal(floorMax(recruitmentRound()), 90);
    assert.equal(
      floorMax(recruitmentRound()),
      RECRUITMENT_ITEMS.length * (RECRUITMENT_CORRECT + RECRUITMENT_FIRST_BONUS),
    );
  });

  test("an answer after the item's timer scores nothing", () => {
    // SPEC: "every correct answer *within the timer* scores 10". The boundary
    // closes the item on its own clock; a submission that loses that race is
    // recorded as an attempt and paid nothing.
    const s = accept(
      recruiting(["p1"]),
      [{ type: "submitAnswer", pid: "p1", answer: "Vault" }],
      T0 + RECRUITMENT_SECONDS_PER_ITEM * 1000 + 1,
    );
    assert.equal(arcadeOf(s).banked["p1"], undefined);
    assert.deepEqual(recruitmentPlay(s).answered, { p1: false });
  });

  test("one answer per item, and none before the card comes down", () => {
    const carded = accept(entered(["p1"]), [
      { type: "startRound", round: "recruitment", config: recruitmentRound() },
    ]);
    assertRefused(
      carded,
      run(carded, { type: "submitAnswer", pid: "p1", answer: "Vault" }),
      "wrong_round_phase",
    );

    const s = accept(recruiting(["p1"]), [
      { type: "submitAnswer", pid: "p1", answer: "Vault" },
    ]);
    assertRefused(
      s,
      run(s, { type: "submitAnswer", pid: "p1", answer: "Nomad" }),
      "already_answered_item",
    );
  });

  test("nextItem stops at the last item, and is not a Plan / Apply command", () => {
    const short = accept(recruiting(["p1"], RECRUITMENT_ITEMS.slice(0, 1)), []);
    assertRefused(short, run(short, { type: "nextItem" }, T0), "wrong_round_phase");
    const plan = planning(["p1"]);
    assertRefused(plan, run(plan, { type: "nextItem" }, T0), "wrong_round_phase");
  });

  test("Recruitment does not drain, so there is no Lounge to back from", () => {
    const s = recruiting(["p1", "p2"]);
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p1", backing: "p2" }, T0 + 1000),
      "not_in_the_lounge",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Round 1 — Plan / Apply                                               */
/* ------------------------------------------------------------------ */

describe("plan / apply arithmetic", () => {
  test("checkpoints are the quarter marks, which for 120 are SPEC's 30/60/90", () => {
    assert.deepEqual(checkpointsFor(120), [30, 60, 90]);
    assert.deepEqual(checkpointsFor(100), [25, 50, 75]);
    assert.deepEqual(checkpointsFor(60), [15, 30, 45]);
    // Nothing on or past the finish line, and never the same mark twice.
    assert.deepEqual(checkpointsFor(4), [1, 2, 3]);
    assert.deepEqual(checkpointsFor(2), [1]);
    assert.deepEqual(checkpointsFor(0), []);
  });

  test("a checkpoint banks 5 as it is passed, once", () => {
    const cps = checkpointsFor(120);
    assert.equal(checkpointBank(0, 29, cps), 0);
    assert.equal(checkpointBank(29, 30, cps), 5);
    assert.equal(checkpointBank(30, 31, cps), 0);
    assert.equal(checkpointBank(0, 120, cps), 15);
  });

  test("first three across are +15 / +10 / +5 and nothing after", () => {
    assert.equal(finishBonus(0), 15);
    assert.equal(finishBonus(1), 10);
    assert.equal(finishBonus(2), 5);
    assert.equal(finishBonus(3), 0);
  });
});

describe("plan / apply on the Floor", () => {
  test("crossing first banks 15 + 10 + 15 = 40, SPEC's Floor max", () => {
    let s = planning(["p1", "p2", "p3", "p4"]);
    s = taps(s, "p1", 120, T0 + 1000);
    s = taps(s, "p2", 120, T0 + 2000);
    s = taps(s, "p3", 120, T0 + 3000);
    s = taps(s, "p4", 120, T0 + 4000);

    assert.equal(banked(s, "p1"), 40); // 15 + 10 + 15
    assert.equal(banked(s, "p2"), 35); // 15 + 10 + 10
    assert.equal(banked(s, "p3"), 30); // 15 + 10 + 5
    assert.equal(banked(s, "p4"), 25); // 15 + 10, and no bonus left
    assert.equal(floorMax({ kind: "plan_apply", target: 120, seconds: 75 }), 40);
    assert.deepEqual(planPlay(s).finishOrder, ["p1", "p2", "p3", "p4"]);
  });

  test("checkpoints bank as they go: 89 resources is 10, 90 is 15", () => {
    let s = planning(["p1"]);
    s = taps(s, "p1", 89);
    assert.equal(banked(s, "p1"), 10);
    s = taps(s, "p1", 1);
    assert.equal(banked(s, "p1"), 15);
  });

  test("a tap during APPLY drains, and banked points survive it", () => {
    let s = planning(["p1", "p2"]);
    s = taps(s, "p1", 60, T0 + 1000);
    assert.equal(banked(s, "p1"), 10);

    s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 8000 }], T0 + 5000);
    s = accept(s, [{ type: "tap", pid: "p1", at: T0 + 6000 }], T0 + 6000);

    assert.equal(arcadeOf(s).standing["p1"], "drained");
    assert.deepEqual(arcadeOf(s).lounge["p1"], {
      backing: null,
      at: T0 + 6000,
      placedAt: null,
      placedFrom: "drained",
    });
    // "Getting caught at 75% keeps what you banked at 50%."
    assert.equal(banked(s, "p1"), 10);
    // And the drain does not move anybody else.
    assert.equal(arcadeOf(s).standing["p2"], "floor");
  });

  test("a drained player cannot tap, and a crossed player cannot be drained", () => {
    let s = planning(["p1", "p2"], 3);
    s = taps(s, "p2", 3, T0 + 500); // across the line
    s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 9000 }], T0 + 1000);
    s = accept(s, [{ type: "tap", pid: "p1", at: T0 + 2000 }], T0 + 2000);
    assertRefused(
      s,
      run(s, { type: "tap", pid: "p1", at: T0 + 3000 }, T0 + 3000),
      "not_on_the_floor",
    );
    // p2 is already home. A stray tap on a pink screen is not a drain.
    const stray = run(s, { type: "tap", pid: "p2", at: T0 + 3000 }, T0 + 3000);
    assert.equal(stray.applied, false);
    assert.equal(arcadeOf(stray.state).standing["p2"], "floor");
  });

  test("the grace is the boundary's: a tap instant before the lock still counts", () => {
    // SPEC's 250 ms grace is applied to the instant at the socket boundary.
    // The engine only asks whether the corrected instant is before or after
    // the light turned — deriving it from `now` here would put network time
    // back into the game.
    let s = planning(["p1"]);
    s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 9000 }], T0 + 5000);
    s = accept(s, [{ type: "tap", pid: "p1", at: T0 + 4999 }], T0 + 5200);
    assert.equal(arcadeOf(s).standing["p1"], "floor");
    assert.deepEqual(planPlay(s).resources, { p1: 1 });
    // One millisecond later — after the turn — and it is a drain.
    const late = accept(s, [{ type: "tap", pid: "p1", at: T0 + 5000 }], T0 + 5200);
    assert.equal(arcadeOf(late).standing["p1"], "drained");
  });

  test("re-scheduling the same light does not move the instant taps are judged against", () => {
    let s = planning(["p1"]);
    s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 4000 }], T0 + 2000);
    s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 6000 }], T0 + 4000);
    assert.equal(planPlay(s).lightChangedAt, T0 + 2000);
    // Which means a tap at 3000 — inside the same APPLY — still drains.
    const r = accept(s, [{ type: "tap", pid: "p1", at: T0 + 3000 }], T0 + 4100);
    assert.equal(arcadeOf(r).standing["p1"], "drained");
  });

  test("taps after the Floor closes are refused, not scored", () => {
    const s = planning(["p1"], 120, 75);
    const endsAt = arcadeOf(s).endsAt;
    assert.equal(endsAt, T0 + 75_000);
    assertRefused(
      s,
      run(s, { type: "tap", pid: "p1", at: T0 + 75_000 }, T0 + 75_000),
      "floor_locked",
    );
  });

  test("an ordinary tap neither broadcasts nor persists; a milestone does both", () => {
    // Sixty phones at ten taps a second is six hundred events a second. The
    // runtime broadcasts the round at 10 Hz on its own; what the engine has to
    // announce is a number changing.
    let s = planning(["p1"]);
    const plain = run(s, { type: "tap", pid: "p1", at: T0 + 100 }, T0 + 100);
    assert.equal(plain.applied, true);
    assert.deepEqual(plain.effects, []);

    s = taps(s, "p1", 29);
    const milestone = run(s, { type: "tap", pid: "p1", at: T0 + 200 }, T0 + 200);
    assert.ok(milestone.effects.some((e) => e.kind === "persist"));
    assert.ok(milestone.effects.some((e) => e.kind === "broadcast"));
  });

  test("a tap is judged against the light at its own instant, not the light now", () => {
    // SPEC: "During APPLY (pink), any tap is … drained." A 400 ms round trip
    // taps 1.9 s into the lock, the phone plainly pink, and the frame lands
    // after the light has gone back to green. The instant is what counts.
    let s = planning(["p1", "p2"]);
    s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 5_000 }], T0 + 3_000);
    s = accept(s, [{ type: "setLight", light: "plan", until: T0 + 11_000 }], T0 + 5_000);
    assert.equal(planPlay(s).light, "plan");
    assert.equal(planPlay(s).applySince, T0 + 3_000, "the lock that just closed");

    const late = accept(s, [{ type: "tap", pid: "p1", at: T0 + 4_900 }], T0 + 5_100);
    assert.equal(arcadeOf(late).standing["p1"], "drained");

    // The other direction is untouched: a tap inside the PLAN *before* that
    // lock, and one inside the PLAN after it, both bank a resource.
    const early = accept(s, [{ type: "tap", pid: "p2", at: T0 + 2_900 }], T0 + 5_100);
    assert.equal(arcadeOf(early).standing["p2"], "floor");
    assert.equal(planPlay(early).resources["p2"], 1);
    const after = accept(s, [{ type: "tap", pid: "p2", at: T0 + 5_050 }], T0 + 5_100);
    assert.equal(arcadeOf(after).standing["p2"], "floor");
    assert.equal(planPlay(after).resources["p2"], 1);
  });

  test("before the first lock there is no window for a tap to fall in", () => {
    // `beginPlay` sets PLAN with `lightChangedAt` at the top of the round, so
    // "earlier than the current light" must not be read as "in the APPLY
    // before it" — there was not one.
    const s = planning(["p1"]);
    assert.equal(planPlay(s).applySince, null);
    const before = accept(s, [{ type: "tap", pid: "p1", at: T0 - 500 }], T0 + 100);
    assert.equal(arcadeOf(before).standing["p1"], "floor");
    assert.equal(planPlay(before).resources["p1"], 1);
  });

  test("a milestone is addressed, not shouted: the tapper, the console, and the screen only on a crossing", () => {
    // Sixty phones do not render anybody else's resource count, so a
    // checkpoint that fans out to the room is fifty-nine frames that change
    // nothing. Measured in bots/arcade-round.test.ts; here is the rule.
    const audiences = (effects: readonly Effect[]) =>
      effects
        .filter((e): e is Extract<Effect, { kind: "broadcast" }> => e.kind === "broadcast")
        .map((e) => (typeof e.to === "string" ? e.to : `pid:${e.to.pid}`))
        .sort();

    let s = planning(["p1", "p2"], 30);
    s = taps(s, "p1", 7); // the quarter marks of 30 are 8, 15, 23
    const checkpoint = run(s, { type: "tap", pid: "p1", at: T0 + 200 }, T0 + 200);
    assert.equal(arcadeOf(checkpoint.state).banked["p1"], PLAN_APPLY_CHECKPOINT_BANK);
    assert.deepEqual(audiences(checkpoint.effects), ["host", "pid:p1"]);

    s = taps(s, "p1", 22); // 8 + 22 = 30 − 1: one short of the line
    const crossing = run(s, { type: "tap", pid: "p1", at: T0 + 300 }, T0 + 300);
    assert.deepEqual(planPlay(crossing.state).finishOrder, ["p1"]);
    assert.deepEqual(audiences(crossing.effects), ["host", "pid:p1", "screen"]);

    // A drain still is room-wide: the dormitory grid moves for everybody.
    const locked = accept(s, [{ type: "setLight", light: "apply", until: T0 + 9_000 }], T0 + 400);
    const drain = run(locked, { type: "tap", pid: "p2", at: T0 + 500 }, T0 + 500);
    assert.deepEqual(audiences(drain.effects), ["all"]);
  });

  test("setLight and tap need a Plan / Apply round that is running", () => {
    const s = recruiting(["p1"]);
    assertRefused(s, run(s, { type: "setLight", light: "apply", until: 9e9 }, T0), "wrong_round_phase");
    assertRefused(s, run(s, { type: "tap", pid: "p1", at: T0 }, T0), "wrong_round_phase");
    const nobody = planning(["p1"]);
    assertRefused(
      nobody,
      run(nobody, { type: "tap", pid: "ghost", at: T0 + 10 }, T0 + 10),
      "unknown_participant",
    );
  });
});

/* ------------------------------------------------------------------ */
/* The Lounge                                                           */
/* ------------------------------------------------------------------ */

/** p1 drained at 60 resources; p2, p3, p4 still running. Target 120. */
function drained(): SessionState {
  let s = planning(["p1", "p2", "p3", "p4"]);
  s = taps(s, "p1", 60, T0 + 500);
  s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 9000 }], T0 + 1000);
  s = accept(s, [{ type: "tap", pid: "p1", at: T0 + 2000 }], T0 + 2000);
  s = accept(s, [{ type: "setLight", light: "plan", until: T0 + 20_000 }], T0 + 3000);
  return s;
}

describe("the Lounge", () => {
  test("backing is free until the Floor locks, and keeps the seat's arrival time", () => {
    let s = drained();
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p2" }], T0 + 4000);
    assert.deepEqual(arcadeOf(s).lounge["p1"], {
      backing: "p2",
      at: T0 + 2000,
      placedAt: T0 + 4000,
      placedFrom: "drained",
    });
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p3" }], T0 + 5000);
    // The seat keeps its arrival time and the bet takes a new one: what the
    // Lounge is paid on is when the bet was placed, not when they sat down.
    assert.deepEqual(arcadeOf(s).lounge["p1"], {
      backing: "p3",
      at: T0 + 2000,
      placedAt: T0 + 5000,
      placedFrom: "drained",
    });
    // Backing the same person twice is a no-op, not an event.
    const same = run(s, { type: "backPlayer", pid: "p1", backing: "p3" }, T0 + 6000);
    assert.equal(same.applied, false);
  });

  test("you cannot back yourself, a drained player, a stranger, or from the Floor", () => {
    let s = drained();
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p1", backing: "p1" }, T0 + 4000),
      "cannot_back_yourself",
    );
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p2", backing: "p3" }, T0 + 4000),
      "not_in_the_lounge",
    );
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p1", backing: "ghost" }, T0 + 4000),
      "unknown_participant",
    );
    // Drain p2 as well, then have p1 try to back them.
    s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 20_000 }], T0 + 5000);
    s = accept(s, [{ type: "tap", pid: "p2", at: T0 + 6000 }], T0 + 6000);
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p1", backing: "p2" }, T0 + 7000),
      "cannot_back_a_drained_player",
    );
  });

  test("once the Floor locks the bet is in", () => {
    const s = drained();
    const endsAt = arcadeOf(s).endsAt ?? 0;
    assertRefused(
      s,
      run(s, { type: "backPlayer", pid: "p1", backing: "p2" }, endsAt),
      "floor_locked",
    );
    const ended = accept(s, [{ type: "endRound" }], endsAt);
    assertRefused(
      ended,
      run(ended, { type: "backPlayer", pid: "p1", backing: "p2" }, endsAt + 1),
      "wrong_round_phase",
    );
  });

  test("backed runner crosses +10, or wins +15 — the better one, never both", () => {
    let s = drained();
    // p1 backs the eventual winner, p4 will be drained and back the runner-up.
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p2" }], T0 + 4000);
    s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 6000 }], T0 + 5000);
    s = accept(s, [{ type: "tap", pid: "p4", at: T0 + 5500 }], T0 + 5500);
    s = accept(s, [{ type: "backPlayer", pid: "p4", backing: "p3" }], T0 + 5600);
    s = accept(s, [{ type: "setLight", light: "plan", until: T0 + 60_000 }], T0 + 6000);

    s = taps(s, "p2", 120, T0 + 7000); // first across
    s = taps(s, "p3", 120, T0 + 8000); // second across
    s = accept(s, [{ type: "endRound" }], T0 + 75_000);

    // p1 banked 10 on the Floor before the drain, then a perfect Lounge —
    // which is 15, the winner award alone, not 25 for both.
    assert.equal(Math.max(PLAN_APPLY_BACKED_CROSSES, PLAN_APPLY_BACKED_WINS), 15);
    assert.equal(total(s, "p1"), 10 + 15);
    // p4 backed the second finisher: crossing only.
    assert.equal(total(s, "p4"), 10);
    assert.equal(total(s, "p2"), 40);
    assert.equal(total(s, "p3"), 35);
  });

  test("a bet placed after your runner crossed pays nothing", () => {
    // The finish order is on the big screen as it happens — that is the
    // round's theatre and it is not going to stop being — so a bet that may
    // be changed until the Floor locks is a bet that can be placed on a
    // result that has already happened. Drained at 90, watch the screen,
    // back whoever crossed: 15 for a certainty, on top of 15 banked, which
    // beats the 25 an honest third-place crossing pays.
    let s = drained();
    s = taps(s, "p2", 120, T0 + 5000);
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p2" }], T0 + 6000);
    assert.equal(arcadeOf(s).lounge["p1"]?.backing, "p2", "the bet is allowed");
    s = accept(s, [{ type: "endRound" }], T0 + 75_000);
    assert.equal(total(s, "p1"), 10, "…and it is not paid");
  });

  test("the same bet a second earlier is paid in full", () => {
    // The other half of the rule: the Lounge is still a bet, and a bet on a
    // runner who has not finished is exactly what it is supposed to be.
    let s = drained();
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p2" }], T0 + 4999);
    s = taps(s, "p2", 120, T0 + 5000);
    s = accept(s, [{ type: "endRound" }], T0 + 75_000);
    assert.equal(total(s, "p1"), 10 + PLAN_APPLY_BACKED_WINS);
  });

  test("backing someone who never crosses pays nothing", () => {
    let s = drained();
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p2" }], T0 + 4000);
    s = taps(s, "p2", 119, T0 + 5000);
    s = accept(s, [{ type: "endRound" }], T0 + 75_000);
    assert.equal(total(s, "p1"), 10); // the Floor points, and no Lounge
    assert.equal(total(s, "p2"), 15); // three checkpoints, no crossing
  });

  test("backing someone who is drained after you back them pays nothing", () => {
    let s = drained();
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p2" }], T0 + 4000);
    s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 20_000 }], T0 + 5000);
    s = accept(s, [{ type: "tap", pid: "p2", at: T0 + 6000 }], T0 + 6000);
    s = accept(s, [{ type: "endRound" }], T0 + 75_000);
    assert.equal(total(s, "p1"), 10);
  });

  test("a Lounge seat with nobody backed scores nothing and breaks nothing", () => {
    const s = accept(drained(), [{ type: "endRound" }], T0 + 75_000);
    assert.equal(total(s, "p1"), 10);
  });

  test("a seat written before bets were timed is paid, not thrown over", async () => {
    // One process restart inside one Plan / Apply round, on the deploy that
    // introduced the timing. `rehydrate` runs no arcade migration, so what
    // comes back is the old shape exactly: `placedAt` and `placedFrom`
    // *absent* from the seat, and `finishedAt` absent from the play. Not
    // null — absent, which is why the fallback tests for it loosely.
    //
    // Reading either one unguarded throws inside `endRound`, which settles
    // the whole round for everybody, so the cost of getting this wrong is
    // not one unpaid bet. The seat is paid: dropping a bet somebody really
    // did place, in front of them, with nothing to show why, is the worse of
    // the two failures.
    const { rehydrate } = await import("../server/recovery.ts");
    let s = drained();
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p2" }], T0 + 4000);
    s = taps(s, "p2", 120, T0 + 5000);

    const legacy = structuredClone(s) as unknown as Record<string, never>;
    const arcade = legacy["arcade"] as unknown as Record<string, never>;
    const seat = (arcade["lounge"] as unknown as Record<string, never>)["p1"]!;
    delete (seat as unknown as Record<string, unknown>)["placedAt"];
    delete (seat as unknown as Record<string, unknown>)["placedFrom"];
    delete (arcade["play"] as unknown as Record<string, unknown>)["finishedAt"];

    const out = rehydrate({
      meta: { sid: "s", title: "t", joinCode: "hvs.a" },
      snapshot: { seq: s.seq, state: legacy },
      events: [],
    } as never);
    assert.ok(out, "the session did not come back");
    const back = out.state.arcade?.lounge["p1"] as unknown as Record<string, unknown>;
    assert.ok(back && !("placedAt" in back), "something migrated the seat after all");

    const ended = accept(out.state, [{ type: "endRound" }], T0 + 75_000);
    assert.equal(total(ended, "p1"), 10 + PLAN_APPLY_BACKED_WINS);
  });
});

describe("the Lounge cap", () => {
  test("a perfect Lounge is worth less than a perfect Floor, round by round", () => {
    // SPEC's "Arcade scoring summary", all six rounds.
    //
    // Two of the Lounge figures in that table are **stale and need
    // correcting**: it lists 25 for Unseal and 25 for Gganbu, which predate
    // the decision that the two backing awards are the better of the two and
    // never their sum. Both are 8 here, and the test below says why 8 rather
    // than 15: the cheapest way of completing those two Floors pays 10, where
    // the cheapest way of crossing Plan / Apply's pays 25.
    //
    // Every Floor figure is SPEC's, unchanged.
    const rounds = [
      { round: "recruitment" as const, config: recruitmentRound(), floor: 90, lounge: 0 },
      {
        round: "plan_apply" as const,
        config: { kind: "plan_apply" as const, target: 120, seconds: 75 },
        floor: 40,
        lounge: 15,
      },
      { round: "unseal" as const, config: unsealRound(), floor: 60, lounge: 8 },
      { round: "tug_of_raft" as const, config: tugOfRaftRound(1), floor: 45, lounge: 0 },
      { round: "gganbu" as const, config: gganbuRound(1), floor: 50, lounge: 8 },
      { round: "glass_bridge" as const, config: glassBridgeRound(), floor: 63, lounge: 15 },
    ];
    for (const r of rounds) {
      assert.equal(floorMax(r.config), r.floor, `${r.round} Floor max`);
      assert.equal(loungeMax(r.round), r.lounge, `${r.round} Lounge max`);
      assert.ok(loungeMax(r.round) < floorMax(r.config), `${r.round}: Lounge must cap below the Floor`);
    }
    // The property that actually matters, and the reason the awards do not
    // stack: crossing the line in *last* place still beats a perfect Lounge.
    const worstCrossing =
      checkpointsFor(120).length * PLAN_APPLY_CHECKPOINT_BANK + PLAN_APPLY_CROSS;
    assert.equal(worstCrossing, 25);
    assert.ok(worstCrossing > loungeMax("plan_apply"));
  });

  test("the cheapest way off each Floor beats that round's perfect Lounge", () => {
    // The same property, round by round, in the terms each round states it.
    // "Crossing the line" means something different on each Floor, so the
    // cheapest completion is written out here rather than derived.
    const cheapest = [
      // Crossing in last place: three checkpoints and the 10.
      { round: "plan_apply" as const, completion: 25 },
      // A circle tin, which is the cheapest tin there is.
      { round: "unseal" as const, completion: 10 },
      // Wagering nothing all round: ten tokens, converted 1:1. The cheapest
      // *win* is 11 — one token against a revoked rival — and 10 is the
      // harder number to beat, so it is the one used.
      { round: "gganbu" as const, completion: 10 },
      // Reaching the far side in wave 2 or 3: six steps at 5, and the 15.
      { round: "glass_bridge" as const, completion: 45 },
    ];
    for (const r of cheapest) {
      assert.ok(
        loungeMax(r.round) < r.completion,
        `${r.round}: a perfect Lounge (${loungeMax(r.round)}) must not beat ${r.completion}`,
      );
      // And the other half of SPEC's tuning target: a perfect Lounge is
      // always worth having.
      assert.ok(loungeMax(r.round) > 0, `${r.round}: the Lounge must pay something`);
    }
    // The two rounds with no Lounge at all are the two that never drain.
    assert.equal(loungeMax("recruitment"), 0);
    assert.equal(loungeMax("tug_of_raft"), 0);
  });

  test("a survivor who banks nothing is still beaten by a perfect Lounge", () => {
    // SPEC used to word the property as "surviving a Floor is always worth
    // more than a perfect Lounge", and no constants can make that literally
    // true — it now says "crossing the line", for this reason: a
    // player never drained who never reaches the first checkpoint banks 0.
    // That is the intended shape — the Floor pays for progress, and someone
    // who neither progressed nor was drained has not out-played a backer who
    // picked the winner.
    let s = drained();
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p2" }], T0 + 4000);
    s = taps(s, "p2", 120, T0 + 5000);
    s = taps(s, "p3", 29, T0 + 6000); // survived the whole round, banked nothing
    s = accept(s, [{ type: "endRound" }], T0 + 75_000);
    assert.equal(total(s, "p3"), 0);
    assert.equal(total(s, "p1"), 25); // 10 banked + 15 for backing the winner
    assert.ok(total(s, "p1") > total(s, "p3"));
  });

  test("a player drained at the last checkpoint who backs the winner no longer ties the winner", () => {
    // This used to be 15 banked + 25 Lounge = 40, dead level with winning the
    // Floor. Not stacking the two Lounge awards is what fixed it: 15 + 15 = 30.
    let s = planning(["p1", "p2"]);
    s = taps(s, "p1", 90, T0 + 500);
    s = accept(s, [{ type: "setLight", light: "apply", until: T0 + 9000 }], T0 + 1000);
    s = accept(s, [{ type: "tap", pid: "p1", at: T0 + 2000 }], T0 + 2000);
    s = accept(s, [{ type: "setLight", light: "plan", until: T0 + 60_000 }], T0 + 3000);
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p2" }], T0 + 4000);
    s = taps(s, "p2", 120, T0 + 5000);
    s = accept(s, [{ type: "endRound" }], T0 + 75_000);
    assert.equal(total(s, "p1"), 30);
    assert.equal(total(s, "p2"), 40);
    assert.ok(total(s, "p2") > total(s, "p1"), "winning the Floor must beat a late drain plus a perfect Lounge");
  });
});

/* ------------------------------------------------------------------ */
/* Banking, draining and the next round                                 */
/* ------------------------------------------------------------------ */

describe("draining lasts exactly one round", () => {
  test("every round starts with everyone back on the Floor, banked cleared, totals kept", () => {
    let s = drained();
    s = accept(s, [{ type: "backPlayer", pid: "p1", backing: "p2" }], T0 + 4000);
    s = taps(s, "p2", 120, T0 + 5000);
    s = accept(s, [{ type: "endRound" }, { type: "revealRound" }], T0 + 75_000);

    // Between rounds the grid still shows who was drained — the pink strike is
    // for "drained this round" — and the totals are settled.
    assert.equal(arcadeOf(s).standing["p1"], "drained");
    assert.equal(total(s, "p1"), 25);

    s = accept(
      s,
      [{ type: "startRound", round: "plan_apply", config: { kind: "plan_apply", target: 120, seconds: 75 } }],
      T0 + 90_000,
    );
    const a = arcadeOf(s);
    assert.deepEqual(a.standing, { p1: "floor", p2: "floor", p3: "floor", p4: "floor" });
    assert.deepEqual(a.lounge, {});
    assert.deepEqual(a.banked, {});
    assert.equal(a.totals["p1"], 25); // 10 banked + 15 for backing the winner
    assert.equal(a.totals["p2"], 40);
  });

  test("a second round adds to the first: the arcade raw is cumulative", () => {
    let s = recruiting(["p1", "p2"]);
    s = accept(s, [{ type: "submitAnswer", pid: "p1", answer: "Vault" }], T0 + 1000);
    s = accept(s, [{ type: "endRound" }, { type: "revealRound" }], T0 + 30_000);
    assert.equal(total(s, "p1"), 15);

    s = accept(
      s,
      [
        { type: "startRound", round: "plan_apply", config: { kind: "plan_apply", target: 120, seconds: 75 } },
        { type: "beginPlay" },
      ],
      T0 + 40_000,
    );
    s = taps(s, "p1", 120, T0 + 41_000);
    s = accept(s, [{ type: "endRound" }], T0 + 100_000);
    assert.equal(total(s, "p1"), 55); // 15 + 40
    // Everybody who was in the round is on the board, at zero if they did nothing.
    assert.equal(total(s, "p2"), 0);
  });
});

/* ------------------------------------------------------------------ */
/* Into the scoreboard                                                  */
/* ------------------------------------------------------------------ */

describe("the arcade raw score", () => {
  test("lands in scores at the reveal, not at the end of the round", () => {
    // The same discipline as trivia: the participant's points strip is
    // projected from `scores`, so it moves when the reveal does.
    let s = recruiting(["p1", "p2"]);
    s = accept(s, [{ type: "submitAnswer", pid: "p1", answer: "Vault" }], T0 + 1000);
    assert.deepEqual(s.scores["arcade"], {});

    s = accept(s, [{ type: "endRound" }], T0 + 30_000);
    assert.deepEqual(s.scores["arcade"], {}, "the close writes nothing");

    s = accept(s, [{ type: "revealRound" }], T0 + 31_000);
    assert.deepEqual(s.scores["arcade"], {
      p1: { raw: 15, status: "played" },
      p2: { raw: 0, status: "played" },
    });
  });

  test("it is an ordinary raw: the scoreboard normalises it with no special case", () => {
    let s = recruiting(["p1", "p2"]);
    s = accept(s, [{ type: "submitAnswer", pid: "p1", answer: "Vault" }], T0 + 1000);
    s = accept(s, [{ type: "submitAnswer", pid: "p2", answer: "nope" }], T0 + 2000);
    s = accept(s, [{ type: "endRound" }, { type: "revealRound" }], T0 + 30_000);

    const standings = computeStandings(s);
    const top = standings.find((r) => r.pid === "p1");
    const bottom = standings.find((r) => r.pid === "p2");
    assert.equal(top?.perActivity["arcade"]?.points, 100);
    assert.equal(top?.perActivity["arcade"]?.raw, 15);
    assert.equal(top?.perActivity["arcade"]?.source, "normalised");
    assert.equal(bottom?.perActivity["arcade"]?.points, 0);
  });

  test("bench credit is not overwritten by an arcade total", () => {
    let s = recruiting(["p1", "p2"]);
    s = accept(s, [{ type: "submitAnswer", pid: "p1", answer: "Vault" }], T0 + 1000);
    s = accept(
      s,
      [{ type: "setStatus", activityId: "arcade", pid: "p1", status: "bench" }],
      T0 + 2000,
    );
    s = accept(s, [{ type: "endRound" }, { type: "revealRound" }], T0 + 30_000);
    assert.deepEqual(s.scores["arcade"]?.["p1"], { raw: 0, status: "bench" });
  });
});

describe("replay", () => {
  test("an arcade round replays to the same state", () => {
    const events: { event: Event; at: number }[] = [
      { event: { type: "open" }, at: 10 },
      { event: { type: "start" }, at: 20 },
      { event: { type: "join", pid: "p1", nickname: "Ana" }, at: 30 },
      { event: { type: "join", pid: "p2", nickname: "Bo" }, at: 40 },
      { event: { type: "enterArcade", activityId: "arcade" }, at: 50 },
      {
        event: { type: "startRound", round: "plan_apply", config: { kind: "plan_apply", target: 4, seconds: 75 } },
        at: 60,
      },
      { event: { type: "beginPlay" }, at: T0 },
      { event: { type: "tap", pid: "p1", at: T0 + 100 }, at: T0 + 100 },
      { event: { type: "tap", pid: "p1", at: T0 + 200 }, at: T0 + 200 },
      { event: { type: "setLight", light: "apply", until: T0 + 4000 }, at: T0 + 300 },
      { event: { type: "tap", pid: "p2", at: T0 + 400 }, at: T0 + 400 },
      { event: { type: "backPlayer", pid: "p2", backing: "p1" }, at: T0 + 500 },
      { event: { type: "setLight", light: "plan", until: T0 + 9000 }, at: T0 + 600 },
      { event: { type: "tap", pid: "p1", at: T0 + 700 }, at: T0 + 700 },
      { event: { type: "tap", pid: "p1", at: T0 + 800 }, at: T0 + 800 },
      { event: { type: "endRound" }, at: T0 + 76_000 },
      { event: { type: "revealRound" }, at: T0 + 77_000 },
    ];
    const initial = newSession({ sid: "s", title: "T", joinCode: "RAFT", activities: [ARCADE] });
    const once = replay(initial, events);
    const twice = replay(initial, events);
    assert.deepEqual(once, twice);
    // Target 4: checkpoints at 1, 2 and 3, so crossing pays 15 + 10 + 15.
    assert.equal(once.arcade?.totals["p1"], 40);
    // p2 was drained on the first tap and backed the winner: 0 + 15.
    assert.equal(once.arcade?.totals["p2"], 15);
    assert.deepEqual(once.scores["arcade"], {
      p1: { raw: 40, status: "played" },
      p2: { raw: 15, status: "played" },
    });
  });
});
