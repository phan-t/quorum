/**
 * The activity list importer.
 *
 * Same bias as the question and send-off importers' tests: a list that is
 * wrong must fail *here*, naming the entry, rather than create a session whose
 * scoring is wrong in a way nothing reports. So most of these are rejections.
 *
 * Every fixture below is invented. `config/events/` is gitignored because its
 * content is about the people in the room and this repository is public —
 * nothing from a real event belongs in a test file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_SPOT_CAP,
  formatErrors,
  importActivities,
  MAX_ACTIVITIES,
  MAX_ID_CHARS,
  MAX_SPOT_CAP,
  MAX_TITLE_CHARS,
} from "./import.ts";

function ok(raw: unknown) {
  const result = importActivities(raw);
  assert.ok(
    result.ok,
    `expected a load, got: ${result.ok ? "" : formatErrors(result.errors).join(" / ")}`,
  );
  return result.activities;
}

function errs(raw: unknown): string[] {
  const result = importActivities(raw);
  assert.ok(!result.ok, "expected a rejection");
  return formatErrors(result.errors);
}

const TRIVIA = { id: "trivia", title: "Trivia", kind: "trivia" };
const ARCADE = { id: "arcade", title: "Hashi Arcade", kind: "arcade" };
const MANUAL = { id: "ttx", title: "Security TTX", kind: "manual", spotCap: 2 };

describe("what loads", () => {
  it("reads the documented shape", () => {
    const list = ok([TRIVIA, ARCADE, MANUAL]);
    assert.deepEqual(list, [
      { id: "trivia", title: "Trivia", kind: "trivia", spotCap: DEFAULT_SPOT_CAP },
      { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: DEFAULT_SPOT_CAP },
      { id: "ttx", title: "Security TTX", kind: "manual", spotCap: 2 },
    ]);
  });

  it("defaults spotCap, and takes the one it is given", () => {
    const list = ok([{ ...TRIVIA, spotCap: 5 }, ARCADE]);
    assert.equal(list[0]?.spotCap, 5);
    assert.equal(list[1]?.spotCap, DEFAULT_SPOT_CAP);
  });

  it("takes a spotCap of 0 — a facilitator who grants none", () => {
    assert.equal(ok([{ ...TRIVIA, spotCap: 0 }])[0]?.spotCap, 0);
  });

  it("takes a null spotCap as absent", () => {
    assert.equal(ok([{ ...TRIVIA, spotCap: null }])[0]?.spotCap, DEFAULT_SPOT_CAP);
  });

  it("trims the id and the title", () => {
    const list = ok([{ id: " trivia ", title: "  Trivia  ", kind: "trivia" }]);
    assert.equal(list[0]?.id, "trivia");
    assert.equal(list[0]?.title, "Trivia");
  });

  it("takes one activity, and takes several manual ones", () => {
    assert.equal(ok([MANUAL]).length, 1);
    assert.equal(
      ok([
        { id: "ttx", title: "Security TTX", kind: "manual" },
        { id: "bake-off", title: "Bake Off", kind: "manual" },
        { id: "quiz_2", title: "Paper Quiz", kind: "manual" },
      ]).length,
      3,
    );
  });

  it("keeps the file's order, which is what becomes the tiebreak order", () => {
    assert.deepEqual(
      ok([ARCADE, MANUAL, TRIVIA]).map((a) => a.id),
      ["arcade", "ttx", "trivia"],
    );
  });
});

describe("the list itself", () => {
  it("must be a list", () => {
    assert.deepEqual(errs({ activities: [TRIVIA] }), ["This must be a list of activities."]);
    assert.deepEqual(errs("trivia"), ["This must be a list of activities."]);
  });

  it("refuses an empty list, and says how to take the default", () => {
    const lines = errs([]);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /at least one activity/);
    assert.match(lines[0] ?? "", /leave the key out/);
  });

  it("refuses more than the ceiling", () => {
    const many = Array.from({ length: MAX_ACTIVITIES + 1 }, (_, i) => ({
      id: `a${i}`,
      title: `Activity ${i}`,
      kind: "manual",
    }));
    assert.deepEqual(errs(many), [`${MAX_ACTIVITIES + 1} activities; the most is ${MAX_ACTIVITIES}.`]);
    assert.equal(ok(many.slice(0, MAX_ACTIVITIES)).length, MAX_ACTIVITIES);
  });

  it("reports every problem at once, addressed by position", () => {
    assert.deepEqual(
      errs([{ id: "a", title: "A", kind: "nope" }, { id: "b", kind: "manual" }]),
      [
        'Activity 1, kind: "nope" is not an activity kind. Use trivia, arcade, manual.',
        "Activity 2, title: Missing, or not a string.",
      ],
    );
  });

  it("refuses an entry that is not an object", () => {
    assert.deepEqual(errs(["trivia"]), ["Activity 1: This is not an activity object."]);
    assert.deepEqual(errs([[TRIVIA]]), ["Activity 1: This is not an activity object."]);
  });
});

describe("unknown keys", () => {
  it("refuses a misspelled spotCap rather than defaulting it", () => {
    assert.deepEqual(errs([{ ...TRIVIA, spotcap: 4 }]), [
      'Activity 1, spotcap: Nothing reads a "spotcap" key. Check the spelling.',
    ]);
  });

  it("refuses a key nothing reads", () => {
    assert.deepEqual(errs([{ ...TRIVIA, facilitator: "someone" }]), [
      'Activity 1, facilitator: Nothing reads a "facilitator" key. Check the spelling.',
    ]);
  });
});

describe("kind", () => {
  it("takes each kind the engine has", () => {
    assert.equal(ok([TRIVIA])[0]?.kind, "trivia");
    assert.equal(ok([ARCADE])[0]?.kind, "arcade");
    assert.equal(ok([MANUAL])[0]?.kind, "manual");
  });

  it("refuses a typo, because that activity could never open", () => {
    assert.deepEqual(errs([{ ...TRIVIA, kind: "trvia" }]), [
      'Activity 1, kind: "trvia" is not an activity kind. Use trivia, arcade, manual.',
    ]);
  });

  it("refuses a missing kind", () => {
    assert.deepEqual(errs([{ id: "a", title: "A" }]), [
      "Activity 1, kind: Missing, or not a string. One of trivia, arcade, manual.",
    ]);
  });

  /**
   * The single slots. `state.trivia` and `state.arcade` hold one activity
   * each: a second trivia set silently replaces the first, and a second arcade
   * is refused by the reducer with a message about the phase. Both are
   * discovered live, so both are refused here instead.
   */
  it("refuses a second trivia", () => {
    assert.deepEqual(errs([TRIVIA, { id: "trivia-2", title: "More Trivia", kind: "trivia" }]), [
      "Activity 2, kind: Activity 1 is already the trivia. A session runs one trivia, and the second would never open.",
    ]);
  });

  it("refuses a second arcade", () => {
    assert.deepEqual(errs([ARCADE, { id: "arcade-2", title: "More Arcade", kind: "arcade" }]), [
      "Activity 2, kind: Activity 1 is already the arcade. A session runs one arcade, and the second would never open.",
    ]);
  });

  it("allows any number of manual activities — no slot to shadow", () => {
    assert.equal(ok([MANUAL, { id: "ttx2", title: "Second TTX", kind: "manual" }]).length, 2);
  });
});

describe("id", () => {
  it("refuses a repeat, because two activities would share one score", () => {
    assert.deepEqual(
      errs([MANUAL, { id: "ttx", title: "Another", kind: "manual" }]),
      ['Activity 2, id: "ttx" is already activity 1. Two activities with one id share one score.'],
    );
  });

  it("refuses a repeat that only differs by surrounding space", () => {
    assert.equal(errs([MANUAL, { id: " ttx ", title: "Another", kind: "manual" }]).length, 1);
  });

  it("refuses a missing or blank id", () => {
    assert.deepEqual(errs([{ title: "A", kind: "manual" }]), [
      'Activity 1, id: Missing, or not a string. Give a short name like "trivia".',
    ]);
    assert.deepEqual(errs([{ id: "  ", title: "A", kind: "manual" }]), [
      "Activity 1, id: The id is blank.",
    ]);
  });

  it("refuses an id with characters the console would have to quote", () => {
    for (const id of ["ttx 2", "ttx,2", "ttx:2", "-ttx", "TTX", "ttx/2", "tt.x"]) {
      const lines = errs([{ id, title: "A", kind: "manual" }]);
      assert.equal(lines.length, 1, `expected one error for ${JSON.stringify(id)}`);
      assert.match(lines[0] ?? "", /is not a usable id/);
    }
  });

  it("takes the shapes the default set and the docs use", () => {
    for (const id of ["trivia", "arcade", "ttx", "bake-off", "round_2", "a1"]) {
      assert.equal(ok([{ id, title: "A", kind: "manual" }])[0]?.id, id);
    }
  });

  it("refuses an id past the ceiling", () => {
    assert.deepEqual(errs([{ id: "x".repeat(MAX_ID_CHARS + 1), title: "A", kind: "manual" }]), [
      `Activity 1, id: ${MAX_ID_CHARS + 1} characters; the limit is ${MAX_ID_CHARS}.`,
    ]);
  });
});

describe("title", () => {
  it("refuses a blank title — a column with no header", () => {
    assert.deepEqual(errs([{ id: "a", title: "   ", kind: "manual" }]), [
      "Activity 1, title: The title is blank.",
    ]);
  });

  it("refuses a title past the ceiling", () => {
    assert.deepEqual(
      errs([{ id: "a", title: "T".repeat(MAX_TITLE_CHARS + 1), kind: "manual" }]),
      [`Activity 1, title: ${MAX_TITLE_CHARS + 1} characters; the limit is ${MAX_TITLE_CHARS}.`],
    );
  });

  it("counts code points, not UTF-16 units", () => {
    // Emoji are two units each; at the ceiling in glyphs this must load.
    const title = "🏆".repeat(MAX_TITLE_CHARS);
    assert.equal(ok([{ id: "a", title, kind: "manual" }])[0]?.title, title);
  });
});

describe("spotCap", () => {
  it("refuses a cap that is not a whole number", () => {
    assert.deepEqual(errs([{ ...TRIVIA, spotCap: 1.5 }]), [
      "Activity 1, spotCap: 1.5 is not a whole number of awards.",
    ]);
    assert.deepEqual(errs([{ ...TRIVIA, spotCap: "2" }]), [
      'Activity 1, spotCap: "2" is not a whole number of awards.',
    ]);
  });

  it("refuses a negative cap", () => {
    assert.deepEqual(errs([{ ...TRIVIA, spotCap: -1 }]), [
      "Activity 1, spotCap: -1 is not a whole number of awards.",
    ]);
  });

  it("refuses a cap past the ceiling", () => {
    assert.deepEqual(errs([{ ...TRIVIA, spotCap: MAX_SPOT_CAP + 1 }]), [
      `Activity 1, spotCap: ${MAX_SPOT_CAP + 1} awards; the most is ${MAX_SPOT_CAP}.`,
    ]);
  });
});
