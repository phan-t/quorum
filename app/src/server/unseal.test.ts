/**
 * Unseal on the wire: what each role is sent, and — the point of this file —
 * what nothing but the host is sent until the reveal.
 *
 * Expected behaviour comes from SPEC.md ("Round 2 — Unseal"), DESIGN.md ("The
 * arcade register") and the engine's own analysis in engine/arcade.ts, not
 * from views.ts. Where a test fails the projection is wrong or the spec is
 * ambiguous; the test is left failing and the case is reported.
 *
 * Everything here is asserted against the **serialised frame** rather than a
 * parsed object, for the reason glass-bridge.test.ts gives: checking a
 * rendered page tests a renderer's discipline, checking the object misses a
 * field somebody adds later under another name, and checking the string is
 * the only version of the claim that survives being edited by someone who has
 * not read this comment.
 *
 * The four claims:
 *
 * 1. **The words never leave the server** until `revealRound`, and not even
 *    then to a surface that has not earned them.
 * 2. **A cue reaches exactly one phone**: the one holding that tin. There is
 *    no public view of the tins at all, because a cue is the word with the
 *    order taken off and nine of them on the Desktop is every tin solved out
 *    loud by whoever reads fastest.
 * 3. **No frame pairs a player with a shape.** A shape is a word length, and
 *    the picks travel as counts.
 * 4. **The solved prefix is the player's own and stops there.** A phone is
 *    never sent one letter more than it has tapped — which would be the
 *    answer, arriving early, on the surface the round is played on.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newSession, replay } from "../engine/reducer.ts";
import type {
  Activity,
  Event,
  SessionState,
  UnsealItem,
} from "../engine/types.ts";
import { renderStateFor } from "./views.ts";
import type { RenderState } from "../protocol.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const ACTIVITIES: readonly Activity[] = [
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

/**
 * Four tins whose words, cues and notes appear nowhere else in the product.
 *
 * "RAFT" and "MODULE" are in half this repository and finding one in a frame
 * would prove nothing. KRYPTON, XENON and the rest appear in exactly one
 * place each, so finding one is unambiguous — and so is not finding one.
 *
 * Every cue is a genuine scramble of its own word: `startRound` refuses a tin
 * whose letters do not match, and a fixture that could not be loaded would
 * make every assertion below vacuous.
 */
const TINS: readonly UnsealItem[] = [
  {
    shape: "circle",
    cue: "N O X E N",
    answer: "XENON",
    note: "NOBLE-NOTE: the circle tier.",
  },
  {
    shape: "triangle",
    cue: "D A R O N",
    answer: "RADON",
    note: "DECAY-NOTE: the triangle tier.",
  },
  {
    shape: "star",
    cue: "N O T Y P R K",
    answer: "KRYPTON",
    note: "LAMP-NOTE: the star tier.",
  },
  {
    shape: "umbrella",
    cue: "M U I D I R I",
    answer: "IRIDIUM",
    note: "DENSE-NOTE: the umbrella tier.",
  },
];

/** Every word and every note. None of these may appear before the reveal. */
const SECRETS = [
  ...TINS.map((t) => t.answer),
  ...TINS.map((t) => t.note),
];

/** Every cue. None may appear on a frame but the one phone holding that tin. */
const CUES = TINS.map((t) => t.cue);

const T0 = 1_700_000_000_000;

function session(events: readonly Event[], at = T0): SessionState {
  const base = newSession({
    sid: "ses_unseal",
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
    { type: "join", pid: "p1", nickname: "Priya" },
    { type: "join", pid: "p2", nickname: "Kenji" },
    { type: "join", pid: "p3", nickname: "Ade" },
    { type: "join", pid: "p4", nickname: "Grace" },
    { type: "start" },
    { type: "setSegment", segment: "arcade" },
    { type: "enterArcade", activityId: "arcade" },
    ...extra,
  ]);
}

const START: Event = {
  type: "startRound",
  round: "unseal",
  config: { kind: "unseal", items: TINS, seconds: 60 },
};

/** The round card is up. Nobody is holding a tin yet. */
function carded(): SessionState {
  return entered([START]);
}

/** The Floor is open, with a pick per player. */
function unsealing(
  extra: readonly { event: Event; at: number }[] = [],
): SessionState {
  return replay(
    entered([
      START,
      { type: "pickShape", pid: "p1", shape: "circle" },
      { type: "pickShape", pid: "p2", shape: "triangle" },
      { type: "pickShape", pid: "p3", shape: "star" },
      { type: "pickShape", pid: "p4", shape: "umbrella" },
      { type: "beginPlay" },
    ]),
    extra,
  );
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

/** How many times a key appears in the bytes. Zero, one, or a leak. */
function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

function publicFrames(state: SessionState): { label: string; frame: string }[] {
  return [
    ...["p1", "p2", "p3", "p4"].map((pid) => ({
      label: `participant ${pid}`,
      frame: wire(state, "participant", pid),
    })),
    { label: "screen", frame: wire(state, "screen") },
  ];
}

/* ------------------------------------------------------------------ */
/* 1. The words stay on the server                                     */
/* ------------------------------------------------------------------ */

describe("the words stay on the server", () => {
  it("are in no public frame while the round card is up", () => {
    for (const { label, frame } of publicFrames(carded())) {
      for (const secret of SECRETS) {
        assert.ok(!frame.includes(secret), `${label}: leaked ${secret}`);
      }
      assert.ok(!frame.includes('"recap"'), `${label}: the recap leaked`);
      assert.ok(!frame.includes('"key"'), `${label}: the key leaked`);
    }
  });

  it("are in no public frame while the tins are being opened", () => {
    // One tin is nearly open, one has cracked, and one player has read the
    // docs. None of that is the word.
    const mid = unsealing([
      { event: { type: "tapLetter", pid: "p1", letter: "X" }, at: T0 + 1_000 },
      { event: { type: "tapLetter", pid: "p1", letter: "E" }, at: T0 + 1_500 },
      { event: { type: "readDocs", pid: "p3" }, at: T0 + 2_000 },
      // R is on the triangle's tin and is not its first letter: a crack.
      { event: { type: "tapLetter", pid: "p2", letter: "N" }, at: T0 + 2_500 },
    ]);
    assert.equal(view(mid, "participant", "p2").arcadeMine?.standing, "drained");
    for (const { label, frame } of publicFrames(mid)) {
      for (const secret of SECRETS) {
        assert.ok(!frame.includes(secret), `${label}: leaked ${secret}`);
      }
    }
  });

  it("is not in a cracked player's frame, who is sitting beside somebody still tapping", () => {
    const mid = unsealing([
      { event: { type: "tapLetter", pid: "p2", letter: "N" }, at: T0 + 2_500 },
    ]);
    const frame = wire(mid, "participant", "p2");
    for (const secret of SECRETS) assert.ok(!frame.includes(secret), secret);
    // Their own cue is gone too: the tin is cracked and there is nothing left
    // to tap, so there is nothing on their screen for a neighbour to read.
    assert.equal(view(mid, "participant", "p2").arcadeMine?.unseal?.cracked, true);
  });

  it("opens every word and every note to the room at the reveal", () => {
    const revealed = replay(unsealing(), [
      { event: { type: "endRound" }, at: T0 + 70_000 },
      { event: { type: "revealRound" }, at: T0 + 71_000 },
    ]);
    const recap = view(revealed, "participant", "p1").arcade?.unseal?.recap;
    assert.equal(recap?.length, 4);
    assert.deepEqual(recap?.[2], {
      shape: "star",
      cue: "N O T Y P R K",
      answer: "KRYPTON",
      note: "LAMP-NOTE: the star tier.",
    });
    // And the Desktop, which is what the room actually reads it off.
    assert.equal(view(revealed, "screen").arcade?.unseal?.recap?.length, 4);
  });

  it("gives the host the words throughout, because the host reads them out", () => {
    const recap = view(carded(), "host").arcade?.unseal?.recap;
    assert.deepEqual(
      recap?.map((t) => t.answer),
      ["XENON", "RADON", "KRYPTON", "IRIDIUM"],
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2. A cue reaches exactly one phone                                  */
/* ------------------------------------------------------------------ */

describe("a cue reaches exactly the phone holding that tin", () => {
  it("is absent from the big screen entirely", () => {
    const frame = wire(unsealing(), "screen");
    for (const cue of CUES) {
      assert.ok(!frame.includes(cue), `the screen was sent the cue ${cue}`);
    }
  });

  it("gives each phone its own cue and nobody else's", () => {
    const mid = unsealing();
    const held: Record<string, string> = {
      p1: "N O X E N",
      p2: "D A R O N",
      p3: "N O T Y P R K",
      p4: "M U I D I R I",
    };
    for (const [pid, own] of Object.entries(held)) {
      const frame = wire(mid, "participant", pid);
      assert.ok(frame.includes(own), `${pid} was not sent its own cue`);
      for (const cue of CUES) {
        if (cue === own) continue;
        assert.ok(!frame.includes(cue), `${pid} was sent somebody else's cue`);
      }
    }
  });

  it("withholds the cue until the Floor opens, even from the holder", () => {
    // The tin is handed over at the pick and *opened* when the round starts.
    // Twenty seconds of the round card with the letters already on the phone
    // is twenty seconds of thinking nobody else gets.
    const picked = entered([
      START,
      { type: "pickShape", pid: "p1", shape: "circle" },
    ]);
    const mine = view(picked, "participant", "p1").arcadeMine?.unseal;
    assert.equal(mine?.shape, "circle");
    assert.equal(mine?.cue, null);
    assert.ok(!wire(picked, "participant", "p1").includes("N O X E N"));
  });
});

/* ------------------------------------------------------------------ */
/* 3. No frame pairs a player with a shape                             */
/* ------------------------------------------------------------------ */

describe("nothing on the wire says who picked what", () => {
  it("projects the picks as counts, on every public surface", () => {
    const mid = unsealing();
    for (const { label, frame } of publicFrames(mid)) {
      assert.ok(!frame.includes('"pick"'), `${label}: the pick map leaked`);
      assert.ok(!frame.includes('"tins"'), `${label}: the tin list leaked`);
    }
    const shapes = view(mid, "screen").arcade?.unseal?.shapes ?? [];
    assert.deepEqual(
      shapes.map((s) => [s.shape, s.picked]),
      [
        ["circle", 1],
        ["triangle", 1],
        ["star", 1],
        ["umbrella", 1],
      ],
    );
  });

  it("keeps the per-player letter counts and the docs list on the console", () => {
    const mid = unsealing([
      { event: { type: "readDocs", pid: "p3" }, at: T0 + 2_000 },
      { event: { type: "tapLetter", pid: "p1", letter: "X" }, at: T0 + 2_400 },
    ]);
    for (const role of ["participant", "screen"] as const) {
      const pub = view(mid, role, "p1").arcade?.unseal;
      assert.equal(pub?.progress, undefined, `${role}: the letter counts leaked`);
      assert.equal(pub?.docs, undefined, `${role}: the docs list leaked`);
    }
    // Counted in the bytes, because that is the claim that survives somebody
    // adding a second per-player map under another name: a phone's frame
    // carries exactly one `progress`, its own, and the Desktop carries none.
    assert.equal(occurrences(wire(mid, "participant", "p1"), '"progress"'), 1);
    assert.equal(occurrences(wire(mid, "screen"), '"progress"'), 0);
    assert.ok(!wire(mid, "participant", "p1").includes('"docs":['));

    const host = view(mid, "host").arcade?.unseal;
    assert.deepEqual(host?.docs, [3]);
    assert.equal(host?.progress?.["p3"], 1);
  });

  it("does not put the length of anybody's word on a public surface", () => {
    // The shapes *are* the lengths. A length per shape on the picker would
    // make the pick informed about the very thing it is meant to buy.
    const mid = unsealing();
    for (const role of ["participant", "screen", "host"] as const) {
      const shapes = view(mid, role, "p1").arcade?.unseal?.shapes ?? [];
      for (const shape of shapes) {
        assert.ok(
          !Object.prototype.hasOwnProperty.call(shape, "length"),
          `${role}: a word length leaked onto the picker`,
        );
      }
    }
    // Exactly one `length` in a phone's bytes — its own — and none at all on
    // the Desktop, which is in the room with three people still working.
    assert.equal(occurrences(wire(mid, "participant", "p3"), '"length"'), 1);
    assert.equal(occurrences(wire(mid, "screen"), '"length"'), 0);
    // The holder is told their own, which is what the pick bought them.
    assert.equal(view(mid, "participant", "p3").arcadeMine?.unseal?.length, 7);
  });
});

/* ------------------------------------------------------------------ */
/* 4. The solved prefix is their own, and stops there                  */
/* ------------------------------------------------------------------ */

describe("the solved prefix", () => {
  it("is exactly what they have tapped, and never one letter more", () => {
    const mid = unsealing([
      { event: { type: "tapLetter", pid: "p3", letter: "K" }, at: T0 + 1_000 },
      { event: { type: "tapLetter", pid: "p3", letter: "R" }, at: T0 + 1_400 },
    ]);
    const mine = view(mid, "participant", "p3").arcadeMine?.unseal;
    assert.equal(mine?.solved, "KR");
    assert.equal(mine?.progress, 2);
    // KRY would be the answer arriving early. It is the whole hazard here.
    assert.ok(!wire(mid, "participant", "p3").includes("KRY"));
  });

  it("is a letter longer after Read the docs, and still not the word", () => {
    // SPEC.md: the button "reveals the next letter", and the engine commits
    // it — so the prefix grows by exactly one and the rest stays in the key.
    const mid = unsealing([
      { event: { type: "readDocs", pid: "p3" }, at: T0 + 1_000 },
    ]);
    const mine = view(mid, "participant", "p3").arcadeMine?.unseal;
    assert.equal(mine?.solved, "K");
    assert.equal(mine?.docs, true);
    assert.ok(!wire(mid, "participant", "p3").includes("KRYPTON"));
  });

  it("is the whole word once the tin is open, which is then not a secret", () => {
    const opened = unsealing(
      [..."XENON"].map((letter, i) => ({
        event: { type: "tapLetter", pid: "p1", letter } as Event,
        at: T0 + 1_000 + i * 200,
      })),
    );
    const mine = view(opened, "participant", "p1").arcadeMine?.unseal;
    assert.equal(mine?.unsealed, true);
    assert.equal(mine?.solved, "XENON");
    // …and it is still nobody else's business. p4 is still working.
    assert.ok(!wire(opened, "participant", "p4").includes("XENON"));
    assert.ok(!wire(opened, "screen").includes("XENON"));
  });
});

/* ------------------------------------------------------------------ */
/* 5. The results                                                      */
/* ------------------------------------------------------------------ */

describe("the Floor's results", () => {
  it("go to the Desktop and the console, and to no phone", () => {
    const opened = unsealing(
      [..."XENON"].map((letter, i) => ({
        event: { type: "tapLetter", pid: "p1", letter } as Event,
        at: T0 + 1_000 + i * 200,
      })),
    );
    const screen = view(opened, "screen").arcade?.unseal;
    assert.deepEqual(screen?.unsealOrder, [1]);
    assert.equal(screen?.shapes.find((s) => s.shape === "circle")?.fastest, 1);

    const phone = view(opened, "participant", "p4").arcade?.unseal;
    assert.equal(phone?.unsealOrder, undefined);
    assert.ok(phone?.shapes.every((s) => s.fastest === undefined));
  });

  it("puts the four scores on every surface, because the score is the bet", () => {
    // SPEC.md prices the shapes 10 / 20 / 35 / 50, and the pick is made
    // before the word is known: the number is the question the picker asks.
    for (const role of ["participant", "screen", "host"] as const) {
      const shapes = view(carded(), role, "p1").arcade?.unseal?.shapes ?? [];
      assert.deepEqual(
        shapes.map((s) => s.score),
        [10, 20, 35, 50],
      );
    }
  });
});
