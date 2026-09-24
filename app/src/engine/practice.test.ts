/**
 * Practice: the games run and the board does not move.
 *
 * The room meeting Red Light, Green Light for the first time spends one run
 * learning that a tap during APPLY drains you. That is a lesson worth having
 * and a terrible thing to be scored on, so a round can be run once to learn it
 * and once for keeps.
 *
 * What these check, in order of what would be worst to get wrong: that a
 * practice round really does leave `scores` alone, that a real round after it
 * scores normally, that the host cannot flip the flag underneath a live
 * question, and that the activity still knows what everyone would have
 * scored — a practice run that shows nothing teaches nothing.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Activity, Effect, Event, RejectCode, SessionState } from "./types.ts";
import { newSession, reduce, replay } from "./reducer.ts";
import { computeStandings } from "./scoring.ts";
import { recruitmentRound } from "../arcade/recruitment.ts";

function rejects(effects: readonly Effect[]) {
  return effects.filter((e): e is Extract<Effect, { kind: "reject" }> => e.kind === "reject");
}

function accept(state: SessionState, events: readonly Event[], now = 1000): SessionState {
  return events.reduce((s, e) => {
    const r = reduce(s, e, now);
    assert.ok(!rejects(r.effects).length, `expected ${e.type} not to be rejected`);
    assert.equal(r.state.seq, s.seq + 1, `expected ${e.type} to be accepted`);
    return r.state;
  }, state);
}

function refused(state: SessionState, event: Event, code: RejectCode, now = 1000): void {
  const r = reduce(state, event, now);
  assert.deepEqual(r.state, state, "a refusal changes nothing");
  assert.ok(
    rejects(r.effects).some((e) => e.code === code),
    `expected ${code}, got [${rejects(r.effects).map((e) => e.code).join(", ")}]`,
  );
}

const ACT: Activity[] = [
  { id: "trivia", title: "trivia", kind: "trivia", spotCap: 2 },
  { id: "arcade", title: "arcade", kind: "manual", spotCap: 2 },
];

const QUESTIONS = [
  {
    text: "In what year was HashiCorp founded?",
    answers: ["2008", "2010", "2012", "2015"],
    timeLimitSec: 10,
    correct: [2],
    note: null,
    round: null,
    basePoints: 1000,
  },
  {
    text: "Which was HashiCorp's first product?",
    answers: ["Terraform", "Vagrant"],
    timeLimitSec: 10,
    correct: [1],
    note: null,
    round: null,
    basePoints: 1000,
  },
];

/** A session with two people in it and a question set loaded. */
function ready(): SessionState {
  return accept(
    newSession({ sid: "s", title: "t", joinCode: "hvs.aaa", activities: ACT }),
    [
      { type: "open" },
      { type: "join", pid: "p1", nickname: "alice" },
      { type: "join", pid: "p2", nickname: "bob" },
      { type: "start" },
      { type: "loadTrivia", activityId: "trivia", questions: QUESTIONS },
    ],
  );
}

/** Open a question, both answer correctly, close and reveal. */
function playOne(s: SessionState): SessionState {
  return accept(s, [
    { type: "openQuestion", suddenDeath: false },
    { type: "answerQuestion", pid: "p1", choice: 2, ms: 1000 },
    { type: "answerQuestion", pid: "p2", choice: 2, ms: 2000 },
    { type: "closeQuestion" },
    { type: "revealQuestion" },
  ]);
}

/** In the arcade with a round card up — the how-to-play, before any play. */
function cardUp(): SessionState {
  return accept(ready(), [
    { type: "enterArcade", activityId: "arcade" },
    { type: "startRound", round: "recruitment", config: recruitmentRound() },
  ]);
}

function boardTotal(s: SessionState): number {
  return Object.values(s.scores["trivia"] ?? {}).reduce((n, r) => n + r.raw, 0);
}

describe("a practice round", () => {
  test("leaves the board completely alone", () => {
    const s = playOne(accept(ready(), [{ type: "setPractice", on: true }]));
    assert.equal(boardTotal(s), 0, "practice reached the board");
    assert.deepEqual(s.scores["trivia"], {}, "practice wrote a bucket");
  });

  test("still tells the room what they would have scored", () => {
    // A practice run that shows nothing teaches nothing: the activity's own
    // totals are the feedback, and only `scores` is held back.
    const s = playOne(accept(ready(), [{ type: "setPractice", on: true }]));
    const totals = s.trivia?.totals ?? {};
    assert.ok((totals["p1"] ?? 0) > 0, "p1 scored nothing in the round itself");
    assert.ok(
      (totals["p1"] ?? 0) > (totals["p2"] ?? 0),
      "the faster answer should still be worth more",
    );
  });

  test("keeps the standings empty", () => {
    const practised = computeStandings(playOne(accept(ready(), [{ type: "setPractice", on: true }])));
    const real = computeStandings(playOne(ready()));
    // Both halves: the real run must put somebody on the board, or the
    // practice assertion below is true of an empty list and proves nothing.
    assert.ok(real.some((r) => r.total > 0), "the real run scored nobody");
    assert.equal(practised.length, real.length, "practice changed who is listed");
    for (const row of practised) assert.equal(row.total, 0, `${row.pid} scored in practice`);
  });

  test("does not stop the next question scoring for real", () => {
    // The whole point: learn it, then play it.
    let s = playOne(accept(ready(), [{ type: "setPractice", on: true }]));
    assert.equal(boardTotal(s), 0);
    s = accept(s, [{ type: "setPractice", on: false }, { type: "nextQuestion" }]);
    s = accept(s, [
      { type: "openQuestion", suddenDeath: false },
      { type: "answerQuestion", pid: "p1", choice: 1, ms: 1000 },
      { type: "closeQuestion" },
      { type: "revealQuestion" },
    ]);
    assert.ok(boardTotal(s) > 0, "the real question did not score");
  });

  test("scores normally when practice was never on", () => {
    assert.ok(boardTotal(playOne(ready())) > 0);
  });
});

describe("turning practice on and off", () => {
  test("is refused while a question is open", () => {
    const s = accept(ready(), [{ type: "openQuestion", suddenDeath: false }]);
    refused(s, { type: "setPractice", on: true }, "wrong_question_phase");
  });

  test("is refused while a question is closed but not yet revealed", () => {
    // The totals are settled and not yet banked — the exact window where the
    // flag would decide, retrospectively, whether the round counted.
    const s = accept(ready(), [
      { type: "openQuestion", suddenDeath: false },
      { type: "answerQuestion", pid: "p1", choice: 2, ms: 1000 },
      { type: "closeQuestion" },
    ]);
    refused(s, { type: "setPractice", on: true }, "wrong_question_phase");
  });

  test("is allowed once the question is revealed", () => {
    const s = playOne(ready());
    assert.equal(accept(s, [{ type: "setPractice", on: true }]).practice, true);
  });

  test("is allowed while an arcade round card is up", () => {
    // The card is the briefing, and the briefing is when the host decides the
    // room should learn this one first. Nothing has been played, so the flag
    // is not being asked to rule on anything after the fact.
    const s = cardUp();
    assert.equal(accept(s, [{ type: "setPractice", on: true }]).practice, true);
    assert.equal(accept(cardUp(), [
      { type: "setPractice", on: true },
      { type: "setPractice", on: false },
    ]).practice, false, "it only went one way");
  });

  test("is refused once the arcade round is running", () => {
    const s = accept(cardUp(), [{ type: "beginPlay" }]);
    refused(s, { type: "setPractice", on: true }, "wrong_round_phase");
  });

  test("does nothing when it is already that way", () => {
    const s = ready();
    assert.equal(reduce(s, { type: "setPractice", on: false }, 1000).state.seq, s.seq);
  });

  test("is off on a new session, and a restart turns it off again", () => {
    assert.equal(ready().practice, false);
    const s = accept(playOne(accept(ready(), [{ type: "setPractice", on: true }])), [
      { type: "restartSession" },
    ]);
    assert.equal(s.practice, false, "practice survived a restart");
  });
});

describe("practice across a replay", () => {
  test("a recovered session remembers it, and its scores", () => {
    const log: Event[] = [
      { type: "open" },
      { type: "join", pid: "p1", nickname: "alice" },
      { type: "start" },
      { type: "loadTrivia", activityId: "trivia", questions: QUESTIONS },
      { type: "setPractice", on: true },
      { type: "openQuestion", suddenDeath: false },
      { type: "answerQuestion", pid: "p1", choice: 2, ms: 1000 },
      { type: "closeQuestion" },
      { type: "revealQuestion" },
    ];
    const base = newSession({ sid: "s", title: "t", joinCode: "hvs.aaa", activities: ACT });
    const direct = accept(base, log);
    const replayed = replay(base, log.map((event) => ({ event, at: 1000 })));
    assert.equal(replayed.practice, true);
    assert.deepEqual(replayed.scores, direct.scores);
    assert.equal(boardTotal(replayed), 0, "a replayed practice round banked points");
  });
});
