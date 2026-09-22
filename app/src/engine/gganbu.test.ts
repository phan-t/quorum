/**
 * Round 4, Gganbu. Every expected number is computed by hand from SPEC.md
 * "#### Round 4 — Gganbu" and the "Arcade scoring summary" table, and never by
 * calling the code under test.
 *
 * Everyone starts on ten tokens, six prompts run at fifteen seconds each, a
 * wager is one to five, and tokens convert 1:1 at the buzzer. A perfect run is
 * 10 + 6 × 5 = 40, and 40 + 10 for finishing above your rival is SPEC's Floor
 * max of 50.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  Activity,
  ArcadeState,
  Effect,
  Event,
  OverUnder,
  ParticipantId,
  RejectCode,
  SessionState,
} from "./types.ts";
import { newSession, reduce } from "./reducer.ts";
import {
  aheadOfRival,
  floorMax,
  gganbuFloorPoints,
  gganbuFloorView,
  gganbuMeView,
  gganbuPairs,
  GGANBU_AHEAD,
  GGANBU_BACKED_AHEAD,
  GGANBU_BACKED_RICHEST,
  GGANBU_MAX_WAGER,
  GGANBU_PROMPT_SECONDS,
  GGANBU_START_TOKENS,
  loungeMax,
  loungePoints,
  richestInTheRoom,
  rivalOf,
  rivalTokens,
  settleGganbuPrompt,
  splitPrompts,
  tokensOf,
} from "./arcade.ts";
import { GGANBU_PROMPTS, gganbuRound } from "../arcade/gganbu.ts";

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

function run(state: SessionState, event: Event, now: number) {
  const snapshot = structuredClone(state);
  deepFreeze(state);
  const result = reduce(state, event, now);
  assert.deepEqual(state, snapshot, `reduce(${event.type}) mutated its input state`);
  return result;
}

function rejects(effects: readonly Effect[]) {
  return effects.filter(
    (e): e is Extract<Effect, { kind: "reject" }> => e.kind === "reject",
  );
}

function accept(state: SessionState, event: Event, now: number): SessionState {
  const r = run(state, event, now);
  assert.equal(r.state.seq, state.seq + 1, `expected ${event.type} to be accepted`);
  assert.ok(!rejects(r.effects).length, `expected ${event.type} not to be rejected`);
  return r.state;
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
  const codes = rejects(r.effects).map((e) => e.code);
  assert.ok(codes.includes(code), `expected ${code}, got [${codes.join(", ")}]`);
}

const ARCADE: Activity = {
  id: "arcade",
  title: "Hashi Arcade",
  kind: "arcade",
  spotCap: 2,
};

const T0 = 1000;
const SEED = 3;
/** Fifteen seconds a prompt. */
const PROMPT = 15_000;

function entered(n: number): SessionState {
  let s = newSession({
    sid: "s",
    title: "Offsite",
    joinCode: "RAFT",
    activities: [ARCADE],
  });
  s = accept(s, { type: "open" }, 10);
  s = accept(s, { type: "start" }, 20);
  for (let i = 1; i <= n; i++) {
    s = accept(s, { type: "join", pid: `p${i}`, nickname: `Player ${i}` }, 100 + i);
  }
  return accept(s, { type: "enterArcade", activityId: "arcade" }, 500);
}

function wagering(n = 4, seed = SEED): SessionState {
  const s = accept(
    entered(n),
    { type: "startRound", round: "gganbu", config: gganbuRound(seed) },
    T0 - 1,
  );
  return accept(s, { type: "beginPlay" }, T0);
}

function arcadeOf(state: SessionState): ArcadeState {
  assert.ok(state.arcade, "expected the arcade to be open");
  return state.arcade;
}

function pot(s: SessionState) {
  const play = arcadeOf(s).play;
  assert.ok(play?.kind === "gganbu", "expected a Gganbu round");
  return play;
}

const banked = (s: SessionState, pid: ParticipantId) => arcadeOf(s).banked[pid] ?? 0;
const total = (s: SessionState, pid: ParticipantId) => arcadeOf(s).totals[pid] ?? 0;
const standing = (s: SessionState, pid: ParticipantId) => arcadeOf(s).standing[pid];

/** The answer to the open prompt. The test may know it; a phone may not. */
function answerAt(s: SessionState): OverUnder {
  const play = pot(s);
  return play.key[play.at]!.answer;
}

const other = (pick: OverUnder): OverUnder => (pick === "over" ? "under" : "over");

/** Wager `amount` on the open prompt, correctly or otherwise. */
function stake(
  s: SessionState,
  pid: ParticipantId,
  amount: number,
  right: boolean,
  at = T0 + 1_000,
): SessionState {
  const pick = right ? answerAt(s) : other(answerAt(s));
  return accept(s, { type: "wager", pid, pick, amount }, at);
}

/** Close the open prompt and open the next one. */
function nextPrompt(s: SessionState): SessionState {
  const play = pot(s);
  return accept(s, { type: "nextPrompt" }, T0 + (play.at + 1) * PROMPT);
}

/* ------------------------------------------------------------------ */
/* Content                                                              */
/* ------------------------------------------------------------------ */

describe("the launch content", () => {
  test("six prompts, fifteen seconds each, ten tokens to start", () => {
    assert.equal(GGANBU_PROMPTS.length, 6);
    assert.equal(GGANBU_PROMPT_SECONDS, 15);
    assert.equal(GGANBU_START_TOKENS, 10);
    assert.deepEqual(gganbuRound(9), {
      kind: "gganbu",
      prompts: GGANBU_PROMPTS,
      secondsPerPrompt: 15,
      startTokens: 10,
      seed: 9,
    });
  });

  test("exactly three are flagged VERIFY, and they are the three dates", () => {
    // SPEC.md: "three are flagged VERIFY exactly as the trivia bank flags
    // dates". The flags are not decoration — they are the three whose answers
    // turn on a release year rather than on a port number.
    const flagged = GGANBU_PROMPTS.filter((p) => p.verify);
    assert.equal(flagged.length, 3);
    assert.deepEqual(flagged.map((p) => p.cue), [
      "Vagrant's first public release",
      "Terraform's first release",
      "The year Terraform reached 1.0",
    ]);
    for (const p of flagged) {
      assert.match(p.threshold, /^\d{4}$/, "a flagged prompt turns on a year");
    }
  });

  test("every prompt has a cue, a threshold, an answer and a note", () => {
    for (const p of GGANBU_PROMPTS) {
      assert.ok(p.cue.trim() !== "", "a prompt with no question");
      assert.ok(p.threshold.trim() !== "", `${p.cue} has no threshold`);
      assert.ok(p.note.trim() !== "", `${p.cue} has no note`);
      assert.ok(p.answer === "over" || p.answer === "under");
    }
  });

  test("the answers are not all one way, and do not alternate", () => {
    const answers = GGANBU_PROMPTS.map((p) => p.answer);
    assert.equal(answers.filter((a) => a === "over").length, 3);
    assert.equal(answers.filter((a) => a === "under").length, 3);
    const alternating = answers.every(
      (a, i) => i === 0 || a !== answers[i - 1],
    );
    assert.ok(!alternating, "a player who spots a pattern has stopped reading");
  });

  test("splitting content leaves the answer on one side of the line", () => {
    const { board, key } = splitPrompts(GGANBU_PROMPTS);
    assert.deepEqual(board[0], {
      cue: "Vault's default API port",
      threshold: "8000",
    });
    assert.deepEqual(key[0], {
      answer: "over",
      note: GGANBU_PROMPTS[0]!.note,
      verify: false,
    });
    for (const shown of board) {
      assert.deepEqual(Object.keys(shown).sort(), ["cue", "threshold"]);
    }
  });

  test("a round with no prompts, no stake or no seed is refused", () => {
    const s = entered(2);
    for (const config of [
      { kind: "gganbu", prompts: [], secondsPerPrompt: 15, startTokens: 10, seed: 1 },
      {
        kind: "gganbu",
        prompts: GGANBU_PROMPTS,
        secondsPerPrompt: 0,
        startTokens: 10,
        seed: 1,
      },
      {
        kind: "gganbu",
        prompts: GGANBU_PROMPTS,
        secondsPerPrompt: 15,
        startTokens: 0,
        seed: 1,
      },
      {
        kind: "gganbu",
        prompts: GGANBU_PROMPTS,
        secondsPerPrompt: 15,
        startTokens: 10,
        seed: Infinity,
      },
    ] as const) {
      assertRefused(
        s,
        run(s, { type: "startRound", round: "gganbu", config }, T0),
        "invalid_round_config",
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* Pairing                                                              */
/* ------------------------------------------------------------------ */

describe("you have been paired", () => {
  test("pairs are symmetrical and nobody is paired with themselves", () => {
    for (const n of [2, 4, 8, 27, 60]) {
      const pids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
      const pairs = gganbuPairs(pids, 4);
      for (const [pid, rival] of Object.entries(pairs)) {
        assert.notEqual(pid, rival);
        assert.equal(pairs[rival], pid, `${pid} and ${rival} disagree`);
      }
      assert.equal(Object.keys(pairs).length, n - (n % 2));
    }
  });

  test("an odd roster leaves exactly one player facing the house", () => {
    const s = wagering(5);
    const play = pot(s);
    const housed = ["p1", "p2", "p3", "p4", "p5"].filter(
      (pid) => rivalOf(play, pid) === null,
    );
    assert.equal(housed.length, 1);
    // The house holds the opening stake and never wagers. Beating it is
    // beating a rival who stood still, which is no harder and no easier.
    assert.equal(rivalTokens(play, housed[0]!), 10);
  });

  test("a roster of one is a room of one player and the house", () => {
    const s = wagering(1);
    assert.equal(rivalOf(pot(s), "p1"), null);
    assert.equal(rivalTokens(pot(s), "p1"), 10);
    assert.equal(aheadOfRival(pot(s), "p1"), false, "level pays nobody");
  });

  test("an empty roster starts a round with nothing in it", () => {
    const s = wagering(0);
    assert.deepEqual(pot(s).rivals, {});
    assert.deepEqual(pot(s).tokens, {});
    assert.deepEqual(richestInTheRoom(pot(s)), []);
  });

  test("the same seed draws the same pairs", () => {
    const pids = ["p1", "p2", "p3", "p4"];
    assert.deepEqual(gganbuPairs(pids, 77), gganbuPairs(pids, 77));
  });
});

/* ------------------------------------------------------------------ */
/* Wagering                                                             */
/* ------------------------------------------------------------------ */

describe("the wager", () => {
  test("one to five tokens, and never more than you hold", () => {
    const s = wagering(4);
    assert.equal(tokensOf(pot(s), "p1"), 10);
    for (const amount of [0, -1, 6, 1.5, Number.NaN]) {
      assertRefused(
        s,
        run(s, { type: "wager", pid: "p1", pick: "over", amount }, T0 + 100),
        "invalid_wager",
      );
    }
    assertRefused(
      s,
      run(
        s,
        { type: "wager", pid: "p1", pick: "sideways" as OverUnder, amount: 1 },
        T0 + 100,
      ),
      "invalid_choice",
    );
  });

  test("a wager of more than you hold is refused", () => {
    // p1 loses down to three, and can then stake at most three.
    let s = wagering(4);
    s = stake(s, "p1", 5, false);
    s = nextPrompt(s);
    s = stake(s, "p1", 2, false, T0 + PROMPT + 100);
    s = nextPrompt(s);
    assert.equal(tokensOf(pot(s), "p1"), 3);
    assertRefused(
      s,
      run(s, { type: "wager", pid: "p1", pick: "over", amount: 4 }, T0 + 2 * PROMPT + 100),
      "invalid_wager",
    );
    s = stake(s, "p1", 3, true, T0 + 2 * PROMPT + 100);
    assert.equal(pot(s).wagers["p1"]?.amount, 3);
  });

  test("one wager a prompt, and no change of mind", () => {
    let s = wagering(4);
    s = stake(s, "p1", 2, true);
    assertRefused(
      s,
      run(s, { type: "wager", pid: "p1", pick: "over", amount: 1 }, T0 + 2_000),
      "already_answered_item",
    );
  });

  test("outside the arcade, and outside this round, a wager is refused", () => {
    let s = newSession({
      sid: "s",
      title: "Offsite",
      joinCode: "RAFT",
      activities: [ARCADE],
    });
    s = accept(s, { type: "open" }, 10);
    s = accept(s, { type: "start" }, 20);
    s = accept(s, { type: "join", pid: "p1", nickname: "Player 1" }, 30);
    assertRefused(
      s,
      run(s, { type: "wager", pid: "p1", pick: "over", amount: 1 }, T0),
      "not_in_arcade",
    );
    const e = entered(2);
    assertRefused(
      e,
      run(e, { type: "wager", pid: "p1", pick: "over", amount: 1 }, T0),
      "wrong_round_phase",
    );
    assertRefused(e, run(e, { type: "nextPrompt" }, T0), "wrong_round_phase");
    const playing = wagering(4);
    assertRefused(
      playing,
      run(playing, { type: "wager", pid: "ghost", pick: "over", amount: 1 }, T0 + 10),
      "unknown_participant",
    );
  });

  test("a wager after the prompt has closed is refused", () => {
    const s = wagering(4);
    assert.equal(pot(s).promptEndsAt, T0 + PROMPT);
    assertRefused(
      s,
      run(s, { type: "wager", pid: "p1", pick: "over", amount: 1 }, T0 + PROMPT),
      "floor_locked",
    );
  });

  test("the round's clocks", () => {
    const s = wagering(4);
    // Six prompts at fifteen seconds: ninety seconds of Floor.
    assert.equal(arcadeOf(s).endsAt, T0 + 6 * PROMPT);
    const next = nextPrompt(s);
    assert.equal(pot(next).at, 1);
    assert.equal(pot(next).promptEndsAt, T0 + 2 * PROMPT);
    // Re-derived from the prompt that is actually open, so event-loop lag
    // does not eat the last prompt's tail.
    assert.equal(arcadeOf(next).endsAt, T0 + 2 * PROMPT + 4 * PROMPT);
  });
});

/* ------------------------------------------------------------------ */
/* Settlement                                                           */
/* ------------------------------------------------------------------ */

describe("settling a prompt", () => {
  test("right gains the wager, wrong loses it, and no wager loses nothing", () => {
    let s = wagering(4);
    s = stake(s, "p1", 5, true);
    s = stake(s, "p2", 3, false);
    // p3 says nothing at all.
    s = nextPrompt(s);
    assert.equal(tokensOf(pot(s), "p1"), 15);
    assert.equal(tokensOf(pot(s), "p2"), 7);
    assert.equal(tokensOf(pot(s), "p3"), 10, "no answer is not a wrong answer");
    assert.deepEqual(pot(s).wagers, {}, "the wagers are per prompt");
  });

  test("tokens do not move until the prompt closes", () => {
    // The round's whole secrecy rule. Both halves of a pair answer the same
    // prompt with the rival's token count on screen throughout, so a count
    // that moved when a wager was judged would be the answer arriving early.
    let s = wagering(4);
    const before = { ...pot(s).tokens };
    s = stake(s, "p1", 5, true);
    s = stake(s, "p2", 5, false);
    assert.deepEqual(pot(s).tokens, before, "not one token has moved");
    s = nextPrompt(s);
    assert.notDeepEqual(pot(s).tokens, before);
  });

  test("reaching zero revokes the token and drains the player", () => {
    let s = wagering(4);
    // Ten down to nothing: 5, 5.
    s = stake(s, "p1", 5, false);
    s = nextPrompt(s);
    assert.equal(standing(s, "p1"), "floor");
    s = stake(s, "p1", 5, false, T0 + PROMPT + 100);
    s = nextPrompt(s);
    assert.equal(tokensOf(pot(s), "p1"), 0);
    assert.equal(standing(s, "p1"), "drained");
    assert.deepEqual(arcadeOf(s).lounge["p1"], {
      backing: null,
      at: T0 + 2 * PROMPT,
    });
    assertRefused(
      s,
      run(s, { type: "wager", pid: "p1", pick: "over", amount: 1 }, T0 + 2 * PROMPT + 100),
      "not_on_the_floor",
    );
  });

  test("settleGganbuPrompt, on its own, with the numbers written out", () => {
    const s = wagering(4);
    const play = {
      ...pot(s),
      tokens: { p1: 10, p2: 4, p3: 1 },
      wagers: {
        p1: { pick: answerAt(s), amount: 5 },
        p2: { pick: other(answerAt(s)), amount: 4 },
        p3: { pick: other(answerAt(s)), amount: 1 },
      },
    };
    const settled = settleGganbuPrompt(play);
    assert.deepEqual(settled.tokens, { p1: 15, p2: 0, p3: 0 });
    assert.deepEqual([...settled.revoked].sort(), ["p2", "p3"]);
  });
});

/* ------------------------------------------------------------------ */
/* The house                                                            */
/* ------------------------------------------------------------------ */

describe("the house", () => {
  test("a rival who disconnects is replaced by the house", () => {
    let s = wagering(4);
    const rival = rivalOf(pot(s), "p1");
    assert.ok(rival !== null);
    // The rival builds a lead and then their phone dies.
    s = stake(s, rival, 5, true);
    s = nextPrompt(s);
    assert.equal(rivalTokens(pot(s), "p1"), 15);
    s = accept(s, { type: "disconnect", pid: rival }, T0 + PROMPT + 100);
    assert.equal(rivalOf(pot(s), "p1"), null, "they are playing the house now");
    assert.equal(rivalTokens(pot(s), "p1"), 10, "which holds the opening stake");
    // And it stays that way if they come back: their gganbu has spent the
    // round playing somebody else.
    s = accept(s, { type: "reconnect", pid: rival }, T0 + PROMPT + 200);
    assert.equal(rivalOf(pot(s), "p1"), null);
    // The pair dissolves for both of them. One-sided housing lets the two
    // halves' comparisons disagree — on twelve against eleven it pays both
    // the +10, and on eight against nine it pays neither — so the rule is
    // "if your gganbu leaves, you both play the house".
    assert.equal(rivalOf(pot(s), rival), null);
    assert.equal(rivalTokens(pot(s), rival), 10);
  });

  test("housing a pair is written down, not just broadcast", () => {
    // The runtime persists only when the engine asks, and it deliberately
    // never persists a bare connection change. A pair dissolving is not a
    // connection change: it moves what two people's +10 is measured against,
    // so a restart must not un-house them.
    let s = wagering(4);
    const rival = rivalOf(pot(s), "p1");
    assert.ok(rival !== null);
    const r = run(s, { type: "disconnect", pid: rival }, T0 + 100);
    assert.ok(r.effects.some((e) => e.kind === "persist"));
    assert.ok(
      r.effects.some(
        (e) =>
          e.kind === "broadcast" &&
          typeof e.to === "object" &&
          e.to.pid === "p1",
      ),
      "the player left behind is told their rival is gone",
    );
    // An ordinary disconnection, with no pair to dissolve, still persists
    // nothing and still tells nobody but the host.
    const ended = accept(s, { type: "endRound" }, T0 + 6 * PROMPT);
    const plain = run(ended, { type: "disconnect", pid: "p2" }, T0 + 6 * PROMPT + 10);
    assert.ok(!plain.effects.some((e) => e.kind === "persist"));
    assert.deepEqual(plain.effects, [
      { kind: "broadcast", to: "host", what: "state" },
    ]);
  });

  test("releasing a nickname houses the pair too", () => {
    let s = wagering(4);
    const rival = rivalOf(pot(s), "p1");
    assert.ok(rival !== null);
    s = accept(s, { type: "releaseNickname", pid: rival }, T0 + 100);
    assert.equal(rivalOf(pot(s), "p1"), null);
  });

  test("a latecomer who wagers is dealt in and converts", () => {
    let s = wagering(3);
    s = accept(s, { type: "join", pid: "p9", nickname: "Late" }, T0 + 500);
    s = stake(s, "p9", 5, true, T0 + 1_000);
    for (let i = 0; i < 5; i++) s = nextPrompt(s);
    s = accept(s, { type: "endRound" }, T0 + 6 * PROMPT);
    // Fifteen tokens, and no rival was drawn for them, so they are playing
    // the house's ten: 15 + 10.
    assert.equal(rivalOf(pot(s), "p9"), null);
    assert.equal(banked(s, "p9"), 25);
    assert.equal(total(s, "p9"), 25, "and it reaches the arcade total");
  });

  test("a rival who is kicked is replaced too", () => {
    let s = wagering(4);
    const rival = rivalOf(pot(s), "p1");
    assert.ok(rival !== null);
    s = accept(s, { type: "kick", pid: rival }, T0 + 100);
    assert.equal(rivalOf(pot(s), "p1"), null);
  });

  test("a rival who was already gone when the pairs were drawn", () => {
    let s = entered(4);
    s = accept(s, { type: "disconnect", pid: "p2" }, 600);
    s = accept(
      s,
      { type: "startRound", round: "gganbu", config: gganbuRound(SEED) },
      T0 - 1,
    );
    s = accept(s, { type: "beginPlay" }, T0);
    const rival = pot(s).rivals["p2"];
    assert.ok(rival !== undefined);
    assert.equal(rivalOf(pot(s), rival), null, "paired with a phone that is not there");
  });

  test("a disconnection outside a Gganbu round changes nothing", () => {
    const s = wagering(4);
    const ended = accept(s, { type: "endRound" }, T0 + 6 * PROMPT);
    const after = run(ended, { type: "disconnect", pid: "p2" }, T0 + 6 * PROMPT + 10);
    assert.deepEqual(after.state.arcade?.play, ended.arcade?.play);
  });
});

/* ------------------------------------------------------------------ */
/* Conversion                                                           */
/* ------------------------------------------------------------------ */

describe("the buzzer", () => {
  test("tokens convert 1:1, plus 10 for finishing above your rival", () => {
    let s = wagering(4);
    const rival = rivalOf(pot(s), "p1");
    assert.ok(rival !== null);
    // p1 wins five on the first prompt and stands pat after that.
    s = stake(s, "p1", 5, true);
    for (let i = 0; i < 5; i++) s = nextPrompt(s);
    assert.equal(pot(s).at, 5, "the sixth prompt is open");
    s = accept(s, { type: "endRound" }, T0 + 6 * PROMPT);
    // 15 tokens, and 15 > the rival's untouched 10.
    assert.equal(banked(s, "p1"), 25);
    assert.equal(banked(s, rival), 10, "ten tokens, and level with nobody");
    assert.equal(total(s, "p1"), 25);
  });

  test("the sixth prompt settles at the end, like the bridge's last step", () => {
    let s = wagering(4);
    for (let i = 0; i < 5; i++) s = nextPrompt(s);
    s = stake(s, "p1", 5, true, T0 + 5 * PROMPT + 100);
    s = stake(s, "p2", 5, false, T0 + 5 * PROMPT + 100);
    s = accept(s, { type: "endRound" }, T0 + 6 * PROMPT);
    assert.equal(tokensOf(pot(s), "p1"), 15);
    assert.equal(tokensOf(pot(s), "p2"), 5);
    assertRefused(
      s,
      run(s, { type: "nextPrompt" }, T0 + 6 * PROMPT + 10),
      "wrong_round_phase",
    );
  });

  test("a revoked player converts nothing", () => {
    let s = wagering(4);
    s = stake(s, "p1", 5, false);
    s = nextPrompt(s);
    s = stake(s, "p1", 5, false, T0 + PROMPT + 100);
    s = nextPrompt(s);
    assert.equal(standing(s, "p1"), "drained");
    s = accept(s, { type: "endRound" }, T0 + 6 * PROMPT);
    assert.equal(banked(s, "p1"), 0);
    assert.equal(total(s, "p1"), 0, "played and scored nothing is still played");
  });

  test("a perfect run is SPEC's 50, and the arithmetic says so twice", () => {
    assert.equal(floorMax(gganbuRound(1)), 50);
    assert.equal(
      GGANBU_START_TOKENS + 6 * GGANBU_MAX_WAGER + GGANBU_AHEAD,
      50,
    );
    let s = wagering(2);
    for (let i = 0; i < 6; i++) {
      s = stake(s, "p1", 5, true, T0 + i * PROMPT + 100);
      if (i < 5) s = nextPrompt(s);
    }
    s = accept(s, { type: "endRound" }, T0 + 6 * PROMPT);
    assert.equal(banked(s, "p1"), 50, "40 tokens and the 10 for being ahead");
  });

  test("gganbuFloorPoints, by hand", () => {
    const s = wagering(4);
    const play = { ...pot(s), tokens: { p1: 12, p2: 12, p3: 3 }, rivals: { p1: "p2", p2: "p1" } };
    assert.equal(gganbuFloorPoints(play, "p1"), 12, "level pays nobody the 10");
    assert.equal(gganbuFloorPoints(play, "p3"), 3, "three tokens, and the house holds ten");
    const ahead = { ...play, tokens: { p1: 13, p2: 12, p3: 3 } };
    assert.equal(gganbuFloorPoints(ahead, "p1"), 23);
  });
});

/* ------------------------------------------------------------------ */
/* The Lounge                                                           */
/* ------------------------------------------------------------------ */

describe("the Lounge", () => {
  /** p1 is revoked on the second prompt; everybody else is still playing. */
  function revoked(): SessionState {
    let s = wagering(4);
    s = stake(s, "p1", 5, false);
    s = nextPrompt(s);
    s = stake(s, "p1", 5, false, T0 + PROMPT + 100);
    s = nextPrompt(s);
    assert.equal(standing(s, "p1"), "drained");
    return s;
  }

  test("backing a player who finishes above their rival pays 5", () => {
    let s = revoked();
    const play = {
      ...pot(s),
      tokens: { p1: 0, p2: 12, p3: 11, p4: 9 },
      rivals: { p2: "p3", p3: "p2" },
      housed: {},
    };
    // p2 is ahead of p3, and p2 also holds the most in the room: the better of
    // the two, which is 8, and never 13.
    assert.equal(loungePoints(play, "p2", "floor"), GGANBU_BACKED_RICHEST);
    // p3 is behind p2 but ahead of nothing, so p3 pays nothing.
    assert.equal(loungePoints(play, "p3", "floor"), 0);
    // p4 has no rival left and so plays the house's ten. Nine is not ten.
    assert.equal(loungePoints(play, "p4", "floor"), 0);
    const p4ahead = { ...play, tokens: { p1: 0, p2: 12, p3: 11, p4: 11 } };
    assert.equal(loungePoints(p4ahead, "p4", "floor"), GGANBU_BACKED_AHEAD);
  });

  test("a tie at the top pays every backer who picked one of them", () => {
    const s = revoked();
    const play = { ...pot(s), tokens: { p1: 0, p2: 12, p3: 12, p4: 9 } };
    assert.deepEqual(richestInTheRoom(play), ["p2", "p3"]);
    assert.equal(loungePoints(play, "p2", "floor"), GGANBU_BACKED_RICHEST);
    assert.equal(loungePoints(play, "p3", "floor"), GGANBU_BACKED_RICHEST);
  });

  test("a revoked player pays their backer nothing at all", () => {
    const s = revoked();
    assert.equal(loungePoints(pot(s), "p1", "drained"), 0);
    // And they cannot be backed in the first place.
    const r = run(
      s,
      { type: "backPlayer", pid: "p1", backing: "p1" },
      T0 + 2 * PROMPT + 100,
    );
    assert.ok(rejects(r.effects).some((e) => e.code === "cannot_back_yourself"));
  });

  test("the Lounge is paid at the end, out of the settled tokens", () => {
    let s = revoked();
    s = accept(
      s,
      { type: "backPlayer", pid: "p1", backing: "p2" },
      T0 + 2 * PROMPT + 100,
    );
    // p2 takes five off the third prompt and coasts.
    s = stake(s, "p2", 5, true, T0 + 2 * PROMPT + 200);
    for (let i = 2; i < 5; i++) s = nextPrompt(s);
    s = accept(s, { type: "endRound" }, T0 + 6 * PROMPT);
    assert.equal(tokensOf(pot(s), "p2"), 15);
    assert.deepEqual(richestInTheRoom(pot(s)), ["p2"]);
    assert.equal(banked(s, "p1"), 8, "backed the richest player in the room");
    assert.equal(total(s, "p1"), 8);
  });

  test("standing still on the Floor beats a perfect Lounge", () => {
    // The tuning rule, checked rather than asserted in a comment. Tokens
    // convert 1:1 and everybody starts on ten, so a player who wagers nothing
    // all round converts 10; the cheapest *win* is one token against a revoked
    // rival's nothing, which is 11. A perfect Lounge is 8, and 8 is under
    // both. SPEC's table still says 25, which predates the rule that the two
    // awards do not stack.
    assert.equal(loungeMax("gganbu"), 8);
    assert.ok(loungeMax("gganbu") < GGANBU_START_TOKENS);
    assert.ok(loungeMax("gganbu") < 1 + GGANBU_AHEAD);
    assert.equal(
      loungeMax("gganbu"),
      Math.max(GGANBU_BACKED_AHEAD, GGANBU_BACKED_RICHEST),
    );
    assert.notEqual(
      loungeMax("gganbu"),
      GGANBU_BACKED_AHEAD + GGANBU_BACKED_RICHEST,
    );
    assert.ok(loungeMax("gganbu") > 0, "and it is still worth having");
  });
});

/* ------------------------------------------------------------------ */
/* Leaks                                                                */
/* ------------------------------------------------------------------ */

describe("what a gganbu may know", () => {
  test("a rival's pick and stake are secret until the prompt settles", () => {
    let s = wagering(4);
    const rival = rivalOf(pot(s), "p1")!;
    s = stake(s, rival, 5, true);
    const mine = gganbuMeView(arcadeOf(s), pot(s), "p1");
    // What p1 may learn: that their rival has locked in. That is the same line
    // trivia draws between "24 of 27 answered" and the answers themselves.
    assert.equal(mine.rivalCommitted, true);
    assert.equal(mine.rivalTokens, 10, "the settled count, which has not moved");
    assert.equal(mine.committed, false);
    assert.equal(mine.wager, null);
    // And what they may not: the pick, or the stake, in any field at all.
    assert.deepEqual(Object.keys(mine).sort(), [
      "committed",
      "revoked",
      "rival",
      "rivalCommitted",
      "rivalTokens",
      "tokens",
      "wager",
    ]);
  });

  test("your own wager is yours, because you made it", () => {
    let s = wagering(4);
    s = stake(s, "p1", 4, true);
    const mine = gganbuMeView(arcadeOf(s), pot(s), "p1");
    assert.equal(mine.committed, true);
    assert.deepEqual(mine.wager, { pick: answerAt(s), amount: 4 });
  });

  test("the public view counts wagers and never reads one", () => {
    let s = wagering(4);
    s = stake(s, "p1", 5, true);
    s = stake(s, "p2", 1, false);
    const view = gganbuFloorView(pot(s));
    assert.equal(view.wagered, 2);
    assert.deepEqual(view.prompt, {
      cue: "Vault's default API port",
      threshold: "8000",
    });
    assert.deepEqual(Object.keys(view).sort(), [
      "at",
      "of",
      "prompt",
      "promptEndsAt",
      "richest",
      "tokens",
      "wagered",
    ]);
    const json = JSON.stringify(view);
    for (const p of GGANBU_PROMPTS) {
      assert.ok(!json.includes(p.note), `${p.cue}'s note is in the public view`);
    }
    // Nor is the open prompt's answer anywhere in it, under any name.
    assert.ok(!json.includes('"answer"'));
  });

  test("a revoked player in the Lounge learns nothing about the open prompt", () => {
    let s = wagering(4);
    s = stake(s, "p1", 5, false);
    s = nextPrompt(s);
    s = stake(s, "p1", 5, false, T0 + PROMPT + 100);
    s = nextPrompt(s);
    const mine = gganbuMeView(arcadeOf(s), pot(s), "p1");
    assert.equal(mine.revoked, true);
    assert.equal(mine.tokens, 0);
    assert.equal(mine.wager, null);
  });
});
