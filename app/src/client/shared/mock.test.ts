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
 * instant.
 *
 * `room()` asks the hub for `bots: 0`, so the only participants in a round are
 * the ones a test put there. That is newer than it looks and it is what made
 * half of this file possible: `?mock=manual` joins six bots starting one second
 * in, the budget for a whole scenario was therefore the first second of a
 * session, and **everything gated on a clock was unreachable** — the Plan /
 * Apply light, a wave cut, an item timer, a step timer, which is most of the
 * arcade. With the room's population under the scenario's control,
 * {@link Room.advance} can hold a room still for as long as a round's own
 * timers need. See {@link noStrangers} for what replaced the deadline the old
 * harness guarded, and why that deadline had in fact never been crossed.
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
 * - **#25** the state-timing sweep, the other half of the same read: *when*
 *   the mock moves a thing the reducer also moves. The trivia points reaching
 *   the score grid at the reveal and not at the close, and reaching it only
 *   for the people who played; `practice` gating the board in both trivia and
 *   the arcade; a sudden death staying open for the host to close and
 *   breaking nobody's streak; a Lounge bet placed after the result it names
 *   paying nothing; Recruitment's 5 + 5; and a Gganbu pair dissolving the
 *   moment half of it leaves.
 * - **#27** the tail of the same sweep, and the first scenarios in this file
 *   that run a round's own clock out. The Plan / Apply half of late-bet
 *   protection, which needed the APPLY light and was the reason the harness
 *   had to grow `advance` at all; the round's totals folded over `standing ∪
 *   banked` rather than over the roster; Recruitment's Floor clock re-derived
 *   at every item; and a kick marking the person where it used to delete them.
 *   Plus the drift #27 found on the way and was wrong about — the console's
 *   `standings` are `topFive` and not the public five, which was already true
 *   and is now watched.
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
 * #27's seventeen lettered guard and refusal differences are **not** here and
 * are not fixed: they are the second half of that issue. Two of them are why a
 * scenario below reads oddly — a Plan / Apply latecomer cannot tap on the mock
 * (guard a), so the `banked` half of the totals union is exercised through a
 * Recruitment answer instead.
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
 *
 * **A scenario about a clock has to spend some.** The same rule one step along,
 * and the reason the rule above is worth writing twice. `#nextItem`'s
 * re-derived `endsAt` and `#beginPlay`'s guess are *the same number* with no
 * time between them, and four trivia answers in the same millisecond of the
 * fake clock all round to the same points, so the whole room normalises to 100
 * and no ceiling can move — the second of those was caught by exactly the
 * "assert something an idle room could not satisfy" line the rule above asks
 * for, and only by that. Both scenarios spend {@link Room.advance} between the
 * acts, not because the code under test is slow but because the difference they
 * are about does not exist until the clock has moved.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { newSession, reduce, replay } from "../../engine/reducer.ts";
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
  /**
   * Hold the room still and let its own clocks run.
   *
   * This is what a scenario about a timer is made of, and until `MockConfig`
   * grew a `bots` field there was no way to write one: `?mock=manual` starts
   * joining six bots one second in, so the budget for a whole scenario was the
   * first second of a session and **everything gated on a clock was out of
   * reach** — the Plan / Apply light, a wave cut, an item timer, a step timer.
   * That is most of the arcade, and it is why the Plan / Apply half of late-bet
   * protection sat written and unwatched while the Unseal half was tested.
   *
   * Fake milliseconds, a second at a time, for the reason the director suite
   * ticks a second at a time: one enormous tick is the same arithmetic and a
   * great deal harder to reason about when a timer re-arms itself, which every
   * one of the arcade's does.
   *
   * It does **not** make the mock's own timer durations predictable. The light
   * is a fresh `2_000 + random(4_000)` at every turn, and a scenario has no
   * business knowing which. Advance in steps and read the light off the frame:
   * {@link untilTheLightIs} does exactly that.
   */
  advance(ms: number): void;
}

/**
 * Nobody in the room but the people a scenario put there.
 *
 * This used to be a clock budget, and the clock was the problem. `?mock=manual`
 * has no director but still joins six bots, the first at one second and the rest
 * every 400 ms after, so that a console opened on it has something to show —
 * and a seventh participant nobody asked for is a seventh row the engine side
 * does not have. So every scenario had to finish inside the first second, and a
 * scenario that wanted to watch a timer fire could not exist. Plan / Apply's
 * light is two to six seconds; an item is twenty; a wave is six at its
 * shortest. The arcade is made of clocks, and none of them were reachable.
 *
 * `MockConfig.bots` is the fix, and {@link room} passes `bots: 0`: the mock
 * brings nobody, the scenario owns the roster, and {@link Room.advance} can run
 * a round's own timers out. What is left to guard is not a deadline but the
 * thing the deadline stood for, so this checks it directly — every nickname in
 * the room is one the scenario handed out.
 *
 * Better than the deadline in three ways. It survives `advance`. It survives a
 * `release` and a `kick`, both of which take somebody *out* of the roster and
 * would have tripped a size comparison. And it says what went wrong rather than
 * what time it is.
 *
 * Worth recording why the old guard never fired: `#hostCmd` sets
 * `#directorStopped`, `#at` refuses to run once it is set, and the manual room's
 * six joins go through `#at` — so any scenario that pressed a console button
 * inside the first second already got no bots, by accident. Every scenario here
 * does. The guard was watching a deadline that nothing was ever going to cross,
 * which is the least useful kind of green.
 */
function noStrangers(
  roster: readonly { nickname: string }[],
  invited: ReadonlySet<string>,
): void {
  for (const p of roster) {
    assert.ok(
      invited.has(p.nickname),
      `${p.nickname} is in the room and no scenario put them there, so the ` +
        "two rooms no longer hold the same people",
    );
  }
}

async function room(t: TestContext, phoneCount: number): Promise<Room> {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const mod = await freshMock();
  // `bots: 0` — see {@link noStrangers}. Not in MANUAL itself, because the
  // director suite spreads MANUAL and wants the whole scripted cast.
  const factory = mod.mockTransport({ ...MANUAL, bots: 0 });
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
  const invited = new Set<string>();
  const phones: Wire[] = [];
  for (let i = 0; i < phoneCount; i += 1) {
    const nickname = `Player ${i + 1}`;
    invited.add(nickname);
    phones.push(open({ t: "hello", role: "participant", joinCode, nickname }));
  }

  let cid = 0;
  const guard = (): void => noStrangers(host.state().roster, invited);
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
      guard();
    },
    settle() {
      tick(2);
      guard();
    },
    join(nickname) {
      invited.add(nickname);
      const wire = open({
        t: "hello",
        role: "participant",
        joinCode,
        nickname,
      });
      phones.push(wire);
      guard();
      return wire;
    },
    advance(ms) {
      for (let left = ms; left > 0; left -= 1_000) tick(Math.min(1_000, left));
      guard();
    },
  };
}

/**
 * Hold the room until the Plan / Apply light shows `want`.
 *
 * The light is the reason the harness needed {@link Room.advance} at all, and
 * the reason a scenario cannot simply tick a fixed number: `#lightMs` draws a
 * fresh `2_000 + random(4_000)` at every turn, deliberately, because SPEC.md's
 * light is not a metronome. So this advances in small steps and reads the light
 * off the console's own frame, which is also the surface the room reads it off.
 *
 * A hundred milliseconds at a time, so the caller knows the turn happened within
 * a tenth of a second of being found — which is what lets a scenario reason
 * about the 250 ms lock grace on either side of it.
 *
 * Fails rather than looping forever. The cap is comfortably more than two full
 * turns of the longest light, so reaching it means the light has stopped turning
 * and every claim after this point would have been made against a dead round.
 */
function untilTheLightIs(r: Room, want: "plan" | "apply"): void {
  for (let waited = 0; waited <= 20_000; waited += 100) {
    if (r.host.state().arcade?.planApply?.light === want) return;
    r.advance(100);
  }
  assert.fail(`the light never turned to ${want}`);
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
 * The big screen's frame, at `now`.
 *
 * Separate from {@link engineView} because `standings` is one of the few
 * fields where the two roles genuinely differ: views.ts gives the console
 * `topFive(all)` — "they cannot run the session blind" — and gives the screen
 * `publicStandings(all)`, which is the hard five *and* the rule that an
 * unscored room shows nothing rather than an alphabetical slice of itself. A
 * claim about the public leaderboard has to be made against the public frame,
 * and comparing a screen frame to a host frame was the first version of the
 * test below.
 */
function engineScreen(state: SessionState, now: number = T0): RenderState {
  const lastSeen = new Map(Object.keys(state.participants).map((pid) => [pid, now]));
  return renderStateFor(state, { role: "screen", lastSeen, now });
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

/* ------------------------------------------------------------------ */
/* #25.1 and #25.6 — when the points reach the score grid              */
/* ------------------------------------------------------------------ */

/**
 * The trivia slice of the console's score grid, which is what item 1 is about.
 *
 * A `ScoreRow` carries every activity at once plus a rank and a nickname, and
 * comparing the whole row would drag in six fields that have nothing to do
 * with *when* trivia lands. This is the three that do, per person, in roster
 * order — and taken the same way on both sides, so it is still the engine's
 * answer being compared and not a literal.
 */
function triviaGrid(state: RenderState): readonly {
  pid: string;
  raw: number | null;
  status: string | undefined;
  points: number | null;
}[] {
  return (state.hostExtras?.scores ?? []).map((row) => ({
    pid: row.pid,
    raw: row.raw["trivia"] ?? null,
    status: row.status["trivia"],
    points: row.points["trivia"] ?? null,
  }));
}

/**
 * The big screen's leaderboard, as far as trivia is concerned.
 *
 * `perActivity` is keyed by activity id and the two rooms are not holding the
 * same *list* of activities — the mock's session is a fixed three (a judged
 * TTX, trivia, the arcade) and `engineRoom` loads two — so a whole-row compare
 * fails on a `ttx: null` key that says nothing about anything. Rank, name,
 * total and the trivia column are the board, and they are taken the same way
 * on both sides.
 */
function publicBoard(
  state: RenderState,
): readonly { rank: number; nickname: string; total: number; trivia: number | null }[] {
  return state.standings.map((row) => ({
    rank: row.rank,
    nickname: row.nickname,
    total: row.total,
    trivia: row.perActivity["trivia"] ?? null,
  }));
}

describe("the trivia points reach the score grid at the reveal", () => {
  /**
   * `closeQuestion` in reducer.ts settles into `trivia.totals` and `streaks`
   * and stops there, and the note on it says why in as many words: writing
   * `scores` at the close leaked the answer, because the participant's own
   * points strip is projected from `scores` and a right answer made it jump
   * while the question was still unrevealed. No field said "correct" and the
   * phone turned green anyway. `revealQuestion` is where `scores` is written.
   *
   * `MockSession.settleQuestion` ended by writing `p.raw["trivia"]` and
   * `p.status["trivia"]`, and `#closeQuestion` calls it — so on the demo, in
   * the window between the host pressing Close and pressing Reveal, the
   * participant's strip moved and the public leaderboard re-sorted with the
   * answer off the screen. The exact leak the reducer's note records fixing,
   * reproduced on the only surface anybody looks at without a backend.
   *
   * The same scenario carries the sibling claim about *who* is written, since
   * it is the same two lines: the grid is filled for the people who have a
   * **total**, which is the people who answered, and not for the whole roster
   * at zero. Three of the six here never touch their phone and must stay
   * `unset` — the empty cell a host benches somebody off. `board()` averages
   * Bench Credit over the `played` entries, so "played, 0" moves a number as
   * well as a colour.
   */
  it("holds the grid still at the close and moves it at the reveal, as the engine does", async (t) => {
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    const openedAt = Date.now();
    r.cmd({ name: "trivia.open", suddenDeath: false });
    const question = questionFromFrame(r.host.state());
    const right = question.correct[0] ?? 0;
    const wrong = right === 0 ? 1 : 0;
    // Two right, one wrong, three silent — the same shape the podium test
    // uses, because it is the shape where padding, the truth and an empty
    // room are three different answers.
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

    let engine = engineTriviaRoom(6, [question]);
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
      ...answers.map((event) => ({ event, at: T0 })),
    ]);

    // Nothing yet, on either side: the question is open.
    assert.deepEqual(triviaGrid(r.host.state()), triviaGrid(engineView(engine)));

    r.cmd({ name: "trivia.close" });
    engine = replay(engine, [{ event: { type: "closeQuestion" }, at: T0 + 1_000 }]);
    const closedReal = triviaGrid(engineView(engine));
    // The engine's own claim, spelled out: the close leaves every cell empty.
    // Without this the comparison below would pass on two implementations
    // that both wrote at the close.
    assert.deepEqual(
      closedReal.map((row) => row.status),
      ["unset", "unset", "unset", "unset", "unset", "unset"],
      "the engine wrote the grid at the close, so this test is about nothing",
    );
    assert.deepEqual(
      triviaGrid(r.host.state()),
      closedReal,
      "the grid moved between Close and Reveal",
    );
    // And the public board, which is the other half of the leak: thirty
    // phones and the big screen draw it.
    assert.deepEqual(
      publicBoard(r.screen.state()),
      publicBoard(engineScreen(engine)),
      "the standings moved between Close and Reveal",
    );

    r.cmd({ name: "trivia.reveal" });
    engine = replay(engine, [{ event: { type: "revealQuestion" }, at: T0 + 1_100 }]);
    const revealedReal = triviaGrid(engineView(engine));
    // Three cells filled and three still absent: the people who answered, the
    // wrong tap included at zero, and nobody else. A grid that stayed empty at
    // the reveal would match an unwritten one just as happily.
    assert.deepEqual(
      revealedReal.map((row) => row.status),
      ["played", "played", "played", "unset", "unset", "unset"],
      "the engine's own grid at the reveal",
    );
    assert.ok(
      revealedReal.some((row) => (row.raw ?? 0) > 0),
      "nobody scored, so an unwritten grid would pass",
    );
    assert.deepEqual(triviaGrid(r.host.state()), revealedReal, "the grid at the reveal");
    assert.deepEqual(
      publicBoard(r.screen.state()),
      publicBoard(engineScreen(engine)),
      "the standings at the reveal",
    );
  });

  /**
   * `withActivityTotals` in reducer.ts opens with
   * `if (state.practice) return state.scores;` — one choke point, covering
   * trivia and the arcade, gated there rather than at its two call sites so
   * that a third activity gets the behaviour without anybody remembering to
   * ask for it.
   *
   * This file stored `practice`, had a `#hostCmd` case for it and projected
   * it, and nothing read it. So a practice round moved the board on the demo
   * and does not on the server, which is the entire content of the toggle —
   * and `mock.ts`'s own comment above `MOCK_SENDOFF` records the previous
   * round of exactly this: "the practice toggle shipped unverifiable because
   * this file had no case for its command". The case was added. The gate was
   * not.
   *
   * The round still *happens* on both sides, which is the other half of the
   * rule and the reason this is not simply "score nothing": the podium fills
   * and the phone's own strip fills. Only the score grid and the standings
   * stay where they were.
   */
  it("scores a practice question into the podium and not onto the board, as the engine does", async (t) => {
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "practice", on: true });
    const openedAt = Date.now();
    r.cmd({ name: "trivia.open", suddenDeath: false });
    const question = questionFromFrame(r.host.state());
    const right = question.correct[0] ?? 0;
    const answers: Event[] = [];
    ["p1", "p2"].forEach((pid, i) => {
      const ms = Date.now() - openedAt;
      answers.push({ type: "answerQuestion", pid, choice: right, ms });
      r.phones[i]?.send({ t: "trivia.answer", cid: `q${i}`, index: 0, choice: right });
    });
    r.cmd({ name: "trivia.close" });
    r.cmd({ name: "trivia.reveal" });

    let engine = engineTriviaRoom(6, [question], [], [{ type: "setPractice", on: true }]);
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
      ...answers.map((event) => ({ event, at: T0 })),
      { event: { type: "closeQuestion" }, at: T0 + 1_000 },
      { event: { type: "revealQuestion" }, at: T0 + 1_100 },
    ]);

    const real = engineView(engine);
    assert.equal(real.practice, true, "the engine is not in practice");
    assert.equal(r.host.state().practice, true, "the mock is not in practice");
    // The round happened: two people are on the engine's own podium with
    // points. Without this the comparison below is two empty boards, and two
    // empty boards match however the gate is written.
    const podium = real.trivia?.podium ?? [];
    assert.equal(podium.length, 2, "the engine's own podium");
    assert.ok(
      podium.some((row) => row.points > 0),
      "nobody scored even into the practice totals",
    );
    assert.deepEqual(r.screen.state().trivia?.podium, podium, "the podium");

    // And the board did not move.
    assert.deepEqual(
      triviaGrid(real).map((row) => row.status),
      ["unset", "unset", "unset", "unset", "unset", "unset"],
      "the engine wrote a practice round onto its own grid",
    );
    assert.deepEqual(triviaGrid(r.host.state()), triviaGrid(real), "the score grid");
    assert.deepEqual(
      publicBoard(r.screen.state()),
      publicBoard(engineScreen(engine)),
      "the standings",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #25.3 and #25.9 — what a sudden death does and does not do          */
/* ------------------------------------------------------------------ */

describe("a sudden death is closed by the host, like every other question", () => {
  /**
   * `answerQuestion` in reducer.ts sets `suddenDeathWinner` and leaves the
   * phase `open`. Nothing in runtime.ts or views.ts closes it either, and
   * that is the design: the big screen shows the winner **while the question
   * is still open**, the room gets to look at it, the rest of the room can
   * still tap, and the host presses Close when they are ready.
   *
   * `#recordAnswer` called `#closeQuestion()` inline. So on the demo the first
   * correct tap flipped the phase to `closed`, nulled both clocks, locked
   * everybody else out mid-thought, and turned the host's own Close into a
   * refusal — "No question is open" — on the one question a host most wants to
   * control the pacing of.
   *
   * Four observations taken the same way on both sides and compared as one
   * record. The two cannot be compared question-for-question here, because
   * the mock has no tiebreaker pool and shows the next unasked question
   * instead — a listed deliberate difference — but none of these four is
   * about which question is on screen.
   */
  interface SuddenDeathBeat {
    readonly phaseAfterTheWinningTap: string | undefined;
    readonly winnerIsNamed: boolean;
    readonly aSecondPersonCanStillAnswer: boolean;
    readonly phaseAfterTheHostCloses: string | undefined;
  }

  it("stays open until the host closes it, on both implementations", async (t) => {
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    const openedAt = Date.now();
    // Out of `idle`, because the mock's `trivia.open` admits only `idle` where
    // the reducer also admits `suddenDeath` out of `revealed`. That guard is
    // its own item and not this one's; a tiebreak opened from idle is
    // reachable on both today.
    r.cmd({ name: "trivia.open", suddenDeath: true });
    const question = questionFromFrame(r.host.state());
    const right = question.correct[0] ?? 0;
    const ms = Date.now() - openedAt;
    r.phones[0]?.send({ t: "trivia.answer", cid: "sd1", index: 0, choice: right });
    const afterTheTap = r.screen.state().trivia;
    r.phones[1]?.send({ t: "trivia.answer", cid: "sd2", index: 0, choice: right });
    const secondRefused = r.phones[1]?.frames
      .filter((f) => f.t === "refusedCmd")
      .at(-1);
    r.cmd({ name: "trivia.close" });
    const mocked: SuddenDeathBeat = {
      phaseAfterTheWinningTap: afterTheTap?.phase,
      winnerIsNamed: afterTheTap?.suddenDeathWinner != null,
      aSecondPersonCanStillAnswer:
        secondRefused === undefined || secondRefused.cid !== "sd2",
      phaseAfterTheHostCloses: r.screen.state().trivia?.phase,
    };

    let engine = engineTriviaRoom(6, [question], [question]);
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: true }, at: T0 },
      { event: { type: "answerQuestion", pid: "p1", choice: right, ms }, at: T0 + 10 },
    ]);
    const realAfterTheTap = engineView(engine).trivia;
    // `reduce` rather than `replay`, because the claim is about whether the
    // second tap was *accepted* and `replay` throws the answer away.
    const secondTap = reduce(
      engine,
      { type: "answerQuestion", pid: "p2", choice: right, ms },
      T0 + 20,
    );
    engine = replay(secondTap.state, [
      { event: { type: "closeQuestion" }, at: T0 + 30 },
    ]);
    const real: SuddenDeathBeat = {
      phaseAfterTheWinningTap: realAfterTheTap?.phase,
      winnerIsNamed: realAfterTheTap?.suddenDeathWinner != null,
      aSecondPersonCanStillAnswer: secondTap.applied,
      phaseAfterTheHostCloses: engineView(engine).trivia?.phase,
    };

    // The engine's own answer, written out, so that two implementations which
    // both slammed the question shut could not pass by agreeing.
    assert.deepEqual(
      real,
      {
        phaseAfterTheWinningTap: "open",
        winnerIsNamed: true,
        aSecondPersonCanStillAnswer: true,
        phaseAfterTheHostCloses: "closed",
      },
      "the engine's own behaviour, which is the claim being compared against",
    );
    assert.deepEqual(mocked, real);
  });

  /**
   * `settleQuestion` in engine/trivia.ts early-returns on `trivia.suddenDeath`
   * with `answers`, `totals` **and `streaks`** handed straight back. SPEC.md's
   * "no points change", read strictly: a tiebreak is a decision, not a
   * question, so it neither pays nor breaks a run.
   *
   * The mock skipped the *scoring* for a sudden death and then went on running
   * the fold, so a non-answerer and a wrong tap both had `triviaStreaks[pid]`
   * set to 0 on the way past. Visible immediately as `triviaMine.streak` on
   * the phone, and again on the next scored question as a streak bonus that
   * should have been paid and was not.
   */
  it("breaks nobody's streak, as the engine does", async (t) => {
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    const openedAt = Date.now();
    r.cmd({ name: "trivia.open", suddenDeath: false });
    const question = questionFromFrame(r.host.state());
    const right = question.correct[0] ?? 0;
    const ms = Date.now() - openedAt;
    // p1 builds a streak of one on a scored question and then sits out the
    // tiebreak, which is the ordinary case: a tiebreak is between two other
    // people and the rest of the room watches.
    r.phones[0]?.send({ t: "trivia.answer", cid: "a1", index: 0, choice: right });
    r.cmd({ name: "trivia.close" });
    r.cmd({ name: "trivia.reveal" });
    r.cmd({ name: "trivia.next" });
    const sdOpenedAt = Date.now();
    r.cmd({ name: "trivia.open", suddenDeath: true });
    const tie = questionFromFrame(r.host.state());
    const tieRight = tie.correct[0] ?? 0;
    const tieMs = Date.now() - sdOpenedAt;
    r.phones[1]?.send({ t: "trivia.answer", cid: "sd", index: 1, choice: tieRight });
    r.cmd({ name: "trivia.close" });
    // Revealed, because `TriviaMine` only carries a streak in that state:
    // before the reveal a phone is told `locked` and nothing else, which is
    // the whole of the secrecy rule. Revealing a tiebreak is what a host does
    // with one anyway.
    r.cmd({ name: "trivia.reveal" });
    const streakOf = (wire: Wire | undefined): number | undefined => {
      const mine = wire?.state().triviaMine;
      return mine?.state === "revealed" ? mine.streak : undefined;
    };
    const mocked = { p1: streakOf(r.phones[0]), p2: streakOf(r.phones[1]) };

    let engine = engineTriviaRoom(6, [question, question], [tie]);
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
      { event: { type: "answerQuestion", pid: "p1", choice: right, ms }, at: T0 + 10 },
      { event: { type: "closeQuestion" }, at: T0 + 20 },
      { event: { type: "revealQuestion" }, at: T0 + 30 },
      { event: { type: "nextQuestion" }, at: T0 + 40 },
      { event: { type: "openQuestion", suddenDeath: true }, at: T0 + 50 },
      {
        event: { type: "answerQuestion", pid: "p2", choice: tieRight, ms: tieMs },
        at: T0 + 60,
      },
      { event: { type: "closeQuestion" }, at: T0 + 70 },
      { event: { type: "revealQuestion" }, at: T0 + 80 },
    ]);
    const engineStreak = (pid: string): number | undefined => {
      const mine = renderStateFor(engine, {
        role: "participant",
        pid,
        lastSeen: new Map([[pid, T0 + 80]]),
        now: T0 + 80,
      }).triviaMine;
      return mine?.state === "revealed" ? mine.streak : undefined;
    };
    const real = { p1: engineStreak("p1"), p2: engineStreak("p2") };

    // The engine's own answer: p1 keeps the run they earned on the scored
    // question, and p2's correct tiebreak tap does not start one either —
    // both of which are "a sudden death settles nothing". A room where nobody
    // had a streak to lose would read `{p1: 0, p2: 0}` on any implementation
    // at all, which is why the scored question comes first.
    assert.deepEqual(real, { p1: 1, p2: 0 }, "the engine's own streaks");
    assert.deepEqual(mocked, real);
  });
});

/* ------------------------------------------------------------------ */
/* #25.7 — what Recruitment banks                                      */
/* ------------------------------------------------------------------ */

describe("Recruitment banks what the engine banks", () => {
  /**
   * `RECRUITMENT_CORRECT` in engine/arcade.ts was **retuned from 10 to 5**,
   * and carries the arithmetic: at 10 the round banks 7 × 15 = 105 against
   * Plan / Apply's 40 and the Bridge's 63, which is more than the other two
   * together and settles the leaderboard before the arcade is half over. At 5
   * it is 7 × (5 + 5) = 70. The first-three bonus deliberately did not move.
   *
   * `#recordItemAnswer` here still banked `10 + 5`. The engine is the one that
   * moved and this file is the one that did not, so the demo's Floor max was
   * 105 against the server's 70 — on the console's `banked` and `totals`, on
   * the phone's own strip, and on the board once the round was revealed.
   *
   * Four correct answers on one item, because three is where the bonus stops:
   * the fourth person is what separates "5 and 5" from a flat 10, and this
   * file has now had both numbers wrong in different directions.
   */
  it("pays 5 and 5, and the bonus to the first three only, as the engine does", async (t) => {
    const pair = roundPair("recruitment");
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    const item = RECRUITMENT_ITEMS[0];
    assert.ok(item !== undefined, "there are no recruitment items");
    for (let i = 0; i < 4; i += 1) {
      r.phones[i]?.send({
        t: "arcade.answer",
        cid: `a${i}`,
        item: 0,
        answer: item.answer,
      });
    }
    r.settle();

    let engine = engineRoom(6, [
      { type: "startRound", round: "recruitment", config: pair.config },
      { type: "beginPlay" },
    ]);
    engine = replay(
      engine,
      (["p1", "p2", "p3", "p4"] as const).map((pid, i) => ({
        event: { type: "submitAnswer", pid, answer: item.answer } as Event,
        at: T0 + 100 + i,
      })),
    );

    const banked = (state: RenderState): Readonly<Record<string, number>> =>
      state.hostExtras?.arcade?.banked ?? {};
    // The engine's own arithmetic, printed rather than implied: three at ten
    // and a fourth at five. A round where everybody scored the same would
    // pass against a mock that kept the bonus and dropped the retune, or the
    // other way round.
    assert.deepEqual(
      banked(engineView(engine)),
      { p1: 10, p2: 10, p3: 10, p4: 5 },
      "the engine's own banked",
    );
    assert.deepEqual(banked(r.host.state()), banked(engineView(engine)), "banked");
    // The fourth person's own phone, which is where a wrong number is read by
    // somebody who can argue about it.
    const mine = r.phones[3]?.state().arcadeMine?.banked;
    const realMine = renderStateFor(engine, {
      role: "participant",
      pid: "p4",
      lastSeen: new Map([["p4", T0 + 200]]),
      now: T0 + 200,
    }).arcadeMine?.banked;
    assert.equal(realMine, 5, "the engine's own answer on the fourth phone");
    assert.equal(mine, realMine, "the fourth phone's own strip");

    // And the round's totals once it has settled, which is what reaches the
    // score grid at the reveal.
    r.cmd({ name: "arcade.end" });
    engine = replay(engine, [{ event: { type: "endRound" }, at: T0 + 300 }]);
    assert.deepEqual(
      r.host.state().hostExtras?.arcade?.totals,
      engineView(engine).hostExtras?.arcade?.totals,
      "totals",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #27.2 — whose points the round's totals fold over                   */
/* ------------------------------------------------------------------ */

describe("a round's totals are folded over the people who were in it", () => {
  /**
   * `settleRound` in engine/arcade.ts folds `standing ∪ banked` and spells out
   * both halves: the standings fixed at the round's card, plus anybody who
   * banked without being in them — a latecomer, "somebody who joined after the
   * round started, was put on the Floor by playing, and scored", whose points
   * would otherwise be quietly dropped.
   *
   * `#endRound` here folded `s.participants`, which is neither half. It looks
   * equivalent and is not, because `resetFloor()` is what makes it look
   * equivalent and `resetFloor()` runs at the round's card: anybody the roster
   * gained or lost *inside* the round makes the two disagree.
   *
   * The consequence is not arithmetic, it is a cell. A raw of `0` on the
   * console's arcade totals means "played and scored nothing", and an absent
   * entry means "did not play" — which is the cell a host needs in order to
   * bench somebody. So the old fold wrote "played, 0" against a person who
   * arrived after the round and against a person who had left the room, and
   * "played, 0" also changes Bench Credit, which `board()` averages over the
   * entries that say `played`.
   *
   * Both halves in one room, because each catches a different wrong fold:
   *
   * - **p5 is released before the round card**, so `rosterOrder` leaves them out
   *   of the engine's standings and `inTheRoom()` leaves them out of the mock's.
   *   A fold over `s.participants` gives them a zero the engine does not write.
   *   This one also watches `resetFloor()`, which walked `participants` too —
   *   with the fold fixed and the reset not, the zero comes back by another door.
   * - **p7 joins mid-round and does nothing**, which is the same zero from the
   *   other end of the round.
   * - **p8 joins mid-round and answers**, which is the `banked` half of the
   *   union: they are in neither side's standings and must be in both sides'
   *   totals. Without them a fold over `standing` alone would pass.
   *
   * Recruitment rather than Plan / Apply for p8's sake: `tap` is where the two
   * implementations still disagree about a latecomer with no standing — the
   * reducer admits them and this file refuses them, which is a guard difference
   * of its own and not this one — while a Recruitment answer is accepted by both.
   */
  it("gives a round's zero to the people who were in it and nobody else, as the engine does", async (t) => {
    const pair = roundPair("recruitment");
    const item = RECRUITMENT_ITEMS[0];
    assert.ok(item !== undefined, "there are no recruitment items");

    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    // Out of the room before the card goes up, and therefore out of the round.
    r.cmd({ name: "participant.release", pid: "p5" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });

    // The two latecomers. `join` puts them at the end of `phones`, so
    // `phones[6]` is p7 and `phones[7]` is p8.
    r.join("Player 7");
    const late = r.join("Player 8");
    r.phones[0]?.send({ t: "arcade.answer", cid: "a1", item: 0, answer: item.answer });
    late.send({ t: "arcade.answer", cid: "a8", item: 0, answer: item.answer });
    r.cmd({ name: "arcade.end" });

    let engine = engineRoom(6, [
      { type: "releaseNickname", pid: "p5" },
      { type: "startRound", round: "recruitment", config: pair.config },
      { type: "beginPlay" },
      { type: "join", pid: "p7", nickname: "Player 7" },
      { type: "join", pid: "p8", nickname: "Player 8" },
      { type: "submitAnswer", pid: "p1", answer: item.answer },
      { type: "submitAnswer", pid: "p8", answer: item.answer },
      { type: "endRound" },
    ]);

    const totals = (state: RenderState): Readonly<Record<string, number>> =>
      state.hostExtras?.arcade?.totals ?? {};
    const real = totals(engineView(engine));
    // The engine's own answer, printed, and made to be worth comparing: the
    // room is not all zeroes, not all present, and not all absent. Two people
    // scored, four were in the round and did not, and two of the eight rows the
    // roster has ever held are not in the fold at all.
    assert.deepEqual(
      real,
      { p1: 10, p2: 0, p3: 0, p4: 0, p6: 0, p8: 10 },
      "the engine's own totals",
    );
    assert.deepEqual(totals(r.host.state()), real, "the round's totals");
    // Said again as the thing a host would notice, so a failure reads as the
    // bug rather than as a diff: the released person and the silent latecomer
    // have no cell, and the scoring latecomer has one.
    for (const pid of ["p5", "p7"]) {
      assert.ok(!(pid in totals(r.host.state())), `${pid} has a round they were not in`);
    }
    assert.ok("p8" in totals(r.host.state()), "the latecomer's points were dropped");
  });
});

/* ------------------------------------------------------------------ */
/* #27.3 — Recruitment's round clock, re-derived per item              */
/* ------------------------------------------------------------------ */

describe("Recruitment's round ends when its last item does", () => {
  /**
   * `nextItem` in reducer.ts recomputes `endsAt` from the item that is actually
   * open — `itemEndsAt + (items.length − 1 − at) × secondsPerItem × 1000` — and
   * its comment says why: `beginPlay` can only guess at `begin + items × 20 s`,
   * every item opens a little after its predecessor's deadline because the timer
   * that opens it has event-loop lag, so the guess drifts earlier than the truth
   * by the accumulated lag. The runtime re-arms its Floor timer off the new
   * value.
   *
   * `#nextItem` here bumped `at`, restamped `itemEndsAt`, re-armed the item
   * timer, and left `arcadeEndsAt` at `#beginPlay`'s guess. Recruitment is one
   * of the three rounds whose Floor timer *is* armed — glass, tug and gganbu are
   * excluded, for the same lag reason — so there were two competing deadlines,
   * and the earlier one wins: the last item lost the tail of its twenty seconds.
   * The stale `endsAt` also went on the wire, so the round countdown on the big
   * screen disagreed with the item countdown beside it.
   *
   * The claim is made on the projection and as a *difference* of two fields on
   * the same frame, because the two implementations do not share a clock and an
   * absolute instant from one means nothing to the other. `endsAt − itemEndsAt`
   * is the arithmetic itself: how much round is left after the open item, which
   * is zero once the last item is open and six items' worth on the first.
   *
   * A second of held clock before every press, which is what this scenario could
   * not do before `MockConfig.bots`. Without it the two fields agree by accident
   * — with no time between `#beginPlay` and the first press, the stale guess and
   * the honest arithmetic are the same number — and the mutation comes back
   * green. The lag *is* the test.
   */
  it("re-derives the Floor's clock at every item, as the engine does", async (t) => {
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

    /** How much round is left after the open item closes, off one frame. */
    const tail = (state: RenderState): number => {
      const arcade = state.arcade;
      const itemEndsAt = arcade?.recruitment?.itemEndsAt;
      assert.ok(arcade !== undefined, "no arcade on the frame");
      assert.ok(itemEndsAt !== undefined, "the open item has no clock");
      assert.ok(arcade.endsAt !== null, "the Floor has no clock");
      return arcade.endsAt - itemEndsAt;
    };

    const items = pair.config.kind === "recruitment" ? pair.config.items.length : 0;
    assert.ok(items > 2, "a one-item round cannot show this at all");
    const seen: { at: number; mock: number; real: number }[] = [];
    for (let at = 1; at < items; at += 1) {
      // The lag, which is the whole point: a real host presses this when the
      // item's own timer goes, a little after it, and the guess `#beginPlay`
      // made drifts earlier than the truth by exactly this much.
      r.advance(1_000);
      r.cmd({ name: "arcade.next" });
      engine = replay(engine, [
        { event: { type: "nextItem" }, at: T0 + at * 1_000 },
      ]);
      seen.push({ at, mock: tail(r.host.state()), real: tail(engineView(engine)) });
    }

    // The engine's own arithmetic, printed: six items' worth of round left
    // behind the second item, and none at all behind the last. A round whose
    // every tail were the same number would pass against anything.
    const secondsPerItem =
      pair.config.kind === "recruitment" ? pair.config.secondsPerItem : 0;
    assert.deepEqual(
      seen.map((s) => s.real),
      Array.from({ length: items - 1 }, (_, i) => (items - 2 - i) * secondsPerItem * 1_000),
      "the engine's own tails",
    );
    for (const { at, mock, real } of seen) {
      assert.equal(mock, real, `the Floor's clock diverges at item ${at + 1}`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* #25.4 — a bet placed after the result it names                      */
/* ------------------------------------------------------------------ */

describe("a bet placed after the result it names pays nothing", () => {
  /**
   * `betStands` in engine/arcade.ts, written a second time here as
   * `mockBetStands` — and it was not written here at all before.
   *
   * A round's Floor is a public surface: the big screen draws who has crossed
   * and whose tin is open, because that is the round's theatre. A bet may be
   * changed until the Floor locks. Put the two together and the Lounge stops
   * being a bet — watch the screen until somebody is through, then name them,
   * and collect the top award for a certainty. The engine stamps
   * `LoungeSeat.placedAt` at `backPlayer` and refuses such a bet at
   * settlement; `MockLounge` had no `placedAt`, `MockPlanPlay` had no
   * `finishedAt`, and `#endRound` paid purely on membership of `finishOrder`
   * and `unsealOrder`. In the demo a drained bot could back a guaranteed
   * winner, and it showed in the console, the standings and the export.
   *
   * Unseal rather than Plan / Apply, for one reason: a Plan / Apply drain
   * needs the APPLY light, and the light is on a two-to-six second timer that
   * does not fit inside the window this file has before the mock starts
   * joining its own bots. An Unseal drain is two wrong letters and no clock at
   * all. It is the same guard — `betStands` covers exactly these two rounds,
   * and the reasoning is identical — and Plan / Apply's half is left to
   * whoever grows the harness a way to run a timer out.
   *
   * The scenario is the whole claim: **two** drained backers on the same
   * runner, one who bets before the tin comes open and one who bets after.
   * One backer alone would pass against an implementation with no guard at
   * all, and two who both bet early would pass against one that refused
   * everything.
   */
  it("pays the backer who bet early and not the one who waited, as the engine does", async (t) => {
    const pair = roundPair("unseal");
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    const round = r.host.state().arcade?.roundIndex ?? -1;

    let engine = engineRoom(6, [
      { type: "startRound", round: "unseal", config: pair.config },
      { type: "beginPlay" },
    ]);
    // `beginPlay` above is stamped at T0, so the engine's `startedAt` is T0
    // and every `unsealedMs` below is an offset from it. The instants are
    // chosen rather than borrowed from the mock's clock for that reason: the
    // rule is an ordering, and an ordering written out is one that can be read.
    const shapes = r.host.state().arcade?.unseal?.shapes ?? [];
    const shape = shapes.find((s) => s.available)?.shape;
    assert.ok(shape !== undefined, "the round dealt no tins at all");

    const pick = (i: number, pid: string, at: number): void => {
      r.phones[i]?.send({ t: "arcade.shape", cid: `pick-${pid}`, round, shape });
      engine = replay(engine, [{ event: { type: "pickShape", pid, shape }, at }]);
    };
    /** The word behind a cue, which the cue is an anagram of. */
    const wordFor = (cue: string): string[] => {
      const item = UNSEAL_ITEMS.find((i) => i.cue === cue);
      assert.ok(item !== undefined, `no unseal item has the cue ${cue}`);
      return [...item.answer.toUpperCase()].filter((c) => /\p{L}/u.test(c));
    };
    const cueOn = (wire: Wire | undefined): string => {
      const cue = wire?.state().arcadeMine?.unseal?.cue;
      assert.ok(typeof cue === "string" && cue !== "", "that phone holds no tin");
      return cue;
    };
    const engineCue = (pid: string, now: number): string | null | undefined =>
      renderStateFor(engine, {
        role: "participant",
        pid,
        lastSeen: new Map([[pid, now]]),
        now,
      }).arcadeMine?.unseal?.cue;

    // The runner, and the two who are about to fall.
    pick(0, "p1", T0 + 10);
    pick(2, "p3", T0 + 10);
    pick(3, "p4", T0 + 10);
    // The two sides deal tins by player number out of the same item list, so
    // the same person is holding the same word. Asserted rather than assumed:
    // if the dealing ever diverges, the numbers below stop meaning anything
    // and this should say so rather than fail somewhere downstream.
    for (const [i, pid] of [[0, "p1"], [2, "p3"], [3, "p4"]] as const) {
      assert.equal(engineCue(pid, T0 + 10), cueOn(r.phones[i]), `${pid}'s tin`);
    }

    // p3 and p4 shatter their own tins: two wrong letters each. The letter has
    // to be one of their own tiles — a letter that is not is a malformed frame
    // and is refused rather than counted — so it is drawn from their own cue.
    const shatter = (i: number, pid: string, at: number): void => {
      const cue = cueOn(r.phones[i]);
      const word = wordFor(cue);
      const wrong = [...cue].find((c) => /\p{L}/u.test(c) && c !== word[0]);
      assert.ok(wrong !== undefined, `${pid}'s word is one letter repeated`);
      for (const n of [0, 1]) {
        r.phones[i]?.send({
          t: "arcade.letter",
          cid: `x-${pid}-${n}`,
          round,
          letter: wrong,
        });
        engine = replay(engine, [
          { event: { type: "tapLetter", pid, letter: wrong }, at: at + n },
        ]);
      }
    };
    shatter(2, "p3", T0 + 20);
    shatter(3, "p4", T0 + 20);
    const drained = (state: RenderState): readonly string[] =>
      (state.arcade?.grid ?? []).filter((c) => c.struck).map((c) => c.pid);
    assert.deepEqual(
      drained(engineView(engine)),
      ["p3", "p4"],
      "the engine drained somebody else, so the Lounge below is not what it looks like",
    );
    assert.deepEqual(drained(r.host.state()), drained(engineView(engine)), "the drains");

    // The honest bet: placed while p1's tin is still shut.
    r.phones[2]?.send({ t: "arcade.back", cid: "back-p3", pid: "p1" });
    engine = replay(engine, [
      { event: { type: "backPlayer", pid: "p3", backing: "p1" }, at: T0 + 30 },
    ]);

    // p1 unseals, which is on the big screen the instant it happens.
    const word = wordFor(cueOn(r.phones[0]));
    word.forEach((letter, n) => {
      r.phones[0]?.send({ t: "arcade.letter", cid: `p1-${n}`, round, letter });
      engine = replay(engine, [
        { event: { type: "tapLetter", pid: "p1", letter }, at: T0 + 40 },
      ]);
    });
    assert.equal(
      r.phones[0]?.state().arcadeMine?.unseal?.unsealed,
      true,
      "p1 did not get their tin open, so there is no result to bet after",
    );

    // And the bet that is not a bet: named after the result it names.
    r.phones[3]?.send({ t: "arcade.back", cid: "back-p4", pid: "p1" });
    engine = replay(engine, [
      { event: { type: "backPlayer", pid: "p4", backing: "p1" }, at: T0 + 50 },
    ]);

    r.cmd({ name: "arcade.end" });
    engine = replay(engine, [{ event: { type: "endRound" }, at: T0 + 60 }]);

    const totals = (state: RenderState): Readonly<Record<string, number>> =>
      state.hostExtras?.arcade?.totals ?? {};
    const real = totals(engineView(engine));
    // The engine's own arithmetic, printed. p3 is paid the 8 for backing the
    // fastest in a shape; p4 backed the same person for the same 8 and is
    // paid nothing, which is the entire difference the guard makes. Both
    // banked nothing on the Floor — their first letter was wrong, so a
    // shattered tin is worth zero — so these two numbers are the Lounge and
    // nothing else.
    assert.equal(real["p3"], 8, "the engine did not pay the honest bet");
    assert.equal(real["p4"], 0, "the engine paid the late bet");
    assert.deepEqual(totals(r.host.state()), real, "the round's totals");
  });

  /**
   * The other half, and the half the harness existed to make reachable.
   *
   * `mockBetStands`' `plan_apply` arm and the `finishedAt` stamp in `#recordTap`
   * that feeds it were written at the same time as the Unseal arm above and had
   * nothing watching them, for one reason: a Plan / Apply drain needs the APPLY
   * light, the light runs on its own two-to-six second timer, and every
   * scenario in this file had to finish inside the first second of a session
   * before the mock joined its own bots. So the code was written, read, and
   * never run — which is the state every divergence this file exists for was
   * found in. `MockConfig.bots` and {@link Room.advance} are what changed.
   *
   * A smaller target than the tuned 120, because the crossing is four taps here
   * rather than a hundred and twenty and the light does not wait: the same
   * config goes to both sides, `checkpointsFor` and `mockCheckpoints` both give
   * quarter marks, and four is the smallest target whose three checkpoints are
   * three distinct numbers. The round is the guard, not the arithmetic.
   *
   * The scenario is the same shape as the Unseal one above and for the same
   * reason: **two** drained backers on the same runner, one betting before the
   * crossing and one after. One alone would pass against an implementation with
   * no guard at all, and two early ones would pass against one that refused
   * everything.
   */
  it("pays the early backer and not the one who waited for the crossing, as the engine does", async (t) => {
    // Target four: see the note above. Ninety seconds, so the Floor's own timer
    // is nowhere near — the only clock this scenario runs out is the light's.
    const cmd = {
      name: "arcade.round",
      kind: "plan_apply",
      target: 4,
      seconds: 90,
    } as const;
    const config: ArcadeRoundConfig = { kind: "plan_apply", target: 4, seconds: 90 };

    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(cmd);
    r.cmd({ name: "arcade.begin" });
    const round = r.host.state().arcade?.roundIndex ?? -1;

    let engine = engineRoom(6, [
      { type: "startRound", round: "plan_apply", config },
      { type: "beginPlay" },
    ]);
    // The engine has no clock: the light is a `setLight` event carrying the
    // instant, and a tap carries its own corrected instant. So the engine side
    // is written as the ordering it is a claim about, and the mock side is
    // driven by holding the room until its own light turns. The two clocks are
    // never compared — only the two settlements are.
    const plan = (at: number, until: number): void => {
      engine = replay(engine, [
        { event: { type: "setLight", light: "plan", until }, at },
      ]);
    };
    const apply = (at: number, until: number): void => {
      engine = replay(engine, [
        { event: { type: "setLight", light: "apply", until }, at },
      ]);
    };
    const tap = (pid: string, at: number): void => {
      engine = replay(engine, [{ event: { type: "tap", pid, at }, at }]);
    };

    // The light turns pink. Three hundred milliseconds past the turn before
    // anybody taps, because `#tapInstant` pulls a tap inside 250 ms of the lock
    // back to the last instant of the PLAN before it — SPEC.md's grace for
    // network latency — and a tap inside it is forgiven rather than drained.
    // `untilTheLightIs` finds the turn within 100 ms of it happening, so this
    // is the first instant at which a drain is the thing being tested.
    untilTheLightIs(r, "apply");
    r.advance(300);
    apply(T0 + 10_000, T0 + 16_000);

    // p3 and p4 tap into the lock and are drained. Not p1, who is the runner.
    r.phones[2]?.send({ t: "arcade.tap", cid: "lock-p3", round });
    r.phones[3]?.send({ t: "arcade.tap", cid: "lock-p4", round });
    tap("p3", T0 + 11_000);
    tap("p4", T0 + 11_001);

    const drained = (state: RenderState): readonly string[] =>
      (state.arcade?.grid ?? []).filter((c) => c.struck).map((c) => c.pid);
    assert.deepEqual(
      drained(engineView(engine)),
      ["p3", "p4"],
      "the engine drained somebody else, so the Lounge below is not what it looks like",
    );
    assert.deepEqual(
      drained(r.host.state()),
      drained(engineView(engine)),
      "the two rooms drained different people, so the Lounges differ before the bets do",
    );

    // Green again, which is when a runner may move and a backer may bet.
    untilTheLightIs(r, "plan");
    plan(T0 + 16_000, T0 + 30_000);

    // The honest bet: placed while p1 is still short of the line.
    r.phones[2]?.send({ t: "arcade.back", cid: "back-p3", pid: "p1" });
    engine = replay(engine, [
      { event: { type: "backPlayer", pid: "p3", backing: "p1" }, at: T0 + 17_000 },
    ]);
    assert.equal(
      engineView(engine).arcade?.planApply?.crossed,
      0,
      "somebody was already across when the honest bet was placed",
    );

    // p1 crosses, which is on the big screen the instant it happens: the finish
    // order is on the Plan / Apply view for every role.
    for (let i = 0; i < 4; i += 1) {
      r.phones[0]?.send({ t: "arcade.tap", cid: `run-${i}`, round });
      tap("p1", T0 + 18_000 + i);
    }
    assert.equal(
      engineView(engine).arcade?.planApply?.crossed,
      1,
      "p1 did not cross, so there is no result to bet after",
    );
    assert.equal(
      r.host.state().arcade?.planApply?.crossed,
      1,
      "p1 crossed on the engine and not on the mock, so the two Floors differ",
    );

    // And the bet that is not a bet, named after the crossing it names.
    r.phones[3]?.send({ t: "arcade.back", cid: "back-p4", pid: "p1" });
    engine = replay(engine, [
      { event: { type: "backPlayer", pid: "p4", backing: "p1" }, at: T0 + 19_000 },
    ]);

    r.cmd({ name: "arcade.end" });
    engine = replay(engine, [{ event: { type: "endRound" }, at: T0 + 20_000 }]);

    const totals = (state: RenderState): Readonly<Record<string, number>> =>
      state.hostExtras?.arcade?.totals ?? {};
    const real = totals(engineView(engine));
    // The engine's own arithmetic, printed, so a change of tuning is a
    // conversation here rather than a literal quietly edited. p1 banks three
    // checkpoints at 5 and the first crossing at 10 + 15. p3 is paid 15 for
    // backing the winner; p4 backed the same winner for the same 15 and is paid
    // nothing, and that difference is the whole of the guard. Neither of them
    // banked anything on the Floor — their one tap was into the lock — so the
    // two numbers are the Lounge and nothing else.
    assert.equal(real["p1"], 3 * 5 + 10 + 15, "the engine did not pay the crossing");
    assert.equal(real["p3"], 15, "the engine did not pay the honest bet");
    assert.equal(real["p4"], 0, "the engine paid the late bet");
    assert.deepEqual(totals(r.host.state()), real, "the round's totals");
  });
});

/* ------------------------------------------------------------------ */
/* #25.5 — a Gganbu rival who leaves mid-round                         */
/* ------------------------------------------------------------------ */

describe("a Gganbu pair dissolves when half of it leaves", () => {
  /**
   * `houseThePairOf` in reducer.ts runs at `disconnect`, at `kick` and at
   * `releaseNickname` — at the instant the rival goes — and houses **both**
   * halves, because the +10 is awarded per player against whoever is in front
   * of them and a one-sided substitution makes the pair's two comparisons
   * disagree. SPEC.md: "a rival who disconnects is replaced by the house."
   *
   * The mock wrote `housed` only inside `#startRound`, which is the one moment
   * at which nobody has left yet. `participant.release` set `conn = "away"`
   * and the director dropped a bot, and neither touched it. `housed` is
   * projected and `gganbuMine` draws the survivor's rival card off it, so on
   * the demo the card went on naming somebody who had gone home, all the way
   * to a settlement that compared against them.
   *
   * **Why this compares behaviour rather than two lists.** The pairs are drawn
   * from a seed, and the mock draws its own at `#startRound` where the engine
   * is handed one in the round config — so p1's rival is a different person on
   * the two sides and always will be. What is the same is the rule: before,
   * nobody is housed and p1 has a rival; after, that pair and only that pair
   * is housed, and the survivor's own phone says they are playing the house.
   * Four observations, taken the same way on each side.
   */
  interface HousingBehaviour {
    readonly housedBeforeAnybodyLeft: number;
    readonly theSurvivorHadARival: boolean;
    readonly housedAfterTheRelease: number;
    readonly theSurvivorNowPlaysTheHouse: boolean;
  }

  it("houses both halves the moment one of them is released, on both implementations", async (t) => {
    const pair = roundPair("gganbu");
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });

    const mockRivalOf = (i: number): string | null | undefined =>
      r.phones[i]?.state().arcadeMine?.gganbu?.rival;
    const mockHoused = (): number => (r.host.state().arcade?.gganbu?.housed ?? []).length;
    const rival = mockRivalOf(0);
    assert.ok(
      typeof rival === "string",
      "p1 has no rival in a room of six, so there is no pair to dissolve",
    );
    // The phones are opened in pid order, so `p4` is `phones[3]`. Stated here
    // rather than searched for, because `room()` documents the mapping and
    // every other scenario in this file already relies on it.
    const survivor = Number(rival.slice(1)) - 1;
    const housedBefore = mockHoused();
    r.cmd({ name: "participant.release", pid: "p1" });
    const mocked: HousingBehaviour = {
      housedBeforeAnybodyLeft: housedBefore,
      theSurvivorHadARival: true,
      housedAfterTheRelease: mockHoused(),
      theSurvivorNowPlaysTheHouse: mockRivalOf(survivor) === null,
    };

    let engine = engineRoom(6, [
      { type: "startRound", round: "gganbu", config: pair.config },
      { type: "beginPlay" },
    ]);
    const engineMine = (pid: string, now: number): string | null | undefined =>
      renderStateFor(engine, {
        role: "participant",
        pid,
        lastSeen: new Map([[pid, now]]),
        now,
      }).arcadeMine?.gganbu?.rival;
    const engineHoused = (): number =>
      (engineView(engine).arcade?.gganbu?.housed ?? []).length;
    const realRival = engineMine("p1", T0);
    assert.ok(typeof realRival === "string", "the engine left p1 unpaired");
    const realHousedBefore = engineHoused();
    engine = replay(engine, [
      { event: { type: "releaseNickname", pid: "p1" }, at: T0 + 1_000 },
    ]);
    const real: HousingBehaviour = {
      housedBeforeAnybodyLeft: realHousedBefore,
      theSurvivorHadARival: true,
      housedAfterTheRelease: engineHoused(),
      theSurvivorNowPlaysTheHouse: engineMine(realRival, T0 + 1_000) === null,
    };

    // The engine's own behaviour, written out. Two is the claim: **both**
    // halves, not only the one left behind. A round where nobody was paired
    // would read zero and zero on any implementation at all, which is what
    // the two assertions above are for.
    assert.deepEqual(
      real,
      {
        housedBeforeAnybodyLeft: 0,
        theSurvivorHadARival: true,
        housedAfterTheRelease: 2,
        theSurvivorNowPlaysTheHouse: true,
      },
      "the engine's own behaviour, which is the claim being compared against",
    );
    assert.deepEqual(mocked, real);
  });
});

/* ------------------------------------------------------------------ */
/* #25.2, the other half — practice and the arcade                     */
/* ------------------------------------------------------------------ */

describe("a practice arcade round moves no board either", () => {
  /**
   * `withActivityTotals` is one choke point for a reason its own comment
   * gives: "a third activity added later gets the behaviour without anyone
   * remembering to ask for it". The mock has no such choke point — the trivia
   * write and the arcade write are two loops in two files' worth of distance
   * from each other — so the gate has to be stated twice, and a test that
   * only covered trivia would be a test that let the arcade half rot.
   *
   * Recruitment, because it is the round that needs no clock: four correct
   * answers, end, reveal. The round still produces its totals on both sides —
   * `hostExtras.arcade.totals` is what the console draws and what a host uses
   * to decide the round worked — and the score grid does not move.
   */
  it("banks the round and leaves the score grid alone, as the engine does", async (t) => {
    const pair = roundPair("recruitment");
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    r.cmd({ name: "practice", on: true });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    const item = RECRUITMENT_ITEMS[0];
    assert.ok(item !== undefined, "there are no recruitment items");
    for (let i = 0; i < 4; i += 1) {
      r.phones[i]?.send({
        t: "arcade.answer",
        cid: `a${i}`,
        item: 0,
        answer: item.answer,
      });
    }
    r.cmd({ name: "arcade.end" });
    r.cmd({ name: "arcade.reveal" });

    let engine = engineRoom(
      6,
      [
        { type: "startRound", round: "recruitment", config: pair.config },
        { type: "beginPlay" },
        ...(["p1", "p2", "p3", "p4"] as const).map(
          (pid): Event => ({ type: "submitAnswer", pid, answer: item.answer }),
        ),
        { type: "endRound" },
        { type: "revealRound" },
      ],
      [{ type: "setPractice", on: true }],
    );

    const real = engineView(engine);
    assert.equal(real.practice, true, "the engine is not in practice");
    // The round happened on both sides, which is what makes the empty grid
    // below a gate rather than a round that never ran.
    // Two zeroes on the end: `settleRound` in engine/arcade.ts folds over
    // `standing ∪ banked`, so everybody who was on the Floor gets a total
    // whether or not they answered.
    assert.deepEqual(
      real.hostExtras?.arcade?.totals,
      { p1: 10, p2: 10, p3: 10, p4: 5, p5: 0, p6: 0 },
      "the engine's own totals",
    );
    assert.deepEqual(
      r.host.state().hostExtras?.arcade?.totals,
      real.hostExtras?.arcade?.totals,
      "the round's totals",
    );
    const arcadeGridSlice = (
      state: RenderState,
    ): readonly { pid: string; status: string | undefined }[] =>
      (state.hostExtras?.scores ?? []).map((row) => ({
        pid: row.pid,
        status: row.status["arcade"],
      }));
    assert.deepEqual(
      arcadeGridSlice(real).map((row) => row.status),
      ["unset", "unset", "unset", "unset", "unset", "unset"],
      "the engine wrote a practice round onto its own grid",
    );
    assert.deepEqual(arcadeGridSlice(r.host.state()), arcadeGridSlice(real), "the grid");
    assert.deepEqual(
      publicBoard(r.screen.state()),
      publicBoard(engineScreen(engine)),
      "the standings",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #27.4 — a kick marks the person, it does not delete them            */
/* ------------------------------------------------------------------ */

describe("a kicked person keeps their row and loses their place", () => {
  /**
   * `kick` in reducer.ts sets `kicked: true, connected: false` and leaves the
   * rest of the row alone. `#hostCmd`'s `participant.kick` **spliced them out of
   * the array**, and that was a bookkeeping difference right up until the
   * projections started filtering: `rosterOrder` in engine/arcade.ts and
   * `computeStandings` in engine/scoring.ts read `kicked`, so on the server a
   * kick leaves a marked row to filter and here it left a hole.
   *
   * A hole and a mark agree about anything that only counts the room — the
   * roster is one shorter either way — which is why this went unnoticed. They
   * disagree the moment the *row* is the thing that answers the question, and
   * two places need it:
   *
   * 1. **The collision lookup at the door.** The reducer frees a kicked
   *    nickname for other people and refuses it to the person who was kicked,
   *    on their own rejoin token: SPEC.md's "can rejoin under a different
   *    nickname". With the row deleted there was nothing left to recognise, so
   *    a kicked phone reconnecting — which is what a kicked phone does, it
   *    still holds its token — fell through to a fresh join and was let
   *    straight back in under the same name. That is the one thing a kick is
   *    for.
   * 2. **The ceiling `#normalise` scales the room against.** `normaliseActivity`
   *    skips a kicked participant at both ends and says why: "someone removed
   *    for joining under an offensive name would otherwise scale the whole room
   *    down against a score nobody can see."
   *
   * Everything else the mark makes visible — the standings, the score grid, the
   * podium, the round's standings reset, the numbering, the rope's sides, the
   * Gganbu pairs — was right by accident while the row was deleted and has to
   * be filtered now that it is not. The second test below is the guard on that,
   * and it is the reason a fix this small is worth a scenario at all.
   */
  it("refuses their own rejoin token under the name they were kicked for, as the engine does", async (t) => {
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    let engine = engineRoom(6);

    const names = (state: RenderState): readonly string[] =>
      state.roster.map((p) => p.nickname);
    assert.deepEqual(names(engineView(engine)), [
      "Player 1",
      "Player 2",
      "Player 3",
      "Player 4",
      "Player 5",
      "Player 6",
    ]);

    r.cmd({ name: "participant.kick", pid: "p3" });
    engine = replay(engine, [{ event: { type: "kick", pid: "p3" }, at: T0 + 100 }]);
    assert.deepEqual(
      names(engineView(engine)),
      ["Player 1", "Player 2", "Player 4", "Player 5", "Player 6"],
      "the engine did not remove them from the room",
    );
    assert.deepEqual(names(r.host.state()), names(engineView(engine)), "after the kick");

    // The kicked phone comes back, which is what a phone does: it still holds
    // the token it was given. Same token, same name — the one case that is
    // refused, on both sides.
    r.phones[2]?.send({
      t: "hello",
      role: "participant",
      joinCode: r.host.state().joinCode ?? "",
      nickname: "Player 3",
      rejoinToken: "tok-p3",
    });
    engine = replay(engine, [
      { event: { type: "join", pid: "p3", nickname: "Player 3" }, at: T0 + 200 },
    ]);
    assert.deepEqual(
      names(engineView(engine)),
      ["Player 1", "Player 2", "Player 4", "Player 5", "Player 6"],
      "the engine let them back in, so there is nothing here to compare",
    );
    assert.deepEqual(
      names(r.host.state()),
      names(engineView(engine)),
      "the room after a kicked phone reconnected under the same name",
    );
    // And said as the thing itself, because a roster comparison would also pass
    // if the mock had refused *every* rejoin: the refusal names the reason.
    const refused = (r.phones[2]?.frames ?? []).filter((f) => f.t === "refused").at(-1);
    assert.equal(refused?.t === "refused" ? refused.reason : null, "kicked");

    // A different name, and they are back: the same person, un-kicked and
    // renamed, which is `join`'s `existing.kicked ? { nickname, nicknameKey }`.
    r.phones[2]?.send({
      t: "hello",
      role: "participant",
      joinCode: r.host.state().joinCode ?? "",
      nickname: "Player 9",
      rejoinToken: "tok-p3",
    });
    engine = replay(engine, [
      { event: { type: "join", pid: "p3", nickname: "Player 9" }, at: T0 + 300 },
    ]);
    assert.ok(
      names(engineView(engine)).includes("Player 9"),
      "the engine refused a rejoin under a new name, which is not the rule",
    );
    assert.deepEqual(
      names(r.host.state()),
      names(engineView(engine)),
      "the room after the same phone rejoined under a new name",
    );
  });

  /**
   * The projections, now that there is a row for them to find.
   *
   * Every one of these was right while `kick` deleted the row and would be
   * wrong the moment it stopped, so this is the scenario that makes the change
   * above safe rather than the one that proves it was needed. The claim worth
   * making loudest is the ceiling: the person kicked is the person on the top
   * score, so an unfiltered `#normalise` scales the whole room against a raw
   * nobody can see and *every other row's* trivia column drops.
   */
  it("keeps them out of the board, the grid, the podium and the ceiling, as the engine does", async (t) => {
    const r = await room(t, 6);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    const openedAt = Date.now();
    r.cmd({ name: "trivia.open", suddenDeath: false });
    const question = questionFromFrame(r.host.state());
    const right = question.correct[0] ?? 0;
    const wrong = right === 0 ? 1 : 0;

    // p1 answers first and fastest, so p1 is the ceiling. p2 and p3 answer
    // correctly a little later, p4 is wrong, p5 and p6 are silent — a room
    // where dropping the top row visibly moves every other number.
    const taps: readonly { i: number; pid: string; choice: number }[] = [
      { i: 0, pid: "p1", choice: right },
      { i: 1, pid: "p2", choice: right },
      { i: 2, pid: "p3", choice: right },
      { i: 3, pid: "p4", choice: wrong },
    ];
    const answers: Event[] = [];
    for (const tap of taps) {
      // Three seconds between taps, which is the other thing `advance` is for.
      // Without it every tap lands in the same millisecond of the fake clock,
      // SPEC.md's "an answer at the buzzer is worth half an instant one" rounds
      // all four to the same 1000, and the whole room normalises to 100 — a
      // ceiling nobody can move is a ceiling this scenario cannot be about.
      if (tap.i > 0) r.advance(3_000);
      const ms = Date.now() - openedAt;
      answers.push({ type: "answerQuestion", pid: tap.pid, choice: tap.choice, ms });
      r.phones[tap.i]?.send({
        t: "trivia.answer",
        cid: `q${tap.pid}`,
        index: 0,
        choice: tap.choice,
      });
    }
    r.cmd({ name: "trivia.close" });
    r.cmd({ name: "trivia.reveal" });

    let engine = engineTriviaRoom(6, [question]);
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
      ...answers.map((event) => ({ event, at: T0 })),
      { event: { type: "closeQuestion" }, at: T0 + 1_000 },
      { event: { type: "revealQuestion" }, at: T0 + 1_100 },
    ]);

    // The room before the kick, so the numbers below are a change and not a
    // coincidence: p1 is on 100 and somebody else is not.
    const before = triviaGrid(engineView(engine));
    assert.equal(
      before.find((row) => row.pid === "p1")?.points,
      100,
      "p1 is not the ceiling",
    );
    const p2Before = before.find((row) => row.pid === "p2")?.points ?? 0;
    assert.ok(p2Before > 0 && p2Before < 100, "p2 is level with the ceiling already");

    r.cmd({ name: "participant.kick", pid: "p1" });
    engine = replay(engine, [{ event: { type: "kick", pid: "p1" }, at: T0 + 2_000 }]);

    const real = engineView(engine);
    // The ceiling moved to p2, which is the whole of `normaliseActivity`'s note
    // about a removed score not scaling the room. Printed, because a mock that
    // kept p1 in the ceiling would leave p2 below 100 and that is the failure
    // this line names.
    assert.equal(
      triviaGrid(real).find((row) => row.pid === "p2")?.points,
      100,
      "the engine still scales the room against the person it removed",
    );
    assert.deepEqual(
      triviaGrid(r.host.state()),
      triviaGrid(real),
      "the console's score grid",
    );
    // Through `publicBoard`, for the reason the note on it gives: the two rooms
    // are not holding the same *list* of activities, so a whole-row compare
    // fails on a `ttx: null` key that says nothing about a kick.
    assert.deepEqual(
      publicBoard(r.host.state()),
      publicBoard(real),
      "the console's standings",
    );
    assert.deepEqual(
      r.host.state().hostExtras?.participantCount,
      real.hostExtras?.participantCount,
      "the console's count of the room",
    );
    // The podium: p1 scored, so the engine has a podium with p1 off it and the
    // rest of the rows still there. An empty podium would match anything.
    const realPodium = engineScreen(engine).trivia?.podium ?? [];
    assert.ok(
      realPodium.length > 0,
      "the engine's podium is empty, so this compares nothing",
    );
    assert.ok(
      !realPodium.some((row) => row.nickname === "Player 1"),
      "the engine left the kicked person on the podium",
    );
    assert.deepEqual(r.screen.state().trivia?.podium, realPodium, "the big screen's podium");
  });
});

/* ------------------------------------------------------------------ */
/* #27, found on the way — the console's own standings                 */
/* ------------------------------------------------------------------ */

describe("the console's standings are not the public five", () => {
  /**
   * views.ts gives the console `topFive(all)` and the big screen
   * `publicStandings(all)`, and the difference is two rules: the public five is
   * a hard cap where the console's expands a tie at fifth, and the public five
   * is **empty until somebody has scored** where the console's is not. The note
   * on it is one line — "the host sees everything: they cannot run the session
   * blind, and sealing is about what the *room* sees".
   *
   * #27 lists this as a drift found on the way, with the mock building the
   * host's `standings` from `#publicRows`. It does not: `render` has used
   * `#topFive(board)` for the host since the scoring surfaces were built, and
   * the two implementations agree. So this is the test that says so rather than
   * a fix — the claim was worth checking and is worth keeping checked, because
   * the two helpers sit four lines apart in this file and the wrong one would be
   * an easy thing to reach for.
   *
   * An unscored room of seven, which is the shape that separates the two rules
   * at both ends at once: seven is more than the cap, and unscored is where the
   * zero gate bites. `#publicRows` would send nothing at all here.
   */
  it("shows the host an unscored room the engine would not show the screen", async (t) => {
    const r = await room(t, 7);
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    const engine = engineRoom(7);

    const real = engineView(engine);
    // The engine's own answer first, and it is the interesting one: the console
    // is handed all seven rows of a room where nobody has a point, and the big
    // screen is handed none.
    assert.equal(real.standings.length, 7, "the engine's console standings");
    assert.equal(
      engineScreen(engine).standings.length,
      0,
      "the engine's big screen is showing an unscored board, so the two rules have merged",
    );
    assert.deepEqual(
      publicBoard(r.host.state()),
      publicBoard(real),
      "the console's standings",
    );
    assert.deepEqual(
      publicBoard(r.screen.state()),
      publicBoard(engineScreen(engine)),
      "the big screen's standings",
    );
  });
});
