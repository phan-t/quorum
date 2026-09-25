/**
 * The Glass Bridge on the wire: what each role is sent, and — the point of
 * this file — what nothing but the host is sent until the reveal.
 *
 * Expected behaviour comes from SPEC.md ("Round 5 — The Glass Bridge"),
 * DESIGN.md ("The arcade register") and the engine's own analysis in
 * engine/arcade.ts, not from views.ts. Where a test fails the projection is
 * wrong or the spec is ambiguous; the test is left failing and the case is
 * reported.
 *
 * Everything here is asserted against the **serialised frame** rather than a
 * parsed object, for the reason the light-schedule test in arcade.test.ts is:
 * checking a rendered page tests a renderer's discipline, checking the object
 * misses a field somebody adds later under another name, and checking the
 * string is the only version of the claim that survives being edited by
 * someone who has not read this comment.
 *
 * The three claims:
 *
 * 1. **The answer key never leaves the server.** `real` and both reveal notes
 *    are absent from every participant and screen frame until `revealRound`.
 * 2. **No frame pairs a player with a pane.** The engine never stores which
 *    pane anybody chose, because with two panes a pane that *held* identifies
 *    the real pane exactly as well as one that broke. Nothing on the wire
 *    puts it back, and nothing on the wire can be joined to recover it.
 * 3. **A participant's view is a subset of the big screen's.** The big screen
 *    is in the room, so there is no screen-only secret: every field a phone
 *    gets, the screen gets, with the same value.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newSession, replay } from "../engine/reducer.ts";
import type {
  Activity,
  Event,
  GlassStep,
  SessionState,
} from "../engine/types.ts";
import { SessionRegistry, type Client } from "./runtime.ts";
import { renderStateFor } from "./views.ts";
import { parseClientMessage } from "../protocol.ts";
import type { RenderState } from "../protocol.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const ACTIVITIES: readonly Activity[] = [
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

/**
 * Three steps, with labels and notes nothing else in the product contains.
 *
 * "Vault" would appear in half the repository and prove nothing. KRYPTON,
 * XENON and the rest appear in exactly one place each, so finding one in a
 * frame is unambiguous — and so is *not* finding one.
 */
const STEPS: readonly GlassStep[] = [
  {
    product: "Vault",
    panes: [
      { label: "Vault KRYPTON Engine", note: "XENON-NOTE: the real one." },
      { label: "Vault ARGON Mesh", note: "NEON-NOTE: there is no mesh." },
    ],
    real: 0,
  },
  {
    product: "Consul",
    panes: [
      { label: "Consul RADON Beacon", note: "HELIUM-NOTE: no beacon." },
      { label: "Consul IRIDIUM Pool", note: "OSMIUM-NOTE: gossip pools." },
    ],
    real: 1,
  },
  {
    product: "Nomad",
    panes: [
      { label: "Nomad COBALT Drivers", note: "NICKEL-NOTE: task drivers." },
      { label: "Nomad CAESIUM Scheduler", note: "BARIUM-NOTE: not this." },
    ],
    real: 0,
  },
];

const WAVE_SECONDS = [12, 9, 6] as const;

/** Every note in the bank. None of these may appear before the reveal. */
const NOTES = STEPS.flatMap((s) => s.panes.map((p) => p.note));

const T0 = 1_700_000_000_000;

function session(events: readonly Event[], at = T0): SessionState {
  const base = newSession({
    sid: "ses_glass",
    title: "Test",
    joinCode: "hvs.testtesttest",
    activities: ACTIVITIES,
  });
  return replay(
    base,
    events.map((event) => ({ event, at })),
  );
}

/**
 * Six people in the arcade, so the three waves are two apiece.
 *
 * `waveCutsFor` splits contiguous thirds by arcade number: p1 p2 are wave 1,
 * p3 p4 wave 2, p5 p6 wave 3. Three people would work but would make every
 * wave a single player, which hides exactly the case this round is about —
 * half a wave still deciding while the other half has stepped.
 */
function entered(extra: readonly Event[] = []): SessionState {
  return session([
    { type: "open" },
    { type: "join", pid: "p1", nickname: "Priya" },
    { type: "join", pid: "p2", nickname: "Kenji" },
    { type: "join", pid: "p3", nickname: "Ade" },
    { type: "join", pid: "p4", nickname: "Grace" },
    { type: "join", pid: "p5", nickname: "Tobias" },
    { type: "join", pid: "p6", nickname: "Yuki" },
    { type: "start" },
    { type: "setSegment", segment: "arcade" },
    { type: "enterArcade", activityId: "arcade" },
    ...extra,
  ]);
}

const START: Event = {
  type: "startRound",
  round: "glass_bridge",
  config: { kind: "glass_bridge", steps: STEPS, waveSeconds: WAVE_SECONDS },
};

/** The round card is up. Nothing of the bridge has been shown yet. */
function carded(): SessionState {
  return entered([START]);
}

/** Wave 1, step 0, open. */
function crossing(extra: readonly { event: Event; at: number }[] = []): SessionState {
  return replay(entered([START, { type: "beginPlay" }]), extra);
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

/** Every participant's frame, and the big screen's. The public surfaces. */
function publicFrames(state: SessionState): { label: string; frame: string }[] {
  return [
    ...["p1", "p2", "p3", "p4", "p5", "p6"].map((pid) => ({
      label: `participant ${pid}`,
      frame: wire(state, "participant", pid),
    })),
    { label: "screen", frame: wire(state, "screen") },
  ];
}

/* ------------------------------------------------------------------ */
/* 1. The answer key never leaves the server                           */
/* ------------------------------------------------------------------ */

describe("the answer key stays on the server", () => {
  it("is not in any public frame while the round card is up", () => {
    for (const { label, frame } of publicFrames(carded())) {
      for (const note of NOTES) {
        assert.ok(!frame.includes(note), `${label}: a reveal note leaked: ${note}`);
      }
      assert.ok(!frame.includes('"real"'), `${label}: the real pane leaked`);
      assert.ok(!frame.includes('"recap"'), `${label}: the recap leaked`);
    }
  });

  it("is not in any public frame while the bridge is being crossed", () => {
    // Somebody has already fallen, somebody has already crossed a step, and
    // a step has closed and published a break. None of that is the key.
    const mid = crossing([
      { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
      { event: { type: "stepPane", pid: "p2", step: 0, choice: 1 }, at: T0 + 3_000 },
      { event: { type: "nextStep" }, at: T0 + 12_000 },
      { event: { type: "stepPane", pid: "p1", step: 1, choice: 1 }, at: T0 + 14_000 },
    ]);
    for (const { label, frame } of publicFrames(mid)) {
      for (const note of NOTES) {
        assert.ok(!frame.includes(note), `${label}: a reveal note leaked: ${note}`);
      }
      assert.ok(!frame.includes('"real"'), `${label}: the real pane leaked`);
      assert.ok(!frame.includes('"key"'), `${label}: the key leaked`);
    }
  });

  it("is not in a drained player's frame, who is sitting next to somebody still standing", () => {
    // The hazard the engine names in as many words: p2 fell at step 0 and is
    // in the Lounge with nothing to do; p1 is on step 1 at the same table.
    const mid = crossing([
      { event: { type: "stepPane", pid: "p2", step: 0, choice: 1 }, at: T0 + 3_000 },
      { event: { type: "nextStep" }, at: T0 + 12_000 },
    ]);
    assert.equal(view(mid, "participant", "p2").arcadeMine?.standing, "drained");
    const frame = wire(mid, "participant", "p2");
    for (const note of NOTES) assert.ok(!frame.includes(note), note);
    assert.ok(!frame.includes('"real"'), frame);
  });

  it("opens both notes and the real pane to the room at the reveal", () => {
    // SPEC.md: "The reveal note for each pane reads out why the fake was
    // fake." Both notes, because the big screen reads out both — the fake's
    // is the joke and the real one's is what somebody learns.
    const revealed = replay(crossing(), [
      { event: { type: "endRound" }, at: T0 + 200_000 },
      { event: { type: "revealRound" }, at: T0 + 201_000 },
    ]);
    const recap = view(revealed, "participant", "p1").arcade?.glass?.recap;
    assert.equal(recap?.length, 3);
    assert.deepEqual(recap?.[0], {
      product: "Vault",
      labels: ["Vault KRYPTON Engine", "Vault ARGON Mesh"],
      real: 0,
      notes: ["XENON-NOTE: the real one.", "NEON-NOTE: there is no mesh."],
    });
    assert.deepEqual(recap?.[1]?.real, 1);
    for (const { label, frame } of publicFrames(revealed)) {
      for (const note of NOTES) {
        assert.ok(frame.includes(note), `${label}: the reveal withheld ${note}`);
      }
    }
  });

  it("gives the host the key throughout, because the host reads it out", () => {
    // The same rule Recruitment's answer and trivia's `correct` follow: the
    // console is the one surface that may hold the answer while the round is
    // running, because the host is running it.
    const frame = wire(crossing(), "host");
    for (const note of NOTES) assert.ok(frame.includes(note), note);
    const recap = view(crossing(), "host").arcade?.glass?.recap;
    assert.equal(recap?.[2]?.real, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. No frame pairs a player with a pane                              */
/* ------------------------------------------------------------------ */

describe("nothing on the wire says which pane anybody chose", () => {
  it("carries no per-player choice, on any surface, at any phase", () => {
    const mid = crossing([
      { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
      { event: { type: "stepPane", pid: "p2", step: 0, choice: 1 }, at: T0 + 3_000 },
    ]);
    const revealed = replay(mid, [
      { event: { type: "endRound" }, at: T0 + 200_000 },
      { event: { type: "revealRound" }, at: T0 + 201_000 },
    ]);
    for (const state of [crossing(), mid, revealed]) {
      for (const role of ["participant", "screen", "host"] as const) {
        const frame = wire(state, role, "p1");
        assert.ok(!frame.includes('"choice"'), `${role}: a choice is on the wire`);
        assert.ok(!frame.includes('"stepped"'), `${role}: stepped is on the wire`);
      }
    }
  });

  it("counts who is standing on a pane, and names none of them", () => {
    // `onPanes` is the size of `stepped`, and the waiting wave's phone needs
    // it: the bet it draws is open only until the crossing wave puts its
    // first foot down, and a phone that guessed at that would draw a button
    // the engine then refuses. A count names nobody, and it discloses
    // nothing new — every commit either raises that player's `position` or
    // drains them, and both are already in the same frame.
    const mid = crossing([
      { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
      { event: { type: "stepPane", pid: "p2", step: 0, choice: 1 }, at: T0 + 3_000 },
    ]);
    assert.equal(view(crossing(), "participant", "p3").arcade?.glass?.onPanes, 0);
    for (const role of ["participant", "screen", "host"] as const) {
      assert.equal(view(mid, role, "p3").arcade?.glass?.onPanes, 2, role);
    }
    // And it waits for the Floor to open, exactly as `step` does: while the
    // round card is up there is no bridge to be standing on.
    assert.equal(view(carded(), "participant", "p3").arcade?.glass?.onPanes, undefined);
    assert.equal(view(carded(), "screen").arcade?.glass?.onPanes, undefined);
  });

  it("tells the host who has committed and never what they committed to", () => {
    // `hostExtras.arcade.answeredBy` is the keys of `stepped`, never its
    // values: the value is whether their pane held, and "X survived this
    // step" next to a published break is the one join this round prevents.
    const mid = crossing([
      { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
      { event: { type: "stepPane", pid: "p2", step: 0, choice: 1 }, at: T0 + 3_000 },
    ]);
    const hostArcade = view(mid, "host").hostExtras?.arcade;
    assert.deepEqual([...(hostArcade?.answeredBy ?? [])].sort(), ["p1", "p2"]);
    // p1 held and p2 broke; the console is told the same thing about both.
    assert.deepEqual(hostArcade?.drained, ["p2"]);
  });

  it("does not publish a break as a player falls, only as the step closes", () => {
    // The round's one secrecy rule. With two panes, "the left one broke" *is*
    // "the right one is real", and half the wave is still standing on the
    // other side of it. p2 falls at step 0 four seconds in; the other five
    // people in the room learn nothing until the step closes.
    const fell = crossing([
      { event: { type: "stepPane", pid: "p2", step: 0, choice: 1 }, at: T0 + 4_000 },
    ]);
    assert.equal(view(fell, "participant", "p2").arcadeMine?.standing, "drained");
    for (const { label, frame } of publicFrames(fell)) {
      assert.ok(
        frame.includes('"broken":[null,null,null]'),
        `${label}: a break was published while the step was open: ${frame}`,
      );
    }
    // Not even the console, which would otherwise be a surface the host can
    // share by accident with the room the round is being played in.
    assert.ok(wire(fell, "host").includes('"broken":[null,null,null]'));

    // The step closes. Now — and only now — the pane that broke is public,
    // and everyone it could help has already stepped past it.
    const closed = replay(fell, [
      { event: { type: "nextStep" }, at: T0 + 12_000 },
    ]);
    for (const { label, frame } of publicFrames(closed)) {
      assert.ok(
        frame.includes('"broken":[1,null,null]'),
        `${label}: the break was not published at the close: ${frame}`,
      );
    }
  });

  it("leaves a step nobody fell at unpublished, so a silent wave teaches nothing", () => {
    const clean = crossing([
      { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
      { event: { type: "stepPane", pid: "p2", step: 0, choice: 0 }, at: T0 + 3_000 },
      { event: { type: "nextStep" }, at: T0 + 12_000 },
    ]);
    assert.deepEqual(view(clean, "screen").arcade?.glass?.broken, [null, null, null]);
    // And the two of them are visibly on step 1, which says they survived and
    // says nothing about which pane they are standing on.
    assert.equal(view(clean, "screen").arcade?.glass?.position?.["p1"], 1);
  });

  it("does not let the wave's last step publish a break early either", () => {
    // `nextWave` closes the wave's open step on its way past, which is the
    // same close — and the same rule.
    const lastStep = crossing([
      { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
      { event: { type: "stepPane", pid: "p2", step: 0, choice: 0 }, at: T0 + 2_500 },
      { event: { type: "nextStep" }, at: T0 + 12_000 },
      { event: { type: "stepPane", pid: "p1", step: 1, choice: 1 }, at: T0 + 14_000 },
      { event: { type: "stepPane", pid: "p2", step: 1, choice: 1 }, at: T0 + 14_500 },
      { event: { type: "nextStep" }, at: T0 + 24_000 },
      // p1 puts their weight on the fake. Nobody else in the room may learn
      // that from the wire until this step closes.
      { event: { type: "stepPane", pid: "p1", step: 2, choice: 1 }, at: T0 + 26_000 },
    ]);
    assert.equal(view(lastStep, "participant", "p1").arcadeMine?.standing, "drained");
    assert.ok(wire(lastStep, "screen").includes('"broken":[null,null,null]'));
    const waved = replay(lastStep, [
      { event: { type: "nextWave" }, at: T0 + 36_000 },
    ]);
    assert.deepEqual(view(waved, "screen").arcade?.glass?.broken, [null, null, 1]);
    assert.equal(view(waved, "screen").arcade?.glass?.wave, 2);
  });
});

/* ------------------------------------------------------------------ */
/* 3. A participant's view is a subset of the big screen's             */
/* ------------------------------------------------------------------ */

describe("the big screen is in the room, so there is no screen-only secret", () => {
  /** Every phase the round passes through, with people on the bridge. */
  const states: { label: string; state: SessionState }[] = [
    { label: "card", state: carded() },
    { label: "wave 1 open", state: crossing() },
    {
      label: "mid-crossing",
      state: crossing([
        { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
        { event: { type: "stepPane", pid: "p2", step: 0, choice: 1 }, at: T0 + 3_000 },
        { event: { type: "nextStep" }, at: T0 + 12_000 },
        { event: { type: "stepPane", pid: "p1", step: 1, choice: 1 }, at: T0 + 14_000 },
        { event: { type: "nextStep" }, at: T0 + 24_000 },
        { event: { type: "stepPane", pid: "p1", step: 2, choice: 0 }, at: T0 + 26_000 },
        { event: { type: "nextWave" }, at: T0 + 36_000 },
      ]),
    },
  ];

  for (const { label, state } of states) {
    it(`gives a phone nothing at ${label} the screen does not also have`, () => {
      const screen = view(state, "screen").arcade?.glass;
      for (const pid of ["p1", "p3", "p5"]) {
        const mine = view(state, "participant", pid).arcade?.glass;
        if (mine === undefined) {
          assert.equal(screen, undefined, label);
          continue;
        }
        assert.ok(screen !== undefined, `${label}: the screen has no round view`);
        for (const key of Object.keys(mine) as (keyof typeof mine)[]) {
          assert.ok(
            key in screen,
            `${label}/${pid}: the phone has ${String(key)} and the screen does not`,
          );
          assert.deepEqual(
            mine[key],
            screen[key],
            `${label}/${pid}: ${String(key)} differs between the phone and the screen`,
          );
        }
      }
    });
  }

  it("does not put the room's results on a phone", () => {
    // The same rule `planApply.finishOrder` follows. Not a secret — the
    // phone's own `position` map already says who reached the far side — but
    // the phone shows one person's round, and the key is not in the bytes.
    const done = crossing([
      { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
      { event: { type: "nextStep" }, at: T0 + 12_000 },
      { event: { type: "stepPane", pid: "p1", step: 1, choice: 1 }, at: T0 + 14_000 },
      { event: { type: "nextStep" }, at: T0 + 24_000 },
      { event: { type: "stepPane", pid: "p1", step: 2, choice: 0 }, at: T0 + 26_000 },
    ]);
    const frame = wire(done, "participant", "p1");
    assert.ok(!frame.includes('"crossed"'), frame);
    assert.ok(!frame.includes('"fastest"'), frame);
    assert.ok(!frame.includes('"elapsedMs"'), frame);
    // The screen has them, as player numbers, because the announcer says
    // numbers and the big screen is where the room's results live.
    const screen = view(done, "screen").arcade?.glass;
    assert.deepEqual(screen?.crossed, [1]);
    assert.equal(screen?.fastest, 1);
    // `elapsedMs` is the raw material of an award, and every number lives on
    // the console.
    assert.equal(screen?.elapsedMs, undefined);
    assert.equal(view(done, "host").arcade?.glass?.elapsedMs?.["p1"], 6_000);
  });

  it("says who is across on every surface, because the bridge filling in is the point", () => {
    // SPEC.md: the asymmetry is the whole game, and waiting for your wave has
    // to be worth doing. `position` is what a waiting wave watches.
    const done = crossing([
      { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
      { event: { type: "nextStep" }, at: T0 + 12_000 },
      { event: { type: "stepPane", pid: "p1", step: 1, choice: 1 }, at: T0 + 14_000 },
      { event: { type: "nextStep" }, at: T0 + 24_000 },
      { event: { type: "stepPane", pid: "p1", step: 2, choice: 0 }, at: T0 + 26_000 },
    ]);
    for (const role of ["participant", "screen", "host"] as const) {
      const glass = view(done, role, "p5").arcade?.glass;
      assert.equal(glass?.position?.["p1"], 3, role);
      assert.equal(glass?.of, 3, role);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The bridge, as the room reads it                                    */
/* ------------------------------------------------------------------ */

describe("what the bridge puts on the wire", () => {
  it("withholds the panes while the round card is up", () => {
    // Recruitment's rule, for the same reason: the room is looking at the
    // card, and eighteen labels sitting in a phone's JSON twenty seconds
    // early is twenty seconds of reading nobody else gets.
    const card = carded();
    assert.equal(view(card, "participant", "p1").arcade?.glass?.board, undefined);
    for (const { label, frame } of publicFrames(card)) {
      assert.ok(!frame.includes("KRYPTON"), `${label}: a pane label leaked`);
      assert.ok(!frame.includes("IRIDIUM"), `${label}: a pane label leaked`);
    }
    // The host has it, because the host is setting the round up.
    assert.ok(wire(card, "host").includes("KRYPTON"));
  });

  it("sends the whole bridge once the Floor opens, because the screen draws it", () => {
    const open = crossing();
    for (const role of ["participant", "screen", "host"] as const) {
      const board = view(open, role, "p6").arcade?.glass?.board;
      assert.equal(board?.length, 3, role);
      assert.deepEqual(board?.[1], {
        product: "Consul",
        labels: ["Consul RADON Beacon", "Consul IRIDIUM Pool"],
      }, role);
    }
  });

  it("gives every role the step's own deadline, as an instant", () => {
    // Absolute, like every other instant on this wire: a surface that got the
    // frame late still counts down to the same moment. And the step's, never
    // the round's — the round's `endsAt` is three waves away.
    const open = crossing();
    for (const role of ["participant", "screen", "host"] as const) {
      const glass = view(open, role, "p1").arcade?.glass;
      assert.equal(glass?.stepEndsAt, T0 + 12_000, role);
      assert.equal(glass?.stepStartedAt, T0, role);
      assert.equal(glass?.step, 0, role);
    }
    assert.ok(wire(open, "participant", "p1").includes(`"stepEndsAt":${T0 + 12_000}`));
    assert.notEqual(view(open, "screen").arcade?.endsAt, T0 + 12_000);

    // It moves with the step, on the step's own clock: `nextStep` fires 300 ms
    // late and step 2 still gets its twelve seconds.
    const second = replay(open, [{ event: { type: "nextStep" }, at: T0 + 12_300 }]);
    assert.equal(view(second, "participant", "p1").arcade?.glass?.stepEndsAt, T0 + 24_300);

    // And the wave's length changes with the wave. SPEC.md: 12 / 9 / 6.
    const wave2 = replay(open, [{ event: { type: "nextWave" }, at: T0 + 40_000 }]);
    assert.equal(view(wave2, "screen").arcade?.glass?.stepEndsAt, T0 + 49_000);
    assert.deepEqual(view(wave2, "screen").arcade?.glass?.waveSeconds, [12, 9, 6]);
  });

  it("omits the step clocks when no step is open", () => {
    // Omitted rather than nulled or zeroed: the play state carries zeroes
    // until `beginPlay`, and a surface drawing them counts down 00:00 at a
    // room looking at a round card.
    for (const frame of publicFrames(carded())) {
      assert.ok(!frame.frame.includes("stepEndsAt"), frame.label);
      assert.ok(!frame.frame.includes("stepStartedAt"), frame.label);
    }
    const revealed = replay(crossing(), [
      { event: { type: "endRound" }, at: T0 + 200_000 },
      { event: { type: "revealRound" }, at: T0 + 201_000 },
    ]);
    for (const frame of publicFrames(revealed)) {
      assert.ok(!frame.frame.includes("stepEndsAt"), frame.label);
    }
  });

  it("names the waves by the two numbers the room can read off the screen", () => {
    // SPEC.md: "Players cross in three waves by player number." Two cuts, so
    // anybody can work out their own wave from the big screen rather than
    // being told by a field that only their phone has.
    const open = crossing();
    for (const role of ["participant", "screen", "host"] as const) {
      assert.deepEqual(view(open, role, "p1").arcade?.glass?.waveCuts, [2, 4], role);
      assert.equal(view(open, role, "p1").arcade?.glass?.wave, 1, role);
    }
  });

  it("tells one phone its own wave, its own step and its own pane, and no more", () => {
    const mid = crossing([
      { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
      { event: { type: "stepPane", pid: "p2", step: 0, choice: 1 }, at: T0 + 3_000 },
    ]);
    assert.deepEqual(view(mid, "participant", "p1").arcadeMine?.glass, {
      wave: 1,
      onTheBridge: true,
      step: 1,
      committed: true,
      held: true,
      across: false,
    });
    assert.deepEqual(view(mid, "participant", "p2").arcadeMine?.glass, {
      wave: 1,
      onTheBridge: false, // drained
      step: 0,
      committed: true,
      held: false,
      across: false,
    });
    // Wave 3 is watching, and is told so.
    assert.deepEqual(view(mid, "participant", "p5").arcadeMine?.glass, {
      wave: 3,
      onTheBridge: false,
      step: 0,
      committed: false,
      across: false,
    });
    // `held` is omitted, not nulled, until they commit: the key is not in the
    // bytes rather than sitting there as null.
    assert.ok(!wire(mid, "participant", "p5").includes('"held"'));
  });

  it("banks wave 1's blind bonus and shows it on their own phone", () => {
    // SPEC.md: each step crossed banks 5, and wave 1 banks +3 per step for
    // going blind. One step, wave 1: 8.
    const stepped = crossing([
      { event: { type: "stepPane", pid: "p1", step: 0, choice: 0 }, at: T0 + 2_000 },
    ]);
    assert.equal(view(stepped, "participant", "p1").arcadeMine?.banked, 8);
  });
});

/* ------------------------------------------------------------------ */
/* The socket boundary                                                 */
/* ------------------------------------------------------------------ */

function fakeClient(pid: string, rtt: number[]): Client {
  const socket = { readyState: 1, send() {} } as unknown as Client["socket"];
  return { socket, role: "participant", pid, lastSeen: T0, seq: 0, rtt, pingSentAt: null };
}

describe("a step at the socket boundary", () => {
  function running(): ReturnType<SessionRegistry["add"]>["runtime"] {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(entered(), T0);
    runtime.apply(START, T0);
    runtime.apply({ type: "beginPlay" }, T0);
    return runtime;
  }

  it("corrects the decision time for the player's own latency", () => {
    // Six decision times added up are what the fastest full crossing is
    // settled on — 15 points to somebody's backer — so measuring them from
    // the frame's arrival would put the player's network in the award. The
    // same correction a trivia response time gets, and capped the same way.
    const runtime = running();
    runtime.clearArcadeTimers();
    const fast = fakeClient("p1", [20, 20, 20]);
    const slow = fakeClient("p2", [400, 400, 400]);
    runtime.clients.add(fast);
    runtime.clients.add(slow);
    // Both decided at 2 000 ms; the frames arrive 10 ms and 200 ms later.
    assert.equal(runtime.step(fast, 0, 0, 0, T0 + 2_010).applied, true);
    assert.equal(runtime.step(slow, 0, 0, 0, T0 + 2_200).applied, true);
    const play = runtime.state.arcade?.play;
    const elapsed = play?.kind === "glass_bridge" ? play.elapsedMs : {};
    assert.equal(elapsed["p1"], 2_000);
    assert.equal(elapsed["p2"], 2_000);
    runtime.clearArcadeTimers();
  });

  it("lets a slow link's step beat the deadline it actually beat", () => {
    const runtime = running();
    runtime.clearArcadeTimers();
    const slow = fakeClient("p1", [400, 400, 400]);
    runtime.clients.add(slow);
    // Chosen at 11 900 with 100 ms left; the frame lands 100 ms past the
    // deadline. Corrected by 200 ms it is inside the step, which is where
    // the thumb was.
    assert.equal(runtime.step(slow, 0, 0, 0, T0 + 12_100).applied, true);
    runtime.clearArcadeTimers();
  });

  it("refuses a step meant for a round that has moved on", () => {
    const runtime = running();
    runtime.clearArcadeTimers();
    const client = fakeClient("p1", []);
    runtime.clients.add(client);
    // The bridge resets to step 0 at every wave and every round, so step 0 is
    // exactly the index a stale frame carries. The round index is what tells
    // them apart.
    const stale = runtime.step(client, 7, 0, 0, T0 + 1_000);
    assert.equal(stale.applied, false);
    assert.equal(stale.rejection?.code, "wrong_round_phase");
    runtime.clearArcadeTimers();
  });

  it("refuses a step meant for a step that has moved on", () => {
    const runtime = running();
    runtime.clearArcadeTimers();
    const client = fakeClient("p1", []);
    runtime.clients.add(client);
    const stale = runtime.step(client, 0, 1, 0, T0 + 1_000);
    assert.equal(stale.applied, false);
    assert.equal(stale.rejection?.code, "wrong_step");
    runtime.clearArcadeTimers();
  });

  it("refuses a step from a wave that is not on the bridge", () => {
    const runtime = running();
    runtime.clearArcadeTimers();
    const client = fakeClient("p5", []);
    runtime.clients.add(client);
    const early = runtime.step(client, 0, 0, 0, T0 + 1_000);
    assert.equal(early.applied, false);
    assert.equal(early.rejection?.code, "not_your_wave");
    runtime.clearArcadeTimers();
  });

  it("walks the eighteen deadlines itself, and lets the Floor timer alone", () => {
    // Eighteen deadlines accumulate eighteen lots of event-loop lag, so a
    // Floor timer armed at the nominal end would land on top of wave 3's
    // last step — the six-second one. The step timer owns the ending.
    const runtime = running();
    assert.equal(runtime.armedStepAt, T0 + 12_000);
    assert.equal(runtime.armedFloorAt, null);
    runtime.apply({ type: "nextStep" }, T0 + 12_300);
    assert.equal(runtime.armedStepAt, T0 + 24_300);
    assert.equal(runtime.state.arcade?.endsAt, T0 + 24_300 + 12_000 + 3 * 9_000 + 3 * 6_000);
    runtime.apply({ type: "nextStep" }, T0 + 24_600);
    runtime.apply({ type: "nextWave" }, T0 + 36_900);
    // Wave 2's steps are nine seconds.
    assert.equal(runtime.armedStepAt, T0 + 45_900);
    assert.equal(runtime.armedFloorAt, null);
    runtime.clearArcadeTimers();
  });

  it("clears the step timer when the round ends", () => {
    const runtime = running();
    runtime.apply({ type: "endRound" }, T0 + 5_000);
    assert.equal(runtime.armedStepAt, null);
    runtime.clearArcadeTimers();
  });

  it("sends a fall to everybody and a pane that held to three sockets", () => {
    // A fall moves the dormitory grid, which is the whole room's surface, and
    // it is safe to broadcast precisely because no projection of this state
    // says which pane it was. A pane that held goes narrow — the stepper's
    // own phone, the console and the big screen's position row, which is the
    // set `submitAnswer` sends to.
    const runtime = running();
    runtime.clearArcadeTimers();
    interface Counted {
      state: number;
    }
    const counts = new Map<string, Counted>();
    const watch = (
      label: string,
      role: "participant" | "host" | "screen",
      pid?: string,
    ): void => {
      const out: Counted = { state: 0 };
      counts.set(label, out);
      const socket = {
        readyState: 1,
        send(frame: string) {
          if ((JSON.parse(frame) as { t: string }).t === "state") out.state += 1;
        },
      } as unknown as Client["socket"];
      runtime.clients.add({
        socket,
        role,
        ...(pid ? { pid } : {}),
        lastSeen: T0,
        seq: 0,
        rtt: [],
        pingSentAt: null,
      });
    };
    watch("p1", "participant", "p1");
    watch("p2", "participant", "p2");
    watch("p3", "participant", "p3");
    watch("host", "host");
    watch("screen", "screen");
    // What main.ts does as each socket arrives. Counting from before it is
    // counting the connect, not the round.
    runtime.broadcastRoster(T0);
    for (const c of counts.values()) c.state = 0;

    runtime.apply({ type: "stepPane", pid: "p1", step: 0, choice: 0 }, T0 + 1_000);
    assert.equal(counts.get("p1")?.state, 1, "the stepper hears about their own step");
    assert.equal(counts.get("host")?.state, 1);
    assert.equal(counts.get("screen")?.state, 1, "the bridge fills in");
    assert.equal(counts.get("p3")?.state, 0, "and nobody else hears anything");

    for (const c of counts.values()) c.state = 0;
    runtime.apply({ type: "stepPane", pid: "p2", step: 0, choice: 1 }, T0 + 2_000);
    assert.equal(runtime.state.arcade?.standing["p2"], "drained");
    for (const label of ["p1", "p2", "p3", "host", "screen"]) {
      assert.equal(counts.get(label)?.state, 1, `${label} did not see the fall`);
    }
    runtime.clearArcadeTimers();
  });
});

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

describe("the Glass Bridge's frames", () => {
  it("carries no timestamp on a step, because a step's instant is worth points", () => {
    const parsed = parseClientMessage(
      JSON.stringify({ t: "arcade.step", cid: "c1", round: 0, step: 2, choice: 1, at: 9 }),
    );
    assert.deepEqual(parsed, {
      t: "arcade.step",
      cid: "c1",
      round: 0,
      step: 2,
      choice: 1,
    });
  });

  it("refuses a malformed step rather than dropping it silently", () => {
    for (const bad of [
      '{"t":"arcade.step","cid":"c1","round":0,"step":-1,"choice":0}',
      '{"t":"arcade.step","cid":"c1","round":0,"step":0.5,"choice":0}',
      '{"t":"arcade.step","cid":"c1","round":0,"step":0,"choice":-1}',
      '{"t":"arcade.step","cid":"c1","round":0,"step":0}',
      '{"t":"arcade.step","round":0,"step":0,"choice":0}',
    ]) {
      assert.equal(parseClientMessage(bad), null, bad);
    }
  });

  it("takes the three step timers from the console and the panes from nowhere", () => {
    // The eighteen panes carry `real` and both notes, so a round config on
    // the wire would be the answer key arriving from a browser. The command
    // carries the timers; the content is attached on the server.
    const ok = parseClientMessage(
      JSON.stringify({
        t: "host.cmd",
        cid: "c1",
        cmd: { name: "arcade.round", kind: "glass_bridge", waveSeconds: [12, 9, 6], steps: STEPS },
      }),
    );
    assert.deepEqual(ok?.t === "host.cmd" ? ok.cmd : null, {
      name: "arcade.round",
      kind: "glass_bridge",
      waveSeconds: [12, 9, 6],
    });
    for (const bad of [
      { name: "arcade.round", kind: "glass_bridge", waveSeconds: [12, 9] },
      { name: "arcade.round", kind: "glass_bridge", waveSeconds: [12, 9, 0] },
      { name: "arcade.round", kind: "glass_bridge", waveSeconds: [12, 9, 6, 3] },
      { name: "arcade.round", kind: "glass_bridge" },
    ]) {
      const parsed = parseClientMessage(
        JSON.stringify({ t: "host.cmd", cid: "c1", cmd: bad }),
      );
      assert.equal(parsed?.t === "host.cmd" ? parsed.cmd : "?", null, JSON.stringify(bad));
    }
  });

  it("parses the two controls that walk the bridge", () => {
    for (const name of ["arcade.nextStep", "arcade.nextWave"]) {
      const parsed = parseClientMessage(
        JSON.stringify({ t: "host.cmd", cid: "c1", cmd: { name } }),
      );
      assert.deepEqual(parsed?.t === "host.cmd" ? parsed.cmd : null, { name });
    }
  });
});
