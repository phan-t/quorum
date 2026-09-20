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
  test("six items, twenty seconds each — SPEC's 2.5 minute round", () => {
    assert.equal(RECRUITMENT_ITEMS.length, 6);
    assert.equal(RECRUITMENT_SECONDS_PER_ITEM, 20);
    assert.deepEqual(recruitmentRound(), {
      kind: "recruitment",
      items: RECRUITMENT_ITEMS,
      secondsPerItem: 20,
    });
  });

  test("the existing six, in order", () => {
    assert.deepEqual(
      RECRUITMENT_ITEMS.map((i) => i.answer),
      ["Vault", "Terraform", "Consul", "Packer", "Boundary", "Nomad"],
    );
  });

  test("every item has a cue and a note — the note is the bit people learn from", () => {
    for (const item of RECRUITMENT_ITEMS) {
      assert.ok(item.cue.trim() !== "", `${item.answer} has no cue`);
      assert.ok(item.note.trim() !== "", `${item.answer} has no note`);
      assert.ok(foldAnswer(item.answer) !== "", `${item.answer} folds to nothing`);
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
