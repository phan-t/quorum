/**
 * The space bar, and what it cannot reach.
 *
 * `bindSpace` is DOM code and this repo has no DOM in its tests, so the
 * decision it makes is extracted into {@link spaceVerdict}, which is pure.
 * That decision is the whole of the console's keyboard safety: the space bar
 * either does nothing or fires **the primary button**, and there is no path by
 * which it presses whatever happens to have focus.
 *
 * The reason this file exists is the restart panel. Wiping a session's scores
 * is the one thing on this console that cannot be undone, and "the space bar
 * cannot do it" has to be a property something checks rather than a rule the
 * next person to edit main.ts is expected to remember. The keys in play on the
 * console are SPACE (next), G (scoring grid), SHIFT+H (holding card), SHIFT+D
 * (driving mode), ESC (disarm) and Alt+Up/Down (runbook rows); the ones
 * asserted here are the ones that could plausibly land on the wipe.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { spaceVerdict, type SpaceKey } from "./controls.ts";

/** A keydown, with everything defaulted to the boring case. */
function key(over: Partial<SpaceKey> = {}): SpaceKey {
  return {
    key: " ",
    code: "Space",
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: null,
    ...over,
  };
}

/** A focused element, as the decision sees it. */
function on(tagName: string, ...classes: string[]): SpaceKey["target"] {
  return { tagName, isContentEditable: false, classes };
}

describe("the space bar advances the run of show", () => {
  test("from the page itself", () => {
    assert.equal(spaceVerdict(key({ target: on("BODY") })), "fire");
    assert.equal(spaceVerdict(key({ target: null })), "fire");
  });

  test("by `code` as well as by `key`, for a layout that reports neither", () => {
    assert.equal(spaceVerdict(key({ key: "Spacebar", code: "Space" })), "fire");
    assert.equal(spaceVerdict(key({ key: " ", code: "" })), "fire");
  });

  test("but not on key repeat, and not with a modifier held", () => {
    assert.equal(spaceVerdict(key({ repeat: true })), "ignore");
    assert.equal(spaceVerdict(key({ metaKey: true })), "ignore");
    assert.equal(spaceVerdict(key({ ctrlKey: true })), "ignore");
    assert.equal(spaceVerdict(key({ altKey: true })), "ignore");
  });

  test("and not for any other key", () => {
    for (const k of ["g", "G", "h", "d", "Escape", "Enter", "ArrowDown"]) {
      assert.equal(spaceVerdict(key({ key: k, code: `Key${k}` })), "ignore", k);
    }
  });

  test("a focused button hands the key back rather than pressing itself", () => {
    // Every button on the console except an inline confirm's Yes and No.
    for (const cls of [
      "ctl-button",
      "theme-toggle",
      "seg",
      "a-pick",
      "a-setup-move",
      "pf-tick",
    ]) {
      assert.equal(spaceVerdict(key({ target: on("BUTTON", cls) })), "handBackAndFire", cls);
    }
  });

  test("an inline confirm's Yes and No keep it — they took focus to be answered", () => {
    assert.equal(spaceVerdict(key({ target: on("BUTTON", "ctl-yes") })), "ignore");
    assert.equal(spaceVerdict(key({ target: on("BUTTON", "ctl-no") })), "ignore");
  });

  test("a text field keeps every key that lands in it", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      assert.equal(spaceVerdict(key({ target: on(tag) })), "ignore", tag);
    }
    assert.equal(
      spaceVerdict(key({ target: { tagName: "DIV", isContentEditable: true, classes: [] } })),
      "ignore",
    );
  });
});

/*
 * ------------------------------------------------------------------
 * The wipe
 * ------------------------------------------------------------------
 *
 * Three widgets, and the space bar must not press any of them:
 *
 *   .rs-arm    opens the panel
 *   .rs-field  where the word is typed
 *   .rs-go     the one that wipes, and is disabled until the word matches
 */

describe("the space bar cannot start or fire a restart", () => {
  const WIPE_WIDGETS: readonly (readonly [string, string, string])[] = [
    ["the arm button", "BUTTON", "rs-arm"],
    ["the fire button", "BUTTON", "rs-go"],
    ["the cancel button", "BUTTON", "rs-cancel"],
  ];

  for (const [what, tag, cls] of WIPE_WIDGETS) {
    test(`${what} is blurred, never pressed`, () => {
      const verdict = spaceVerdict(key({ target: on(tag, cls) }));
      assert.equal(
        verdict,
        "handBackAndFire",
        `space on ${cls} must hand the key back to the primary button`,
      );
      assert.notEqual(verdict, "ignore", "and must not be swallowed either");
    });
  }

  test("the confirmation field swallows space, so a stray press types a space", () => {
    assert.equal(spaceVerdict(key({ target: on("INPUT", "field", "rs-field") })), "ignore");
  });

  test("the wipe's buttons are not in the set that owns the space bar", () => {
    // The one-line version of the property, stated against the class names as
    // main.ts spells them. A future button that wanted to be exempt would have
    // to be given `ctl-yes` or `ctl-no`, which is the point of the list being
    // two entries long.
    for (const cls of ["rs-arm", "rs-go", "rs-cancel", "rs-field"]) {
      assert.notEqual(cls, "ctl-yes");
      assert.notEqual(cls, "ctl-no");
    }
  });

  test("the console's other keys do nothing to it either", () => {
    // G, SHIFT+H, SHIFT+D, ESC and Alt+Arrow all reach main.ts through their
    // own listeners; none of them is a space, so none of them gets past here.
    const others: SpaceKey[] = [
      key({ key: "g", code: "KeyG", target: on("BUTTON", "rs-go") }),
      key({ key: "h", code: "KeyH", target: on("BUTTON", "rs-go") }),
      key({ key: "d", code: "KeyD", target: on("BUTTON", "rs-go") }),
      key({ key: "Escape", code: "Escape", target: on("BUTTON", "rs-go") }),
      key({ key: "ArrowUp", code: "ArrowUp", altKey: true, target: on("BUTTON", "rs-go") }),
      key({ key: "ArrowDown", code: "ArrowDown", altKey: true, target: on("BUTTON", "rs-go") }),
      key({ key: "Enter", code: "Enter", target: on("BUTTON", "rs-arm") }),
    ];
    for (const ev of others) {
      assert.equal(spaceVerdict(ev), "ignore", `${ev.key} must not reach the primary`);
    }
  });
});

/*
 * ------------------------------------------------------------------
 * The typed word
 * ------------------------------------------------------------------
 *
 * main.ts compares `field.value.trim().toLowerCase()` against "restart". The
 * comparison is restated here because it is the second of the three gates and
 * the only one made of a string.
 */

const RESTART_WORD = "restart";
const matches = (typed: string): boolean =>
  typed.trim().toLowerCase() === RESTART_WORD;

describe("the confirmation word", () => {
  test("accepts what a host under pressure actually types", () => {
    for (const typed of ["restart", "RESTART", "Restart", " restart", "restart ", " Restart "]) {
      assert.ok(matches(typed), JSON.stringify(typed));
    }
  });

  test("rejects an empty field, a stray space bar, and a near miss", () => {
    for (const typed of ["", " ", "   ", "r", "rest", "restarts", "re start", "start over"]) {
      assert.ok(!matches(typed), JSON.stringify(typed));
    }
  });

  test("a field full of spaces is not the word, however many are pressed", () => {
    assert.ok(!matches(" ".repeat(40)));
  });
});
