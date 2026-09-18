/**
 * Reducer tests. `reduce(state, event, now) -> {state, effects}` is pure, so
 * every call here goes through `run`, which deep-freezes the input state and
 * checks it against a clone afterwards. Expected behaviour is taken from
 * SPEC.md ("Identity", "Session lifecycle", "Scoring", "Seal and reveal",
 * "Failure modes") and SCORING.md, not from reducer.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  Activity,
  Effect,
  Event,
  RejectCode,
  SessionState,
} from "./types.ts";
import { newSession, nicknameKey, reduce, replay } from "./reducer.ts";
import { computeStandings } from "./scoring.ts";

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

/** reduce() with the purity contract enforced on every call. */
function run(state: SessionState, event: Event, now = 1000) {
  const snapshot = structuredClone(state);
  deepFreeze(state);
  const result = reduce(state, event, now);
  assert.deepEqual(state, snapshot, `reduce(${event.type}) mutated its input state`);
  return result;
}

/** Apply events in order; every one must be accepted (seq must bump). */
function accept(state: SessionState, events: readonly Event[], now = 1000): SessionState {
  return events.reduce((s, e) => {
    const r = run(s, e, now);
    assert.equal(r.state.seq, s.seq + 1, `expected ${e.type} to be accepted`);
    assert.ok(!rejects(r.effects).length, `expected ${e.type} not to be rejected`);
    return r.state;
  }, state);
}

function rejects(effects: readonly Effect[]) {
  return effects.filter((e): e is Extract<Effect, { kind: "reject" }> => e.kind === "reject");
}

function rejectCodes(effects: readonly Effect[]): RejectCode[] {
  return rejects(effects).map((e) => e.code);
}

function has(effects: readonly Effect[], pred: (e: Effect) => boolean): boolean {
  return effects.some(pred);
}

const isPersist = (e: Effect) => e.kind === "persist";
const isBroadcast = (what: "state" | "standings" | "toast") => (e: Effect) =>
  e.kind === "broadcast" && e.what === what;

/** Rejected or no-op: same state object, same seq, no persist, no broadcast. */
function assertRefused(
  before: SessionState,
  r: { state: SessionState; effects: readonly Effect[] },
  code?: RejectCode | readonly RejectCode[],
) {
  assert.deepEqual(r.state, before, "state must be unchanged");
  assert.equal(r.state.seq, before.seq, "seq must not bump");
  assert.ok(!has(r.effects, isPersist), "nothing to persist");
  assert.ok(!has(r.effects, (e) => e.kind === "broadcast"), "nothing to broadcast");
  if (code !== undefined) {
    const codes = rejectCodes(r.effects);
    const wanted = typeof code === "string" ? [code] : code;
    assert.ok(
      codes.some((c) => wanted.includes(c)),
      `expected a reject with one of [${wanted.join(", ")}], got [${codes.join(", ")}]`,
    );
  }
}

function assertNoOp(before: SessionState, r: { state: SessionState; effects: readonly Effect[] }) {
  assertRefused(before, r);
  assert.deepEqual(r.effects, [], "a no-op emits no effects");
}

function act(id: string, spotCap = 2): Activity {
  return { id, title: id, kind: "manual", spotCap };
}

const ACTIVITIES = [act("ttx"), act("trivia"), act("arcade")];

function draft(activities: readonly Activity[] = ACTIVITIES): SessionState {
  return newSession({ sid: "s1", title: "Huddle", joinCode: "RAFT", activities });
}

function lobby(activities?: readonly Activity[]): SessionState {
  return accept(draft(activities), [{ type: "open" }]);
}

// Single-letter pids are fixtures, not nicknames — pad to clear the two-character minimum.
const join = (pid: string, nickname = pid.length >= 2 ? pid : pid + pid): Event => ({ type: "join", pid, nickname });

/** open, join the given pids, start. */
function running(pids: readonly string[] = ["p1", "p2", "p3"], activities?: readonly Activity[]) {
  return accept(lobby(activities), [...pids.map((p) => join(p)), { type: "start" }]);
}

function must<T>(x: T | undefined, what = "value"): T {
  assert.ok(x !== undefined, `expected ${what}`);
  return x;
}

function participant(state: SessionState, pid: string) {
  return must(state.participants[pid], `participant ${pid}`);
}

function score(state: SessionState, activityId: string, pid: string) {
  return state.scores[activityId]?.[pid];
}

function totalOf(state: SessionState, pid: string): number {
  return must(computeStandings(state).find((s) => s.pid === pid), `standing ${pid}`).total;
}

/* ------------------------------------------------------------------ */
/* newSession                                                           */
/* ------------------------------------------------------------------ */

describe("newSession", () => {
  test("starts in draft, live, unlocked, seq 0, player numbers from 1", () => {
    const s = draft();
    assert.equal(s.phase, "draft");
    assert.equal(s.seal, "live");
    assert.equal(s.joinsLocked, false);
    assert.equal(s.seq, 0);
    assert.equal(s.nextPlayerNumber, 1);
    assert.deepEqual(s.participants, {});
    assert.deepEqual(s.spots, []);
  });

  test("defaults the tiebreak order to the activity order, or takes the one given", () => {
    assert.deepEqual(draft().tiebreakOrder, ["ttx", "trivia", "arcade"]);
    const s = newSession({
      sid: "s",
      title: "t",
      joinCode: "PLAN",
      activities: ACTIVITIES,
      tiebreakOrder: ["trivia"],
    });
    assert.deepEqual(s.tiebreakOrder, ["trivia"]);
  });
});

/* ------------------------------------------------------------------ */
/* Purity and seq                                                       */
/* ------------------------------------------------------------------ */

describe("purity", () => {
  test("no event type mutates the input state, accepted or not", () => {
    const s = accept(running(), [
      { type: "setScore", activityId: "ttx", pid: "p1", raw: 10 },
      { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "r" },
    ]);
    const spotSeq = must(s.spots[0]).seq;
    const events: Event[] = [
      join("p9", "New"),
      join("p1"),
      join("p8", "p2"),
      { type: "disconnect", pid: "p1" },
      { type: "reconnect", pid: "p1" },
      { type: "open" },
      { type: "start" },
      { type: "setSegment", segment: "holding" },
      { type: "setSeal", seal: "sealed" },
      { type: "setHolding", holding: { title: "Break", line: "back at 2:40" } },
      { type: "setJoinsLocked", locked: true },
      { type: "setScore", activityId: "ttx", pid: "p2", raw: 5 },
      { type: "setScore", activityId: "nope", pid: "p2", raw: 5 },
      { type: "setStatus", activityId: "ttx", pid: "p3", status: "bench" },
      { type: "grantSpot", activityId: "ttx", pid: "p2", reason: "great" },
      { type: "grantSpot", activityId: "ttx", pid: "p2", reason: "  " },
      { type: "revokeSpot", seq: spotSeq },
      { type: "revokeSpot", seq: 999 },
      { type: "kick", pid: "p3" },
      { type: "releaseNickname", pid: "p2" },
      { type: "close" },
    ];
    for (const e of events) run(s, e); // `run` asserts non-mutation
  });

  test("is deterministic: the same inputs give deep-equal outputs", () => {
    const s = running();
    const e: Event = { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "x" };
    assert.deepEqual(run(s, e, 42), run(s, e, 42));
  });

  test("the clock only reaches state through `now`: joinedAt and spot.at", () => {
    const s = accept(lobby(), [join("p1")], 1234);
    assert.equal(participant(s, "p1").joinedAt, 1234);
    const r = run(accept(s, [{ type: "start" }]), { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "r" }, 5678);
    assert.equal(must(r.state.spots[0]).at, 5678);
  });
});

describe("seq", () => {
  test("increments by exactly one on each accepted event", () => {
    let s = draft();
    const before = s.seq;
    s = accept(s, [{ type: "open" }, join("p1"), join("p2"), { type: "start" }]);
    assert.equal(s.seq, before + 4);
  });

  test("does not increment on a rejected event", () => {
    const s = running();
    const r = run(s, { type: "setScore", activityId: "ghost", pid: "p1", raw: 1 });
    assert.ok(rejectCodes(r.effects).length > 0);
    assert.equal(r.state.seq, s.seq);
  });

  test("does not increment on a no-op event", () => {
    const s = running();
    assert.equal(run(s, { type: "setSegment", segment: s.segment }).state.seq, s.seq);
    assert.equal(run(s, { type: "setSeal", seal: s.seal }).state.seq, s.seq);
    assert.equal(run(s, { type: "setJoinsLocked", locked: false }).state.seq, s.seq);
    assert.equal(run(s, { type: "reconnect", pid: "p1" }).state.seq, s.seq);
  });
});

/* ------------------------------------------------------------------ */
/* Joining                                                              */
/* ------------------------------------------------------------------ */

describe("join", () => {
  test("in lobby: creates the participant with number 1, joinedAt = now, connected", () => {
    const s = lobby();
    const r = run(s, join("p1", "Kenji"), 777);
    assert.equal(r.state.seq, s.seq + 1);
    assert.deepEqual(participant(r.state, "p1"), {
      pid: "p1",
      nickname: "Kenji",
      nicknameKey: nicknameKey("Kenji"),
      playerNumber: 1,
      joinedAt: 777,
      connected: true,
      kicked: false,
    });
    assert.ok(has(r.effects, isBroadcast("state")));
    assert.ok(has(r.effects, isPersist));
    assert.deepEqual(rejectCodes(r.effects), []);
  });

  test("while running: late join is allowed and lands them in the roster", () => {
    const s = running(["p1"]);
    const r = run(s, join("late", "Late"));
    assert.equal(r.state.seq, s.seq + 1);
    assert.equal(participant(r.state, "late").playerNumber, 2);
  });

  test("in draft: refused, the code is not live yet", () => {
    const s = draft();
    assertRefused(s, run(s, join("p1")), "not_joinable");
    assert.equal(run(s, join("p1")).state.nextPlayerNumber, 1);
  });

  test("after close: refused", () => {
    const s = accept(running(), [{ type: "close" }]);
    assertRefused(s, run(s, join("new")), ["not_joinable", "session_closed"]);
  });

  test("while locked: a new nickname is refused", () => {
    const s = accept(running(), [{ type: "setJoinsLocked", locked: true }]);
    assertRefused(s, run(s, join("new")), "joins_locked");
  });

  test("while locked: rejoin still works for everyone already in", () => {
    // SPEC.md "The join code leaks": "Locked means no new nicknames, but
    // rejoin still works for everyone already in."
    const s = accept(running(["p1"]), [
      { type: "disconnect", pid: "p1" },
      { type: "setJoinsLocked", locked: true },
    ]);
    const r = run(s, join("p1"));
    assert.deepEqual(rejectCodes(r.effects), [], "a known pid rejoining under its own name is not a new nickname");
    assert.equal(participant(r.state, "p1").connected, true);
  });

  test("player numbers follow join order", () => {
    const s = accept(lobby(), [join("a", "Ana"), join("b", "Ben"), join("c", "Cy")]);
    assert.deepEqual(
      ["a", "b", "c"].map((p) => participant(s, p).playerNumber),
      [1, 2, 3],
    );
    assert.equal(s.nextPlayerNumber, 4);
  });

  test("a refused join does not consume a player number", () => {
    const s = accept(lobby(), [join("a", "Sam")]);
    const r = run(s, join("b", "sam"));
    assert.equal(r.state.nextPlayerNumber, 2);
    const next = accept(s, [join("c", "Cy")]);
    assert.equal(participant(next, "c").playerNumber, 2);
  });

  test("rejoin under the same pid keeps the original number and join time", () => {
    const s = accept(lobby(), [join("a", "Ana"), join("b", "Ben")], 100);
    const r = run(accept(s, [{ type: "disconnect", pid: "a" }]), join("a", "Ana"), 900);
    const a = participant(r.state, "a");
    assert.equal(a.playerNumber, 1);
    assert.equal(a.joinedAt, 100);
    assert.equal(a.connected, true);
    assert.equal(r.state.nextPlayerNumber, 3, "no number consumed");
    assert.deepEqual(rejectCodes(r.effects), []);
  });

  test("rejoin under the same pid and the same nickname does not collide with itself", () => {
    const s = accept(lobby(), [join("a", "Ana")]);
    const r = run(s, join("a", "ana"));
    assert.deepEqual(rejectCodes(r.effects), []);
    assert.equal(participant(r.state, "a").playerNumber, 1);
  });

  test("rejoin under the same pid may rename", () => {
    const s = accept(lobby(), [join("a", "Ana")]);
    const r = run(s, join("a", "Anastasia"));
    assert.equal(participant(r.state, "a").nickname, "Anastasia");
    assert.equal(participant(r.state, "a").playerNumber, 1);
  });

  test("stores the nickname trimmed", () => {
    const s = accept(lobby(), [join("a", "  Kenji  ")]);
    assert.equal(participant(s, "a").nickname, "Kenji");
  });

  describe("duplicate nickname", () => {
    for (const dup of ["Sam", "sam", "SAM", "S.A.M.", "Sam ", " sam", "s-a-m", "S a m"]) {
      test(`"${dup}" collides with "Sam"`, () => {
        const s = accept(lobby(), [join("a", "Sam")]);
        assertRefused(s, run(s, join("b", dup)), "nickname_taken");
      });
    }

    test("the refusal goes to the joiner, not the incumbent", () => {
      const s = accept(lobby(), [join("a", "Sam")]);
      const r = run(s, join("b", "sam"));
      assert.deepEqual(rejects(r.effects).map((e) => e.to), [{ pid: "b" }]);
    });

    test("genuinely different nicknames do not collide", () => {
      const s = accept(lobby(), [join("a", "Sam"), join("b", "Samuel"), join("c", "Sam2")]);
      assert.equal(Object.keys(s.participants).length, 3);
    });

    test("nicknameKey folds case, whitespace and punctuation", () => {
      assert.equal(nicknameKey("Sam"), nicknameKey("s.a.m."));
      assert.equal(nicknameKey("Kenji "), nicknameKey("kenji"));
      assert.notEqual(nicknameKey("Sam"), nicknameKey("Samuel"));
      assert.equal(nicknameKey("!!!"), "");
    });
  });

  describe("empty nickname", () => {
    for (const bad of ["", "   ", "\t\n", "...", "!!!", "- -"]) {
      test(`${JSON.stringify(bad)} is refused`, () => {
        const s = lobby();
        const r = run(s, join("p1", bad));
        assertRefused(s, r);
        assert.ok(rejectCodes(r.effects).length > 0, "a reject effect is emitted");
        assert.equal(r.state.participants["p1"], undefined);
      });
    }

    test("a one-character nickname is refused (two-character minimum)", () => {
      // SPEC.md "Identity": "the nickname field is free text with a
      // two-character minimum."
      const s = lobby();
      const r = run(s, join("p1", "A"));
      assertRefused(s, r);
      assert.ok(rejectCodes(r.effects).length > 0);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Release, kick, connection                                            */
/* ------------------------------------------------------------------ */

describe("releaseNickname", () => {
  test("then a fresh join with that nickname succeeds, and the old device is disconnected", () => {
    const s = accept(running(["p1"]), [join("kenji", "Kenji")]);
    assertRefused(s, run(s, join("kenji2", "Kenji")), "nickname_taken");

    const released = accept(s, [{ type: "releaseNickname", pid: "kenji" }]);
    assert.equal(participant(released, "kenji").connected, false);

    const r = run(released, join("kenji2", "Kenji"));
    assert.deepEqual(rejectCodes(r.effects), []);
    assert.equal(participant(r.state, "kenji2").nickname, "Kenji");
  });

  test("of an unknown pid is a no-op", () => {
    const s = running();
    assertNoOp(s, run(s, { type: "releaseNickname", pid: "ghost" }));
  });

  test("twice is a no-op the second time", () => {
    const s = accept(running(["p1"]), [{ type: "releaseNickname", pid: "p1" }]);
    assertNoOp(s, run(s, { type: "releaseNickname", pid: "p1" }));
  });

  test("the released participant's own scores stay with them", () => {
    const s = accept(running(["p1"]), [
      { type: "setScore", activityId: "ttx", pid: "p1", raw: 10 },
      { type: "releaseNickname", pid: "p1" },
    ]);
    assert.equal(score(s, "ttx", "p1")?.raw, 10);
  });
});

describe("kick", () => {
  test("marks the participant kicked and disconnected and removes them from standings", () => {
    const s = accept(running(["p1", "p2"]), [{ type: "kick", pid: "p2" }]);
    assert.equal(participant(s, "p2").kicked, true);
    assert.equal(participant(s, "p2").connected, false);
    assert.deepEqual(computeStandings(s).map((x) => x.pid), ["p1"]);
  });

  test("frees the nickname for someone else", () => {
    const s = accept(running(["p1"]), [join("a", "Sam"), { type: "kick", pid: "a" }]);
    const r = run(s, join("b", "Sam"));
    assert.deepEqual(rejectCodes(r.effects), []);
  });

  test("a kicked participant can rejoin under a different nickname and is no longer kicked", () => {
    // SPEC.md: "Kicked participants can rejoin under a different nickname
    // unless the lobby is locked." The browser keeps its token, so the
    // rejoin arrives under the same pid.
    const s = accept(running(["p1"]), [join("a", "asdf"), { type: "kick", pid: "a" }]);
    const r = run(s, join("a", "Sam"));
    assert.deepEqual(rejectCodes(r.effects), []);
    assert.equal(participant(r.state, "a").kicked, false, "rejoined, so not kicked");
    assert.ok(computeStandings(r.state).some((x) => x.pid === "a"), "back in the standings");
  });

  test("a kicked participant cannot rejoin while the lobby is locked", () => {
    const s = accept(running(["p1"]), [
      join("a", "asdf"),
      { type: "kick", pid: "a" },
      { type: "setJoinsLocked", locked: true },
    ]);
    assertRefused(s, run(s, join("a", "Sam")), "joins_locked");
  });

  test("of an unknown pid is a no-op", () => {
    const s = running();
    assertNoOp(s, run(s, { type: "kick", pid: "ghost" }));
  });

  test("twice is a no-op the second time", () => {
    const s = accept(running(), [{ type: "kick", pid: "p2" }]);
    assertNoOp(s, run(s, { type: "kick", pid: "p2" }));
  });

  test("a kicked participant's stale score does not cap the room", () => {
    const s = accept(running(["p1", "p2", "troll"]), [
      { type: "setScore", activityId: "ttx", pid: "troll", raw: 99_999 },
      { type: "setScore", activityId: "ttx", pid: "p1", raw: 10 },
      { type: "setScore", activityId: "ttx", pid: "p2", raw: 5 },
      { type: "kick", pid: "troll" },
    ]);
    assert.equal(totalOf(s, "p1"), 100);
    assert.equal(totalOf(s, "p2"), 50);
  });

  test("a score cannot be set for a kicked participant", () => {
    const s = accept(running(), [{ type: "kick", pid: "p3" }]);
    assertRefused(s, run(s, { type: "setScore", activityId: "ttx", pid: "p3", raw: 7 }), "unknown_participant");
  });

  test("a Spot Award cannot be granted to a kicked participant", () => {
    const s = accept(running(), [{ type: "kick", pid: "p3" }]);
    assertRefused(s, run(s, { type: "grantSpot", activityId: "ttx", pid: "p3", reason: "?" }), "unknown_participant");
  });
});

describe("disconnect / reconnect", () => {
  test("flip the flag and tell only the host", () => {
    const s = running(["p1"]);
    const d = run(s, { type: "disconnect", pid: "p1" });
    assert.equal(participant(d.state, "p1").connected, false);
    assert.equal(d.state.seq, s.seq + 1);
    assert.ok(!has(d.effects, (e) => e.kind === "broadcast" && e.to === "all"));
    const r = run(d.state, { type: "reconnect", pid: "p1" });
    assert.equal(participant(r.state, "p1").connected, true);
  });

  test("are no-ops when nothing changes or the pid is unknown", () => {
    const s = running(["p1"]);
    assertNoOp(s, run(s, { type: "reconnect", pid: "p1" }));
    assertNoOp(s, run(s, { type: "disconnect", pid: "ghost" }));
    const off = accept(s, [{ type: "disconnect", pid: "p1" }]);
    assertNoOp(off, run(off, { type: "disconnect", pid: "p1" }));
  });

  test("reconnect works after close, so people can screenshot the final standings", () => {
    const s = accept(running(["p1"]), [{ type: "disconnect", pid: "p1" }, { type: "close" }]);
    const r = run(s, { type: "reconnect", pid: "p1" });
    assert.equal(participant(r.state, "p1").connected, true);
  });

  test("a kicked participant cannot simply reconnect", () => {
    const s = accept(running(["p1"]), [{ type: "kick", pid: "p1" }]);
    const r = run(s, { type: "reconnect", pid: "p1" });
    assert.equal(participant(r.state, "p1").connected, false, "kicked means out until they rejoin");
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

describe("lifecycle", () => {
  test("open: draft -> lobby", () => {
    const r = run(draft(), { type: "open" });
    assert.equal(r.state.phase, "lobby");
    assert.equal(r.state.segment, "lobby");
    assert.equal(r.state.seq, 1);
    assert.ok(has(r.effects, isPersist));
  });

  test("open: refused from lobby, running and closed", () => {
    for (const s of [lobby(), running(), accept(running(), [{ type: "close" }])]) {
      assertRefused(s, run(s, { type: "open" }));
    }
  });

  test("start: lobby -> running", () => {
    const r = run(lobby(), { type: "start" });
    assert.equal(r.state.phase, "running");
  });

  test("start: refused from draft, running and closed", () => {
    for (const s of [draft(), running(), accept(running(), [{ type: "close" }])]) {
      assertRefused(s, run(s, { type: "start" }));
    }
  });

  test("close: freezes the session — final segment, revealed, joins locked", () => {
    const r = run(running(), { type: "close" });
    assert.equal(r.state.phase, "closed");
    assert.equal(r.state.segment, "final");
    assert.equal(r.state.seal, "revealed");
    assert.equal(r.state.joinsLocked, true);
  });

  test("close twice is a no-op", () => {
    const s = accept(running(), [{ type: "close" }]);
    assertNoOp(s, run(s, { type: "close" }));
  });

  test("the host can move between all six segments in any order while running", () => {
    let s = running();
    for (const seg of ["holding", "trivia", "standings", "holding", "arcade", "final", "lobby", "trivia"] as const) {
      const r = run(s, { type: "setSegment", segment: seg });
      assert.equal(r.state.segment, seg);
      assert.equal(r.state.seq, s.seq + 1);
      s = r.state;
    }
  });

  test("setSegment to the current segment is a no-op", () => {
    const s = accept(running(), [{ type: "setSegment", segment: "holding" }]);
    assertNoOp(s, run(s, { type: "setSegment", segment: "holding" }));
  });

  describe("after close, everything that changes the session is refused", () => {
    const closed = () =>
      accept(running(["p1", "p2"]), [
        { type: "setScore", activityId: "ttx", pid: "p1", raw: 10 },
        { type: "setScore", activityId: "ttx", pid: "p2", raw: 5 },
        { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "r" },
        { type: "setHolding", holding: { title: "Done", line: "thanks" } },
        { type: "close" },
      ]);

    const cases: [string, Event][] = [
      ["setSegment", { type: "setSegment", segment: "holding" }],
      ["setSeal", { type: "setSeal", seal: "sealed" }],
      ["setJoinsLocked", { type: "setJoinsLocked", locked: false }],
      ["setHolding", { type: "setHolding", holding: { title: "x", line: "y" } }],
      ["setScore (existing)", { type: "setScore", activityId: "ttx", pid: "p1", raw: 1 }],
      ["setScore (new)", { type: "setScore", activityId: "trivia", pid: "p2", raw: 1 }],
      ["setStatus", { type: "setStatus", activityId: "ttx", pid: "p2", status: "bench" }],
      ["grantSpot", { type: "grantSpot", activityId: "ttx", pid: "p2", reason: "late" }],
      ["kick", { type: "kick", pid: "p2" }],
      ["releaseNickname", { type: "releaseNickname", pid: "p2" }],
      ["start", { type: "start" }],
      ["open", { type: "open" }],
    ];

    for (const [name, e] of cases) {
      test(`${name} is refused after close`, () => {
        const s = closed();
        assertRefused(s, run(s, e));
      });
    }

    test("revokeSpot is refused after close: the final standings are frozen", () => {
      const s = closed();
      const seq = must(s.spots[0]).seq;
      assertRefused(s, run(s, { type: "revokeSpot", seq }));
    });

    test("standings are literally frozen: totals before and after an attempted score change match", () => {
      const s = closed();
      const before = computeStandings(s);
      const r = run(s, { type: "setScore", activityId: "ttx", pid: "p2", raw: 10 });
      assert.deepEqual(computeStandings(r.state), before);
    });

    test("a destructive command after close is rejected with an explanation, not silently ignored", () => {
      const s = closed();
      const r = run(s, { type: "setScore", activityId: "ttx", pid: "p2", raw: 10 });
      assert.deepEqual(rejectCodes(r.effects), ["session_closed"]);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Seal, holding, lock                                                  */
/* ------------------------------------------------------------------ */

describe("seal", () => {
  test("live -> sealed -> revealed, each a state change that re-sends standings", () => {
    let s = running();
    for (const seal of ["sealed", "revealed"] as const) {
      const r = run(s, { type: "setSeal", seal });
      assert.equal(r.state.seal, seal);
      assert.equal(r.state.seq, s.seq + 1);
      assert.ok(has(r.effects, isBroadcast("standings")));
      s = r.state;
    }
  });

  test("setting the seal it already has is a no-op", () => {
    const s = accept(running(), [{ type: "setSeal", seal: "sealed" }]);
    assertNoOp(s, run(s, { type: "setSeal", seal: "sealed" }));
  });

  test("unseal (sealed -> live) is allowed; the host makes the call", () => {
    const s = accept(running(), [{ type: "setSeal", seal: "sealed" }]);
    assert.equal(run(s, { type: "setSeal", seal: "live" }).state.seal, "live");
  });
});

describe("holding", () => {
  test("sets and clears the card", () => {
    const card = { title: "TTX in progress", line: "back at 2:40" };
    const s = accept(running(), [{ type: "setHolding", holding: card }]);
    assert.deepEqual(s.holding, card);
    const r = run(s, { type: "setHolding", holding: null });
    assert.equal(r.state.holding, null);
    assert.equal(r.state.seq, s.seq + 1);
  });

  test("clearing an already-empty card is a no-op", () => {
    const s = running();
    assert.equal(s.holding, null);
    assertNoOp(s, run(s, { type: "setHolding", holding: null }));
  });

  test("setting the identical card again is a no-op", () => {
    const card = { title: "Break", line: "back soon" };
    const s = accept(running(), [{ type: "setHolding", holding: card }]);
    assertNoOp(s, run(s, { type: "setHolding", holding: { ...card } }));
  });
});

describe("joins lock", () => {
  test("lock, refuse, unlock, accept", () => {
    const s = accept(running(["p1"]), [{ type: "setJoinsLocked", locked: true }]);
    assertRefused(s, run(s, join("p2")), "joins_locked");
    const open = accept(s, [{ type: "setJoinsLocked", locked: false }]);
    assert.deepEqual(rejectCodes(run(open, join("p2")).effects), []);
  });

  test("locking when already locked is a no-op", () => {
    const s = accept(running(), [{ type: "setJoinsLocked", locked: true }]);
    assertNoOp(s, run(s, { type: "setJoinsLocked", locked: true }));
  });

  test("locking in the lobby (before start) refuses new joins too", () => {
    const s = accept(lobby(), [{ type: "setJoinsLocked", locked: true }]);
    assertRefused(s, run(s, join("p1")), "joins_locked");
  });
});

/* ------------------------------------------------------------------ */
/* setScore                                                             */
/* ------------------------------------------------------------------ */

describe("setScore", () => {
  test("records a played raw score and re-sends standings", () => {
    const s = running();
    const r = run(s, { type: "setScore", activityId: "ttx", pid: "p1", raw: 18_400 });
    assert.deepEqual(score(r.state, "ttx", "p1"), { raw: 18_400, status: "played" });
    assert.equal(r.state.seq, s.seq + 1);
    assert.ok(has(r.effects, isBroadcast("standings")));
    assert.ok(has(r.effects, isPersist));
    assert.equal(totalOf(r.state, "p1"), 100);
  });

  test("overwrites (re-publish) a previous score", () => {
    const s = accept(running(), [{ type: "setScore", activityId: "ttx", pid: "p1", raw: 5 }]);
    const r = run(s, { type: "setScore", activityId: "ttx", pid: "p1", raw: 9 });
    assert.equal(score(r.state, "ttx", "p1")?.raw, 9);
  });

  test("the same score again is a no-op", () => {
    const s = accept(running(), [{ type: "setScore", activityId: "ttx", pid: "p1", raw: 5 }]);
    assertNoOp(s, run(s, { type: "setScore", activityId: "ttx", pid: "p1", raw: 5 }));
  });

  test("for an activity that does not exist is refused", () => {
    const s = running();
    assertRefused(s, run(s, { type: "setScore", activityId: "ghost", pid: "p1", raw: 5 }), "unknown_activity");
    assert.equal(run(s, { type: "setScore", activityId: "ghost", pid: "p1", raw: 5 }).state.scores["ghost"], undefined);
  });

  test("for a participant that does not exist is refused", () => {
    const s = running();
    assertRefused(s, run(s, { type: "setScore", activityId: "ttx", pid: "ghost", raw: 5 }), "unknown_participant");
  });

  test("zero is a legitimate raw score", () => {
    const s = accept(running(), [
      { type: "setScore", activityId: "ttx", pid: "p1", raw: 0 },
      { type: "setScore", activityId: "ttx", pid: "p2", raw: 4 },
    ]);
    assert.equal(totalOf(s, "p1"), 0);
    assert.equal(totalOf(s, "p2"), 100);
  });

  test("fractional raw scores are accepted", () => {
    const s = accept(running(), [
      { type: "setScore", activityId: "ttx", pid: "p1", raw: 2.5 },
      { type: "setScore", activityId: "ttx", pid: "p2", raw: 5 },
    ]);
    assert.equal(totalOf(s, "p1"), 50);
  });

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    test(`a raw of ${bad} is refused: it is not a score and it poisons the standings`, () => {
      const s = accept(running(), [{ type: "setScore", activityId: "ttx", pid: "p2", raw: 10 }]);
      const r = run(s, { type: "setScore", activityId: "ttx", pid: "p1", raw: bad });
      assertRefused(s, r);
      for (const st of computeStandings(r.state)) {
        assert.ok(Number.isFinite(st.total), `${st.pid} total ${st.total}`);
      }
    });
  }

  test("a raw score can be given to a late joiner who is unset elsewhere", () => {
    const s = accept(running(["p1"]), [join("late"), { type: "setScore", activityId: "trivia", pid: "late", raw: 3 }]);
    assert.equal(score(s, "trivia", "late")?.status, "played");
    assert.equal(score(s, "ttx", "late"), undefined);
  });
});

/* ------------------------------------------------------------------ */
/* setStatus                                                            */
/* ------------------------------------------------------------------ */

describe("setStatus", () => {
  test("bench discards the raw score", () => {
    const s = accept(running(), [{ type: "setScore", activityId: "ttx", pid: "p1", raw: 50 }]);
    const r = run(s, { type: "setStatus", activityId: "ttx", pid: "p1", status: "bench" });
    assert.deepEqual(score(r.state, "ttx", "p1"), { raw: 0, status: "bench" });
    assert.equal(r.state.seq, s.seq + 1);
    assert.ok(has(r.effects, isBroadcast("standings")));
  });

  test("bench then played does not resurrect the old raw", () => {
    const s = accept(running(), [
      { type: "setScore", activityId: "ttx", pid: "p1", raw: 50 },
      { type: "setStatus", activityId: "ttx", pid: "p1", status: "bench" },
      { type: "setStatus", activityId: "ttx", pid: "p1", status: "played" },
    ]);
    assert.notEqual(score(s, "ttx", "p1")?.raw, 50);
  });

  test("bench removes them from the ceiling and credits their average", () => {
    const s = accept(running(["fac", "a", "b"]), [
      { type: "setScore", activityId: "ttx", pid: "fac", raw: 1000 },
      { type: "setScore", activityId: "ttx", pid: "a", raw: 10 },
      { type: "setScore", activityId: "ttx", pid: "b", raw: 5 },
      { type: "setScore", activityId: "trivia", pid: "fac", raw: 90 },
      { type: "setScore", activityId: "trivia", pid: "a", raw: 100 },
      { type: "setStatus", activityId: "ttx", pid: "fac", status: "bench" },
    ]);
    assert.equal(totalOf(s, "a"), 100 + 100);
    assert.equal(totalOf(s, "b"), 50);
    assert.equal(totalOf(s, "fac"), 90 + 90);
  });

  test("benching before any score exists is allowed (facilitators are benched in setup)", () => {
    const s = running(["fac"]);
    const r = run(s, { type: "setStatus", activityId: "ttx", pid: "fac", status: "bench" });
    assert.equal(score(r.state, "ttx", "fac")?.status, "bench");
  });

  test("the same status again is a no-op", () => {
    const s = accept(running(), [{ type: "setStatus", activityId: "ttx", pid: "p1", status: "bench" }]);
    assertNoOp(s, run(s, { type: "setStatus", activityId: "ttx", pid: "p1", status: "bench" }));
  });

  test("marking unset someone who has no entry is a no-op", () => {
    const s = running();
    assert.equal(score(s, "ttx", "p1"), undefined);
    assertNoOp(s, run(s, { type: "setStatus", activityId: "ttx", pid: "p1", status: "unset" }));
  });

  test("for an activity that does not exist is refused", () => {
    const s = running();
    assertRefused(s, run(s, { type: "setStatus", activityId: "ghost", pid: "p1", status: "bench" }), "unknown_activity");
  });

  test("for a participant that does not exist is refused", () => {
    const s = running();
    const r = run(s, { type: "setStatus", activityId: "ttx", pid: "ghost", status: "played" });
    assertRefused(s, r, "unknown_participant");
    assert.equal(score(r.state, "ttx", "ghost"), undefined, "no phantom score row");
  });
});

/* ------------------------------------------------------------------ */
/* Spot Awards                                                          */
/* ------------------------------------------------------------------ */

describe("grantSpot", () => {
  test("records the award with a trimmed reason, worth 10, and toasts everyone", () => {
    const s = running();
    const r = run(s, { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "  best recovery  " }, 99);
    assert.equal(r.state.spots.length, 1);
    const spot = must(r.state.spots[0]);
    assert.equal(spot.pid, "p1");
    assert.equal(spot.activityId, "ttx");
    assert.equal(spot.reason, "best recovery");
    assert.equal(spot.at, 99);
    assert.equal(r.state.seq, s.seq + 1);
    assert.equal(totalOf(r.state, "p1"), 10);
    assert.ok(has(r.effects, (e) => e.kind === "broadcast" && e.what === "toast" && e.to === "all"));
    assert.ok(has(r.effects, isBroadcast("standings")));
    assert.ok(has(r.effects, isPersist));
  });

  test("each award has a distinct seq so it can be revoked individually", () => {
    const s = accept(running(), [
      { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "a" },
      { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "b" },
    ]);
    const seqs = s.spots.map((x) => x.seq);
    assert.equal(new Set(seqs).size, 2);
  });

  for (const reason of ["", " ", "\t", "\n  \n"]) {
    test(`with reason ${JSON.stringify(reason)} is refused`, () => {
      const s = running();
      const r = run(s, { type: "grantSpot", activityId: "ttx", pid: "p1", reason });
      assertRefused(s, r, "reason_required");
      assert.deepEqual(r.state.spots, []);
    });
  }

  test("for an activity that does not exist is refused", () => {
    const s = running();
    assertRefused(s, run(s, { type: "grantSpot", activityId: "ghost", pid: "p1", reason: "r" }), "unknown_activity");
  });

  test("for a participant that does not exist is refused", () => {
    const s = running();
    assertRefused(s, run(s, { type: "grantSpot", activityId: "ttx", pid: "ghost", reason: "r" }), "unknown_participant");
  });

  test("a bench participant cannot receive that activity's award", () => {
    const s = accept(running(), [{ type: "setStatus", activityId: "ttx", pid: "p1", status: "bench" }]);
    assertRefused(s, run(s, { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "r" }), "bench_cannot_receive_spot");
  });

  test("a bench participant can still receive another activity's award", () => {
    const s = accept(running(), [{ type: "setStatus", activityId: "ttx", pid: "p1", status: "bench" }]);
    const r = run(s, { type: "grantSpot", activityId: "trivia", pid: "p1", reason: "r" });
    assert.deepEqual(rejectCodes(r.effects), []);
    assert.equal(r.state.spots.length, 1);
  });

  test("an unset participant (not scored yet) can receive an award", () => {
    const s = running();
    const r = run(s, { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "r" });
    assert.deepEqual(rejectCodes(r.effects), []);
  });

  test("benching someone after they were awarded removes the award's value for that activity", () => {
    // SCORING.md: "A participant on bench for an activity cannot receive
    // that activity's Spot Awards." Grant-then-bench must not be a way
    // around bench-then-grant.
    const s = accept(running(), [
      { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "r" },
      { type: "setStatus", activityId: "ttx", pid: "p1", status: "bench" },
    ]);
    assert.equal(totalOf(s, "p1"), 0);
  });

  describe("cap", () => {
    test("default cap is two per activity; the third is refused", () => {
      const s = accept(running(), [
        { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "one" },
        { type: "grantSpot", activityId: "ttx", pid: "p2", reason: "two" },
      ]);
      const r = run(s, { type: "grantSpot", activityId: "ttx", pid: "p3", reason: "three" });
      assertRefused(s, r, "spot_cap_reached");
      assert.equal(r.state.spots.length, 2);
    });

    test("is per activity: a full ttx does not block trivia", () => {
      const s = accept(running(), [
        { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "one" },
        { type: "grantSpot", activityId: "ttx", pid: "p2", reason: "two" },
      ]);
      const r = run(s, { type: "grantSpot", activityId: "trivia", pid: "p3", reason: "three" });
      assert.deepEqual(rejectCodes(r.effects), []);
    });

    test("the host can raise it", () => {
      const s = accept(running(["p1", "p2", "p3"], [act("ttx", 3)]), [
        { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "one" },
        { type: "grantSpot", activityId: "ttx", pid: "p2", reason: "two" },
        { type: "grantSpot", activityId: "ttx", pid: "p3", reason: "three" },
      ]);
      assert.equal(s.spots.length, 3);
      assertRefused(s, run(s, { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "four" }), "spot_cap_reached");
    });

    test("a cap of zero refuses every award", () => {
      const s = running(["p1"], [act("ttx", 0)]);
      assertRefused(s, run(s, { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "r" }), "spot_cap_reached");
    });

    test("revoking one frees a slot", () => {
      const s = accept(running(), [
        { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "one" },
        { type: "grantSpot", activityId: "ttx", pid: "p2", reason: "two" },
      ]);
      const revoked = accept(s, [{ type: "revokeSpot", seq: must(s.spots[0]).seq }]);
      assert.equal(revoked.spots.length, 1);
      assert.equal(totalOf(revoked, "p1"), 0);
      const r = run(revoked, { type: "grantSpot", activityId: "ttx", pid: "p3", reason: "three" });
      assert.deepEqual(rejectCodes(r.effects), []);
    });
  });
});

describe("revokeSpot", () => {
  test("of an unknown seq is a no-op", () => {
    const s = accept(running(), [{ type: "grantSpot", activityId: "ttx", pid: "p1", reason: "r" }]);
    assertNoOp(s, run(s, { type: "revokeSpot", seq: 424242 }));
  });

  test("removes only the named award", () => {
    const s = accept(running(), [
      { type: "grantSpot", activityId: "ttx", pid: "p1", reason: "a" },
      { type: "grantSpot", activityId: "trivia", pid: "p1", reason: "b" },
    ]);
    const [first, second] = s.spots;
    const r = run(s, { type: "revokeSpot", seq: must(first).seq });
    assert.deepEqual(r.state.spots, [second]);
    assert.ok(has(r.effects, isBroadcast("standings")));
  });
});

/* ------------------------------------------------------------------ */
/* Replay                                                               */
/* ------------------------------------------------------------------ */

describe("replay", () => {
  const log: { event: Event; at: number }[] = [
    { event: { type: "open" }, at: 1 },
    { event: join("p1", "Priya"), at: 2 },
    { event: join("p2", "Kenji"), at: 3 },
    { event: join("p3", "kenji"), at: 4 }, // rejected
    { event: join("p3", "Sam"), at: 5 },
    { event: { type: "start" }, at: 6 },
    { event: { type: "setSegment", segment: "holding" }, at: 7 },
    { event: { type: "setHolding", holding: { title: "TTX", line: "back at 2:40" } }, at: 8 },
    { event: { type: "setStatus", activityId: "ttx", pid: "p3", status: "bench" }, at: 9 },
    { event: { type: "setScore", activityId: "ttx", pid: "p1", raw: 18 }, at: 10 },
    { event: { type: "setScore", activityId: "ttx", pid: "p2", raw: 14 }, at: 11 },
    { event: { type: "setScore", activityId: "ttx", pid: "p2", raw: 14 }, at: 12 }, // no-op
    { event: { type: "grantSpot", activityId: "ttx", pid: "p2", reason: "best recovery" }, at: 13 },
    { event: { type: "grantSpot", activityId: "ttx", pid: "p3", reason: "x" }, at: 14 }, // bench: rejected
    { event: { type: "disconnect", pid: "p1" }, at: 15 },
    { event: join("p1", "Priya"), at: 16 },
    { event: { type: "setSeal", seal: "sealed" }, at: 17 },
    { event: { type: "setScore", activityId: "trivia", pid: "p3", raw: 9200 }, at: 18 },
    { event: { type: "setScore", activityId: "trivia", pid: "p1", raw: 18_400 }, at: 19 },
    { event: { type: "setJoinsLocked", locked: true }, at: 20 },
    { event: join("p4", "Late"), at: 21 }, // locked: rejected
    { event: { type: "close" }, at: 22 },
  ];

  test("reproduces the state reached by applying the events one at a time", () => {
    const stepped = log.reduce((s, e) => run(s, e.event, e.at).state, draft());
    const replayed = replay(draft(), log);
    assert.deepEqual(replayed, stepped);
    assert.equal(replayed.phase, "closed");
    assert.equal(Object.keys(replayed.participants).length, 3);
  });

  test("replaying the tail onto a mid-log snapshot gives the same result as the full log", () => {
    const cut = 12;
    const snapshot = replay(draft(), log.slice(0, cut));
    assert.deepEqual(replay(snapshot, log.slice(cut)), replay(draft(), log));
  });

  test("an empty log returns the initial state", () => {
    const s = draft();
    assert.deepEqual(replay(s, []), s);
  });

  test("the replayed standings are the ones the room saw", () => {
    const s = replay(draft(), log);
    const totals = Object.fromEntries(computeStandings(s).map((x) => [x.pid, x.total]));
    // ttx: p1 18 (100), p2 14 (78), p3 bench. trivia: p1 100, p3 50. spot: p2 +10.
    // p3's bench credit = mean of [50] = 50.
    assert.deepEqual(totals, { p1: 200, p2: 88, p3: 100 });
  });
});
