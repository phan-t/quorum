/**
 * The mock server, checked against the thing it is a mock of.
 *
 * `mock.ts` is a second implementation of the engine and of the projection —
 * five thousand lines of it — written independently on purpose, because a mock
 * that borrowed `views.ts` could never catch `views.ts` putting an answer on a
 * phone. That is a good reason to keep two copies and a bad reason to leave
 * them unwatched: three divergences were found in as many days, none of them
 * by anything failing, all of them by somebody reading the two files side by
 * side. A demo that lies is worse than no demo, because `?mock=1` is the only
 * way anybody sees the console and the Desktop without staging a real session,
 * and "the demo shows X" then stops being evidence that the product does X.
 *
 * So: this file drives the mock through its own socket, drives the **engine**
 * through the same sequence, and compares. Where the two must agree, the
 * assertion is against the reducer's output and not against a number typed in
 * here — a test that pinned the mock's current behaviour would have passed
 * happily on every one of the three bugs below.
 *
 * ## How the mock is driven
 *
 * It only exports `mockTransport`, which memoises one hub per module instance,
 * so each scenario imports a fresh copy of the module with a cache-busting
 * query. Time is `node:test`'s fake clock: the mock is `setTimeout` from top
 * to bottom, and a fake clock makes the whole thing — the connect handshake,
 * the round timers, the scripted director's seven minutes — deterministic and
 * instant. It also keeps the scenarios below under the one-second mark at
 * which `?mock=manual` starts joining its own bots, so the only participants
 * in a round are the ones a test put there.
 *
 * ## What is checked
 *
 * - **#17** the round counter moves on the same transition in both.
 * - **#19** the console's "who has committed" list covers the same rounds.
 * - **#12** the loop holds `final` for as long as the Desktop spends playing
 *   it, which is a number `view.ts` owns and neither side may guess at.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { newSession, replay } from "../../engine/reducer.ts";
import type {
  Activity,
  ArcadeRoundConfig,
  Event,
  SessionState,
  UnsealShape,
} from "../../engine/types.ts";
import { renderStateFor } from "../../server/views.ts";
import type {
  ClientMessage,
  HostCommand,
  RenderState,
  ServerMessage,
} from "../../protocol.ts";
import { RECRUITMENT_ITEMS } from "../../arcade/recruitment.ts";
import { GLASS_BRIDGE_STEPS } from "../../arcade/glass-bridge.ts";
import { UNSEAL_ITEMS } from "../../arcade/unseal.ts";
import { GGANBU_PROMPTS } from "../../arcade/gganbu.ts";
import { finalRevealMs } from "./view.ts";
import type { MockConfig } from "./mock.ts";
import type { Transport } from "./transport.ts";

/* ------------------------------------------------------------------ */
/* The mock, driven through its own socket                             */
/* ------------------------------------------------------------------ */

type MockModule = typeof import("./mock.ts");

const MOCK_URL = new URL("./mock.ts", import.meta.url).href;
let instance = 0;

/**
 * A module instance nobody else is holding.
 *
 * `mockTransport` does `hub ??= new MockHub(cfg)`, which is right for a page —
 * the console, the Desktop and a phone opened in three tabs each get their own
 * — and wrong for a test file, where the second scenario would inherit the
 * first one's room. The query string is discarded by the resolver and honoured
 * by the module cache, which is exactly the asymmetry wanted here.
 */
async function freshMock(): Promise<MockModule> {
  instance += 1;
  return (await import(`${MOCK_URL}?instance=${instance}`)) as MockModule;
}

const MANUAL: MockConfig = {
  // No scripted director: these scenarios drive the console themselves. The
  // director is turned on for exactly one suite, the one about its timing.
  director: false,
  speed: 1,
  drop: false,
  gap: false,
  // Zero, so a tick of one millisecond delivers a frame. The latency the real
  // config defaults to is there to make a demo look like a network, and here
  // it would only mean larger numbers in `tick`.
  latency: 0,
};

/** One connected surface, and every frame it has been sent. */
interface Wire {
  readonly transport: Transport;
  readonly frames: ServerMessage[];
  /** The most recent full state frame, which is what every assertion reads. */
  state(): RenderState;
  send(msg: ClientMessage): void;
}

/**
 * A room: one console, one Desktop, and however many phones were asked for.
 *
 * The phones join in order and the mock hands out `p1`, `p2`, … in join order,
 * which is the same scheme the engine's own fixtures use — so a pid means the
 * same person on both sides of every comparison in this file and the two
 * `answeredBy` lists can be compared as-is rather than through a mapping.
 */
interface Room {
  readonly host: Wire;
  readonly screen: Wire;
  readonly phones: readonly Wire[];
  /** Send a console command and let the frames it produces arrive. */
  cmd(command: HostCommand): void;
  /** Let pending frames arrive. */
  settle(): void;
}

async function room(t: TestContext, phoneCount: number): Promise<Room> {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const mod = await freshMock();
  const factory = mod.mockTransport(MANUAL);
  const tick = (ms: number): void => t.mock.timers.tick(ms);

  const open = (hello: Extract<ClientMessage, { t: "hello" }>): Wire => {
    const frames: ServerMessage[] = [];
    const transport = factory({
      onOpen() {},
      onMessage(msg) {
        frames.push(msg);
      },
      onClose() {},
    });
    // The hub acks a connection ten milliseconds later, as a socket would.
    tick(11);
    transport.send(hello);
    tick(2);
    const wire: Wire = {
      transport,
      frames,
      state() {
        const last = frames.filter((f) => f.t === "state").at(-1);
        assert.ok(last !== undefined && last.t === "state", "no state frame yet");
        return last.state;
      },
      send(msg) {
        transport.send(msg);
        tick(2);
      },
    };
    return wire;
  };

  const host = open({ t: "hello", role: "host", hostToken: "mock-host" });
  const screen = open({ t: "hello", role: "screen", screenToken: "mock-screen" });
  // The mock draws its own join code at construction and puts it on the
  // console's frame, so a phone has to be told what the console was told.
  const joinCode = host.state().joinCode;
  assert.ok(joinCode, "the console frame carries no join code");
  const phones: Wire[] = [];
  for (let i = 0; i < phoneCount; i += 1) {
    phones.push(
      open({
        t: "hello",
        role: "participant",
        joinCode,
        nickname: `Player ${i + 1}`,
      }),
    );
  }

  let cid = 0;
  return {
    host,
    screen,
    phones,
    cmd(command) {
      cid += 1;
      host.send({ t: "host.cmd", cid: `cid-${cid}`, cmd: command });
      const refused = host.frames.filter((f) => f.t === "refusedCmd");
      const last = refused.at(-1);
      assert.ok(
        last === undefined || last.cid !== `cid-${cid}`,
        `the mock refused ${command.name}: ${last?.t === "refusedCmd" ? last.message : ""}`,
      );
    },
    settle() {
      tick(2);
    },
  };
}

/* ------------------------------------------------------------------ */
/* The engine, driven through the same sequence                        */
/* ------------------------------------------------------------------ */

const T0 = 1_700_000_000_000;

const ACTIVITIES: readonly Activity[] = [
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

/**
 * The same room on the real engine: the same people, in the same order, so the
 * arcade numbers and therefore the Glass Bridge's waves come out the same.
 */
function engineRoom(phoneCount: number, extra: readonly Event[] = []): SessionState {
  const joins: Event[] = [];
  for (let i = 0; i < phoneCount; i += 1) {
    joins.push({ type: "join", pid: `p${i + 1}`, nickname: `Player ${i + 1}` });
  }
  const base = newSession({
    sid: "ses_divergence",
    title: "Divergence",
    joinCode: "hvs.testtesttest",
    activities: ACTIVITIES,
  });
  const events: readonly Event[] = [
    { type: "open" },
    ...joins,
    { type: "start" },
    { type: "setSegment", segment: "arcade" },
    { type: "enterArcade", activityId: "arcade" },
    ...extra,
  ];
  return replay(
    base,
    events.map((event) => ({ event, at: T0 })),
  );
}

function engineView(state: SessionState): RenderState {
  return renderStateFor(state, { role: "host", lastSeen: new Map(), now: T0 });
}

/**
 * The console command and the engine event for one round, side by side.
 *
 * Both halves carry the *same content* — `src/arcade/`'s own items, which the
 * mock reads directly and the real server passes in as a config — so a
 * comparison of the two projections is a comparison of the code and not of two
 * different sets of questions.
 */
interface RoundPair {
  readonly kind: string;
  readonly cmd: Extract<HostCommand, { name: "arcade.round" }>;
  readonly config: ArcadeRoundConfig;
}

/** A fixed seed, because a seed drawn twice is two different rounds. */
const SEED = 0x5eed_1234;

const ROUNDS: readonly RoundPair[] = [
  {
    kind: "recruitment",
    cmd: { name: "arcade.round", kind: "recruitment", secondsPerItem: 20 },
    config: { kind: "recruitment", items: RECRUITMENT_ITEMS, secondsPerItem: 20 },
  },
  {
    kind: "plan_apply",
    cmd: { name: "arcade.round", kind: "plan_apply", target: 120, seconds: 90 },
    config: { kind: "plan_apply", target: 120, seconds: 90 },
  },
  {
    kind: "unseal",
    cmd: { name: "arcade.round", kind: "unseal", seconds: 60 },
    config: { kind: "unseal", items: UNSEAL_ITEMS, seconds: 60 },
  },
  {
    kind: "tug_of_raft",
    cmd: {
      name: "arcade.round",
      kind: "tug_of_raft",
      pulls: 3,
      pullSeconds: 25,
      bpm: 100,
    },
    config: {
      kind: "tug_of_raft",
      pulls: 3,
      pullSeconds: 25,
      bpm: 100,
      seed: SEED,
    },
  },
  {
    kind: "gganbu",
    cmd: {
      name: "arcade.round",
      kind: "gganbu",
      secondsPerPrompt: 15,
      startTokens: 10,
    },
    config: {
      kind: "gganbu",
      prompts: GGANBU_PROMPTS,
      secondsPerPrompt: 15,
      startTokens: 10,
      seed: SEED,
    },
  },
  {
    kind: "glass_bridge",
    cmd: { name: "arcade.round", kind: "glass_bridge", waveSeconds: [12, 9, 6] },
    config: {
      kind: "glass_bridge",
      steps: GLASS_BRIDGE_STEPS,
      waveSeconds: [12, 9, 6],
    },
  },
];

function roundPair(kind: string): RoundPair {
  const found = ROUNDS.find((r) => r.kind === kind);
  assert.ok(found !== undefined, `no round pair for ${kind}`);
  return found;
}

/* ------------------------------------------------------------------ */
/* #17 — when the round counter moves                                  */
/* ------------------------------------------------------------------ */

describe("the round counter moves on the transition the reducer moves it on", () => {
  /**
   * The counter used to be bumped at the round's *end* in the mock and at the
   * round's *start* in the reducer. Both walk 0, 1, 2, so nothing reading it
   * as "which round of the run is this" could tell them apart — which is why
   * this went unnoticed. The Desktop reads it as a reset key instead.
   */
  it("walks two rounds with the same index on every frame the reducer has one", async (t) => {
    const r = await room(t, 6);
    const pair = roundPair("tug_of_raft");
    const second = roundPair("unseal");
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });

    let engine = engineRoom(6);
    const seen: { where: string; mock: number | undefined; real: number }[] = [];
    const compare = (where: string): void => {
      seen.push({
        where,
        mock: r.host.state().arcade?.roundIndex,
        real: engineView(engine).arcade?.roundIndex ?? -1,
      });
    };
    const step = (where: string, cmd: HostCommand, event: Event): void => {
      r.cmd(cmd);
      engine = replay(engine, [{ event, at: T0 }]);
      compare(where);
    };

    compare("in the arcade, before any round");
    step("round 1, card up", pair.cmd, {
      type: "startRound",
      round: "tug_of_raft",
      config: pair.config,
    });
    step("round 1, running", { name: "arcade.begin" }, { type: "beginPlay" });
    step("round 1, ended", { name: "arcade.end" }, { type: "endRound" });
    step("round 1, revealed", { name: "arcade.reveal" }, { type: "revealRound" });
    step("round 2, card up", second.cmd, {
      type: "startRound",
      round: "unseal",
      config: second.config,
    });
    step("round 2, running", { name: "arcade.begin" }, { type: "beginPlay" });
    step("round 2, ended", { name: "arcade.end" }, { type: "endRound" });

    for (const { where, mock, real } of seen) {
      assert.equal(mock, real, `roundIndex diverges at: ${where}`);
    }
    // And the walk was worth making: the two rounds are not both index 0.
    assert.deepEqual(
      seen.map((s) => s.real),
      [0, 0, 0, 0, 0, 1, 1, 1],
    );
  });

  it("does not put a new index on the frame that ends a round", async (t) => {
    // The Desktop's win beat keys its memory of the last pull's tallies off
    // `roundIndex`, and resets when it changes — correctly, because a new
    // index is a new rope. But the pull that *wins* a round is settled by the
    // round's end, so the winning tallies and the `idle` phase arrive on one
    // frame. A new index on that frame makes the beat forget the round on the
    // frame it was supposed to narrate, and the last pull of every Tug round
    // goes unsaid.
    const r = await room(t, 6);
    const pair = roundPair("tug_of_raft");
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    const running = r.screen.state().arcade;
    assert.equal(running?.phase, "running");

    r.cmd({ name: "arcade.end" });
    const ended = r.screen.state().arcade;
    assert.equal(ended?.phase, "idle", "the round did not end");
    assert.equal(
      ended?.roundIndex,
      running?.roundIndex,
      "the closing frame carries a different round than the round it closed",
    );
  });

  it("refuses a frame that arrives after the round ended, by phase and not by index", async (t) => {
    // The counter also guards inbound frames: a tap carrying last round's
    // index is refused. Moving the bump to the start means a tap arriving
    // after `endRound` now matches the index and falls through to the phase
    // check instead — which is precisely what the real server does with the
    // same late frame, and the reason this is a safe place to move it.
    const r = await room(t, 6);
    const pair = roundPair("tug_of_raft");
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    const round = r.host.state().arcade?.roundIndex ?? -1;
    r.cmd({ name: "arcade.end" });

    const phone = r.phones[0];
    assert.ok(phone !== undefined);
    phone.send({ t: "arcade.beat", cid: "late", round });
    const refusal = phone.frames.filter((f) => f.t === "refusedCmd").at(-1);
    assert.ok(refusal !== undefined && refusal.t === "refusedCmd");
    assert.equal(refusal.cid, "late", "the late beat was not refused at all");
    assert.equal(refusal.message, "There is no rope.");
  });
});

/* ------------------------------------------------------------------ */
/* #19 — who the console is told has committed                         */
/* ------------------------------------------------------------------ */

describe("the console is told who has committed, in every round that has a commitment", () => {
  /**
   * `hostExtras.arcade.answeredBy` is the number behind the console's "N of M
   * have picked" — the line a facilitator reads to decide whether to move on.
   * The mock built it for two of the four rounds that have one, so the demo
   * console read a flat zero for the whole of Unseal and the Glass Bridge
   * while its own bots were visibly picking and stepping. A zero looks like a
   * round that has not started, which is why nobody noticed.
   *
   * Each case commits with the *same two people* on both sides and compares
   * the lists. Comparing against the engine and not against `["p1","p2"]` is
   * what makes this a divergence test: if the engine ever stops publishing one
   * of these, this fails too, and the answer is a conversation rather than a
   * one-line edit here.
   */
  interface Commit {
    readonly kind: string;
    /** What the two phones send. */
    readonly phone: (r: Room, index: number, round: number) => void;
    /** The same two commitments as engine events. */
    readonly events: (state: SessionState) => readonly Event[];
    readonly expect: readonly string[];
  }

  /**
   * A shape the room actually has tins of, read off the console's own frame.
   *
   * Picking a literal would be picking whichever shape `UNSEAL_ITEMS` happens
   * to lead with today, and the round deals a subset by player number.
   */
  const availableShape = (r: Room): UnsealShape => {
    const shapes = r.host.state().arcade?.unseal?.shapes ?? [];
    const found = shapes.find((s) => s.available);
    assert.ok(found !== undefined, "the round dealt no tins at all");
    return found.shape;
  };

  const COMMITS: readonly Commit[] = [
    {
      kind: "recruitment",
      phone: (r, i, round) => {
        r.phones[i]?.send({
          t: "arcade.answer",
          cid: `a${i}`,
          item: 0,
          answer: "vault",
        });
        void round;
      },
      events: () => [
        { type: "submitAnswer", pid: "p1", answer: "vault" },
        { type: "submitAnswer", pid: "p2", answer: "vault" },
      ],
      expect: ["p1", "p2"],
    },
    {
      kind: "unseal",
      phone: (r, i, round) => {
        r.phones[i]?.send({
          t: "arcade.shape",
          cid: `s${i}`,
          round,
          shape: availableShape(r),
        });
      },
      events: (state) => {
        const shape = renderStateFor(state, {
          role: "host",
          lastSeen: new Map(),
          now: T0,
        }).arcade?.unseal?.shapes.find((s) => s.available)?.shape;
        assert.ok(shape !== undefined, "the engine dealt no tins at all");
        return [
          { type: "pickShape", pid: "p1", shape },
          { type: "pickShape", pid: "p2", shape },
        ];
      },
      expect: ["p1", "p2"],
    },
    {
      kind: "glass_bridge",
      // p1 and p2 are the whole of wave 1 in a room of six, on both sides,
      // because both split the arcade numbers into contiguous thirds.
      phone: (r, i, round) => {
        r.phones[i]?.send({
          t: "arcade.step",
          cid: `g${i}`,
          round,
          step: 0,
          choice: 0,
        });
      },
      events: () => [
        { type: "stepPane", pid: "p1", step: 0, choice: 0 },
        { type: "stepPane", pid: "p2", step: 0, choice: 0 },
      ],
      expect: ["p1", "p2"],
    },
    {
      kind: "gganbu",
      phone: (r, i, round) => {
        r.phones[i]?.send({
          t: "arcade.wager",
          cid: `w${i}`,
          round,
          pick: "over",
          amount: 2,
        });
      },
      events: () => [
        { type: "wager", pid: "p1", pick: "over", amount: 2 },
        { type: "wager", pid: "p2", pick: "over", amount: 2 },
      ],
      expect: ["p1", "p2"],
    },
  ];

  for (const commit of COMMITS) {
    it(`names both committers in ${commit.kind}, exactly as the engine does`, async (t) => {
      const pair = roundPair(commit.kind);
      const r = await room(t, 6);
      r.cmd({ name: "open" });
      r.cmd({ name: "start" });
      r.cmd({ name: "arcade.enter" });
      r.cmd(pair.cmd);
      r.cmd({ name: "arcade.begin" });
      const round = r.host.state().arcade?.roundIndex ?? -1;
      commit.phone(r, 0, round);
      commit.phone(r, 1, round);
      r.settle();

      let engine = engineRoom(6, [
        {
          type: "startRound",
          round: pair.cmd.kind,
          config: pair.config,
        },
        { type: "beginPlay" },
      ]);
      engine = replay(
        engine,
        commit.events(engine).map((event) => ({ event, at: T0 + 1_000 })),
      );

      const real = [...(engineView(engine).hostExtras?.arcade?.answeredBy ?? [])].sort();
      const mocked = [...(r.host.state().hostExtras?.arcade?.answeredBy ?? [])].sort();
      // The engine is the claim; the literal is only there so that an engine
      // that silently stopped publishing does not make this test vacuous.
      assert.deepEqual(real, [...commit.expect], "the engine's own list moved");
      assert.deepEqual(mocked, real);
    });
  }

  /**
   * Tug of Raft and Plan / Apply are a heartbeat and a tap, not a decision
   * anybody is waiting on, so both sides publish an empty list *even once
   * people are tapping*. The taps are the whole assertion: a round with no
   * activity in it would read empty however the arm was written, so adding
   * three missing arms instead of two would pass a test that did not tap.
   *
   * A round apiece, because the fake clock is one per test.
   */
  const QUIET: readonly { kind: string; tap: (r: Room, round: number) => void; events: readonly Event[] }[] = [
    {
      kind: "tug_of_raft",
      tap: (r, round) => {
        r.phones[0]?.send({ t: "arcade.beat", cid: "b0", round });
        r.phones[1]?.send({ t: "arcade.beat", cid: "b1", round });
      },
      events: [
        { type: "tapBeat", pid: "p1", at: T0 + 600 },
        { type: "tapBeat", pid: "p2", at: T0 + 600 },
      ],
    },
    {
      kind: "plan_apply",
      tap: (r, round) => {
        r.phones[0]?.send({ t: "arcade.tap", cid: "t0", round });
        r.phones[1]?.send({ t: "arcade.tap", cid: "t1", round });
      },
      events: [
        { type: "tap", pid: "p1", at: T0 + 600 },
        { type: "tap", pid: "p2", at: T0 + 600 },
      ],
    },
  ];

  for (const quiet of QUIET) {
    it(`names nobody in ${quiet.kind}, which has nothing to commit to`, async (t) => {
      const pair = roundPair(quiet.kind);
      const r = await room(t, 6);
      r.cmd({ name: "open" });
      r.cmd({ name: "start" });
      r.cmd({ name: "arcade.enter" });
      r.cmd(pair.cmd);
      r.cmd({ name: "arcade.begin" });
      quiet.tap(r, r.host.state().arcade?.roundIndex ?? -1);
      r.settle();

      let engine = engineRoom(6, [
        { type: "startRound", round: pair.cmd.kind, config: pair.config },
        { type: "beginPlay" },
      ]);
      engine = replay(
        engine,
        quiet.events.map((event) => ({ event, at: T0 + 600 })),
      );
      assert.deepEqual(
        engineView(engine).hostExtras?.arcade?.answeredBy,
        [],
        quiet.kind,
      );
      assert.deepEqual(
        r.host.state().hostExtras?.arcade?.answeredBy,
        [],
        quiet.kind,
      );
    });
  }
});

/* ------------------------------------------------------------------ */
/* #12 — the loop's own pacing                                         */
/* ------------------------------------------------------------------ */

describe("the scripted loop holds a beat for as long as the beat takes to play", () => {
  /**
   * The Desktop's final reveal is a climb it plays on its own clock: one dwell
   * per row below first, then a hold on an empty first place, and only then
   * the winner. The loop used to give that two seconds, so nobody watching
   * `?mock=1` had ever seen it — on the segment DESIGN.md spends the most
   * words on, in the loop that exists so every screen change can be watched.
   *
   * The whole seven-minute script is walked on the fake clock, which takes a
   * few tens of milliseconds, and the segment changes are read off the
   * Desktop's own frames rather than off the source — the claim is about what
   * the Desktop is sent, and reading the schedule back out of `#at` calls
   * would be a test of arithmetic this file already trusts.
   */
  interface Mark {
    readonly segment: string;
    readonly atMs: number;
  }

  async function walkTheLoop(
    t: TestContext,
    seconds: number,
  ): Promise<{ marks: Mark[]; finalRows: number }> {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const started = Date.now();
    const mod = await freshMock();
    const factory = mod.mockTransport({ ...MANUAL, director: true });

    const marks: Mark[] = [];
    let last = "";
    let finalRows = -1;
    const screen = factory({
      onOpen() {},
      onMessage(msg) {
        if (msg.t !== "state") return;
        if (msg.state.segment !== last) {
          last = msg.state.segment;
          marks.push({ segment: last, atMs: Date.now() - started });
        }
        // What the Desktop will pace its climb off, captured on the first
        // frame of the segment that plays it.
        if (msg.state.segment === "final" && finalRows < 0) {
          finalRows = msg.state.standings.length;
        }
      },
      onClose() {},
    });
    t.mock.timers.tick(11);
    screen.send({ t: "hello", role: "screen", screenToken: "mock-screen" });
    // A second at a time. One enormous tick would be the same arithmetic, and
    // a great deal harder to reason about if a timer ever re-arms itself.
    for (let i = 0; i < seconds; i += 1) t.mock.timers.tick(1_000);
    return { marks, finalRows };
  }

  const firstAt = (marks: readonly Mark[], segment: string): number => {
    const found = marks.find((m) => m.segment === segment);
    assert.ok(found !== undefined, `the loop never reached ${segment}`);
    return found.atMs;
  };

  it("leaves the final reveal on screen for the whole of the climb", async (t) => {
    const { marks, finalRows } = await walkTheLoop(t, 400);
    // Five: `#publicRows` caps what may go to the Desktop at a hard five, so
    // the climb is four dwells and the hold. If this ever changes the assertion
    // below follows it, which is the entire point of deriving the hold.
    assert.equal(finalRows, 5, "the Desktop was sent a different board");
    const need = finalRevealMs(
      Array.from({ length: finalRows }, (_, i) => ({
        rank: i + 1,
        nickname: "",
        total: 0,
        perActivity: {},
        bench: [],
        spot: 0,
      })),
    );
    assert.ok(need > 0, "finalRevealMs has stopped pacing anything");

    const held = firstAt(marks, "sendoff") - firstAt(marks, "final");
    assert.ok(
      held >= need,
      `final is held for ${held} ms and the Desktop spends ${need} ms playing it`,
    );
  });

  it("still reaches the send-off, walks it, and restarts", async (t) => {
    // The hold pushed everything after it later, so this is the check that it
    // pushed them rather than ran over them: the send-off is entered, and the
    // loop comes back round to a fresh lobby.
    const { marks } = await walkTheLoop(t, 480);
    const segments = marks.map((m) => m.segment);
    assert.deepEqual(segments.slice(0, 8), [
      "lobby",
      "holding",
      "standings",
      "trivia",
      "arcade",
      "standings",
      "final",
      "sendoff",
    ]);
    assert.equal(segments[8], "lobby", "the loop did not restart");
    // And the restart comes after the send-off has been walked, not on top of
    // it: seven five-second steps and the hold on the last card.
    const sendoff = firstAt(marks, "sendoff");
    const restart = marks[8]?.atMs ?? 0;
    assert.ok(
      restart - sendoff >= 20_000 + 6 * 5_000,
      `the loop restarted ${restart - sendoff} ms into a send-off it had not finished`,
    );
  });
});
