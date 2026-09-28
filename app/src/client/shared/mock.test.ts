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
 * One property of that fake clock is load-bearing and easy to read past.
 * `tick(n)` advances `Date.now()` to the **end** of the tick and only then runs
 * the timers that came due inside it, so a callback never sees its own deadline
 * — it sees the tick's end. Every instant the mock stamps under
 * {@link Room.advance} is therefore late by up to a whole tick, which is up to a
 * second: `lightChangedAt`, `stepStartedAt`, `pullStartedAt` and `unsealedMs`
 * are all stamped from `#now()` inside a timer. A scenario that compares one of
 * those against an instant it worked out itself has to allow for the skew or
 * spend its clock in smaller ticks than `advance` does. The same property is
 * what makes #27's guard **(b)** reachable at all — see the note on it below.
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
 * - **#27's lettered guards**, the second half of that issue and the last
 *   section of this file. These are a different kind of claim from everything
 *   above: a guard is not on a surface, so what is compared is the `refusedCmd`
 *   a press produced — its code *and* its sentence, because the sentence goes on
 *   the glass — or the `applied` flag of the ack, which is how the console tells
 *   a toggle that did something from one that was already in that position. See
 *   {@link Answer} and {@link engineAnswer}. Some of them are also about *whether
 *   a frame went out at all*, which is what {@link stateFrames} is for. The last
 *   two are **(b)**, the Floor's own clock on a tap, a letter and a bet, which a
 *   wrong reading of the fake clock kept out of this file for a release; the note
 *   on (b) below is what that reading was and why it was wrong.
 * - **#29**, a survey run against `reducer.ts`, `views.ts` and `runtime.ts` after
 *   all of the above had closed, and from the source rather than from the issue
 *   tracker — which is the reason it found nine more. The last section of this
 *   file. Its first three are things a person watching the demo would see: the
 *   send-off's Auto never advancing a slide, which is the one row in any of these
 *   issues that needed *machinery* rather than a guard; the Spot Award toast
 *   naming somebody the server does not name, whose whole section came out with
 *   Spot Awards; and "Clear the card" putting the session title on the big screen
 *   where a real room goes blank. Then a closed
 *   session that was not frozen, a door with no phase gate and one nickname rule
 *   where the reducer has five, three commands that would still name a kicked
 *   person, a kicked phone still being counted, and the points arithmetic —
 *   `mock.ts` was the naive transcription that `questionPoints` carries a comment
 *   warning about, and was a point low on three taps in a thousand.
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
 * Two of #27's seventeen rows are **not** scenarios here, and each for its own
 * reason. They are written down rather than left to be rediscovered, because a
 * difference nobody wrote down is what the issue is about.
 *
 * - **(c)**, the Plan / Apply lock judged with `applySince`, and **(o)**,
 *   Recruitment's answer refusing a drained player, are listed as deliberate
 *   differences in `mock.ts`'s header — entries 8 and 9. Neither is reachable
 *   through this socket: the mock corrects no instant for latency, so no tap can
 *   land inside a lock that has already closed; and nothing drains in
 *   Recruitment, so no answer can come from the Lounge. Both were left alone
 *   rather than guarded, because an unreachable guard is another piece of code
 *   nothing watches.
 *
 * Two of #29's sixteen are in the same position, and are written up at the head
 * of its own section: the `no_more_questions` sentence, and the streak bonus on a
 * warm-up. Both were differences rather than absent guards, so both were fixed
 * and neither can be watched — `at` cannot pass the end of the set, and the set
 * has no warm-up in it and no command that loads one. Mutating each of them back
 * leaves the whole suite green, which is the evidence that they are unreachable
 * and not the evidence that a scenario is missing.
 *
 * **(b)**, the Floor's clock on a tap, a letter and a bet, was the third of them
 * for a release, and the paragraph that excused it is kept here in corrected
 * form rather than deleted, because the argument was plausible, was written down
 * twice — here and above the guard in `#arcadeTap` — and was wrong. It ran: the
 * window the guard protects is between `endsAt` and the frame that ends the
 * round; `node:test`'s timers fire at their exact deadline and dispatch in due
 * order; so there is no moment at which the round is still `running` and its own
 * clock has passed, and a window that is seconds wide in a browser is zero wide
 * here.
 *
 * The premise is false, for the reason set out under "How the mock is driven"
 * above: `tick(n)` moves the clock to the end of the tick *before* it runs the
 * timers that came due inside it. So a frame handed to `transport.send` before
 * `endsAt` and the Floor timer armed for `endsAt` both come due inside one tick,
 * the frame runs first because its `runAt` is earlier, and it runs with the
 * mock's clock already past `endsAt` and `arcadePhase` still `running`. The
 * window is the tick's length minus the frame's lead, and 463 ms of it is what
 * the scenarios in the last section of this file use.
 *
 * What hid it was an ordering and not a clock. The probe ticked *past* `endsAt`
 * and only then sent, which is a frame arriving at an `idle` round and can only
 * ever be answered `wrong_round_phase`; sending first and ticking second always
 * reaches the window. All three of (b)'s guards have scenarios now — the
 * Plan / Apply tap, the Unseal letter and the `#arcadeBack` bet. The claim that
 * the bet guard was "the one with a window, and that one is tested" was false in
 * both halves: until those scenarios, this file did not contain the string "The
 * Floor has locked." at all.
 *
 * Two of the seventeen also turned out not to be differences, and are recorded
 * here in the same spirit. **(m)**, the totals fold, was the tail item #27's own
 * first half fixed — `#endRound` folds `standing ∪ banked` and the scenario for
 * it is above. And **(n)** is a misreading: the reducer does *not* broadcast a
 * late-dealt rope side. See the scenario named for it, which tests the real
 * divergence that was underneath — an uncredited tap fanning the whole rope out.
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
import { PROTOCOL_VERSION } from "../../protocol.ts";
import { RECRUITMENT_ITEMS } from "../../arcade/recruitment.ts";
import { GLASS_BRIDGE_STEPS } from "../../arcade/glass-bridge.ts";
import { UNSEAL_ITEMS } from "../../arcade/unseal.ts";
import { GGANBU_PROMPTS } from "../../arcade/gganbu.ts";
// The engine's own arithmetic for a question's points, used as the oracle it is:
// #29's row about it is that `mock.ts` was the naive transcription this function
// carries a comment warning against, and a scenario that wrote the correct
// formula out here instead would be comparing the mock against this file.
import { questionPoints } from "../../engine/trivia.ts";
// The floor of the send-off's beat, so the Auto scenario can walk a montage in a
// hundred fake seconds instead of four hundred. A bound and not a rule: both
// implementations clamp against it, and the clamp is what is being compared.
import { MIN_AUTO_SECONDS } from "../../engine/sendoff.ts";
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
  /**
   * Send a console command and hand back what the mock answered it with.
   *
   * {@link Room.cmd} asserts the press was accepted, which is right for the
   * scenarios that are about what a command *does*. #27's guard sweep is about
   * what a command *refuses* — and about the difference between a refusal and
   * an `applied: false` ack, which is a distinction the console reads: a
   * refusal is a red toast, and an ack that changed nothing is a toggle that
   * was already in that position. So these compare an {@link Answer} against
   * the one {@link engineAnswer} takes off the reducer for the same event.
   */
  attempt(command: HostCommand): Answer;
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
   * Fake milliseconds, a second at a time, and **not** because one enormous
   * tick would be the same arithmetic. This used to claim it was, which is
   * false in two ways that a scenario can trip over.
   *
   * A timer created *during* a tick does not run in that tick, so a re-arming
   * chain — which every one of the arcade's timers is — advances one link per
   * tick however long the tick is. Measured, on a one-second timer that re-arms
   * itself: one `tick(20_000)` fires it **once**, at 20 000; twenty
   * `tick(1_000)`s fire it ten times, at 1 000 through 10 000. So the size of
   * the tick decides how far the room actually gets, and the big tick gets
   * nowhere.
   *
   * And `tick(n)` moves `Date.now()` to the **end** of the tick before it runs
   * anything, so every instant the mock stamps inside that tick is the tick's
   * end rather than the deadline that woke it. Ticking a second at a time keeps
   * that error under a second, which is the most this can do about it; see the
   * note on the tick's end in the header.
   *
   * It does **not** make the mock's own timer durations predictable. The light
   * is a fresh `2_000 + random(4_000)` at every turn, and a scenario has no
   * business knowing which. Advance in steps and read the light off the frame:
   * {@link untilTheLightIs} does exactly that.
   */
  advance(ms: number): void;
}

/**
 * What one side said about one frame it was sent.
 *
 * Deliberately the same shape for both implementations, because that is the
 * whole claim #27's guard rows make: the engine and the mock must refuse the
 * same presses, with the same code, in the same words, and must ack the same
 * presses as having changed nothing. `refusedCmd.message` is not diagnostics —
 * it is the sentence that goes on the glass, so a refusal worded differently
 * here is a difference a host or a player reads.
 */
type Answer =
  | { readonly kind: "ack"; readonly applied: boolean }
  | { readonly kind: "refused"; readonly code: string; readonly message: string };

/** The answer a surface was given about one `cid`, off its own wire. */
function answerTo(wire: Wire, cid: string): Answer {
  const reply = wire.frames
    .filter((f) => (f.t === "ack" || f.t === "refusedCmd") && f.cid === cid)
    .at(-1);
  assert.ok(reply !== undefined, `the mock said nothing at all about ${cid}`);
  if (reply.t === "refusedCmd") {
    return { kind: "refused", code: reply.code, message: reply.message };
  }
  assert.ok(reply.t === "ack", `${cid} was answered with a ${reply.t}`);
  return { kind: "ack", applied: reply.applied };
}

/**
 * The same answer, from the reducer: its `applied` flag, or the rejection it
 * emitted.
 *
 * `reduce` returns both — `applied: false` covers a rejection *and* a no-op,
 * and the `reject` effect is what the boundary turns into a `refusedCmd` — so
 * this is the engine's own answer to the press and not a reading of it.
 */
function engineAnswer(
  state: SessionState,
  event: Event,
  at: number = T0,
): { readonly next: SessionState; readonly answer: Answer } {
  const result = reduce(state, event, at);
  const rejection = result.effects.find((e) => e.kind === "reject");
  if (rejection !== undefined && rejection.kind === "reject") {
    return {
      next: result.state,
      answer: { kind: "refused", code: rejection.code, message: rejection.message },
    };
  }
  return { next: result.state, answer: { kind: "ack", applied: result.applied } };
}

/**
 * How many full state frames a surface has been sent.
 *
 * The count, not the content, because some of #27 is about *whether a frame
 * went out at all*: `setJoinsLocked` is addressed to the console alone, and an
 * uncredited Tug tap that dealt somebody a side is addressed where an ordinary
 * uncredited tap is addressed nowhere. Acks are filtered out — every one of
 * these commands is acked, so counting every frame would count the same one
 * twice and hide the difference.
 */
function stateFrames(wire: Wire): number {
  return wire.frames.filter((f) => f.t === "state").length;
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

/**
 * How a room starts, for the one scenario that is about the phase before it.
 *
 * {@link room} presses Open before the phones arrive, because a phone cannot join
 * a session in `draft` — the reducer refuses it `not_joinable`, and as of #29 so
 * does the mock. Every scenario below therefore gets a room in `lobby` and
 * presses `start` itself; the `r.cmd({ name: "open" })` that used to be the first
 * line of each of them is now one press inside the constructor, made before there
 * is anybody to admit.
 *
 * `"draft"` is for the guard scenario that is *about* `draft` — a Close pressed
 * in it — and it asserts nobody was asked for, because a phone in a draft room is
 * the thing that is no longer possible.
 */
type RoomStart = "lobby" | "draft";

async function room(
  t: TestContext,
  phoneCount: number,
  start: RoomStart = "lobby",
): Promise<Room> {
  assert.ok(
    start === "lobby" || phoneCount === 0,
    "a draft room cannot hold phones — the mock now refuses a join in draft, " +
      "as the reducer does",
  );
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
  let cid = 0;
  const press = (command: HostCommand): void => {
    cid += 1;
    host.send({ t: "host.cmd", cid: `cid-${cid}`, cmd: command });
  };
  // The door, opened before anybody knocks. See {@link RoomStart}.
  if (start === "lobby") press({ name: "open" });
  const invited = new Set<string>();
  const phones: Wire[] = [];
  for (let i = 0; i < phoneCount; i += 1) {
    const nickname = `Player ${i + 1}`;
    invited.add(nickname);
    phones.push(open({ t: "hello", role: "participant", joinCode, nickname }));
  }

  const guard = (): void => noStrangers(host.state().roster, invited);
  return {
    host,
    screen,
    phones,
    cmd(command) {
      press(command);
      const refused = host.frames.filter((f) => f.t === "refusedCmd");
      const last = refused.at(-1);
      assert.ok(
        last === undefined || last.cid !== `cid-${cid}`,
        `the mock refused ${command.name}: ${last?.t === "refusedCmd" ? last.message : ""}`,
      );
      guard();
    },
    attempt(command) {
      press(command);
      const answer = answerTo(host, `cid-${cid}`);
      guard();
      return answer;
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
  { id: "trivia", title: "Trivia", kind: "trivia" },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade" },
];

/**
 * A session on the engine in `draft`, which is where {@link room} starts too.
 *
 * Separate from {@link engineRoom} because two of #27's guards are about the
 * phases *before* a session is running — a Close pressed in `draft`, and a
 * segment chosen in the lobby — and `engineRoom` has already opened and started
 * by the time it hands anything back.
 */
function engineDraft(): SessionState {
  return newSession({
    sid: "ses_divergence",
    title: "Divergence",
    joinCode: "hvs.testtesttest",
    activities: ACTIVITIES,
  });
}

/**
 * The same room on the real engine, stopped one event short of the arcade.
 *
 * Split out of {@link engineRoom} for #27's Lounge guards: the first thing
 * `backPlayer` checks is that there *is* an arcade, and `engineRoom` has always
 * entered one by the time it hands anything back — so the engine's own answer to
 * a bet with the arcade shut was not reachable through it.
 */
function engineBeforeTheArcade(phoneCount: number): SessionState {
  const joins: Event[] = [];
  for (let i = 0; i < phoneCount; i += 1) {
    joins.push({ type: "join", pid: `p${i + 1}`, nickname: `Player ${i + 1}` });
  }
  const events: readonly Event[] = [
    { type: "open" },
    ...joins,
    { type: "start" },
    { type: "setSegment", segment: "arcade" },
  ];
  return replay(
    engineDraft(),
    events.map((event) => ({ event, at: T0 })),
  );
}

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
  const events: readonly Event[] = [
    ...beforeTheArcade,
    { type: "enterArcade", activityId: "arcade" },
    ...extra,
  ];
  return replay(
    engineBeforeTheArcade(phoneCount),
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
   * different statement from the absent cell of a question nobody answered.
   * The fix is to the set, not to a narrower one.)
   */
  it("sends a row per person who played and no more, exactly as the engine does", async (t) => {
    const r = await room(t, 6);
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
    // one *unopened*. That mattered more when this was written than it does
    // now: the mock's `trivia.open` admitted only `idle`, where the reducer also
    // admits `suddenDeath` out of `revealed`, so a tiebreak opened from `idle`
    // was the only one reachable on both. That is #27's guard (f) and it is
    // fixed — there is a scenario for it further down — but the walk is left as
    // it is, because the fields this test is about do not depend on which phase
    // the tiebreak was opened from.
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
   * unrelated frame at all — a join, a bot answering, a score typed in — pushed
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
   * `unset`, which normalisation excludes from the ceiling: "played, 0" would put
   * three people on the board for a question none of them answered, and would
   * scale the room down against a raw nobody earned.
   */
  it("holds the grid still at the close and moves it at the reveal, as the engine does", async (t) => {
    const r = await room(t, 6);
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
   * entry means "did not play". So the old fold wrote "played, 0" against a
   * person who arrived after the round and against a person who had left the
   * room, and a "played, 0" is a row on the board and a divisor in the
   * normalisation that the engine does not have.
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
   * Recruitment rather than Plan / Apply for p8's sake, and that was a
   * *constraint* when this was written rather than a choice: `tap` was where the
   * two implementations disagreed about a latecomer with no standing — the
   * reducer admitted them and this file refused them — so a Plan / Apply
   * latecomer could not score here at all. That is #27's guard (a), it is fixed,
   * and there is now a scenario further down that reaches the same `banked` half
   * of this union through a tap. This one is left on Recruitment because it is
   * three people in one room rather than one, and because the fold it watches is
   * the same fold whichever round fills it.
   */
  it("gives a round's zero to the people who were in it and nobody else, as the engine does", async (t) => {
    const pair = roundPair("recruitment");
    const item = RECRUITMENT_ITEMS[0];
    assert.ok(item !== undefined, "there are no recruitment items");

    const r = await room(t, 6);
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

/* ------------------------------------------------------------------ */
/* #27 (a)–(q) — the guards, and the words a refusal is made of        */
/* ------------------------------------------------------------------ */

/**
 * The lettered rows of #27, which are all guards and refusals.
 *
 * They are a different kind of claim from everything above, and worth saying
 * why before the first one. The scenarios up to here compare *projections*: two
 * rooms driven the same way must put the same numbers on the same surfaces. A
 * guard is not on a surface. What a guard produces is a `refusedCmd` — a code
 * and a sentence — or an `ack` whose `applied` flag says whether the press did
 * anything, and both of those are read: the sentence goes on the glass, and the
 * flag is how the console knows a toggle it pressed was already in that
 * position. So these compare {@link Answer}s, taken off the mock's own wire and
 * off {@link engineAnswer}'s reading of the reducer's effects.
 *
 * The other half of them is *whether a frame goes out at all*, which is what
 * {@link stateFrames} is for.
 */
describe("the console's refusals are the reducer's refusals", () => {
  /**
   * (g) `close`, whose two arms were swapped for each other.
   *
   * `close` in reducer.ts: "closing an unopened session is meaningless; closing
   * a lobby that never started is a real thing a host does when an event is
   * abandoned." So a second Close is idempotent — the reducer's global
   * closed-session freeze exempts `close` by name, with the comment "closing
   * twice is idempotent, not an error" — and a Close in `draft` is the refusal.
   *
   * The mock had it exactly the other way round: `draft` closed a session
   * nobody had opened, setting `seal: "revealed"` and `segment: "final"` on an
   * empty room, and a second Close came back as a red toast for a button that
   * had already done what it says.
   */
  it("answers a Close in draft and a second Close the way the reducer answers them", async (t) => {
    // The one room in this file that stays in `draft`, and it holds no phones:
    // #29 gave the mock the reducer's `not_joinable`, so a draft session has
    // nobody in it by construction. Nothing below reads the roster — the two
    // claims are an answer and a phase.
    const r = await room(t, 0, "draft");
    assert.equal(r.host.state().phase, "draft", "the room did not start in draft");

    // The engine's own two answers, which are the point of the pairing: they are
    // not the same answer, so a mock that gave one answer to both cannot pass.
    const inDraft = engineAnswer(engineDraft(), { type: "close" });
    assert.deepEqual(
      inDraft.answer,
      {
        kind: "refused",
        code: "wrong_phase",
        message: "The session was never opened.",
      },
      "the engine's answer to a Close in draft",
    );
    assert.deepEqual(r.attempt({ name: "close" }), inDraft.answer, "Close, in draft");
    assert.equal(
      r.host.state().phase,
      "draft",
      "the refused Close closed the session anyway",
    );

    // The one press {@link room} normally makes for itself.
    r.cmd({ name: "open" });
    r.cmd({ name: "start" });
    let engine = engineRoom(0);
    const first = engineAnswer(engine, { type: "close" });
    assert.deepEqual(
      first.answer,
      { kind: "ack", applied: true },
      "the engine's first Close",
    );
    assert.deepEqual(r.attempt({ name: "close" }), first.answer, "the first Close");
    engine = first.next;

    const second = engineAnswer(engine, { type: "close" });
    assert.deepEqual(
      second.answer,
      { kind: "ack", applied: false },
      "the engine's second Close is not an ack that changed nothing",
    );
    assert.deepEqual(r.attempt({ name: "close" }), second.answer, "the second Close");
    assert.equal(r.host.state().phase, "closed", "the room is no longer closed");
  });

  /**
   * (h) the segment, which has no phase guard on the server and had one here.
   *
   * Argued both ways and decided as a fix, because the engine's position is not
   * an accident of implementation: `setSegment` has no phase check, and
   * `client/host/runbook.ts` states the contract in its header — "Nothing on
   * the server knows about this. The engine holds no sequence at all —
   * `setSegment` takes any segment at any time and sets it." The console's
   * segment rail is live in the lobby, which is where a host puts the holding
   * card up before the room arrives, and `?mock=manual` is the only console
   * anybody rehearses on. A demo that refuses a press the room will accept
   * teaches the wrong order of presses.
   *
   * Paired with the repeat, which is (k)'s first of five: the reducer returns
   * `unchanged` for a segment already showing, and the two answers differ, so
   * neither arm can be passed by accident.
   */
  it("takes a segment before the session is started, and acks a repeat as nothing", async (t) => {
    const r = await room(t, 2);
    assert.equal(
      r.host.state().phase,
      "lobby",
      "the session is already running, so the phase guard is not what is under test",
    );

    let engine = engineAnswer(engineDraft(), { type: "open" }).next;
    const first = engineAnswer(engine, { type: "setSegment", segment: "holding" });
    assert.deepEqual(
      first.answer,
      { kind: "ack", applied: true },
      "the engine refuses a segment in the lobby, so this row has changed",
    );
    assert.deepEqual(
      r.attempt({ name: "segment", kind: "holding" }),
      first.answer,
      "a segment chosen in the lobby",
    );
    engine = first.next;
    assert.equal(
      r.host.state().segment,
      engineView(engine).segment,
      "the two rooms are showing different segments",
    );
    assert.equal(r.host.state().segment, "holding", "the segment did not move at all");

    const again = engineAnswer(engine, { type: "setSegment", segment: "holding" });
    assert.deepEqual(
      again.answer,
      { kind: "ack", applied: false },
      "the engine's repeat is not an ack that changed nothing",
    );
    assert.deepEqual(
      r.attempt({ name: "segment", kind: "holding" }),
      again.answer,
      "the same segment, twice",
    );
  });

  /**
   * (k) and (q) together, because they are two readings of the same press.
   *
   * (k): `setSeal`, `setHolding` and `setJoinsLocked` — with `setSegment` above
   * and `pickShape` below — all open with an equality check and return
   * `unchanged`. None of them had one here, so the console was told a press had
   * changed something when it had not, and the room was sent a frame identical
   * to the one it was already holding.
   *
   * (q): `setJoinsLocked` is the one setter whose broadcast is not `to: "all"`.
   * It emits `{ to: "host", what: "state" }` and nothing else, because the lock
   * is drawn on the console's lobby panel and nowhere else — and `joinsLocked`
   * is nonetheless on *every* role's frame, so on the real server a phone's copy
   * of it is stale until something else broadcasts. Here the case fell to the
   * bottom of `#hostCmd` and fanned out to the room, so a surface that started
   * drawing the lock would have worked in the demo and been stale in the room.
   *
   * The seal is in the same scenario on purpose, and it is what makes the
   * fan-out claim mean anything: sealing *is* `to: "all"`, so the phone's frame
   * count has to move for one press and hold still for the other. A claim that
   * only said "the phone got no frame" would pass against a harness that could
   * not see a frame at all.
   */
  it("acks a setter that moved nothing as nothing, and tells only the console about the lock", async (t) => {
    const r = await room(t, 2);
    r.cmd({ name: "start" });
    let engine = engineRoom(2);
    const phone = r.phones[0];
    assert.ok(phone !== undefined);

    /* The seal: `to: "all"`, so every phone hears about it. */
    const sealed = engineAnswer(engine, { type: "setSeal", seal: "sealed" });
    assert.deepEqual(sealed.answer, { kind: "ack", applied: true }, "the engine's seal");
    const beforeTheSeal = stateFrames(phone);
    assert.deepEqual(
      r.attempt({ name: "seal", state: "sealed" }),
      sealed.answer,
      "the seal",
    );
    assert.ok(
      stateFrames(phone) > beforeTheSeal,
      "sealing told the room nothing, so this harness cannot see a fan-out at all " +
        "and the join-lock claim below would pass however it was written",
    );
    engine = sealed.next;
    const sealedAgain = engineAnswer(engine, { type: "setSeal", seal: "sealed" });
    assert.deepEqual(
      sealedAgain.answer,
      { kind: "ack", applied: false },
      "the engine's repeated seal",
    );
    assert.deepEqual(
      r.attempt({ name: "seal", state: "sealed" }),
      sealedAgain.answer,
      "the same seal, twice",
    );

    /* The holding card, compared field by field rather than by identity. */
    const card = { title: "Back at 2:15", line: "Grab a coffee" };
    const held = engineAnswer(engine, { type: "setHolding", holding: card });
    assert.deepEqual(held.answer, { kind: "ack", applied: true }, "the engine's card");
    assert.deepEqual(
      r.attempt({ name: "holding", title: card.title, line: card.line }),
      held.answer,
      "the holding card",
    );
    engine = held.next;
    // The same card as a fresh object, which is the shape the console actually
    // sends: it rebuilds the card from its two inputs on every keystroke, so an
    // identity comparison would fan out on every one of them.
    const heldAgain = engineAnswer(engine, {
      type: "setHolding",
      holding: { title: card.title, line: card.line },
    });
    assert.deepEqual(
      heldAgain.answer,
      { kind: "ack", applied: false },
      "the engine's repeated card",
    );
    assert.deepEqual(
      r.attempt({ name: "holding", title: card.title, line: card.line }),
      heldAgain.answer,
      "the same card, twice",
    );
    assert.deepEqual(
      r.host.state().holding,
      engineView(engine).holding,
      "the two consoles are holding different cards",
    );

    /* The join lock: the console, and nobody else. */
    const locked = reduce(engine, { type: "setJoinsLocked", locked: true }, T0);
    const fanOut = locked.effects.filter((e) => e.kind === "broadcast");
    // The engine's own effects, which are the whole of this claim: it addresses
    // the console and it addresses nobody else.
    assert.ok(fanOut.length > 0, "the engine broadcasts nothing at all for the lock");
    assert.deepEqual(
      fanOut.map((e) => e.to),
      fanOut.map(() => "host"),
      "the engine's lock reaches somebody other than the console",
    );
    const beforeTheLock = { host: stateFrames(r.host), phone: stateFrames(phone) };
    assert.deepEqual(
      r.attempt({ name: "lobby.lock", locked: true }),
      { kind: "ack", applied: true },
      "the lock",
    );
    assert.equal(
      stateFrames(r.host),
      beforeTheLock.host + 1,
      "the console was not told about the lock it set",
    );
    assert.equal(
      stateFrames(phone),
      beforeTheLock.phone,
      "a phone was sent a frame for a lock the engine addresses to the console alone",
    );
    engine = locked.state;
    const lockedAgain = engineAnswer(engine, { type: "setJoinsLocked", locked: true });
    assert.deepEqual(
      lockedAgain.answer,
      { kind: "ack", applied: false },
      "the engine's repeated lock",
    );
    assert.deepEqual(
      r.attempt({ name: "lobby.lock", locked: true }),
      lockedAgain.answer,
      "the same lock, twice",
    );
  });

  /**
   * (p) Reveal before End, which is the arcade's commonest mis-press.
   *
   * `revealRound` in reducer.ts has two sentences for the two cases, and the
   * difference is the use of them: "End the round before revealing it." names
   * the button to press instead, and "There is nothing to reveal." says the
   * press was meaningless. The mock sent the second for both, so a host who
   * pressed Reveal one button too early — in front of the room, which is when
   * it happens — was told there was nothing there.
   */
  it("names the button to press when Reveal comes before End", async (t) => {
    const r = await room(t, 2);
    const pair = roundPair("unseal");
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    let engine = engineRoom(2);

    // Nothing has been played: the other arm, and the one the mock already had.
    const nothing = engineAnswer(engine, { type: "revealRound" });
    assert.deepEqual(
      nothing.answer,
      {
        kind: "refused",
        code: "wrong_round_phase",
        message: "There is nothing to reveal.",
      },
      "the engine's answer with no round played",
    );
    assert.deepEqual(
      r.attempt({ name: "arcade.reveal" }),
      nothing.answer,
      "Reveal with no round played",
    );

    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    engine = replay(engine, [
      { event: { type: "startRound", round: "unseal", config: pair.config }, at: T0 },
      { event: { type: "beginPlay" }, at: T0 },
    ]);
    assert.equal(
      r.host.state().arcade?.phase,
      "running",
      "the round is not running, so this is the same arm as above",
    );

    const running = engineAnswer(engine, { type: "revealRound" });
    assert.deepEqual(
      running.answer,
      {
        kind: "refused",
        code: "wrong_round_phase",
        message: "End the round before revealing it.",
      },
      "the engine's answer over a running round",
    );
    assert.notDeepEqual(
      running.answer,
      nothing.answer,
      "the engine has one message for both cases, so this row has changed",
    );
    assert.deepEqual(
      r.attempt({ name: "arcade.reveal" }),
      running.answer,
      "Reveal over a running round",
    );
  });

  /**
   * (j) a restart, which turns practice off.
   *
   * `restartSession` in reducer.ts sets `practice: false` with a reason on it: a
   * restart is the room starting again, and practice is not a thing a new
   * session inherits. Neither `restart()` nor `reset()` here touched it, so a
   * host who rehearsed a round in practice and then restarted for the real thing
   * got a clean console over a session that was still scoring nothing — and
   * `practice` is on every role's frame precisely so that nobody can be in that
   * position without being told.
   */
  it("turns practice off across a restart, as the reducer does", async (t) => {
    const r = await room(t, 2);
    r.cmd({ name: "start" });
    r.cmd({ name: "practice", on: true });
    let engine = replay(engineRoom(2), [
      { event: { type: "setPractice", on: true }, at: T0 },
    ]);
    // Worth comparing at all: both rooms really are in practice before the
    // restart, so the `false` below is a change and not a default.
    assert.equal(engineView(engine).practice, true, "the engine is not in practice");
    assert.equal(r.host.state().practice, true, "the mock is not in practice");

    // The mock draws its own join code and checks the restart names it, exactly
    // as the server does: a restart frame that does not name this session is not
    // one this session performs.
    const confirm = r.host.state().joinCode;
    assert.ok(confirm !== undefined, "the console frame carries no join code");
    r.cmd({ name: "session.restart", confirm });
    engine = replay(engine, [{ event: { type: "restartSession" }, at: T0 + 1_000 }]);
    assert.equal(
      engineView(engine).practice,
      false,
      "the engine's own answer: a restart clears practice",
    );
    assert.equal(
      r.host.state().practice,
      engineView(engine).practice,
      "the mock came back from a restart still in practice",
    );
    // And the restart really happened on both, rather than being refused.
    assert.equal(r.host.state().phase, engineView(engine).phase, "the phase after a restart");
  });
});

/* ------------------------------------------------------------------ */
/* #27 (e) and (f) — the set a tiebreak interrupts                     */
/* ------------------------------------------------------------------ */

describe("a tiebreak leaves the scored set exactly where it found it", () => {
  /**
   * Two rows, one walk, because they are the two halves of the same afternoon.
   *
   * **(f)** `openQuestion` in reducer.ts admits a sudden death out of `revealed`
   * as well as out of `idle`, and its comment calls that the point of the fix:
   * "a tie is settled *after* the last question, when the phase is `revealed`
   * and `nextQuestion` has nothing left to advance to." The mock admitted `idle`
   * only — so the one tiebreak a room actually stages, the one that settles the
   * whole game after the last reveal, could not be reached on the mock at all.
   *
   * **(e)** `nextQuestion` refuses only `open`: "advancing from `idle` is how a
   * host skips a question they do not want to ask, which the ⚠️ VERIFY
   * discipline in the question bank makes a real need." The mock required
   * `revealed`, which took the skip away, and then cleared a sudden death with
   * `at += 1`, which burned the next scored question — where the reducer holds
   * the question the tiebreak interrupted and hands it back untouched.
   *
   * The walk *is* the test of (e)'s first half rather than a setup for it: every
   * step of it is a `trivia.next` out of `idle`, which is what the old guard
   * refused. It then ends where (f) lives — on the last question of the set,
   * revealed — and the tiebreak is opened there.
   *
   * The questions come off the console's own frames, as everywhere else in this
   * file: the mock's set is a private constant with no loader. The *tiebreak
   * question* is the one thing the two sides do not share, and deliberately —
   * `mock.ts` lists the absent sudden-death pool as a known difference — so
   * nothing below compares the question on screen. What it compares is where
   * the set is: `index`, `of` and `phase`, which are the three fields that say
   * so.
   */
  it("skips out of idle, settles a tie after the last reveal, and comes back unmoved", async (t) => {
    const r = await room(t, 3);
    r.cmd({ name: "start" });

    const total = r.host.state().trivia?.of ?? 0;
    assert.ok(total >= 3, "the mock's set is too short to skip through");

    // (e), the skip: capture each question while it is idle and step past it
    // without ever opening it. Every one of these was `wrong_question_phase`,
    // "Reveal this one first.", before this row was fixed.
    const asked: Question[] = [];
    const skips: Answer[] = [];
    for (let i = 0; i < total; i += 1) {
      asked.push(questionFromFrame(r.host.state()));
      assert.equal(r.host.state().trivia?.index, i, `the mock is not on question ${i}`);
      if (i === total - 1) break;
      skips.push(r.attempt({ name: "trivia.next" }));
    }
    let engine = engineTriviaRoom(3, asked, [
      {
        text: "A tiebreak question, held outside the scored set.",
        answers: ["Yes", "No"],
        timeLimitSec: 20,
        correct: [0],
        note: null,
        round: null,
        basePoints: 0,
      },
    ]);
    for (const skip of skips) {
      const stepped = engineAnswer(engine, { type: "nextQuestion" });
      assert.deepEqual(
        stepped.answer,
        { kind: "ack", applied: true },
        "the engine refuses a skip out of idle, so this row has changed",
      );
      assert.deepEqual(skip, stepped.answer, "a question skipped without being asked");
      engine = stepped.next;
    }

    /** Where the set is, on one frame: the three fields that say so. */
    const where = (state: RenderState): unknown => {
      const view = state.trivia;
      assert.ok(view !== undefined, "no trivia on the frame");
      return { index: view.index, of: view.of, phase: view.phase };
    };
    assert.deepEqual(
      where(engineView(engine)),
      { index: total - 1, of: total, phase: "idle" },
      "the engine's own place in the set after the skips",
    );
    assert.deepEqual(where(r.host.state()), where(engineView(engine)), "after the skips");

    // The last question, played properly, so the phase (f) is about is a real one.
    r.cmd({ name: "trivia.open", suddenDeath: false });
    r.cmd({ name: "trivia.close" });
    r.cmd({ name: "trivia.reveal" });
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
      { event: { type: "closeQuestion" }, at: T0 + 1_000 },
      { event: { type: "revealQuestion" }, at: T0 + 2_000 },
    ]);
    assert.deepEqual(
      where(engineView(engine)),
      { index: total - 1, of: total, phase: "revealed" },
      "the engine is not on a revealed last question, so (f) is not being exercised",
    );
    assert.deepEqual(
      where(r.host.state()),
      where(engineView(engine)),
      "at the last reveal",
    );

    // (f): the tie, settled after the last reveal. The set has nothing left to
    // advance to, which is the case the reducer's comment is about.
    const tie = engineAnswer(
      engine,
      { type: "openQuestion", suddenDeath: true },
      T0 + 3_000,
    );
    assert.deepEqual(
      tie.answer,
      { kind: "ack", applied: true },
      "the engine refuses a sudden death out of revealed, so this row has changed",
    );
    assert.deepEqual(
      r.attempt({ name: "trivia.open", suddenDeath: true }),
      tie.answer,
      "a sudden death opened after the last reveal",
    );
    engine = tie.next;
    assert.equal(
      r.host.state().trivia?.suddenDeath,
      true,
      "the mock is not in a sudden death",
    );
    assert.equal(
      engineView(engine).trivia?.suddenDeath,
      true,
      "the engine is not in a sudden death",
    );

    // Closed by the host, because a sudden death has no timer — it "runs until
    // someone is right" — and `nextQuestion` refuses an open question whatever
    // kind it is. The scenario above this one is about that close; here it is
    // the step that gets to the clearing.
    r.cmd({ name: "trivia.close" });
    engine = replay(engine, [
      { event: { type: "closeQuestion" }, at: T0 + 3_500 },
    ]);

    // (e), the half that cost points: clearing it puts the set back where it
    // was — the same question, in the same phase — and does not spend one.
    const cleared = engineAnswer(engine, { type: "nextQuestion" }, T0 + 4_000);
    assert.deepEqual(
      cleared.answer,
      { kind: "ack", applied: true },
      "the engine cannot clear a tiebreak after the last question",
    );
    assert.deepEqual(
      r.attempt({ name: "trivia.next" }),
      cleared.answer,
      "the tie cleared",
    );
    engine = cleared.next;
    assert.deepEqual(
      where(engineView(engine)),
      { index: total - 1, of: total, phase: "revealed" },
      "the engine's own place afterwards: the question the tiebreak interrupted",
    );
    assert.deepEqual(
      where(r.host.state()),
      where(engineView(engine)),
      "the set did not come back where the tiebreak found it",
    );

    // And the set really is finished on both, rather than one of them holding a
    // question the other has spent: `at` never moved, so this is the last one.
    const past = engineAnswer(engine, { type: "nextQuestion" }, T0 + 5_000);
    assert.deepEqual(
      past.answer,
      {
        kind: "refused",
        code: "no_more_questions",
        message: "That was the last question.",
      },
      "the engine has a question left after the tiebreak",
    );
    assert.deepEqual(
      r.attempt({ name: "trivia.next" }),
      past.answer,
      "past the end of the set",
    );
  });

  /**
   * (e)'s one refusal, which the mock also had wrong in the other direction.
   *
   * Advancing past an *open* question is the one thing `nextQuestion` refuses,
   * "because it would drop answers already given and score nobody" — and the
   * words matter as much as the code does, since "Close the question before
   * moving on." names the press to make and the mock's "Reveal this one first."
   * named a press that is two steps away.
   */
  it("refuses to advance past an open question, in the reducer's words", async (t) => {
    const r = await room(t, 3);
    r.cmd({ name: "start" });
    const asked = [questionFromFrame(r.host.state())];
    r.cmd({ name: "trivia.open", suddenDeath: false });
    assert.equal(r.host.state().trivia?.phase, "open", "no question is open");

    const engine = replay(engineTriviaRoom(3, asked), [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
    ]);
    const refused = engineAnswer(engine, { type: "nextQuestion" }, T0 + 1_000);
    assert.deepEqual(
      refused.answer,
      {
        kind: "refused",
        code: "wrong_question_phase",
        message: "Close the question before moving on.",
      },
      "the engine's answer over an open question",
    );
    assert.deepEqual(
      r.attempt({ name: "trivia.next" }),
      refused.answer,
      "Next over an open question",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #27 (a) and (i) — the latecomer, and the number the host hands them  */
/* ------------------------------------------------------------------ */

describe("a latecomer to a running round can play it", () => {
  /**
   * (a) the Plan / Apply tap, which refused anybody without a standing.
   *
   * `tap` in reducer.ts refuses `=== "drained"` and says why in the same breath:
   * "absent means *joined after the round started*, and such a person is put on
   * the Floor by playing … without this they were refused a tap for being in the
   * Lounge *and* refused a bet for being on the Floor — two contradictory
   * sentences on one phone, and nothing they could do about either." The mock
   * refused `!== "floor"`, which is exactly that person.
   *
   * It is the row that shaped the rest of this file: the scenario above about
   * `#endRound`'s `standing ∪ banked` fold had to reach the `banked` half through
   * a Recruitment answer, because a Plan / Apply latecomer could not score here
   * at all. This is the same half of the same union, by the route the issue
   * describes.
   *
   * Target four, as the late-bet scenario above uses and for the same reason:
   * the crossing is four taps rather than a hundred and twenty, and four is the
   * smallest target whose three checkpoints are three distinct numbers. One tap
   * clears the first checkpoint and banks 5, which is enough — the claim is that
   * the tap was *taken*, not that the arithmetic is different arithmetic.
   */
  it("banks a latecomer's tap and folds it into the round, as the engine does", async (t) => {
    const cmd = {
      name: "arcade.round",
      kind: "plan_apply",
      target: 4,
      seconds: 90,
    } as const;
    const config: ArcadeRoundConfig = { kind: "plan_apply", target: 4, seconds: 90 };

    const r = await room(t, 6);
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(cmd);
    r.cmd({ name: "arcade.begin" });
    const round = r.host.state().arcade?.roundIndex ?? -1;

    let engine = engineRoom(6, [
      { type: "startRound", round: "plan_apply", config },
      { type: "beginPlay" },
    ]);

    // The latecomer, arriving with the Floor already open. `startRound` fixed the
    // standings before they got here, so they have none — on either side.
    const late = r.join("Player 7");
    engine = replay(engine, [
      { event: { type: "join", pid: "p7", nickname: "Player 7" }, at: T0 + 1_000 },
    ]);
    const standingOf = (state: RenderState, pid: string): string | undefined =>
      (state.arcade?.grid ?? []).find((c) => c.pid === pid)?.standing;
    assert.equal(
      standingOf(engineView(engine), "p7"),
      "floor",
      "the engine's grid does not have the latecomer on it",
    );

    // The tap, which used to be refused here and accepted there. Sent before the
    // light can turn: `#lightMs` is two seconds at its shortest and nothing has
    // spent any clock, so this is comfortably inside the opening PLAN.
    late.send({ t: "arcade.tap", cid: "late-tap", round });
    const tapped = engineAnswer(
      engine,
      { type: "tap", pid: "p7", at: T0 + 2_000 },
      T0 + 2_000,
    );
    assert.deepEqual(
      tapped.answer,
      { kind: "ack", applied: true },
      "the engine refuses a latecomer's tap, so this row has changed",
    );
    assert.deepEqual(
      answerTo(late, "late-tap"),
      tapped.answer,
      "the latecomer's tap",
    );
    engine = tapped.next;

    r.cmd({ name: "arcade.end" });
    engine = replay(engine, [{ event: { type: "endRound" }, at: T0 + 3_000 }]);

    const totals = (state: RenderState): Readonly<Record<string, number>> =>
      state.hostExtras?.arcade?.totals ?? {};
    const real = totals(engineView(engine));
    // The engine's own fold, printed. Six people were in the round and scored
    // nothing; the seventh was not in the standings at all and is in the totals
    // because they banked — which is the `banked` half of the union, reached the
    // way the issue said it should be once this guard was fixed.
    assert.deepEqual(
      real,
      { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, p7: 5 },
      "the engine's own totals",
    );
    assert.deepEqual(totals(r.host.state()), real, "the round's totals");
  });

  /**
   * (i) re-entering the arcade, which is how a latecomer gets a number.
   *
   * `enterArcade` in reducer.ts re-runs `assignPlayerNumbers` on a second entry
   * and says so: "re-entering is not an error: it is how the host hands a number
   * to somebody who joined after the arcade started. Numbers already handed out
   * never move." It returns `unchanged` only when the re-run added nobody. The
   * mock opened with `if (s.arcadeOn) return noop()`, so the one press that fixes
   * a latecomer's number did nothing at all — on the surface where the
   * facilitator would go looking for it, and acked as "understood, changed
   * nothing" so the console could not tell.
   *
   * The claim is the ack, because the ack is all of it that is on the wire: the
   * grid's `playerNumber` falls back to join order (`playerNumbers[pid] ??
   * p.playerNumber`), deliberately, so that a numberless latecomer is drawn as
   * themselves rather than as `000`. What the number changes is the *rules* —
   * `waveOf` and `tinIndexFor` are handed the raw register — and by the next
   * round card both implementations have dealt one anyway.
   *
   * The second half of the scenario is the trap this fix walks into. The mock's
   * `assignArcadeNumbers` also did `arcadeStanding[pid] ??= "floor"`, which was
   * dead at every existing call site and stops being dead the moment the command
   * can re-enter: a standing puts the latecomer into `#endRound`'s `standing ∪
   * banked` fold and writes them a `0` on the console's arcade totals — "played
   * and scored nothing" against somebody who was not in the round. That is the
   * exact cell the fold was fixed for, arriving by a new door, and it is why the
   * standing moved out of that method.
   */
  it("acks the press that numbers a latecomer, and leaves them out of the round", async (t) => {
    const pair = roundPair("recruitment");
    const r = await room(t, 6);
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });

    let engine = engineRoom(6, [
      { type: "startRound", round: "recruitment", config: pair.config },
      { type: "beginPlay" },
    ]);

    r.join("Player 7");
    engine = replay(engine, [
      { event: { type: "join", pid: "p7", nickname: "Player 7" }, at: T0 + 1_000 },
    ]);

    const numbered = engineAnswer(
      engine,
      { type: "enterArcade", activityId: "arcade" },
      T0 + 2_000,
    );
    assert.deepEqual(
      numbered.answer,
      { kind: "ack", applied: true },
      "the engine treats a re-entry as a no-op, so this row has changed",
    );
    assert.deepEqual(
      r.attempt({ name: "arcade.enter" }),
      numbered.answer,
      "Enter the arcade again, with somebody new in the room",
    );
    engine = numbered.next;

    // And again, with nobody new: now it *is* a no-op, on both. The pair is what
    // makes the first half a claim — an implementation that acked every re-entry
    // `true` would pass one of these and not the other.
    const nobodyNew = engineAnswer(
      engine,
      { type: "enterArcade", activityId: "arcade" },
      T0 + 3_000,
    );
    assert.deepEqual(
      nobodyNew.answer,
      { kind: "ack", applied: false },
      "the engine's second re-entry",
    );
    assert.deepEqual(
      r.attempt({ name: "arcade.enter" }),
      nobodyNew.answer,
      "Enter the arcade again, with nobody new",
    );
    engine = nobodyNew.next;

    // The round ends with the latecomer never having played. The engine's fold
    // has no cell for them, and neither may this one.
    r.cmd({ name: "arcade.end" });
    engine = replay(engine, [{ event: { type: "endRound" }, at: T0 + 4_000 }]);
    const totals = (state: RenderState): Readonly<Record<string, number>> =>
      state.hostExtras?.arcade?.totals ?? {};
    const real = totals(engineView(engine));
    assert.deepEqual(
      real,
      { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0 },
      "the engine's own totals: six cells, and none for the latecomer",
    );
    assert.deepEqual(totals(r.host.state()), real, "the round's totals");
    assert.ok(
      !("p7" in totals(r.host.state())),
      "the press that numbered the latecomer also put them in a round they missed",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #27 (b) and (d) — the Lounge's guards, in the reducer's order        */
/* ------------------------------------------------------------------ */

describe("a bet is refused in the reducer's order and in the reducer's words", () => {
  /**
   * (d), which is six differences wearing one letter.
   *
   * `backPlayer` in reducer.ts checks, in this order: the arcade is open, the
   * round is running, you are in the Lounge (or a waiting wave), the Floor's
   * clock has not run out, it is not yourself, they exist, and they are still on
   * the Floor. `#arcadeBack` checked the Lounge, yourself and their standing
   * *first* and the phase **last**, wearing `floor_locked`, and never reached
   * `unknown_participant` at all. So:
   *
   * - A phone pressing Back between rounds — which is when a Lounge card is
   *   still on the glass, because the strike stays up through idle and reveal —
   *   was told "You are on the Floor." by a room with no Floor open.
   * - With the arcade off there is no seat and no waiting wave, so the same
   *   sentence answered a room that is not in the arcade at all.
   * - Backing a pid nobody holds read `undefined !== "floor"` and came back as
   *   "They are in the Lounge too." about a person who does not exist.
   * - And three of the messages were this file's own wording rather than the
   *   engine's, which matters because `refusedCmd.message` is the sentence that
   *   goes on the glass.
   *
   * Driven as one walk through a Plan / Apply round, because that is the shortest
   * route to somebody who is genuinely in the Lounge: the light turns, two taps
   * into the lock drain two people, and every guard after the first two needs one
   * of them. The last one needs the round to be over, so it comes after the End.
   *
   * The accepted bet and the repeat of it are in here too, and they are what stop
   * this passing against an implementation that refuses everything.
   */
  it("walks every refusal the reducer has for a bet, and compares each one", async (t) => {
    const cmd = {
      name: "arcade.round",
      kind: "plan_apply",
      target: 4,
      seconds: 90,
    } as const;
    const config: ArcadeRoundConfig = { kind: "plan_apply", target: 4, seconds: 90 };

    const r = await room(t, 6);
    r.cmd({ name: "start" });
    // Before the arcade, because the first thing the reducer checks for a bet is
    // that there is one. See {@link engineBeforeTheArcade}.
    let engine = engineBeforeTheArcade(6);
    const [p1, , p3, p4] = r.phones;
    assert.ok(p1 !== undefined && p3 !== undefined && p4 !== undefined);

    /** One phone's Back, on both sides, compared. */
    let bets = 0;
    const bet = (
      wire: Wire,
      pid: string,
      backing: string,
      at: number,
      want: Answer,
      where: string,
    ): void => {
      bets += 1;
      const cid = `back-${bets}`;
      const real = engineAnswer(engine, { type: "backPlayer", pid, backing }, at);
      assert.deepEqual(real.answer, want, `the engine's own answer: ${where}`);
      wire.send({ t: "arcade.back", cid, pid: backing });
      assert.deepEqual(answerTo(wire, cid), real.answer, where);
      engine = real.next;
    };

    // Before the arcade is open at all. The engine's first guard, and one the
    // mock could not reach.
    bet(
      p1,
      "p1",
      "p2",
      T0 + 1_000,
      { kind: "refused", code: "not_in_arcade", message: "The arcade is not open." },
      "a bet with the arcade shut",
    );

    r.cmd({ name: "arcade.enter" });
    r.cmd(cmd);
    engine = replay(engine, [
      { event: { type: "enterArcade", activityId: "arcade" }, at: T0 + 2_000 },
      {
        event: { type: "startRound", round: "plan_apply", config },
        at: T0 + 2_000,
      },
    ]);

    // The round card is up and the Floor is not open: the engine's second guard,
    // which the mock checked last and under the wrong name.
    bet(
      p1,
      "p1",
      "p2",
      T0 + 3_000,
      {
        kind: "refused",
        code: "wrong_round_phase",
        message: "The Lounge is not open.",
      },
      "a bet against the round card",
    );

    r.cmd({ name: "arcade.begin" });
    engine = replay(engine, [{ event: { type: "beginPlay" }, at: T0 + 4_000 }]);
    const round = r.host.state().arcade?.roundIndex ?? -1;

    // Two people into the Lounge, the only way this round produces one: the light
    // turns pink and they tap. Three hundred milliseconds past the turn, because
    // `#tapInstant` forgives a tap inside the 250 ms grace.
    untilTheLightIs(r, "apply");
    r.advance(300);
    engine = replay(engine, [
      {
        event: { type: "setLight", light: "apply", until: T0 + 16_000 },
        at: T0 + 10_000,
      },
    ]);
    p3.send({ t: "arcade.tap", cid: "lock-p3", round });
    p4.send({ t: "arcade.tap", cid: "lock-p4", round });
    engine = replay(engine, [
      { event: { type: "tap", pid: "p3", at: T0 + 11_000 }, at: T0 + 11_000 },
      { event: { type: "tap", pid: "p4", at: T0 + 11_001 }, at: T0 + 11_001 },
    ]);
    untilTheLightIs(r, "plan");
    engine = replay(engine, [
      {
        event: { type: "setLight", light: "plan", until: T0 + 40_000 },
        at: T0 + 16_000,
      },
    ]);

    const drained = (state: RenderState): readonly string[] =>
      (state.arcade?.grid ?? []).filter((c) => c.struck).map((c) => c.pid);
    assert.deepEqual(
      drained(engineView(engine)),
      ["p3", "p4"],
      "the engine drained somebody else, so the guards below are not what they look like",
    );
    assert.deepEqual(
      drained(r.host.state()),
      drained(engineView(engine)),
      "the two rooms drained different people",
    );

    // On the Floor, so there is nothing to bet with.
    bet(
      p1,
      "p1",
      "p2",
      T0 + 17_000,
      {
        kind: "refused",
        code: "not_in_the_lounge",
        message: "You are on the Floor. Play.",
      },
      "a bet from the Floor",
    );
    // Yourself, from the Lounge.
    bet(
      p3,
      "p3",
      "p3",
      T0 + 17_100,
      {
        kind: "refused",
        code: "cannot_back_yourself",
        message: "You are in the Lounge. Back somebody still playing.",
      },
      "backing yourself",
    );
    // Somebody who does not exist, which the mock answered as though they did.
    bet(
      p3,
      "p3",
      "p99",
      T0 + 17_200,
      {
        kind: "refused",
        code: "unknown_participant",
        message: "No participant p99.",
      },
      "backing a pid nobody holds",
    );
    // Somebody who is in the Lounge too, named.
    bet(
      p3,
      "p3",
      "p4",
      T0 + 17_300,
      {
        kind: "refused",
        code: "cannot_back_a_drained_player",
        message: "Player 4 is in the Lounge too.",
      },
      "backing a drained player",
    );
    // A bet that stands, so this is not a scenario that refuses everything.
    bet(
      p3,
      "p3",
      "p1",
      T0 + 17_400,
      { kind: "ack", applied: true },
      "an honest bet",
    );
    assert.equal(
      engineView(engine).hostExtras?.arcade?.backing?.["p3"],
      "p1",
      "the engine did not record the bet, so the repeat below is not a repeat",
    );
    // And the same bet again, which is not a change of mind. `placedAt` is
    // restamped on every placement and `betStands` judges the bet on it, so a
    // phone re-sending its own bet must not turn a standing one into a late one.
    bet(
      p3,
      "p3",
      "p1",
      T0 + 17_500,
      { kind: "ack", applied: false },
      "the same bet, twice",
    );

    // And after the round: the phase guard again, from the other side of it.
    r.cmd({ name: "arcade.end" });
    engine = replay(engine, [{ event: { type: "endRound" }, at: T0 + 18_000 }]);
    bet(
      p3,
      "p3",
      "p2",
      T0 + 19_000,
      {
        kind: "refused",
        code: "wrong_round_phase",
        message: "The Lounge is not open.",
      },
      "a bet after the round ended",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #27 (l) — a round that has ended has no clocks                      */
/* ------------------------------------------------------------------ */

describe("a round that has ended carries neither of its clocks", () => {
  /**
   * `endRound` in reducer.ts nulls `startedAt` **and** `endsAt`. This file nulled
   * only `endsAt`, and left `arcadeStartedAt` standing until the *next*
   * `#startRound` — so `ArcadeView.startedAt` went out non-null through the whole
   * of idle and the whole of the reveal, a finished round still saying when its
   * Floor opened. Nothing reads it today, which is why it went unseen; it is on
   * the wire for every role, which is why it is a difference rather than
   * bookkeeping.
   *
   * Both instants, and at both phases, because the reveal is where the field sat
   * wrong for longest — a host talks over a reveal for as long as they like.
   *
   * The two clocks are compared as *null or not*, never as numbers: the mock's
   * clock is 1.2 seconds ahead of the page's by design and the engine is handed
   * the harness's own `T0`, so the instants themselves are two readings of two
   * different clocks and only their absence is a shared claim.
   */
  it("nulls startedAt at the end and keeps it null through the reveal, as the engine does", async (t) => {
    const pair = roundPair("unseal");
    const r = await room(t, 6);
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    let engine = engineRoom(6, [
      { type: "startRound", round: "unseal", config: pair.config },
      { type: "beginPlay" },
    ]);

    /** Which of the round's two clocks are set, and the phase they are set in. */
    const clocks = (state: RenderState): unknown => {
      const arcade = state.arcade;
      assert.ok(arcade !== undefined, "no arcade on the frame");
      return {
        phase: arcade.phase,
        started: arcade.startedAt !== null,
        ends: arcade.endsAt !== null,
      };
    };

    // Running: both clocks set, on both sides. Without this the nulls below
    // could be nulls that were never anything else.
    assert.deepEqual(
      clocks(engineView(engine)),
      { phase: "running", started: true, ends: true },
      "the engine's own clocks while the Floor is open",
    );
    assert.deepEqual(clocks(r.host.state()), clocks(engineView(engine)), "while running");

    r.cmd({ name: "arcade.end" });
    engine = replay(engine, [{ event: { type: "endRound" }, at: T0 + 1_000 }]);
    assert.deepEqual(
      clocks(engineView(engine)),
      { phase: "idle", started: false, ends: false },
      "the engine's own clocks at the close",
    );
    assert.deepEqual(clocks(r.host.state()), clocks(engineView(engine)), "at the close");

    r.cmd({ name: "arcade.reveal" });
    engine = replay(engine, [{ event: { type: "revealRound" }, at: T0 + 2_000 }]);
    assert.deepEqual(
      clocks(engineView(engine)),
      { phase: "reveal", started: false, ends: false },
      "the engine's own clocks at the reveal",
    );
    assert.deepEqual(
      clocks(r.screen.state()),
      clocks(engineScreen(engine)),
      "at the reveal, on the big screen",
    );
  });
});


/* ------------------------------------------------------------------ */
/* #27 (n) — what an uncredited tap at the rope moves, and what it sends */
/* ------------------------------------------------------------------ */

describe("a tap at the rope that achieved nothing tells nobody it did", () => {
  /**
   * (n), which turned out to be a misreading of the reducer, and a real
   * divergence in the opposite direction underneath it.
   *
   * #27 has the reducer "applies and broadcasts when `sides` changed even with
   * nothing credited", and `#recordBeat` returning false as the bug. Only the
   * first verb is right. `tapBeat` in reducer.ts ends on
   *
   *     if (!credited && sides === play.sides && last === was) return unchanged();
   *     return applied({ … }, credited ? [ …three broadcasts, PERSIST ] : []);
   *
   * so it *applies* whenever something moved — a beat credited, a side dealt to
   * somebody who was not in the room when they were dealt, or an election wound
   * forward past its end — and it **sends nothing at all unless a beat was
   * credited**. Its own comment says why, two lines further down: "thirty
   * players at 100 bpm is fifty credits a second, and a fan-out each would be
   * fifteen hundred frames a second to move a rope by a pixel." A late-dealt
   * side reaches the room on that player's next credited tap, on the server
   * exactly as here. There is nothing to fix in that direction.
   *
   * What *was* wrong is the same two lines read the other way. `#recordBeat`
   * returned true whenever `last` had moved, and `last` moves for every silent
   * player every three and a bit beats, because that is what winding an election
   * forward is — so a tap that achieved nothing fanned the whole rope out to the
   * console, the big screen and the tapper. And the ack was a flat `applied:
   * true` for every tap the round accepted, so a tap SPEC.md says achieves
   * nothing told the phone it had achieved something.
   *
   * Three taps, and the point of the scenario is that the *three engine answers
   * are three different answers*:
   *
   * | the tap | applied | a frame |
   * | --- | --- | --- |
   * | off the beat, already on a side | no | no |
   * | off the beat, and dealt a side by it | yes | no |
   * | off the beat, and an election wound forward | yes | no |
   *
   * A mock that acked everything `true` fails the first, one that acked
   * everything `false` fails the second and third, and one that broadcast
   * whenever something moved fails the frame count on the second and third. The
   * pairing is the test.
   *
   * Which side each player is on is **not** compared and cannot be: the mock
   * draws its own seed for the deal, exactly as the real boundary does, so the
   * two rooms are pulling two different ropes. What is compared is who has been
   * dealt in — and that comparison is made after a frame the room was going to
   * get anyway, because a state the room has not been sent is not a state the
   * harness can read off a frame.
   *
   * The instants are half a beat off — 100 bpm is a beat every 600 ms and the
   * window is ±120 — and that they are is asserted rather than assumed: if the
   * arithmetic ever drifted onto a beat, `onBeats` would move and the table
   * above would stop being three different answers.
   */
  it("acks what moved, sends a frame only for what was credited, as the reducer does", async (t) => {
    const pair = roundPair("tug_of_raft");
    const r = await room(t, 6);
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    // `Room.cmd` delivers its frame at `Date.now()` and then ticks two
    // milliseconds, so the pull started two milliseconds ago. Every instant below
    // is measured from here, which is the only way this scenario can know where
    // in the beat grid its taps land — `#recordBeat` judges a tap by the mock's
    // own clock, and the mock's clock is the page's plus a fixed skew.
    const began = Date.now() - 2;
    const round = r.host.state().arcade?.roundIndex ?? -1;

    let engine = engineRoom(6, [
      { type: "startRound", round: "tug_of_raft", config: pair.config },
      { type: "beginPlay" },
    ]);

    const late = r.join("Player 7");
    engine = replay(engine, [
      { event: { type: "join", pid: "p7", nickname: "Player 7" }, at: T0 + 100 },
    ]);

    const tugSidesOf = (
      state: RenderState,
    ): Readonly<Record<string, number>> | undefined => state.arcade?.tug?.sides;
    assert.ok(
      tugSidesOf(engineView(engine)) !== undefined,
      "the engine puts no sides on the console's frame, so nothing below is a claim",
    );
    assert.ok(
      !("p7" in (tugSidesOf(engineView(engine)) ?? {})),
      "the engine dealt the latecomer in before they tapped",
    );

    /**
     * One tap, on both sides, compared: what the engine applied, what it sent,
     * and what the mock acked and sent for the same tap in the same place in the
     * beat grid. The mock's instant comes from holding its clock; the engine's is
     * `T0 + elapsed`, because every event in {@link engineRoom} is stamped at
     * `T0` and so its `pullStartedAt` is `T0`. The two clocks are never compared.
     */
    const tapAt = (
      wire: Wire,
      pid: string,
      elapsed: number,
      cid: string,
      where: string,
    ): void => {
      const wanted = began + elapsed - Date.now();
      assert.ok(wanted > 0, `the pull is already past ${elapsed} ms: ${where}`);
      r.advance(wanted);
      const at = T0 + elapsed;
      const real = reduce(engine, { type: "tapBeat", pid, at }, at);
      engine = real.state;
      const frames = stateFrames(r.host);
      wire.send({ t: "arcade.beat", cid, round });
      assert.deepEqual(
        answerTo(wire, cid),
        { kind: "ack", applied: real.applied },
        `what the tap was acked with: ${where}`,
      );
      assert.equal(
        stateFrames(r.host) - frames,
        real.effects.filter((e) => e.kind === "broadcast" && e.to === "host").length,
        `how many frames the console was sent: ${where}`,
      );
    };

    const p1 = r.phones[0];
    assert.ok(p1 !== undefined);

    // Row one: off the beat, already on a side. The engine's own answer is that
    // nothing happened at all.
    const nothing = reduce(engine, { type: "tapBeat", pid: "p1", at: T0 + 300 }, T0 + 300);
    assert.equal(nothing.applied, false, "the engine credited an off-beat tap");
    assert.deepEqual(nothing.effects, [], "the engine sent something for it too");
    tapAt(p1, "p1", 300, "off-p1", "off the beat, already dealt in");

    // Row two: the same tap by the latecomer, which deals them a side. Applied,
    // and still nothing on the wire.
    const dealing = reduce(engine, { type: "tapBeat", pid: "p7", at: T0 + 400 }, T0 + 400);
    assert.equal(dealing.applied, true, "the engine did not deal the latecomer a side");
    assert.deepEqual(
      dealing.effects,
      [],
      "the engine broadcasts a late-dealt side after all, so this row has changed",
    );
    tapAt(late, "p7", 400, "deal-p7", "off the beat, and dealt a side");

    // Row three: a tap far enough into the pull that the election this player
    // called has finished, so `lastBeat` winds forward. Applied, and still
    // nothing on the wire — this is the one the mock fanned the rope out for.
    const wound = reduce(engine, { type: "tapBeat", pid: "p1", at: T0 + 4_000 }, T0 + 4_000);
    assert.equal(
      wound.applied,
      true,
      "nothing moved, so the election did not wind forward and row three is row one",
    );
    assert.deepEqual(
      wound.effects,
      [],
      "the engine sends a frame for an election winding forward",
    );
    tapAt(p1, "p1", 4_000, "wound-p1", "off the beat, with an election wound forward");

    // Nothing was credited by any of the three, which is what makes them the
    // same tap three times: the only differences are what moved underneath.
    const onBeats = (state: RenderState): Readonly<Record<string, number>> =>
      state.arcade?.tug?.onBeats ?? {};
    assert.deepEqual(
      onBeats(engineView(engine)),
      {},
      "the engine credited a beat, so one of the three was on the beat after all",
    );

    // And the side really was dealt, on both. Read after a frame the room was
    // going to get anyway: a state nobody has been sent is not a state that can
    // be read off a frame, which is the whole of row two's point.
    r.cmd({ name: "holding", title: "Rope", line: "Pull" });
    engine = replay(engine, [
      {
        event: { type: "setHolding", holding: { title: "Rope", line: "Pull" } },
        at: T0 + 5_000,
      },
    ]);
    const real = Object.keys(tugSidesOf(engineView(engine)) ?? {}).sort();
    assert.deepEqual(
      real,
      ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
      "the engine's own deal after the late tap",
    );
    assert.deepEqual(
      Object.keys(tugSidesOf(r.host.state()) ?? {}).sort(),
      real,
      "who the console has been told is on a side",
    );
    assert.deepEqual(
      onBeats(r.host.state()),
      onBeats(engineView(engine)),
      "the two ropes were pulled different distances",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #27 (k), the fifth of five — the same tin, twice                    */
/* ------------------------------------------------------------------ */

describe("picking the tin you are already holding changes nothing", () => {
  /**
   * The fifth command in (k)'s list, and the only one of the five a *phone*
   * sends. `pickShape` in reducer.ts ends on `if (play.pick[event.pid] === at)
   * return unchanged()`, and the reachable case is the round card: picking is
   * free while the tin is closed — "change your mind freely while the tin is
   * still closed, and not once it is open" — so tapping the same shape twice is
   * an ordinary thing to do with a picker in front of you. Once the Floor is
   * open `already_picked` has the second tap first.
   *
   * What the missing check cost is a repaint the room can see. The big screen
   * counts the four shapes — "four tiles filling up is the round card's whole
   * animation" — and every phone in the room is tapping at that card, so a
   * re-pick that moved nothing still fanned the count out to everybody.
   *
   * Three taps: the pick, the same pick again, and a different shape, which is
   * what stops this passing against an implementation that acked every re-pick
   * as nothing. The engine answers those three differently — applied, not
   * applied, applied — and the frames follow the answers.
   */
  it("acks a repeated pick as nothing and sends the room no frame for it", async (t) => {
    const pair = roundPair("unseal");
    const r = await room(t, 6);
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    // The round card, not the Floor: a re-pick is only allowed here, and this is
    // where the four tiles are being watched.
    assert.equal(r.host.state().arcade?.phase, "card", "the round card is not up");

    let engine = engineRoom(6, [
      { type: "startRound", round: "unseal", config: pair.config },
    ]);
    const phone = r.phones[0];
    assert.ok(phone !== undefined);

    let picks = 0;
    /** One pick, on both sides: the answer, and the frames the room was sent. */
    const pick = (shape: UnsealShape, where: string): void => {
      picks += 1;
      const cid = `pick-${picks}`;
      const real = reduce(engine, { type: "pickShape", pid: "p1", shape }, T0);
      engine = real.state;
      const before = stateFrames(r.screen);
      phone.send({ t: "arcade.shape", cid, round: 0, shape });
      assert.deepEqual(
        answerTo(phone, cid),
        { kind: "ack", applied: real.applied },
        `what the pick was acked with: ${where}`,
      );
      assert.equal(
        stateFrames(r.screen) - before > 0,
        real.effects.some((e) => e.kind === "broadcast" && e.to === "screen"),
        `whether the big screen was repainted: ${where}`,
      );
    };

    // The engine's own three answers, printed before the walk, because the walk
    // is only a test if they are not all the same answer.
    const first = reduce(engine, { type: "pickShape", pid: "p1", shape: "circle" }, T0);
    assert.equal(first.applied, true, "the engine refused a pick against the card");
    const repeat = reduce(
      first.state,
      { type: "pickShape", pid: "p1", shape: "circle" },
      T0,
    );
    assert.equal(
      repeat.applied,
      false,
      "the engine applies a repeated pick, so this row has changed",
    );
    assert.deepEqual(
      repeat.effects,
      [],
      "the engine repaints the room for a pick that moved nothing",
    );
    const changed = reduce(
      repeat.state,
      { type: "pickShape", pid: "p1", shape: "star" },
      T0,
    );
    assert.equal(changed.applied, true, "the engine refused a change of mind");

    pick("circle", "the first pick");
    pick("circle", "the same shape again");
    pick("star", "a change of mind");

    // And both rooms are counting the same tin. `ArcadeUnsealView.shapes` is the
    // count the card animates, and the pick itself — which tin — is on neither
    // wire, so the count is the whole of what can be compared.
    const shapes = (state: RenderState): unknown =>
      (state.arcade?.unseal?.shapes ?? []).map((s) => [s.shape, s.picked]);
    assert.deepEqual(
      shapes(engineScreen(engine)),
      shapes(r.screen.state()),
      "the big screen is counting a different set of tins",
    );
  });
});

describe("a waiting wave stops being able to bet the moment it walks on", () => {
  /**
   * The half of (d)'s first gate that a Plan / Apply round cannot reach, and the
   * reason the gate had to become the reducer's predicate rather than a
   * convenient stand-in for it.
   *
   * `backPlayer` asks `standing[pid] !== "drained" && !waiting`. `#arcadeBack`
   * asked `!held && !waiting` — "have you no Lounge seat" — and the two agree
   * everywhere except for the one player who has a seat *without* a drain: a
   * Glass Bridge wave that is waiting its turn and has bet on the wave in front
   * of it. `drain()` is what ordinarily creates a seat, so on every other Floor
   * "has a seat" and "is drained" are the same sentence; here they are not.
   *
   * Then their own wave walks on. They are on the bridge now, `waiting` goes
   * false, and the reducer tells them so — "You are on the Floor. Play." — while
   * this file let them past the gate on the strength of the seat they are still
   * sitting in, to be refused further down by whichever wave rule happened to
   * catch them. A different code and a different sentence, for the player in the
   * round who is most likely to press the button: they have just spent a whole
   * wave with nothing to do but press it.
   *
   * The waves are read off the phones' own frames rather than worked out here.
   * `ArcadeMineGlass.wave` is "theirs for the round, from their player number",
   * and a scenario that computed it would be a second copy of `waveOf` in the
   * test file.
   */
  it("refuses a second bet from a wave that is now crossing, as the reducer does", async (t) => {
    const pair = roundPair("glass_bridge");
    const r = await room(t, 6);
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });
    let engine = engineRoom(6, [
      { type: "startRound", round: "glass_bridge", config: pair.config },
      { type: "beginPlay" },
    ]);

    /** Somebody in a given wave, as their own phone has been told it. */
    const inWave = (wave: number): { wire: Wire; pid: string } => {
      const at = r.phones.findIndex(
        (w) => w.state().arcadeMine?.glass?.wave === wave,
      );
      assert.ok(at >= 0, `nobody is in wave ${wave}`);
      const wire = r.phones[at];
      assert.ok(wire !== undefined);
      return { wire, pid: `p${at + 1}` };
    };
    const runner = inWave(1);
    const watcher = inWave(2);
    const later = inWave(3);
    // The engine cut the same waves, which is what makes the pids below mean the
    // same thing on both sides. The cuts are on the big screen for the room to
    // read, so they are on the frame to be compared.
    assert.deepEqual(
      r.host.state().arcade?.glass?.waveCuts,
      engineView(engine).arcade?.glass?.waveCuts,
      "the two bridges cut their waves differently",
    );

    // The bet a waiting wave is allowed: on the wave crossing now, before
    // anybody in it has stood on a pane.
    const allowed = engineAnswer(
      engine,
      { type: "backPlayer", pid: watcher.pid, backing: runner.pid },
      T0 + 1_000,
    );
    assert.deepEqual(
      allowed.answer,
      { kind: "ack", applied: true },
      "the engine refuses a waiting wave's bet, so the seat below is never taken",
    );
    watcher.wire.send({ t: "arcade.back", cid: "wait-bet", pid: runner.pid });
    assert.deepEqual(
      answerTo(watcher.wire, "wait-bet"),
      allowed.answer,
      "a waiting wave's bet",
    );
    engine = allowed.next;
    // They are sitting in a seat and they are not drained, which is the whole
    // premise: on any other Floor those two are the same sentence.
    assert.equal(
      engineView(engine).hostExtras?.arcade?.backing?.[watcher.pid],
      runner.pid,
      "the engine did not seat the waiting better",
    );
    assert.equal(
      (engineView(engine).arcade?.grid ?? []).find((c) => c.pid === watcher.pid)
        ?.standing,
      "floor",
      "the waiting better was drained, so they are an ordinary Lounge case",
    );

    // Their own wave walks on.
    r.cmd({ name: "arcade.nextWave" });
    engine = replay(engine, [{ event: { type: "nextWave" }, at: T0 + 2_000 }]);
    assert.equal(
      engineView(engine).arcade?.glass?.wave,
      2,
      "the engine's bridge did not send the second wave",
    );
    assert.equal(
      r.host.state().arcade?.glass?.wave,
      engineView(engine).arcade?.glass?.wave,
      "the two bridges are on different waves",
    );

    // And now they are playing, not watching.
    const refused = engineAnswer(
      engine,
      { type: "backPlayer", pid: watcher.pid, backing: later.pid },
      T0 + 3_000,
    );
    assert.deepEqual(
      refused.answer,
      {
        kind: "refused",
        code: "not_in_the_lounge",
        message: "You are on the Floor. Play.",
      },
      "the engine's own answer once the better's wave is crossing",
    );
    watcher.wire.send({ t: "arcade.back", cid: "crossing-bet", pid: later.pid });
    assert.deepEqual(
      answerTo(watcher.wire, "crossing-bet"),
      refused.answer,
      "a second bet from a wave that is now on the bridge",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #27 (b) — the Floor's clock, on a tap, a letter and a bet            */
/* ------------------------------------------------------------------ */

describe("a press that arrives after the Floor's clock is refused by the clock", () => {
  /**
   * (b), and the reason it sat unwatched for a release.
   *
   * The three guards are one sentence each — `endsAt !== null && now >= endsAt`,
   * in `#arcadeTap`, in `#arcadeUnseal` and in `#arcadeBack` — and they were
   * written, read, and then argued to be unreachable. The argument was written
   * down twice, in this file's header and in the comment above the tap guard, and
   * it was wrong in a way worth recording, because it is the argument anybody
   * would make: `node:test`'s timers fire at their exact deadline, so there is no
   * moment at which the round is still `running` and its own clock has already
   * passed, so nothing can ever be refused by the clock rather than by the phase.
   *
   * That is not how the fake clock works. `tick(n)` advances `Date.now()` to the
   * **end** of the tick and *then* runs every timer that came due inside it, in
   * `runAt` order. A callback never sees its own deadline; it sees the tick's
   * end. So a frame queued at `endsAt − 537` and a Floor timer armed for `endsAt`
   * both come due inside one `tick(1_000)`, the frame runs first because its
   * `runAt` is earlier — and it runs with `#now()` already at `endsAt + 463`,
   * with `arcadePhase` still `running` because the timer that clears it has not
   * had its turn. That is the window, exactly, and it is a third of a second
   * wide on the cheapest clock this file has.
   *
   * What hid it was an ordering, not a clock. The original probe ticked *past*
   * `endsAt` and only then sent, which is a frame arriving at an `idle` round and
   * can only ever answer `wrong_round_phase`. Sending first and ticking second
   * always reaches the window. {@link Wire.send} cannot do it — it is
   * `transport.send(msg)` followed by `tick(2)`, and those two milliseconds land
   * the frame long before the deadline — so these scenarios reach past it to
   * `transport.send` and spend the tick themselves. That is the only place in
   * this file that does, and it is why.
   *
   * Which is also the proof that the window was entered rather than merely
   * stepped over: every one of these three presses has a *different* refusal
   * waiting for it one line up. A tap at an ended round is `wrong_round_phase` /
   * "Nothing to tap."; a bet at one is "The Lounge is not open." So each
   * scenario presses twice — once inside the window, once after the round has
   * gone `idle` — and the two answers are not the same answer. A scenario that
   * had missed the window would collect the second answer where it expects the
   * first.
   */

  /**
   * How far before `endsAt` the frame is queued, and the tick that carries it.
   *
   * `LEAD` has to be more than zero and less than `SPAN`, and is otherwise
   * arbitrary: it is the gap between the frame's `runAt` and the Floor timer's,
   * which is what puts the frame first inside the tick. `SPAN` has to be one
   * tick that spans the deadline, and 1 000 is what {@link Room.advance} spends
   * per tick anyway. Their difference — 463 ms — is how late the mock's `#now()`
   * is when the frame is finally read, and the engine side below is asked the
   * same question at the same offset past its own `endsAt`.
   */
  const LEAD = 537;
  const SPAN = 1_000;

  /**
   * The mock's clock, in the test's own units.
   *
   * `SERVER_SKEW_MS` puts the mock 1.2 seconds ahead of the browser on purpose —
   * deliberate difference 5 — so `endsAt` on the frame is not a number
   * `Date.now()` here can be subtracted from. The offset is measured rather than
   * imported: `#beginPlay` stamps `startedAt` at the instant the `arcade.begin`
   * frame was delivered, and {@link Room.cmd} ticks nothing after that delivery,
   * so the difference between the stamp and `Date.now()` at this point *is* the
   * offset. Called immediately after `arcade.begin` and never again.
   */
  function mockClock(r: Room): () => number {
    const startedAt = r.host.state().arcade?.startedAt;
    assert.ok(typeof startedAt === "number", "the round carries no startedAt");
    const skew = startedAt - Date.now();
    return () => Date.now() + skew;
  }

  /**
   * Hold the room to `LEAD` ms short of the Floor's clock, queue whatever
   * `press` queues without letting it arrive, and then spend one tick across the
   * deadline.
   *
   * Returns how far past `endsAt` the queued frames were read, so the engine can
   * be asked about the same instant. The assertions in here are the scenario's
   * premise rather than its claim: if the room is not still `running` at
   * `endsAt − LEAD`, or the tick did not end the round, then the window was
   * never open and everything after this is measuring something else.
   */
  function acrossTheDeadline(r: Room, now: () => number, press: () => void): number {
    const endsAt = r.host.state().arcade?.endsAt;
    assert.ok(typeof endsAt === "number", "the round carries no endsAt");
    const wait = endsAt - now() - LEAD;
    assert.ok(
      wait > 0,
      `the Floor's clock is ${endsAt - now()} ms away, which is inside the lead`,
    );
    r.advance(wait);
    assert.equal(endsAt - now(), LEAD, "the room did not stop where it was asked to");
    assert.equal(
      r.host.state().arcade?.phase,
      "running",
      "the round ended before the frame was even queued",
    );
    press();
    // The tick that does all the work: `Date.now()` goes to `endsAt + 463`
    // first, then the queued frames run, then the Floor timer runs and ends the
    // round underneath them.
    r.advance(SPAN);
    assert.equal(
      r.host.state().arcade?.phase,
      "idle",
      "the Floor timer did not end the round, so the frames arrived at a live " +
        "round and the clock was never the thing refusing them",
    );
    // The refusals themselves are `#send`, which is one more `#later`, so they
    // are on the wire and not yet delivered.
    r.settle();
    return SPAN - LEAD;
  }

  /**
   * The tap guard, which is the one (b) is named for.
   *
   * Target four and three seconds: the target because the crossing has to be
   * four taps rather than a hundred and twenty, the three seconds because the
   * Floor's own clock is the clock being run out and ninety of them is a long
   * time to tick through at one second a tick. Plan / Apply is one of the three
   * rounds `#armFloorTimer` does arm for, which is what makes the tick that ends
   * the round a tick this scenario can aim a frame at.
   *
   * Paired with a tap that is plainly in time, because a mock that refused every
   * tap would pass the late half on its own, and with a tap at the round that
   * has now ended, because that is the answer a scenario which missed the window
   * would have collected.
   */
  it("refuses a tap that arrived on the tick that ended the round, as the reducer does", async (t) => {
    const cmd = {
      name: "arcade.round",
      kind: "plan_apply",
      target: 4,
      seconds: 3,
    } as const;
    const config: ArcadeRoundConfig = { kind: "plan_apply", target: 4, seconds: 3 };

    const r = await room(t, 3);
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(cmd);
    r.cmd({ name: "arcade.begin" });
    const round = r.host.state().arcade?.roundIndex ?? -1;
    const now = mockClock(r);
    const runner = r.phones[0];
    assert.ok(runner !== undefined, "the room has no phones");

    let engine = engineRoom(3, [
      { type: "startRound", round: "plan_apply", config },
      { type: "beginPlay" },
    ]);
    const engineEndsAt = engineView(engine).arcade?.endsAt;
    assert.ok(typeof engineEndsAt === "number", "the engine's Floor has no clock");
    // The two clocks are on different epochs and are never compared. Their
    // *lengths* are the same number and have to be, because the instants below
    // are offsets from each side's own `endsAt` and mean the same thing only if
    // the two Floors are open for the same three seconds.
    assert.equal(
      (r.host.state().arcade?.endsAt ?? 0) - (r.host.state().arcade?.startedAt ?? 0),
      engineEndsAt - T0,
      "the two Floors are open for different lengths of time",
    );

    // A tap in time. The light is green — `#beginPlay` draws `2_000 +
    // random(4_000)` for the first PLAN, so the first instant of the round is
    // inside it whatever it drew — which matters because a tap into the APPLY
    // light drains, and a drained player is refused `not_on_the_floor` a line
    // *above* the guard this scenario is about.
    assert.equal(
      r.host.state().arcade?.planApply?.light,
      "plan",
      "the round opened on the APPLY light, so a tap now would drain the runner",
    );
    const early = engineAnswer(engine, { type: "tap", pid: "p1", at: T0 + 10 }, T0 + 10);
    assert.deepEqual(
      early.answer,
      { kind: "ack", applied: true },
      "the engine refuses a tap inside its own clock, so this is not a pairing",
    );
    runner.send({ t: "arcade.tap", cid: "early-tap", round });
    assert.deepEqual(
      answerTo(runner, "early-tap"),
      early.answer,
      "a tap well inside the Floor's clock",
    );
    engine = early.next;
    const struck = (state: RenderState): readonly string[] =>
      (state.arcade?.grid ?? []).filter((c) => c.struck).map((c) => c.pid);
    assert.deepEqual(struck(engineView(engine)), [], "the engine drained the runner");
    assert.deepEqual(
      struck(r.host.state()),
      [],
      "the mock drained the runner, so the late tap below is refused for standing",
    );

    // And the same tap, queued before the deadline and read after it.
    const late = (at: number): Answer =>
      engineAnswer(engine, { type: "tap", pid: "p1", at }, at).answer;
    const skew = acrossTheDeadline(r, now, () => {
      runner.transport.send({ t: "arcade.tap", cid: "late-tap", round });
    });
    const refused = late(engineEndsAt + skew);
    assert.deepEqual(
      refused,
      {
        kind: "refused",
        code: "floor_locked",
        message: "The Floor is closed.",
      },
      "the engine's own answer to a tap past its Floor's clock",
    );
    assert.deepEqual(
      answerTo(runner, "late-tap"),
      refused,
      "a tap that arrived on the tick that ended the round",
    );

    // The other refusal, one line up, and the reason the one above is evidence:
    // the round is `idle` now, and an `idle` round answers a tap differently. A
    // scenario that had ticked past `endsAt` before sending — which is what the
    // probe that declared this unreachable did — would have got this answer
    // where it expected the one above.
    engine = replay(engine, [{ event: { type: "endRound" }, at: engineEndsAt }]);
    const ended = late(engineEndsAt + 5_000);
    assert.deepEqual(
      ended,
      {
        kind: "refused",
        code: "wrong_round_phase",
        message: "Nothing to tap.",
      },
      "the engine answers an ended round the same way it answers a locked Floor",
    );
    runner.send({ t: "arcade.tap", cid: "ended-tap", round });
    assert.deepEqual(
      answerTo(runner, "ended-tap"),
      ended,
      "a tap at a round that has finished",
    );
  });

  /**
   * The other two, in one round and on one tick.
   *
   * Unseal arms a Floor timer for the same reason Plan / Apply does, and it is
   * the one round that holds both of the remaining guards within reach at once:
   * a tin being tapped open is a `#arcadeUnseal` letter, and a shattered tin is a
   * Lounge seat without a clock — two wrong letters and no waiting. So both
   * frames are queued on the same tick and both are read past the same `endsAt`.
   *
   * Three roles: p1 has a tin and is tapping it open, p3 shatters theirs and
   * bets from the Lounge, and p2 is on the Floor and never touched — they are
   * who the late bet names, because `#arcadeBack` acks a bet on the runner you
   * are already backing as `applied: false` and a late bet naming p1 again would
   * have been answered by that check instead of by the clock.
   *
   * Both halves are paired with the same press made in time, for the reason the
   * tap is: a letter and a bet that were both refused *whatever* the clock said
   * would pass the late half on their own.
   */
  it("refuses a letter and a bet that arrived on that same tick, as the reducer does", async (t) => {
    const cmd = { name: "arcade.round", kind: "unseal", seconds: 3 } as const;
    const config: ArcadeRoundConfig = {
      kind: "unseal",
      items: UNSEAL_ITEMS,
      seconds: 3,
    };

    const r = await room(t, 6);
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(cmd);
    r.cmd({ name: "arcade.begin" });
    const round = r.host.state().arcade?.roundIndex ?? -1;
    const now = mockClock(r);

    let engine = engineRoom(6, [
      { type: "startRound", round: "unseal", config },
      { type: "beginPlay" },
    ]);
    const engineEndsAt = engineView(engine).arcade?.endsAt;
    assert.ok(typeof engineEndsAt === "number", "the engine's Floor has no clock");
    assert.equal(
      (r.host.state().arcade?.endsAt ?? 0) - (r.host.state().arcade?.startedAt ?? 0),
      engineEndsAt - T0,
      "the two Floors are open for different lengths of time",
    );

    const runner = r.phones[0];
    const bystander = r.phones[1];
    const better = r.phones[2];
    assert.ok(runner !== undefined && bystander !== undefined && better !== undefined);

    const shape = (r.host.state().arcade?.unseal?.shapes ?? []).find((s) => s.available)
      ?.shape;
    assert.ok(shape !== undefined, "the round dealt no tins at all");

    /** The word behind a cue, which the cue is an anagram of. */
    const wordFor = (cue: string): string[] => {
      const item = UNSEAL_ITEMS.find((i) => i.cue === cue);
      assert.ok(item !== undefined, `no unseal item has the cue ${cue}`);
      return [...item.answer.toUpperCase()].filter((c) => /\p{L}/u.test(c));
    };
    const cueOn = (wire: Wire): string => {
      const cue = wire.state().arcadeMine?.unseal?.cue;
      assert.ok(typeof cue === "string" && cue !== "", "that phone holds no tin");
      return cue;
    };
    const engineCue = (pid: string, at: number): string | null | undefined =>
      renderStateFor(engine, {
        role: "participant",
        pid,
        lastSeen: new Map([[pid, at]]),
        now: at,
      }).arcadeMine?.unseal?.cue;

    const pick = (wire: Wire, pid: string, at: number): void => {
      wire.send({ t: "arcade.shape", cid: `pick-${pid}`, round, shape });
      engine = replay(engine, [{ event: { type: "pickShape", pid, shape }, at }]);
    };
    pick(runner, "p1", T0 + 10);
    pick(better, "p3", T0 + 10);
    // The two sides deal tins by player number out of the same item list, so the
    // same person is holding the same word. Asserted rather than assumed: if the
    // dealing diverges, every letter below stops meaning the same thing on the
    // two sides and this should say so here.
    assert.equal(engineCue("p1", T0 + 10), cueOn(runner), "p1's tin");
    assert.equal(engineCue("p3", T0 + 10), cueOn(better), "p3's tin");

    // p3 shatters: two wrong letters, drawn from their own tiles because a
    // letter that is not on the tin is a malformed frame rather than a guess.
    const cue3 = cueOn(better);
    const wrong = [...cue3].find((c) => /\p{L}/u.test(c) && c !== wordFor(cue3)[0]);
    assert.ok(wrong !== undefined, "p3's word is one letter repeated");
    for (const n of [0, 1]) {
      better.send({ t: "arcade.letter", cid: `x-${n}`, round, letter: wrong });
      engine = replay(engine, [
        { event: { type: "tapLetter", pid: "p3", letter: wrong }, at: T0 + 20 + n },
      ]);
    }
    const struck = (state: RenderState): readonly string[] =>
      (state.arcade?.grid ?? []).filter((c) => c.struck).map((c) => c.pid);
    assert.deepEqual(
      struck(engineView(engine)),
      ["p3"],
      "the engine did not put p3 in the Lounge, so there is no bet to place",
    );
    assert.deepEqual(struck(r.host.state()), struck(engineView(engine)), "the drains");

    // A letter in time, and a bet in time.
    const word = wordFor(cueOn(runner));
    assert.ok(
      word.length >= 2,
      "p1's word is one letter, so the late letter below would not be the next one",
    );
    const firstLetter = word[0];
    const nextLetter = word[1];
    assert.ok(firstLetter !== undefined && nextLetter !== undefined);

    const earlyLetter = engineAnswer(
      engine,
      { type: "tapLetter", pid: "p1", letter: firstLetter },
      T0 + 40,
    );
    assert.deepEqual(
      earlyLetter.answer,
      { kind: "ack", applied: true },
      "the engine refuses a letter inside its own clock, so this is not a pairing",
    );
    runner.send({ t: "arcade.letter", cid: "early-letter", round, letter: firstLetter });
    assert.deepEqual(
      answerTo(runner, "early-letter"),
      earlyLetter.answer,
      "a letter well inside the Floor's clock",
    );
    engine = earlyLetter.next;

    const earlyBet = engineAnswer(
      engine,
      { type: "backPlayer", pid: "p3", backing: "p1" },
      T0 + 50,
    );
    assert.deepEqual(
      earlyBet.answer,
      { kind: "ack", applied: true },
      "the engine refuses a bet inside its own clock, so this is not a pairing",
    );
    better.send({ t: "arcade.back", cid: "early-bet", pid: "p1" });
    assert.deepEqual(
      answerTo(better, "early-bet"),
      earlyBet.answer,
      "a bet well inside the Floor's clock",
    );
    engine = earlyBet.next;

    // And the same two presses, queued before the deadline and read after it.
    // p1's next letter is a letter they would be *credited* for — progress is
    // one and this is word[1] — and p3's bet names somebody they are not already
    // backing, so with the clock out of the way both of these succeed.
    const skew = acrossTheDeadline(r, now, () => {
      runner.transport.send({
        t: "arcade.letter",
        cid: "late-letter",
        round,
        letter: nextLetter,
      });
      better.transport.send({ t: "arcade.back", cid: "late-bet", pid: "p2" });
    });
    const at = engineEndsAt + skew;

    const lateLetter = engineAnswer(
      engine,
      { type: "tapLetter", pid: "p1", letter: nextLetter },
      at,
    );
    assert.deepEqual(
      lateLetter.answer,
      {
        kind: "refused",
        code: "floor_locked",
        message: "The Floor is closed.",
      },
      "the engine's own answer to a letter past its Floor's clock",
    );
    assert.deepEqual(
      answerTo(runner, "late-letter"),
      lateLetter.answer,
      "a letter that arrived on the tick that ended the round",
    );

    const lateBet = engineAnswer(
      engine,
      { type: "backPlayer", pid: "p3", backing: "p2" },
      at,
    );
    assert.deepEqual(
      lateBet.answer,
      {
        kind: "refused",
        code: "floor_locked",
        message: "The Floor has locked.",
      },
      "the engine's own answer to a bet past its Floor's clock",
    );
    assert.deepEqual(
      answerTo(better, "late-bet"),
      lateBet.answer,
      "a bet that arrived on the tick that ended the round",
    );
    // Two different sentences for the same locked Floor, and both go on glass:
    // the reducer says "closed" to somebody holding a tin and "locked" to
    // somebody in the Lounge. A mock that shared one string between the two
    // guards would pass one of these and fail the other.
    assert.notDeepEqual(
      lateLetter.answer,
      lateBet.answer,
      "the two guards answer with the same sentence, so one of them is unwatched",
    );

    // And the refusal that is waiting one line up, for the reason the tap
    // scenario spells out: an `idle` round refuses a bet in different words, so
    // the answers above are evidence that the window was entered.
    engine = replay(engine, [{ event: { type: "endRound" }, at: engineEndsAt }]);
    const ended = engineAnswer(
      engine,
      { type: "backPlayer", pid: "p3", backing: "p2" },
      engineEndsAt + 5_000,
    );
    assert.deepEqual(
      ended.answer,
      {
        kind: "refused",
        code: "wrong_round_phase",
        message: "The Lounge is not open.",
      },
      "the engine answers an ended round the same way it answers a locked Floor",
    );
    better.send({ t: "arcade.back", cid: "ended-bet", pid: "p2" });
    assert.deepEqual(
      answerTo(better, "ended-bet"),
      ended.answer,
      "a bet at a round that has finished",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #29 — the nine the four sweeps missed, and the five confirmed       */
/* ------------------------------------------------------------------ */

/**
 * #29's survey, scenario by scenario.
 *
 * It was written from the source rather than from the issue tracker — three
 * claims in the earlier issues turned out to be false once somebody read the
 * engine — and it found nine divergences the sweeps behind #17, #19, #12, #24,
 * #25 and #27 had all walked past, plus five the previous agent had recorded and
 * left. The first three are things a person watching `?mock=1` would see.
 *
 * Two of its rows are recorded rather than tested, and both are unreachable
 * through this socket rather than merely awkward. They are written down here for
 * the same reason (c) and (o) are above: a difference nobody wrote down is what
 * the issue is about.
 *
 * - **`no_more_questions`'s wording.** `trivia.open` said "That was the last
 *   one." where the reducer says "That was the last question." The two strings
 *   are now the same string, and nothing can reach the branch to prove it:
 *   `question()` indexes the scored set at `at`, `trivia.next` refuses to move
 *   `at` past the end, and a tiebreak restores where it found it. Fixed rather
 *   than listed because the fix is a string and the alternative is a sentence
 *   that would reach a host's glass differently the day the mock grows a loader.
 * - **The streak bonus on a warm-up.** `settleQuestion` in engine/trivia.ts pays
 *   nothing at all for a `basePoints: 0` question, streak bonus included, and
 *   this file paid the bonus regardless. Also now in step, and also unreachable:
 *   the question set is a private constant with no warm-up in it and no command
 *   that loads another, which is deliberate difference 2. The same argument as
 *   the "no trivia loaded" frame, one field along.
 *
 * Everything else the survey found is a scenario below, in the issue's own
 * order of what a person would notice.
 */

/**
 * The mock's own clock, measured through `ping`.
 *
 * `SERVER_SKEW_MS` puts the mock 1.2 seconds ahead of the browser on purpose —
 * deliberate difference 5 — so an instant on a frame is not a number `Date.now()`
 * here can be subtracted from. {@link mockClock} in the last suite measures the
 * offset off a round's `startedAt`, which only exists inside the arcade; this
 * measures it off `pong`, which any surface can ask for at any time.
 *
 * Exact rather than approximate, and the two ticks are why. `Wire.send` is
 * `transport.send(msg)` followed by `tick(2)`, and the mock's delivery is one
 * more zero-millisecond `setTimeout` — so the `pong` is *built* during that
 * tick, at the clock this line then reads, and *delivered* on the next one.
 */
function mockNow(r: Room): () => number {
  r.host.send({ t: "ping", t0: 0 });
  const builtAt = Date.now();
  r.settle();
  const pong = r.host.frames.filter((f) => f.t === "pong").at(-1);
  assert.ok(pong !== undefined && pong.t === "pong", "the mock did not answer a ping");
  const skew = pong.t1 - builtAt;
  return () => Date.now() + skew;
}

/**
 * A send-off the engine can be handed, shaped like one a room would watch.
 *
 * Two photographs and two messages of different lengths, so that stepping moves
 * between slides whose `slideMs` are different numbers, and a closing card so the
 * walk has somewhere to stop. It is not the mock's content and does not try to
 * be — the mock's is a private constant of four long messages — which is why
 * every claim below is about *behaviour* rather than about an instant.
 */
const SENDOFF_CONTENT: SendoffContent = {
  name: "A Leaving Colleague",
  subtitle: null,
  opening: { photos: ["one.jpg", "two.jpg"], seconds: 40, music: null },
  kudos: [
    { from: "A Colleague", message: "Thank you for all of it." },
    {
      from: "Another Colleague",
      message:
        "The desk will not be the same, and neither will the Tuesday review, " +
        "which you ran for three years without once letting it run long.",
    },
  ],
  closing: { photos: [], line: "Don't be a stranger." },
};

/* ------------------------------------------------------------------ */
/* #29.1 — Auto, on the send-off, advancing something                  */
/* ------------------------------------------------------------------ */

describe("the send-off walks itself under Auto, as the runtime's slide timer does", () => {
  /**
   * The headline of #29, and the only row in it that needed machinery rather
   * than a guard.
   *
   * `stepSendoff` had exactly three callers in `mock.ts` — the two host commands
   * and the scripted director — and **there was no timer keyed on `sendoffAuto`
   * anywhere in the file**. The server has one: `#armSlideTimer` in runtime.ts
   * fires `{ type: "sendoffNext" }` at `slideAt + slideMs(...)` and re-arms after
   * every `apply`. So in `?mock=manual` the host pressed Auto, `auto: true` and a
   * live `advanceAt` went on the wire, the console and the Desktop both counted
   * down to zero — and the photograph stayed up for ever. A probe left the mock
   * on `run / index 0 / same photo` with `advanceAt` eighty-four seconds in the
   * past while the runtime under the same presses had reached `closing`.
   *
   * Two near misses are worth naming, because between them they are the reason
   * this survived four sweeps. The #12 scenario above checks that `advanceAt` is
   * *anchored* — that it does not move when nothing about the send-off moved —
   * which is a claim about the projection and is perfectly true of a deadline
   * nothing ever acts on. And deliberate difference 1 in `mock.ts`'s header is
   * about **trivia** Auto, and says "trivia" in as many words.
   *
   * **Why this compares behaviour and not instants.** The same reason #12 does:
   * the two sides are holding different send-offs, `slideMs` scales a slide by
   * its own text, and the clocks are on different epochs. What is the same is
   * what Auto *does* — hold at the title card, hold short of the deadline, step
   * on it, keep stepping, hold when it is switched off, and stop at the closing
   * card. Seven observations, taken the same way on each side, compared as one
   * record.
   *
   * **How the engine is made to spend a clock.** The reducer is pure and holds no
   * timers; the timer lives in runtime.ts. So {@link spendOnTheEngine} runs it:
   * step the clock forward, and whenever the instant `views.ts` publishes as
   * `advanceAt` has arrived, apply `sendoffNext` at exactly that instant. That is
   * `#armSlideTimer`'s rule, read off the projection rather than guessed at —
   * which is the part that matters, because a helper that picked its own
   * deadlines would be comparing the mock against this file's arithmetic.
   */
  interface AutoWalk {
    readonly heldAtTheTitleCard: boolean;
    readonly heldShortOfTheFirstDeadline: boolean;
    readonly steppedOnTheFirstDeadline: boolean;
    readonly heldShortOfTheSecondDeadline: boolean;
    readonly steppedOnTheSecondDeadline: boolean;
    readonly heldOnceAutoWasOff: boolean;
    readonly reachedTheClosingCardUnpressed: boolean;
    readonly heldAtTheClosingCard: boolean;
  }

  /**
   * Which slide is up, as a string two sides can be compared on.
   *
   * `index` alone is not enough: it is the *message* ordinal, so every photograph
   * in the opening montage reports zero. The photo key is what tells two
   * consecutive photographs apart, and `part` is what tells the halves of one
   * long message apart — both of which are single steps of Auto and both of which
   * a scenario that only watched `index` would call "nothing happened".
   */
  function slide(view: RenderState["sendoff"]): string {
    assert.ok(view !== undefined, "no send-off on the frame");
    return `${view.phase}|${view.index}|${view.part}|${view.photo ?? ""}`;
  }

  /** How far short of a deadline the room is held before it is crossed. */
  const SHORT_OF_IT = 500;

  /**
   * The runtime's slide timer, run over the engine.
   *
   * Applies `sendoffNext` at each `advanceAt` that falls at or before `to`, and
   * stops without applying anything past it — so "hold the engine to 500 ms short
   * of its own deadline" and "let the engine cross it" are the same call with two
   * different targets, which is what makes the two halves of the record mean the
   * same thing on both sides.
   */
  function spendOnTheEngine(
    state: SessionState,
    from: number,
    to: number,
  ): SessionState {
    let s = state;
    let t = from;
    for (let steps = 0; steps < 500; steps += 1) {
      const due = engineView(s, t).sendoff?.advanceAt ?? null;
      if (due === null || due > to) return s;
      t = due;
      s = replay(s, [{ event: { type: "sendoffNext" }, at: t }]);
    }
    assert.fail("the engine's send-off never stopped advancing");
  }

  /** Where the engine's slide deadline is, or nothing if it has none. */
  function engineDeadline(state: SessionState, now: number): number | null {
    return engineView(state, now).sendoff?.advanceAt ?? null;
  }

  it("holds, steps, keeps stepping and stops, on both implementations", async (t) => {
    const r = await room(t, 2);
    r.cmd({ name: "start" });
    r.cmd({ name: "segment", kind: "sendoff" });
    // The shortest beat the reducer will accept, so the montage is walked in a
    // hundred fake seconds rather than in four hundred. It is the host's own
    // control and it is clamped identically on both sides.
    r.cmd({ name: "sendoff.speed", seconds: MIN_AUTO_SECONDS });
    // Auto on at the title card, which is where a host turns it on, and — as the
    // #12 scenario records — the only starting point at which a `setSendoffAuto`
    // restamp cannot cover for a step that never stamped an anchor at all.
    r.cmd({ name: "sendoff.auto", auto: true });
    const now = mockNow(r);
    const view = (): RenderState["sendoff"] => r.host.state().sendoff;

    const atTitle = slide(view());
    r.advance(30_000);
    const heldAtTheTitleCard = slide(view()) === atTitle;

    r.cmd({ name: "sendoff.next" });
    const first = view()?.advanceAt ?? null;
    assert.ok(first !== null, "the run started with no deadline on the frame");
    const onSlideOne = slide(view());
    r.advance(first - now() - SHORT_OF_IT);
    const heldShortOfTheFirstDeadline = slide(view()) === onSlideOne;
    r.advance(1_000);
    const steppedOnTheFirstDeadline = slide(view()) !== onSlideOne;

    const second = view()?.advanceAt ?? null;
    assert.ok(second !== null, "the second slide carries no deadline");
    const onSlideTwo = slide(view());
    r.advance(second - now() - SHORT_OF_IT);
    const heldShortOfTheSecondDeadline = slide(view()) === onSlideTwo;
    r.advance(1_000);
    const steppedOnTheSecondDeadline = slide(view()) !== onSlideTwo;

    r.cmd({ name: "sendoff.auto", auto: false });
    const parked = slide(view());
    r.advance(60_000);
    const heldOnceAutoWasOff = slide(view()) === parked;

    // And the whole of the rest of it, unpressed. One second a tick, because a
    // re-arming chain advances one link per tick however long the tick is — see
    // {@link Room.advance} — so the cap is a slide count and not a duration.
    r.cmd({ name: "sendoff.auto", auto: true });
    let ticks = 0;
    while (view()?.phase !== "closing" && ticks < 400) {
      r.advance(1_000);
      ticks += 1;
    }
    const reachedTheClosingCardUnpressed = view()?.phase === "closing";
    const onTheLastCard = slide(view());
    r.advance(60_000);
    const heldAtTheClosingCard = slide(view()) === onTheLastCard;

    const mocked: AutoWalk = {
      heldAtTheTitleCard,
      heldShortOfTheFirstDeadline,
      steppedOnTheFirstDeadline,
      heldShortOfTheSecondDeadline,
      steppedOnTheSecondDeadline,
      heldOnceAutoWasOff,
      reachedTheClosingCardUnpressed,
      heldAtTheClosingCard,
    };

    /* The same eight moments, on the engine and its own runtime's rule. */
    let engine = engineRoom(2, [
      { type: "loadSendoff", content: SENDOFF_CONTENT, seed: 1 },
      { type: "setSegment", segment: "sendoff" },
      { type: "setSendoffSpeed", seconds: MIN_AUTO_SECONDS },
      { type: "setSendoffAuto", auto: true },
    ]);
    let at = T0;
    const realView = (): RenderState["sendoff"] => engineView(engine, at).sendoff;

    const realAtTitle = slide(realView());
    engine = spendOnTheEngine(engine, at, at + 30_000);
    at += 30_000;
    const realHeldAtTheTitleCard = slide(realView()) === realAtTitle;

    engine = replay(engine, [{ event: { type: "sendoffNext" }, at }]);
    const realFirst = engineDeadline(engine, at);
    assert.ok(realFirst !== null, "the engine's run started with no deadline");
    const realOnSlideOne = slide(realView());
    engine = spendOnTheEngine(engine, at, realFirst - SHORT_OF_IT);
    at = realFirst - SHORT_OF_IT;
    const realHeldShortOfTheFirst = slide(realView()) === realOnSlideOne;
    engine = spendOnTheEngine(engine, at, realFirst);
    at = realFirst;
    const realSteppedOnTheFirst = slide(realView()) !== realOnSlideOne;

    const realSecond = engineDeadline(engine, at);
    assert.ok(realSecond !== null, "the engine's second slide carries no deadline");
    const realOnSlideTwo = slide(realView());
    engine = spendOnTheEngine(engine, at, realSecond - SHORT_OF_IT);
    at = realSecond - SHORT_OF_IT;
    const realHeldShortOfTheSecond = slide(realView()) === realOnSlideTwo;
    engine = spendOnTheEngine(engine, at, realSecond);
    at = realSecond;
    const realSteppedOnTheSecond = slide(realView()) !== realOnSlideTwo;

    engine = replay(engine, [{ event: { type: "setSendoffAuto", auto: false }, at }]);
    const realParked = slide(realView());
    engine = spendOnTheEngine(engine, at, at + 60_000);
    at += 60_000;
    const realHeldOnceAutoWasOff = slide(realView()) === realParked;

    engine = replay(engine, [{ event: { type: "setSendoffAuto", auto: true }, at }]);
    engine = spendOnTheEngine(engine, at, at + 3_600_000);
    at += 3_600_000;
    const realReachedTheClosingCard = realView()?.phase === "closing";
    const realOnTheLastCard = slide(realView());
    engine = spendOnTheEngine(engine, at, at + 60_000);
    at += 60_000;
    const realHeldAtTheClosingCard = slide(realView()) === realOnTheLastCard;

    const real: AutoWalk = {
      heldAtTheTitleCard: realHeldAtTheTitleCard,
      heldShortOfTheFirstDeadline: realHeldShortOfTheFirst,
      steppedOnTheFirstDeadline: realSteppedOnTheFirst,
      heldShortOfTheSecondDeadline: realHeldShortOfTheSecond,
      steppedOnTheSecondDeadline: realSteppedOnTheSecond,
      heldOnceAutoWasOff: realHeldOnceAutoWasOff,
      reachedTheClosingCardUnpressed: realReachedTheClosingCard,
      heldAtTheClosingCard: realHeldAtTheClosingCard,
    };

    // The engine's own record, spelled out, because it is the claim and not the
    // baseline: a walk that never moved would satisfy four of these eight for
    // free, and those four are exactly the ones the old mock passed.
    assert.deepEqual(
      real,
      {
        heldAtTheTitleCard: true,
        heldShortOfTheFirstDeadline: true,
        steppedOnTheFirstDeadline: true,
        heldShortOfTheSecondDeadline: true,
        steppedOnTheSecondDeadline: true,
        heldOnceAutoWasOff: true,
        reachedTheClosingCardUnpressed: true,
        heldAtTheClosingCard: true,
      },
      "the engine's own behaviour under its runtime's slide timer",
    );
    assert.deepEqual(mocked, real);
  });
});

/* ------------------------------------------------------------------ */
/* #29.3 — what "Clear the card" leaves behind                         */
/* ------------------------------------------------------------------ */

describe("clearing the holding card leaves the card the server leaves", () => {
  /**
   * The console's Clear sends `{ name: "holding", title: "", line: "" }`.
   * `main.ts` turns that into `setHolding` with `{ title: "", line: "" }`,
   * protocol.ts's parser accepts empty strings on purpose, and the reducer stores
   * the card **non-null**. This file mapped both fields empty to `holding: null`.
   *
   * Which is a different big screen, not a different representation. The Desktop
   * draws `state.holding?.title ?? state.title`, so `null` puts the **session
   * title** up — "Divergence", or whatever the afternoon is called — where a real
   * session goes blank. The one field on the holding panel whose whole job is to
   * be empty was the one that showed something in the demo.
   *
   * `null` is still reachable and still means "no card": it is where a session
   * starts and where `restart` puts it back. There is simply no console command
   * that returns to it, which is the reducer's position too — so the scenario
   * checks the start, the write, the clear, and that the clear is *not* the start.
   */
  it("stores an empty card rather than no card, as the reducer does", async (t) => {
    const r = await room(t, 2);
    r.cmd({ name: "start" });
    let engine = engineRoom(2);

    // Where a session begins: no card at all, on both sides.
    assert.equal(engineView(engine).holding, null, "the engine started with a card");
    assert.equal(r.screen.state().holding, engineView(engine).holding, "at the start");

    const filled = { title: "Back at 14:20", line: "Prize: the good coffee." };
    r.cmd({ name: "holding", ...filled });
    engine = replay(engine, [
      { event: { type: "setHolding", holding: filled }, at: T0 + 1_000 },
    ]);
    assert.deepEqual(
      r.screen.state().holding,
      engineView(engine).holding,
      "the card the host typed",
    );

    r.cmd({ name: "holding", title: "", line: "" });
    engine = replay(engine, [
      {
        event: { type: "setHolding", holding: { title: "", line: "" } },
        at: T0 + 2_000,
      },
    ]);
    const cleared = engineView(engine).holding;
    // The engine's own answer, and the whole of the divergence: a card, with
    // nothing in it. Without this line the comparison below would be just as
    // happy with two implementations that both cleared to `null`.
    assert.deepEqual(
      cleared,
      { title: "", line: "" },
      "the engine cleared to no card at all, so this claim has moved",
    );
    assert.deepEqual(
      r.screen.state().holding,
      cleared,
      "the card the big screen is left drawing after a Clear",
    );
    // And what the Desktop actually paints, which is the thing a room sees.
    const painted = (state: RenderState): string => state.holding?.title ?? state.title;
    assert.equal(painted(r.screen.state()), "", "the demo put a title on the big screen");
    assert.equal(painted(r.screen.state()), painted(engineScreen(engine)));

    // A second Clear is a no-op on both sides, which is `setHolding`'s own
    // field-by-field comparison: the console sends the whole card on every
    // keystroke of the editor and an unchanged one must not fan out.
    const again = engineAnswer(engine, {
      type: "setHolding",
      holding: { title: "", line: "" },
    });
    assert.deepEqual(again.answer, { kind: "ack", applied: false }, "the engine's repeat");
    assert.deepEqual(r.attempt({ name: "holding", title: "", line: "" }), again.answer);
  });
});

/* ------------------------------------------------------------------ */
/* #29.4 — a closed session is frozen                                  */
/* ------------------------------------------------------------------ */

describe("a closed session refuses every press the reducer refuses", () => {
  /**
   * The reducer's first act, before its switch: once `phase === "closed"`,
   * everything but `disconnect` / `reconnect` / `close` / `reopen` /
   * `restartSession` is refused `session_closed`. `#hostCmd` had no such gate at
   * all, and a probe pressed six buttons after a Close and was acked
   * `applied: true` on every one — it sealed the scoreboard, typed a score in,
   * shrank the roster and opened a question in a session the engine had frozen.
   *
   * **Reachable from the console, not only from the socket**, which is what makes
   * this the one a host walks into. After Close the segment rail and the primary
   * button are disabled in `host/main.ts` and nothing else is: not the scoring
   * grid, not kick or release, not seal, not practice, not the lobby lock.
   * "Close the session, then tidy the scores" is a reasonable thing to rehearse,
   * and the demo taught that it works.
   *
   * Each press is paired with the engine's answer to the same event *before* the
   * close, which is the non-vacuity line: every one of these is an
   * `applied: true` in a running session, so a mock that refused them for some
   * other reason would fail that half.
   *
   * Six presses until Spot Awards were removed, and the `spot.grant` among them
   * is now a `score.status` — a second scoring command, so the gate is still
   * checked against more than one arm of the switch.
   */
  it("answers six presses after a Close the way the reducer answers them", async (t) => {
    const r = await room(t, 3);
    r.cmd({ name: "start" });
    // A trivia room rather than {@link engineRoom}, because one of the six presses
    // is `trivia.open` and the reducer asks "is a set loaded" before it asks about
    // the phase — so an engine with no questions would refuse it
    // `no_questions_loaded` and the pairing below would be comparing the wrong
    // refusal. The mock's set is a private constant, so the honest way to put the
    // same questions in front of the engine is to read one off the frame.
    const running = engineTriviaRoom(3, [questionFromFrame(r.host.state())]);

    const presses: readonly { cmd: HostCommand; event: Event }[] = [
      {
        cmd: { name: "seal", state: "sealed" },
        event: { type: "setSeal", seal: "sealed" },
      },
      {
        cmd: { name: "score.set", activityId: "trivia", pid: "p1", raw: 11 },
        event: { type: "setScore", activityId: "trivia", pid: "p1", raw: 11 },
      },
      {
        cmd: { name: "score.status", activityId: "trivia", pid: "p1", status: "played" },
        event: { type: "setStatus", activityId: "trivia", pid: "p1", status: "played" },
      },
      { cmd: { name: "participant.kick", pid: "p2" }, event: { type: "kick", pid: "p2" } },
      { cmd: { name: "practice", on: true }, event: { type: "setPractice", on: true } },
      {
        cmd: { name: "trivia.open", suddenDeath: false },
        event: { type: "openQuestion", suddenDeath: false },
      },
    ];

    // Every one of the six is a press a running session accepts. Taken off the
    // engine rather than asserted here, so the day one of them stops being
    // allowed this line says so instead of quietly passing.
    for (const press of presses) {
      assert.deepEqual(
        engineAnswer(running, press.event).answer,
        { kind: "ack", applied: true },
        `the engine refuses ${press.cmd.name} in a running session, so its row has moved`,
      );
    }

    r.cmd({ name: "close" });
    const closed = engineAnswer(running, { type: "close" }).next;
    assert.equal(engineView(closed).phase, "closed", "the engine did not close");

    for (const press of presses) {
      const real = engineAnswer(closed, press.event);
      assert.deepEqual(
        real.answer,
        {
          kind: "refused",
          code: "session_closed",
          message: "The session is closed.",
        },
        `the engine's answer to ${press.cmd.name} in a closed session`,
      );
      assert.deepEqual(r.attempt(press.cmd), real.answer, `${press.cmd.name}, after a Close`);
    }

    // And nothing moved, which is the half the `applied` flag cannot show. Four
    // projections the six presses would each have changed.
    assert.equal(r.host.state().seal, engineView(closed).seal, "the seal");
    assert.equal(r.host.state().practice, engineView(closed).practice, "practice");
    assert.deepEqual(triviaGrid(r.host.state()), triviaGrid(engineView(closed)), "the grid");
    assert.deepEqual(
      r.host.state().roster.map((p) => p.pid),
      engineView(closed).roster.map((p) => p.pid),
      "the roster",
    );
    assert.equal(
      r.host.state().trivia?.phase,
      engineView(closed).trivia?.phase,
      "the question phase",
    );
  });

  /**
   * The other half, which the guard above cannot reach: the clocks.
   *
   * Every timer in `mock.ts` mutates the session directly rather than going back
   * through `#hostCmd`, so a gate on presses does not see them. On the server the
   * same timeouts survive a Close and then call `apply` — which is the layer the
   * freeze is in — so the event is refused and nothing moves. Here the close
   * timer went on to settle the question a few seconds after the session had
   * ended, which is a scoreboard changing in a room that has gone home.
   *
   * The engine's answer to the event the timer fires is the oracle: a refusal,
   * therefore an unmoved state, therefore a question still open.
   */
  it("leaves a question open across a Close, because the reducer refuses the close", async (t) => {
    const r = await room(t, 3);
    r.cmd({ name: "start" });
    r.cmd({ name: "trivia.open", suddenDeath: false });
    const question = questionFromFrame(r.host.state());
    assert.equal(r.host.state().trivia?.phase, "open", "no question was opened");

    let engine = engineTriviaRoom(3, [question]);
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
      { event: { type: "close" }, at: T0 + 1_000 },
    ]);
    const timerFires = engineAnswer(engine, { type: "closeQuestion" }, T0 + 60_000);
    assert.deepEqual(
      timerFires.answer,
      { kind: "refused", code: "session_closed", message: "The session is closed." },
      "the engine lets a closed session's question timer settle after all",
    );
    assert.equal(
      engineView(timerFires.next, T0 + 60_000).trivia?.phase,
      "open",
      "the engine's question is not still open, so there is nothing to compare",
    );

    r.cmd({ name: "close" });
    // Well past the question's own time limit, which is what the close timer is
    // armed for. Nothing may fire.
    r.advance(question.timeLimitSec * 1000 + 10_000);
    assert.equal(
      r.host.state().trivia?.phase,
      engineView(timerFires.next, T0 + 60_000).trivia?.phase,
      "the mock's own clock settled a question in a closed session",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #29.5 — the door, before the session is open and after it is shut   */
/* ------------------------------------------------------------------ */

/**
 * What a phone is told at the door, in the shape it comes off the wire.
 *
 * A `refused` frame carries a {@link RefusedReason} and a sentence, and both are
 * read: the reason picks the screen the join form shows and the sentence is what
 * the person holding the phone actually reads.
 */
interface DoorAnswer {
  readonly reason: string;
  readonly message: string;
}

function doorAnswerTo(wire: Wire): DoorAnswer | null {
  const refusal = wire.frames.filter((f) => f.t === "refused").at(-1);
  if (refusal === undefined || refusal.t !== "refused") return null;
  return { reason: refusal.reason, message: refusal.message };
}

/**
 * The same answer, off the reducer and through the boundary's own mapping.
 *
 * `main.ts` has the table: the engine's reject codes are deliberately not the
 * wire's reasons, so `joins_locked` becomes `lobby_locked`, and both
 * `not_joinable` and the global `session_closed` become `not_joinable` — with a
 * note about why it is not `no_such_code` ("the code is real and the session
 * exists"). The sentence is the reducer's, unchanged. Reproduced rather than
 * imported because it is the boundary, which is exactly where the mock's own
 * `#hello` sits.
 */
function engineDoorAnswer(
  state: SessionState,
  pid: string,
  nickname: string,
): DoorAnswer | null {
  const result = reduce(state, { type: "join", pid, nickname }, T0);
  const rejection = result.effects.find((e) => e.kind === "reject");
  if (rejection === undefined || rejection.kind !== "reject") return null;
  const map: Record<string, string> = {
    nickname_taken: "nickname_taken",
    invalid_nickname: "invalid_nickname",
    joins_locked: "lobby_locked",
    kicked: "kicked",
    not_joinable: "not_joinable",
    session_closed: "not_joinable",
  };
  return {
    reason: map[rejection.code] ?? "malformed",
    message: rejection.message,
  };
}

describe("a phone cannot join a session that is not open", () => {
  /**
   * `#hello` checked the token, the code's shape, the lock, the nickname's length
   * and a clash — and never the phase. `join` in reducer.ts refuses `draft` and
   * `closed`, and the two sentences are different sentences.
   *
   * It matters more here than it would anywhere else, because `?mock=manual`
   * deliberately *starts* in `draft` so the host can drive `open` themselves. So
   * a phone opened against the demo before the host has pressed anything joined,
   * and the same phone against the same session in the room is turned away — and
   * the console's roster is the one surface a host checks before starting.
   *
   * Fixable rather than listable because the scripted bots do not come through
   * this door: `#botJoins` adds to the roster directly, which is deliberate
   * difference 6, so `?mock=manual` still has a room to show. What it did cost is
   * one line of the harness — {@link room} now presses Open before the phones
   * arrive, because a draft room cannot hold any.
   */
  it("turns a phone away from a draft session, in the reducer's words", async (t) => {
    const r = await room(t, 0, "draft");
    const real = engineDoorAnswer(engineDraft(), "p1", "Player 1");
    assert.deepEqual(
      real,
      { reason: "not_joinable", message: "The session is not open." },
      "the engine admits a phone to a draft session, so this row has moved",
    );
    const phone = r.join("Player 1");
    r.settle();
    assert.deepEqual(doorAnswerTo(phone), real, "the door of a draft session");
    assert.deepEqual(r.host.state().roster, [], "somebody got in anyway");
  });

  it("turns a phone away from a closed session, in the reducer's other words", async (t) => {
    const r = await room(t, 1);
    r.cmd({ name: "start" });
    r.cmd({ name: "close" });
    const closed = engineAnswer(engineRoom(1), { type: "close" }).next;
    const real = engineDoorAnswer(closed, "p9", "Latecomer");
    // The engine's closed-session freeze answers before `join` does, which is why
    // this sentence is not the draft one. Two different sentences through one
    // wire reason, and a mock with one of them cannot pass both scenarios.
    assert.deepEqual(
      real,
      { reason: "not_joinable", message: "The session is closed." },
      "the engine's answer at the door of a closed session",
    );
    const phone = r.join("Latecomer");
    r.settle();
    assert.deepEqual(doorAnswerTo(phone), real, "the door of a closed session");
    assert.equal(
      r.host.state().roster.length,
      engineView(closed).roster.length,
      "the roster grew",
    );
  });

  /**
   * The locked lobby, which is not one of #29's rows and was found beside them.
   *
   * The reason was right — `main.ts` maps the engine's `joins_locked` onto the
   * wire's `lobby_locked`, and this file has said `lobby_locked` all along — and
   * the sentence was this file's own: "The host has locked the lobby." where the
   * reducer says "The host has locked joining." A `refused` frame's message is
   * what the person holding the phone reads, so it is the same kind of difference
   * as every other sentence in this section, and it is here because the fix to the
   * phase gate is one line above it.
   *
   * The same sentence is now on the special `…lock` code beside it, which is a
   * demo affordance — deliberate difference 6 — kept so the locked-lobby screen
   * can be reached without a host. Not reachable from here: the mock draws its own
   * join code at construction and {@link Room.join} can only offer that one, so
   * the two strings are kept in step by being written together and not by this
   * scenario.
   */
  it("turns a phone away from a locked lobby, in the reducer's words", async (t) => {
    const r = await room(t, 1);
    r.cmd({ name: "start" });
    r.cmd({ name: "lobby.lock", locked: true });
    const locked = engineAnswer(engineRoom(1), {
      type: "setJoinsLocked",
      locked: true,
    }).next;
    const real = engineDoorAnswer(locked, "p9", "Latecomer");
    assert.deepEqual(
      real,
      { reason: "lobby_locked", message: "The host has locked joining." },
      "the engine admits a phone to a locked lobby, so this row has moved",
    );

    const phone = r.join("Latecomer");
    r.settle();
    assert.deepEqual(doorAnswerTo(phone), real, "the door of a locked lobby");

    // Unlocked again, and the same name gets in — so the refusal above is the
    // lock's and not something the name or the phase would have produced anyway.
    r.cmd({ name: "lobby.lock", locked: false });
    const unlocked = engineDoorAnswer(
      engineAnswer(locked, { type: "setJoinsLocked", locked: false }).next,
      "p9",
      "Someone Else",
    );
    assert.equal(unlocked, null, "the engine refuses a join into an unlocked lobby");
    const admitted = r.join("Someone Else");
    r.settle();
    assert.equal(doorAnswerTo(admitted), null, "the unlocked lobby refused a join");
  });
});

/* ------------------------------------------------------------------ */
/* #29.6 — commands that name somebody who is no longer there          */
/* ------------------------------------------------------------------ */

describe("a command naming a kicked or unknown participant is answered as the reducer answers it", () => {
  /**
   * `find_pid` includes kicked people, deliberately — it is how a kicked row is
   * still found for `houseThePairOf` and for the projections that mark it — so
   * `setScore` and `setStatus` have to say `!p || p.kicked` themselves, which is
   * what the reducer does. Here they asked only `!p`. The loudest case was a
   * third command, `grantSpot`, which granted a Spot Award to somebody the host
   * had just removed and toasted it to the whole room; Spot Awards are gone and
   * the two that are left share the rule it broke.
   *
   * The same scenario carries the three idempotence rows beside it, because they
   * are the same lookup from the other end: kicking an unknown pid was a refusal
   * here and is a no-op there, and a second kick and a second release both
   * *applied* here and broadcast a frame identical to the one the room was
   * holding. The console reads that difference — `applied: false` is a button
   * that was already where it is, and a refusal is a sentence on the glass.
   *
   * Five answers, and they are not all the same answer: two refusals with a pid
   * in them, one ack that did something, and three acks that did not.
   */
  it("walks the six, and compares each one", async (t) => {
    const r = await room(t, 3);
    r.cmd({ name: "start" });
    let engine = engineRoom(3);

    r.cmd({ name: "participant.kick", pid: "p2" });
    engine = engineAnswer(engine, { type: "kick", pid: "p2" }).next;
    assert.equal(
      engineView(engine).roster.find((p) => p.pid === "p2"),
      undefined,
      "the engine still has p2 on the roster, so nothing was kicked",
    );

    const rows: readonly { what: string; cmd: HostCommand; event: Event }[] = [
      {
        what: "scoring somebody who has been kicked",
        cmd: { name: "score.set", activityId: "trivia", pid: "p2", raw: 7 },
        event: { type: "setScore", activityId: "trivia", pid: "p2", raw: 7 },
      },
      {
        what: "clearing the cell of somebody who has been kicked",
        cmd: { name: "score.status", activityId: "trivia", pid: "p2", status: "unset" },
        event: { type: "setStatus", activityId: "trivia", pid: "p2", status: "unset" },
      },
      {
        what: "kicking somebody twice",
        cmd: { name: "participant.kick", pid: "p2" },
        event: { type: "kick", pid: "p2" },
      },
      {
        what: "kicking a pid nobody holds",
        cmd: { name: "participant.kick", pid: "p99" },
        event: { type: "kick", pid: "p99" },
      },
      {
        what: "releasing a pid nobody holds",
        cmd: { name: "participant.release", pid: "p99" },
        event: { type: "releaseNickname", pid: "p99" },
      },
    ];

    const answers = rows.map((row) => engineAnswer(engine, row.event).answer);
    // The engine's own five, written out. Two refusals naming the pid and three
    // acks that changed nothing: a mock that gave one answer to all five — which
    // is close to what this file did — cannot pass this line.
    assert.deepEqual(
      answers,
      [
        { kind: "refused", code: "unknown_participant", message: "No participant p2." },
        { kind: "refused", code: "unknown_participant", message: "No participant p2." },
        { kind: "ack", applied: false },
        { kind: "ack", applied: false },
        { kind: "ack", applied: false },
      ],
      "the engine's own answers to the five",
    );
    rows.forEach((row, i) => {
      assert.deepEqual(r.attempt(row.cmd), answers[i], row.what);
    });

    // A release is the other door out of the room, and it has the same two
    // answers: the first one does something and the second one does not.
    const first = engineAnswer(engine, { type: "releaseNickname", pid: "p1" });
    assert.deepEqual(first.answer, { kind: "ack", applied: true }, "the engine's release");
    assert.deepEqual(r.attempt({ name: "participant.release", pid: "p1" }), first.answer);
    const second = engineAnswer(first.next, { type: "releaseNickname", pid: "p1" });
    assert.deepEqual(
      second.answer,
      { kind: "ack", applied: false },
      "the engine's second release is not an ack that changed nothing",
    );
    assert.deepEqual(
      r.attempt({ name: "participant.release", pid: "p1" }),
      second.answer,
      "releasing the same nickname twice",
    );

    // And the grid, which is where a stored raw against a kicked row would show.
    assert.deepEqual(
      triviaGrid(r.host.state()),
      triviaGrid(engineView(second.next)),
      "the score grid after five presses that should have changed nothing",
    );
    // And the roster, which is where a kick or a release that applied twice would
    // show. This checked `hostExtras.spots` when there were Spot Awards to grant
    // to somebody who was not in the room.
    assert.deepEqual(
      r.host.state().roster,
      engineView(second.next).roster,
      "the roster after five presses that should have changed nothing",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #29.7 — the arithmetic of a question's points                       */
/* ------------------------------------------------------------------ */

describe("a question's points are the engine's arithmetic, on the millisecond it matters", () => {
  /**
   * `questionPoints` in engine/trivia.ts is one division on purpose, and carries
   * the argument: the obvious transcription of SCORING.md's formula — `base * (1
   * - t / limit / 2)` — divides twice and subtracts, each step carries its own
   * binary rounding error, and a response time that lands on an exact half
   * arrives as .4999… and `Math.round` takes it **down**. The comment names 123
   * response times in the real launch set where it happens.
   *
   * This file was that transcription. For its own 1000-point, fifteen-second
   * questions, 41 of the 15 001 possible millisecond values came out a point low
   * — on `triviaMine.points`, on the totals, on the podium and on the score grid,
   * for roughly three taps in a thousand. Nobody was going to find it by eye,
   * which is the whole reason it is worth a scenario.
   *
   * **The millisecond is searched for, not written down.** The scenario asks the
   * two formulas where they disagree for whatever question the mock is holding,
   * and fails if they now agree everywhere — so it follows a change to the
   * question set instead of quietly testing a value that no longer matters. The
   * naive form is written out once, here, for that search and nowhere else.
   *
   * **A scenario about a clock has to spend some**, and this one is the sharpest
   * case of that rule in the file: the whole claim lives at one millisecond of
   * response time, so the room is held for exactly the offset that reaches it.
   */
  const naivePoints = (base: number, ms: number, limitSec: number): number =>
    Math.round(base * (1 - Math.min(ms, limitSec * 1000) / (limitSec * 1000) / 2));

  it("scores a response time the naive formula rounds down, as the engine scores it", async (t) => {
    const r = await room(t, 3);
    r.cmd({ name: "start" });
    r.cmd({ name: "trivia.open", suddenDeath: false });
    // `opensAt` is stamped inside the tick this press spends, so `Date.now()`
    // here *is* that instant less the skew — and the skew cancels, because the
    // mock's `ms` is one skewed clock minus another.
    const openedAt = Date.now();
    const question = questionFromFrame(r.host.state());

    let target = -1;
    for (let ms = 0; ms <= question.timeLimitSec * 1000; ms += 1) {
      if (
        naivePoints(question.basePoints, ms, question.timeLimitSec) !==
        questionPoints(question.basePoints, ms, question.timeLimitSec)
      ) {
        target = ms;
        break;
      }
    }
    assert.ok(
      target > 0,
      "the two formulas agree on every response time this question can have, so " +
        "there is nothing here to tell apart",
    );
    // What the difference is, so the failure reads as arithmetic rather than as a
    // number that moved: the naive form is one point low, never high.
    assert.equal(
      questionPoints(question.basePoints, target, question.timeLimitSec) -
        naivePoints(question.basePoints, target, question.timeLimitSec),
      1,
      "the naive transcription is not one point low here after all",
    );

    const right = question.correct[0] ?? 0;
    // Two milliseconds of the offset belong to the tick that carries the frame:
    // `Wire.send` is `transport.send` followed by `tick(2)`, and the answer is
    // read at the end of that tick.
    r.advance(target - 2);
    r.phones[0]?.send({ t: "trivia.answer", cid: "late", index: 0, choice: right });
    assert.equal(
      Date.now() - openedAt,
      target,
      "the room was not held to the millisecond the claim is about",
    );

    r.cmd({ name: "trivia.close" });
    r.cmd({ name: "trivia.reveal" });

    let engine = engineTriviaRoom(3, [question]);
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
      {
        event: { type: "answerQuestion", pid: "p1", choice: right, ms: target },
        at: T0 + target,
      },
      { event: { type: "closeQuestion" }, at: T0 + target + 100 },
      { event: { type: "revealQuestion" }, at: T0 + target + 200 },
    ]);

    // The phone's own strip, which is the surface the number is largest on.
    const mine = renderStateFor(engine, {
      role: "participant",
      pid: "p1",
      lastSeen: new Map([["p1", T0 + target + 200]]),
      now: T0 + target + 200,
    }).triviaMine;
    assert.ok(mine?.state === "revealed", "the engine's phone is not at the reveal");
    assert.equal(
      mine.points,
      questionPoints(question.basePoints, target, question.timeLimitSec),
      "the engine did not score its own question with its own formula",
    );
    const theirs = r.phones[0]?.state().triviaMine;
    assert.ok(theirs?.state === "revealed", "the mock's phone is not at the reveal");
    assert.equal(theirs.points, mine.points, "the points on the phone");
    // And the two surfaces the same number is copied onto.
    assert.deepEqual(
      triviaGrid(r.host.state()),
      triviaGrid(engineView(engine, T0 + target + 200)),
      "the score grid",
    );
    assert.deepEqual(
      publicBoard(r.screen.state()),
      publicBoard(engineScreen(engine, T0 + target + 200)),
      "the public leaderboard",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #29.8 — the nickname rules at the door                              */
/* ------------------------------------------------------------------ */

describe("the door applies the reducer's nickname rules", () => {
  /**
   * `#hello` had one rule — `nickname.length < 2`, worded "Two characters or
   * more." — against the reducer's three, and none of the three sentences
   * matched. So a nickname that gets in here is turned away there, which is the
   * worst direction for this file to be wrong in: the join form is rehearsed
   * against `?mock=1` and nowhere else.
   *
   * - `sanitiseNickname` first, which strips control and format characters and
   *   collapses whitespace. Absent entirely: a name padded with zero-width
   *   joiners was long here and short there.
   * - the fold to a key, which is `nicknameKey` — NFKD, marks stripped, lowered,
   *   non-alphanumerics dropped. This file folded case and nothing else, so `Ana`
   *   and `Aña` were one person there and two here.
   * - and the two bounds, two and twenty-four **glyphs**. There was no ceiling at
   *   all, and `String.length` would have counted a name of twenty emoji as
   *   forty.
   *
   * Four names, four different answers, all four taken off the reducer through
   * the boundary's mapping — see {@link engineDoorAnswer}.
   */
  it("gives a phone the reducer's four answers, in the reducer's words", async (t) => {
    const r = await room(t, 1);
    r.cmd({ name: "start" });
    const engine = engineRoom(1);

    const names: readonly { what: string; nickname: string }[] = [
      { what: "one character", nickname: "A" },
      // Punctuation folds to an empty key on both sides once the engine's fold is
      // the fold. It is two characters, so the length rules have nothing to say.
      { what: "nothing that can be a key", nickname: "!!" },
      { what: "twenty-five glyphs", nickname: "A".repeat(25) },
      // Twenty-five letters from outside the BMP, which is what proves the count
      // is code points and not UTF-16 units: `String.length` calls these fifty and
      // `[...name].length` calls them twenty-five. Letters rather than emoji on
      // purpose — an emoji is neither `\p{L}` nor `\p{N}`, so a name of emoji folds
      // to an empty key and collects "Pick a nickname." before the ceiling is ever
      // reached, which would have made this row a second copy of the one above it.
      { what: "twenty-five astral letters", nickname: "\u{1D400}".repeat(25) },
    ];

    const real = names.map((n) => engineDoorAnswer(engine, "p9", n.nickname));
    assert.deepEqual(
      real,
      [
        { reason: "invalid_nickname", message: "Nicknames need at least 2 characters." },
        { reason: "invalid_nickname", message: "Pick a nickname." },
        { reason: "invalid_nickname", message: "Nicknames are at most 24 characters." },
        { reason: "invalid_nickname", message: "Nicknames are at most 24 characters." },
      ],
      "the engine's own four answers, which are three different sentences",
    );

    names.forEach((n, i) => {
      const phone = r.join(n.nickname);
      r.settle();
      assert.deepEqual(doorAnswerTo(phone), real[i], n.what);
    });
    assert.equal(
      r.host.state().roster.length,
      1,
      "one of the four names was admitted to the room",
    );

    /**
     * And `sanitiseNickname` itself, which none of the four above can reach.
     *
     * The old door did `trim().replace(/\s+/g, " ")`, and the engine's fold does
     * that *and* strips control and format characters. Those two differ on exactly
     * one kind of name — one carrying something invisible — and on nothing else, so
     * a mutation that deletes the sanitise call survives all four rows above. It
     * did, the first time these ran.
     *
     * So: twenty-four letters and a zero-width joiner. Sanitised it is twenty-four
     * glyphs and gets through the ceiling; unsanitised it is twenty-five and
     * collects "Nicknames are at most 24 characters." from the row above, which is
     * a different sentence and a different rule. Paired with a holder of the
     * sanitised name already in the room so the answer is a *refusal* rather than
     * an admission — a phone that got in under a name the harness never invited
     * would trip {@link noStrangers} before any comparison could be made, and it
     * would be tripping it for the right reason.
     *
     * It carries the third claim beside it for free: the sentence names the
     * *sanitised* nickname, which is what the reducer puts in it.
     */
    const PLAIN = "A".repeat(24);
    const INVISIBLE = `${PLAIN}‍`;
    assert.equal([...INVISIBLE].length, 25, "the invisible character is not there");
    r.join(PLAIN);
    r.settle();
    assert.equal(r.host.state().roster.length, 2, "the plain name was not admitted");

    const held = replay(
      engineDraft(),
      (
        [
          { type: "open" },
          { type: "join", pid: "p1", nickname: PLAIN },
          { type: "start" },
        ] as Event[]
      ).map((event) => ({ event, at: T0 })),
    );
    const invisible = engineDoorAnswer(held, "p9", INVISIBLE);
    assert.deepEqual(
      invisible,
      {
        reason: "nickname_taken",
        message: `${PLAIN} is already here. Pick another, or ask the host to release it.`,
      },
      "the engine reads the invisible character as a twenty-fifth glyph, so this " +
        "name no longer tells the two folds apart",
    );
    const sneaky = r.join(INVISIBLE);
    r.settle();
    assert.deepEqual(doorAnswerTo(sneaky), invisible, "a name padded with a joiner");
    assert.equal(r.host.state().roster.length, 2, "the padded name was admitted");
  });

  /**
   * The clash, and the reason `participant.release` exists.
   *
   * The reducer refuses any non-kicked holder of the key, connected or not. This
   * file asked `clash.conn === "on"` and, when the holder was away, **handed the
   * newcomer their row** — their pid, their player number, their raw scores and
   * their scores. A door that gives the next arrival the row is a door that
   * makes `participant.release` pointless.
   *
   * **Driven off the scripted director, and it has to be.** Nothing in
   * {@link room} can produce an away participant who is neither kicked nor
   * released: a kick marks them `kicked` and a release blanks their key, and both
   * free the name on purpose — the reducer agrees with the mock about both. The
   * one route to `conn: "away"` with the key intact is the director's own
   * hand-dropped bot at thirteen seconds, which is deliberate difference 7's
   * single scripted disconnection, so this scenario builds a director room the way
   * {@link walkTheLoop} does and types that bot's name into a phone. Which is also
   * exactly how a person would meet it: it is reachable in `?mock=1` with no
   * socket at all.
   */
  it("refuses a name held by somebody who is away, as the reducer does", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const mod = await freshMock();
    const factory = mod.mockTransport({ ...MANUAL, director: true });
    const tick = (ms: number): void => t.mock.timers.tick(ms);

    const frames: ServerMessage[] = [];
    const host = factory({
      onOpen() {},
      onMessage(msg) {
        frames.push(msg);
      },
      onClose() {},
    });
    tick(11);
    host.send({ t: "hello", role: "host", hostToken: "mock-host" });
    // Fifteen seconds: the script opens at half a second, starts the session at
    // nine, and drops one bot's connection at thirteen. One second a tick, for the
    // reason {@link Room.advance} gives.
    for (let i = 0; i < 15; i += 1) tick(1_000);

    const state = frames.filter((f) => f.t === "state").at(-1);
    assert.ok(state !== undefined && state.t === "state", "the console has no frame");
    assert.equal(state.state.phase, "running", "the script has not started the session");
    const away = state.state.roster.find((p) => p.conn === "away");
    assert.ok(
      away !== undefined,
      "the script dropped nobody, so there is no away holder to clash with",
    );
    const joinCode = state.state.joinCode;
    assert.ok(joinCode, "the console frame carries no join code");

    const phoneFrames: ServerMessage[] = [];
    const phone = factory({
      onOpen() {},
      onMessage(msg) {
        phoneFrames.push(msg);
      },
      onClose() {},
    });
    tick(11);
    phone.send({
      t: "hello",
      role: "participant",
      joinCode,
      nickname: away.nickname,
    });
    tick(4);

    // The engine, holding the same situation: somebody joined, then dropped, and
    // is still on the roster under their own key.
    const engine = replay(
      engineDraft(),
      (
        [
          { type: "open" },
          { type: "join", pid: "p1", nickname: away.nickname },
          { type: "start" },
          { type: "disconnect", pid: "p1" },
        ] as Event[]
      ).map((event) => ({ event, at: T0 })),
    );
    assert.equal(
      engine.participants["p1"]?.connected,
      false,
      "the engine's holder is not away, so the clash is the connected one",
    );
    const real = engineDoorAnswer(engine, "p9", away.nickname);
    assert.deepEqual(
      real,
      {
        reason: "nickname_taken",
        message: `${away.nickname} is already here. Pick another, or ask the host to release it.`,
      },
      "the engine lets a newcomer take an away holder's name, so this row has moved",
    );

    const refusal = phoneFrames.filter((f) => f.t === "refused").at(-1);
    assert.ok(refusal !== undefined && refusal.t === "refused", "the phone was admitted");
    assert.deepEqual(
      { reason: refusal.reason, message: refusal.message },
      real,
      "the door, for a name whose holder is away",
    );
    // And the row is still theirs: the newcomer was given no welcome, so there is
    // no pid to inherit a score with.
    assert.equal(
      phoneFrames.filter((f) => f.t === "welcome").length,
      0,
      "the newcomer was welcomed into the away holder's row",
    );
    // Releasing the name is what frees it, which is the other half of the rule —
    // and the reducer agrees, because a released holder's key is blank.
    const released = engineAnswer(engine, { type: "releaseNickname", pid: "p1" }).next;
    assert.equal(
      engineDoorAnswer(released, "p9", away.nickname),
      null,
      "the engine still refuses a released name, so release does nothing",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #29.9 — a kicked phone's tap                                        */
/* ------------------------------------------------------------------ */

describe("a kicked phone's answer is refused and counted by nobody", () => {
  /**
   * `answerQuestion` in reducer.ts refuses `!p || p.kicked` with
   * `unknown_participant`, and `main.ts` drops the kicked socket on the way past.
   * This file had neither — and the socket half is deliberate difference 7, which
   * says nobody ever disconnects, so the phone is still connected on purpose. The
   * *guard* was simply missing, so the tap was acked and counted: a probe left the
   * console reading `answered 1 / eligible 1` with a distribution and an
   * `answeredBy` row, in a room whose one remaining participant had not answered.
   *
   * The socket staying open stays. Being counted does not.
   */
  it("refuses the tap in the reducer's words and leaves the count alone", async (t) => {
    const r = await room(t, 2);
    r.cmd({ name: "start" });
    r.cmd({ name: "trivia.open", suddenDeath: false });
    const question = questionFromFrame(r.host.state());
    const right = question.correct[0] ?? 0;

    let engine = engineTriviaRoom(2, [question]);
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
      { event: { type: "kick", pid: "p2" }, at: T0 + 10 },
    ]);
    r.cmd({ name: "participant.kick", pid: "p2" });

    const real = engineAnswer(
      engine,
      { type: "answerQuestion", pid: "p2", choice: right, ms: 20 },
      T0 + 20,
    );
    assert.deepEqual(
      real.answer,
      {
        kind: "refused",
        code: "unknown_participant",
        message: "No participant p2.",
      },
      "the engine counts a kicked phone's answer, so this row has moved",
    );
    const kicked = r.phones[1];
    assert.ok(kicked !== undefined, "the room has no second phone");
    kicked.send({ t: "trivia.answer", cid: "ghost", index: 0, choice: right });
    assert.deepEqual(answerTo(kicked, "ghost"), real.answer, "a kicked phone's tap");

    // The one person still in the room taps, so the count below is one and not
    // zero: two empty counts would match however either side is written.
    engine = replay(engine, [
      {
        event: { type: "answerQuestion", pid: "p1", choice: right, ms: 30 },
        at: T0 + 30,
      },
    ]);
    r.phones[0]?.send({ t: "trivia.answer", cid: "real", index: 0, choice: right });
    r.settle();

    // `answered` and `eligible` are optional on the wire — protocol.ts leaves
    // them off a phone that has not locked in — so a missing one is a real answer
    // and is reported as such rather than defaulted to zero, which would let two
    // absent counts match.
    const count = (
      state: RenderState,
    ): { answered: number | undefined; eligible: number | undefined } => {
      const view = state.trivia;
      assert.ok(view !== undefined, "no question on the frame");
      return { answered: view.answered, eligible: view.eligible };
    };
    assert.deepEqual(
      count(engineView(engine, T0 + 30)),
      { answered: 1, eligible: 1 },
      "the engine's own count",
    );
    assert.deepEqual(count(r.host.state()), count(engineView(engine, T0 + 30)));
    assert.deepEqual(
      r.host.state().hostExtras?.trivia?.answeredBy ?? [],
      engineView(engine, T0 + 30).hostExtras?.trivia?.answeredBy ?? [],
      "the console's list of who has answered",
    );
  });
});

/* ------------------------------------------------------------------ */
/* #29 — the five that were recorded and not fixed                     */
/* ------------------------------------------------------------------ */

describe("the four recorded divergences that a sequence can reach", () => {
  /**
   * `openQuestion` in reducer.ts asks three things in order: is a set loaded, is
   * the session `running`, and is the question phase one that can be opened.
   * There was no phase check here at all, so the probe opened a question in the
   * lobby and the phone received the text — a room being asked question one
   * before the host has pressed Start.
   *
   * Socket-only from the console's point of view, because the trivia panel is
   * behind the segment rail. The rail is not a rule, and this file is where the
   * rule lives.
   */
  it("refuses a question opened before the session is started, in the reducer's words", async (t) => {
    const r = await room(t, 2);
    assert.equal(r.host.state().phase, "lobby", "the room is not in the lobby");

    // A set loaded, and no `start`: `engineTriviaRoom` presses one, so this walks
    // the events itself.
    const joins: Event[] = [
      { type: "join", pid: "p1", nickname: "Player 1" },
      { type: "join", pid: "p2", nickname: "Player 2" },
    ];
    const lobby = replay(
      engineDraft(),
      (
        [
          { type: "open" },
          ...joins,
          { type: "setSegment", segment: "trivia" },
          {
            type: "loadTrivia",
            activityId: "trivia",
            questions: [questionFromFrame(r.host.state())],
            tiebreakers: [],
          },
        ] as Event[]
      ).map((event) => ({ event, at: T0 })),
    );
    const inTheLobby = engineAnswer(lobby, { type: "openQuestion", suddenDeath: false });
    assert.deepEqual(
      inTheLobby.answer,
      { kind: "refused", code: "wrong_phase", message: "Start the session first." },
      "the engine opens a question in the lobby, so this row has moved",
    );
    assert.deepEqual(
      r.attempt({ name: "trivia.open", suddenDeath: false }),
      inTheLobby.answer,
      "a question opened in the lobby",
    );
    assert.equal(
      r.host.state().trivia?.phase,
      engineView(lobby).trivia?.phase,
      "the mock opened it anyway",
    );

    // And the pairing that keeps the fix honest: once the session is running the
    // same press is accepted on both sides, so a mock that refused every
    // `trivia.open` would fail here.
    r.cmd({ name: "start" });
    const running = engineAnswer(
      replay(lobby, [{ event: { type: "start" }, at: T0 + 100 }]),
      { type: "openQuestion", suddenDeath: false },
    );
    assert.deepEqual(running.answer, { kind: "ack", applied: true }, "the engine's Open");
    assert.deepEqual(
      r.attempt({ name: "trivia.open", suddenDeath: false }),
      running.answer,
      "a question opened in a running session",
    );
  });

  /**
   * The two halves of a trivia tap's refusal order.
   *
   * On the server the index is not the engine's to refuse: `answer` in runtime.ts
   * checks it at the boundary — "the driver is the only layer that can tell a tap
   * meant for question 7 from one that arrived after the host advanced to question
   * 8" — and only then hands the event to `reduce`. This file asked the *phase*
   * first, which is a divergence a phone reads: after Reveal and Next, `at` is 1
   * and the phase is `idle`, so a phone still holding question one was told "That
   * question is closed." where the room would be told "That question has moved
   * on." Same code, and the wrong one of the two sentences — the one that does not
   * say why.
   *
   * Pressed twice, with the stale index and with the current one, because the two
   * answers are different sentences and a scenario that collected the wrong one
   * would be passing on the bug it was written for.
   *
   * And `Number.isInteger`, which the reducer asks for and this did not. In
   * principle only from a socket, since protocol.ts's parser refuses a fractional
   * `choice` before a real server sees it — but the in-page path hands a typed
   * `ClientMessage` straight to the hub with no parse in between, which is the
   * door this harness comes through too.
   */
  it("refuses a tap in the boundary's order, with the boundary's sentences", async (t) => {
    const r = await room(t, 2);
    r.cmd({ name: "start" });
    r.cmd({ name: "trivia.open", suddenDeath: false });
    const first = questionFromFrame(r.host.state());
    const right = first.correct[0] ?? 0;

    /**
     * The answer the server would give one tap, boundary included.
     *
     * `answer` in runtime.ts checks the index and defers everything else; so does
     * this, and the deferral is {@link engineAnswer} over `answerQuestion`.
     */
    const engineTap = (
      state: SessionState,
      index: number,
      pid: string,
      choice: number,
    ): Answer => {
      const trivia = state.trivia;
      assert.ok(trivia !== null, "the engine has no question set loaded");
      if (index !== trivia.at) {
        return {
          kind: "refused",
          code: "question_not_open",
          message: "That question has moved on.",
        };
      }
      return engineAnswer(state, { type: "answerQuestion", pid, choice, ms: 5 }).answer;
    };

    let engine = engineTriviaRoom(2, [first, first]);
    engine = replay(engine, [
      { event: { type: "openQuestion", suddenDeath: false }, at: T0 },
    ]);

    // A fractional choice, while the question is plainly open.
    const fractional = engineTap(engine, 0, "p1", 1.5);
    assert.deepEqual(
      fractional,
      { kind: "refused", code: "invalid_choice", message: "No such answer." },
      "the engine accepts a fractional choice, so this row has moved",
    );
    r.phones[0]?.send({ t: "trivia.answer", cid: "half", index: 0, choice: 1.5 });
    assert.deepEqual(answerTo(r.phones[0]!, "half"), fractional, "a choice of 1.5");
    // And a whole one, so the refusal above is about the fraction and not about
    // the tap: the same phone, the same moment.
    const whole = engineTap(engine, 0, "p1", right);
    assert.deepEqual(whole, { kind: "ack", applied: true }, "the engine's own tap");
    r.phones[0]?.send({ t: "trivia.answer", cid: "whole", index: 0, choice: right });
    assert.deepEqual(answerTo(r.phones[0]!, "whole"), whole, "a choice of an integer");
    engine = replay(engine, [
      {
        event: { type: "answerQuestion", pid: "p1", choice: right, ms: 5 },
        at: T0 + 5,
      },
    ]);

    // Now past the question: closed, revealed, and on to the next one. `at` is 1
    // and the phase is `idle`, which is the state the two checks disagree about.
    r.cmd({ name: "trivia.close" });
    r.cmd({ name: "trivia.reveal" });
    r.cmd({ name: "trivia.next" });
    engine = replay(engine, [
      { event: { type: "closeQuestion" }, at: T0 + 100 },
      { event: { type: "revealQuestion" }, at: T0 + 200 },
      { event: { type: "nextQuestion" }, at: T0 + 300 },
    ]);
    assert.equal(engine.trivia?.at, 1, "the engine did not advance");
    assert.equal(engine.trivia?.phase, "idle", "the engine's next question is already open");

    const stale = engineTap(engine, 0, "p2", right);
    const current = engineTap(engine, 1, "p2", right);
    // The two sentences, which is the whole content of the ordering: a mock that
    // asks the phase first gives the second answer to the first press.
    assert.deepEqual(
      [stale, current],
      [
        {
          kind: "refused",
          code: "question_not_open",
          message: "That question has moved on.",
        },
        {
          kind: "refused",
          code: "question_not_open",
          message: "That question is closed.",
        },
      ],
      "the engine's two answers, which have to be two answers",
    );
    const phone = r.phones[1];
    assert.ok(phone !== undefined, "the room has no second phone");
    phone.send({ t: "trivia.answer", cid: "stale", index: 0, choice: right });
    assert.deepEqual(answerTo(phone, "stale"), stale, "a tap on the question before");
    phone.send({ t: "trivia.answer", cid: "current", index: 1, choice: right });
    assert.deepEqual(answerTo(phone, "current"), current, "a tap on an unopened question");
  });

  /**
   * Recruitment's typed answer, and the sentence the server actually uses.
   *
   * The audit read this as `not_in_arcade` / "The arcade is not open." on the
   * server, and that is `tap`'s chain in runtime.ts rather than `submitAnswer`'s —
   * worth recording, because #29's own opening says three claims in the earlier
   * issues were false once somebody read the engine, and this is a fourth.
   * `submitAnswer` has no such branch, and the reducer's `not_in_arcade` is
   * unreachable behind the runtime's Recruitment check.
   *
   * What *is* wrong is a wording, and it is reachable. The server asks the
   * question in two layers with two sentences: runtime.ts asks whether the round
   * in play is Recruitment and says "Nothing to answer."; the reducer then asks
   * whether the Floor is `running` and says "There is nothing to answer." This
   * file had one condition and one sentence, so a submission to a Recruitment
   * round that has *ended* — the play survives `#endRound`, the phase does not —
   * collected the wrong one of the two.
   *
   * The kicked check the reducer makes is the other half, and it is the same
   * omission as trivia's: deliberate difference 7 keeps the socket open, and never
   * said the answer counts.
   */
  it("uses each of the two sentences where the server uses it", async (t) => {
    const pair = roundPair("recruitment");
    const r = await room(t, 3);
    r.cmd({ name: "start" });
    r.cmd({ name: "arcade.enter" });
    r.cmd(pair.cmd);
    r.cmd({ name: "arcade.begin" });

    let engine = engineRoom(3, [
      { type: "startRound", round: "recruitment", config: pair.config },
      { type: "beginPlay" },
    ]);

    /**
     * The server's answer to one typed submission, boundary included: the
     * Recruitment check and the item index are runtime.ts's, and everything after
     * them is the reducer's.
     */
    const engineSubmit = (
      state: SessionState,
      pid: string,
      item: number,
      answer: string,
      at: number,
    ): Answer => {
      const play = state.arcade?.play;
      if (play?.kind !== "recruitment") {
        return {
          kind: "refused",
          code: "wrong_round_phase",
          message: "Nothing to answer.",
        };
      }
      if (item !== play.at) {
        return {
          kind: "refused",
          code: "wrong_round_phase",
          message: "That one has moved on.",
        };
      }
      return engineAnswer(state, { type: "submitAnswer", pid, answer }, at).answer;
    };

    // First, a kicked player answering a round that is plainly running.
    r.cmd({ name: "participant.kick", pid: "p3" });
    engine = engineAnswer(engine, { type: "kick", pid: "p3" }).next;
    const ghost = engineSubmit(engine, "p3", 0, "anything", T0 + 100);
    assert.deepEqual(
      ghost,
      {
        kind: "refused",
        code: "unknown_participant",
        message: "No participant p3.",
      },
      "the engine counts a kicked player's typed answer, so this row has moved",
    );
    const kicked = r.phones[2];
    assert.ok(kicked !== undefined, "the room has no third phone");
    kicked.send({ t: "arcade.answer", cid: "ghost", item: 0, answer: "anything" });
    assert.deepEqual(answerTo(kicked, "ghost"), ghost, "a kicked player's typed answer");

    // And a real one, so the refusal above is about the kick: the same item, the
    // same instant.
    const alive = engineSubmit(engine, "p1", 0, "anything", T0 + 110);
    assert.deepEqual(alive, { kind: "ack", applied: true }, "the engine's own submission");
    r.phones[0]?.send({ t: "arcade.answer", cid: "alive", item: 0, answer: "anything" });
    assert.deepEqual(answerTo(r.phones[0]!, "alive"), alive, "a submission that counts");
    engine = replay(engine, [
      {
        event: { type: "submitAnswer", pid: "p1", answer: "anything" },
        at: T0 + 110,
      },
    ]);

    // Now end the round. The play is still Recruitment and the Floor is not
    // running, which is the state the two sentences disagree about.
    r.cmd({ name: "arcade.end" });
    engine = replay(engine, [{ event: { type: "endRound" }, at: T0 + 200 }]);
    assert.equal(
      engine.arcade?.play?.kind,
      "recruitment",
      "the engine dropped the play at the end of the round, so the second " +
        "sentence is unreachable and there is nothing here to compare",
    );
    const ended = engineSubmit(engine, "p2", 0, "anything", T0 + 300);
    assert.deepEqual(
      ended,
      {
        kind: "refused",
        code: "wrong_round_phase",
        message: "There is nothing to answer.",
      },
      "the engine's answer at a Recruitment round that has ended",
    );
    // Not the same sentence as the one the boundary uses, which is the point.
    assert.notDeepEqual(
      ended,
      {
        kind: "refused",
        code: "wrong_round_phase",
        message: "Nothing to answer.",
      },
      "the two sentences are the same sentence, so this row is not a difference",
    );
    const late = r.phones[1];
    assert.ok(late !== undefined, "the room has no second phone");
    late.send({ t: "arcade.answer", cid: "late", item: 0, answer: "anything" });
    assert.deepEqual(
      answerTo(late, "late"),
      ended,
      "a typed answer at a Recruitment round that has ended",
    );

    // And the boundary's own sentence, where the boundary uses it: a round that
    // is not Recruitment at all.
    r.cmd({ name: "arcade.reveal" });
    const second = roundPair("plan_apply");
    r.cmd(second.cmd);
    r.cmd({ name: "arcade.begin" });
    engine = replay(engine, [
      { event: { type: "revealRound" }, at: T0 + 400 },
      {
        event: { type: "startRound", round: "plan_apply", config: second.config },
        at: T0 + 500,
      },
      { event: { type: "beginPlay" }, at: T0 + 600 },
    ]);
    const elsewhere = engineSubmit(engine, "p2", 0, "anything", T0 + 700);
    assert.deepEqual(
      elsewhere,
      {
        kind: "refused",
        code: "wrong_round_phase",
        message: "Nothing to answer.",
      },
      "the boundary's own sentence, for a round with nothing to type into",
    );
    late.send({ t: "arcade.answer", cid: "wrong-round", item: 0, answer: "anything" });
    assert.deepEqual(
      answerTo(late, "wrong-round"),
      elsewhere,
      "a typed answer at a round that is not Recruitment",
    );
  });

  /**
   * `sendoff.speed`, handed something that is not a number.
   *
   * `setSendoffSpeed` in reducer.ts refuses a non-finite `seconds` before it
   * clamps, and the clamp is the reason: `Math.round(NaN)` is `NaN`, `Math.max`
   * and `Math.min` pass it straight through, and `autoSeconds: NaN` then poisons
   * every deadline derived from it — a countdown that draws nothing, and now that
   * the mock has a slide timer, one armed for `NaN` milliseconds.
   *
   * In principle only from a socket: protocol.ts's parser drops it. It reaches
   * *this* file because the in-page path hands a typed `HostCommand` straight to
   * the hub with no parse in between, which is also how this harness presses
   * buttons — so unlike the two rows recorded at the top of this section, this one
   * can be watched, and is.
   */
  it("refuses a speed that is not a number, in the reducer's words", async (t) => {
    const r = await room(t, 2);
    r.cmd({ name: "start" });
    r.cmd({ name: "segment", kind: "sendoff" });
    const engine = engineRoom(2, [
      { type: "loadSendoff", content: SENDOFF_CONTENT, seed: 1 },
      { type: "setSegment", segment: "sendoff" },
    ]);

    const real = engineAnswer(engine, {
      type: "setSendoffSpeed",
      seconds: Number.NaN,
    });
    assert.deepEqual(
      real.answer,
      {
        kind: "refused",
        code: "invalid_round_config",
        message: "That speed is not a number.",
      },
      "the engine stores a non-finite speed, so this row has moved",
    );
    assert.deepEqual(
      r.attempt({ name: "sendoff.speed", seconds: Number.NaN }),
      real.answer,
      "a speed of NaN",
    );
    // The consequence, which is what the refusal is protecting: the beat on the
    // wire is still a number, and still the same number on both sides.
    const held = r.host.state().sendoff?.autoSeconds;
    assert.ok(
      typeof held === "number" && Number.isFinite(held),
      `the mock stored a beat of ${String(held)}`,
    );
    assert.equal(held, engineView(engine).sendoff?.autoSeconds, "the beat on the wire");

    // A finite speed the engine does take, so the refusal above is about the
    // number and not about the button.
    const good = engineAnswer(engine, {
      type: "setSendoffSpeed",
      seconds: MIN_AUTO_SECONDS,
    });
    assert.deepEqual(good.answer, { kind: "ack", applied: true }, "the engine's own speed");
    assert.deepEqual(
      r.attempt({ name: "sendoff.speed", seconds: MIN_AUTO_SECONDS }),
      good.answer,
      "a speed the reducer accepts",
    );
    assert.equal(
      r.host.state().sendoff?.autoSeconds,
      engineView(good.next).sendoff?.autoSeconds,
      "the beat the host chose",
    );
  });
});

/**
 * The demo is this build's server, so it speaks this build's protocol.
 *
 * #33 gave every client a check on `welcome.protocol`, and the phone's answer
 * to a mismatch is to reload itself. The mock fabricates its own `welcome`, and
 * for the whole life of the file that field was the literal `1` — which was
 * harmless only for as long as `PROTOCOL_VERSION` was also 1. The moment it
 * moved, `?mock=1` became a page that reloads itself on open, twice, and then
 * sits under a banner telling the reader to reload a page that has no server
 * behind it at all. Nothing else in this file would have noticed: every other
 * assertion here is about a `state` frame.
 *
 * Asserted for all three roles because the mock builds the frame in two places
 * — `#hello` for the console and the Desktop, `#admit` for a phone — and the
 * participant path is the one where the consequence is a reload.
 */
describe("#33 the mock's welcome carries this build's protocol version", () => {
  it("on every role's handshake", async (t) => {
    const r = await room(t, 1);
    for (const [who, wire] of [
      ["the console", r.host],
      ["the Desktop", r.screen],
      ["a phone", r.phones[0]!],
    ] as const) {
      const welcomes = wire.frames.filter((f) => f.t === "welcome");
      assert.equal(welcomes.length, 1, `${who} was welcomed once`);
      assert.equal(
        welcomes[0]?.protocol,
        PROTOCOL_VERSION,
        `${who} would reload itself on open against a literal here`,
      );
    }
  });
});
