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
 * - **#24** the projection sweep, one scenario per divergence: the strike on
 *   the arcade grid, a released participant leaving five projections, the
 *   trivia podium, the send-off's countdown, a tiebreaker's index and round
 *   card, and a latecomer's arcade number.
 *
 * Two of #24's eight are not here, and both for the same reason — the mock
 * cannot be driven into the state they are about. Its question set is a
 * private constant with no command that loads or unloads one, so neither the
 * server's "no trivia loaded" frame nor a `Round` column left blank in a CSV
 * is reachable through this socket. The first is listed as a deliberate
 * difference in `mock.ts`; the second is a one-line guard added there to
 * match `roundAt`, and it is unverified by anything until the mock grows a
 * loader.
 *
 * ## Writing another one
 *
 * Two rules, both learned the hard way.
 *
 * **Assert against the engine, not against a literal.** Every claim below
 * compares a field to `renderStateFor`'s answer for the same sequence. A test
 * that pinned the mock's current behaviour would have passed happily on every
 * one of the divergences it was written for, and the day the engine changes
 * its mind the failure here should be a conversation rather than a literal
 * quietly edited to match.
 *
 * **Make the scenario do the thing.** One of the first mutations came back
 * green because the test compared an empty list to an empty list without
 * anybody having acted, and empty matches empty however the code is written.
 * So each claim also asserts something about the engine's own output that
 * would not hold in an idle room — "the engine's own podium has three rows",
 * "the engine drained exactly p1 and p2" — before comparing the two sides.
 * If that line is hard to write, the scenario probably is not exercising the
 * field it names.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { newSession, replay } from "../../engine/reducer.ts";
import type {
  Activity,
  ArcadeRoundConfig,
  Event,
  Question,
  SendoffContent,
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
  /**
   * One more phone, joining now rather than at construction.
   *
   * The latecomer is a case with its own rules on both sides — the reducer
   * re-runs `assignPlayerNumbers` at every `startRound` so that somebody who
   * arrived mid-round leaves the next round card with a number — and there
   * was no way to produce one here. Returns the new wire and appends it to
   * `phones`, so `phones[6]` is `p7`.
   */
  join(nickname: string): Wire;
}

/**
 * How long a room may be driven before the mock starts adding people to it.
 *
 * `?mock=manual` has no director but still joins six bots, the first at one
 * second and the rest every 400 ms after, so that a console opened on it has
 * something to show. Every scenario here has to finish inside that, because a
 * seventh participant nobody asked for is a seventh row the engine side does
 * not have. Each `cmd` and each `send` costs two milliseconds of fake clock
 * and a `join` costs thirteen, so the budget is generous — but a test that
 * wants to watch a timer fire cannot have one, and must end the round by hand
 * instead.
 */
const BOTS_ARRIVE_AT_MS = 1_000;

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

  const started = Date.now();
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
  const guardTheClock = (): void => {
    assert.ok(
      Date.now() - started < BOTS_ARRIVE_AT_MS,
      "the scenario ran past the point where the mock joins its own bots, so " +
        "the two rooms no longer hold the same people",
    );
  };
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
      guardTheClock();
    },
    settle() {
      tick(2);
      guardTheClock();
    },
    join(nickname) {
      const wire = open({
        t: "hello",
        role: "participant",
        joinCode,
        nickname,
      });
      phones.push(wire);
      guardTheClock();
      return wire;
    },
  };
}

/* ------------------------------------------------------------------ */
/* The engine, driven through the same sequence                        */
/* ------------------------------------------------------------------ */

const T0 = 1_700_000_000_000;

const ACTIVITIES: readonly Activity[] = [
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

/**
 * The same room on the real engine: the same people, in the same order, so the
 * arcade numbers and therefore the Glass Bridge's waves come out the same.
 */
function engineRoom(
  phoneCount: number,
  extra: readonly Event[] = [],
  /**
   * Events between `start` and `enterArcade`. The arcade numbers are dealt at
   * `enterArcade`, so anything that has to happen before the room is numbered
   * — a release, say — has to go here rather than in `extra`.
   */
  beforeTheArcade: readonly Event[] = [],
): SessionState {
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
    ...beforeTheArcade,
    { type: "enterArcade", activityId: "arcade" },
    ...extra,
  ];
  return replay(
    base,
    events.map((event) => ({ event, at: T0 })),
  );
}

/**
 * The console's frame, at `now`.
 *
 * `lastSeen` is filled with the same instant for everybody, which is the
 * difference between "nobody has been heard from since 1970" and a room whose
 * phones are all in hand. An empty map put every engine roster entry on
 * `conn: "away"` and left `hostExtras.awayCount` at the size of the room,
 * which is a comparison nothing could pass — the mock's phones are connected
 * sockets and say so. Away-ness has its own rules and its own tests; it is
 * not what anything below is about.
 */
function engineView(state: SessionState, now: number = T0): RenderState {
  const lastSeen = new Map(Object.keys(state.participants).map((pid) => [pid, now]));
  return renderStateFor(state, { role: "host", lastSeen, now });
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

/* ------------------------------------------------------------------ */
/* #24.1 — the strike on the grid                                      */
/* ------------------------------------------------------------------ */

describe("a pink strike is the standing and nothing else", () => {
  /**
   * `arcadeGrid` in views.ts sets `struck: standing === "drained"` flat, and
   * carries ten lines about why the `phase === "running" || "reveal"` gate
   * came off: `endRound` leaves the phase `idle`, so the strike went out at
   * the end of the round and came back on at the reveal a few seconds later.
   * On the big screen that is a grid of pink strikes blinking while the host
   * is talking. The mock still had the gate, so `?mock=1` reproduced the bug
   * on the surface the bug was about — and the big screen is the surface
   * `?mock=1` exists to let anybody look at.
   *
   * Two phones fall off the first step of the Glass Bridge, which is a drain
   * the round settles by itself: step 0's real pane is index 1, so choosing 0
   * breaks it for both. Then the round is ended and revealed with nothing
   * else happening, and the grid is compared on each of the three phases the
   * gate used to disagree about.
   */
  it("keeps a drained cell struck through idle and reveal, as the engine does", async (t) => {
    const pair = roundPair("glass_bridge");
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    const round = r.host.state().arcade?.roundIndex ?? -1;
    // p1 and p2 are the whole of wave 1 in a room of six on both sides.
    r.phones[0]?.send({ t: "arcade.step", cid: "s1", round, step: 0, choice: 0 });
    r.phones[1]?.send({ t: "arcade.step", cid: "s2", round, step: 0, choice: 0 });
    r.settle();

    let engine = engineRoom(6, [
      { type: "startRound", round: "glass_bridge", config: pair.config },
      { type: "beginPlay" },
      { type: "stepPane", pid: "p1", step: 0, choice: 0 },
      { type: "stepPane", pid: "p2", step: 0, choice: 0 },
    ]);

    const compare = (where: string): void => {
      assert.deepEqual(
        r.screen.state().arcade?.grid,
        engineView(engine).arcade?.grid,
        `the grid diverges at: ${where}`,
      );
    };

    compare("mid-step, before the step closed");

    r.cmd({ name: "arcade.end" });
    engine = replay(engine, [{ event: { type: "endRound" }, at: T0 + 1_000 }]);
    // The claim is worth making only if somebody actually fell: an unstruck
    // grid matches an unstruck grid however `struck` is written.
    const ended = engineView(engine).arcade;
    assert.equal(ended?.phase, "idle", "the round did not end");
    assert.deepEqual(
      ended?.grid.filter((c) => c.struck).map((c) => c.pid),
      ["p1", "p2"],
      "nobody was drained, so there is no strike to disagree about",
    );
    compare("ended, phase idle — where the gate blinked the strike out");

    r.cmd({ name: "arcade.reveal" });
    engine = replay(engine, [{ event: { type: "revealRound" }, at: T0 + 2_000 }]);
    assert.equal(engineView(engine).arcade?.phase, "reveal");
    compare("revealed — where the gate blinked it back in");
  });
});

/* ------------------------------------------------------------------ */
/* #24.2 — a released participant is out of the room                   */
/* ------------------------------------------------------------------ */

describe("a released participant stops being counted", () => {
  /**
   * `release` is the host handing somebody's nickname back: the collision key
   * is cleared so the name can be claimed again, and the score stays on the
   * record so that swapping phones costs nobody anything. Until they rejoin
   * they are not in the room, and views.ts says so in five places with the
   * same two-clause filter — `!p.kicked && p.nicknameKey !== ""`.
   *
   * The mock cleared the key and then went on walking `this.participants`
   * everywhere, so a released person kept their grid cell, kept their roster
   * row, and — the part a facilitator acts on — kept inflating the
   * denominator of "N of M have answered" on both the console and the big
   * screen. The host waits for somebody who has gone home.
   *
   * What is deliberately *not* here: `standings` and `hostExtras.scores`.
   * `computeStandings` in engine/scoring.ts filters `kicked` and nothing
   * else, so a released person stays on the board on the real server too.
   * That is the record keeping their score, and the two sides already agree.
   */
  it("drops them from the roster, the grid and every count, exactly as the engine does", async (t) => {
    const pair = roundPair("recruitment");
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });

    let engine = engineRoom(6, [
      { type: "startRound", round: "recruitment", config: pair.config },
      { type: "beginPlay" },
    ]);

    const both = (): { mock: RenderState; real: RenderState } => ({
      mock: r.host.state(),
      real: engineView(engine),
    });

    // Before, so the comparison below is a change and not a coincidence.
    const before = both();
    assert.equal(before.real.roster.length, 6, "the engine did not seat six");
    assert.deepEqual(before.mock.roster, before.real.roster);

    r.cmd({ name: "participant.release", pid: "p6" });
    engine = replay(engine, [
      { event: { type: "releaseNickname", pid: "p6" }, at: T0 + 1_000 },
    ]);

    const after = both();
    assert.equal(
      after.real.roster.length,
      5,
      "the engine still seats six, so nothing was released",
    );
    assert.deepEqual(after.mock.roster, after.real.roster, "roster");
    assert.deepEqual(
      after.mock.hostExtras?.participantCount,
      after.real.hostExtras?.participantCount,
      "hostExtras.participantCount",
    );
    assert.deepEqual(
      after.mock.hostExtras?.awayCount,
      after.real.hostExtras?.awayCount,
      "hostExtras.awayCount",
    );
    assert.deepEqual(after.mock.arcade?.grid, after.real.arcade?.grid, "arcade.grid");
    assert.deepEqual(after.mock.arcade?.onFloor, after.real.arcade?.onFloor, "onFloor");
    assert.deepEqual(
      after.mock.arcade?.inLounge,
      after.real.arcade?.inLounge,
      "inLounge",
    );
    // The denominator of the Desktop's "N of M answered", which is the one a
    // facilitator reads to decide whether to move on.
    assert.equal(after.real.arcade?.recruitment?.eligible, 5, "the engine's own count");
    assert.deepEqual(
      after.mock.arcade?.recruitment?.eligible,
      after.real.arcade?.recruitment?.eligible,
      "recruitment.eligible",
    );
    // And the record keeps them, on both sides. The scores are a statement
    // about what happened, not about who is holding a phone.
    assert.equal(
      after.real.hostExtras?.scores.some((row) => row.pid === "p6"),
      true,
      "the engine dropped a released person's score row",
    );
    assert.equal(
      after.mock.hostExtras?.scores.some((row) => row.pid === "p6"),
      true,
      "the mock dropped a released person's score row",
    );
  });

  /**
   * Plan / Apply's ticker is the one place the filter is not a `.filter()` on
   * the roster but a `continue` inside a fold over `play.resources`, and the
   * resources outlive the release. A runner who has gone home keeps their
   * number in the corner of the light with a bar beside it.
   */
  it("takes them off the Plan / Apply ticker, exactly as the engine does", async (t) => {
    const pair = roundPair("plan_apply");
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    const round = r.host.state().arcade?.roundIndex ?? -1;
    // The light starts on PLAN and stays there for the whole of this: three
    // runners bank one resource each, which is enough to be on a ticker that
    // only lists people with more than zero.
    r.phones[0]?.send({ t: "arcade.tap", cid: "t1", round });
    r.phones[1]?.send({ t: "arcade.tap", cid: "t2", round });
    r.phones[2]?.send({ t: "arcade.tap", cid: "t3", round });
    r.settle();

    let engine = engineRoom(6, [
      { type: "startRound", round: "plan_apply", config: pair.config },
      { type: "beginPlay" },
      { type: "tap", pid: "p1", at: T0 + 600 },
      { type: "tap", pid: "p2", at: T0 + 600 },
      { type: "tap", pid: "p3", at: T0 + 600 },
    ]);

    const leaders = (state: RenderState): readonly unknown[] =>
      state.arcade?.planApply?.leaders ?? [];
    // Three runners on it before the release, or the assertion after it is
    // an empty list matching an empty list.
    assert.equal(leaders(engineView(engine)).length, 3, "the engine's own ticker");
    assert.deepEqual(leaders(r.host.state()), leaders(engineView(engine)));

    r.cmd({ name: "participant.release", pid: "p2" });
    engine = replay(engine, [
      { event: { type: "releaseNickname", pid: "p2" }, at: T0 + 1_000 },
    ]);
    assert.equal(
      leaders(engineView(engine)).length,
      2,
      "the engine left them on its own ticker",
    );
    assert.deepEqual(leaders(r.host.state()), leaders(engineView(engine)));
  });
});

/* ------------------------------------------------------------------ */
/* #24.3 and #24.5 — the trivia block                                  */
/* ------------------------------------------------------------------ */

/**
 * The mock's own question set, read off the console's frame.
 *
 * The four questions live in `mock.ts` as a private constant and there is no
 * command that loads another set, so the only honest way to put the same
 * questions in front of the engine is to ask the mock what it is showing.
 * Everything the scoring and the podium depend on — the time limit, the base
 * points, which answer is right — is on the host's own frame, because the
 * host is the one who reads it out.
 *
 * `round` is the one field that cannot be recovered: the wire carries the
 * *computed* run (`{name, position, size}`) and a run of one is projected as
 * `null`, so a question alone in its round comes back nameless. Nothing below
 * compares a round card between the two sides for that reason; the sudden
 * death test makes its round claims against each implementation separately.
 */
function questionFromFrame(state: RenderState): Question {
  const view = state.trivia;
  assert.ok(view !== undefined, "the console has no question on it");
  assert.ok(view.correct !== undefined, "the console frame carries no answer key");
  return {
    text: view.text,
    answers: [...view.answers],
    timeLimitSec: view.timeLimitSec,
    correct: [...view.correct],
    note: view.note ?? null,
    round: view.round?.name ?? null,
    basePoints: view.basePoints,
  };
}

/** A room on the engine with a question set loaded and nothing asked yet. */
function engineTriviaRoom(
  phoneCount: number,
  questions: readonly Question[],
  tiebreakers: readonly Question[] = [],
  extra: readonly Event[] = [],
): SessionState {
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
    { type: "setSegment", segment: "trivia" },
    { type: "loadTrivia", activityId: "trivia", questions, tiebreakers },
    ...extra,
  ];
  return replay(
    base,
    events.map((event) => ({ event, at: T0 })),
  );
}

describe("the trivia podium is the people who have played", () => {
  /**
   * `triviaPodium` in views.ts walks `Object.entries(trivia.totals)`, and
   * `settleQuestion` in engine/trivia.ts folds over `trivia.answers` — so a
   * total exists for everybody who **answered**, a wrong tap included at
   * zero, and for nobody else. The mock walked the whole roster with `?? 0`,
   * so the podium was padded out to its five slots however few people had
   * played: here, three tapped and the mock sent five, the extra two being
   * people who never touched their phone sitting on a podium at zero. On the
   * phone and the big screen, at every reveal.
   *
   * (#24 reads the rule as "answered correctly". It is not: a wrong tap gets
   * a zero entry, deliberately, because "played and scored nothing" is a
   * different statement from the absent cell a host benches somebody off.
   * The fix is to the set, not to a narrower one.)
   */
  it("sends a row per person who played and no more, exactly as the engine does", async (t) => {
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    // The mock times an answer on its own clock — `#now() - opensAt` — and the
    // engine is handed the same figure as `ms`, because a pure reducer cannot
    // derive one. Both are differences between two readings of the same fake
    // clock, so the skew the mock adds to every instant cancels and the
    // response time each phone is credited with can be read off here rather
    // than guessed at. A literal would be pinning the harness's own tick
    // pattern, and the points would stop matching the first time it changed.
    const openedAt = Date.now();
    r.cmd({ name: "trivia.open", suddenDeath: false });
    const question = questionFromFrame(r.host.state());
    const right = question.correct[0] ?? 0;
    const wrong = right === 0 ? 1 : 0;
    // Two right, one wrong, three silent: a shape where padding and the truth
    // are three rows apart.
    const taps: readonly { pid: string; choice: number }[] = [
      { pid: "p1", choice: right },
      { pid: "p2", choice: right },
      { pid: "p3", choice: wrong },
    ];
    const answers: Event[] = [];
    taps.forEach((tap, i) => {
      const ms = Date.now() - openedAt;
      answers.push({ type: "answerQuestion", pid: tap.pid, choice: tap.choice, ms });
      r.phones[i]?.send({
        t: "trivia.answer",
        cid: `q${i}`,
        index: 0,
        choice: tap.choice,
      });
    });
    r.cmd({ name: "trivia.close" });
    r.cmd({ name: "trivia.reveal" });

    const mocked = r.screen.state().trivia?.podium;
    assert.ok(mocked !== undefined, "the mock sent no podium at the reveal");

    let engine = engineTriviaRoom(6, [question]);
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
      ...answers.map((event) => ({ event, at: T0 })),
      { event: { type: "closeQuestion" }, at: T0 + 1_000 },
      { event: { type: "revealQuestion" }, at: T0 + 1_100 },
    ]);
    const real = engineView(engine).trivia?.podium;
    // Three, not five and not six: the three who tapped, and the three who
    // did not are absent. The engine's own answer, asserted so that a padded
    // mock cannot pass by matching a padded engine.
    assert.equal(real?.length, 3, "the engine's own podium is a different shape");
    assert.ok(
      real.some((row) => row.points > 0),
      "nobody scored, so the podium is empty on both sides whatever it is made of",
    );
    assert.deepEqual(mocked, real);
  });

  /**
   * The other half of #24.2: `TriviaView.eligible` is the "27" in "24 of 27
   * answered", and views.ts builds it from the roster's filter rather than
   * from the roster, so that a phone whose socket went quiet ten seconds ago
   * is still somebody the host is waiting for. A *released* person is not.
   */
  it("counts a released person out of the eligible, exactly as the engine does", async (t) => {
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "trivia.open", suddenDeath: false });
    const question = questionFromFrame(r.host.state());

    let engine = engineTriviaRoom(6, [question], [], [
      { type: "openQuestion", suddenDeath: false },
    ]);
    assert.equal(engineView(engine).trivia?.eligible, 6, "the engine did not seat six");
    assert.equal(r.host.state().trivia?.eligible, 6);

    r.cmd({ name: "participant.release", pid: "p6" });
    engine = replay(engine, [
      { event: { type: "releaseNickname", pid: "p6" }, at: T0 + 500 },
    ]);
    assert.equal(
      engineView(engine).trivia?.eligible,
      5,
      "the engine still counts them, so nothing was released",
    );
    assert.deepEqual(
      r.host.state().trivia?.eligible,
      engineView(engine).trivia?.eligible,
    );
  });
});

describe("a tiebreaker is not question four of twenty", () => {
  /**
   * Two fields, both of them a statement that the tiebreaker is outside the
   * scored set. `views.ts` sends `index: trivia.suddenDeath ? -1 : trivia.at`
   * and `round: trivia.suddenDeath ? null : roundAt(...)`; the mock sent
   * `this.at` and `this.round(this.at)`, so a sudden death arrived on the
   * phones and the big screen wearing the *next unasked* question's number
   * and, if the run it interrupted had a name, that run's round card and its
   * "3 of 5".
   *
   * Sudden death really is reachable in the mock — `trivia.open` takes the
   * flag, and the scripted loop uses it — which is what makes this a live bug
   * rather than the `TODO(tiebreak)` about the mock having no tiebreaker pool.
   * That TODO is why the *question* cannot be compared between the two sides
   * here: the engine shows a tiebreaker held outside the set and the mock
   * shows `questions[at]`. `index` and `round` are precisely the two fields
   * that say "not part of the set", and they do not depend on which question
   * is on screen.
   */
  it("carries no index and no round card under a sudden death, on either side", async (t) => {
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });

    // The whole set, walked and captured: the round card is a property of a
    // *run* of consecutive questions and the engine cannot rebuild the run
    // from a prefix of it. The mock's last two share a round, so stopping one
    // short would leave the engine holding a run of one and projecting null —
    // which is what a first attempt at this test did, and it would have
    // "passed" the tiebreak assertions below on a field that was null either
    // way. The walk ends on the last question, revealed, with a round card on
    // it, so the nulls asserted afterwards are a guard doing something.
    // The console sees the question it is about to read out, so each one can
    // be captured while it is still `idle` and the walk can stop on the last
    // one *unopened*. That matters: the mock's `trivia.open` admits only
    // `idle`, where the reducer also admits `suddenDeath` out of `revealed`,
    // and that guard is the sibling issue's to fix rather than this one's. A
    // tiebreak opened from `idle` is reachable on both today.
    const asked: Question[] = [];
    const total = r.host.state().trivia?.of ?? 0;
    assert.ok(total >= 2, "the mock's set is too short to have a run in it");
    for (let i = 0; i < total; i += 1) {
      asked.push(questionFromFrame(r.host.state()));
      if (i === total - 1) break;
      r.cmd({ name: "trivia.open", suddenDeath: false });
      r.cmd({ name: "trivia.close" });
      r.cmd({ name: "trivia.reveal" });
      r.cmd({ name: "trivia.next" });
    }
    const ordinary = r.host.state().trivia;
    assert.equal(ordinary?.index, total - 1, "the mock is not on the last question");
    assert.ok(
      ordinary?.round != null,
      "the last question is not in a named run, so the nulls below prove nothing",
    );

    // The engine, on the same three questions and in the same place. Its own
    // round card is rebuilt from the names the mock's frames carried, which
    // is as much of the set as the wire can give back — see
    // `questionFromFrame`.
    const tiebreaker: Question = {
      text: "A tiebreak question, held outside the scored set.",
      answers: ["Yes", "No"],
      timeLimitSec: 20,
      correct: [0],
      note: null,
      round: null,
      basePoints: 0,
    };
    const walk: Event[] = [];
    for (let i = 0; i < total - 1; i += 1) {
      walk.push({ type: "openQuestion", suddenDeath: false });
      walk.push({ type: "closeQuestion" });
      walk.push({ type: "revealQuestion" });
      walk.push({ type: "nextQuestion" });
    }
    let engine = engineTriviaRoom(6, asked, [tiebreaker], walk);
    const realOrdinary = engineView(engine).trivia;
    assert.equal(realOrdinary?.index, ordinary?.index, "index, before the tiebreak");
    assert.deepEqual(realOrdinary?.round, ordinary?.round, "round, before the tiebreak");

    // And now the tiebreak, opened out of the revealed question on both
    // sides. `trivia.open` in the mock takes the flag; the reducer's
    // `openQuestion` takes it too and allows it out of `revealed`.
    r.cmd({ name: "trivia.open", suddenDeath: true });
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: true }, at: T0 + 1_000 },
    ]);
    const realTie = engineView(engine).trivia;
    const mockTie = r.host.state().trivia;
    assert.equal(realTie?.suddenDeath, true, "the engine is not in a sudden death");
    assert.equal(mockTie?.suddenDeath, true, "the mock is not in a sudden death");
    assert.equal(realTie?.index, -1, "the engine's own answer");
    assert.equal(realTie?.round, null, "the engine's own answer");
    assert.equal(mockTie?.index, realTie?.index, "index, under the tiebreak");
    assert.deepEqual(mockTie?.round, realTie?.round, "round, under the tiebreak");
  });
});

/* ------------------------------------------------------------------ */
/* #24.4 — the send-off's own countdown                                */
/* ------------------------------------------------------------------ */

describe("the send-off's advanceAt is anchored to the slide, not to the frame", () => {
  /**
   * `SendoffView.advanceAt` is an absolute instant: protocol.ts has it there
   * so a surface can draw "advances in 4s" and have the number mean the same
   * thing on a phone, on the console and on the big screen, whatever each of
   * them thinks the time is. views.ts derives it from `so.slideAt`, which the
   * reducer stamps when the slide goes up and nulls when it comes down.
   *
   * The mock had no `slideAt` at all and computed `Date.now() + slideMs(...)`
   * inside the projection — so every broadcast reset the countdown to full.
   * Under Auto, a surface drawing it never counted down on the mock, and any
   * unrelated frame at all — a join, a bot answering, a Spot Award — pushed
   * the deadline back out. That is exactly the property the field exists to
   * provide, absent from the only place anybody watches the send-off.
   *
   * **Why this compares behaviour rather than two numbers.** The two sides
   * are holding different send-offs: the mock's content is a private constant
   * with four messages of its own, the engine is handed whatever the test
   * loads, and `slideMs` scales a message by its length — so the two
   * `advanceAt` values are instants on two different clocks for two different
   * slides and are not the same number even when both are right. What *is*
   * the same on both is what the field does: it does not move when nothing
   * about the send-off moved, and it does move when the slide does. Three
   * observations, taken the same way on each side, compared as one record.
   */
  interface CountdownBehaviour {
    readonly nullAtTheTitleCard: boolean;
    readonly setByTheStepThatStartedTheRun: boolean;
    readonly heldAcrossAnUnrelatedFrame: boolean;
    readonly movedBySteppingTheSlide: boolean;
    readonly restampedByTurningAutoBackOn: boolean;
  }

  it("holds its deadline across an unrelated frame, on both implementations", async (t) => {
    const r = await room(t, 2);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "segment", kind: "sendoff" });

    const advance = (): number | null => r.host.state().sendoff?.advanceAt ?? null;
    // Auto goes on at the title card, so the only thing that can have stamped
    // an anchor by the time the run starts is the step itself. Turning it on
    // mid-run instead would let a `setSendoffAuto` restamp cover for a step
    // that never stamped at all — which is exactly what an earlier version of
    // this test did, and the mutation that deletes the stamp in `stepSendoff`
    // came back green.
    r.cmd({ name: "sendoff.auto", auto: true });
    const atTitle = advance();
    r.cmd({ name: "sendoff.next" });
    const running = advance();
    // Time passes, and something that has nothing to do with the send-off
    // happens: the host edits the holding card. On the mock that is a fresh
    // broadcast built from scratch, which is where the old code recomputed
    // the deadline from the clock.
    r.settle();
    r.cmd({ name: "holding", title: "Back shortly", line: "Coffee." });
    const afterAnUnrelatedFrame = advance();
    r.cmd({ name: "sendoff.next" });
    const afterAStep = advance();
    // And Auto off and on again mid-run, which the reducer restamps for a
    // stated reason: the slide on screen gets its full time rather than
    // advancing the instant the host presses because it has been up a while.
    r.settle();
    r.cmd({ name: "sendoff.auto", auto: false });
    r.settle();
    r.cmd({ name: "sendoff.auto", auto: true });
    const afterAutoAgain = advance();

    const mocked: CountdownBehaviour = {
      nullAtTheTitleCard: atTitle === null,
      setByTheStepThatStartedTheRun: running !== null,
      heldAcrossAnUnrelatedFrame: afterAnUnrelatedFrame === running,
      movedBySteppingTheSlide: afterAStep !== running,
      restampedByTurningAutoBackOn:
        afterAutoAgain !== null && afterAStep !== null && afterAutoAgain > afterAStep,
    };
    // Non-vacuous on the mock's own terms: a deadline that is null throughout
    // is "held" and "null at the title card" for free.
    assert.equal(mocked.setByTheStepThatStartedTheRun, true, "the mock never set one");

    // The engine, driven through the same four moments. Its content is
    // written here rather than read off the mock's frames because a
    // `SendoffView` carries one slide at a time and `buildPlan` needs the
    // whole file; the *shape* is what matters — a photograph and a message,
    // so that stepping moves between two slides with different lengths.
    const content: SendoffContent = {
      name: "A Leaving Colleague",
      subtitle: null,
      opening: { photos: ["one.jpg", "two.jpg"], seconds: 40, music: null },
      kudos: [
        { from: "A Colleague", message: "Thank you for all of it." },
        { from: "Another Colleague", message: "The desk will not be the same." },
      ],
      closing: { photos: [], line: "Don't be a stranger." },
    };
    let engine = engineRoom(2, [
      { type: "loadSendoff", content, seed: 1 },
      { type: "setSegment", segment: "sendoff" },
    ]);
    const engineAdvance = (now: number): number | null =>
      engineView(engine, now).sendoff?.advanceAt ?? null;
    engine = replay(engine, [
      { event: { type: "setSendoffAuto", auto: true }, at: T0 + 10 },
    ]);
    const realAtTitle = engineAdvance(T0 + 10);
    engine = replay(engine, [{ event: { type: "sendoffNext" }, at: T0 + 20 }]);
    const realRunning = engineAdvance(T0 + 30);
    // The unrelated frame is a later render with a state change that is not
    // the send-off's — which is precisely what a broadcast is.
    engine = replay(engine, [
      {
        event: { type: "setHolding", holding: { title: "Back shortly", line: "Coffee." } },
        at: T0 + 5_000,
      },
    ]);
    const realAfterAnUnrelatedFrame = engineAdvance(T0 + 5_000);
    engine = replay(engine, [{ event: { type: "sendoffNext" }, at: T0 + 6_000 }]);
    const realAfterAStep = engineAdvance(T0 + 6_000);
    engine = replay(engine, [
      { event: { type: "setSendoffAuto", auto: false }, at: T0 + 7_000 },
      { event: { type: "setSendoffAuto", auto: true }, at: T0 + 8_000 },
    ]);
    const realAfterAutoAgain = engineAdvance(T0 + 8_000);

    const real: CountdownBehaviour = {
      nullAtTheTitleCard: realAtTitle === null,
      setByTheStepThatStartedTheRun: realRunning !== null,
      heldAcrossAnUnrelatedFrame: realAfterAnUnrelatedFrame === realRunning,
      movedBySteppingTheSlide: realAfterAStep !== realRunning,
      restampedByTurningAutoBackOn:
        realAfterAutoAgain !== null &&
        realAfterAStep !== null &&
        realAfterAutoAgain > realAfterAStep,
    };
    assert.deepEqual(
      real,
      {
        nullAtTheTitleCard: true,
        setByTheStepThatStartedTheRun: true,
        heldAcrossAnUnrelatedFrame: true,
        movedBySteppingTheSlide: true,
        restampedByTurningAutoBackOn: true,
      },
      "the engine's own behaviour, which is the claim being compared against",
    );
    assert.deepEqual(mocked, real);
  });
});

/* ------------------------------------------------------------------ */
/* #24.6 — the latecomer's number                                      */
/* ------------------------------------------------------------------ */

describe("somebody who joined after the round started still has a number", () => {
  /**
   * `startRound` in the reducer re-runs `assignPlayerNumbers` every time, and
   * assignment is append-only, so a number already read off a phone never
   * moves and somebody who arrived since is given the next one. The mock
   * assigned only at `arcade.enter`, so a latecomer had no entry at all —
   * and `arcadeNumber()` answered `0` for them, where views.ts falls back to
   * the join-order number.
   *
   * `000` is not a cosmetic wrong number. It sorts to the front of the grid,
   * ahead of player one; it is printed on that person's own phone; and
   * `mockWaveOf(0, cuts)` hit `0 <= cuts[0]` and returned **wave 1**, so the
   * Glass Bridge told somebody who joined ten seconds ago that they were in
   * the wave that walks blind. The engine's `waveOf` is handed `undefined`
   * and answers wave 3, which it documents as the honest answer for somebody
   * who was not there when the cuts were taken.
   *
   * Both halves are here: the grid while they are numberless mid-round, and
   * the grid once the next round card has handed them one.
   *
   * **Somebody is released before the arcade opens**, and that is what makes
   * the second half of this a claim at all. An arcade number is gapless and a
   * join-order number is not — views.ts says so where it spells the fallback
   * out — so in an untouched room of six the latecomer's join order and the
   * number the next round card would give them are both seven, and a mock
   * that never re-assigned would look right. Releasing one person first opens
   * the gap: the room is numbered 1…5, the latecomer joins seventh, and the
   * round card must hand them **6**. A first version of this test did not do
   * that, and the mutation that deletes the re-assignment came back green.
   */
  it("draws them by join order until a round card numbers them, as the engine does", async (t) => {
    const first = roundPair("glass_bridge");
    const second = roundPair("recruitment");
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "participant.release", pid: "p3" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(first.cmd);
    r.cmd({ name: "arcade.begin" });

    let engine = engineRoom(
      6,
      [
        { type: "startRound", round: "glass_bridge", config: first.config },
        { type: "beginPlay" },
      ],
      [{ type: "releaseNickname", pid: "p3" }],
    );

    // A seventh phone, mid-round. Neither side hands out a number here: the
    // reducer's `enterArcade` is the host's documented way to do that and
    // nobody pressed it.
    const late = r.join("Player 7");
    engine = replay(engine, [
      { event: { type: "join", pid: "p7", nickname: "Player 7" }, at: T0 + 1_000 },
    ]);

    const grid = (state: RenderState): readonly unknown[] => state.arcade?.grid ?? [];
    assert.equal(grid(engineView(engine)).length, 6, "the engine seated the wrong room");
    assert.deepEqual(
      grid(r.host.state()),
      grid(engineView(engine)),
      "the grid, while the latecomer is unnumbered",
    );
    // Spelled out so that one grid matching another cannot pass by accident:
    // the latecomer is drawn last, on their join-order number, rather than
    // first on `000`.
    const cells = engineView(engine).arcade?.grid ?? [];
    assert.deepEqual(
      cells.map((c) => ({ pid: c.pid, playerNumber: c.playerNumber })),
      [
        { pid: "p1", playerNumber: 1 },
        { pid: "p2", playerNumber: 2 },
        { pid: "p4", playerNumber: 3 },
        { pid: "p5", playerNumber: 4 },
        { pid: "p6", playerNumber: 5 },
        { pid: "p7", playerNumber: 7 },
      ],
      "the engine's own grid before the latecomer has an arcade number",
    );

    // And their own phone: the wave the Bridge has put them in.
    const mineWave = late.state().arcadeMine?.glass?.wave;
    const realMine = renderStateFor(engine, {
      role: "participant",
      pid: "p7",
      lastSeen: new Map([["p7", T0]]),
      now: T0,
    }).arcadeMine?.glass?.wave;
    assert.equal(realMine, 3, "the engine's own answer for a latecomer");
    assert.equal(mineWave, realMine, "the wave on the latecomer's own phone");

    // Now the next round card, which is where the reducer hands out numbers.
    r.cmd({ name: "arcade.end" });
    r.cmd({ name: "arcade.reveal" });
    r.cmd(second.cmd);
    engine = replay(
      engine,
      (
        [
          { type: "endRound" },
          { type: "revealRound" },
          { type: "startRound", round: "recruitment", config: second.config },
        ] as Event[]
      ).map((event) => ({ event, at: T0 + 2_000 })),
    );
    assert.deepEqual(
      grid(r.host.state()),
      grid(engineView(engine)),
      "the grid, after the round card that should have numbered them",
    );
    const numbered = engineView(engine).arcade?.grid ?? [];
    // Six, not seven: the round card closes the gap the release opened, which
    // is the whole difference between re-assigning and not.
    assert.deepEqual(
      numbered.map((c) => c.playerNumber),
      [1, 2, 3, 4, 5, 6],
      "the engine's own numbering after the second round card",
    );
    // The denominator moved with them, on both sides.
    assert.equal(engineView(engine).arcade?.recruitment?.eligible, 6);
    assert.equal(
      r.host.state().arcade?.recruitment?.eligible,
      engineView(engine).arcade?.recruitment?.eligible,
    );
  });
});
