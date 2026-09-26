/**
 * Round 0's launch content. These are properties of the *content*, not of the
 * engine: an item that two answers both match, or an accept alias that belongs
 * to another product, is a bug nobody notices until twenty people type it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { foldAnswer, matchesItem } from "../engine/arcade.ts";
import { RECRUITMENT_ITEMS, RECRUITMENT_SECONDS_PER_ITEM, recruitmentRound } from "./recruitment.ts";

describe("recruitment content", () => {
  test("seven items, twenty seconds each", () => {
    assert.equal(RECRUITMENT_ITEMS.length, 7);
    assert.equal(RECRUITMENT_SECONDS_PER_ITEM, 20);
    // 140 s of Floor. SPEC budgets 2.5 minutes for the round including the
    // 20 s card, which the seventh item spends: the reveal is the recruiting
    // sequence, which runs on into the next card either way.
    assert.equal(RECRUITMENT_ITEMS.length * RECRUITMENT_SECONDS_PER_ITEM, 140);
    assert.deepEqual(recruitmentRound(), {
      kind: "recruitment",
      items: RECRUITMENT_ITEMS,
      secondsPerItem: 20,
    });
  });

  test("the seven, in order, with Waypoint fourth", () => {
    assert.deepEqual(
      RECRUITMENT_ITEMS.map((i) => i.answer),
      ["Vault", "Terraform", "Consul", "Waypoint", "Packer", "Boundary", "Nomad"],
    );
  });

  test("the round is not decided by elimination", () => {
    // Six emoji pairs for the six products the room can recite means the last
    // two answers are whichever names have not come up yet, and the cue stops
    // being read. The seventh item is the fix, and it only works if it lands
    // before the back half — last would spring the surprise once, after
    // elimination had already answered items 5 and 6.
    const at = RECRUITMENT_ITEMS.findIndex((i) => i.answer === "Waypoint");
    assert.ok(at >= 0, "the set needs a product from outside the famous six");
    assert.ok(
      at > 0 && at < RECRUITMENT_ITEMS.length - 2,
      `the outsider is item ${at + 1} of ${RECRUITMENT_ITEMS.length}; it has to land before the back half`,
    );
  });

  test("a cue is two emoji and no letters", () => {
    // Two, and the count was the half of this test that was missing. The round
    // is two emoji for one product: a third picture is a third clue, and a cue
    // that can grow is a cue that gets easier every time somebody looks at a
    // weak one and adds to it rather than replacing it.
    //
    // Counted in graphemes rather than code points, because four of the seven
    // carry a variation selector — `🛠️` is two code points and one picture, so
    // `[...cue].length` would read 3 and be right about nothing.
    const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
    for (const item of RECRUITMENT_ITEMS) {
      assert.equal(
        Array.from(graphemes.segment(item.cue)).length,
        2,
        `${item.answer}'s cue is ${item.cue}, which is not two emoji`,
      );
      // The answer is typed, so a letter anywhere in a cue is the answer being
      // handed over. "tf" in a Terraform cue would be the whole item.
      assert.ok(!/\p{L}/u.test(item.cue), `${item.answer}'s cue contains a letter`);
    }
  });

  test("every item has a cue and a note — the note is the bit people learn from", () => {
    for (const item of RECRUITMENT_ITEMS) {
      assert.ok(item.cue.trim() !== "", `${item.answer} has no cue`);
      assert.ok(item.note.trim() !== "", `${item.answer} has no note`);
      assert.ok(foldAnswer(item.answer) !== "", `${item.answer} folds to nothing`);
      // The House reads these out. DESIGN.md: "no exclamation marks, ever" —
      // the notes were product blurbs once and a blurb is where one gets in.
      assert.ok(!item.note.includes("!"), `${item.answer}'s note has an exclamation mark`);
    }
  });

  test("no answer or alias is ambiguous across the set", () => {
    for (const item of RECRUITMENT_ITEMS) {
      for (const typed of [item.answer, ...item.accept]) {
        const matching = RECRUITMENT_ITEMS.filter((i) => matchesItem(i, typed));
        assert.deepEqual(
          matching.map((i) => i.answer),
          [item.answer],
          `"${typed}" matches more than ${item.answer}`,
        );
      }
    }
  });

  test("tf is Terraform's alias and SPEC names no other", () => {
    assert.deepEqual(
      RECRUITMENT_ITEMS.flatMap((i) => i.accept.map((a) => [i.answer, a])),
      [["Terraform", "tf"]],
    );
  });
});
