/**
 * A question open across a restart stops its clock and resumes when the room
 * is back, rather than closing during a gap nobody could play through.
 *
 * Before this, recovery re-armed the question's own deadline. The process is
 * up well before the load balancer sends anyone to it, so a crash five seconds
 * into a twenty-second question routinely closed it with no phone connected.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { newSession, reduce, replay, RESUME_FLOOR_MS } from "../engine/reducer.ts";
import type { Activity, Event, Question, SessionState } from "../engine/types.ts";
import { Persister } from "./persist.ts";
import { lastAliveAt, recoverSessions } from "./recovery.ts";
import { SessionRegistry } from "./runtime.ts";
import { MemoryStore } from "./store/memory.ts";

const ACTIVITIES: readonly Activity[] = [
  { id: "trivia", title: "Trivia", kind: "trivia" },
];

const QUESTIONS: readonly Question[] = [
  {
    text: "Which product does secrets management?",
    answers: ["A", "B", "C", "D"],
    timeLimitSec: 20,
    correct: [1],
    note: null,
    round: "Round one",
    basePoints: 1000,
  },
];

const SETUP: readonly Event[] = [
  { type: "open" },
  { type: "join", pid: "p1", nickname: "Priya" },
  { type: "start" },
  { type: "setSegment", segment: "trivia" },
  { type: "loadTrivia", activityId: "trivia", questions: QUESTIONS },
];

/** A session whose question opened at `openedAt`, as a running process left it. */
function openAt(openedAt: number): SessionState {
  const base = newSession({
    sid: "ses_pause",
    title: "pause",
    joinCode: "hvs.pausepadpadpadpadpadpadpa",
    activities: ACTIVITIES,
  });
  return replay(base, [
    ...SETUP.map((event) => ({ event, at: openedAt - 1000 })),
    { event: { type: "openQuestion", suddenDeath: false }, at: openedAt },
  ]);
}

async function stored(state: SessionState, writtenAt: number): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putMeta({
    sid: state.sid,
    title: state.title,
    joinCode: state.joinCode,
    phase: state.phase,
    seal: state.seal,
    hostTokenHash: "h",
    screenTokenHash: "s",
    createdAt: writtenAt,
    updatedAt: writtenAt,
  });
  await store.putSnapshot(state.sid, state, writtenAt);
  return store;
}

describe("pauseQuestion / resumeQuestion", () => {
  it("stops the clock with the time that was left, and resumes it from there", () => {
    const opened = 1_000_000;
    const paused = reduce(openAt(opened), { type: "pauseQuestion" }, opened + 5_000).state;
    assert.equal(paused.trivia?.closesAt, null, "nothing counts down while paused");
    assert.deepEqual(paused.trivia?.paused, { elapsedMs: 5_000, remainingMs: 15_000 });

    const back = opened + 60_000;
    const resumed = reduce(paused, { type: "resumeQuestion" }, back).state;
    assert.equal(resumed.trivia?.paused, undefined);
    assert.equal(resumed.trivia?.closesAt, back + 15_000);
    // A response time measured from here counts the five seconds the room
    // had, and not the minute of restart.
    assert.equal(resumed.trivia?.opensAt, back - 5_000);
  });

  it("gives a question that went with a second left the floor, not the second", () => {
    const opened = 1_000_000;
    const paused = reduce(openAt(opened), { type: "pauseQuestion" }, opened + 19_000).state;
    const resumed = reduce(paused, { type: "resumeQuestion" }, opened + 90_000).state;
    assert.equal(resumed.trivia?.closesAt, opened + 90_000 + RESUME_FLOOR_MS);
  });

  it("leaves a question whose deadline had already passed for the timer to close", () => {
    const opened = 1_000_000;
    const out = reduce(openAt(opened), { type: "pauseQuestion" }, opened + 25_000);
    assert.equal(out.state.trivia?.paused, undefined);
    assert.equal(out.state.trivia?.closesAt, opened + 20_000);
  });

  it("does nothing to resume when nothing is paused", () => {
    const state = openAt(1_000_000);
    assert.equal(reduce(state, { type: "resumeQuestion" }, 2_000_000).state, state);
  });

  it("drops the stopped clock when the host closes a paused question", () => {
    const opened = 1_000_000;
    const paused = reduce(openAt(opened), { type: "pauseQuestion" }, opened + 5_000).state;
    const closed = reduce(paused, { type: "closeQuestion" }, opened + 70_000).state;
    assert.equal(closed.trivia?.phase, "closed");
    assert.equal(closed.trivia?.paused, undefined);
  });
});

describe("recovery pauses an open question until the first phone is back", () => {
  it("does not close it at boot, and resumes it with the time it had left", async () => {
    const opened = Date.now() - 120_000;
    // The last write was five seconds in; then the process went away for
    // nearly two minutes, far past the question's twenty-second deadline.
    const store = await stored(openAt(opened), opened + 5_000);

    const registry = new SessionRegistry(new Persister(store, () => {}));
    const boot = Date.now();
    await recoverSessions(store, registry, () => {}, boot);
    const runtime = registry.bySessionId("ses_pause");
    assert.ok(runtime);

    await new Promise((r) => setTimeout(r, 5));
    assert.equal(runtime.state.trivia?.phase, "open", "still open after boot");
    assert.equal(runtime.armedCloseAt, null, "and no deadline armed");

    const back = boot + 30_000;
    runtime.resumePausedQuestion(back);
    assert.equal(runtime.state.trivia?.closesAt, back + 15_000);
    assert.equal(runtime.armedCloseAt, back + 15_000);
    runtime.clearQuestionTimer();
  });

  it("dates the gap from the newest event when it is later than the snapshot", () => {
    const at = lastAliveAt({
      meta: {
        sid: "s",
        title: "s",
        joinCode: "j",
        phase: "running",
        seal: "live",
        hostTokenHash: "h",
        screenTokenHash: "s",
        createdAt: 1,
        updatedAt: 1,
      },
      snapshot: { seq: 3, state: openAt(1_000), writtenAt: 1_000 },
      events: [{ seq: 4, event: { type: "closeQuestion" }, at: 4_000 }],
      participants: [],
    });
    assert.equal(at, 4_000);
  });
});
