/**
 * The trivia wire: what each role is sent, and the arithmetic that turns a
 * frame arriving on a socket into a response time.
 *
 * Expected behaviour comes from SPEC.md ("Trivia", "What participants see of
 * the standings") and ARCHITECTURE.md ("Clocks and fairness", "Trivia"), not
 * from views.ts. Where a test fails, the projection is wrong or the spec is
 * ambiguous; the test is left failing and the case is reported.
 *
 * The centre of this file is one property, asserted against the *serialised*
 * frame rather than against a parsed object: while a question is open, the
 * bytes a participant receives contain nothing that identifies the correct
 * answer. Checking the rendered page instead would test a renderer's
 * discipline; checking the object would miss a field added later with a
 * different name. Checking the string is the only version of the claim that
 * stays true when somebody else edits this code.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newSession, replay } from "../engine/reducer.ts";
import type {
  Activity,
  Event,
  Question,
  SessionState,
} from "../engine/types.ts";
import {
  correctedResponseMs,
  medianRtt,
  MAX_LATENCY_CORRECTION_MS,
  SessionRegistry,
  type Client,
} from "./runtime.ts";
import {
  distributionOf,
  prepareViews,
  renderStateFor,
  roundAt,
  triviaPodium,
} from "./views.ts";
import type { RenderState } from "../protocol.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const ACTIVITIES: readonly Activity[] = [
  { id: "trivia", title: "Trivia", kind: "trivia" },
];

/**
 * Deliberately distinctive answer text. "Vault" would appear in a question
 * about Vault and prove nothing; `KRYPTON-CORRECT` appears in exactly one
 * place, so finding it in a frame is unambiguous.
 */
const QUESTIONS: readonly Question[] = [
  {
    text: "Which product does secrets management?",
    answers: ["KRYPTON-A", "KRYPTON-CORRECT", "KRYPTON-C", "KRYPTON-D"],
    timeLimitSec: 20,
    correct: [1],
    note: "XENON-NOTE: the bit people forget.",
    round: "Name that product",
    basePoints: 1000,
  },
  {
    text: "Which brand colour is purple?",
    answers: ["Vault", "Consul", "Terraform", "Nomad"],
    timeLimitSec: 10,
    correct: [2],
    note: null,
    round: "Brand",
    basePoints: 500,
  },
  {
    text: "Which of these ships as a binary?",
    answers: ["Yes", "No"],
    timeLimitSec: 10,
    correct: [0, 1],
    note: null,
    round: "Brand",
    basePoints: 1000,
  },
];

const T0 = 1_700_000_000_000;

function session(events: readonly Event[], at = T0): SessionState {
  const base = newSession({
    sid: "ses_test",
    title: "Test",
    joinCode: "hvs.testtesttest",
    activities: ACTIVITIES,
  });
  return replay(
    base,
    events.map((event) => ({ event, at })),
  );
}

/** A lobby with three people in it and the question set loaded. */
function loaded(extra: readonly Event[] = []): SessionState {
  return session([
    { type: "open" },
    { type: "join", pid: "p1", nickname: "Priya" },
    { type: "join", pid: "p2", nickname: "Kenji" },
    { type: "join", pid: "p3", nickname: "Ade" },
    { type: "start" },
    { type: "setSegment", segment: "trivia" },
    { type: "loadTrivia", activityId: "trivia", questions: QUESTIONS },
    ...extra,
  ]);
}

function view(state: SessionState, role: "participant" | "host" | "screen", pid?: string): RenderState {
  return renderStateFor(state, {
    role,
    ...(pid === undefined ? {} : { pid }),
    lastSeen: new Map(),
    now: T0,
  });
}

/** What actually crosses the socket. `send()` stringifies exactly this. */
function wire(state: SessionState, role: "participant" | "host" | "screen", pid?: string): string {
  return JSON.stringify({ t: "state", seq: 1, state: view(state, role, pid) });
}

/* ------------------------------------------------------------------ */
/* The property                                                        */
/* ------------------------------------------------------------------ */

describe("a participant cannot learn the answer before the reveal", () => {
  /**
   * SPEC.md: "The phone shows 'locked in' and nothing else — no hint of
   * correctness until the reveal, because a phone that turns green is visible
   * to the person next to you."
   */
  const open = loaded([
    { type: "openQuestion", suddenDeath: false },
    { type: "answerQuestion", pid: "p1", choice: 1, ms: 2_400 }, // right
    { type: "answerQuestion", pid: "p2", choice: 0, ms: 3_100 }, // wrong
  ]);

  it("does not put the correct answer's index on the wire", () => {
    const frame = wire(open, "participant", "p1");
    assert.equal(view(open, "participant", "p1").trivia?.correct, undefined);
    // Not "the field is undefined" — the word is not in the bytes at all.
    assert.ok(
      !frame.includes('"correct"'),
      `the frame carries a "correct" key: ${frame}`,
    );
  });

  it("does not put their own answer's correctness on the wire", () => {
    // The engine sets `TriviaAnswer.correct` at answer time, because the host
    // is entitled to it. The participant's projection must strip it.
    const right = wire(open, "participant", "p1");
    const wrong = wire(open, "participant", "p2");
    for (const frame of [right, wrong]) {
      assert.ok(!frame.includes('"correct"'), frame);
      assert.ok(!frame.includes('"points"'), frame);
      assert.ok(!frame.includes('"streak"'), frame);
    }
    // And the two frames differ only in which answer was chosen: if one of
    // them carried a signal the other did not, they would differ in length by
    // more than the choice.
    assert.equal(
      view(open, "participant", "p1").triviaMine?.state,
      "locked",
    );
    assert.deepEqual(view(open, "participant", "p1").triviaMine, {
      state: "locked",
      choice: 1,
    });
    assert.deepEqual(view(open, "participant", "p2").triviaMine, {
      state: "locked",
      choice: 0,
    });
  });

  it("does not put the distribution or the note on the wire", () => {
    const frame = wire(open, "participant", "p1");
    assert.ok(!frame.includes("XENON-NOTE"), "the note leaked before the reveal");
    assert.ok(!frame.includes('"distribution"'), "the distribution leaked");
  });

  it("holds through close, and only opens at the reveal", () => {
    // Close settles the points. It must not show them: SPEC puts the reveal
    // after the close precisely so the host chooses the moment.
    const closed = replay(open, [{ event: { type: "closeQuestion" }, at: T0 + 5_000 }]);
    const frame = wire(closed, "participant", "p1");
    assert.ok(!frame.includes('"correct"'), frame);
    assert.ok(!frame.includes('"points"'), frame);
    assert.deepEqual(view(closed, "participant", "p1").triviaMine, {
      state: "locked",
      choice: 1,
    });

    const revealed = replay(closed, [
      { event: { type: "revealQuestion" }, at: T0 + 6_000 },
    ]);
    const after = view(revealed, "participant", "p1");
    assert.deepEqual(after.trivia?.correct, [1]);
    assert.equal(after.triviaMine?.state, "revealed");
    assert.equal(
      after.triviaMine?.state === "revealed" ? after.triviaMine.correct : null,
      true,
    );
    assert.ok(wire(revealed, "participant", "p1").includes("XENON-NOTE"));
  });

  it("does not send the question at all before the host opens it", () => {
    // "Host opens the question … phones show the answers." Before that the
    // phone has not been sent them, so there is nothing to read ahead.
    const idle = loaded();
    const frame = wire(idle, "participant", "p1");
    assert.ok(!frame.includes("KRYPTON"), `the answers leaked while idle: ${frame}`);
    assert.equal(view(idle, "participant", "p1").trivia?.text, "");
    assert.deepEqual(view(idle, "participant", "p1").trivia?.answers, []);
    // The same is true of the big screen, which is in the room.
    assert.ok(!wire(idle, "screen").includes("KRYPTON"));
    // The host has it, because the host is about to read it out.
    assert.ok(wire(idle, "host").includes("KRYPTON-CORRECT"));
  });
});

describe("the answered count on a phone", () => {
  /**
   * ARCHITECTURE's per-role table, the one row in it that is not a secret:
   * `answered`/`eligible` reach a phone once *that* phone has locked in. The
   * count is people, not choices, so the property the rest of this file
   * defends is untouched by it — and these tests say so against the wire as
   * well as the object, because "the count arrived" and "only the count
   * arrived" are two different claims.
   */
  const open = loaded([
    { type: "openQuestion", suddenDeath: false },
    { type: "answerQuestion", pid: "p1", choice: 1, ms: 2_400 },
  ]);

  it("is withheld from a phone that has not answered", () => {
    const s = view(open, "participant", "p2").trivia;
    assert.equal(s?.answered, undefined);
    assert.equal(s?.eligible, undefined);
    // Omission, not nulling: the word is not in the bytes on that socket.
    const frame = wire(open, "participant", "p2");
    assert.ok(!frame.includes('"answered"'), frame);
    assert.ok(!frame.includes('"eligible"'), frame);
  });

  it("reaches a phone that has locked in, and climbs", () => {
    const s = view(open, "participant", "p1").trivia;
    assert.equal(s?.answered, 1);
    assert.equal(s?.eligible, 3);
    // Still nothing about the answer itself.
    assert.equal(s?.correct, undefined);
    assert.equal(s?.distribution, undefined);
    assert.ok(!wire(open, "participant", "p1").includes("XENON-NOTE"));

    const two = replay(open, [
      {
        event: { type: "answerQuestion", pid: "p2", choice: 0, ms: 3_100 },
        at: T0 + 3_100,
      },
    ]);
    assert.equal(view(two, "participant", "p1").trivia?.answered, 2);
    assert.equal(view(two, "participant", "p2").trivia?.answered, 2);
  });

  it("counts the room and not the phones that are awake", () => {
    // `eligible` is the roster's filter rather than the roster, so somebody
    // whose socket went quiet is still somebody the room is waiting for.
    const kicked = replay(open, [
      { event: { type: "kick", pid: "p3" }, at: T0 + 1_000 },
    ]);
    assert.equal(view(kicked, "participant", "p1").trivia?.eligible, 2);
  });

  it("does not follow a phone that never answered into the close", () => {
    const closed = replay(open, [
      { event: { type: "closeQuestion" }, at: T0 + 5_000 },
    ]);
    assert.equal(view(closed, "participant", "p1").trivia?.answered, 1);
    assert.equal(view(closed, "participant", "p2").trivia?.answered, undefined);
  });

  it("is the same object for every phone that has locked in", () => {
    // The role-level frame is shared between phones on purpose; the count is
    // per-phone only in the sense that having it is. Two phones that have both
    // answered must not cost two projections of it.
    const two = replay(open, [
      {
        event: { type: "answerQuestion", pid: "p2", choice: 0, ms: 3_100 },
        at: T0 + 3_100,
      },
    ]);
    const prepared = prepareViews(two, new Map(), T0);
    assert.equal(
      prepared.participant("p1").trivia,
      prepared.participant("p2").trivia,
    );
  });
});

describe("the big screen", () => {
  const open = loaded([
    { type: "openQuestion", suddenDeath: false },
    { type: "answerQuestion", pid: "p1", choice: 1, ms: 2_400 },
  ]);

  it("gets the climbing count, and not the answer", () => {
    const s = view(open, "screen").trivia;
    assert.equal(s?.answered, 1);
    assert.equal(s?.eligible, 3);
    assert.equal(s?.correct, undefined);
    assert.equal(s?.distribution, undefined);
  });

  it("gets the distribution at the reveal", () => {
    const revealed = replay(open, [
      { event: { type: "closeQuestion" }, at: T0 + 5_000 },
      { event: { type: "revealQuestion" }, at: T0 + 6_000 },
    ]);
    const s = view(revealed, "screen").trivia;
    assert.deepEqual(s?.correct, [1]);
    assert.deepEqual(s?.distribution, [0, 1, 0, 0]);
    assert.equal(s?.note, "XENON-NOTE: the bit people forget.");
  });

  it("never receives the participant's own block", () => {
    assert.equal(view(open, "screen").triviaMine, undefined);
    assert.equal(view(open, "screen").hostExtras, undefined);
  });
});

describe("the host console", () => {
  const open = loaded([
    { type: "openQuestion", suddenDeath: false },
    { type: "answerQuestion", pid: "p1", choice: 1, ms: 2_400 },
    { type: "answerQuestion", pid: "p2", choice: 0, ms: 3_100 },
  ]);

  it("sees correctness and the live distribution before the reveal", () => {
    // ARCHITECTURE.md: "and (host only) correctness before reveal".
    const s = view(open, "host").trivia;
    assert.deepEqual(s?.correct, [1]);
    assert.deepEqual(s?.distribution, [1, 1, 0, 0]);
    assert.equal(s?.answered, 2);
    assert.equal(s?.eligible, 3);
  });

  it("sees who has answered, and not what they answered", () => {
    const extras = view(open, "host").hostExtras?.trivia;
    assert.deepEqual(new Set(extras?.answeredBy), new Set(["p1", "p2"]));
    assert.equal(extras?.loaded, 3);
    // "24 of 27 answered" is a count of people, not a grid of choices.
    assert.ok(!JSON.stringify(extras).includes("choice"));
  });
});

describe("rounds", () => {
  it("groups consecutive questions that share a value", () => {
    // SPEC.md: "Consecutive questions with the same value get a round card
    // between them."
    assert.equal(roundAt(QUESTIONS, 0), null, "a run of one is not a round");
    assert.deepEqual(roundAt(QUESTIONS, 1), {
      name: "Brand",
      position: 1,
      size: 2,
      startsHere: true,
    });
    assert.deepEqual(roundAt(QUESTIONS, 2), {
      name: "Brand",
      position: 2,
      size: 2,
      startsHere: false,
    });
  });

  it("gives no round to a question the CSV left blank", () => {
    const none: Question[] = [{ ...QUESTIONS[0]!, round: null }];
    assert.equal(roundAt(none, 0), null);
  });
});

describe("the activity podium", () => {
  it("survives the seal", () => {
    // SPEC.md: "Activity podiums still show while sealed. The trivia's own
    // top five after each question is the trivia; it says who is winning
    // *this activity*, not the session."
    const played = loaded([
      { type: "openQuestion", suddenDeath: false },
      { type: "answerQuestion", pid: "p1", choice: 1, ms: 1_000 },
      { type: "answerQuestion", pid: "p2", choice: 1, ms: 9_000 },
      { type: "closeQuestion" },
      { type: "revealQuestion" },
      { type: "setSeal", seal: "sealed" },
    ]);
    const s = view(played, "participant", "p3");
    assert.deepEqual(s.standings, [], "the session standings are sealed");
    assert.equal(s.trivia?.podium?.length, 2);
    assert.equal(s.trivia?.podium?.[0]?.nickname, "Priya");
    assert.ok(
      (s.trivia?.podium?.[0]?.points ?? 0) > (s.trivia?.podium?.[1]?.points ?? 0),
      "answering sooner is worth more",
    );
  });

  it("is empty before anyone has scored", () => {
    const state = loaded();
    assert.deepEqual(triviaPodium(state, state.trivia!), []);
  });

  it("counts answers per index, including the zeroes", () => {
    const open = loaded([
      { type: "openQuestion", suddenDeath: false },
      { type: "answerQuestion", pid: "p1", choice: 3, ms: 1_000 },
      { type: "answerQuestion", pid: "p2", choice: 3, ms: 2_000 },
    ]);
    assert.deepEqual(distributionOf(open.trivia!, 4), [0, 0, 0, 2]);
  });
});

/* ------------------------------------------------------------------ */
/* Response time                                                       */
/* ------------------------------------------------------------------ */

describe("the latency correction", () => {
  /**
   * ARCHITECTURE.md: response time is
   * `serverReceivedAt − opensAt − min(rtt ÷ 2, 250 ms)`.
   */
  it("subtracts half the round trip", () => {
    assert.equal(correctedResponseMs(T0 + 3_000, T0, 200), 2_900);
    assert.equal(correctedResponseMs(T0 + 3_000, T0, 60), 2_970);
  });

  it("caps the correction at 250 ms", () => {
    // Half of 500 is exactly the cap: the last uncapped value.
    assert.equal(correctedResponseMs(T0 + 3_000, T0, 500), 2_750);
    // Beyond it nothing more is given back, however bad the link.
    assert.equal(correctedResponseMs(T0 + 3_000, T0, 600), 2_750);
    assert.equal(correctedResponseMs(T0 + 3_000, T0, 4_000), 2_750);
    assert.equal(MAX_LATENCY_CORRECTION_MS, 250);
  });

  it("means a terrible link cannot beat a good one", () => {
    // Two people tap at the same instant on the same question. Without the
    // cap the one on the four-second round trip would be credited with
    // answering two seconds earlier than the one on fibre, and would win a
    // speed race they lost.
    const tappedAt = T0 + 5_000;
    const fibre = correctedResponseMs(tappedAt, T0, 20);
    const hotelWifi = correctedResponseMs(tappedAt, T0, 4_000);
    assert.ok(
      hotelWifi >= fibre - MAX_LATENCY_CORRECTION_MS,
      "the correction gave away more than the cap",
    );
    assert.equal(fibre - hotelWifi, MAX_LATENCY_CORRECTION_MS - 10);
  });

  it("gives nothing back when the socket has never been measured", () => {
    // A correction is points. Handing one out on no evidence is the thing the
    // cap exists to bound, so an unmeasured socket gets the harsh answer.
    assert.equal(correctedResponseMs(T0 + 3_000, T0, null), 3_000);
  });

  it("never goes negative", () => {
    // A clock that jumped, or a correction larger than the elapsed time.
    // `round(base × (1 − (t ÷ T) ÷ 2))` with a negative t is more than base.
    assert.equal(correctedResponseMs(T0 + 100, T0, 4_000), 0);
    assert.equal(correctedResponseMs(T0 - 5_000, T0, 20), 0);
  });

  it("takes the median of the recent samples, not the mean", () => {
    // One packet behind a bufferbloated uplink must not move the estimate.
    assert.equal(medianRtt([40, 45, 50, 55, 4_000]), 50);
    assert.equal(medianRtt([]), null);
    // An even count is the mean of the two middle samples, not the upper one.
    // Two samples is the ordinary early state — the probe at hello plus the
    // one fired when the first question opens — and taking the upper made
    // `[40, 4000]` report 4000, which is the outlier this is meant to reject.
    assert.equal(medianRtt([40, 4_000]), 2_020);
    assert.equal(medianRtt([40, 44, 50, 4_000]), 47);
    assert.equal(medianRtt([7]), 7);
    assert.equal(medianRtt([120]), 120);
  });
});

/* ------------------------------------------------------------------ */
/* The boundary and the timer                                          */
/* ------------------------------------------------------------------ */

/** Poll rather than sleep: a fixed wait is a test that fails on a busy box. */
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function fakeClient(pid: string, rtt: number[]): Client {
  // Enough of a socket for `answer` and `send`: readyState 1 is OPEN, and a
  // send that goes nowhere is what a test wants anyway.
  const socket = {
    readyState: 1,
    send() {},
  } as unknown as Client["socket"];
  return { socket, role: "participant", pid, lastSeen: T0, seq: 0, rtt, pingSentAt: null };
}

describe("the socket boundary", () => {
  it("computes ms from the server's clock and hands the engine no timestamp", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), T0);
    runtime.apply({ type: "openQuestion", suddenDeath: false }, T0);

    const client = fakeClient("p1", [100, 100, 100]);
    runtime.clients.add(client);
    const out = runtime.answer(client, 0, 1, T0 + 4_000);
    assert.equal(out.applied, true);

    // 4000 − min(100/2, 250) = 3950.
    assert.equal(runtime.state.trivia?.answers["p1"]?.ms, 3_950);
    const logged = runtime.log.at(-1)?.event;
    assert.equal(logged?.type, "answerQuestion");
    assert.deepEqual(Object.keys(logged ?? {}).sort(), ["choice", "ms", "pid", "type"]);
  });

  it("refuses a tap meant for a question that has moved on", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), T0);
    runtime.apply({ type: "openQuestion", suddenDeath: false }, T0);
    const client = fakeClient("p1", []);
    runtime.clients.add(client);

    const stale = runtime.answer(client, 5, 1, T0 + 1_000);
    assert.equal(stale.applied, false);
    assert.equal(stale.rejection?.code, "question_not_open");
    assert.equal(runtime.state.trivia?.answers["p1"], undefined);
  });

  it("leaves 'already answered' to the engine", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), T0);
    runtime.apply({ type: "openQuestion", suddenDeath: false }, T0);
    const client = fakeClient("p1", []);
    runtime.clients.add(client);
    runtime.answer(client, 0, 1, T0 + 1_000);
    const again = runtime.answer(client, 0, 2, T0 + 2_000);
    assert.equal(again.applied, false);
    assert.equal(again.rejection?.code, "already_answered");
    assert.equal(runtime.state.trivia?.answers["p1"]?.choice, 1, "the first tap stands");
  });
});

describe("the question timer", () => {
  it("arms on open and fires closeQuestion at closesAt", async () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), Date.now());
    const now = Date.now();
    runtime.apply({ type: "openQuestion", suddenDeath: false }, now);
    assert.equal(runtime.state.trivia?.phase, "open");
    assert.equal(runtime.armedCloseAt, runtime.state.trivia?.closesAt);

    // Re-arm at a deadline already in the past — the restart case, and the
    // fastest way to watch the timer actually fire.
    runtime.state = {
      ...runtime.state,
      trivia: { ...runtime.state.trivia!, closesAt: Date.now() - 1 },
    };
    runtime.armQuestionTimer();
    await until(() => runtime.state.trivia?.phase === "closed");
    assert.equal(runtime.state.trivia?.phase, "closed");
    assert.equal(runtime.armedCloseAt, null);
  });

  it("disarms when the host closes early, so the two cannot both land", async () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), Date.now());
    runtime.apply({ type: "openQuestion", suddenDeath: false }, Date.now());
    assert.notEqual(runtime.armedCloseAt, null);

    runtime.apply({ type: "closeQuestion" }, Date.now());
    assert.equal(runtime.state.trivia?.phase, "closed");
    assert.equal(runtime.armedCloseAt, null, "the timer is still armed after an early close");

    // Reveal and advance. A timer left over from question 1 would now close
    // question 2 a moment after it opened.
    runtime.apply({ type: "revealQuestion" }, Date.now());
    runtime.apply({ type: "nextQuestion" }, Date.now());
    runtime.apply({ type: "openQuestion", suddenDeath: false }, Date.now());
    // Long enough that a leftover timer would have fired. It must not have.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(runtime.state.trivia?.phase, "open");
    assert.equal(runtime.state.trivia?.at, 1);
  });

  it("arms nothing for sudden death, which has no timer", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), Date.now());
    runtime.apply({ type: "openQuestion", suddenDeath: true }, Date.now());
    assert.equal(runtime.state.trivia?.suddenDeath, true);
    assert.equal(runtime.state.trivia?.closesAt, null);
    assert.equal(runtime.armedCloseAt, null);
  });
});

/**
 * Auto's clock, and what the console is told about it.
 *
 * The rule about *whether* a beat exists is `autoBeat`, tested as arithmetic
 * in engine/trivia.test.ts. What is tested here is the two things only the
 * server can be wrong about: that the clock is armed for exactly the beats the
 * rule names and disarmed for the ones it does not, and that the mode reaches
 * the console and nobody else.
 */
describe("the trivia beat timer", () => {
  /** Move the pending beat into the past and re-arm, so it fires now. */
  function overdue(runtime: { state: SessionState; armBeatTimer(now?: number): void }): void {
    runtime.state = {
      ...runtime.state,
      trivia: { ...runtime.state.trivia!, autoAt: Date.now() - 60_000 },
    };
    runtime.armBeatTimer();
  }

  it("arms nothing while the set is in manual", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), Date.now());
    runtime.apply({ type: "openQuestion", suddenDeath: false }, Date.now());
    runtime.apply({ type: "closeQuestion" }, Date.now());
    assert.equal(runtime.armedBeatAt, null);
  });

  it("arms the reveal once the question closes, and fires it", async () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), Date.now());
    runtime.apply({ type: "setTriviaAuto", auto: true }, Date.now());
    runtime.apply({ type: "openQuestion", suddenDeath: false }, Date.now());
    assert.equal(runtime.armedBeatAt, null, "an open question is the other timer's");

    runtime.apply({ type: "closeQuestion" }, Date.now());
    assert.notEqual(runtime.armedBeatAt, null);
    overdue(runtime);
    await until(() => runtime.state.trivia?.phase === "revealed");
    assert.equal(runtime.state.trivia?.phase, "revealed");
  });

  it("opens the next question, rather than stopping on an idle one", async () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), Date.now());
    runtime.apply({ type: "setTriviaAuto", auto: true }, Date.now());
    runtime.apply({ type: "openQuestion", suddenDeath: false }, Date.now());
    runtime.apply({ type: "closeQuestion" }, Date.now());
    runtime.apply({ type: "revealQuestion" }, Date.now());
    assert.notEqual(runtime.armedBeatAt, null);

    overdue(runtime);
    await until(() => runtime.state.trivia?.at === 1);
    assert.equal(runtime.state.trivia?.at, 1);
    assert.equal(
      runtime.state.trivia?.phase,
      "open",
      "a set that runs itself has to put the next question up",
    );
    // And the question's own close timer came back armed with it.
    assert.equal(runtime.armedCloseAt, runtime.state.trivia?.closesAt);
  });

  it("stops at the end of the set rather than reaching for a question that is not there", async () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), Date.now());
    runtime.apply({ type: "setTriviaAuto", auto: true }, Date.now());
    // Walk to the last of the three and reveal it.
    for (let i = 0; i < 3; i += 1) {
      runtime.apply({ type: "openQuestion", suddenDeath: false }, Date.now());
      runtime.apply({ type: "closeQuestion" }, Date.now());
      runtime.apply({ type: "revealQuestion" }, Date.now());
      if (i < 2) runtime.apply({ type: "nextQuestion" }, Date.now());
    }
    assert.equal(runtime.state.trivia?.at, 2);
    assert.equal(runtime.armedBeatAt, null, "nothing is armed on the last reveal");
    // Nothing fires, however long anybody waits.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(runtime.state.trivia?.phase, "revealed");
    assert.equal(runtime.state.trivia?.at, 2);
  });

  it("disarms the moment the host presses Manual mid-wait", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), Date.now());
    runtime.apply({ type: "setTriviaAuto", auto: true }, Date.now());
    runtime.apply({ type: "openQuestion", suddenDeath: false }, Date.now());
    runtime.apply({ type: "closeQuestion" }, Date.now());
    assert.notEqual(runtime.armedBeatAt, null);
    runtime.apply({ type: "setTriviaAuto", auto: false }, Date.now());
    assert.equal(runtime.armedBeatAt, null);
  });

  it("arms nothing for a sudden death, and puts Auto away when one opens", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(loaded(), Date.now());
    runtime.apply({ type: "setTriviaAuto", auto: true }, Date.now());
    runtime.apply({ type: "openQuestion", suddenDeath: false }, Date.now());
    runtime.apply({ type: "closeQuestion" }, Date.now());
    runtime.apply({ type: "revealQuestion" }, Date.now());

    runtime.apply({ type: "openQuestion", suddenDeath: true }, Date.now());
    assert.equal(runtime.state.trivia?.auto, false, "the button flips back to Auto");
    runtime.apply({ type: "closeQuestion" }, Date.now());
    assert.equal(runtime.armedBeatAt, null, "a tiebreak is never revealed by a clock");
    runtime.apply({ type: "revealQuestion" }, Date.now());
    assert.equal(runtime.armedBeatAt, null);
  });

  it("re-arms for the instant it always meant after a restart", () => {
    // The recovery case: the process comes back holding a state whose beat is
    // already stamped, and the clock is a function of that state.
    const registry = new SessionRegistry();
    const now = Date.now();
    const recovered = session(
      [
        { type: "open" },
        { type: "join", pid: "p1", nickname: "Priya" },
        { type: "start" },
        { type: "setSegment", segment: "trivia" },
        { type: "loadTrivia", activityId: "trivia", questions: QUESTIONS },
        { type: "setTriviaAuto", auto: true },
        { type: "setTriviaSpeed", seconds: 7 },
        { type: "openQuestion", suddenDeath: false },
        { type: "closeQuestion" },
      ],
      now,
    );
    const { runtime } = registry.add(recovered, now);
    runtime.armBeatTimer(now);
    assert.equal(runtime.state.trivia?.auto, true, "Auto is engine state and comes back");
    assert.equal(runtime.state.trivia?.autoSeconds, 7);
    assert.equal(runtime.armedBeatAt, now + 7_000);
  });
});

describe("Auto on the wire", () => {
  const closed = loaded([
    { type: "setTriviaAuto", auto: true },
    { type: "setTriviaSpeed", seconds: 6 },
    { type: "openQuestion", suddenDeath: false },
    { type: "closeQuestion" },
  ]);

  it("reaches the console with the instant the beat fires", () => {
    const auto = view(closed, "host").hostExtras?.trivia?.auto;
    assert.equal(auto?.on, true);
    assert.equal(auto?.seconds, 6);
    // Absolute, never a duration: a console that gets the frame late still
    // counts down to the instant the server means.
    assert.equal(auto?.advanceAt, T0 + 6_000);
  });

  it("reaches nobody else", () => {
    // `hostExtras` is host-only, but the claim worth asserting is about the
    // bytes: the phone and the big screen are not told the room is on a clock,
    // because a countdown to the reveal is a second clock under a question
    // that has just closed.
    for (const role of ["participant", "screen"] as const) {
      const frame = wire(closed, role, role === "participant" ? "p1" : undefined);
      assert.ok(!frame.includes('"advanceAt"'), `${role}: ${frame}`);
      assert.ok(!frame.includes('"autoSeconds"'), `${role}: ${frame}`);
    }
  });

  it("says nothing is pending when nothing is", () => {
    const manual = loaded([
      { type: "openQuestion", suddenDeath: false },
      { type: "closeQuestion" },
    ]);
    assert.equal(view(manual, "host").hostExtras?.trivia?.auto?.on, false);
    assert.equal(view(manual, "host").hostExtras?.trivia?.auto?.advanceAt, null);
  });
});
