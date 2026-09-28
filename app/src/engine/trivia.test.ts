/**
 * Trivia tests. Every expected number here is computed by hand from SPEC.md
 * "Trivia" — `round(base × (1 − (t ÷ T) ÷ 2))` plus `100 × min(n − 1, 5)` —
 * and never by calling the code under test. Where SPEC.md is silent, the test
 * says which way the engine went and why.
 *
 * As in reducer.test.ts, every call goes through `run`, which deep-freezes the
 * input state and checks it against a clone afterwards: the engine is pure.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  Activity,
  Effect,
  Event,
  Question,
  RejectCode,
  SessionState,
  TriviaState,
} from "./types.ts";
import { newSession, reduce, replay } from "./reducer.ts";
import {
  autoBeat,
  autoBeatMs,
  autoFiresAt,
  clampBeatSeconds,
  currentQuestion,
  DEFAULT_BEAT_SECONDS,
  MAX_BEAT_SECONDS,
  MIN_BEAT_SECONDS,
  questionPoints,
  streakBonus,
} from "./trivia.ts";
import type { TriviaAutoAt } from "./trivia.ts";
import { DEFAULT_TIEBREAKERS } from "./tiebreak.ts";
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

function must<T>(x: T | undefined | null, what = "value"): T {
  assert.ok(x !== undefined && x !== null, `expected ${what}`);
  return x;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function act(id: string): Activity {
  return { id, title: id, kind: id === "trivia" ? "trivia" : "manual" };
}

const ACTIVITIES = [act("trivia"), act("arcade")];

interface QSpec {
  readonly answers?: number;
  readonly correct?: readonly number[];
  readonly timeLimitSec?: number;
  readonly basePoints?: number;
  readonly note?: string | null;
  readonly round?: string | null;
}

function q(spec: QSpec = {}): Question {
  const answers = spec.answers ?? 4;
  return {
    text: `Question with ${answers} answers`,
    answers: Array.from({ length: answers }, (_, i) => `A${i + 1}`),
    timeLimitSec: spec.timeLimitSec ?? 20,
    correct: spec.correct ?? [2],
    note: spec.note ?? null,
    round: spec.round ?? null,
    basePoints: spec.basePoints ?? 1000,
  };
}

const PIDS = ["p1", "p2", "p3"];

/**
 * A running session with three participants and `questions` loaded.
 *
 * The tiebreak pool is explicit and is built from the same `q()`, so that a
 * sudden death in these tests has the same shape of question as a scored one
 * and `choice: 2` means the same thing in both. The pool's own behaviour —
 * the built-in fallback, the flag that lifts a question out of the set, and
 * what happens when it runs out — is in "the tiebreak pool" below, where it
 * is the subject rather than the scenery.
 */
function loaded(
  questions: readonly Question[] = [q(), q(), q()],
  pids: readonly string[] = PIDS,
  tiebreakers: readonly Question[] = [q(), q()],
): SessionState {
  const base = accept(
    newSession({ sid: "s1", title: "Huddle", joinCode: "RAFT", activities: ACTIVITIES }),
    [
      { type: "open" },
      ...pids.map((pid): Event => ({ type: "join", pid, nickname: pid })),
      { type: "start" },
    ],
  );
  return accept(base, [
    { type: "loadTrivia", activityId: "trivia", questions, tiebreakers },
  ]);
}

function trivia(state: SessionState): TriviaState {
  return must(state.trivia, "trivia state");
}

/** open -> the given taps -> close. `ms` is the corrected response time. */
function playQuestion(
  state: SessionState,
  taps: Readonly<Record<string, { choice: number; ms: number }>>,
  opts: {
    readonly suddenDeath?: boolean;
    readonly openAt?: number;
    /**
     * Go on to the reveal. Points settle at the close but only reach `scores`
     * at the reveal — deliberately, so a phone's points strip cannot move
     * before the answer is public — so a test about `scores` asks for this.
     */
    readonly reveal?: boolean;
  } = {},
): SessionState {
  const openAt = opts.openAt ?? 1000;
  let s = accept(state, [{ type: "openQuestion", suddenDeath: opts.suddenDeath ?? false }], openAt);
  for (const [pid, tap] of Object.entries(taps)) {
    s = accept(s, [{ type: "answerQuestion", pid, choice: tap.choice, ms: tap.ms }], openAt + tap.ms);
  }
  s = accept(s, [{ type: "closeQuestion" }], openAt + 20_000);
  if (!opts.reveal) return s;
  return accept(s, [{ type: "revealQuestion" }], openAt + 20_100);
}

function totalOf(state: SessionState, pid: string): number {
  return trivia(state).totals[pid] ?? 0;
}

/* ------------------------------------------------------------------ */
/* The arithmetic, on its own                                          */
/* ------------------------------------------------------------------ */

describe("question points", () => {
  test("an instant correct answer is worth the full base", () => {
    // 1000 × (1 − (0 ÷ 20000) ÷ 2) = 1000
    assert.equal(questionPoints(1000, 0, 20), 1000);
  });

  test("a correct answer at the buzzer is worth exactly half, never less", () => {
    // 1000 × (1 − (20000 ÷ 20000) ÷ 2) = 500
    assert.equal(questionPoints(1000, 20_000, 20), 500);
    // Over the limit — the timer and the close event can race — still half.
    assert.equal(questionPoints(1000, 25_000, 20), 500);
  });

  test("hand-computed mid-timer values", () => {
    // 1000 × (1 − (5000 ÷ 20000) ÷ 2) = 1000 × 0.875 = 875
    assert.equal(questionPoints(1000, 5_000, 20), 875);
    // 1000 × (1 − (7000 ÷ 20000) ÷ 2) = 1000 × 0.825 = 825
    assert.equal(questionPoints(1000, 7_000, 20), 825);
    // 500 × (1 − (3000 ÷ 10000) ÷ 2) = 500 × 0.85 = 425
    assert.equal(questionPoints(500, 3_000, 10), 425);
    // 1000 × (1 − (10000 ÷ 30000) ÷ 2) = 1000 × 0.833… = 833.33 -> 833
    assert.equal(questionPoints(1000, 10_000, 30), 833);
  });

  test("an exact half rounds up", () => {
    // 1000 × (1 − (20 ÷ 20000) ÷ 2) = 999.5 -> 1000
    assert.equal(questionPoints(1000, 20, 20), 1000);
  });

  test("a warm-up is worth nothing however fast it is answered", () => {
    assert.equal(questionPoints(0, 0, 20), 0);
    assert.equal(questionPoints(0, 12_345, 20), 0);
  });

  test("a negative or unusable response time is treated as instant", () => {
    assert.equal(questionPoints(1000, -50, 20), 1000);
    assert.equal(questionPoints(1000, Number.NaN, 20), 1000);
  });
});

describe("streak bonus", () => {
  test("100 × min(n − 1, 5)", () => {
    assert.equal(streakBonus(1), 0);
    assert.equal(streakBonus(2), 100);
    assert.equal(streakBonus(3), 200);
    assert.equal(streakBonus(4), 300);
    assert.equal(streakBonus(5), 400);
    assert.equal(streakBonus(6), 500);
  });

  test("caps at five steps", () => {
    assert.equal(streakBonus(7), 500);
    assert.equal(streakBonus(20), 500);
  });
});

/* ------------------------------------------------------------------ */
/* loadTrivia                                                          */
/* ------------------------------------------------------------------ */

describe("loadTrivia", () => {
  test("loads a set at question one, idle, with no answers", () => {
    const s = loaded();
    const t = trivia(s);
    assert.equal(t.activityId, "trivia");
    assert.equal(t.questions.length, 3);
    assert.equal(t.at, 0);
    assert.equal(t.phase, "idle");
    assert.equal(t.opensAt, null);
    assert.equal(t.closesAt, null);
    assert.equal(t.suddenDeath, false);
    assert.equal(t.suddenDeathWinner, null);
    assert.deepEqual(t.answers, {});
    assert.deepEqual(t.totals, {});
    assert.deepEqual(t.streaks, {});
  });

  test("an unknown activity is refused", () => {
    const s = loaded();
    assertRefused(
      s,
      run(s, { type: "loadTrivia", activityId: "nope", questions: [q()] }),
      "unknown_activity",
    );
  });

  test("an empty set is refused", () => {
    const base = accept(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES }),
      [{ type: "open" }],
    );
    assertRefused(
      base,
      run(base, { type: "loadTrivia", activityId: "trivia", questions: [] }),
      "no_questions_loaded",
    );
  });

  // The reason to load twice is almost always that the first CSV was the
  // wrong file, caught in the dry run. Replacing then costs nothing.
  test("a second load replaces the set while nothing has been asked yet", () => {
    const s = loaded();
    const replacement = [q({ answers: 2 }), q({ answers: 3 })];
    const r = run(s, {
      type: "loadTrivia",
      activityId: "trivia",
      questions: replacement,
    });
    assert.deepEqual(rejectCodes(r.effects), []);
    assert.equal(trivia(r.state).questions.length, 2);
    // The replacement, not the original three.
    assert.deepEqual(
      trivia(r.state).questions.map((x) => x.answers.length),
      [2, 3],
    );
  });

  // ...but once a question has been asked, the banked totals were produced by
  // questions the replacement would not contain.
  test("a second load is refused once a question has been opened", () => {
    const s = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }]);
    assertRefused(
      s,
      run(s, { type: "loadTrivia", activityId: "trivia", questions: [q()] }),
      "trivia_already_started",
    );
  });

  test("still refused after that question is closed and revealed", () => {
    const s = accept(loaded(), [
      { type: "openQuestion", suddenDeath: false },
      { type: "closeQuestion" },
      { type: "revealQuestion" },
      { type: "nextQuestion" },
    ]);
    assertRefused(
      s,
      run(s, { type: "loadTrivia", activityId: "trivia", questions: [q()] }),
      "trivia_already_started",
    );
  });

  test("refused once the session is closed", () => {
    const s = accept(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES }),
      [{ type: "open" }, { type: "close" }],
    );
    assertRefused(
      s,
      run(s, { type: "loadTrivia", activityId: "trivia", questions: [q()] }),
      "session_closed",
    );
  });

  /**
   * `state.trivia` is one slot, not a map keyed by activity.
   *
   * This is the behaviour behind the rule that a session may configure at most
   * one `trivia` activity — `src/activities/import.ts` refuses a second one,
   * and this test is what that rule is protecting against. A second trivia
   * activity's set does not sit beside the first: it replaces it outright,
   * with nothing rejected and nothing said, leaving the first activity with no
   * questions and no error anybody saw. If the engine ever grows a slot per
   * activity, this test fails and that rule should be revisited rather than
   * kept out of habit.
   */
  test("a second trivia activity's set replaces the first's — the slot is single", () => {
    const two: readonly Activity[] = [
      act("trivia"),
      { id: "trivia-2", title: "trivia-2", kind: "trivia" },
    ];
    const s = accept(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: two }),
      [
        { type: "open" },
        { type: "join", pid: "p1", nickname: "p1" },
        { type: "start" },
        { type: "loadTrivia", activityId: "trivia", questions: [q(), q(), q()] },
      ],
    );
    assert.equal(trivia(s).activityId, "trivia");
    assert.equal(trivia(s).questions.length, 3);

    const r = run(s, { type: "loadTrivia", activityId: "trivia-2", questions: [q()] });
    assert.deepEqual(rejectCodes(r.effects), [], "nothing objects");
    // One slot: the second activity is the loaded one now, and the first has
    // no questions left at all.
    assert.equal(trivia(r.state).activityId, "trivia-2");
    assert.equal(trivia(r.state).questions.length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* openQuestion                                                        */
/* ------------------------------------------------------------------ */

describe("openQuestion", () => {
  test("sets opensAt and closesAt from now and the question's limit", () => {
    const s = accept(loaded([q({ timeLimitSec: 30 })]), [
      { type: "openQuestion", suddenDeath: false },
    ], 50_000);
    const t = trivia(s);
    assert.equal(t.phase, "open");
    assert.equal(t.opensAt, 50_000);
    assert.equal(t.closesAt, 50_000 + 30_000);
  });

  test("sudden death has no timer at all", () => {
    const s = accept(loaded(), [{ type: "openQuestion", suddenDeath: true }], 7_000);
    const t = trivia(s);
    assert.equal(t.suddenDeath, true);
    assert.equal(t.opensAt, 7_000);
    assert.equal(t.closesAt, null);
  });

  test("refused before a set is loaded", () => {
    const s = accept(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES }),
      [{ type: "open" }, { type: "start" }],
    );
    assertRefused(s, run(s, { type: "openQuestion", suddenDeath: false }), "no_questions_loaded");
  });

  test("refused before the session is running", () => {
    const base = accept(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES }),
      [{ type: "open" }, { type: "loadTrivia", activityId: "trivia", questions: [q()] }],
    );
    assertRefused(base, run(base, { type: "openQuestion", suddenDeath: false }), "wrong_phase");
  });

  test("refused while a question is already open", () => {
    const s = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }]);
    assertRefused(
      s,
      run(s, { type: "openQuestion", suddenDeath: false }),
      "wrong_question_phase",
    );
  });

  test("refused after the question has been revealed but not advanced", () => {
    let s = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }]);
    s = accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }]);
    assertRefused(
      s,
      run(s, { type: "openQuestion", suddenDeath: false }),
      "wrong_question_phase",
    );
  });
});

/* ------------------------------------------------------------------ */
/* answerQuestion                                                      */
/* ------------------------------------------------------------------ */

describe("answerQuestion", () => {
  const open = (questions?: readonly Question[]) =>
    accept(loaded(questions), [{ type: "openQuestion", suddenDeath: false }], 1000);

  test("records the tap, and tells nobody but the tapper, the host and the screen", () => {
    // The first tap of a question: `answers` has one key in it, so "every
    // phone that has locked in" and "the tapper" are the same socket. The tap
    // after this one is where the two part company — see below.
    const s = open();
    const r = run(s, { type: "answerQuestion", pid: "p1", choice: 2, ms: 4_000 }, 5_000);
    assert.ok(r.applied);
    const answer = must(trivia(r.state).answers["p1"], "answer");
    assert.equal(answer.choice, 2);
    assert.equal(answer.correct, true);
    assert.equal(answer.ms, 4_000);
    const audiences = r.effects
      .filter((e): e is Extract<Effect, { kind: "broadcast" }> => e.kind === "broadcast")
      .map((e) => JSON.stringify(e.to));
    assert.deepEqual(audiences.sort(), [
      JSON.stringify("host"),
      JSON.stringify("screen"),
      JSON.stringify({ pid: "p1" }),
    ].sort());
    assert.ok(r.effects.some((e) => e.kind === "persist"), "an answer must reach the event log");
  });

  test("tells the phones that have already locked in, so their count climbs", () => {
    // The answered count is on the phone from the moment it taps, and a count
    // that only moves when its own owner taps is a number that never moves.
    // So the audience is the console, the screen and every phone holding the
    // count — and no wider than that: a phone still deciding is not shown the
    // count, and its frame would be the one it already has.
    const s = accept(open(), [{ type: "answerQuestion", pid: "p1", choice: 2, ms: 1_000 }], 2_000);
    const r = run(s, { type: "answerQuestion", pid: "p2", choice: 0, ms: 4_000 }, 5_000);
    assert.ok(r.applied);
    const audiences = r.effects
      .filter((e): e is Extract<Effect, { kind: "broadcast" }> => e.kind === "broadcast")
      .map((e) => JSON.stringify(e.to));
    assert.deepEqual(audiences.sort(), [
      JSON.stringify("host"),
      JSON.stringify("screen"),
      JSON.stringify({ pid: "p1" }),
      JSON.stringify({ pid: "p2" }),
    ].sort());
    // p3 has not answered, and is deliberately not on the list.
    assert.ok(!audiences.includes(JSON.stringify({ pid: "p3" })), audiences.join(","));
  });

  test("scores nothing until the question closes — a phone must not turn green", () => {
    const s = accept(open(), [{ type: "answerQuestion", pid: "p1", choice: 2, ms: 0 }], 1000);
    const t = trivia(s);
    assert.equal(must(t.answers["p1"], "answer").points, 0);
    assert.equal(must(t.answers["p1"], "answer").streakBonus, 0);
    assert.deepEqual(t.totals, {}, "no total may move while the question is open");
    assert.deepEqual(t.streaks, {}, "no streak may move while the question is open");
    assert.deepEqual(s.scores["trivia"], {}, "nothing lands on the scoreboard yet");
  });

  test("one tap is final: the second is refused", () => {
    const s = accept(open(), [{ type: "answerQuestion", pid: "p1", choice: 0, ms: 500 }]);
    assertRefused(
      s,
      run(s, { type: "answerQuestion", pid: "p1", choice: 2, ms: 900 }),
      "already_answered",
    );
    assert.equal(must(trivia(s).answers["p1"], "answer").choice, 0, "the first tap stands");
  });

  test("a choice outside the question's answers is refused", () => {
    const s = open();
    for (const choice of [-1, 4, 99, 1.5, Number.NaN]) {
      assertRefused(
        s,
        run(s, { type: "answerQuestion", pid: "p1", choice, ms: 100 }),
        "invalid_choice",
      );
    }
  });

  test("a two-answer question refuses choice 2 and 3", () => {
    const s = open([q({ answers: 2, correct: [1] })]);
    assertRefused(s, run(s, { type: "answerQuestion", pid: "p1", choice: 2, ms: 1 }), "invalid_choice");
    const ok = accept(s, [{ type: "answerQuestion", pid: "p1", choice: 1, ms: 1 }]);
    assert.equal(must(trivia(ok).answers["p1"], "answer").correct, true);
  });

  test("a three-answer question refuses choice 3", () => {
    const s = open([q({ answers: 3, correct: [2] })]);
    assertRefused(s, run(s, { type: "answerQuestion", pid: "p1", choice: 3, ms: 1 }), "invalid_choice");
    const ok = accept(s, [{ type: "answerQuestion", pid: "p1", choice: 2, ms: 1 }]);
    assert.equal(must(trivia(ok).answers["p1"], "answer").correct, true);
  });

  test("any listed answer is correct on a multi-answer question", () => {
    const s = open([q({ correct: [1, 3] })]);
    const a = accept(s, [{ type: "answerQuestion", pid: "p1", choice: 1, ms: 0 }]);
    const b = accept(a, [{ type: "answerQuestion", pid: "p2", choice: 3, ms: 0 }]);
    const c = accept(b, [{ type: "answerQuestion", pid: "p3", choice: 2, ms: 0 }]);
    const t = trivia(c);
    assert.equal(must(t.answers["p1"], "p1").correct, true);
    assert.equal(must(t.answers["p2"], "p2").correct, true);
    assert.equal(must(t.answers["p3"], "p3").correct, false);
  });

  test("refused while the question is not open", () => {
    const idle = loaded();
    assertRefused(
      idle,
      run(idle, { type: "answerQuestion", pid: "p1", choice: 0, ms: 10 }),
      "question_not_open",
    );
    const closed = accept(open(), [{ type: "closeQuestion" }]);
    assertRefused(
      closed,
      run(closed, { type: "answerQuestion", pid: "p1", choice: 0, ms: 10 }),
      "question_not_open",
    );
  });

  test("refused for someone who is not here, or who was kicked", () => {
    const s = open();
    assertRefused(
      s,
      run(s, { type: "answerQuestion", pid: "ghost", choice: 0, ms: 10 }),
      "unknown_participant",
    );
    const kicked = accept(s, [{ type: "kick", pid: "p3" }]);
    assertRefused(
      kicked,
      run(kicked, { type: "answerQuestion", pid: "p3", choice: 0, ms: 10 }),
      "unknown_participant",
    );
  });

  test("the response time is clamped into [0, limit]", () => {
    const s = open([q({ timeLimitSec: 10 })]);
    const late = accept(s, [{ type: "answerQuestion", pid: "p1", choice: 2, ms: 11_500 }]);
    assert.equal(must(trivia(late).answers["p1"], "answer").ms, 10_000);
    const early = accept(late, [{ type: "answerQuestion", pid: "p2", choice: 2, ms: -300 }]);
    assert.equal(must(trivia(early).answers["p2"], "answer").ms, 0);
  });

  test("sudden death does not clamp: there is no limit to clamp to", () => {
    const s = accept(loaded([q({ timeLimitSec: 10 })]), [
      { type: "openQuestion", suddenDeath: true },
    ]);
    const t = accept(s, [{ type: "answerQuestion", pid: "p1", choice: 2, ms: 45_000 }]);
    assert.equal(must(trivia(t).answers["p1"], "answer").ms, 45_000);
  });
});

/* ------------------------------------------------------------------ */
/* closeQuestion — the scoring                                         */
/* ------------------------------------------------------------------ */

describe("closeQuestion", () => {
  test("pays the hand-computed points and nothing else", () => {
    // T = 20 s. p1 right at 5 s: 1000 × 0.875 = 875. p2 right at 20 s: 500.
    // p3 wrong: 0. Nobody has a streak yet, so no bonuses.
    const s = playQuestion(loaded(), {
      p1: { choice: 2, ms: 5_000 },
      p2: { choice: 2, ms: 20_000 },
      p3: { choice: 0, ms: 1_000 },
    });
    assert.equal(totalOf(s, "p1"), 875);
    assert.equal(totalOf(s, "p2"), 500);
    assert.equal(totalOf(s, "p3"), 0);
    const t = trivia(s);
    assert.equal(must(t.answers["p1"], "p1").points, 875);
    assert.equal(must(t.answers["p1"], "p1").streakBonus, 0);
    assert.equal(must(t.answers["p3"], "p3").points, 0);
    assert.equal(t.phase, "closed");
  });

  test("someone who never tapped scores nothing and stays off the board", () => {
    const s = playQuestion(loaded(), { p1: { choice: 2, ms: 0 } });
    assert.equal(trivia(s).totals["p2"], undefined);
    assert.equal(s.scores["trivia"]?.["p2"], undefined, "an untouched cell stays unset");
  });


  // The gap the close-to-reveal deferral exists for: a right answer and a
  // wrong one must be indistinguishable in `scores` until the reveal, because
  // the phone's points strip is projected from it.
  test("scores do not move at the close — only at the reveal", () => {
    const closed = playQuestion(loaded(), {
      p1: { choice: 2, ms: 5_000 },
      p3: { choice: 0, ms: 1_000 },
    });
    assert.equal(trivia(closed).phase, "closed");
    assert.equal(closed.scores["trivia"]?.["p1"], undefined, "right answer must not show at close");
    assert.equal(closed.scores["trivia"]?.["p3"], undefined, "wrong answer must not show at close");
    // The points exist on the trivia state — settled, just not published.
    assert.equal(must(trivia(closed).answers["p1"], "p1").points, 875);

    const revealed = accept(closed, [{ type: "revealQuestion" }], 30_000);
    assert.deepEqual(revealed.scores["trivia"]?.["p1"], { raw: 875, status: "played" });
    assert.deepEqual(revealed.scores["trivia"]?.["p3"], { raw: 0, status: "played" });
  });

  test("the total lands in the per-activity scores as an ordinary raw", () => {
    const s = playQuestion(
      loaded(),
      { p1: { choice: 2, ms: 5_000 }, p3: { choice: 0, ms: 1_000 } },
      { reveal: true },
    );
    assert.deepEqual(s.scores["trivia"]?.["p1"], { raw: 875, status: "played" });
    assert.deepEqual(s.scores["trivia"]?.["p3"], { raw: 0, status: "played" });
    // And the Phase 2 scoreboard normalises it with no special case: top raw
    // becomes 100.
    const standing = must(
      computeStandings(s).find((r) => r.pid === "p1"),
      "p1 standing",
    );
    assert.equal(standing.perActivity["trivia"]?.points, 100);
    assert.equal(standing.perActivity["trivia"]?.raw, 875);
  });

  test("refused when no question is open", () => {
    const idle = loaded();
    assertRefused(idle, run(idle, { type: "closeQuestion" }), "wrong_question_phase");
    const closed = accept(loaded(), [
      { type: "openQuestion", suddenDeath: false },
      { type: "closeQuestion" },
    ]);
    assertRefused(closed, run(closed, { type: "closeQuestion" }), "wrong_question_phase");
  });

  test("host early-close and the timer are the same event", () => {
    // Closing at 3 s, long before the 20 s limit, pays what was already earned.
    const s = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }], 1000);
    const answered = accept(s, [{ type: "answerQuestion", pid: "p1", choice: 2, ms: 2_000 }], 3_000);
    const closed = accept(answered, [{ type: "closeQuestion" }], 3_500);
    // 1000 × (1 − (2000 ÷ 20000) ÷ 2) = 1000 × 0.95 = 950
    assert.equal(totalOf(closed, "p1"), 950);
    // The clock is gone with the question: nothing counts down to a close
    // that has already happened.
    assert.equal(trivia(closed).opensAt, null);
    assert.equal(trivia(closed).closesAt, null);
  });
});

/* ------------------------------------------------------------------ */
/* Streaks                                                             */
/* ------------------------------------------------------------------ */

describe("streaks", () => {
  /** Seven identical instant-answer questions, so only the bonus varies. */
  function sevenInstant(correctness: readonly boolean[]): SessionState {
    let s = loaded(correctness.map(() => q()));
    for (const right of correctness) {
      s = playQuestion(s, { p1: { choice: right ? 2 : 0, ms: 0 } });
      if (trivia(s).at < trivia(s).questions.length - 1) {
        s = accept(s, [{ type: "nextQuestion" }]);
      }
    }
    return s;
  }

  test("the bonus climbs 0, 100, 200, 300, 400 and caps at 500", () => {
    const s = sevenInstant([true, true, true, true, true, true, true]);
    // Each correct answer is worth 1000 at t = 0, plus 100 × min(n − 1, 5).
    // n:            1     2     3     4     5     6     7
    // bonus:        0   100   200   300   400   500   500
    const expected = 7 * 1000 + (0 + 100 + 200 + 300 + 400 + 500 + 500);
    assert.equal(totalOf(s, "p1"), expected);
    assert.equal(trivia(s).streaks["p1"], 7);
  });

  test("a miss resets the streak", () => {
    const s = sevenInstant([true, true, true, false, true, true, true]);
    // n:            1     2     3   miss     1     2     3
    // bonus:        0   100   200      0     0   100   200
    const expected = 6 * 1000 + (0 + 100 + 200 + 0 + 0 + 100 + 200);
    assert.equal(totalOf(s, "p1"), expected);
    assert.equal(trivia(s).streaks["p1"], 3);
  });

  test("not answering at all breaks the streak just as a wrong answer does", () => {
    let s = loaded([q(), q(), q()]);
    s = playQuestion(s, { p1: { choice: 2, ms: 0 }, p2: { choice: 2, ms: 0 } });
    s = accept(s, [{ type: "nextQuestion" }]);
    s = playQuestion(s, { p2: { choice: 2, ms: 0 } }); // p1 says nothing
    assert.equal(trivia(s).streaks["p1"], undefined, "a silent question is a miss");
    s = accept(s, [{ type: "nextQuestion" }]);
    s = playQuestion(s, { p1: { choice: 2, ms: 0 }, p2: { choice: 2, ms: 0 } });
    // p1: 1000 + 1000 (no bonus, the run restarted). p2: three in a row.
    assert.equal(totalOf(s, "p1"), 2000);
    assert.equal(totalOf(s, "p2"), 3000 + 0 + 100 + 200);
  });

  test("a warm-up pays nothing but still advances the streak", () => {
    // SPEC.md: "`Points` … 0 makes a question a warm-up". A warm-up that paid
    // a streak bonus would move the scoreboard, which is the one thing a
    // warm-up is defined not to do — so the bonus is suppressed with the base.
    // The streak itself counts *correct answers*, and a warm-up is a question
    // you got right, so it carries through to the next question's bonus.
    let s = loaded([q(), q({ basePoints: 0 }), q()]);
    s = playQuestion(s, { p1: { choice: 2, ms: 0 } });
    assert.equal(totalOf(s, "p1"), 1000);

    s = accept(s, [{ type: "nextQuestion" }]);
    s = playQuestion(s, { p1: { choice: 2, ms: 0 } });
    assert.equal(totalOf(s, "p1"), 1000, "the warm-up adds nothing, bonus included");
    assert.equal(trivia(s).streaks["p1"], 2, "but it counts as a correct answer");
    assert.equal(must(trivia(s).answers["p1"], "answer").streakBonus, 0);

    s = accept(s, [{ type: "nextQuestion" }]);
    s = playQuestion(s, { p1: { choice: 2, ms: 0 } });
    // Third consecutive correct answer: 1000 + (100 × min(3 − 1, 5)) = 1200.
    assert.equal(totalOf(s, "p1"), 1000 + 1200);
  });

  test("a wrong answer on a warm-up still breaks the streak", () => {
    let s = loaded([q(), q({ basePoints: 0 }), q()]);
    s = playQuestion(s, { p1: { choice: 2, ms: 0 } });
    s = accept(s, [{ type: "nextQuestion" }]);
    s = playQuestion(s, { p1: { choice: 0, ms: 0 } });
    assert.equal(trivia(s).streaks["p1"], undefined);
    s = accept(s, [{ type: "nextQuestion" }]);
    s = playQuestion(s, { p1: { choice: 2, ms: 0 } });
    assert.equal(totalOf(s, "p1"), 2000, "no bonus: the run restarted");
  });

  test("the streak bonus is added to the speed points, not instead of them", () => {
    // Two questions, both answered correctly at 5 s of a 20 s limit:
    // 875, then 875 + 100.
    let s = loaded([q(), q()]);
    s = playQuestion(s, { p1: { choice: 2, ms: 5_000 } });
    s = accept(s, [{ type: "nextQuestion" }]);
    s = playQuestion(s, { p1: { choice: 2, ms: 5_000 } });
    assert.equal(totalOf(s, "p1"), 875 + 875 + 100);
  });
});

/* ------------------------------------------------------------------ */
/* Sudden death                                                        */
/* ------------------------------------------------------------------ */

describe("sudden death", () => {
  test("the first correct answer wins and no points change at all", () => {
    const before = loaded([q()]);
    const s = playQuestion(
      before,
      {
        p1: { choice: 0, ms: 500 }, // wrong, first
        p2: { choice: 2, ms: 900 }, // right, wins
        p3: { choice: 2, ms: 1_200 }, // right, too late
      },
      { suddenDeath: true },
    );
    const t = trivia(s);
    assert.equal(t.suddenDeathWinner, "p2");
    assert.deepEqual(t.totals, {}, "sudden death changes no points");
    assert.deepEqual(t.streaks, {}, "and no streaks");
    assert.deepEqual(s.scores["trivia"], {}, "and nothing reaches the scoreboard");
    assert.equal(must(t.answers["p2"], "p2").points, 0);
    assert.equal(must(t.answers["p2"], "p2").streakBonus, 0);
  });

  test("a later correct answer does not take the win", () => {
    const s = playQuestion(
      loaded([q()]),
      { p2: { choice: 2, ms: 100 }, p3: { choice: 2, ms: 200 } },
      { suddenDeath: true },
    );
    assert.equal(trivia(s).suddenDeathWinner, "p2");
  });

  test("a sudden death nobody wins leaves the winner null", () => {
    const s = playQuestion(
      loaded([q()]),
      { p1: { choice: 0, ms: 100 }, p2: { choice: 1, ms: 200 } },
      { suddenDeath: true },
    );
    assert.equal(trivia(s).suddenDeathWinner, null);
  });

  test("it does not disturb totals banked by earlier questions", () => {
    let s = loaded([q(), q()]);
    s = playQuestion(s, { p1: { choice: 2, ms: 0 } });
    s = accept(s, [{ type: "nextQuestion" }]);
    s = playQuestion(s, { p2: { choice: 2, ms: 10 } }, { suddenDeath: true });
    assert.equal(totalOf(s, "p1"), 1000);
    assert.equal(totalOf(s, "p2"), 0);
    assert.equal(trivia(s).suddenDeathWinner, "p2");
  });
});

/* ------------------------------------------------------------------ */
/* revealQuestion / nextQuestion                                       */
/* ------------------------------------------------------------------ */

describe("revealQuestion", () => {
  test("follows a close", () => {
    const s = accept(loaded(), [
      { type: "openQuestion", suddenDeath: false },
      { type: "closeQuestion" },
      { type: "revealQuestion" },
    ]);
    assert.equal(trivia(s).phase, "revealed");
  });

  test("refused while the question is open — the screen must not give it away", () => {
    const s = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }]);
    assertRefused(s, run(s, { type: "revealQuestion" }), "wrong_question_phase");
  });

  test("refused while idle", () => {
    const s = loaded();
    assertRefused(s, run(s, { type: "revealQuestion" }), "wrong_question_phase");
  });

  test("refused twice", () => {
    const s = accept(loaded(), [
      { type: "openQuestion", suddenDeath: false },
      { type: "closeQuestion" },
      { type: "revealQuestion" },
    ]);
    assertRefused(s, run(s, { type: "revealQuestion" }), "wrong_question_phase");
  });

  test("refused before a set is loaded", () => {
    const s = accept(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES }),
      [{ type: "open" }, { type: "start" }],
    );
    assertRefused(s, run(s, { type: "revealQuestion" }), "no_questions_loaded");
    assertRefused(s, run(s, { type: "closeQuestion" }), "no_questions_loaded");
    assertRefused(s, run(s, { type: "nextQuestion" }), "no_questions_loaded");
  });
});

describe("nextQuestion", () => {
  test("advances, clears the answers, and keeps totals and streaks", () => {
    let s = playQuestion(loaded(), { p1: { choice: 2, ms: 0 } });
    s = accept(s, [{ type: "revealQuestion" }]);
    s = accept(s, [{ type: "nextQuestion" }]);
    const t = trivia(s);
    assert.equal(t.at, 1);
    assert.equal(t.phase, "idle");
    assert.equal(t.opensAt, null);
    assert.equal(t.closesAt, null);
    assert.deepEqual(t.answers, {}, "per-question answers are cleared");
    assert.equal(t.totals["p1"], 1000, "the running total survives");
    assert.equal(t.streaks["p1"], 1, "so does the streak");
  });

  test("clears the sudden death flag and winner", () => {
    let s = playQuestion(loaded(), { p1: { choice: 2, ms: 5 } }, { suddenDeath: true });
    s = accept(s, [{ type: "nextQuestion" }]);
    assert.equal(trivia(s).suddenDeath, false);
    assert.equal(trivia(s).suddenDeathWinner, null);
  });

  test("refused while a question is open", () => {
    const s = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }]);
    assertRefused(s, run(s, { type: "nextQuestion" }), "wrong_question_phase");
  });

  test("skipping an unasked question is allowed", () => {
    // Advancing from `idle` is how a host drops a question they do not want to
    // ask. There is no separate skip event and this is the same thing.
    const s = accept(loaded(), [{ type: "nextQuestion" }]);
    assert.equal(trivia(s).at, 1);
  });

  test("refused past the end of the set", () => {
    let s = loaded([q(), q()]);
    s = accept(s, [{ type: "nextQuestion" }]);
    assertRefused(s, run(s, { type: "nextQuestion" }), "no_more_questions");
    assert.equal(trivia(s).at, 1, "the last question stays on screen");
  });

  test("a one-question set cannot advance at all", () => {
    const s = loaded([q()]);
    assertRefused(s, run(s, { type: "nextQuestion" }), "no_more_questions");
  });
});

/* ------------------------------------------------------------------ */
/* A whole set                                                         */
/* ------------------------------------------------------------------ */

describe("a whole set", () => {
  test("three questions, three players, every number checked by hand", () => {
    let s = loaded([
      q({ timeLimitSec: 20 }),
      q({ timeLimitSec: 10, basePoints: 500 }),
      q({ timeLimitSec: 30, correct: [1, 3] }),
    ]);

    // Q1 (base 1000, T = 20 s)
    //   p1 right at 5 s   -> 875, streak 1, bonus 0
    //   p2 right at 20 s  -> 500, streak 1, bonus 0
    //   p3 wrong          -> 0
    s = playQuestion(s, {
      p1: { choice: 2, ms: 5_000 },
      p2: { choice: 2, ms: 20_000 },
      p3: { choice: 3, ms: 2_000 },
    });
    s = accept(s, [{ type: "revealQuestion" }, { type: "nextQuestion" }]);

    // Q2 (base 500, T = 10 s)
    //   p1 right at 3 s   -> 425, streak 2, bonus 100
    //   p2 wrong          -> 0, streak broken
    //   p3 right at 0 s   -> 500, streak 1, bonus 0
    s = playQuestion(s, {
      p1: { choice: 2, ms: 3_000 },
      p2: { choice: 0, ms: 1_000 },
      p3: { choice: 2, ms: 0 },
    });
    s = accept(s, [{ type: "revealQuestion" }, { type: "nextQuestion" }]);

    // Q3 (base 1000, T = 30 s, correct = {1, 3})
    //   p1 right at 10 s  -> 833, streak 3, bonus 200
    //   p2 right at 15 s  -> 750, streak 1, bonus 0
    //   p3 silent         -> 0, streak broken
    // Revealed, because the assertions below read `scores`, and points only
    // reach `scores` at the reveal.
    s = playQuestion(
      s,
      { p1: { choice: 3, ms: 10_000 }, p2: { choice: 1, ms: 15_000 } },
      { reveal: true },
    );

    assert.equal(totalOf(s, "p1"), 875 + (425 + 100) + (833 + 200));
    assert.equal(totalOf(s, "p2"), 500 + 0 + 750);
    assert.equal(totalOf(s, "p3"), 0 + 500 + 0);

    assert.deepEqual(s.scores["trivia"]?.["p1"], { raw: 2433, status: "played" });
    assert.deepEqual(s.scores["trivia"]?.["p2"], { raw: 1250, status: "played" });
    assert.deepEqual(s.scores["trivia"]?.["p3"], { raw: 500, status: "played" });

    // Normalisation: 2433 is the top, so p1 is 100 and the others scale.
    const standings = computeStandings(s);
    const points = (pid: string) =>
      must(standings.find((r) => r.pid === pid), pid).perActivity["trivia"]?.points;
    assert.equal(points("p1"), 100);
    assert.equal(points("p2"), Math.round((100 * 1250) / 2433)); // 51
    assert.equal(points("p3"), Math.round((100 * 500) / 2433)); // 21
  });
});

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

describe("recovery", () => {
  test("a trivia session replays from its event log to the same state", () => {
    // The runtime only writes the event log when the engine asks it to, so
    // this passing also means every accepted trivia event emits `persist`.
    const questions = [q(), q({ basePoints: 0 }), q({ correct: [0, 2] })];
    const log: { event: Event; at: number }[] = [
      { event: { type: "open" }, at: 10 },
      { event: { type: "join", pid: "p1", nickname: "p1" }, at: 20 },
      { event: { type: "join", pid: "p2", nickname: "p2" }, at: 30 },
      { event: { type: "start" }, at: 40 },
      { event: { type: "loadTrivia", activityId: "trivia", questions }, at: 50 },
      { event: { type: "openQuestion", suddenDeath: false }, at: 1_000 },
      { event: { type: "answerQuestion", pid: "p1", choice: 2, ms: 5_000 }, at: 6_000 },
      { event: { type: "answerQuestion", pid: "p2", choice: 0, ms: 6_000 }, at: 7_000 },
      { event: { type: "closeQuestion" }, at: 8_000 },
      { event: { type: "revealQuestion" }, at: 9_000 },
      { event: { type: "nextQuestion" }, at: 10_000 },
      { event: { type: "openQuestion", suddenDeath: false }, at: 11_000 },
      { event: { type: "answerQuestion", pid: "p1", choice: 2, ms: 1_000 }, at: 12_000 },
      { event: { type: "closeQuestion" }, at: 13_000 },
    ];
    const initial = newSession({
      sid: "s1",
      title: "Huddle",
      joinCode: "RAFT",
      activities: ACTIVITIES,
    });

    const once = replay(initial, log);
    const twice = replay(initial, log);
    assert.deepEqual(twice, once, "replay is deterministic");
    assert.equal(totalOf(once, "p1"), 875, "the warm-up adds nothing");
    assert.equal(trivia(once).streaks["p1"], 2);
    assert.deepEqual(once.scores["trivia"]?.["p1"], { raw: 875, status: "played" });
    assert.deepEqual(once.scores["trivia"]?.["p2"], { raw: 0, status: "played" });
  });
});

/* ------------------------------------------------------------------ */
/* The tiebreak pool                                                   */
/* ------------------------------------------------------------------ */

/**
 * SCORING.md settles a tie with "sudden death — one question, first correct
 * answer wins, no points", and never a coin flip.
 *
 * Sudden death used to be a *mode* on `questions[at]`, and that had three
 * consequences, all of them wrong: it spent one of the twenty scored
 * questions, a tie settled mid-set silently dropped a question from the game,
 * and once the set was exhausted there was nothing left to put the mode on —
 * which is exactly the moment a final tie needs settling. The fix is that a
 * tiebreaker is **not part of the scored set**.
 */
describe("the tiebreak pool", () => {
  /**
   * A tiebreaker whose correct answer is 1, where an ordinary `q()`'s is 2.
   * That difference is what proves which question an answer was judged
   * against.
   */
  const tb = (n: number): Question => ({
    ...q({ correct: [1] }),
    text: `Tiebreaker ${n}`,
    tiebreak: true,
  });

  test("questions flagged in the file are lifted out of the twenty", () => {
    const s = accept(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES }),
      [
        { type: "open" },
        { type: "join", pid: "p1", nickname: "p1" },
        { type: "start" },
        {
          type: "loadTrivia",
          activityId: "trivia",
          questions: [
            q(),
            { ...q(), text: "Held back", tiebreak: true },
            q(),
          ],
        },
      ],
    );
    const t = trivia(s);
    assert.equal(t.questions.length, 2, "two scored questions, not three");
    assert.ok(!t.questions.some((x) => x.text === "Held back"));
    assert.equal(t.tiebreakers.length, 1);
    assert.equal(must(t.tiebreakers[0]).text, "Held back");
  });

  test("a file of nothing but tiebreakers has no game in it", () => {
    const base = accept(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES }),
      [{ type: "open" }, { type: "start" }],
    );
    assertRefused(
      base,
      run(base, {
        type: "loadTrivia",
        activityId: "trivia",
        questions: [{ ...q(), tiebreak: true }],
      }),
      "no_questions_loaded",
    );
  });

  test("a file with no tiebreakers falls back to the built-in pool", () => {
    // Most files flag nothing, and "never a coin flip" has to be true for
    // them too.
    const s = accept(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES }),
      [
        { type: "open" },
        { type: "join", pid: "p1", nickname: "p1" },
        { type: "start" },
        { type: "loadTrivia", activityId: "trivia", questions: [q()] },
      ],
    );
    assert.deepEqual(trivia(s).tiebreakers, DEFAULT_TIEBREAKERS);
  });

  test("the built-in pool is askable, and scores nothing even if asked", () => {
    assert.ok(DEFAULT_TIEBREAKERS.length >= 2, "one tie is not the only tie");
    for (const question of DEFAULT_TIEBREAKERS) {
      assert.ok(question.answers.length >= 2, `${question.text} has one answer`);
      assert.ok(question.correct.length >= 1, `${question.text} has no answer`);
      for (const c of question.correct) {
        assert.ok(c >= 0 && c < question.answers.length, "a correct index off the end");
      }
      assert.equal(question.basePoints, 0, "a tiebreaker cannot pay points");
      assert.equal(question.tiebreak, true);
      assert.ok(question.note !== null, "the reveal still teaches something");
    }
  });

  test("a sudden death asks the tiebreaker, and leaves the set where it was", () => {
    let s = loaded([q(), q(), q()], PIDS, [tb(1), tb(2)]);
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 1_000);
    const t = trivia(s);
    assert.equal(t.suddenDeath, true);
    assert.equal(must(currentQuestion(t)).text, "Tiebreaker 1");
    assert.equal(t.tiebreakAt, 0);
    assert.equal(t.tiebreakUsed, 1, "asking it spends it");
    // The scored set has no question in play while the tiebreak runs, and
    // `at` says so by pointing past the end of it — so a projection that has
    // not learned about tiebreakers finds nothing rather than the wrong
    // question. Where the host comes back to is parked in `tiebreakHeld`.
    assert.equal(t.at, t.questions.length);
    assert.equal(t.questions[t.at], undefined);
    assert.equal(must(t.tiebreakHeld).at, 0, "and question one is kept");
    // Cleared, it hands the set back exactly where it was.
    const cleared = accept(
      accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }], 2_000),
      [{ type: "nextQuestion" }],
      3_000,
    );
    assert.equal(trivia(cleared).at, 0);
    assert.equal(trivia(cleared).phase, "idle");
    // And it is judged against the tiebreaker, not against questions[0]:
    // `q()` is correct on 2 and the tiebreaker on 1.
    const answered = accept(s, [{ type: "answerQuestion", pid: "p1", choice: 1, ms: 40 }]);
    assert.equal(must(trivia(answered).answers["p1"]).correct, true);
    assert.equal(trivia(answered).suddenDeathWinner, "p1");
    const wrong = accept(s, [{ type: "answerQuestion", pid: "p2", choice: 2, ms: 40 }]);
    assert.equal(must(trivia(wrong).answers["p2"]).correct, false);
  });

  test("it can be run after the final question, which is where a tie lands", () => {
    // Walk to the end of a two-question set and reveal the last one. This is
    // the state the old sudden death could not be opened from at all:
    // `nextQuestion` refuses past the last question, so there was nothing
    // left to put the mode on.
    let s = loaded([q(), q()], PIDS, [tb(1)]);
    s = playQuestion(s, { p1: { choice: 2, ms: 100 } }, { reveal: true });
    s = accept(s, [{ type: "nextQuestion" }]);
    s = playQuestion(s, { p1: { choice: 2, ms: 100 } }, { reveal: true });
    const t = trivia(s);
    assert.equal(t.at, 1);
    assert.equal(t.phase, "revealed");
    assertRefused(s, run(s, { type: "nextQuestion" }), "no_more_questions");

    const sd = accept(s, [{ type: "openQuestion", suddenDeath: true }], 90_000);
    assert.equal(trivia(sd).phase, "open");
    assert.equal(must(currentQuestion(trivia(sd))).text, "Tiebreaker 1");
    assert.equal(
      must(trivia(sd).tiebreakHeld).at,
      1,
      "the set is still sitting on its last question, and comes back to it",
    );
    const back = accept(
      accept(sd, [{ type: "closeQuestion" }, { type: "revealQuestion" }], 91_000),
      [{ type: "nextQuestion" }],
      92_000,
    );
    assert.equal(trivia(back).at, 1);
    assert.equal(trivia(back).phase, "revealed");
  });

  test("it settles nothing: no points, no streaks, no scoreboard", () => {
    let s = loaded([q(), q()], PIDS, [tb(1)]);
    s = playQuestion(s, { p1: { choice: 2, ms: 100 } }, { reveal: true });
    const before = { ...trivia(s).totals };
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 50_000);
    s = accept(s, [{ type: "answerQuestion", pid: "p2", choice: 1, ms: 30 }], 50_030);
    s = accept(s, [{ type: "closeQuestion" }], 50_100);
    assert.equal(trivia(s).suddenDeathWinner, "p2");
    assert.deepEqual(trivia(s).totals, before, "a tiebreak moves no totals");
    s = accept(s, [{ type: "revealQuestion" }], 50_200);
    assert.deepEqual(s.scores["trivia"]?.["p2"], undefined);
    assert.equal(must(s.scores["trivia"]?.["p1"]).raw, before["p1"]);
  });

  test("clearing a tiebreak does not advance the scored set", () => {
    // A tie settled between questions three and four must not cost the room
    // question four. `at` did not move when the tiebreak opened, so it must
    // not move when it is put away.
    let s = loaded([q(), q(), q()], PIDS, [tb(1)]);
    s = playQuestion(s, { p1: { choice: 2, ms: 100 } }, { reveal: true });
    s = accept(s, [{ type: "nextQuestion" }]);
    assert.equal(trivia(s).at, 1);
    s = playQuestion(s, { p1: { choice: 2, ms: 10 } }, { suddenDeath: true, openAt: 40_000 });
    s = accept(s, [{ type: "revealQuestion" }], 61_000);
    s = accept(s, [{ type: "nextQuestion" }], 62_000);
    const t = trivia(s);
    assert.equal(t.at, 1, "question two is still to be asked");
    assert.equal(t.suddenDeath, false);
    assert.equal(t.suddenDeathWinner, null);
    assert.deepEqual(t.answers, {});
  });

  test("a tiebreak puts no un-asked scored question within reach", () => {
    // The safety property that `at` pointing past the end of the set buys.
    // Every projection written before tiebreakers existed reads
    // `questions[at]` for "the question in play"; during a tiebreak that must
    // find nothing rather than the next question the room has not been asked
    // yet, whose text would go on every phone and whose answer and note would
    // be read out at the tiebreak's reveal.
    let s = loaded(
      [q(), { ...q(), text: "NOT ASKED YET", note: "and its answer" }],
      ["p1"],
      [tb(1)],
    );
    s = playQuestion(s, { p1: { choice: 2, ms: 100 } }, { reveal: true });
    s = accept(s, [{ type: "nextQuestion" }], 30_000);
    assert.equal(must(trivia(s).questions[trivia(s).at]).text, "NOT ASKED YET");
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 40_000);
    const t = trivia(s);
    assert.equal(t.questions[t.at], undefined, "nothing for a stale reader to find");
    assert.equal(must(currentQuestion(t)).text, "Tiebreaker 1");
    // And the un-asked question is still there, still un-asked, when the
    // tiebreak is cleared.
    s = accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }], 41_000);
    s = accept(s, [{ type: "nextQuestion" }], 42_000);
    assert.equal(must(currentQuestion(trivia(s))).text, "NOT ASKED YET");
    assert.equal(trivia(s).phase, "idle");
  });

  test("a question already scored cannot be re-opened after a tiebreak", () => {
    // The hazard the hold exists for. A tiebreak does not move `at`, so
    // clearing one used to leave the set `idle` on a question that had already
    // been asked, settled and written to `scores` — and `idle` is exactly the
    // phase `openQuestion` accepts. Asking it again paid for it again.
    let s = loaded([q(), q()], ["p1"], [tb(1)]);
    s = playQuestion(s, { p1: { choice: 2, ms: 100 } }, { reveal: true });
    const once = totalOf(s, "p1");
    assert.ok(once > 0);
    // Straight into a tiebreak off the reveal, then clear it.
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 40_000);
    s = accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }], 41_000);
    s = accept(s, [{ type: "nextQuestion" }], 42_000);
    const t = trivia(s);
    assert.equal(t.at, 0, "the set is still on question one");
    assert.equal(t.phase, "revealed", "and it is still revealed, not idle");
    assert.equal(t.tiebreakHeld, null);
    assertRefused(
      s,
      run(s, { type: "openQuestion", suddenDeath: false }, 43_000),
      "wrong_question_phase",
    );
    assert.equal(totalOf(s, "p1"), once, "and it was paid for exactly once");
    // The ordinary way on still works, and pays question two once.
    s = accept(s, [{ type: "nextQuestion" }], 44_000);
    assert.equal(trivia(s).at, 1);
    assert.equal(trivia(s).phase, "idle");
  });

  test("the interrupted question keeps its answers for the big screen", () => {
    let s = loaded([q(), q()], PIDS, [tb(1)]);
    s = playQuestion(
      s,
      { p1: { choice: 2, ms: 100 }, p2: { choice: 0, ms: 200 } },
      { reveal: true },
    );
    const before = trivia(s).answers;
    assert.equal(Object.keys(before).length, 2);
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 40_000);
    assert.deepEqual(trivia(s).answers, {}, "the tiebreak starts empty");
    s = accept(s, [{ type: "answerQuestion", pid: "p3", choice: 1, ms: 20 }], 40_020);
    s = accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }], 41_000);
    s = accept(s, [{ type: "nextQuestion" }], 42_000);
    assert.deepEqual(trivia(s).answers, before, "and hands the question back whole");
  });

  test("two tiebreaks in a row still hand the scored question back", () => {
    let s = loaded([q(), q()], ["p1"], [tb(1), tb(2)]);
    s = playQuestion(s, { p1: { choice: 2, ms: 100 } }, { reveal: true });
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 40_000);
    s = accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }], 41_000);
    // Nobody got it, so the host runs another one without clearing the first.
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 42_000);
    assert.equal(must(currentQuestion(trivia(s))).text, "Tiebreaker 2");
    assert.equal(must(trivia(s).tiebreakHeld).phase, "revealed");
    s = accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }], 43_000);
    s = accept(s, [{ type: "nextQuestion" }], 44_000);
    assert.equal(trivia(s).phase, "revealed", "still the scored question's phase");
    assert.equal(trivia(s).at, 0);
  });

  test("each tiebreak spends a question, and the pool runs out", () => {
    let s = loaded([q()], PIDS, [tb(1), tb(2)]);
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 1_000);
    assert.equal(must(currentQuestion(trivia(s))).text, "Tiebreaker 1");
    s = accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }], 2_000);
    s = accept(s, [{ type: "nextQuestion" }], 3_000);
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 4_000);
    assert.equal(
      must(currentQuestion(trivia(s))).text,
      "Tiebreaker 2",
      "a question the room has already heard cannot settle a second tie",
    );
    s = accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }], 5_000);
    s = accept(s, [{ type: "nextQuestion" }], 6_000);
    assertRefused(
      s,
      run(s, { type: "openQuestion", suddenDeath: true }, 7_000),
      "no_tiebreak_question",
    );
  });

  test("a tiebreak is refused over an open or an unrevealed question", () => {
    const open = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }]);
    assertRefused(
      open,
      run(open, { type: "openQuestion", suddenDeath: true }),
      "wrong_question_phase",
    );
    const closed = accept(open, [{ type: "closeQuestion" }], 2_000);
    assertRefused(
      closed,
      run(closed, { type: "openQuestion", suddenDeath: true }, 3_000),
      "wrong_question_phase",
    );
  });

  test("an ordinary question is still refused once one has been revealed", () => {
    // Only sudden death may open over a revealed question. Opening the next
    // scored one still goes through `nextQuestion`.
    let s = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }]);
    s = accept(s, [{ type: "closeQuestion" }, { type: "revealQuestion" }], 2_000);
    assertRefused(
      s,
      run(s, { type: "openQuestion", suddenDeath: false }, 3_000),
      "wrong_question_phase",
    );
  });

  test("the pool survives a replay of the log", () => {
    const log: readonly { event: Event; at: number }[] = [
      { event: { type: "open" }, at: 10 },
      { event: { type: "join", pid: "p1", nickname: "p1" }, at: 20 },
      { event: { type: "join", pid: "p2", nickname: "p2" }, at: 30 },
      { event: { type: "start" }, at: 40 },
      {
        event: {
          type: "loadTrivia",
          activityId: "trivia",
          questions: [q(), { ...q(), text: "Held back", tiebreak: true }],
        },
        at: 50,
      },
      { event: { type: "openQuestion", suddenDeath: true }, at: 60 },
      { event: { type: "answerQuestion", pid: "p2", choice: 2, ms: 20 }, at: 80 },
      { event: { type: "closeQuestion" }, at: 90 },
    ];
    const s = replay(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES }),
      log,
    );
    const t = must(s.trivia);
    assert.equal(t.questions.length, 1);
    assert.equal(must(currentQuestion(t)).text, "Held back");
    assert.equal(t.suddenDeathWinner, "p2");
    assert.equal(t.tiebreakUsed, 1);
    assert.deepEqual(t.totals, {});
  });
});

/* ------------------------------------------------------------------ */
/* Auto                                                                */
/* ------------------------------------------------------------------ */

/**
 * The beat rule, as arithmetic.
 *
 * `autoBeat` is the whole safety argument for Auto, so it is tested as a pure
 * function over every phase rather than only through the beats a scenario
 * happens to walk. Every expected value here is read off the rule in the
 * doc comment and never by calling the code twice.
 */
describe("autoBeat: what the set does on its own", () => {
  const at = (
    over: Partial<TriviaAutoAt> = {},
  ): TriviaAutoAt => ({
    auto: true,
    suddenDeath: false,
    phase: "closed",
    at: 0,
    of: 3,
    ...over,
  });

  test("does nothing at all in manual, in every phase", () => {
    for (const phase of ["idle", "open", "closed", "revealed"] as const) {
      assert.equal(autoBeat(at({ auto: false, phase })), null, phase);
    }
  });

  test("reveals a closed question and then opens the next", () => {
    assert.equal(autoBeat(at({ phase: "closed" })), "reveal");
    assert.equal(autoBeat(at({ phase: "revealed" })), "advance");
  });

  test("never opens a question from cold, so turning Auto on does nothing", () => {
    // The hazard the whole feature turns on: a host who presses Auto at
    // question one, or who walks back to an idle question by hand, must not
    // have a question put in front of the room by a clock.
    assert.equal(autoBeat(at({ phase: "idle" })), null);
  });

  test("leaves an open question to its own timer", () => {
    assert.equal(autoBeat(at({ phase: "open" })), null);
  });

  test("never moves a sudden death, in any phase", () => {
    for (const phase of ["idle", "open", "closed", "revealed"] as const) {
      assert.equal(autoBeat(at({ suddenDeath: true, phase })), null, phase);
    }
  });

  test("stops on the last reveal rather than reaching past the end", () => {
    // Three questions, sitting on the third: there is nothing to advance to.
    assert.equal(autoBeat(at({ phase: "revealed", at: 2, of: 3 })), null);
    assert.equal(autoBeat(at({ phase: "revealed", at: 1, of: 3 })), "advance");
    // It still reveals the last one — stopping is about advancing, not about
    // leaving the room without the answer to the question they just played.
    assert.equal(autoBeat(at({ phase: "closed", at: 2, of: 3 })), "reveal");
  });
});

describe("autoBeatMs: one slider, two waits", () => {
  test("the reveal beat is exactly the number on the slider", () => {
    assert.equal(autoBeatMs("reveal", 5, 0), 5000);
    assert.equal(autoBeatMs("reveal", 5, 500), 5000, "the note does not move it");
    assert.equal(autoBeatMs("reveal", 12, 0), 12_000);
  });

  test("the wait after the reveal is longer, and longer again with a note", () => {
    // base × 2 + chars × 45ms at the default beat. Hand-computed.
    assert.equal(autoBeatMs("advance", 5, 0), 10_000);
    assert.equal(autoBeatMs("advance", 5, 100), 10_000 + 4_500);
    assert.ok(
      autoBeatMs("advance", 5, 137) > autoBeatMs("reveal", 5, 137),
      "reading a note must never be the shorter of the two",
    );
  });

  test("the slider scales both, so faster is faster everywhere", () => {
    const slow = autoBeatMs("advance", 10, 137);
    const fast = autoBeatMs("advance", 3, 137);
    assert.ok(fast < slow);
    // 10s is exactly twice the default, so the note's share doubles too.
    assert.equal(autoBeatMs("advance", 10, 100), 20_000 + 9_000);
  });

  test("one pathological note cannot hold the room for a minute", () => {
    assert.equal(autoBeatMs("advance", 5, 100_000), 5000 * 6);
  });

  test("a beat that is not a number falls back rather than becoming NaN", () => {
    // A snapshot written before Auto existed has no `autoSeconds`, and
    // `undefined * 1000` is a timer armed for never.
    assert.equal(
      autoBeatMs("reveal", undefined as unknown as number, 0),
      DEFAULT_BEAT_SECONDS * 1000,
    );
    assert.equal(clampBeatSeconds(Number.NaN), DEFAULT_BEAT_SECONDS);
  });

  test("the slider is clamped and rounded, both ends", () => {
    assert.equal(clampBeatSeconds(0), MIN_BEAT_SECONDS);
    assert.equal(clampBeatSeconds(-4), MIN_BEAT_SECONDS);
    assert.equal(clampBeatSeconds(9999), MAX_BEAT_SECONDS);
    assert.equal(clampBeatSeconds(6.4), 6);
  });
});

describe("Auto, through the reducer", () => {
  test("a set loads in manual, whatever the last one was set to", () => {
    const t = trivia(loaded());
    assert.equal(t.auto, false);
    assert.equal(t.autoSeconds, DEFAULT_BEAT_SECONDS);
    assert.equal(t.autoAt, null);
  });

  test("the close and the reveal each stamp the beat they start", () => {
    let s = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }], 1000);
    s = accept(s, [{ type: "closeQuestion" }], 5000);
    assert.equal(trivia(s).autoAt, 5000);
    s = accept(s, [{ type: "revealQuestion" }], 9000);
    assert.equal(trivia(s).autoAt, 9000, "the second beat counts from the reveal");
    s = accept(s, [{ type: "nextQuestion" }], 12_000);
    assert.equal(trivia(s).autoAt, null, "an idle question has no beat pending");
  });

  test("turning Auto on gives whatever is on screen its full beat", () => {
    // The bug this prevents: a question that closed eight seconds ago
    // revealing itself the instant the host presses Auto.
    let s = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }], 1000);
    s = accept(s, [{ type: "closeQuestion" }], 5000);
    s = accept(s, [{ type: "setTriviaAuto", auto: true }], 13_000);
    assert.equal(trivia(s).autoAt, 13_000);
    assert.equal(autoFiresAt(trivia(s)), 13_000 + DEFAULT_BEAT_SECONDS * 1000);
  });

  test("the slider does not restart the wait it is shortening", () => {
    let s = accept(loaded(), [{ type: "openQuestion", suddenDeath: false }], 1000);
    s = accept(s, [{ type: "closeQuestion" }], 5000);
    s = accept(s, [{ type: "setTriviaAuto", auto: true }], 5000);
    s = accept(s, [{ type: "setTriviaSpeed", seconds: 3 }], 7000);
    assert.equal(trivia(s).autoAt, 5000, "still counting from the close");
    assert.equal(autoFiresAt(trivia(s)), 8000);
  });

  test("the slider is clamped by the engine and nowhere else", () => {
    let s = accept(loaded(), [{ type: "setTriviaSpeed", seconds: 900 }]);
    assert.equal(trivia(s).autoSeconds, MAX_BEAT_SECONDS);
    s = accept(s, [{ type: "setTriviaSpeed", seconds: -1 }]);
    assert.equal(trivia(s).autoSeconds, MIN_BEAT_SECONDS);
  });

  test("a speed that is not a number is refused", () => {
    const s = loaded();
    assertRefused(
      s,
      run(s, { type: "setTriviaSpeed", seconds: Number.NaN }),
      "invalid_round_config",
    );
  });

  test("opening a sudden death switches Auto off, it does not merely suppress it", () => {
    // A suppressed Auto leaves the console's button reading "Manual" — auto is
    // on — while nothing happens, and then the host clears the tiebreak and
    // the set starts itself again mid-announcement. Off is the honest version.
    let s = playQuestion(loaded(), { p1: { choice: 2, ms: 100 } }, { reveal: true });
    s = accept(s, [{ type: "setTriviaAuto", auto: true }], 30_000);
    assert.equal(trivia(s).auto, true);
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 31_000);
    assert.equal(trivia(s).auto, false);
    // And it is still off once the tie is settled and the set comes back.
    s = accept(s, [{ type: "closeQuestion" }], 40_000);
    s = accept(s, [{ type: "revealQuestion" }], 41_000);
    s = accept(s, [{ type: "nextQuestion" }], 42_000);
    assert.equal(trivia(s).auto, false);
    assert.equal(autoFiresAt(trivia(s)), null);
  });

  test("Auto cannot be switched on during a sudden death", () => {
    let s = playQuestion(loaded(), { p1: { choice: 2, ms: 100 } }, { reveal: true });
    s = accept(s, [{ type: "openQuestion", suddenDeath: true }], 31_000);
    assertRefused(s, run(s, { type: "setTriviaAuto", auto: true }, 32_000), "wrong_question_phase");
    // Off is always allowed: off is always the safe direction.
    assert.equal(run(s, { type: "setTriviaAuto", auto: false }, 32_000).state.seq, s.seq);
  });

  test("nothing is pending on an open question, or on the last reveal", () => {
    // Two questions, so the second reveal is the end of the set.
    let s = accept(loaded([q(), q()]), [{ type: "setTriviaAuto", auto: true }]);
    s = accept(s, [{ type: "openQuestion", suddenDeath: false }], 1000);
    assert.equal(autoFiresAt(trivia(s)), null, "the question's own timer owns this");
    s = accept(s, [{ type: "closeQuestion" }], 5000);
    assert.ok(autoFiresAt(trivia(s)) !== null);
    s = accept(s, [{ type: "revealQuestion" }], 6000);
    assert.ok(autoFiresAt(trivia(s)) !== null, "one question left, so it advances");
    s = accept(s, [{ type: "nextQuestion" }], 7000);
    assert.equal(autoFiresAt(trivia(s)), null, "an idle question waits for a press");
    s = accept(s, [{ type: "openQuestion", suddenDeath: false }], 8000);
    s = accept(s, [{ type: "closeQuestion" }], 12_000);
    s = accept(s, [{ type: "revealQuestion" }], 13_000);
    assert.equal(
      autoFiresAt(trivia(s)),
      null,
      "the last reveal stays up; Auto must not reach for a question that is not there",
    );
  });

  test("the note's length is the reveal's length", () => {
    const long = q({ note: "x".repeat(200) });
    let s = accept(loaded([long, q()]), [{ type: "setTriviaAuto", auto: true }]);
    s = accept(s, [{ type: "openQuestion", suddenDeath: false }], 1000);
    s = accept(s, [{ type: "closeQuestion" }], 5000);
    s = accept(s, [{ type: "revealQuestion" }], 6000);
    assert.equal(
      autoFiresAt(trivia(s)),
      6000 + autoBeatMs("advance", DEFAULT_BEAT_SECONDS, 200),
    );
  });

  test("Auto and the slider survive a replay of the log", () => {
    // The engine is the only writer and the log is the record, so a console
    // that reconnects and a process that restarts both come back to the mode
    // the host left it in. This is that property, stated where it is decided.
    const log: readonly { event: Event; at: number }[] = [
      { event: { type: "open" }, at: 10 },
      { event: { type: "join", pid: "p1", nickname: "p1" }, at: 20 },
      { event: { type: "start" }, at: 30 },
      {
        event: { type: "loadTrivia", activityId: "trivia", questions: [q(), q()] },
        at: 40,
      },
      { event: { type: "setTriviaAuto", auto: true }, at: 50 },
      { event: { type: "setTriviaSpeed", seconds: 8 }, at: 60 },
      { event: { type: "openQuestion", suddenDeath: false }, at: 70 },
      { event: { type: "closeQuestion" }, at: 20_070 },
    ];
    const s = replay(
      newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES }),
      log,
    );
    const t = trivia(s);
    assert.equal(t.auto, true);
    assert.equal(t.autoSeconds, 8);
    // Absolute, so the re-armed timer fires at the instant it always meant.
    assert.equal(autoFiresAt(t), 20_070 + 8000);
  });

  test("a restart puts Auto away and keeps the slider", () => {
    let s = accept(loaded(), [{ type: "setTriviaSpeed", seconds: 9 }]);
    s = accept(s, [{ type: "setTriviaAuto", auto: true }]);
    s = accept(s, [{ type: "restartSession" }], 99_000);
    const t = trivia(s);
    assert.equal(t.auto, false, "a host recovering from something owns the wheel");
    assert.equal(t.autoSeconds, 9);
    assert.equal(t.autoAt, null);
  });

  test("Auto with no question set loaded is refused, not ignored", () => {
    const base = accept(
      newSession({ sid: "s1", title: "H", joinCode: "RAFT", activities: ACTIVITIES }),
      [{ type: "open" }, { type: "start" }],
    );
    assertRefused(base, run(base, { type: "setTriviaAuto", auto: true }), "no_questions_loaded");
    assertRefused(base, run(base, { type: "setTriviaSpeed", seconds: 5 }), "no_questions_loaded");
  });
});
