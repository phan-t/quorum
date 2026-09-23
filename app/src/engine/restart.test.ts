/**
 * Starting a session over, and undoing a close.
 *
 * Two events, and between them they are the only way back from anything the
 * session has done: `reopen` unfreezes a closed session with every score
 * intact, and `restartSession` puts any phase back to a clean lobby with the
 * room and the content still in it.
 *
 * The expected behaviour here is the contract those two events promise — kept:
 * the session id, the join code, the roster with nicknames and join-order
 * numbers, the loaded question set, the activity list. Cleared: scores, Spot
 * Awards, trivia progress, the arcade, the holding card, the seal, the
 * segment and the join lock. It is asserted field by field rather than by
 * comparing against a freshly built session, because "everything is default"
 * and "everything the host needed is still here" are different claims and
 * only one of them is the feature.
 *
 * As everywhere else in this directory, every call goes through `run`, which
 * deep-freezes the input state and checks it against a clone afterwards: the
 * engine is pure.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  Activity,
  ArcadeState,
  Effect,
  Event,
  ParticipantId,
  Question,
  RejectCode,
  SessionPhase,
  SessionState,
  TriviaState,
} from "./types.ts";
import { newSession, reduce, replay } from "./reducer.ts";
import { computeStandings } from "./scoring.ts";
import { recruitmentRound } from "../arcade/recruitment.ts";

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
  return effects.filter(
    (e): e is Extract<Effect, { kind: "reject" }> => e.kind === "reject",
  );
}

function accept(
  state: SessionState,
  events: readonly Event[],
  now = 1000,
): SessionState {
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
  const codes = rejects(r.effects).map((e) => e.code);
  assert.ok(codes.includes(code), `expected ${code}, got [${codes.join(", ")}]`);
}

function must<T>(x: T | undefined | null, what = "value"): T {
  assert.ok(x !== undefined && x !== null, `expected ${what}`);
  return x;
}

const act = (id: string, kind: Activity["kind"] = "manual"): Activity => ({
  id,
  title: id,
  kind,
  spotCap: 2,
});

const ACTIVITIES = [act("ttx"), act("trivia", "trivia"), act("arcade", "arcade")];

const PIDS = ["p1", "p2", "p3"];

function q(correct = 2, basePoints = 1000): Question {
  return {
    text: "Which one?",
    answers: ["A1", "A2", "A3", "A4"],
    timeLimitSec: 20,
    correct: [correct],
    note: "because",
    round: null,
    basePoints,
  };
}

const QUESTIONS = [q(), q(), q()];
const TIEBREAKERS = [q(1, 0), q(3, 0)];

function draft(): SessionState {
  return newSession({
    sid: "s1",
    title: "Huddle",
    joinCode: "hvs.aaaabbbbccccddddeeeeffff",
    activities: ACTIVITIES,
  });
}

function lobby(pids: readonly ParticipantId[] = PIDS): SessionState {
  return accept(draft(), [
    { type: "open" },
    ...pids.map((pid, i): Event => ({ type: "join", pid, nickname: `Player ${i + 1}` })),
  ]);
}

function running(pids: readonly ParticipantId[] = PIDS): SessionState {
  return accept(lobby(pids), [{ type: "start" }]);
}

function trivia(s: SessionState): TriviaState {
  return must(s.trivia, "trivia state");
}

function arcade(s: SessionState): ArcadeState {
  return must(s.arcade, "arcade state");
}

/**
 * The state of a session that has actually been played: a trivia question
 * asked, answered, closed and revealed; a Recruitment round entered, played,
 * ended and revealed; a Spot Award granted; a score typed by hand; the board
 * sealed; the holding card up; joins locked.
 *
 * Every assertion about what a restart *clears* is made against this, so that
 * "the scores are gone" means the scores that were really there and not an
 * empty map that was always empty.
 */
function played(pids: readonly ParticipantId[] = PIDS): SessionState {
  let s = accept(running(pids), [
    { type: "loadTrivia", activityId: "trivia", questions: QUESTIONS, tiebreakers: TIEBREAKERS },
    { type: "setSegment", segment: "trivia" },
    { type: "openQuestion", suddenDeath: false },
  ]);
  s = accept(s, [
    { type: "answerQuestion", pid: "p1", choice: 2, ms: 500 },
    { type: "answerQuestion", pid: "p2", choice: 0, ms: 900 },
  ]);
  s = accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }]);
  s = accept(s, [
    { type: "setSegment", segment: "arcade" },
    { type: "enterArcade", activityId: "arcade" },
    { type: "startRound", round: "recruitment", config: recruitmentRound(undefined, 20) },
    { type: "beginPlay" },
  ]);
  s = accept(s, [{ type: "endRound" }, { type: "revealRound" }]);
  return accept(s, [
    { type: "setScore", activityId: "ttx", pid: "p1", raw: 12 },
    { type: "setStatus", activityId: "ttx", pid: "p3", status: "bench" },
    { type: "grantSpot", pid: "p2", activityId: "ttx", reason: "carried the room" },
    { type: "setHolding", holding: { title: "Back shortly", line: "two minutes" } },
    { type: "setSeal", seal: "sealed" },
    { type: "setJoinsLocked", locked: true },
  ]);
}

/** Every phase a restart has to work from, built the way a host reaches it. */
const FROM: Readonly<Record<Exclude<SessionPhase, "draft">, () => SessionState>> = {
  lobby: () => lobby(),
  running: () => played(),
  closed: () => accept(played(), [{ type: "close" }]),
};

/* ------------------------------------------------------------------ */
/* The fixture itself is the premise of every test below                */
/* ------------------------------------------------------------------ */

describe("a session that has been played", () => {
  test("really has scores, spots, trivia progress and an arcade on it", () => {
    const s = played();
    assert.ok(must(s.scores["trivia"])["p1"], "p1 scored in trivia");
    assert.ok(must(s.scores["arcade"])["p1"], "p1 has an arcade score");
    assert.equal(must(s.scores["ttx"])["p1"]?.raw, 12);
    assert.equal(must(s.scores["ttx"])["p3"]?.status, "bench");
    assert.equal(s.spots.length, 1);
    assert.equal(trivia(s).phase, "revealed");
    assert.ok(Object.keys(trivia(s).totals).length > 0, "trivia totals were banked");
    assert.deepEqual(arcade(s).playerNumbers, { p1: 1, p2: 2, p3: 3 });
    assert.ok(computeStandings(s).some((x) => x.total > 0), "somebody is on the board");
  });
});

/* ------------------------------------------------------------------ */
/* What a restart clears                                                */
/* ------------------------------------------------------------------ */

describe("restartSession clears", () => {
  for (const phase of ["lobby", "running", "closed"] as const) {
    test(`every score, from ${phase}`, () => {
      const before = FROM[phase]();
      const s = accept(before, [{ type: "restartSession" }]);
      for (const a of s.activities) {
        assert.deepEqual(
          s.scores[a.id],
          {},
          `${a.id} should have no scores left`,
        );
      }
      assert.deepEqual(s.spots, [], "no Spot Awards left");
      assert.deepEqual(
        computeStandings(s).map((x) => x.total),
        [0, 0, 0],
        "nobody is on the board",
      );
    });

    test(`the arcade entirely, from ${phase}`, () => {
      const s = accept(FROM[phase](), [{ type: "restartSession" }]);
      assert.equal(s.arcade, null);
    });

    test(`trivia progress but not the questions, from ${phase}`, () => {
      const before = FROM[phase]();
      const s = accept(before, [{ type: "restartSession" }]);
      if (before.trivia === null) {
        assert.equal(s.trivia, null, "nothing loaded stays nothing loaded");
        return;
      }
      const t = trivia(s);
      assert.deepEqual(t.questions, QUESTIONS, "the set is still loaded");
      assert.deepEqual(t.tiebreakers, TIEBREAKERS, "so is the sudden-death pool");
      assert.equal(t.activityId, "trivia");
      assert.equal(t.at, 0, "back to question 1");
      assert.equal(t.phase, "idle");
      assert.equal(t.opensAt, null);
      assert.equal(t.closesAt, null);
      assert.equal(t.tiebreakAt, 0);
      assert.equal(t.tiebreakUsed, 0);
      assert.equal(t.tiebreakHeld, null);
      assert.equal(t.suddenDeath, false);
      assert.equal(t.suddenDeathWinner, null);
      assert.deepEqual(t.answers, {});
      assert.deepEqual(t.totals, {});
      assert.deepEqual(t.streaks, {});
    });

    test(`the seal, the segment, the holding card and the lock, from ${phase}`, () => {
      const s = accept(FROM[phase](), [{ type: "restartSession" }]);
      assert.equal(s.phase, "lobby");
      assert.equal(s.segment, "lobby");
      assert.equal(s.seal, "live");
      assert.equal(s.holding, null);
      assert.equal(s.joinsLocked, false);
    });
  }

  test("a score for an activity the list no longer mentions", () => {
    // A log-only recovery builds a state with an empty activity list, so a
    // bucket can outlive the activity that made it. Nothing may survive a
    // restart just because the list forgot about it.
    const s = played();
    const orphaned: SessionState = {
      ...s,
      activities: [],
      scores: { ...s.scores, ghost: { p1: { raw: 99, status: "played" } } },
    };
    const after = accept(orphaned, [{ type: "restartSession" }]);
    for (const [id, bucket] of Object.entries(after.scores)) {
      assert.deepEqual(bucket, {}, `${id} should be empty`);
    }
    assert.deepEqual(Object.keys(after.scores).sort(), ["arcade", "ghost", "trivia", "ttx"]);
  });

  test("nothing is left half-cleared: no projection can see a played session", () => {
    // The one property a participant's screen depends on at the instant a
    // restart lands. Trivia idle at question 1 with a live seal and no arcade
    // is a lobby; any one of these still set would be a phone rendering the
    // middle of an activity that no longer exists.
    const s = accept(FROM.running(), [{ type: "restartSession" }]);
    assert.equal(s.segment, "lobby");
    assert.equal(s.arcade, null);
    assert.equal(trivia(s).phase, "idle");
    assert.equal(s.seal, "live");
    assert.equal(
      Object.values(s.scores).reduce((n, b) => n + Object.keys(b).length, 0),
      0,
    );
  });
});

/* ------------------------------------------------------------------ */
/* What a restart keeps                                                 */
/* ------------------------------------------------------------------ */

describe("restartSession keeps", () => {
  for (const phase of ["lobby", "running", "closed"] as const) {
    test(`the room, from ${phase}`, () => {
      const before = FROM[phase]();
      const s = accept(before, [{ type: "restartSession" }]);
      assert.deepEqual(
        s.participants,
        before.participants,
        "nobody rejoins, nobody is renamed, nobody's number moves",
      );
      assert.equal(s.nextPlayerNumber, before.nextPlayerNumber);
    });

    test(`the session's identity, from ${phase}`, () => {
      const before = FROM[phase]();
      const s = accept(before, [{ type: "restartSession" }]);
      assert.equal(s.sid, before.sid);
      assert.equal(s.title, before.title);
      assert.equal(s.joinCode, before.joinCode, "nobody is sent a new code");
      assert.deepEqual(s.activities, before.activities);
      assert.deepEqual(s.tiebreakOrder, before.tiebreakOrder);
    });
  }

  test("a kick, which is a decision about a person and not a score", () => {
    const s = accept(played(), [{ type: "kick", pid: "p3" }]);
    const after = accept(s, [{ type: "restartSession" }]);
    assert.equal(must(after.participants["p3"]).kicked, true);
  });

  test("who is connected, which the restart has no opinion about", () => {
    const s = accept(played(), [{ type: "disconnect", pid: "p2" }]);
    const after = accept(s, [{ type: "restartSession" }]);
    assert.equal(must(after.participants["p1"]).connected, true);
    assert.equal(must(after.participants["p2"]).connected, false);
  });
});

/* ------------------------------------------------------------------ */
/* Player numbers                                                       */
/* ------------------------------------------------------------------ */

describe("restartSession and arcade player numbers", () => {
  test("the register goes, because the arcade it belonged to is over", () => {
    const s = accept(played(), [{ type: "restartSession" }]);
    assert.equal(s.arcade, null, "no register, so no number to be out of date");
  });

  test("re-entering deals the same roster the same numbers", () => {
    // SPEC.md's promise is that a number holds for the whole arcade, and a
    // restart ends that arcade. It still should not *look* arbitrary: the
    // numbers come from roster order, which is join order, which a restart
    // does not touch.
    const before = played();
    const restarted = accept(before, [{ type: "restartSession" }]);
    const again = accept(restarted, [
      { type: "start" },
      { type: "enterArcade", activityId: "arcade" },
    ]);
    assert.deepEqual(arcade(again).playerNumbers, arcade(before).playerNumbers);
  });

  test("somebody who arrived mid-arcade takes their place in join order", () => {
    // The one case where a number does move, and the honest answer for a room
    // that is starting again: appended at the end first time round because the
    // arcade had already begun, in join order the second.
    const base = accept(running(["p1", "p2"]), [
      { type: "enterArcade", activityId: "arcade" },
    ]);
    const late = accept(base, [
      { type: "join", pid: "p0", nickname: "Latecomer" },
      { type: "enterArcade", activityId: "arcade" },
    ]);
    assert.equal(arcade(late).playerNumbers["p0"], 3, "appended, not inserted");

    const again = accept(late, [
      { type: "restartSession" },
      { type: "start" },
      { type: "enterArcade", activityId: "arcade" },
    ]);
    // p0 joined third, so join order still puts them third. The number is the
    // same here — what changed is that it is now derived rather than appended.
    assert.deepEqual(arcade(again).playerNumbers, { p1: 1, p2: 2, p0: 3 });
  });
});

/* ------------------------------------------------------------------ */
/* Phases and refusals                                                  */
/* ------------------------------------------------------------------ */

describe("restartSession phases", () => {
  test("a closed session comes back, which is the whole reason it is exempt", () => {
    const closed = FROM.closed();
    assert.equal(closed.phase, "closed");
    const s = accept(closed, [{ type: "restartSession" }]);
    assert.equal(s.phase, "lobby");
    // And it is a lobby that works: the host can start it again.
    assert.equal(accept(s, [{ type: "start" }]).phase, "running");
  });

  test("a draft is refused — there is nothing to clear", () => {
    const d = draft();
    assertRefused(d, run(d, { type: "restartSession" }), "wrong_phase");
  });

  test("a restarted session accepts joins again", () => {
    const s = accept(FROM.closed(), [{ type: "restartSession" }]);
    const joined = accept(s, [{ type: "join", pid: "p9", nickname: "Newcomer" }]);
    assert.equal(must(joined.participants["p9"]).nickname, "Newcomer");
  });

  test("restarting twice is allowed and lands in the same place", () => {
    const once = accept(played(), [{ type: "restartSession" }]);
    const twice = accept(once, [{ type: "restartSession" }]);
    assert.deepEqual({ ...twice, seq: 0 }, { ...once, seq: 0 });
  });

  test("it broadcasts to the room, moves the standings and persists", () => {
    const r = run(played(), { type: "restartSession" });
    assert.ok(
      r.effects.some((e) => e.kind === "broadcast" && e.to === "all" && e.what === "state"),
      "everyone's screen has to change",
    );
    assert.ok(
      r.effects.some((e) => e.kind === "broadcast" && e.what === "standings"),
      "the board just emptied",
    );
    assert.ok(r.effects.some((e) => e.kind === "persist"), "a wipe has to be durable");
  });
});

/* ------------------------------------------------------------------ */
/* reopen                                                               */
/* ------------------------------------------------------------------ */

describe("reopen", () => {
  test("a closed session carries on with every score intact", () => {
    const closed = FROM.closed();
    const totals = computeStandings(closed).map((x) => [x.pid, x.total]);
    const s = accept(closed, [{ type: "reopen" }]);
    assert.equal(s.phase, "running");
    assert.deepEqual(computeStandings(s).map((x) => [x.pid, x.total]), totals);
    assert.deepEqual(s.scores, closed.scores);
    assert.deepEqual(s.spots, closed.spots);
    assert.deepEqual(s.trivia, closed.trivia);
    assert.deepEqual(s.arcade, closed.arcade);
    assert.deepEqual(s.participants, closed.participants);
  });

  test("it unlocks joining, which close locked as a side effect", () => {
    const s = accept(FROM.closed(), [{ type: "reopen" }]);
    assert.equal(s.joinsLocked, false);
    assert.equal(
      must(accept(s, [{ type: "join", pid: "p9", nickname: "Newcomer" }]).participants["p9"])
        .nickname,
      "Newcomer",
    );
  });

  test("it leaves the segment and the seal where the close put them", () => {
    // Deliberate: the room has already seen the final and already seen the
    // scoreboard, and the state carries no memory of where they were before.
    // Both are one press away on the console.
    const s = accept(FROM.closed(), [{ type: "reopen" }]);
    assert.equal(s.segment, "final");
    assert.equal(s.seal, "revealed");
    assert.equal(accept(s, [{ type: "setSegment", segment: "trivia" }]).segment, "trivia");
    assert.equal(accept(s, [{ type: "setSeal", seal: "live" }]).seal, "live");
  });

  test("the session runs again: a question can be opened after a reopen", () => {
    const s = accept(FROM.closed(), [
      { type: "reopen" },
      { type: "setSegment", segment: "trivia" },
      { type: "nextQuestion" },
      { type: "openQuestion", suddenDeath: false },
    ]);
    assert.equal(trivia(s).phase, "open");
    assert.equal(trivia(s).at, 1, "the set picks up where it was");
  });

  test("it is refused on a session that is not closed", () => {
    for (const s of [draft(), lobby(), running(), played()]) {
      assertRefused(s, run(s, { type: "reopen" }), "wrong_phase");
    }
  });

  test("a restart after a reopen is still a clean lobby", () => {
    const s = accept(FROM.closed(), [{ type: "reopen" }, { type: "restartSession" }]);
    assert.equal(s.phase, "lobby");
    assert.deepEqual(s.scores["trivia"], {});
  });
});

/* ------------------------------------------------------------------ */
/* Replay                                                               */
/* ------------------------------------------------------------------ */

describe("replay", () => {
  /** The whole afternoon, plus a close, a reopen, a second close and a wipe. */
  function log(): { event: Event; at: number }[] {
    const events: Event[] = [
      { type: "open" },
      ...PIDS.map((pid, i): Event => ({ type: "join", pid, nickname: `Player ${i + 1}` })),
      { type: "start" },
      { type: "loadTrivia", activityId: "trivia", questions: QUESTIONS, tiebreakers: TIEBREAKERS },
      { type: "setSegment", segment: "trivia" },
      { type: "openQuestion", suddenDeath: false },
      { type: "answerQuestion", pid: "p1", choice: 2, ms: 400 },
      { type: "answerQuestion", pid: "p3", choice: 2, ms: 1200 },
      { type: "closeQuestion" },
      { type: "revealQuestion" },
      { type: "setSegment", segment: "arcade" },
      { type: "enterArcade", activityId: "arcade" },
      { type: "startRound", round: "recruitment", config: recruitmentRound(undefined, 20) },
      { type: "beginPlay" },
      { type: "submitAnswer", pid: "p2", answer: "terraform" },
      { type: "endRound" },
      { type: "revealRound" },
      { type: "grantSpot", pid: "p1", activityId: "ttx", reason: "spotted it" },
      { type: "setSeal", seal: "sealed" },
      { type: "close" },
      { type: "reopen" },
      { type: "close" },
      { type: "restartSession" },
      { type: "start" },
      { type: "setSegment", segment: "trivia" },
      { type: "openQuestion", suddenDeath: false },
      { type: "answerQuestion", pid: "p2", choice: 2, ms: 300 },
      { type: "closeQuestion" },
      { type: "revealQuestion" },
    ];
    return events.map((event, i) => ({ event, at: 1000 + i * 50 }));
  }

  test("a restarted session replays from its event log to the same state", () => {
    const entries = log();
    const stepped = entries.reduce((s, e) => run(s, e.event, e.at).state, draft());
    assert.deepEqual(replay(draft(), entries), stepped);
  });

  test("the replay is the state the room ended on, not the one it was wiped from", () => {
    const s = replay(draft(), log());
    assert.equal(s.phase, "running");
    assert.deepEqual(s.spots, [], "the Spot Award was granted before the wipe");
    // Only p2's post-restart answer is on the board. p1 and p3 answered the
    // same question before the wipe and are back to nothing.
    const totals = Object.fromEntries(computeStandings(s).map((x) => [x.pid, x.total]));
    assert.equal(totals["p1"], 0);
    assert.equal(totals["p3"], 0);
    assert.ok(must(totals["p2"]) > 0, "p2 answered after the restart");
    assert.equal(s.arcade, null, "the arcade was wiped and not re-entered");
    assert.deepEqual(trivia(s).questions, QUESTIONS, "and the set never had to be re-uploaded");
  });

  test("replaying the tail onto a snapshot taken across the wipe agrees", () => {
    // The shape recovery.ts actually uses: a snapshot, plus the events past
    // it. The cut is placed deliberately on the restart itself.
    const entries = log();
    const cut = entries.findIndex((e) => e.event.type === "restartSession");
    assert.ok(cut > 0, "the log has a restart in it");
    const snapshot = replay(draft(), entries.slice(0, cut));
    assert.deepEqual(replay(snapshot, entries.slice(cut)), replay(draft(), entries));
  });

  test("a snapshot taken just after the wipe replays the tail the same way", () => {
    const entries = log();
    const cut = entries.findIndex((e) => e.event.type === "restartSession") + 1;
    const snapshot = replay(draft(), entries.slice(0, cut));
    assert.equal(snapshot.phase, "lobby", "the snapshot is of a clean lobby");
    assert.deepEqual(replay(snapshot, entries.slice(cut)), replay(draft(), entries));
  });
});
