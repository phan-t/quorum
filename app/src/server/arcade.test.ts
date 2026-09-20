/**
 * The arcade wire: what each role is sent, and the arithmetic that turns a
 * frame arriving on a socket into an instant the engine can judge.
 *
 * Expected behaviour comes from SPEC.md ("Hashi Arcade") and DESIGN.md ("The
 * arcade register"), not from views.ts. Where a test fails, the projection is
 * wrong or the spec is ambiguous; the test is left failing and the case is
 * reported.
 *
 * The centre of this file is one property, asserted against the *serialised*
 * frame rather than a parsed object: a participant's bytes never contain the
 * light's schedule. A phone that knew when the lock was coming could tap flat
 * out and stop 401 ms early, every time, and would never be caught. Checking
 * the rendered page would test a renderer's discipline; checking the object
 * would miss a field added later under another name. Checking the string is
 * the only version of the claim that survives somebody else editing this.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newSession, replay } from "../engine/reducer.ts";
import type {
  Activity,
  EmojiItem,
  Event,
  SessionState,
} from "../engine/types.ts";
import {
  LIGHT_MAX_MS,
  LIGHT_MIN_MS,
  LOCK_GRACE_MS,
  MAX_LATENCY_CORRECTION_MS,
  SessionRegistry,
  correctedTapAt,
  pickLightMs,
  type Client,
} from "./runtime.ts";
import { AWAY_AFTER_MS, LIGHT_TELEGRAPH_MS, arcadeGrid, renderStateFor } from "./views.ts";
import { parseClientMessage } from "../protocol.ts";
import type { RenderState } from "../protocol.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const ACTIVITIES: readonly Activity[] = [
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

/**
 * Deliberately distinctive. "Vault" would appear in half the product and
 * prove nothing; `KRYPTON-ANSWER` appears in exactly one place, so finding it
 * in a frame is unambiguous.
 */
const ITEMS: readonly EmojiItem[] = [
  {
    cue: "🔐🏦",
    answer: "KRYPTON-ANSWER",
    accept: ["kr"],
    note: "XENON-NOTE: the bit people learn from.",
  },
  {
    cue: "📡🐪",
    answer: "ARGON-ANSWER",
    accept: [],
    note: "NEON-NOTE.",
  },
];

const T0 = 1_700_000_000_000;

function session(events: readonly Event[], at = T0): SessionState {
  const base = newSession({
    sid: "ses_arcade",
    title: "Test",
    joinCode: "hvs.testtesttest",
    activities: ACTIVITIES,
  });
  return replay(
    base,
    events.map((event) => ({ event, at })),
  );
}

/** Three people, in the arcade, with numbers handed out. */
function entered(extra: readonly Event[] = []): SessionState {
  return session([
    { type: "open" },
    { type: "join", pid: "p1", nickname: "Priya" },
    { type: "join", pid: "p2", nickname: "Kenji" },
    { type: "join", pid: "p3", nickname: "Ade" },
    { type: "start" },
    { type: "setSegment", segment: "arcade" },
    { type: "enterArcade", activityId: "arcade" },
    ...extra,
  ]);
}

/** Recruitment, running, with the first item open. */
function recruiting(extra: readonly Event[] = []): SessionState {
  return entered([
    {
      type: "startRound",
      round: "recruitment",
      config: { kind: "recruitment", items: ITEMS, secondsPerItem: 20 },
    },
    { type: "beginPlay" },
    ...extra,
  ]);
}

/** Plan / Apply, running, with PLAN up and a turn scheduled. */
function planning(extra: readonly Event[] = [], until = T0 + 3_000): SessionState {
  return entered([
    {
      type: "startRound",
      round: "plan_apply",
      config: { kind: "plan_apply", target: 120, seconds: 75 },
    },
    { type: "beginPlay" },
    { type: "setLight", light: "plan", until },
    ...extra,
  ]);
}

function view(
  state: SessionState,
  role: "participant" | "host" | "screen",
  pid?: string,
): RenderState {
  return renderStateFor(state, {
    role,
    ...(pid === undefined ? {} : { pid }),
    lastSeen: new Map(),
    now: T0,
  });
}

/** What actually crosses the socket. `send()` stringifies exactly this. */
function wire(
  state: SessionState,
  role: "participant" | "host" | "screen",
  pid?: string,
): string {
  return JSON.stringify({ t: "state", seq: 1, state: view(state, role, pid) });
}

/* ------------------------------------------------------------------ */
/* The property                                                        */
/* ------------------------------------------------------------------ */

describe("a phone cannot predict the light", () => {
  const state = planning();

  it("does not put the schedule on the wire to a participant", () => {
    const frame = wire(state, "participant", "p1");
    assert.equal(view(state, "participant", "p1").arcade?.planApply?.nextChangeAt, undefined);
    // Not "the field is undefined" — neither word is in the bytes at all.
    assert.ok(!frame.includes('"nextChangeAt"'), `the frame carries the schedule: ${frame}`);
    assert.ok(!frame.includes('"headTurnsAt"'), `the frame carries the telegraph: ${frame}`);
    // And nothing to reconstruct it from: the epoch itself must not appear
    // under any other key either.
    assert.ok(
      !frame.includes(String(T0 + 3_000)),
      `the turn's epoch is reachable from a phone's frame: ${frame}`,
    );
  });

  it("does send the light and when it changed, because both are already visible", () => {
    const mine = view(state, "participant", "p1").arcade?.planApply;
    assert.equal(mine?.light, "plan");
    assert.equal(mine?.lightChangedAt, T0);
    // The target and the checkpoints are the rules of the game, not a secret.
    assert.equal(mine?.target, 120);
    assert.deepEqual(mine?.checkpoints, [30, 60, 90]);
  });

  it("does not put the Floor's results on a phone", () => {
    const frame = wire(state, "participant", "p1");
    assert.ok(!frame.includes('"finishOrder"'), frame);
    assert.ok(!frame.includes('"crossed"'), frame);
  });

  it("gives the big screen the telegraph as an absolute epoch", () => {
    // SPEC.md: "the big screen shows the head beginning to turn 400 ms before
    // the lock". As an instant, not a duration: a screen that received this
    // frame late still starts the wipe when the server meant it to.
    const pa = view(state, "screen").arcade?.planApply;
    assert.equal(pa?.nextChangeAt, T0 + 3_000);
    assert.equal(pa?.headTurnsAt, T0 + 3_000 - LIGHT_TELEGRAPH_MS);
    assert.equal(LIGHT_TELEGRAPH_MS, 400);
  });

  it("telegraphs only the turn into the lock, never the turn out of it", () => {
    // Going back to PLAN is a relief, not a warning. A wipe there would
    // train the room to ignore the one that matters.
    const locked = replay(planning(), [
      { event: { type: "setLight", light: "apply", until: T0 + 9_000 }, at: T0 + 3_000 },
    ]);
    const pa = view(locked, "screen").arcade?.planApply;
    assert.equal(pa?.light, "apply");
    assert.equal(pa?.nextChangeAt, T0 + 9_000);
    assert.equal(pa?.headTurnsAt, undefined);
  });

  it("gives the host everything, because the host is running the round", () => {
    const pa = view(state, "host").arcade?.planApply;
    assert.equal(pa?.nextChangeAt, T0 + 3_000);
    assert.equal(pa?.headTurnsAt, T0 + 2_600);
    assert.equal(pa?.crossed, 0);
  });
});

describe("Recruitment does not hand out the answer", () => {
  const open = recruiting();

  it("keeps the answer and the note off a phone and off the screen", () => {
    for (const frame of [wire(open, "participant", "p1"), wire(open, "screen")]) {
      assert.ok(!frame.includes("KRYPTON-ANSWER"), `the answer leaked: ${frame}`);
      assert.ok(!frame.includes("ARGON-ANSWER"), `a later answer leaked: ${frame}`);
      assert.ok(!frame.includes("XENON-NOTE"), `the note leaked: ${frame}`);
    }
    // The host has it, because the host is reading it out.
    assert.ok(wire(open, "host").includes("KRYPTON-ANSWER"));
  });

  it("does send the cue, which is the question", () => {
    assert.equal(view(open, "participant", "p1").arcade?.recruitment?.cue, "🔐🏦");
    assert.equal(view(open, "screen").arcade?.recruitment?.cue, "🔐🏦");
  });

  it("does not send the cue while the round card is up", () => {
    // Twenty seconds of thinking time for whoever has devtools open is
    // twenty seconds nobody else gets.
    const card = entered([
      {
        type: "startRound",
        round: "recruitment",
        config: { kind: "recruitment", items: ITEMS, secondsPerItem: 20 },
      },
    ]);
    assert.equal(view(card, "participant", "p1").arcade?.phase, "card");
    assert.equal(view(card, "participant", "p1").arcade?.recruitment?.cue, undefined);
    assert.ok(!wire(card, "participant", "p1").includes("🔐🏦"));
    assert.ok(!wire(card, "screen").includes("🔐🏦"));
  });

  it("opens the answer, the note and the recap at the reveal", () => {
    const revealed = replay(recruiting(), [
      { event: { type: "endRound" }, at: T0 + 40_000 },
      { event: { type: "revealRound" }, at: T0 + 41_000 },
    ]);
    const r = view(revealed, "participant", "p1").arcade?.recruitment;
    assert.equal(r?.answer, "KRYPTON-ANSWER");
    assert.equal(r?.note, "XENON-NOTE: the bit people learn from.");
    assert.equal(r?.recap?.length, 2);
    assert.ok(wire(revealed, "screen").includes("ARGON-ANSWER"));
  });

  it("gives every role the item's own deadline, as an instant", () => {
    // SPEC: "Six items, 20 seconds each". The round's `endsAt` is the *last*
    // item's, two minutes out on item one, so a surface drawing it in the
    // item-timer slot counts down the wrong number six times running. The
    // item's deadline is not a secret from anybody, and it is an absolute
    // epoch like every other instant on this wire.
    for (const role of ["participant", "host", "screen"] as const) {
      const r = view(open, role, "p1").arcade?.recruitment;
      assert.equal(r?.itemEndsAt, T0 + 20_000, role);
    }
    assert.equal(view(open, "screen").arcade?.endsAt, T0 + 40_000, "and it is not the round's");

    // It moves with the item, and by the item's own clock: `nextItem` fires
    // late and item 2 still gets its twenty seconds.
    const second = replay(recruiting(), [
      { event: { type: "nextItem" }, at: T0 + 20_300 },
    ]);
    assert.equal(view(second, "participant", "p1").arcade?.recruitment?.itemEndsAt, T0 + 40_300);

    // Omitted, not nulled, when no item is running: the round card and the
    // reveal have no item timer to draw.
    const card = entered([
      {
        type: "startRound",
        round: "recruitment",
        config: { kind: "recruitment", items: ITEMS, secondsPerItem: 20 },
      },
    ]);
    assert.ok(!wire(card, "participant", "p1").includes("itemEndsAt"));
    const revealed = replay(recruiting(), [
      { event: { type: "endRound" }, at: T0 + 40_000 },
      { event: { type: "revealRound" }, at: T0 + 41_000 },
    ]);
    assert.ok(!wire(revealed, "screen").includes("itemEndsAt"));
    // And it is never a duration.
    assert.ok(wire(open, "participant", "p1").includes(`"itemEndsAt":${T0 + 20_000}`));
  });

  it("keeps the room's counts off the phone and on the two surfaces that show one", () => {
    const answered = replay(recruiting(), [
      { event: { type: "submitAnswer", pid: "p1", answer: "krypton answer" }, at: T0 + 2_000 },
    ]);
    assert.equal(view(answered, "participant", "p2").arcade?.recruitment?.answered, undefined);
    assert.equal(view(answered, "screen").arcade?.recruitment?.answered, 1);
    assert.equal(view(answered, "screen").arcade?.recruitment?.eligible, 3);
    assert.equal(view(answered, "host").arcade?.recruitment?.solved, 1);
  });

  it("tells one phone whether it was right, and tells it nothing else", () => {
    // Unlike trivia, and the difference is the input: four tiles mean a phone
    // that turns green tells your neighbour which tile to press. A text field
    // means "Recruited." tells them nothing they can type, and DESIGN.md asks
    // for that line on a correct answer.
    const answered = replay(recruiting(), [
      { event: { type: "submitAnswer", pid: "p1", answer: "krypton answer" }, at: T0 + 2_000 },
      { event: { type: "submitAnswer", pid: "p2", answer: "nope" }, at: T0 + 3_000 },
    ]);
    assert.deepEqual(view(answered, "participant", "p1").arcadeMine?.recruitment, {
      state: "locked",
      correct: true,
    });
    assert.deepEqual(view(answered, "participant", "p2").arcadeMine?.recruitment, {
      state: "locked",
      correct: false,
    });
    assert.deepEqual(view(answered, "participant", "p3").arcadeMine?.recruitment, {
      state: "unanswered",
    });
    // The answer they typed is not echoed back: their own phone already knows.
    assert.ok(!wire(answered, "participant", "p2").includes("nope"));
  });
});

/* ------------------------------------------------------------------ */
/* The grid                                                            */
/* ------------------------------------------------------------------ */

describe("the dormitory grid", () => {
  it("is numbers and standing, and carries no points on any surface", () => {
    const drained = replay(planning(), [
      { event: { type: "setLight", light: "apply", until: T0 + 9_000 }, at: T0 + 3_000 },
      { event: { type: "tap", pid: "p2", at: T0 + 4_000 }, at: T0 + 4_000 },
    ]);
    for (const role of ["participant", "screen"] as const) {
      const grid = view(drained, role, "p1").arcade?.grid ?? [];
      assert.equal(grid.length, 3);
      for (const cell of grid) {
        assert.deepEqual(Object.keys(cell).sort(), [
          "backers",
          "pid",
          "playerNumber",
          "standing",
          "struck",
        ]);
      }
    }
    const cells = arcadeGrid(drained, drained.arcade!);
    assert.equal(cells.find((c) => c.pid === "p2")?.standing, "drained");
    assert.equal(cells.find((c) => c.pid === "p2")?.struck, true);
    assert.equal(cells.find((c) => c.pid === "p1")?.standing, "floor");
    assert.equal(view(drained, "screen").arcade?.onFloor, 2);
    assert.equal(view(drained, "screen").arcade?.inLounge, 1);
  });

  it("is sorted by the arcade's own number, so it reads as a grid", () => {
    const state = planning();
    const numbers = (view(state, "screen").arcade?.grid ?? []).map(
      (c) => c.playerNumber,
    );
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  });

  it("drops the strike once the next round's card is up, and not before", () => {
    // A drain lasts exactly one round. The gold stays while the round is up;
    // the pink strike is "drained *this* round" and has to come off with the
    // round — which is the next round's card going up, not the end of this
    // one. `endRound` leaves the phase `idle` and `revealRound` makes it
    // `reveal`, so a strike gated on the phase blinked out at the end of the
    // round and back in a few seconds later, on the one surface a grid of
    // sixty of them is drawn on.
    const drained = replay(planning(), [
      { event: { type: "setLight", light: "apply", until: T0 + 9_000 }, at: T0 + 3_000 },
      { event: { type: "tap", pid: "p2", at: T0 + 4_000 }, at: T0 + 4_000 },
    ]);
    const struck = (s: SessionState): boolean | undefined =>
      arcadeGrid(s, s.arcade!).find((c) => c.pid === "p2")?.struck;
    assert.equal(struck(drained), true, "drained, mid-round");

    const ended = replay(drained, [
      { event: { type: "endRound" }, at: T0 + 60_000 },
    ]);
    assert.equal(ended.arcade?.phase, "idle");
    assert.equal(struck(ended), true, "the round has ended and the strike stays");

    const revealed = replay(ended, [
      { event: { type: "revealRound" }, at: T0 + 63_000 },
    ]);
    assert.equal(struck(revealed), true, "and through the reveal");

    const next = replay(revealed, [
      {
        event: {
          type: "startRound",
          round: "plan_apply",
          config: { kind: "plan_apply", target: 120, seconds: 75 },
        },
        at: T0 + 70_000,
      },
    ]);
    assert.equal(next.arcade?.phase, "card");
    assert.equal(
      arcadeGrid(next, next.arcade!).every((c) => !c.struck),
      true,
      "the next card puts everyone back on the Floor",
    );
  });

  it("counts who is backing whom", () => {
    const backed = replay(planning(), [
      { event: { type: "setLight", light: "apply", until: T0 + 9_000 }, at: T0 + 3_000 },
      { event: { type: "tap", pid: "p2", at: T0 + 4_000 }, at: T0 + 4_000 },
      { event: { type: "tap", pid: "p3", at: T0 + 4_100 }, at: T0 + 4_100 },
      { event: { type: "backPlayer", pid: "p2", backing: "p1" }, at: T0 + 5_000 },
      { event: { type: "backPlayer", pid: "p3", backing: "p1" }, at: T0 + 5_100 },
    ]);
    const cells = arcadeGrid(backed, backed.arcade!);
    assert.equal(cells.find((c) => c.pid === "p1")?.backers, 2);
    // And the backer's own phone knows who it backed.
    assert.equal(view(backed, "participant", "p2").arcadeMine?.backing, "p1");
    // The console gets the whole map, because the host reads it out.
    assert.deepEqual(view(backed, "host").hostExtras?.arcade?.backing, {
      p2: "p1",
      p3: "p1",
    });
  });
});

/* ------------------------------------------------------------------ */
/* The 250 ms grace                                                     */
/* ------------------------------------------------------------------ */

describe("the grace after the lock", () => {
  /**
   * SPEC.md: "There is a 250 ms grace after the lock for network latency,
   * because a fair game over a video call is one where the last tap before
   * the light changed is not a loss."
   */
  const LOCK = T0 + 10_000;

  it("is 250 ms, and it is applied after the latency correction", () => {
    assert.equal(LOCK_GRACE_MS, 250);
    // The two are the two legs of the round trip: the correction takes off
    // the upstream leg, the grace covers the downstream one.
    assert.equal(correctedTapAt(T0 + 3_000, 200, null), T0 + 2_900);
    assert.equal(correctedTapAt(T0 + 3_000, 60, null), T0 + 2_970);
  });

  it("caps the latency half of it at 250 ms, as trivia does", () => {
    assert.equal(correctedTapAt(T0 + 3_000, 4_000, null), T0 + 2_750);
    assert.equal(MAX_LATENCY_CORRECTION_MS, 250);
  });

  it("gives nothing back when the socket has never been measured", () => {
    assert.equal(correctedTapAt(T0 + 3_000, null, null), T0 + 3_000);
  });

  it("pulls a tap inside the window back to just before the lock", () => {
    // Judged against `lightChangedAt >=`, so one millisecond earlier is a
    // PLAN tap and a resource.
    assert.equal(correctedTapAt(LOCK, null, LOCK), LOCK - 1);
    assert.equal(correctedTapAt(LOCK + 1, null, LOCK), LOCK - 1);
    assert.equal(correctedTapAt(LOCK + 249, null, LOCK), LOCK - 1);
  });

  it("stops at 250 ms exactly", () => {
    // The window is `< 250`, not `<= 250`: a grace with a fuzzy edge is a
    // grace nobody can be told the size of.
    assert.equal(correctedTapAt(LOCK + 250, null, LOCK), LOCK + 250);
    assert.equal(correctedTapAt(LOCK + 900, null, LOCK), LOCK + 900);
  });

  it("only ever forgives, and never moves a tap the other way", () => {
    // The bug this shape exists to avoid: subtracting 250 ms unconditionally
    // would slide a legitimate tap at the start of a PLAN back across the
    // boundary into the APPLY before it, and drain somebody for tapping on
    // green. A PLAN light gets no adjustment at all beyond the latency.
    assert.equal(correctedTapAt(LOCK + 40, 0, null), LOCK + 40);
    assert.equal(correctedTapAt(LOCK + 40, 200, null), LOCK - 60);
    // And a tap that was genuinely before the lock is left before the lock.
    assert.equal(correctedTapAt(LOCK - 500, null, LOCK), LOCK - 500);
    assert.equal(correctedTapAt(LOCK - 10, 400, LOCK), LOCK - 210);
  });

  it("means a slow link's tap inside the window is a resource, not a drain", () => {
    // The whole point, end to end, with both legs at once. The lock left the
    // server at LOCK; this phone is 300 ms round trip, so it did not see the
    // light change until LOCK + 150, and the thumb came off the glass 50 ms
    // after that. The frame lands at LOCK + 350.
    const at = correctedTapAt(LOCK + 350, 300, LOCK);
    assert.ok(at < LOCK, `a good-faith tap was judged as a drain: ${at - LOCK}ms late`);
    assert.equal(at, LOCK - 1);
  });

  it("is a flat rate, so a very slow link is still bounded", () => {
    // The flat 250 ms is what stops the grace becoming a reward for a bad
    // connection. On a 600 ms round trip the lock does not reach the phone
    // for 300 ms, and a tap 50 ms after *seeing* it lands at LOCK + 650.
    // The latency correction is capped at 250, so it corrects to 400 ms past
    // the lock — outside the window, and a drain. That is SPEC.md's trade
    // made explicit, and it is the same cap trivia uses: both halves are
    // bounded, so neither is a reward for a bad connection.
    assert.equal(correctedTapAt(LOCK + 650, 600, LOCK), LOCK + 400);
  });
});

/* ------------------------------------------------------------------ */
/* The light                                                           */
/* ------------------------------------------------------------------ */

describe("the light's duration", () => {
  it("is 2 to 6 seconds inclusive", () => {
    assert.equal(LIGHT_MIN_MS, 2_000);
    assert.equal(LIGHT_MAX_MS, 6_000);
    assert.equal(pickLightMs(() => 0), 2_000);
    assert.equal(pickLightMs(() => 0.5), 4_000);
    assert.equal(pickLightMs(() => 0.999_999_9), 6_000);
    for (let i = 0; i < 200; i += 1) {
      const ms = pickLightMs(Math.random);
      assert.ok(ms >= LIGHT_MIN_MS && ms <= LIGHT_MAX_MS, String(ms));
    }
  });

  it("is drawn at the boundary, because the engine has no randomness", () => {
    // The engine gets an absolute `until`, never a duration and never a seed.
    const registry = new SessionRegistry();
    const { runtime } = registry.add(entered(), T0);
    runtime.rng = () => 0.25;
    runtime.apply(
      {
        type: "startRound",
        round: "plan_apply",
        config: { kind: "plan_apply", target: 120, seconds: 75 },
      },
      T0,
    );
    runtime.apply({ type: "beginPlay" }, T0);
    runtime.flipLight(T0);
    const play = runtime.state.arcade?.play;
    assert.equal(play?.kind === "plan_apply" ? play.light : null, "plan");
    // 2000 + floor(0.25 * 4001) = 3000.
    assert.equal(play?.kind === "plan_apply" ? play.nextChangeAt : null, T0 + 3_000);

    // The next one flips, because the light now has a schedule to flip at.
    runtime.flipLight(T0 + 3_000);
    const next = runtime.state.arcade?.play;
    assert.equal(next?.kind === "plan_apply" ? next.light : null, "apply");
    assert.equal(
      next?.kind === "plan_apply" ? next.lightChangedAt : null,
      T0 + 3_000,
    );
  });

  it("gives the first light a duration rather than locking the room instantly", () => {
    // `beginPlay` sets PLAN with `nextChangeAt === lightChangedAt`, which is
    // as far as a reducer with no clock can get. Treating that as "due" and
    // flipping would lock the Floor the instant it opened.
    const registry = new SessionRegistry();
    const { runtime } = registry.add(entered(), T0);
    runtime.rng = () => 0;
    runtime.apply(
      {
        type: "startRound",
        round: "plan_apply",
        config: { kind: "plan_apply", target: 120, seconds: 75 },
      },
      T0,
    );
    runtime.apply({ type: "beginPlay" }, T0);
    const begun = runtime.state.arcade?.play;
    assert.equal(
      begun?.kind === "plan_apply" ? begun.nextChangeAt : null,
      begun?.kind === "plan_apply" ? begun.lightChangedAt : undefined,
    );
    runtime.flipLight(T0);
    const after = runtime.state.arcade?.play;
    assert.equal(after?.kind === "plan_apply" ? after.light : null, "plan");
    assert.equal(after?.kind === "plan_apply" ? after.nextChangeAt : null, T0 + 2_000);
  });
});

/* ------------------------------------------------------------------ */
/* The socket boundary                                                 */
/* ------------------------------------------------------------------ */

function fakeClient(pid: string, rtt: number[]): Client {
  const socket = { readyState: 1, send() {} } as unknown as Client["socket"];
  return { socket, role: "participant", pid, lastSeen: T0, seq: 0, rtt, pingSentAt: null };
}

describe("a tap at the socket boundary", () => {
  function running(): { runtime: ReturnType<SessionRegistry["add"]>["runtime"] } {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(entered(), T0);
    runtime.rng = () => 0.25;
    runtime.apply(
      {
        type: "startRound",
        round: "plan_apply",
        config: { kind: "plan_apply", target: 120, seconds: 75 },
      },
      T0,
    );
    runtime.apply({ type: "beginPlay" }, T0);
    runtime.clearArcadeTimers();
    return { runtime };
  }

  it("hands the engine an instant and no timestamp from the client", () => {
    const { runtime } = running();
    runtime.apply({ type: "setLight", light: "plan", until: T0 + 3_000 }, T0);
    const client = fakeClient("p1", [100, 100, 100]);
    runtime.clients.add(client);
    const out = runtime.tap(client, 0, T0 + 1_000);
    assert.equal(out.applied, true);
    const play = runtime.state.arcade?.play;
    assert.equal(play?.kind === "plan_apply" ? play.resources["p1"] : null, 1);
    const logged = runtime.log.at(-1)?.event;
    assert.equal(logged?.type, "tap");
    assert.deepEqual(Object.keys(logged ?? {}).sort(), ["at", "pid", "type"]);
    // 1000 − min(100/2, 250) = 950 after T0.
    assert.equal(logged?.type === "tap" ? logged.at : null, T0 + 950);
  });

  it("does not drain a tap that lands inside the grace", () => {
    const { runtime } = running();
    runtime.apply({ type: "setLight", light: "apply", until: T0 + 9_000 }, T0 + 3_000);
    const client = fakeClient("p1", []);
    runtime.clients.add(client);
    // 200 ms after the lock, on an unmeasured socket, so the grace is the
    // only thing standing between this person and the Lounge.
    const out = runtime.tap(client, 0, T0 + 3_200);
    assert.equal(out.applied, true);
    assert.equal(runtime.state.arcade?.standing["p1"], "floor");
    const play = runtime.state.arcade?.play;
    assert.equal(play?.kind === "plan_apply" ? play.resources["p1"] : null, 1);
  });

  it("drains a tap past it", () => {
    const { runtime } = running();
    runtime.apply({ type: "setLight", light: "apply", until: T0 + 9_000 }, T0 + 3_000);
    const client = fakeClient("p1", []);
    runtime.clients.add(client);
    const out = runtime.tap(client, 0, T0 + 3_600);
    assert.equal(out.applied, true);
    assert.equal(runtime.state.arcade?.standing["p1"], "drained");
    assert.equal(runtime.state.arcade?.lounge["p1"]?.backing, null);
  });

  it("still drains a tap made in the lock whose frame lands after the light has turned back", () => {
    // The boundary picks the APPLY window the *corrected instant* falls in,
    // not the light that happens to be up when the frame arrives. Without
    // that the grace is unreachable for exactly the people it is for, and the
    // drain is forgiven for exactly the people who earned it.
    const { runtime } = running();
    runtime.apply({ type: "setLight", light: "apply", until: T0 + 5_000 }, T0 + 3_000);
    runtime.apply({ type: "setLight", light: "plan", until: T0 + 11_000 }, T0 + 5_000);
    const client = fakeClient("p1", [400, 400, 400]);
    runtime.clients.add(client);
    // 5100 − 200 = 4900: 1.9 s into a lock that has just ended.
    assert.equal(runtime.tap(client, 0, T0 + 5_100).applied, true);
    assert.equal(runtime.state.arcade?.standing["p1"], "drained");
    runtime.clearArcadeTimers();
  });

  it("still gives the grace to a tap at the lock whose frame lands after the turn back", () => {
    const { runtime } = running();
    runtime.apply({ type: "setLight", light: "apply", until: T0 + 5_000 }, T0 + 3_000);
    runtime.apply({ type: "setLight", light: "plan", until: T0 + 11_000 }, T0 + 5_000);
    const client = fakeClient("p2", [4_000, 4_000, 4_000]);
    runtime.clients.add(client);
    // Capped at 250: 3400 − 250 = 3150, which is 150 ms into the lock and so
    // inside the 250 ms grace. Green when they pressed it, as far as their
    // phone could tell.
    assert.equal(runtime.tap(client, 0, T0 + 3_400).applied, true);
    assert.equal(runtime.state.arcade?.standing["p2"], "floor");
    const play = runtime.state.arcade?.play;
    assert.equal(play?.kind === "plan_apply" ? play.resources["p2"] : null, 1);
    runtime.clearArcadeTimers();
  });

  it("does not let the grace reopen a Floor that has closed", () => {
    // The round ends at T0 + 75 000 and the last lock lands 100 ms before it.
    // The grace pulls a tap inside the window back to `lockedSince − 1`,
    // which is *before* the close — so a frame that arrived after the Floor
    // shut used to be judged as a tap on green, inside the round, and scored.
    const { runtime } = running();
    runtime.apply({ type: "setLight", light: "apply", until: T0 + 80_000 }, T0 + 74_900);
    const client = fakeClient("p1", []);
    runtime.clients.add(client);
    const out = runtime.tap(client, 0, T0 + 75_100);
    assert.deepEqual(out, {
      applied: false,
      rejection: { code: "floor_locked", message: "The Floor is closed." },
    });
    // The ordinary latency correction is untouched by that: a tap whose
    // corrected instant is still inside the round counts, however late the
    // frame is.
    const slow = fakeClient("p2", [400, 400, 400]);
    runtime.clients.add(slow);
    // 75 050 − 200 = 74 850, before both the lock and the close.
    assert.equal(runtime.tap(slow, 0, T0 + 75_050).applied, true);
    const play = runtime.state.arcade?.play;
    assert.equal(play?.kind === "plan_apply" ? play.resources["p2"] : null, 1);
    runtime.clearArcadeTimers();
  });

  it("lets the item timer own Recruitment's ending, with no Floor timer racing it", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(entered(), T0);
    runtime.apply(
      {
        type: "startRound",
        round: "recruitment",
        config: { kind: "recruitment", items: ITEMS, secondsPerItem: 20 },
      },
      T0,
    );
    runtime.apply({ type: "beginPlay" }, T0);
    assert.equal(runtime.armedItemAt, T0 + 20_000);
    assert.equal(runtime.armedFloorAt, null);
    // The item timer runs 250 ms late; the last item still gets twenty
    // seconds of its own, and the round's clock moves with it.
    runtime.apply({ type: "nextItem" }, T0 + 20_250);
    assert.equal(runtime.armedItemAt, T0 + 40_250);
    assert.equal(runtime.armedFloorAt, null);
    assert.equal(runtime.state.arcade?.endsAt, T0 + 40_250);
    runtime.clearArcadeTimers();

    // Plan / Apply is the other way round: no items, and the Floor's clock is
    // the only one that can end it.
    const { runtime: pa } = new SessionRegistry().add(entered(), T0);
    pa.apply(
      {
        type: "startRound",
        round: "plan_apply",
        config: { kind: "plan_apply", target: 120, seconds: 75 },
      },
      T0,
    );
    pa.apply({ type: "beginPlay" }, T0);
    assert.equal(pa.armedFloorAt, T0 + 75_000);
    assert.equal(pa.armedItemAt, null);
    pa.clearArcadeTimers();
  });

  it("refuses a tap meant for a round that has moved on", () => {
    const { runtime } = running();
    const client = fakeClient("p1", []);
    runtime.clients.add(client);
    const stale = runtime.tap(client, 7, T0 + 1_000);
    assert.equal(stale.applied, false);
    assert.equal(stale.rejection?.code, "wrong_round_phase");
  });

  it("refuses a typed answer meant for an item that has moved on", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(entered(), T0);
    runtime.apply(
      {
        type: "startRound",
        round: "recruitment",
        config: { kind: "recruitment", items: ITEMS, secondsPerItem: 20 },
      },
      T0,
    );
    runtime.apply({ type: "beginPlay" }, T0);
    runtime.clearArcadeTimers();
    const client = fakeClient("p1", []);
    runtime.clients.add(client);
    assert.equal(runtime.submitAnswer(client, 1, "kr", T0 + 1_000).rejection?.code, "wrong_round_phase");
    const ok = runtime.submitAnswer(client, 0, "kr", T0 + 1_000);
    assert.equal(ok.applied, true);
    const play = runtime.state.arcade?.play;
    assert.equal(play?.kind === "recruitment" ? play.answered["p1"] : null, true);
  });
});

/* ------------------------------------------------------------------ */
/* What a broadcast costs                                              */
/* ------------------------------------------------------------------ */

describe("what a broadcast costs", () => {
  interface Counted {
    readonly client: Client;
    state: number;
    roster: number;
  }

  function counted(
    runtime: ReturnType<SessionRegistry["add"]>["runtime"],
    role: "participant" | "host" | "screen",
    pid?: string,
  ): Counted {
    const out: Counted = { client: null as unknown as Client, state: 0, roster: 0 };
    const socket = {
      readyState: 1,
      send(frame: string) {
        const t = (JSON.parse(frame) as { t: string }).t;
        if (t === "state") out.state += 1;
        else if (t === "roster") out.roster += 1;
      },
    } as unknown as Client["socket"];
    const client: Client = {
      socket,
      role,
      ...(pid ? { pid } : {}),
      lastSeen: T0,
      seq: 0,
      rtt: [],
      pingSentAt: null,
    };
    runtime.clients.add(client);
    return Object.assign(out, { client });
  }

  function room() {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(entered(), T0);
    runtime.apply(
      {
        type: "startRound",
        round: "plan_apply",
        config: { kind: "plan_apply", target: 120, seconds: 75 },
      },
      T0,
    );
    runtime.apply({ type: "beginPlay" }, T0);
    runtime.apply({ type: "setLight", light: "plan", until: T0 + 3_000 }, T0);
    const phones = ["p1", "p2", "p3"].map((pid) => counted(runtime, "participant", pid));
    const host = counted(runtime, "host");
    const screen = counted(runtime, "screen");
    // What main.ts does as each socket arrives: a full state to the new one
    // and the roster to everybody else. Counting from after that is counting
    // the round, not the connect.
    runtime.broadcastRoster(T0);
    for (const c of [...phones, host, screen]) {
      c.state = 0;
      c.roster = 0;
    }
    return { runtime, phones, host, screen };
  }

  it("sends no roster frame when the roster has not moved", () => {
    // A `to: "all"` state broadcast used to force a roster resend on every
    // socket — and the state frame it follows already carries the roster, so
    // it was a second full frame saying the same thing. Over a 75 s Floor at
    // sixty players that was 11 100 frames; see bots/arcade-round.test.ts.
    const { runtime, phones, host, screen } = room();
    runtime.apply({ type: "setLight", light: "apply", until: T0 + 6_000 }, T0 + 3_000);
    for (const p of phones) {
      assert.equal(p.state, 1, "the light turn is room-wide");
      assert.equal(p.roster, 0, "and the roster did not move");
    }
    assert.equal(host.state, 1);
    assert.equal(screen.state, 1);

    // Nor does the fifteen-second sweep, whose job is to repaint the roster
    // when somebody goes amber. Nobody has.
    runtime.sweep(T0 + 3_100);
    for (const p of phones) assert.equal(p.roster, 0);
    // Let one go quiet and it does repaint.
    const first = phones[0];
    assert.ok(first);
    first.client.lastSeen = T0 - AWAY_AFTER_MS - 1;
    runtime.sweep(T0 + 3_200);
    for (const p of phones) assert.equal(p.roster, 1);
    runtime.clearArcadeTimers();
  });

  it("sends one when it has", () => {
    const { runtime, phones, host } = room();
    runtime.apply({ type: "join", pid: "p4", nickname: "Mei" }, T0 + 1_000);
    for (const p of phones) assert.equal(p.roster, 1, "somebody joined");
    // The host gets a whole state instead: their headcount lives in
    // hostExtras, which a roster frame does not carry.
    assert.equal(host.state, 2);
    // Kicking them moves it back, and that is a second roster frame, not a
    // suppressed one — the comparison is on the roster, not on the event.
    runtime.apply({ type: "kick", pid: "p4" }, T0 + 2_000);
    for (const p of phones) assert.equal(p.roster, 2);
    runtime.clearArcadeTimers();
  });

  it("sends a checkpoint to the phone that earned it and the console, and nobody else", () => {
    const { runtime, phones, host, screen } = room();
    const p1 = phones[0];
    assert.ok(p1);
    for (let i = 0; i < 29; i += 1) {
      runtime.apply({ type: "tap", pid: "p1", at: T0 + 100 + i }, T0 + 100 + i);
    }
    assert.equal(p1.state, 0, "an ordinary tap is worth no frames at all");
    runtime.apply({ type: "tap", pid: "p1", at: T0 + 200 }, T0 + 200);
    assert.equal(runtime.state.arcade?.banked["p1"], 5);
    assert.equal(p1.state, 1);
    assert.equal(host.state, 1);
    assert.equal(screen.state, 0, "the screen does not draw anybody's resources");
    assert.equal(phones[1]?.state, 0);
    assert.equal(phones[2]?.state, 0);
    for (const p of phones) assert.equal(p.roster, 0);
    runtime.clearArcadeTimers();
  });

  it("sends a drain to everybody, because the dormitory grid moves", () => {
    const { runtime, phones, screen } = room();
    runtime.apply({ type: "setLight", light: "apply", until: T0 + 9_000 }, T0 + 3_000);
    runtime.apply({ type: "tap", pid: "p1", at: T0 + 4_000 }, T0 + 4_000);
    assert.equal(runtime.state.arcade?.standing["p1"], "drained");
    for (const p of phones) assert.equal(p.state, 2, "the light turn and the drain");
    assert.equal(screen.state, 2);
    runtime.clearArcadeTimers();
  });
});

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

describe("the arcade's frames", () => {
  it("carries no timestamp on a tap, because a tap's instant is worth points", () => {
    const parsed = parseClientMessage(
      JSON.stringify({ t: "arcade.tap", cid: "c1", round: 0, at: 123 }),
    );
    assert.deepEqual(parsed, { t: "arcade.tap", cid: "c1", round: 0 });
  });

  it("refuses a malformed round index rather than dropping it silently", () => {
    assert.equal(parseClientMessage('{"t":"arcade.tap","cid":"c1","round":-1}'), null);
    assert.equal(parseClientMessage('{"t":"arcade.tap","cid":"c1","round":0.5}'), null);
    assert.equal(parseClientMessage('{"t":"arcade.tap","round":0}'), null);
  });

  it("bounds a typed answer at the boundary", () => {
    const long = "x".repeat(500);
    const parsed = parseClientMessage(
      JSON.stringify({ t: "arcade.answer", cid: "c1", item: 0, answer: long }),
    );
    assert.equal(
      parsed?.t === "arcade.answer" ? parsed.answer.length : null,
      64,
    );
  });

  it("only accepts a round configuration that matches its round", () => {
    const ok = parseClientMessage(
      JSON.stringify({
        t: "host.cmd",
        cid: "c1",
        cmd: { name: "arcade.round", kind: "plan_apply", target: 120, seconds: 75 },
      }),
    );
    assert.deepEqual(ok?.t === "host.cmd" ? ok.cmd : null, {
      name: "arcade.round",
      kind: "plan_apply",
      target: 120,
      seconds: 75,
    });
    // A round that is designed and not built is refused on the wire, so the
    // console finds out rather than starting something that does nothing.
    const unbuilt = parseClientMessage(
      JSON.stringify({
        t: "host.cmd",
        cid: "c1",
        cmd: { name: "arcade.round", kind: "gganbu", target: 10, seconds: 10 },
      }),
    );
    assert.equal(unbuilt?.t === "host.cmd" ? unbuilt.cmd : "?", null);
    // And a target of zero is a round where everyone is across on tap one.
    const zero = parseClientMessage(
      JSON.stringify({
        t: "host.cmd",
        cid: "c1",
        cmd: { name: "arcade.round", kind: "plan_apply", target: 0, seconds: 75 },
      }),
    );
    assert.equal(zero?.t === "host.cmd" ? zero.cmd : "?", null);
  });
});
