/**
 * Round 4, Gganbu, on the wire.
 *
 * Every other arcade round hides an answer from the room. This one hides an
 * answer from the room *and* hides one person's bet from the one person in the
 * room who is betting against them — both halves of a pair answer the same
 * prompt, sitting next to each other, so a rival's pick, a rival's stake, or a
 * rival's token count moving mid-prompt are all the answer arriving early from
 * the least trustworthy possible source. So the claims here are:
 *
 * 1. **The answer key never leaves the server.** `answer`, `note` and `verify`
 *    reach the host, because the host reads them out, and reach everybody else
 *    at `revealRound` and not one frame earlier. `verify` — "I checked this one
 *    least" — does not travel even then.
 * 2. **A rival's un-settled wager reaches nobody.** Not the other half of the
 *    pair, not the big screen, not the console. There is no `wagers` on any
 *    frame, of any role, in any phase, because the round's only public view
 *    carries a count instead of the map.
 * 3. **A token count cannot twitch mid-prompt**, because a count that moved
 *    when a wager landed would *be* the wager.
 * 4. **The frame is strict.** A malformed stake is refused rather than
 *    defaulted, and the six prompts and the pairing seed never arrive from a
 *    browser.
 *
 * Asserted against the serialised frame wherever the claim is about what is in
 * the bytes, for the reason glass-bridge.test.ts gives: a field that is absent
 * from a type but present in the JSON is still on the wire.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newSession, replay } from "../engine/reducer.ts";
import type {
  Activity,
  Event,
  OverUnderItem,
  SessionState,
} from "../engine/types.ts";
import { gganbuPairs } from "../engine/arcade.ts";
import { SessionRegistry, type Client } from "./runtime.ts";
import { renderStateFor } from "./views.ts";
import { parseClientMessage } from "../protocol.ts";
import type { ArcadeGganbuView, RenderState } from "../protocol.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const ACTIVITIES: readonly Activity[] = [
  { id: "arcade", title: "Hashi Arcade", kind: "arcade" },
];

/**
 * Three prompts whose every string appears nowhere else in the repository.
 *
 * "Vault" would appear in half of it and prove nothing. ZIRCON, TANTALUM and
 * the rest appear in exactly one place each, so finding one in a frame is
 * unambiguous — and so is *not* finding one.
 */
const PROMPTS: readonly OverUnderItem[] = [
  {
    cue: "ZIRCON's first release",
    threshold: "1111",
    answer: "over",
    note: "TANTALUM-NOTE: 1112, by a year.",
    verify: false,
  },
  {
    cue: "RHODIUM's default port",
    threshold: "3333",
    answer: "under",
    note: "NIOBIUM-NOTE: 3330, and it has not moved.",
    verify: true,
  },
  {
    cue: "YTTRIUM's token count",
    threshold: "5555",
    answer: "over",
    note: "SCANDIUM-NOTE: 5556, which nobody remembers.",
    verify: true,
  },
];

/** Every string in the key. Finding any of them in a frame is the leak. */
const KEY_STRINGS: readonly string[] = [
  "TANTALUM-NOTE",
  "NIOBIUM-NOTE",
  "SCANDIUM-NOTE",
];

const T0 = 1_700_000_000_000;
const SEED = 3;
/** SPEC.md: fifteen seconds a prompt. */
const PROMPT_MS = 15_000;
const START_TOKENS = 10;

const PIDS = ["p1", "p2", "p3", "p4"] as const;

const START: Event = {
  type: "startRound",
  round: "gganbu",
  config: {
    kind: "gganbu",
    prompts: PROMPTS,
    secondsPerPrompt: PROMPT_MS / 1000,
    startTokens: START_TOKENS,
    seed: SEED,
  },
};

function session(events: readonly Event[], at = T0): SessionState {
  const base = newSession({
    sid: "ses_gganbu",
    title: "Test",
    joinCode: "hvs.testtesttest",
    activities: ACTIVITIES,
  });
  return replay(
    base,
    events.map((event) => ({ event, at })),
  );
}

function entered(extra: readonly Event[] = []): SessionState {
  return session([
    { type: "open" },
    ...PIDS.map(
      (pid, i): Event => ({ type: "join", pid, nickname: `Player ${i + 1}` }),
    ),
    { type: "start" },
    { type: "setSegment", segment: "arcade" },
    { type: "enterArcade", activityId: "arcade" },
    ...extra,
  ]);
}

/** The Floor open on prompt 0, everybody on ten tokens, nobody wagered. */
function wagering(
  extra: readonly { event: Event; at: number }[] = [],
): SessionState {
  return replay(entered([START, { type: "beginPlay" }]), extra);
}

function view(
  state: SessionState,
  role: "participant" | "host" | "screen",
  pid?: string,
  now = T0,
): RenderState {
  return renderStateFor(state, {
    role,
    ...(pid === undefined ? {} : { pid }),
    lastSeen: new Map(),
    now,
  });
}

function wire(
  state: SessionState,
  role: "participant" | "host" | "screen",
  pid?: string,
): string {
  return JSON.stringify({ t: "state", seq: 1, state: view(state, role, pid) });
}

function gganbuOf(
  state: SessionState,
  role: "participant" | "host" | "screen",
  pid?: string,
): ArcadeGganbuView {
  const g = view(state, role, pid).arcade?.gganbu;
  assert.ok(g !== undefined, `${role}: no gganbu view at all`);
  return g;
}

/** The pairing the engine drew, computed the engine's way rather than guessed. */
const RIVALS = gganbuPairs([...PIDS], SEED);

function rivalOf(pid: string): string {
  const r = RIVALS[pid];
  assert.ok(r !== undefined, `${pid} was paired with the house, which this file is not about`);
  return r;
}

function fakeClient(pid: string | undefined, rtt: number[]): Client {
  const socket = { readyState: 1, send() {} } as unknown as Client["socket"];
  return {
    socket,
    role: "participant",
    ...(pid === undefined ? {} : { pid }),
    lastSeen: T0,
    seq: 0,
    rtt,
    pingSentAt: null,
  };
}

/* ------------------------------------------------------------------ */
/* 1. A rival's wager reaches nobody                                   */
/* ------------------------------------------------------------------ */

describe("a wager is one person's, and stays one person's", () => {
  it("keeps a rival's un-settled wager out of the other half of the pair's frame", () => {
    // The round in one test. p1 stakes four on `over`; their gganbu's phone
    // must learn that a stake landed and nothing else about it — because in
    // this round "what they staked" is a read on the answer, from the one
    // person who is answering the same prompt.
    const rival = rivalOf("p1");
    const state = wagering([
      { event: { type: "wager", pid: "p1", pick: "over", amount: 4 }, at: T0 + 1_000 },
    ]);

    const theirs = view(state, "participant", rival).arcadeMine?.gganbu;
    assert.ok(theirs !== undefined);
    assert.equal(theirs.rivalCommitted, true, "they may learn *that* it landed");
    assert.equal(theirs.committed, false);
    assert.equal(theirs.wager, null, "and they have not staked anything themselves");

    // And in the bytes: p1's pick and stake are nowhere in the frame. `4` on
    // its own would match a token count, so the assertion is on the shapes a
    // wager is actually serialised as.
    const frame = wire(state, "participant", rival);
    assert.ok(!frame.includes('"amount"'), "a stake is on the wire");
    assert.ok(!frame.includes('"pick"'), "a pick is on the wire");
    assert.ok(!frame.includes('"wagers"'), "the wager map is on the wire");
  });

  it("gives a player their own wager, and only their own", () => {
    const rival = rivalOf("p1");
    const state = wagering([
      { event: { type: "wager", pid: "p1", pick: "over", amount: 4 }, at: T0 + 1_000 },
      { event: { type: "wager", pid: rival, pick: "under", amount: 2 }, at: T0 + 2_000 },
    ]);

    const mine = view(state, "participant", rival).arcadeMine?.gganbu;
    assert.deepEqual(mine?.wager, { pick: "under", amount: 2 });
    assert.equal(mine?.committed, true);
    assert.equal(mine?.rivalCommitted, true);

    // Their own stake of two is in their frame; p1's four is not, and "4" is
    // distinguishable from "2" in the bytes.
    const frame = wire(state, "participant", rival);
    assert.ok(frame.includes('"amount":2'), "their own stake should be theirs");
    assert.ok(!frame.includes('"amount":4'), "their rival's stake is on the wire");
    assert.ok(!frame.includes('"pick":"over"'), "their rival's call is on the wire");
  });

  it("puts the wager map on no frame, of any role, in any phase", () => {
    // The point is not that each projection strips it. It is that
    // `gganbuFloorView()` carries a count instead of the map, so no projection
    // has it to strip — including the console's, which gets every other number
    // in the product.
    const phases: readonly [string, SessionState][] = [
      ["card", entered([START])],
      ["running", wagering([
        { event: { type: "wager", pid: "p1", pick: "over", amount: 5 }, at: T0 + 500 },
        { event: { type: "wager", pid: "p2", pick: "under", amount: 3 }, at: T0 + 600 },
      ])],
      ["reveal", replay(
        wagering([
          { event: { type: "wager", pid: "p1", pick: "over", amount: 5 }, at: T0 + 500 },
        ]),
        [
          { event: { type: "endRound" }, at: T0 + PROMPT_MS },
          { event: { type: "revealRound" }, at: T0 + PROMPT_MS + 1 },
        ],
      )],
    ];
    for (const [label, state] of phases) {
      for (const role of ["participant", "host", "screen"] as const) {
        const frame = wire(state, role, "p3");
        assert.ok(
          !frame.includes('"wagers"'),
          `${role} holds the wager map in ${label}`,
        );
      }
    }
  });

  it("sends the count to every surface, because a count names nobody", () => {
    const state = wagering([
      { event: { type: "wager", pid: "p1", pick: "over", amount: 5 }, at: T0 + 500 },
      { event: { type: "wager", pid: "p2", pick: "under", amount: 3 }, at: T0 + 600 },
    ]);
    for (const role of ["participant", "host", "screen"] as const) {
      assert.equal(gganbuOf(state, role, "p3").wagered, 2, `${role}: no count`);
    }
  });

  it("does not move a rival's token count until the prompt settles", () => {
    // A count that twitched when a wager landed would *be* the wager: it would
    // say the stake, and the direction would say the call as soon as it
    // settled. `settleGganbuPrompt` is the only place a token moves.
    const rival = rivalOf("p1");
    const before = view(wagering(), "participant", rival).arcadeMine?.gganbu;
    assert.equal(before?.rivalTokens, START_TOKENS);

    const staked = wagering([
      { event: { type: "wager", pid: "p1", pick: "over", amount: 5 }, at: T0 + 500 },
    ]);
    const during = view(staked, "participant", rival).arcadeMine?.gganbu;
    assert.equal(during?.rivalTokens, START_TOKENS, "the count moved mid-prompt");
    assert.equal(during?.rivalCommitted, true);

    // Prompt 0's answer is `over`, so p1 is paid on settlement and *then* the
    // count moves.
    const settled = replay(staked, [
      { event: { type: "nextPrompt" }, at: T0 + PROMPT_MS },
    ]);
    const after = view(settled, "participant", rival).arcadeMine?.gganbu;
    assert.equal(after?.rivalTokens, START_TOKENS + 5);
    assert.equal(after?.rivalCommitted, false, "and the new prompt is open");
  });

  it("tells the console who has wagered and never what they wagered", () => {
    const state = wagering([
      { event: { type: "wager", pid: "p1", pick: "over", amount: 5 }, at: T0 + 500 },
    ]);
    const extras = view(state, "host").hostExtras?.arcade;
    assert.deepEqual(extras?.answeredBy, ["p1"]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The answer key never leaves the server                           */
/* ------------------------------------------------------------------ */

describe("the answers stay on the server until the reveal", () => {
  it("keeps the key out of a phone's and the screen's frame while the Floor is open", () => {
    const state = wagering();
    for (const role of ["participant", "screen"] as const) {
      const frame = wire(state, role, "p1");
      for (const s of KEY_STRINGS) {
        assert.ok(!frame.includes(s), `${role} was sent ${s}`);
      }
      assert.ok(!frame.includes('"recap"'), `${role} was sent a recap`);
      assert.ok(!frame.includes('"verify"'), `${role} was sent the VERIFY flag`);
      // `"answer"` would be a `GganbuAnswer` on the wire. The participant's
      // Recruitment recap uses the same key name, and this round is not it.
      assert.ok(!frame.includes('"answer"'), `${role} was sent an answer`);
    }
  });

  it("gives the host the answers throughout, because the host reads them out", () => {
    const g = gganbuOf(wagering(), "host");
    assert.equal(g.recap?.length, PROMPTS.length);
    assert.deepEqual(g.recap?.[0], {
      cue: PROMPTS[0]!.cue,
      threshold: PROMPTS[0]!.threshold,
      answer: "over",
      note: PROMPTS[0]!.note,
      verify: false,
    });
    assert.equal(g.recap?.[1]?.verify, true);
  });

  it("releases the answers to the room at the reveal, without the VERIFY flag", () => {
    const revealed = replay(wagering(), [
      { event: { type: "endRound" }, at: T0 + 3 * PROMPT_MS },
      { event: { type: "revealRound" }, at: T0 + 3 * PROMPT_MS + 1 },
    ]);
    for (const role of ["participant", "screen"] as const) {
      const g = gganbuOf(revealed, role, "p1");
      assert.equal(g.recap?.length, PROMPTS.length, `${role}: no recap at the reveal`);
      assert.equal(g.recap?.[1]?.answer, "under");
      assert.equal(g.recap?.[1]?.note, PROMPTS[1]!.note);
      // The flag is the author's own doubt, and a flag beside a settled prompt
      // is a hint that the note about to be read out might be wrong. Omitted,
      // not falsed, so it is not in the bytes.
      assert.equal(g.recap?.[1]?.verify, undefined, `${role} was given VERIFY`);
      assert.ok(
        !wire(revealed, role, "p1").includes('"verify"'),
        `${role} has the flag in the bytes`,
      );
    }
    assert.equal(gganbuOf(revealed, "host").recap?.[1]?.verify, true);
  });

  it("holds the open prompt back while the round card is up", () => {
    // The room is looking at the card, and a prompt sitting in a phone's JSON
    // fifteen seconds early is fifteen seconds of thinking that whoever has
    // devtools open gets and nobody else does.
    const card = entered([START]);
    for (const role of ["participant", "screen"] as const) {
      const g = gganbuOf(card, role, "p1");
      assert.equal(g.prompt, undefined, `${role} has the prompt off the card`);
      assert.equal(g.of, PROMPTS.length, `${role}: the length is announced`);
      assert.equal(g.startTokens, START_TOKENS);
    }
    // The host has it, because the host is about to read it out.
    assert.equal(gganbuOf(card, "host").prompt?.cue, PROMPTS[0]!.cue);
  });

  it("omits the deadline while the round card is up, for every role including the host", () => {
    // The play state carries a zero until `beginPlay`, and a surface handed a
    // zero draws a countdown that expired in 1970 at a room looking at a card.
    for (const role of ["participant", "screen", "host"] as const) {
      assert.equal(
        gganbuOf(entered([START]), role, "p1").promptEndsAt,
        undefined,
        `${role} was handed a zero deadline`,
      );
    }
    for (const role of ["participant", "screen", "host"] as const) {
      assert.equal(
        gganbuOf(wagering(), role, "p1").promptEndsAt,
        T0 + PROMPT_MS,
        `${role} has no deadline once the Floor is open`,
      );
    }
  });

  it("sends the cue and the threshold once the Floor opens, and nothing else of the prompt", () => {
    const g = gganbuOf(wagering(), "participant", "p1");
    assert.deepEqual(g.prompt, {
      cue: PROMPTS[0]!.cue,
      threshold: PROMPTS[0]!.threshold,
    });
    assert.equal(g.at, 0);
    assert.equal(g.secondsPerPrompt, PROMPT_MS / 1000);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Who draws the room                                               */
/* ------------------------------------------------------------------ */

describe("the room's shape goes to the surfaces that draw the room", () => {
  it("keeps the token map, the pairs and the leader off a phone", () => {
    // A phone shows one person's round, and theirs plus their gganbu's is what
    // one person's round is — the same line `planApply.finishOrder` draws.
    const g = gganbuOf(wagering(), "participant", "p1");
    assert.equal(g.tokens, undefined);
    assert.equal(g.richest, undefined);
    assert.equal(g.pairs, undefined);
    assert.equal(g.housed, undefined);
  });

  it("gives the screen and the console the settled counts and the leader", () => {
    const settled = replay(
      wagering([
        { event: { type: "wager", pid: "p1", pick: "over", amount: 5 }, at: T0 + 500 },
      ]),
      [{ event: { type: "nextPrompt" }, at: T0 + PROMPT_MS }],
    );
    for (const role of ["screen", "host"] as const) {
      const g = gganbuOf(settled, role);
      assert.equal(g.tokens?.["p1"], START_TOKENS + 5, `${role}: no counts`);
      assert.equal(g.tokens?.["p2"], START_TOKENS);
      // p1 is alone at the top; the projection names player numbers, not pids.
      assert.deepEqual(g.richest, [1], `${role}: no leader`);
      assert.equal(g.pairs?.["p1"], RIVALS["p1"], `${role}: no pairs`);
      assert.deepEqual(g.housed, [], `${role}: no housed list`);
    }
  });

  it("gives a phone its own gganbu as a pid, and resolves nothing for it", () => {
    // `grid` already carries pid -> player number on every surface and the
    // roster carries the nicknames, so a second copy here would be a second
    // place for the same name to disagree.
    const mine = view(wagering(), "participant", "p1").arcadeMine?.gganbu;
    assert.equal(mine?.rival, RIVALS["p1"]);
    assert.equal(mine?.tokens, START_TOKENS);
    assert.equal(mine?.revoked, false);
    const grid = view(wagering(), "participant", "p1").arcade?.grid ?? [];
    assert.ok(
      grid.some((c) => c.pid === RIVALS["p1"]),
      "the grid cannot resolve the rival's number",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. The frames                                                       */
/* ------------------------------------------------------------------ */

describe("Gganbu's frames", () => {
  it("decodes a wager, and carries no instant even when one is offered", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        t: "arcade.wager",
        cid: "c1",
        round: 3,
        pick: "under",
        amount: 5,
        at: 9,
        prompt: 2,
      }),
    );
    assert.deepEqual(parsed, {
      t: "arcade.wager",
      cid: "c1",
      round: 3,
      pick: "under",
      amount: 5,
    });
  });

  it("refuses a malformed wager rather than defaulting it", () => {
    for (const bad of [
      // no cid: there is nothing to ack or refuse on.
      '{"t":"arcade.wager","round":0,"pick":"over","amount":1}',
      '{"t":"arcade.wager","cid":"c1","pick":"over","amount":1}',
      '{"t":"arcade.wager","cid":"c1","round":-1,"pick":"over","amount":1}',
      '{"t":"arcade.wager","cid":"c1","round":0.5,"pick":"over","amount":1}',
      // a third side is not a wrong bet, it is bytes that are not a frame.
      '{"t":"arcade.wager","cid":"c1","round":0,"pick":"sideways","amount":1}',
      '{"t":"arcade.wager","cid":"c1","round":0,"pick":true,"amount":1}',
      '{"t":"arcade.wager","cid":"c1","round":0,"amount":1}',
      // nought is not a stake, a fraction is not a count of tokens, and a
      // negative one must never reach the arithmetic that settles a prompt.
      '{"t":"arcade.wager","cid":"c1","round":0,"pick":"over","amount":0}',
      '{"t":"arcade.wager","cid":"c1","round":0,"pick":"over","amount":-5}',
      '{"t":"arcade.wager","cid":"c1","round":0,"pick":"over","amount":2.5}',
      '{"t":"arcade.wager","cid":"c1","round":0,"pick":"over","amount":"5"}',
      '{"t":"arcade.wager","cid":"c1","round":0,"pick":"over"}',
    ]) {
      assert.equal(parseClientMessage(bad), null, bad);
    }
  });

  it("lets a stake above the ceiling through, because only the engine knows the hand", () => {
    // One to five, and never more than they hold: both halves of that rule
    // need the hand, so the decoder checks the shape and the engine answers
    // with `invalid_wager` and the real ceiling in the message.
    const parsed = parseClientMessage(
      '{"t":"arcade.wager","cid":"c1","round":0,"pick":"over","amount":99}',
    );
    assert.equal(parsed?.t, "arcade.wager");
  });

  it("takes the two numbers from the console and the prompts from nowhere", () => {
    // An `OverUnderItem` carries the answer, the reveal note and the VERIFY
    // flag, so six prompts arriving from a browser would be the answer key
    // arriving from a browser. The seed is dropped for the reason Tug of
    // Raft's is: a seed a console chose is a console that can deal somebody
    // their gganbu.
    const ok = parseClientMessage(
      JSON.stringify({
        t: "host.cmd",
        cid: "c1",
        cmd: {
          name: "arcade.round",
          kind: "gganbu",
          secondsPerPrompt: 15,
          startTokens: 10,
          prompts: PROMPTS,
          seed: 7,
        },
      }),
    );
    assert.deepEqual(ok?.t === "host.cmd" ? ok.cmd : null, {
      name: "arcade.round",
      kind: "gganbu",
      secondsPerPrompt: 15,
      startTokens: 10,
    });
    const frame = JSON.stringify(ok);
    for (const s of KEY_STRINGS) {
      assert.ok(!frame.includes(s), `${s} survived the decoder`);
    }
    assert.ok(!frame.includes('"seed"'), "a console-chosen seed survived");
  });

  it("refuses a round config that is missing a number or has a useless one", () => {
    for (const bad of [
      { name: "arcade.round", kind: "gganbu", secondsPerPrompt: 15 },
      { name: "arcade.round", kind: "gganbu", startTokens: 10 },
      { name: "arcade.round", kind: "gganbu", secondsPerPrompt: 0, startTokens: 10 },
      { name: "arcade.round", kind: "gganbu", secondsPerPrompt: 15, startTokens: 0 },
      { name: "arcade.round", kind: "gganbu", secondsPerPrompt: 15.5, startTokens: 10 },
      { name: "arcade.round", kind: "gganbu", secondsPerPrompt: 15, startTokens: -1 },
      { name: "arcade.round", kind: "gganbu" },
    ]) {
      const parsed = parseClientMessage(
        JSON.stringify({ t: "host.cmd", cid: "c1", cmd: bad }),
      );
      assert.equal(
        parsed?.t === "host.cmd" ? parsed.cmd : "?",
        null,
        JSON.stringify(bad),
      );
    }
  });

  it("parses the control that settles a prompt", () => {
    const parsed = parseClientMessage(
      JSON.stringify({ t: "host.cmd", cid: "c1", cmd: { name: "arcade.nextPrompt" } }),
    );
    assert.deepEqual(parsed?.t === "host.cmd" ? parsed.cmd : null, {
      name: "arcade.nextPrompt",
    });
  });
});

/* ------------------------------------------------------------------ */
/* 5. The wager at the socket boundary                                 */
/* ------------------------------------------------------------------ */

describe("a wager at the socket boundary", () => {
  function running(): ReturnType<SessionRegistry["add"]>["runtime"] {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(entered(), T0);
    runtime.apply(START, T0);
    runtime.apply({ type: "beginPlay" }, T0);
    return runtime;
  }

  it("lands the stake in the engine", () => {
    const runtime = running();
    runtime.clearArcadeTimers();
    const client = fakeClient("p1", [20, 20, 20]);
    runtime.clients.add(client);
    const out = runtime.wager(client, 0, "over", 4, T0 + 1_000);
    assert.equal(out.applied, true);
    const play = runtime.state.arcade?.play;
    assert.deepEqual(
      play?.kind === "gganbu" ? play.wagers["p1"] : null,
      { pick: "over", amount: 4 },
    );
    runtime.clearArcadeTimers();
  });

  it("refuses a stake meant for a round that has moved on", () => {
    // `wager` carries no round id and the prompt resets to 0 at every round,
    // so prompt 0 is precisely the index a stale frame would land on.
    const runtime = running();
    runtime.clearArcadeTimers();
    const client = fakeClient("p1", []);
    runtime.clients.add(client);
    const out = runtime.wager(client, 4, "over", 1, T0 + 1_000);
    assert.equal(out.applied, false);
    assert.equal(out.rejection?.code, "wrong_round_phase");
    runtime.clearArcadeTimers();
  });

  it("refuses a stake from a socket that is not a participant's", () => {
    const runtime = running();
    runtime.clearArcadeTimers();
    const out = runtime.wager(fakeClient(undefined, []), 0, "over", 1, T0 + 1);
    assert.equal(out.applied, false);
    assert.equal(out.rejection?.code, "unknown_participant");
    runtime.clearArcadeTimers();
  });

  it("refuses a stake before the arcade is open", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(
      session([
        { type: "open" },
        { type: "join", pid: "p1", nickname: "Priya" },
        { type: "start" },
      ]),
      T0,
    );
    const out = runtime.wager(fakeClient("p1", []), 0, "over", 1, T0 + 1);
    assert.equal(out.applied, false);
    assert.equal(out.rejection?.code, "not_in_arcade");
    runtime.clearArcadeTimers();
  });

  it("leaves the hand to the engine, with the real ceiling in the message", () => {
    const runtime = running();
    runtime.clearArcadeTimers();
    const client = fakeClient("p1", []);
    runtime.clients.add(client);
    const out = runtime.wager(client, 0, "over", 99, T0 + 1_000);
    assert.equal(out.applied, false);
    assert.equal(out.rejection?.code, "invalid_wager");
    runtime.clearArcadeTimers();
  });

  it("lets a slow link's stake beat the deadline it actually beat", () => {
    // Staked at 14 900 with 100 ms left on their own countdown; the frame
    // lands 100 ms past the close. Corrected by 200 ms it is inside the
    // prompt, which is where the thumb was. The correction can only ever
    // admit a frame here: this round measures no instant and awards nothing
    // for being fast.
    const runtime = running();
    runtime.clearArcadeTimers();
    const slow = fakeClient("p1", [400, 400, 400]);
    runtime.clients.add(slow);
    assert.equal(runtime.wager(slow, 0, "over", 1, T0 + PROMPT_MS + 100).applied, true);
    runtime.clearArcadeTimers();

    const other = running();
    other.clearArcadeTimers();
    const quick = fakeClient("p2", [20, 20, 20]);
    other.clients.add(quick);
    const late = other.wager(quick, 0, "over", 1, T0 + PROMPT_MS + 100);
    assert.equal(late.applied, false);
    assert.equal(late.rejection?.code, "floor_locked");
    other.clearArcadeTimers();
  });
});

/* ------------------------------------------------------------------ */
/* 6. The prompt clock                                                 */
/* ------------------------------------------------------------------ */

describe("the prompt clock", () => {
  function running(): ReturnType<SessionRegistry["add"]>["runtime"] {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(entered(), T0);
    runtime.apply(START, T0);
    runtime.apply({ type: "beginPlay" }, T0);
    return runtime;
  }

  it("walks the prompts itself, and lets the Floor timer alone", () => {
    // Six prompts are six deadlines and six lots of event-loop lag, so a
    // Floor timer armed at the nominal end would land on top of the last
    // prompt with the last wagers of the round unsettled.
    const runtime = running();
    assert.equal(runtime.armedPromptAt, T0 + PROMPT_MS);
    assert.equal(runtime.armedFloorAt, null);
    runtime.apply({ type: "nextPrompt" }, T0 + PROMPT_MS + 300);
    assert.equal(runtime.armedPromptAt, T0 + PROMPT_MS + 300 + PROMPT_MS);
    // `nextPrompt` keeps `endsAt` in step, so the countdown is not the
    // nominal one either.
    assert.equal(
      runtime.state.arcade?.endsAt,
      T0 + PROMPT_MS + 300 + PROMPT_MS + PROMPT_MS,
    );
    assert.equal(runtime.armedFloorAt, null);
    runtime.clearArcadeTimers();
  });

  it("clears the prompt timer when the round ends", () => {
    const runtime = running();
    runtime.apply({ type: "endRound" }, T0 + 5_000);
    assert.equal(runtime.armedPromptAt, null);
    runtime.clearArcadeTimers();
  });

  it("is armed for nothing outside Gganbu", () => {
    const registry = new SessionRegistry();
    const { runtime } = registry.add(entered(), T0);
    runtime.apply(
      {
        type: "startRound",
        round: "plan_apply",
        config: { kind: "plan_apply", target: 10, seconds: 60 },
      },
      T0,
    );
    runtime.apply({ type: "beginPlay" }, T0);
    assert.equal(runtime.armedPromptAt, null);
    runtime.clearArcadeTimers();
  });
});
