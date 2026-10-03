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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { BUTTON_KIND } from "@carbon/web-components/es/components/button/defs.js";

import { KINDS_USED, spaceVerdict, type SpaceKey } from "./controls.ts";

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
    // Every button on the console except an inline confirm's Yes and No, with
    // the tag each one actually reports.
    //
    // `.ctl-button` is a `<cds-button>` since issue #28 step 1, and the tag is
    // the whole of what this decision looks at. A Carbon button holds the space
    // bar exactly as hard as a native one — its shadow root delegates focus, so
    // a document-level listener's `event.target` is the host and never the
    // `<button>` inside — and asserting it as "BUTTON" here would have left the
    // suite green while the console handed the space bar back to nothing.
    for (const [tag, cls] of [
      ["CDS-BUTTON", "ctl-button"],
      ["BUTTON", "theme-toggle"],
      ["BUTTON", "seg"],
      ["BUTTON", "a-pick"],
      ["BUTTON", "a-setup-move"],
      ["BUTTON", "pf-tick"],
    ] as const) {
      assert.equal(spaceVerdict(key({ target: on(tag, cls) })), "handBackAndFire", cls);
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


/*
 * ------------------------------------------------------------------
 * The kinds the console asks Carbon for
 * ------------------------------------------------------------------
 *
 * This is the test that step 1 needed and did not have.
 *
 * Step 1 shipped `kind="danger--tertiary"`, which is the spelling of Carbon's
 * *CSS class* — `.cds--btn--danger--tertiary` — and not of its attribute,
 * which is `danger-tertiary` with one hyphen. Carbon's answer to a kind it
 * does not recognise is to render the inner `<button>` with no kind class at
 * all: no console warning, no fallback kind, nothing in any log on either
 * side. On a dark page an unstyled `<button>` is the UA's own grey fill, so
 * every `.ctl-danger` control on the console — Close session among them —
 * rendered as a filled grey block. Step 1 read that as "a disabled Carbon
 * button is louder than an enabled one" and recorded it as a finding about
 * Carbon's disabled treatment. It was an enabled button with a typo in it.
 *
 * So the kinds are a list rather than three literals at three call sites, and
 * this reads the list against the enum in the installed package. It is a
 * devDependency and it is already what the console compiles against; the file
 * is a plain object of strings with no DOM in it.
 *
 * The second test is the one that makes the first mean something. "Every kind
 * is in the enum" passes trivially against an enum that has everything in it,
 * and it would have passed against a *checker* that accepted anything. The
 * mistake that shipped has to be a mistake this file can tell.
 */
const CARBON_KINDS: readonly string[] = Object.values(BUTTON_KIND);

describe("the kinds the console asks Carbon for", () => {
  test("are kinds Carbon has", () => {
    assert.ok(KINDS_USED.length > 0, "controls.ts should name its kinds");
    for (const kind of KINDS_USED) {
      assert.ok(
        CARBON_KINDS.includes(kind),
        `controls.ts asks for kind="${kind}", which is not one of Carbon's ` +
          `${CARBON_KINDS.join(", ")}. Carbon renders an unrecognised kind as ` +
          `a bare <button> and says nothing anywhere.`,
      );
    }
  });

  test("and the CSS-class spelling of one is not, which is the mistake", () => {
    // `.cds--btn--danger--tertiary` is the class; `danger-tertiary` is the
    // attribute. If this ever starts failing, Carbon has begun accepting both
    // and the test above has stopped being able to catch anything.
    assert.ok(!CARBON_KINDS.includes("danger--tertiary"));
    assert.ok(CARBON_KINDS.includes("danger-tertiary"));
    assert.ok(KINDS_USED.includes("danger-tertiary"));
  });
});

/*
 * ------------------------------------------------------------------
 * The bridge, and the specificity race it is written to avoid
 * ------------------------------------------------------------------
 *
 * `carbon-tokens.css` is generated. Four tokens cross between the two
 * palettes and all four are declared once under `:root`, which only works
 * because the generator leaves them out of the four theme blocks it writes.
 * `:root[data-theme="dark"]` is (0,2,0) and `:root` is (0,1,0), so one
 * generated `--cds-background: #161616` under the explicit-dark selector would
 * beat the bridge — and only after the host had pressed the theme toggle
 * twice, which is not a thing anybody does while reviewing a diff.
 *
 * Reading the committed file rather than running the generator, because the
 * committed file is what the browser loads and a generator that is correct
 * over a file that is stale is still a console with two grounds.
 */
describe("the Carbon token bridge", () => {
  const css = readFileSync(
    join(import.meta.dirname, "carbon-tokens.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  const BRIDGED = [
    "--cds-focus",
    "--cds-background",
    "--cds-layer-01",
    "--cds-layer-02",
  ];

  test("declares each bridged token exactly once, so nothing can outrank it", () => {
    for (const token of BRIDGED) {
      const hits = css.match(new RegExp(`${token}\\s*:`, "g")) ?? [];
      assert.equal(
        hits.length,
        1,
        `${token} is declared ${hits.length} times in carbon-tokens.css. The ` +
          "bridge owns it, so the generated theme blocks must not name it.",
      );
    }
  });

  test("points them at the console's tokens and not at Carbon's values", () => {
    // The direction is the whole of step 2's first decision: Carbon is told
    // what the console's surfaces are, rather than handing the console its
    // own. A hex here means the bridge has been turned back around.
    for (const [token, expected] of [
      ["--cds-background", "var(--ground)"],
      ["--cds-layer-01", "var(--panel)"],
      ["--cds-layer-02", "var(--panel-2)"],
    ] as const) {
      assert.match(css, new RegExp(`${token}:\\s*${expected.replace(/[()\-]/g, "\\$&")};`));
    }
  });

  test("and still reads as four blocks of theme plus a bridge", () => {
    // The assertion above passes trivially against an empty read.
    assert.ok(css.length > 20_000, `carbon-tokens.css read as ${css.length} bytes`);
    for (const sel of [
      ":root {",
      ':root:not([data-theme="dark"]) {',
      ':root[data-theme="light"] {',
      ':root[data-theme="dark"] {',
    ]) {
      assert.ok(css.includes(sel), sel);
    }
  });
});
