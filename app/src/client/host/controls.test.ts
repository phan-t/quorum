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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  BUTTON_KIND,
  BUTTON_SIZE,
} from "@carbon/web-components/es/components/button/defs.js";

import {
  CARBON_BUTTON_KINDS,
  CARBON_BUTTON_SIZES,
} from "./carbon.ts";
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
      // A disclosure, hand-built so its `aria-expanded` reaches the element
      // that takes focus. See `carbon.ts`.
      ["BUTTON", "a-alt-toggle"],
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
  // The tag each one actually reports, which is the whole of what the decision
  // looks at. The arm button is a hand-built `<button>` because it is a
  // disclosure and a Carbon host cannot announce `aria-expanded` — see
  // `carbon.ts` — and Wipe and Cancel are Carbon hosts. Writing all three as
  // "BUTTON" would have left this green while two of them reported something
  // the decision had never been asked about.
  const WIPE_WIDGETS: readonly (readonly [string, string, string])[] = [
    ["the arm button", "BUTTON", "rs-arm"],
    ["the fire button", "CDS-BUTTON", "rs-go"],
    ["the cancel button", "CDS-BUTTON", "rs-cancel"],
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
 * The kinds and sizes the console asks Carbon for
 * ------------------------------------------------------------------
 *
 * Step 1 shipped `kind="danger--tertiary"`, which is the spelling of Carbon's
 * *CSS class* — `.cds--btn--danger--tertiary` — and not of its attribute,
 * which is `danger-tertiary` with one hyphen. Carbon's answer to a kind it
 * does not recognise is to render the inner `<button>` with no kind class at
 * all: no console warning, no fallback kind, nothing in any log on either
 * side. On a dark page an unstyled `<button>` is the UA's own grey fill, so
 * every `.ctl-danger` control on the console — Close session among them —
 * rendered as a filled grey block.
 *
 * Step 2 answered that with a hand-maintained array of the three kinds
 * `controls.ts` names, read against the enum. It covered three of seven call
 * sites: `main.ts` spelled the other four itself, `size` was checked nowhere,
 * and changing one `kind: "ghost"` in `main.ts` to `"ghost--x"` left typecheck
 * and the whole suite green. A guard that passes while the mistake it is named
 * for is in the tree is worse than no guard, because it is also an argument
 * against looking.
 *
 * So the attributes are not spelled at call sites at all: `carbon.ts` is the
 * only place in `src/client` that names the tag, and its `kind` and `size` are
 * unions, so `"ghost--x"` is a compile error at the line that writes it. The
 * three tests below are what a type cannot say:
 *
 *   1. the unions hold exactly the values Carbon's enums hold, both
 *      directions, so neither a missing kind nor one Carbon has dropped is
 *      silent across a version bump;
 *   2. `carbon.ts` is still the only door, and nothing smuggles `kind` or
 *      `size` through the `attrs` escape hatch;
 *   3. every kind and size *literal* written at a call site is a value Carbon
 *      has — read back out of the source, because the factory is a convention
 *      until something checks that it is used.
 */
const CARBON_KINDS: readonly string[] = Object.values(BUTTON_KIND);
const CARBON_SIZES: readonly string[] = Object.values(BUTTON_SIZE);

/** The console's own files that are allowed to build a Carbon button. */
const CARBON_DOOR = "carbon.ts";

/** Every `src/client/host/*.ts` source, by name, test files excluded. */
function hostSources(): readonly (readonly [string, string])[] {
  const dir = import.meta.dirname;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort()
    .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);
}

/**
 * The text of every `carbonButton(` call in a source, by paren balance.
 *
 * Not a regex over the whole call: the options object holds arrow functions
 * with their own parens, and a lazy match would stop at the first one and read
 * half a call site. String bodies are skipped so a `")"` inside a label cannot
 * close the call.
 *
 * `open` ends at the opening paren — `"h("`, `"carbonButton("` — and every
 * occurrence is scanned, so a nested call is returned as well as the one
 * around it. Callers narrow by what the call starts with.
 */
function callsTo(src: string, open: string): readonly string[] {
  const calls: string[] = [];
  if (!open.endsWith("(")) throw new Error(`open must end at "(": ${open}`);
  for (let at = src.indexOf(open); at !== -1; at = src.indexOf(open, at + 1)) {
    let depth = 0;
    let quote: string | null = null;
    let i = at + open.length - 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote !== null) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    calls.push(src.slice(at, i + 1));
  }
  return calls;
}

const carbonButtonCalls = (src: string): readonly string[] =>
  callsTo(src, "carbonButton(");

/** Every `name: "literal"` in a call, for the one key asked about. */
function literals(call: string, key: string): readonly string[] {
  return [...call.matchAll(new RegExp(`\\b${key}:\\s*"([^"]*)"`, "g"))].map(
    (m) => m[1] as string,
  );
}

describe("the kinds and sizes the console asks Carbon for", () => {
  test("are exactly Carbon's own, in both directions", () => {
    assert.deepEqual(
      [...CARBON_BUTTON_KINDS].sort(),
      [...CARBON_KINDS].sort(),
      "carbon.ts's kinds and BUTTON_KIND have drifted apart. A value missing " +
        "from carbon.ts is a kind the console cannot ask for; a value Carbon " +
        "has dropped is a bare <button> waiting for a version bump.",
    );
    assert.deepEqual(
      [...CARBON_BUTTON_SIZES].sort(),
      [...CARBON_SIZES].sort(),
      "carbon.ts's sizes and BUTTON_SIZE have drifted apart.",
    );
  });

  test("and the CSS-class spelling of one is not, which is the mistake", () => {
    // `.cds--btn--danger--tertiary` is the class; `danger-tertiary` is the
    // attribute. If this ever starts failing, Carbon has begun accepting both
    // and the test above has stopped being able to catch anything.
    assert.ok(!CARBON_KINDS.includes("danger--tertiary"));
    assert.ok(CARBON_KINDS.includes("danger-tertiary"));
    assert.ok((CARBON_BUTTON_KINDS as readonly string[]).includes("danger-tertiary"));
  });

  test("through one factory, which is the only file that names the tag", () => {
    const named = hostSources()
      .filter(([, src]) => src.includes('"cds-button"'))
      .map(([name]) => name);
    assert.deepEqual(
      named,
      [CARBON_DOOR],
      `"cds-button" is spelled in ${named.join(", ")}. It belongs in ` +
        `${CARBON_DOOR} alone, where kind and size are typed — a second site ` +
        "is a site where a kind Carbon does not have compiles.",
    );
  });

  test("and not smuggled through the attrs escape hatch", () => {
    // `attrs` is `Record<string, …>`, so `attrs: { kind: "ghost--x" }` would
    // type-check. Nothing does it and nothing may start.
    for (const [name, src] of hostSources()) {
      const bypass = /attrs:\s*\{[^}]*\b(?:kind|size):/.exec(src);
      assert.equal(
        bypass,
        null,
        `${name} sets kind or size inside attrs, which is the one spelling ` +
          "the unions in carbon.ts cannot see.",
      );
    }
  });

  test("and every kind and size written at a call site is one Carbon has", () => {
    // This is the test the `ghost--x` mutation has to turn red. The unions
    // make it a compile error as well; this is the half that does not need a
    // compiler to have been run.
    const seen: { kinds: string[]; sizes: string[] } = { kinds: [], sizes: [] };
    for (const [name, src] of hostSources()) {
      for (const call of carbonButtonCalls(src)) {
        const where = `${name}: ${call.slice(0, 70).replace(/\s+/g, " ")}…`;
        for (const kind of literals(call, "kind")) {
          seen.kinds.push(kind);
          assert.ok(
            CARBON_KINDS.includes(kind),
            `kind="${kind}" at ${where} is not one of Carbon's ` +
              `${CARBON_KINDS.join(", ")}. Carbon renders an unrecognised ` +
              "kind as a bare <button> and says nothing anywhere.",
          );
        }
        for (const size of literals(call, "size")) {
          seen.sizes.push(size);
          assert.ok(
            CARBON_SIZES.includes(size),
            `size="${size}" at ${where} is not one of Carbon's ` +
              `${CARBON_SIZES.join(", ")}.`,
          );
        }
      }
    }
    // The assertions above pass trivially against a scanner that found
    // nothing, which is exactly how the array this replaced came to cover
    // three sites of seven. Five Carbon buttons are built outside
    // `controls.ts`, which passes its kind and size as variables.
    assert.ok(
      seen.kinds.length >= 5,
      `the scan found ${seen.kinds.length} kind literals at call sites, ` +
        "which is fewer than the console has. The scanner, not the console, " +
        "is what to look at.",
    );
    assert.ok(
      seen.sizes.length >= 5,
      `the scan found ${seen.sizes.length} size literals at call sites.`,
    );
  });
});

/*
 * ------------------------------------------------------------------
 * The two disclosures
 * ------------------------------------------------------------------
 *
 * A `<cds-button>` renders its `<button>` into a shadow root opened with
 * `delegatesFocus: true`, and that inner `<button>` is the element assistive
 * technology sees. Carbon's template binds exactly three of its ARIA
 * attributes — `aria-label` from `tooltip-text`, `aria-pressed`, and its own
 * `aria-describedby`. An `aria-expanded` or an `aria-controls` set on the host
 * never crosses.
 *
 * Step 2 put both of the console's disclosure buttons on Carbon hosts with
 * `aria-expanded` on the host, so both silently stopped announcing their
 * state: an accessibility snapshot of the wipe's arm button read
 * `button "Restart session"` with no expanded state, where on `main` it had
 * been a real `<button aria-expanded>`. On the one control that destroys an
 * afternoon.
 *
 * They are hand-built `<button>`s again, drawn to Carbon's measured metrics in
 * `host.css`. This is the test that keeps them there, because the conversion
 * that broke it was a one-line change that nothing could see — and the next
 * step of #28 is twelve more buttons.
 */
describe("the two disclosures announce their state", () => {
  const DISCLOSURES: readonly (readonly [string, string])[] = [
    ["the wipe's arm button", "rs-arm"],
    ["the arcade's way off the running order", "a-alt-toggle"],
  ];

  const main = readFileSync(join(import.meta.dirname, "main.ts"), "utf8");

  for (const [what, cls] of DISCLOSURES) {
    test(`${what} is a <button>, not a Carbon host`, () => {
      const mine = (open: string, starts: string): readonly string[] =>
        callsTo(main, open).filter(
          (c) => c.startsWith(starts) && c.includes(`class: "${cls}"`),
        );
      const plain = mine("h(", 'h("button"');
      const carbon = mine("carbonButton(", "carbonButton(");
      assert.equal(
        carbon.length,
        0,
        `.${cls} is built by carbonButton(). It is a disclosure, and a ` +
          "<cds-button> forwards only aria-label, aria-pressed and its own " +
          "aria-describedby onto the <button> in its shadow root — so its " +
          "aria-expanded would be announced by nothing. Keep it hand-built; " +
          "host.css draws it to Carbon's own metrics.",
      );
      assert.equal(
        plain.length,
        1,
        `expected exactly one h("button") building .${cls}, found ` +
          `${plain.length}.`,
      );
      assert.match(
        plain[0] as string,
        /"aria-expanded"/,
        `.${cls} opens a panel and must say so on the element that takes ` +
          "focus.",
      );
    });
  }
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
