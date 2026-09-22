/**
 * Round 2, Unseal. Every expected number is computed by hand from SPEC.md
 * "#### Round 2 — Unseal" and the "Arcade scoring summary" table, and never by
 * calling the code under test.
 *
 * As in arcade.test.ts and glass-bridge.test.ts, every call goes through
 * `run`, which deep-freezes the input state and checks it against a clone
 * afterwards: the engine is pure.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  Activity,
  ArcadeState,
  Effect,
  Event,
  ParticipantId,
  RejectCode,
  SessionState,
  UnsealItem,
  UnsealShape,
} from "./types.ts";
import { newSession, reduce } from "./reducer.ts";
import {
  fastestUnseal,
  floorMax,
  isScrambleOf,
  loungeMax,
  loungePoints,
  splitTins,
  tinIndexFor,
  UNSEAL_BACKED_FASTEST,
  UNSEAL_BACKED_UNSEALS,
  UNSEAL_FASTEST_BONUS,
  UNSEAL_LETTER_BANK,
  UNSEAL_SHAPE_SCORE,
  UNSEAL_SHAPES,
  unsealFloorPoints,
  unsealFloorView,
  unsealLetters,
  unsealMeView,
} from "./arcade.ts";
import { UNSEAL_ITEMS, UNSEAL_SECONDS, unsealRound } from "../arcade/unseal.ts";

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

/** The round card is up: shapes may be picked, tins are still shut. */
function carded(n = 4, items: readonly UnsealItem[] = UNSEAL_ITEMS): SessionState {
  return accept(
    entered(n),
    { type: "startRound", round: "unseal", config: unsealRound(items) },
    T0 - 1,
  );
}

/** The Floor is open at T0 and closes at T0 + 60 000. */
function unsealing(n = 4, items: readonly UnsealItem[] = UNSEAL_ITEMS): SessionState {
  return accept(carded(n, items), { type: "beginPlay" }, T0);
}

function arcadeOf(state: SessionState): ArcadeState {
  assert.ok(state.arcade, "expected the arcade to be open");
  return state.arcade;
}

function tins(s: SessionState) {
  const play = arcadeOf(s).play;
  assert.ok(play?.kind === "unseal", "expected an Unseal round");
  return play;
}

const banked = (s: SessionState, pid: ParticipantId) => arcadeOf(s).banked[pid] ?? 0;
const total = (s: SessionState, pid: ParticipantId) => arcadeOf(s).totals[pid] ?? 0;
const standing = (s: SessionState, pid: ParticipantId) => arcadeOf(s).standing[pid];

/** The word in the tin `pid` is holding. Tests may know it; phones may not. */
function wordOf(s: SessionState, pid: ParticipantId): string[] {
  const play = tins(s);
  const at = play.pick[pid];
  assert.ok(at !== undefined, `${pid} is not holding a tin`);
  return unsealLetters(play.key[at]!.answer);
}

/** Tap the whole word correctly, one letter every `every` ms from `from`. */
function unsealWord(
  s: SessionState,
  pid: ParticipantId,
  from: number,
  every = 100,
): SessionState {
  const word = wordOf(s, pid);
  let at = from;
  for (const letter of word) {
    s = accept(s, { type: "tapLetter", pid, letter }, at);
    at += every;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Content                                                              */
/* ------------------------------------------------------------------ */

describe("the launch content", () => {
  test("nine tins: the existing six, plus three for the umbrella", () => {
    assert.equal(UNSEAL_ITEMS.length, 9);
    assert.equal(UNSEAL_SECONDS, 60);
    assert.deepEqual(
      UNSEAL_ITEMS.map((i) => i.answer),
      [
        "RAFT",
        "SENTINEL",
        "PROVIDER",
        "MODULE",
        "GOSSIP",
        "UNSEAL",
        "DECLARATIVE",
        "IDEMPOTENCY",
        "ORCHESTRATION",
      ],
    );
  });

  test("the existing six are the Scrambled board, verbatim", () => {
    // Cue, answer and note, exactly as they are in
    // team-building/activities/hashi-arcade/index.html under key:"scrambled".
    assert.deepEqual(UNSEAL_ITEMS.slice(0, 6).map((i) => [i.cue, i.answer, i.note]), [
      [
        "T F A R",
        "RAFT",
        "The consensus protocol behind integrated storage in Vault, Consul and Nomad.",
      ],
      ["N E L S I T E N", "SENTINEL", "Policy as code across the enterprise products."],
      ["R E V I D O R P", "PROVIDER", "The Terraform plugin that talks to an actual API."],
      [
        "D U E L M O",
        "MODULE",
        "Reusable Terraform. The thing everyone means to write and never does.",
      ],
      ["S I P G O S", "GOSSIP", "How Consul agents find out who is still alive."],
      [
        "N E A L U S",
        "UNSEAL",
        "What you do to a Vault after it starts. Shamir shares, or auto-unseal via a KMS.",
      ],
    ]);
  });

  test("every cue is a scramble of its own word", () => {
    for (const item of UNSEAL_ITEMS) {
      assert.ok(
        isScrambleOf(item.cue, item.answer),
        `${item.answer}'s cue is not its letters`,
      );
      assert.ok(item.note.trim() !== "", `${item.answer} has no note`);
    }
  });

  test("the shape of a tin is the length of the word in it", () => {
    // SPEC: circle is four or five letters, triangle six, star eight,
    // umbrella eleven or more.
    const band: Readonly<Record<UnsealShape, (n: number) => boolean>> = {
      circle: (n) => n === 4 || n === 5,
      triangle: (n) => n === 6,
      star: (n) => n === 8,
      umbrella: (n) => n >= 11,
    };
    for (const item of UNSEAL_ITEMS) {
      const n = unsealLetters(item.answer).length;
      assert.ok(band[item.shape](n), `${item.answer} is ${n} letters, not a ${item.shape}`);
    }
  });

  test("partial credit can never beat completion, in any tier", () => {
    // 2 a letter up to the crack, against the shape score for opening it. The
    // closest call in the launch set is a five-letter circle, which would tie;
    // RAFT is four, so 8 against 10.
    for (const item of UNSEAL_ITEMS) {
      const letters = unsealLetters(item.answer).length;
      assert.ok(
        (letters - 1) * UNSEAL_LETTER_BANK < UNSEAL_SHAPE_SCORE[item.shape],
        `cracking on ${item.answer}'s last letter pays as much as opening it`,
      );
    }
  });

  test("no cue gives its word away by being in order, or in reverse", () => {
    // ⚠️ One of the existing six is its own word backwards: `T F A R` is RAFT.
    // It is kept, because the brief was to reuse the existing items verbatim
    // and because a four-letter word has twenty-four arrangements and one of
    // them was always going to look like something. The other five are
    // genuinely scrambled, and so are the three additions — which matters
    // most at the umbrella tier, the one that pays 50.
    const forwards = (item: UnsealItem) =>
      unsealLetters(item.cue).join("") === unsealLetters(item.answer).join("");
    const backwards = (item: UnsealItem) =>
      unsealLetters(item.cue).join("") ===
      [...unsealLetters(item.answer)].reverse().join("");
    for (const item of UNSEAL_ITEMS) {
      assert.ok(!forwards(item), `${item.answer}'s cue spells it out`);
    }
    assert.deepEqual(
      UNSEAL_ITEMS.filter(backwards).map((i) => i.answer),
      ["RAFT"],
      "only the four-letter circle tin is its word reversed",
    );
  });

  test("no two tins hold the same word", () => {
    const answers = UNSEAL_ITEMS.map((i) => i.answer);
    assert.equal(new Set(answers).size, answers.length);
  });

  test("the round the host gets", () => {
    assert.deepEqual(unsealRound(), {
      kind: "unseal",
      items: UNSEAL_ITEMS,
      seconds: 60,
    });
  });
});

/* ------------------------------------------------------------------ */
/* The tins                                                             */
/* ------------------------------------------------------------------ */

describe("handing out tins", () => {
  test("splitting content leaves the word on one side of the line", () => {
    const { tins: shown, key } = splitTins(UNSEAL_ITEMS);
    assert.equal(shown.length, 9);
    assert.deepEqual(shown[0], { shape: "circle", cue: "T F A R", length: 4 });
    assert.deepEqual(key[0], {
      answer: "RAFT",
      note: UNSEAL_ITEMS[0]!.note,
    });
    // The half that may be shown carries no field that could hold the answer.
    for (const tin of shown) {
      assert.deepEqual(Object.keys(tin).sort(), ["cue", "length", "shape"]);
    }
  });

  test("a tier with several words deals them out by player number", () => {
    const { tins: shown } = splitTins(UNSEAL_ITEMS);
    // Triangles are at indices 3, 4 and 5; players 1, 2 and 3 get one each,
    // and player 4 comes back round to the first.
    assert.equal(tinIndexFor(shown, "triangle", 1), 3);
    assert.equal(tinIndexFor(shown, "triangle", 2), 4);
    assert.equal(tinIndexFor(shown, "triangle", 3), 5);
    assert.equal(tinIndexFor(shown, "triangle", 4), 3);
    // The circle tier has one word, so everybody gets it.
    assert.equal(tinIndexFor(shown, "circle", 1), 0);
    assert.equal(tinIndexFor(shown, "circle", 7), 0);
    // A number nobody has been given yet still gets a tin.
    assert.equal(tinIndexFor(shown, "circle", undefined), 0);
  });

  test("a shape with no tins is refused rather than handed an empty one", () => {
    const { tins: shown } = splitTins([UNSEAL_ITEMS[0]!]);
    assert.equal(tinIndexFor(shown, "umbrella", 1), -1);
    const s = carded(2, [UNSEAL_ITEMS[0]!]);
    assertRefused(
      s,
      run(s, { type: "pickShape", pid: "p1", shape: "umbrella" }, T0),
      "invalid_choice",
    );
  });

  test("a scramble that is not the word's letters is refused at the door", () => {
    const s = entered(2);
    assertRefused(
      s,
      run(
        s,
        {
          type: "startRound",
          round: "unseal",
          config: unsealRound([
            { shape: "circle", cue: "X Y Z Q", answer: "RAFT", note: "n" },
          ]),
        },
        T0,
      ),
      "invalid_round_config",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Picking a shape                                                      */
/* ------------------------------------------------------------------ */

describe("the shape picker", () => {
  test("you pick before you know the word, and the tin opens with the Floor", () => {
    let s = carded(2);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "umbrella" }, T0 - 10);
    // The card is up. The phone knows its shape and nothing else — publishing
    // the cue here would say which word sits behind each shape, which is the
    // whole of the round.
    const shut = unsealMeView(arcadeOf(s), tins(s), "p1");
    assert.equal(shut.shape, "umbrella");
    assert.equal(shut.cue, null);
    assert.equal(shut.solved, "");

    s = accept(s, { type: "beginPlay" }, T0);
    const open = unsealMeView(arcadeOf(s), tins(s), "p1");
    assert.equal(open.cue, "V A E T C R A D I L E");
    assert.equal(open.length, 11);
    assert.equal(open.solved, "");
  });

  test("change your mind while the tin is shut, and not once it is open", () => {
    let s = carded(2);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "circle" }, T0 - 30);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "star" }, T0 - 20);
    assert.equal(unsealMeView(arcadeOf(s), tins(s), "p1").shape, "star");
    // Picking the same shape twice is a no-op, not an error.
    assert.equal(
      run(s, { type: "pickShape", pid: "p1", shape: "star" }, T0 - 15).applied,
      false,
    );
    s = accept(s, { type: "beginPlay" }, T0);
    assertRefused(
      s,
      run(s, { type: "pickShape", pid: "p1", shape: "circle" }, T0 + 10),
      "already_picked",
    );
  });

  test("picking late is allowed: the seconds already gone are the cost", () => {
    let s = unsealing(2);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "circle" }, T0 + 30_000);
    assert.equal(unsealMeView(arcadeOf(s), tins(s), "p1").cue, "T F A R");
  });

  test("outside the arcade entirely, every one of them is refused", () => {
    let s = newSession({
      sid: "s",
      title: "Offsite",
      joinCode: "RAFT",
      activities: [ARCADE],
    });
    s = accept(s, { type: "open" }, 10);
    s = accept(s, { type: "start" }, 20);
    s = accept(s, { type: "join", pid: "p1", nickname: "Player 1" }, 30);
    for (const event of [
      { type: "pickShape", pid: "p1", shape: "circle" },
      { type: "tapLetter", pid: "p1", letter: "R" },
      { type: "readDocs", pid: "p1" },
    ] as const) {
      assertRefused(s, run(s, event, T0), "not_in_arcade");
    }
    // And inside the arcade but in somebody else's round.
    const entered2 = entered(2);
    for (const event of [
      { type: "pickShape", pid: "p1", shape: "circle" },
      { type: "tapLetter", pid: "p1", letter: "R" },
      { type: "readDocs", pid: "p1" },
    ] as const) {
      assertRefused(entered2, run(entered2, event, T0), "wrong_round_phase");
    }
    // An unknown participant is refused before anything else is decided.
    const playing = unsealing(2);
    assertRefused(
      playing,
      run(playing, { type: "pickShape", pid: "ghost", shape: "circle" }, T0),
      "unknown_participant",
    );
    assertRefused(
      playing,
      run(playing, { type: "tapLetter", pid: "ghost", letter: "R" }, T0),
      "unknown_participant",
    );
  });

  test("tapping or reading before there is a tin to tap", () => {
    const s = unsealing(2);
    assertRefused(
      s,
      run(s, { type: "tapLetter", pid: "p1", letter: "R" }, T0 + 10),
      "no_shape_picked",
    );
    assertRefused(
      s,
      run(s, { type: "readDocs", pid: "p1" }, T0 + 10),
      "no_shape_picked",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Tapping the letters                                                  */
/* ------------------------------------------------------------------ */

describe("unsealing", () => {
  /** p1 holds RAFT; p2 holds DECLARATIVE. */
  function holding(): SessionState {
    let s = carded(2);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "circle" }, T0 - 30);
    s = accept(s, { type: "pickShape", pid: "p2", shape: "umbrella" }, T0 - 20);
    return accept(s, { type: "beginPlay" }, T0);
  }

  test("each correct letter banks 2, up to the shape score", () => {
    let s = holding();
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "R" }, T0 + 100);
    assert.equal(banked(s, "p1"), 2);
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "A" }, T0 + 200);
    assert.equal(banked(s, "p1"), 4);
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "F" }, T0 + 300);
    assert.equal(banked(s, "p1"), 6);
    // The fourth letter opens the tin, and opening it pays the shape score —
    // 10 for a circle — not 8 plus a bonus. SPEC's Floor max of 60 is 50 + 10
    // and nothing else, which is what makes the shape score the total.
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "T" }, T0 + 400);
    assert.equal(banked(s, "p1"), 10);
    assert.equal(standing(s, "p1"), "floor");
    assert.equal(unsealMeView(arcadeOf(s), tins(s), "p1").unsealed, true);
  });

  test("a wrong letter cracks the tin and keeps what was banked", () => {
    let s = holding();
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "R" }, T0 + 100);
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "A" }, T0 + 200);
    // T is on the tiles, and it is not the third letter of RAFT.
    const r = run(s, { type: "tapLetter", pid: "p1", letter: "T" }, T0 + 300);
    assert.ok(r.applied);
    assert.equal(r.state.arcade?.standing["p1"], "drained");
    assert.equal(r.state.arcade?.banked["p1"], 4, "2 a letter, up to the crack");
    assert.deepEqual(r.state.arcade?.lounge["p1"], { backing: null, at: T0 + 300 });
    // A crack moves the dormitory grid, so it goes to everybody.
    assert.ok(
      r.effects.some((e) => e.kind === "broadcast" && e.to === "all"),
      "the room is told somebody was drained",
    );
  });

  test("a letter that is not on the tin at all is a refusal, not a crack", () => {
    let s = holding();
    // RAFT has no Z. A frame like that is a bug in a phone, and draining
    // somebody for it would be the game punishing their handset.
    assertRefused(
      s,
      run(s, { type: "tapLetter", pid: "p1", letter: "Z" }, T0 + 100),
      "invalid_letter",
    );
    assertRefused(
      s,
      run(s, { type: "tapLetter", pid: "p1", letter: "" }, T0 + 100),
      "invalid_letter",
    );
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "r" }, T0 + 100);
    assert.equal(banked(s, "p1"), 2, "and case does not matter");
  });

  test("a repeated letter may be tapped from either tile", () => {
    // Player 2 draws the second umbrella tin, IDEMPOTENCY, which has two Es.
    // The phone sends the character, so either tile is the same tap.
    let s = holding();
    const word = wordOf(s, "p2").join("");
    assert.equal(word, "IDEMPOTENCY");
    assert.ok(new Set(word).size < word.length, "the word has a repeated letter");
    s = unsealWord(s, "p2", T0 + 100);
    assert.equal(banked(s, "p2"), 50);
    assert.equal(unsealMeView(arcadeOf(s), tins(s), "p2").solved, word);
  });

  test("a stray tap after the tin is open is not a crack", () => {
    let s = holding();
    s = unsealWord(s, "p1", T0 + 100);
    assert.equal(run(s, { type: "tapLetter", pid: "p1", letter: "R" }, T0 + 900).applied, false);
    assert.equal(standing(s, "p1"), "floor");
  });

  test("the Floor closes and the tins stop", () => {
    const s = holding();
    assert.equal(arcadeOf(s).endsAt, T0 + 60_000);
    assertRefused(
      s,
      run(s, { type: "tapLetter", pid: "p1", letter: "R" }, T0 + 60_000),
      "floor_locked",
    );
  });

  test("a cracked player is in the Lounge, not on the Floor", () => {
    let s = holding();
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "T" }, T0 + 100);
    assert.equal(standing(s, "p1"), "drained");
    assertRefused(
      s,
      run(s, { type: "tapLetter", pid: "p1", letter: "R" }, T0 + 200),
      "not_on_the_floor",
    );
    assertRefused(
      s,
      run(s, { type: "pickShape", pid: "p1", shape: "star" }, T0 + 200),
      "not_on_the_floor",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Read the docs                                                        */
/* ------------------------------------------------------------------ */

describe("Read the docs", () => {
  function holdingCircle(): SessionState {
    let s = carded(3);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "circle" }, T0 - 30);
    s = accept(s, { type: "pickShape", pid: "p2", shape: "circle" }, T0 - 20);
    return accept(s, { type: "beginPlay" }, T0);
  }

  test("it reveals the next letter and halves the round", () => {
    let s = holdingCircle();
    s = accept(s, { type: "readDocs", pid: "p1" }, T0 + 100);
    // One letter in, and the 2 it banked is already halved: floor(2 ÷ 2) = 1.
    assert.equal(banked(s, "p1"), 1);
    assert.equal(unsealMeView(arcadeOf(s), tins(s), "p1").solved, "R");
    assert.equal(unsealMeView(arcadeOf(s), tins(s), "p1").docs, true);
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "A" }, T0 + 200);
    assert.equal(banked(s, "p1"), 2, "floor(4 ÷ 2)");
  });

  test("it halves letters that were banked before it was pressed", () => {
    let s = holdingCircle();
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "R" }, T0 + 100);
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "A" }, T0 + 200);
    assert.equal(banked(s, "p1"), 4);
    s = accept(s, { type: "readDocs", pid: "p1" }, T0 + 300);
    // Three letters, halved: floor(6 ÷ 2) = 3. "Halves your score for the
    // round" is the round, not the rest of it.
    assert.equal(banked(s, "p1"), 3);
  });

  test("pressed enough times it opens the tin, at half price", () => {
    let s = holdingCircle();
    for (let i = 0; i < 4; i++) {
      s = accept(s, { type: "readDocs", pid: "p1" }, T0 + 100 * (i + 1));
    }
    assert.equal(unsealMeView(arcadeOf(s), tins(s), "p1").unsealed, true);
    assert.equal(banked(s, "p1"), 5, "a circle tin at 10, halved");
    assert.equal(standing(s, "p1"), "floor");
  });

  test("and it cannot be the fastest in its shape", () => {
    // p1 buys the whole word and is quickest by the clock; p2 works it out and
    // is slower. The +10 is p2's, and the halving is not also a speed prize.
    let s = holdingCircle();
    for (let i = 0; i < 4; i++) {
      s = accept(s, { type: "readDocs", pid: "p1" }, T0 + 10 * (i + 1));
    }
    s = unsealWord(s, "p2", T0 + 1_000);
    assert.equal(fastestUnseal(tins(s)).circle, "p2");

    s = accept(s, { type: "endRound" }, T0 + 60_000);
    assert.equal(banked(s, "p1"), 5, "10 halved, and no bonus");
    assert.equal(banked(s, "p2"), 20, "10 for the tin, 10 for being fastest");
  });

  test("it looks exactly like a letter from outside", () => {
    // DESIGN.md: "Reading the docs. Score halved. Nobody will know." The
    // public view of the round counts letters and says nothing about how they
    // were come by.
    let s = holdingCircle();
    s = accept(s, { type: "readDocs", pid: "p1" }, T0 + 100);
    const view = unsealFloorView(tins(s));
    assert.equal(view.progress["p1"], 1);
    assert.ok(!Object.keys(view).includes("docs"));
  });
});

/* ------------------------------------------------------------------ */
/* Fastest in each shape                                                */
/* ------------------------------------------------------------------ */

describe("the fastest in each shape", () => {
  test("measured from the Floor opening, and paid at the end", () => {
    let s = carded(4);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "circle" }, T0 - 40);
    s = accept(s, { type: "pickShape", pid: "p2", shape: "circle" }, T0 - 30);
    s = accept(s, { type: "pickShape", pid: "p3", shape: "triangle" }, T0 - 20);
    s = accept(s, { type: "beginPlay" }, T0);
    // p2 finishes at +2 000, p1 at +4 000, p3 at +9 000.
    s = unsealWord(s, "p2", T0 + 1_700, 100);
    s = unsealWord(s, "p1", T0 + 3_700, 100);
    s = unsealWord(s, "p3", T0 + 8_500, 100);
    assert.deepEqual(fastestUnseal(tins(s)), {
      circle: "p2",
      triangle: "p3",
      star: null,
      umbrella: null,
    });
    // Nothing is paid for it until the round ends: until then somebody else
    // can still be faster.
    assert.equal(banked(s, "p2"), 10);
    s = accept(s, { type: "endRound" }, T0 + 60_000);
    assert.equal(banked(s, "p2"), 20);
    assert.equal(banked(s, "p1"), 10, "second in the circle tier is just the tin");
    assert.equal(banked(s, "p3"), 30, "20 for a triangle, 10 for being the only one");
  });

  test("a tie goes to whoever got there first", () => {
    let s = carded(3);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "circle" }, T0 - 30);
    s = accept(s, { type: "pickShape", pid: "p2", shape: "circle" }, T0 - 20);
    s = accept(s, { type: "beginPlay" }, T0);
    // Both finish on the same millisecond; p1 got there first.
    s = unsealWord(s, "p1", T0 + 700, 100);
    s = unsealWord(s, "p2", T0 + 700, 100);
    assert.equal(fastestUnseal(tins(s)).circle, "p1");
  });
});

/* ------------------------------------------------------------------ */
/* Scoring                                                              */
/* ------------------------------------------------------------------ */

describe("the numbers", () => {
  test("the Floor max is SPEC's 60", () => {
    // An umbrella tin, opened fastest: 50 + 10.
    assert.equal(floorMax(unsealRound()), 60);
    assert.equal(UNSEAL_SHAPE_SCORE.umbrella + UNSEAL_FASTEST_BONUS, 60);
    assert.deepEqual(UNSEAL_SHAPES, ["circle", "triangle", "star", "umbrella"]);
    assert.deepEqual(UNSEAL_SHAPE_SCORE, {
      circle: 10,
      triangle: 20,
      star: 35,
      umbrella: 50,
    });
  });

  test("unsealFloorPoints, by hand, for every way a round can go", () => {
    let s = carded(3);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "star" }, T0 - 30);
    s = accept(s, { type: "beginPlay" }, T0);
    const play = tins(s);
    assert.equal(unsealFloorPoints(play, "p1"), 0, "nothing tapped");
    assert.equal(unsealFloorPoints(play, "p2"), 0, "no tin at all");
    // Five letters of SENTINEL: 10. Eight: the shape score, 35.
    assert.equal(
      unsealFloorPoints({ ...play, progress: { p1: 5 } }, "p1"),
      10,
    );
    assert.equal(
      unsealFloorPoints({ ...play, progress: { p1: 8 } }, "p1"),
      35,
    );
    assert.equal(
      unsealFloorPoints({ ...play, progress: { p1: 8 }, docs: { p1: true } }, "p1"),
      17,
      "floor(35 ÷ 2)",
    );
  });

  test("the round folds into the arcade total once, at the end", () => {
    let s = carded(3);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "triangle" }, T0 - 30);
    s = accept(s, { type: "beginPlay" }, T0);
    s = unsealWord(s, "p1", T0 + 500);
    s = accept(s, { type: "endRound" }, T0 + 60_000);
    assert.equal(banked(s, "p1"), 30, "20 for the tin, 10 for being fastest");
    assert.equal(total(s, "p1"), 30);
    assert.equal(total(s, "p2"), 0, "played and scored nothing is still played");
    s = accept(s, { type: "revealRound" }, T0 + 61_000);
    assert.deepEqual(s.scores["arcade"]?.["p1"], { raw: 30, status: "played" });
  });
});

/* ------------------------------------------------------------------ */
/* The Lounge                                                           */
/* ------------------------------------------------------------------ */

describe("the Lounge", () => {
  /** p1 cracks at once; p2 opens a circle tin; p3 opens a triangle. */
  function cracked(): SessionState {
    let s = carded(4);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "circle" }, T0 - 40);
    s = accept(s, { type: "pickShape", pid: "p2", shape: "circle" }, T0 - 30);
    s = accept(s, { type: "pickShape", pid: "p3", shape: "triangle" }, T0 - 20);
    s = accept(s, { type: "beginPlay" }, T0);
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "T" }, T0 + 100);
    assert.equal(standing(s, "p1"), "drained");
    return s;
  }

  test("backing a player who unseals pays 5", () => {
    let s = cracked();
    s = accept(s, { type: "backPlayer", pid: "p1", backing: "p3" }, T0 + 200);
    // p2 opens the circle fastest; p3 opens the only triangle, so p3 is
    // fastest in their shape too. Back p3 and take the larger award.
    s = unsealWord(s, "p2", T0 + 1_000);
    s = unsealWord(s, "p3", T0 + 5_000);
    assert.equal(loungePoints(tins(s), "p2", "floor"), UNSEAL_BACKED_FASTEST);
    assert.equal(loungePoints(tins(s), "p3", "floor"), UNSEAL_BACKED_FASTEST);
    // A player still on the Floor who never opened their tin pays nothing.
    assert.equal(loungePoints(tins(s), "p4", "floor"), 0);
    // And a player who cracked pays nothing, whoever they are.
    assert.equal(loungePoints(tins(s), "p2", "drained"), 0);
  });

  test("the awards are the better of the two, never their sum", () => {
    let s = cracked();
    s = accept(s, { type: "backPlayer", pid: "p1", backing: "p2" }, T0 + 200);
    // p4 picks the circle late and opens it slowly: an unsealer who is not
    // the fastest, which is the 5.
    s = accept(s, { type: "pickShape", pid: "p4", shape: "circle" }, T0 + 300);
    s = unsealWord(s, "p2", T0 + 1_000);
    s = unsealWord(s, "p4", T0 + 20_000);
    assert.equal(loungePoints(tins(s), "p4", "floor"), UNSEAL_BACKED_UNSEALS);
    assert.equal(loungePoints(tins(s), "p2", "floor"), UNSEAL_BACKED_FASTEST);
    assert.equal(
      loungeMax("unseal"),
      Math.max(UNSEAL_BACKED_UNSEALS, UNSEAL_BACKED_FASTEST),
    );
    assert.notEqual(
      loungeMax("unseal"),
      UNSEAL_BACKED_UNSEALS + UNSEAL_BACKED_FASTEST,
    );
  });

  test("opening any tin beats a perfect Lounge", () => {
    // The tuning rule, checked rather than asserted in a comment. The cheapest
    // completion on this Floor is a circle tin at 10; a perfect Lounge is 8.
    const cheapest = Math.min(...UNSEAL_SHAPES.map((sh) => UNSEAL_SHAPE_SCORE[sh]));
    assert.equal(cheapest, 10);
    assert.equal(loungeMax("unseal"), 8);
    assert.ok(
      loungeMax("unseal") < cheapest,
      "a perfect Lounge must not beat the cheapest way off this Floor",
    );
    // And it is still worth having: SPEC asks for both halves.
    assert.ok(loungeMax("unseal") > 0);
  });

  test("a backed tin pays the Lounge at the end of the round", () => {
    let s = cracked();
    s = accept(s, { type: "backPlayer", pid: "p1", backing: "p3" }, T0 + 200);
    s = unsealWord(s, "p3", T0 + 1_000);
    // p1 banked 0 on the Floor — they cracked on their first letter.
    assert.equal(banked(s, "p1"), 0);
    s = accept(s, { type: "endRound" }, T0 + 60_000);
    assert.equal(banked(s, "p1"), 8, "backed the fastest triangle");
    assert.equal(total(s, "p1"), 8);
  });
});

/* ------------------------------------------------------------------ */
/* Leaks                                                                */
/* ------------------------------------------------------------------ */

describe("what a player may know", () => {
  test("the only word a phone is ever told is its own, one letter at a time", () => {
    let s = carded(3);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "umbrella" }, T0 - 30);
    s = accept(s, { type: "pickShape", pid: "p2", shape: "umbrella" }, T0 - 20);
    s = accept(s, { type: "beginPlay" }, T0);
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "D" }, T0 + 100);
    s = accept(s, { type: "tapLetter", pid: "p1", letter: "E" }, T0 + 200);

    const mine = unsealMeView(arcadeOf(s), tins(s), "p1");
    assert.equal(mine.solved, "DE", "what they tapped, and not one letter more");
    assert.equal(mine.progress, 2);
    assert.ok(
      !JSON.stringify(mine).includes("DECLARATIVE"),
      "the rest of the word is not in the frame",
    );
    // Two people in the same tier hold different words, so a neighbour's
    // thumbs are no help.
    assert.notEqual(
      unsealMeView(arcadeOf(s), tins(s), "p2").cue,
      mine.cue,
    );
  });

  test("the public view carries counts, never letters and never cues", () => {
    let s = carded(3);
    s = accept(s, { type: "pickShape", pid: "p1", shape: "circle" }, T0 - 30);
    s = accept(s, { type: "beginPlay" }, T0);
    s = unsealWord(s, "p1", T0 + 500);
    const view = unsealFloorView(tins(s));
    assert.deepEqual(Object.keys(view).sort(), [
      "fastest",
      "picks",
      "progress",
      "unsealOrder",
      "unsealed",
    ]);
    assert.deepEqual(view.picks, { circle: 1, triangle: 0, star: 0, umbrella: 0 });
    assert.deepEqual(view.unsealed, { circle: 1, triangle: 0, star: 0, umbrella: 0 });
    const json = JSON.stringify(view);
    for (const item of UNSEAL_ITEMS) {
      assert.ok(!json.includes(item.answer), `${item.answer} is in the public view`);
      assert.ok(!json.includes(item.cue), `${item.answer}'s cue is in the public view`);
    }
  });
});
