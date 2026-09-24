/**
 * Scoring tests. Every expected value here is derived from SCORING.md by
 * hand, not from scoring.ts. Where the spec is silent the test says so.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  Activity,
  ActivityId,
  Participant,
  ParticipantId,
  RawScore,
  SessionState,
  SpotAward,
} from "./types.ts";
import {
  SPOT_AWARD_POINTS,
  breakTie,
  computeStandings,
  normaliseActivity,
  spotsRemaining,
  topFive,
} from "./scoring.ts";

/* ------------------------------------------------------------------ */
/* Builders — states are constructed directly so these tests do not    */
/* depend on the reducer being correct.                                 */
/* ------------------------------------------------------------------ */

type RawSpec = number | "bench" | "unset";

interface Build {
  readonly activities?: readonly (string | Activity)[];
  readonly tiebreakOrder?: readonly string[];
  /** pids; the nickname is the pid. */
  readonly participants: readonly string[];
  readonly kicked?: readonly string[];
  /** activityId -> pid -> raw | "bench" | "unset" */
  readonly scores?: Readonly<Record<string, Readonly<Record<string, RawSpec>>>>;
  readonly spots?: readonly { pid: string; activityId: string }[];
}

function act(id: string, spotCap = 2): Activity {
  return { id, title: id, kind: "manual", spotCap };
}

function build(b: Build): SessionState {
  const activities: Activity[] = (b.activities ?? ["ttx", "trivia", "arcade"]).map(
    (a) => (typeof a === "string" ? act(a) : a),
  );
  const participants: Record<ParticipantId, Participant> = {};
  b.participants.forEach((pid, i) => {
    participants[pid] = {
      pid,
      nickname: pid,
      nicknameKey: pid.toLowerCase(),
      playerNumber: i + 1,
      joinedAt: i,
      connected: true,
      kicked: (b.kicked ?? []).includes(pid),
    };
  });
  const scores: Record<ActivityId, Record<ParticipantId, RawScore>> = {};
  for (const a of activities) scores[a.id] = {};
  for (const [aid, byPid] of Object.entries(b.scores ?? {})) {
    const bucket = scores[aid] ?? (scores[aid] = {});
    for (const [pid, v] of Object.entries(byPid)) {
      bucket[pid] =
        v === "bench"
          ? { raw: 0, status: "bench" }
          : v === "unset"
            ? { raw: 0, status: "unset" }
            : { raw: v, status: "played" };
    }
  }
  const spots: SpotAward[] = (b.spots ?? []).map((s, i) => ({
    seq: i + 1,
    pid: s.pid,
    activityId: s.activityId,
    reason: "because",
    at: i,
  }));
  return {
    sid: "s",
    title: "t",
    joinCode: "RAFT",
    phase: "running",
    segment: "standings",
    seal: "live",
  practice: false,
    activities,
    tiebreakOrder: b.tiebreakOrder ?? activities.map((a) => a.id),
    participants,
    scores,
    spots,
    holding: null,
    trivia: null,
    arcade: null,
    joinsLocked: false,
    seq: 0,
    nextPlayerNumber: b.participants.length + 1,
  };
}

function must<T>(x: T | undefined, what = "value"): T {
  assert.ok(x !== undefined, `expected ${what} to be present`);
  return x;
}

function standingOf(state: SessionState, pid: string) {
  return must(
    computeStandings(state).find((s) => s.pid === pid),
    `standing for ${pid}`,
  );
}

function pointsOf(state: SessionState, pid: string, activityId: string) {
  return must(standingOf(state, pid).perActivity[activityId], `perActivity ${activityId}`);
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                        */
/* ------------------------------------------------------------------ */

describe("normalisation", () => {
  test("the documented example: 18,400 / 14,720 / 9,200 -> 100 / 80 / 50", () => {
    const s = build({
      participants: ["priya", "kenji", "sam"],
      scores: { trivia: { priya: 18_400, kenji: 14_720, sam: 9_200 } },
    });
    assert.deepEqual(normaliseActivity(s, "trivia"), { priya: 100, kenji: 80, sam: 50 });
  });

  test("the top scorer gets exactly 100 whatever the units", () => {
    for (const top of [1, 7, 20, 0.3, 18_400, 1_000_000]) {
      const s = build({ participants: ["a", "b"], scores: { ttx: { a: top, b: top / 2 } } });
      assert.equal(normaliseActivity(s, "ttx")["a"], 100, `top raw ${top}`);
    }
  });

  test("scaling is proportional: beating the field by double reads as double", () => {
    const s = build({ participants: ["a", "b", "c"], scores: { ttx: { a: 40, b: 20, c: 10 } } });
    assert.deepEqual(normaliseActivity(s, "ttx"), { a: 100, b: 50, c: 25 });
  });

  test("round(): 1/3 -> 33, 2/3 -> 67, 1/8 (12.5) -> 13, 1/200 (0.5) -> 1", () => {
    const s = build({
      activities: ["thirds", "eighths", "tiny"],
      participants: ["top", "x", "y"],
      scores: {
        thirds: { top: 3, x: 1, y: 2 },
        eighths: { top: 8, x: 1 },
        tiny: { top: 200, x: 1 },
      },
    });
    assert.deepEqual(normaliseActivity(s, "thirds"), { top: 100, x: 33, y: 67 });
    assert.equal(normaliseActivity(s, "eighths")["x"], 13);
    assert.equal(normaliseActivity(s, "tiny")["x"], 1);
  });

  test("no floor: a real but tiny score can round to 0", () => {
    const s = build({ participants: ["top", "x"], scores: { ttx: { top: 1000, x: 1 } } });
    assert.equal(normaliseActivity(s, "ttx")["x"], 0);
    assert.equal(standingOf(s, "x").total, 0);
  });

  test("a top raw of 0 (nobody scored) yields 0 for everyone, never NaN", () => {
    const s = build({ participants: ["a", "b"], scores: { ttx: { a: 0, b: 0 } } });
    const n = normaliseActivity(s, "ttx");
    assert.deepEqual(n, { a: 0, b: 0 });
    for (const st of computeStandings(s)) {
      assert.ok(Number.isFinite(st.total), `total for ${st.pid} is ${st.total}`);
    }
  });

  test("a single participant who scored is the top scorer and gets 100", () => {
    const s = build({ participants: ["solo"], scores: { ttx: { solo: 42 } } });
    assert.deepEqual(normaliseActivity(s, "ttx"), { solo: 100 });
    assert.equal(standingOf(s, "solo").rank, 1);
  });

  test("a single participant who scored 0 gets 0, not NaN or 100", () => {
    const s = build({ participants: ["solo"], scores: { ttx: { solo: 0 } } });
    assert.deepEqual(normaliseActivity(s, "ttx"), { solo: 0 });
    assert.equal(standingOf(s, "solo").total, 0);
  });

  test("fractional raw scores normalise like any other", () => {
    const s = build({ participants: ["a", "b"], scores: { ttx: { a: 5, b: 2.5 } } });
    assert.deepEqual(normaliseActivity(s, "ttx"), { a: 100, b: 50 });
  });

  test("bench participants are excluded from the top calculation", () => {
    // The facilitator is on bench with a stale raw that would otherwise win.
    const s = build({
      participants: ["fac", "a", "b"],
      scores: { ttx: { fac: "bench", a: 50, b: 25 } },
    });
    const n = normaliseActivity(s, "ttx");
    assert.equal(n["a"], 100, "the top *played* scorer gets 100");
    assert.equal(n["b"], 50);
    assert.equal(n["fac"], undefined, "bench gets no normalised points");
  });

  test("a bench entry carrying a raw score (data hygiene) still cannot set the ceiling", () => {
    const s = build({ participants: ["fac", "a"], scores: { ttx: { a: 10 } } });
    const dirty: SessionState = {
      ...s,
      scores: { ...s.scores, ttx: { ...s.scores["ttx"], fac: { raw: 1_000_000, status: "bench" } } },
    };
    assert.equal(normaliseActivity(dirty, "ttx")["a"], 100);
  });

  test("unset participants are excluded from the top and receive no points", () => {
    const s = build({
      participants: ["a", "b", "late"],
      scores: { ttx: { a: 10, b: 5, late: "unset" } },
    });
    assert.deepEqual(normaliseActivity(s, "ttx"), { a: 100, b: 50 });
    const late = pointsOf(s, "late", "ttx");
    assert.equal(late.points, null);
    assert.equal(late.source, "unset");
  });

  test("a participant with no score entry at all is simply unset", () => {
    const s = build({ participants: ["a", "b"], scores: { ttx: { a: 10 } } });
    assert.equal(pointsOf(s, "b", "ttx").points, null);
    assert.equal(pointsOf(s, "b", "ttx").source, "unset");
  });

  test("an activity with no scores yet normalises to nothing", () => {
    const s = build({ participants: ["a"] });
    assert.deepEqual(normaliseActivity(s, "ttx"), {});
  });

  test("an unknown activity id normalises to nothing rather than throwing", () => {
    const s = build({ participants: ["a"] });
    assert.deepEqual(normaliseActivity(s, "nope"), {});
  });

  test("a kicked participant is not in the standings and must not set the ceiling", () => {
    // SCORING.md: "The top scorer in an activity gets 100." A kicked
    // participant is removed from the standings, so the top scorer *shown*
    // must be on 100. Otherwise kicking a troll who typed a big number
    // silently caps the whole room.
    const s = build({
      participants: ["troll", "a", "b"],
      kicked: ["troll"],
      scores: { ttx: { troll: 1000, a: 50, b: 25 } },
    });
    const st = computeStandings(s);
    assert.ok(!st.some((x) => x.pid === "troll"), "kicked is excluded from standings");
    assert.equal(standingOf(s, "a").total, 100, "the visible top scorer gets 100");
    assert.equal(standingOf(s, "b").total, 50);
  });

  test("normalised points carry the raw they came from", () => {
    const s = build({ participants: ["a", "b"], scores: { ttx: { a: 20, b: 5 } } });
    assert.deepEqual(pointsOf(s, "b", "ttx"), { points: 25, source: "normalised", raw: 5 });
  });
});

/* ------------------------------------------------------------------ */
/* Bench Credit                                                         */
/* ------------------------------------------------------------------ */

describe("bench credit", () => {
  test("the documented example: 90 and 70 -> credited 80 for the one they ran", () => {
    const s = build({
      participants: ["fac", "top"],
      scores: {
        ttx: { top: 100, fac: 90 },
        trivia: { top: 100, fac: 70 },
        arcade: { top: 10, fac: "bench" },
      },
    });
    const arcade = pointsOf(s, "fac", "arcade");
    assert.deepEqual(arcade, { points: 80, source: "bench", raw: null });
    assert.equal(standingOf(s, "fac").total, 90 + 70 + 80);
  });

  test("a non-integer mean is a whole number of points (90 and 75 -> 83)", () => {
    // SCORING.md gives round() for normalisation and says "mean" for bench
    // credit without stating rounding. Points are whole numbers everywhere
    // else in the document, so this asserts the same round(); see report.
    const s = build({
      participants: ["fac", "top"],
      scores: {
        ttx: { top: 100, fac: 90 },
        trivia: { top: 100, fac: 75 },
        arcade: { top: 10, fac: "bench" },
      },
    });
    const pts = pointsOf(s, "fac", "arcade").points;
    assert.ok(Number.isInteger(pts), `credit ${pts} should be whole`);
    assert.equal(pts, 83);
    assert.ok(Number.isInteger(standingOf(s, "fac").total));
  });

  test("benched for everything (nothing played) reads as null, never 0", () => {
    const s = build({
      participants: ["fac", "top"],
      scores: {
        ttx: { top: 10, fac: "bench" },
        trivia: { top: 10, fac: "bench" },
        arcade: { top: 10, fac: "bench" },
      },
    });
    for (const a of ["ttx", "trivia", "arcade"]) {
      const p = pointsOf(s, "fac", a);
      assert.equal(p.points, null, `${a} should be "—"`);
      assert.equal(p.source, "bench");
    }
    assert.equal(standingOf(s, "fac").total, 0);
  });

  test("bench with nothing played yet is null even while others are unset too", () => {
    const s = build({ participants: ["fac", "a"], scores: { ttx: { fac: "bench" } } });
    assert.equal(pointsOf(s, "fac", "ttx").points, null);
  });

  test("activities that are unset do not enter the mean", () => {
    const s = build({
      participants: ["fac", "top"],
      scores: {
        ttx: { top: 100, fac: 60 },
        trivia: { top: 100, fac: "unset" },
        arcade: { top: 10, fac: "bench" },
      },
    });
    assert.equal(pointsOf(s, "fac", "arcade").points, 60);
  });

  test("generalises unchanged when one person runs two activities", () => {
    const s = build({
      participants: ["fac", "top"],
      scores: {
        ttx: { top: 10, fac: "bench" },
        trivia: { top: 10, fac: "bench" },
        arcade: { top: 100, fac: 80 },
      },
    });
    assert.equal(pointsOf(s, "fac", "ttx").points, 80);
    assert.equal(pointsOf(s, "fac", "trivia").points, 80);
    assert.equal(standingOf(s, "fac").total, 240);
  });

  test("the mean is of normalised points only; Spot Awards do not feed it", () => {
    const s = build({
      participants: ["fac", "top"],
      scores: {
        ttx: { top: 100, fac: 100 },
        trivia: { top: 10, fac: "bench" },
      },
      spots: [{ pid: "fac", activityId: "ttx" }],
    });
    assert.equal(pointsOf(s, "fac", "trivia").points, 100, "credit is 100, not 110");
    assert.equal(standingOf(s, "fac").total, 100 + 100 + 10 + 0);
  });

  test("bench credit is recomputed as activities complete", () => {
    const before = build({
      participants: ["fac", "top"],
      scores: { ttx: { top: 100, fac: 90 }, trivia: { top: 10, fac: "bench" } },
    });
    assert.equal(pointsOf(before, "fac", "trivia").points, 90);
    const after = build({
      participants: ["fac", "top"],
      scores: {
        ttx: { top: 100, fac: 90 },
        trivia: { top: 10, fac: "bench" },
        arcade: { top: 100, fac: 50 },
      },
    });
    assert.equal(pointsOf(after, "fac", "trivia").points, 70);
  });

  test("bench credit changes nobody else's score", () => {
    // fac's trivia raw is deliberately below the top so fac sets no ceiling
    // anywhere; the only thing fac contributes is a bench credit in ttx.
    const withFac = build({
      participants: ["fac", "a", "b"],
      scores: { ttx: { fac: "bench", a: 30, b: 15 }, trivia: { fac: 20, a: 50, b: 25 } },
    });
    const withoutFac = build({
      participants: ["a", "b"],
      scores: { ttx: { a: 30, b: 15 }, trivia: { a: 50, b: 25 } },
    });
    for (const pid of ["a", "b"]) {
      assert.equal(standingOf(withFac, pid).total, standingOf(withoutFac, pid).total, pid);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Spot Awards                                                          */
/* ------------------------------------------------------------------ */

describe("spot awards", () => {
  test("are worth 10 points each", () => {
    assert.equal(SPOT_AWARD_POINTS, 10);
    const s = build({
      participants: ["a", "b"],
      scores: { ttx: { a: 10, b: 5 } },
      spots: [
        { pid: "b", activityId: "ttx" },
        { pid: "b", activityId: "trivia" },
      ],
    });
    const b = standingOf(s, "b");
    assert.equal(b.spotCount, 2);
    assert.equal(b.spotPoints, 20);
    assert.equal(b.total, 50 + 20);
  });

  test("are added after normalisation and never move the ceiling", () => {
    const s = build({
      participants: ["a", "b"],
      scores: { ttx: { a: 10, b: 5 } },
      spots: [{ pid: "a", activityId: "ttx" }],
    });
    assert.equal(pointsOf(s, "a", "ttx").points, 100, "activity points stay at 100");
    assert.equal(standingOf(s, "a").total, 110);
    assert.equal(standingOf(s, "b").total, 50, "b is unaffected by a's spot");
  });

  test("count towards a participant who has no activity points yet", () => {
    const s = build({ participants: ["a"], spots: [{ pid: "a", activityId: "ttx" }] });
    assert.equal(standingOf(s, "a").total, 10);
  });

  test("a spot recorded against an activity the participant is on bench for does not count", () => {
    // SCORING.md: "A participant on bench for an activity cannot receive
    // that activity's Spot Awards." The rule is about the scores, not just
    // the console button — a spot that slipped in (granted before the
    // participant was benched) must not be worth points.
    const s = build({
      participants: ["fac", "a"],
      scores: { ttx: { fac: "bench", a: 10 }, trivia: { fac: 100, a: 50 } },
      spots: [{ pid: "fac", activityId: "ttx" }],
    });
    assert.equal(standingOf(s, "fac").spotPoints, 0);
    assert.equal(standingOf(s, "fac").total, 100 + 100);
  });

  test("spotsRemaining counts down per activity and never goes negative", () => {
    const s = build({
      activities: [act("ttx", 2), act("trivia", 1)],
      participants: ["a"],
      spots: [
        { pid: "a", activityId: "ttx" },
        { pid: "a", activityId: "trivia" },
        { pid: "a", activityId: "trivia" },
      ],
    });
    assert.equal(spotsRemaining(s, act("ttx", 2)), 1);
    assert.equal(spotsRemaining(s, act("trivia", 1)), 0);
    assert.equal(spotsRemaining(s, act("arcade", 2)), 2);
  });
});

/* ------------------------------------------------------------------ */
/* Ranking                                                              */
/* ------------------------------------------------------------------ */

describe("ranking", () => {
  test("is 1-based and ordered by total, highest first", () => {
    const s = build({
      participants: ["low", "mid", "high"],
      scores: { ttx: { low: 1, mid: 2, high: 4 } },
    });
    assert.deepEqual(
      computeStandings(s).map((x) => [x.pid, x.total, x.rank]),
      [["high", 100, 1], ["mid", 50, 2], ["low", 25, 3]],
    );
  });

  test("equal totals share a rank and the next rank skips (1, 1, 3)", () => {
    const s = build({
      participants: ["a", "b", "c"],
      scores: { ttx: { a: 10, b: 10, c: 5 } },
    });
    const ranks = Object.fromEntries(computeStandings(s).map((x) => [x.pid, x.rank]));
    assert.deepEqual(ranks, { a: 1, b: 1, c: 3 });
  });

  test("a three-way tie in second is followed by fifth", () => {
    const s = build({
      participants: ["a", "b", "c", "d", "e"],
      scores: { ttx: { a: 10, b: 5, c: 5, d: 5, e: 1 } },
    });
    const ranks = computeStandings(s).map((x) => x.rank);
    assert.deepEqual(ranks, [1, 2, 2, 2, 5]);
  });

  test("ties are on the total, including spot points", () => {
    const s = build({
      participants: ["a", "b"],
      scores: { ttx: { a: 10, b: 9 } },
      spots: [{ pid: "b", activityId: "ttx" }],
    });
    assert.deepEqual(
      computeStandings(s).map((x) => [x.total, x.rank]),
      [[100, 1], [100, 1]],
    );
  });

  test("kicked participants do not appear", () => {
    const s = build({ participants: ["a", "gone"], kicked: ["gone"], scores: { ttx: { a: 1 } } });
    assert.deepEqual(computeStandings(s).map((x) => x.pid), ["a"]);
  });

  test("a participant with nothing recorded is still listed, on 0", () => {
    const s = build({ participants: ["a", "b"], scores: { ttx: { a: 1 } } });
    assert.equal(standingOf(s, "b").total, 0);
    assert.equal(standingOf(s, "b").rank, 2);
  });

  test("a participant benched everywhere totals 0, not NaN", () => {
    const s = build({ participants: ["a"], scores: { ttx: { a: "bench" } } });
    assert.equal(standingOf(s, "a").total, 0);
  });

  test("an empty session has empty standings", () => {
    assert.deepEqual(computeStandings(build({ participants: [] })), []);
  });

  test("totals sum across all activities, bench included: 3 activities -> up to 300 + 60", () => {
    const s = build({
      activities: [act("ttx", 2), act("trivia", 2), act("arcade", 2)],
      participants: ["a", "b"],
      scores: { ttx: { a: 1, b: 1 }, trivia: { a: 1, b: 1 }, arcade: { a: 1, b: 1 } },
      spots: [
        { pid: "a", activityId: "ttx" },
        { pid: "a", activityId: "ttx" },
        { pid: "a", activityId: "trivia" },
        { pid: "a", activityId: "trivia" },
        { pid: "a", activityId: "arcade" },
        { pid: "a", activityId: "arcade" },
      ],
    });
    assert.equal(standingOf(s, "a").total, 360);
    assert.equal(standingOf(s, "b").total, 300);
  });

  test("does not mutate the state it reads", () => {
    const s = build({ participants: ["a", "b"], scores: { ttx: { a: 10, b: 5 } } });
    const snapshot = structuredClone(s);
    computeStandings(s);
    normaliseActivity(s, "ttx");
    breakTie(s, computeStandings(s));
    assert.deepEqual(s, snapshot);
  });
});

/* ------------------------------------------------------------------ */
/* Top five                                                             */
/* ------------------------------------------------------------------ */

describe("topFive", () => {
  test("returns exactly five when there are more", () => {
    const pids = ["a", "b", "c", "d", "e", "f", "g"];
    const s = build({
      participants: pids,
      scores: { ttx: Object.fromEntries(pids.map((p, i) => [p, 70 - i * 10])) },
    });
    const five = topFive(computeStandings(s));
    assert.equal(five.length, 5);
    assert.deepEqual(five.map((x) => x.pid), ["a", "b", "c", "d", "e"]);
    assert.deepEqual(five.map((x) => x.rank), [1, 2, 3, 4, 5]);
  });

  test("returns everyone when there are fewer than five", () => {
    const s = build({ participants: ["a", "b", "c"], scores: { ttx: { a: 3, b: 2, c: 1 } } });
    assert.equal(topFive(computeStandings(s)).length, 3);
  });

  test("returns exactly five when there are exactly five", () => {
    const s = build({ participants: ["a", "b", "c", "d", "e"] });
    assert.equal(topFive(computeStandings(s)).length, 5);
  });

  test("returns nothing for nobody", () => {
    assert.deepEqual(topFive([]), []);
  });

  test("does not mutate the standings it is given", () => {
    const st = computeStandings(build({ participants: ["a", "b", "c", "d", "e", "f"] }));
    const before = structuredClone(st);
    topFive(st);
    assert.deepEqual(st, before);
    assert.equal(st.length, 6);
  });
});

/* ------------------------------------------------------------------ */
/* Tiebreak                                                             */
/* ------------------------------------------------------------------ */

describe("breakTie", () => {
  test("with a clear leader, the leader wins without consulting the order", () => {
    const s = build({ participants: ["a", "b"], scores: { ttx: { a: 10, b: 5 } } });
    const r = breakTie(s, computeStandings(s));
    assert.equal(r.winner, "a");
    assert.deepEqual(r.tied, ["a"]);
  });

  test("with nobody, there is no winner", () => {
    const s = build({ participants: [] });
    assert.deepEqual(breakTie(s, computeStandings(s)), { winner: null, tied: [] });
  });

  test("resolves on the first activity in tiebreak order that separates", () => {
    // a and b: ttx 100/80 vs trivia 80/100 — level on total.
    const s = build({
      tiebreakOrder: ["ttx", "trivia"],
      participants: ["a", "b"],
      scores: { ttx: { a: 10, b: 8 }, trivia: { a: 8, b: 10 } },
    });
    const st = computeStandings(s);
    assert.equal(must(st[0]).rank, 1);
    assert.equal(must(st[1]).rank, 1);
    assert.equal(breakTie(s, st).winner, "a");
  });

  test("honours tiebreakOrder, not the activity list order", () => {
    const s = build({
      activities: ["ttx", "trivia"],
      tiebreakOrder: ["trivia", "ttx"],
      participants: ["a", "b"],
      scores: { ttx: { a: 10, b: 8 }, trivia: { a: 8, b: 10 } },
    });
    assert.equal(breakTie(s, computeStandings(s)).winner, "b");
  });

  test("walks on to the next activity when the first leaves contenders level", () => {
    // Totals all 250. ttx (100/100/50) drops c; trivia (50/50/100) leaves
    // a and b level; arcade (100/50/100) picks a. b's five spots make up the
    // difference so the three-way tie on total is genuine.
    const tied = build({
      tiebreakOrder: ["ttx", "trivia", "arcade"],
      participants: ["a", "b", "c"],
      scores: {
        ttx: { a: 10, b: 10, c: 5 },
        trivia: { a: 5, b: 5, c: 10 },
        arcade: { a: 10, b: 5, c: 10 },
      },
      spots: [
        { pid: "b", activityId: "ttx" },
        { pid: "b", activityId: "ttx" },
        { pid: "b", activityId: "trivia" },
        { pid: "b", activityId: "trivia" },
        { pid: "b", activityId: "arcade" },
      ],
    });
    const st = computeStandings(tied);
    assert.deepEqual(st.map((x) => x.total), [250, 250, 250]);
    assert.deepEqual(st.map((x) => x.rank), [1, 1, 1], "all three tied for first");
    const r = breakTie(tied, st);
    assert.equal(r.winner, "a", "ttx drops c; trivia keeps a and b level; arcade picks a");
  });

  test("returns null (sudden death) when the order is exhausted with contenders level", () => {
    const s = build({
      tiebreakOrder: ["ttx"],
      participants: ["a", "b"],
      scores: { ttx: { a: 10, b: 10 } },
    });
    const r = breakTie(s, computeStandings(s));
    assert.equal(r.winner, null);
    assert.deepEqual([...r.tied].sort(), ["a", "b"]);
  });

  test("returns null with an empty tiebreak order", () => {
    const s = build({
      tiebreakOrder: [],
      participants: ["a", "b"],
      scores: { ttx: { a: 10, b: 8 }, trivia: { a: 8, b: 10 } },
    });
    assert.equal(breakTie(s, computeStandings(s)).winner, null);
  });

  test("never picks arbitrarily: identical inputs in a different order give the same answer", () => {
    const mk = (pids: string[]) =>
      build({
        participants: pids,
        scores: {
          ttx: { a: 10, b: 10 },
          trivia: { a: 10, b: 10 },
          arcade: { a: 10, b: 10 },
        },
      });
    const r1 = breakTie(mk(["a", "b"]), computeStandings(mk(["a", "b"])));
    const r2 = breakTie(mk(["b", "a"]), computeStandings(mk(["b", "a"])));
    assert.equal(r1.winner, null);
    assert.equal(r2.winner, null);
  });

  test("the contenders that remain after exhaustion are the ones still level", () => {
    const s = build({
      tiebreakOrder: ["ttx"],
      participants: ["a", "b", "c"],
      scores: {
        ttx: { a: 10, b: 10, c: 5 }, // 100 100 50
        trivia: { a: 5, b: 5, c: 10 }, // 50 50 100
        arcade: { a: 5, b: 5, c: 5 }, // 100 100 100 -> totals 250 250 250
      },
    });
    const r = breakTie(s, computeStandings(s));
    assert.equal(r.winner, null);
    assert.deepEqual([...r.tied].sort(), ["a", "b"], "c was separated by ttx");
  });

  test("a participant not tied for first is never a contender, even if they'd win the tiebreak activity", () => {
    const s = build({
      tiebreakOrder: ["ttx"],
      participants: ["a", "b", "c"],
      scores: {
        ttx: { a: 5, b: 5, c: 10 }, // 50 50 100
        trivia: { a: 10, b: 10, c: 1 }, // 100 100 10 -> a,b 150; c 110
      },
    });
    const r = breakTie(s, computeStandings(s));
    assert.equal(r.winner, null);
    assert.ok(!r.tied.includes("c"));
  });

  test("a contender with no score in the tiebreak activity loses to one who has any", () => {
    const s = build({
      tiebreakOrder: ["ttx"],
      participants: ["a", "b"],
      scores: {
        ttx: { a: 5, b: "unset" }, // a 100
        trivia: { a: 1, b: 10 }, // a 10, b 100 -> a 110, b 100... adjust
      },
      spots: [{ pid: "b", activityId: "trivia" }], // b 110
    });
    const st = computeStandings(s);
    assert.deepEqual(st.map((x) => x.rank), [1, 1]);
    assert.equal(breakTie(s, st).winner, "a");
  });

  test("an activity in the order that does not exist separates nobody", () => {
    const s = build({
      tiebreakOrder: ["ghost", "ttx"],
      participants: ["a", "b"],
      scores: { ttx: { a: 10, b: 8 }, trivia: { a: 8, b: 10 } },
    });
    assert.equal(breakTie(s, computeStandings(s)).winner, "a");
  });
});
