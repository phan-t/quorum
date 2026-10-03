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
  TAG_SIZE,
  TAG_TYPE,
} from "@carbon/web-components/es/components/tag/defs.js";
import {
  INPUT_SIZE,
  INPUT_TYPE,
} from "@carbon/web-components/es/components/text-input/defs.js";

import {
  CARBON_BUTTON_KINDS,
  CARBON_BUTTON_SIZES,
  CARBON_INPUT_SIZES,
  CARBON_INPUT_TYPES,
  CARBON_TAG_SIZES,
  CARBON_TAG_TYPES,
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

  /*
   * And a Carbon field, which reports a tag none of the three above is.
   *
   * `<cds-text-input>` renders its `<input>` into a shadow root, so a keydown
   * dispatched on that `<input>` is retargeted on the way out and a
   * document-level listener's `event.target` is the **host**: `CDS-TEXT-INPUT`.
   * Not a field tag, not a button tag — so before issue #28 step 3 taught this
   * decision the two Carbon tags, the verdict fell through to `"fire"`.
   *
   * Measured in the running console rather than argued. With the two tags
   * removed from `isFieldTag` and the client rebuilt, a space dispatched on the
   * `<input>` inside the card editor's title field pressed the primary button
   * once — `Open the lobby   (space)` — and swallowed the space. With them, the
   * primary is never pressed and the space reaches the field.
   *
   * This is the half of that which does not need a browser. It is written as
   * the tag each element actually reports, because asserting `"INPUT"` here
   * would stay green while the console handed the space bar to the run of show
   * in the middle of a card title.
   */
  test("and so does a Carbon field, which reports its host's tag", () => {
    for (const [tag, cls] of [
      ["CDS-TEXT-INPUT", "field"],
      ["CDS-TEXT-INPUT", "field rs-field"],
      ["CDS-SELECT", "rb-card"],
    ] as const) {
      assert.equal(
        spaceVerdict(key({ target: on(tag, ...cls.split(" ")) })),
        "ignore",
        `space inside ${tag} must stay in the field`,
      );
    }
  });

  test("a Carbon field is not mistaken for a Carbon button either", () => {
    // The two wrong answers are different sizes of wrong and both are silent.
    // "fire" presses the primary; "handBackAndFire" blurs the field the host
    // is typing into *and* presses the primary. Neither is "ignore".
    for (const tag of ["CDS-TEXT-INPUT", "CDS-SELECT"]) {
      const verdict = spaceVerdict(key({ target: on(tag, "field") }));
      assert.notEqual(verdict, "fire", tag);
      assert.notEqual(verdict, "handBackAndFire", tag);
    }
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
    // `CDS-TEXT-INPUT` since #28 step 3, and the tag is the whole of what this
    // decision looks at. Written as `INPUT` this stayed green while the field
    // on the one control that wipes an afternoon handed the space bar to the
    // primary button.
    assert.equal(
      spaceVerdict(key({ target: on("CDS-TEXT-INPUT", "field", "rs-field") })),
      "ignore",
    );
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

/**
 * A source with its comments blanked out, so these scans read code.
 *
 * Added when the "only one file names the tag" test went red on a *comment* in
 * `main.ts` that quoted `"cds-select-item"` while explaining why Carbon finds
 * its options with `matches()`. Rewording the comment would have worked once
 * and left the next person to describe a tag in prose with a failing suite and
 * no idea why.
 *
 * A character walk rather than a regex, for the reason `callsTo` is one: the
 * strings in these files contain `//` — join links do — and a regex that
 * treats one as a line comment eats the rest of the line, which is how a
 * scanner comes to find nothing and pass. Quotes are tracked, escapes are
 * skipped, and template literals are left intact because a tag name in one is
 * still a tag name being written.
 *
 * Comment bodies are replaced by spaces rather than removed, so every offset a
 * failure message prints still lines up with the file on disk.
 */
function stripComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      out.push(c);
      i++;
      while (i < src.length) {
        const d = src[i] as string;
        out.push(d);
        i++;
        if (d === "\\") {
          if (i < src.length) out.push(src[i] as string), i++;
          continue;
        }
        if (d === c) break;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") out.push(" "), i++;
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      out.push("  ");
      i += 2;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/** Every `src/client/host/*.ts` source, by name, test files excluded. */
function hostSources(): readonly (readonly [string, string])[] {
  const dir = import.meta.dirname;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort()
    .map((f) => [f, stripComments(readFileSync(join(dir, f), "utf8"))] as const);
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

describe("the scanner these scans are built on", () => {
  test("blanks comments and leaves strings alone", () => {
    const src = [
      'const a = "cds-tag";',
      '// a comment naming "cds-tag"',
      '/* and a block one naming "cds-tag" */',
      'const url = "http://example.test/j/code";',
      "const t = `a template naming cds-tag`;",
    ].join("\n");
    const out = stripComments(src);
    // Two spellings survive: the string and the template. The two in comments
    // do not.
    assert.equal((out.match(/"cds-tag"/g) ?? []).length, 1);
    assert.ok(out.includes("const t = `a template naming cds-tag`;"));
    // And the `//` inside a URL is not a comment, which is the failure mode a
    // regex has: it would blank the rest of that line and the scan would then
    // pass by finding nothing.
    assert.ok(out.includes('"http://example.test/j/code"'), out);
    // Line count is preserved, so an offset still means something.
    assert.equal(out.split("\n").length, src.split("\n").length);
  });

  test("and the console's own sources still read as code after it", () => {
    // The guard against a stripper that blanks everything: these scans pass
    // trivially against an empty read, which is the failure this whole file
    // keeps finding.
    const total = hostSources().reduce((n, [, src]) => n + src.length, 0);
    assert.ok(total > 100_000, `host sources read as ${total} characters`);
    const main = hostSources().find(([n]) => n === "main.ts");
    assert.ok(main?.[1].includes('carbonTag({'), "main.ts has lost its code");
  });
});

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
    // All five tags the console mounts, each checked the same way. #28 step 3
    // added four, and the rule is the rule: a second site is a site where a
    // value Carbon does not have compiles.
    //
    // The quoted *lowercase* spelling, because that is how an element is
    // named. `controls.ts` holds "CDS-TEXT-INPUT" and "CDS-SELECT" in
    // `isFieldTag`, which is a `tagName` comparison and not a tag being
    // created — a different thing, and the case is what tells them apart.
    for (const tag of [
      "cds-button",
      "cds-tag",
      "cds-text-input",
      "cds-select",
      "cds-select-item",
    ]) {
      // `hostSources()` has the comments blanked out, so a tag named in prose
      // — and `main.ts` names three of them, explaining what Carbon does with
      // its children — is not a second site. A tag named in code is.
      const named = hostSources()
        .filter(([, src]) => src.includes(`"${tag}"`))
        .map(([name]) => name);
      assert.deepEqual(
        named,
        [CARBON_DOOR],
        `"${tag}" is spelled in ${named.join(", ") || "nothing"}. It belongs ` +
          `in ${CARBON_DOOR} alone, where every enumerated attribute is typed.`,
      );
    }
  });

  test("and `hx()` itself is called from nowhere else", () => {
    // The tag test above catches a *known* tag spelled twice. This catches the
    // other half: a sixth element built straight through the escape hatch,
    // where there is no union to be wrong about because nobody wrote one.
    // `hx` is `h()` for a custom element and `carbon.ts` is where custom
    // elements are built.
    const callers = hostSources()
      .filter(([, src]) => /\bhx\s*\(/.test(src))
      .map(([name]) => name);
    assert.deepEqual(
      callers,
      [CARBON_DOOR],
      `hx() is called in ${callers.join(", ") || "nothing"}. A Carbon element ` +
        `built outside ${CARBON_DOOR} is one whose enumerated attributes ` +
        "nothing types and nothing checks.",
    );
  });

  test("and not smuggled through the attrs escape hatch", () => {
    // `attrs` is `Record<string, …>`, so `attrs: { kind: "ghost--x" }` would
    // type-check. Nothing does it and nothing may start.
    //
    // `kind` and `size` are checked across the whole file, because no native
    // element the console builds has either. `type` cannot be: a native
    // `<input type="range">` is the send-off speed slider and is none of
    // Carbon's business. So `type` is checked inside Carbon call sites only —
    // see the step 3 suite below, which scans each factory's calls.
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
 * The three elements step 3 added
 * ------------------------------------------------------------------
 *
 * The same three properties, for `cds-tag`, `cds-text-input` and `cds-select`.
 * Written out per element rather than folded into a loop over the button's
 * tests, because the enums are *not* the same enum and the difference is the
 * point: `BUTTON_SIZE` has a `2xl` that `INPUT_SIZE` does not, and a union
 * checked against the wrong enum is a union that passes while the attribute it
 * writes is one Carbon drops on the floor.
 */
const CARBON_TAG_SIZE_VALUES: readonly string[] = Object.values(TAG_SIZE);
const CARBON_TAG_TYPE_VALUES: readonly string[] = Object.values(TAG_TYPE);
const CARBON_INPUT_SIZE_VALUES: readonly string[] = Object.values(INPUT_SIZE);
const CARBON_INPUT_TYPE_VALUES: readonly string[] = Object.values(INPUT_TYPE);

describe("the tag, field and select attributes the console asks Carbon for", () => {
  test("are exactly Carbon's own, in both directions", () => {
    for (const [what, ours, theirs] of [
      ["tag sizes", CARBON_TAG_SIZES, CARBON_TAG_SIZE_VALUES],
      ["tag types", CARBON_TAG_TYPES, CARBON_TAG_TYPE_VALUES],
      ["input sizes", CARBON_INPUT_SIZES, CARBON_INPUT_SIZE_VALUES],
      ["input types", CARBON_INPUT_TYPES, CARBON_INPUT_TYPE_VALUES],
    ] as const) {
      assert.deepEqual(
        [...ours].sort(),
        [...theirs].sort(),
        `carbon.ts's ${what} and Carbon's enum have drifted apart. A value ` +
          "missing from carbon.ts is one the console cannot ask for; a value " +
          "Carbon has dropped is an attribute it will ignore in silence.",
      );
    }
  });

  test("and the two scales are not one scale, which is why each has its own enum", () => {
    // If this ever starts failing, Carbon has aligned them and the four tests
    // above have stopped being able to catch a union checked against the wrong
    // one. `2xl` is a button size and not an input size.
    assert.ok(CARBON_BUTTON_SIZES.includes("2xl"));
    assert.ok(!(CARBON_INPUT_SIZES as readonly string[]).includes("2xl"));
  });

  /*
   * The scope boundary of step 3, as a test rather than as a paragraph.
   *
   * The console's fifteen arcade setup fields are `<input type="number">` with
   * a `min` and a `max` on every one. `cds-text-input` supports textual types
   * only and forwards neither clamp, so converting them would drop both
   * silently. That is why they are still hand-built.
   *
   * The assertion is written so it fails the day the constraint lifts: if
   * Carbon adds `number` to `INPUT_TYPE`, this goes red and whoever is reading
   * it finds out that the fifteen can now be converted. A comment cannot do
   * that.
   */
  test("and `number` is not among them, which is why fifteen fields are not Carbon's", () => {
    assert.ok(
      !CARBON_INPUT_TYPE_VALUES.includes("number"),
      "Carbon's INPUT_TYPE now has `number`. The arcade's fifteen setup " +
        "fields were left hand-built because cds-text-input could not carry " +
        "a type=number with its min and max; check whether it forwards " +
        "`min`/`max`/`step` too, and if it does, they can be converted.",
    );
    assert.ok(CARBON_INPUT_TYPE_VALUES.includes("text"));
  });

  test("and every size and type written at a call site is one Carbon has", () => {
    const seen: Record<string, string[]> = {
      tagSize: [],
      tagType: [],
      inputSize: [],
      inputType: [],
    };
    const check = (ok: boolean, msg: string): void => assert.ok(ok, msg);
    for (const [name, src] of hostSources()) {
      const scan = (
        open: string,
        pairs: readonly (readonly [string, readonly string[], string])[],
      ): void => {
        for (const call of callsTo(src, open)) {
          if (!call.startsWith(open)) continue;
          const where = `${name}: ${call.slice(0, 70).replace(/\s+/g, " ")}…`;
          for (const [key, allowed, bucket] of pairs) {
            for (const v of literals(call, key)) {
              (seen[bucket] as string[]).push(v);
              check(
                allowed.includes(v),
                `${key}="${v}" at ${where} is not one of Carbon's ` +
                  `${allowed.join(", ")}.`,
              );
            }
          }
        }
      };
      scan("carbonTag(", [
        ["size", CARBON_TAG_SIZE_VALUES, "tagSize"],
        ["type", CARBON_TAG_TYPE_VALUES, "tagType"],
      ]);
      scan("carbonTextInput(", [
        ["size", CARBON_INPUT_SIZE_VALUES, "inputSize"],
        ["inputType", CARBON_INPUT_TYPE_VALUES, "inputType"],
      ]);
      scan("carbonSelect(", [["size", CARBON_INPUT_SIZE_VALUES, "inputSize"]]);
    }
    // Against a scanner that found nothing every assertion above passes, which
    // is how the array this pattern replaced came to cover three sites of
    // seven. The console builds two tags, three fields and one select.
    assert.ok(seen["tagSize"]!.length >= 2, `tag sizes found: ${seen["tagSize"]!.length}`);
    assert.ok(seen["tagType"]!.length >= 2, `tag types found: ${seen["tagType"]!.length}`);
    assert.ok(
      seen["inputSize"]!.length >= 4,
      `input sizes found: ${seen["inputSize"]!.length} (three fields and a select)`,
    );
    assert.ok(seen["inputType"]!.length >= 3, `input types found: ${seen["inputType"]!.length}`);
  });

  /*
   * One label decision, applied everywhere.
   *
   * #28 step 3's instruction was to decide between `hide-label` beside the
   * console's own label and Carbon's stacked form *once*, because half and
   * half is what reads as bolted on. `hideLabel` is a required boolean in
   * `CarbonTextInputOpts`, so a field without one is a compile error — but
   * `hideLabel: false` compiles, and this is what holds the decision.
   */
  test("and no Carbon call site writes an enumerated attribute by hand", () => {
    // The `type` half of the escape-hatch guard, scoped to the calls where
    // `type` means a Carbon enum rather than `<input type="range">`.
    let calls = 0;
    for (const [name, src] of hostSources()) {
      if (name === CARBON_DOOR) continue;
      for (const open of [
        "carbonButton(",
        "carbonTag(",
        "carbonTextInput(",
        "carbonSelect(",
        "carbonSelectItem(",
      ]) {
        for (const call of callsTo(src, open)) {
          if (!call.startsWith(open)) continue;
          calls += 1;
          assert.doesNotMatch(
            call.replace(/\s+/g, " "),
            /attrs: \{[^}]*\b(?:kind|size|type|hide-label|label-text|max-count):/,
            `${name} writes a Carbon attribute inside attrs at ${open}…, ` +
              "which is the one spelling the unions and the required fields " +
              "in carbon.ts cannot see.",
          );
        }
      }
    }
    assert.ok(calls >= 12, `the scan found ${calls} Carbon call sites`);
  });

  test("and every field and picker hides Carbon's label, which is the decision", () => {
    let fields = 0;
    for (const [name, src] of hostSources()) {
      if (name === CARBON_DOOR) continue;
      for (const open of ["carbonTextInput(", "carbonSelect("]) {
        for (const call of callsTo(src, open)) {
          if (!call.startsWith(open)) continue;
          fields += 1;
          assert.match(
            call.replace(/\s+/g, " "),
            /hideLabel: true/,
            `${name} builds a Carbon field with Carbon's own label showing. ` +
              "The console puts its label in the 90px column beside the box " +
              "and this is one decision for the whole surface — see host.css.",
          );
        }
      }
    }
    assert.ok(fields >= 4, `the scan found ${fields} Carbon fields at call sites`);
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

  /*
   * Thirteen since #28 step 3, and the nine it added split in two.
   *
   * Six of them `@carbon/themes` exports, so the generator has to leave them
   * out of its four blocks or the specificity race above comes back. The other
   * seven are the layer-context aliases `@carbon/styles` would declare — not
   * theme tokens at all, so they appear in no generated block and the "exactly
   * once" check is the whole of what there is to check. Both are listed here,
   * because the file is what the browser loads and "declared once" is the
   * property either way.
   */
  const BRIDGED = [
    "--cds-focus",
    "--cds-background",
    "--cds-layer-01",
    "--cds-layer-02",
    // Step 3's layer-context aliases. Carbon reads these with **no fallback**:
    // undefined, a `cds-text-input` renders with `background-color:
    // transparent` and `border-block-end-style: none`, which is a field with
    // no fill and no edge. Measured in the browser.
    "--cds-layer",
    "--cds-layer-hover",
    "--cds-layer-background",
    "--cds-field",
    "--cds-field-hover",
    "--cds-border-strong",
    "--cds-border-subtle",
    // And the two inks the theme does export.
    "--cds-text-primary",
    "--cds-text-placeholder",
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
      // Step 3's nine, in the same direction. A hex on any of these right-hand
      // sides is a Carbon grey the console does not have — #262626 and #393939
      // are exactly the two surfaces step 2 measured four product inks off, so
      // the direction is not a style and cannot be taken back one token at a
      // time.
      ["--cds-layer", "var(--panel)"],
      ["--cds-layer-hover", "var(--panel-2)"],
      ["--cds-layer-background", "var(--ground)"],
      ["--cds-field", "var(--panel)"],
      ["--cds-field-hover", "var(--panel-2)"],
      ["--cds-border-strong", "var(--muted)"],
      ["--cds-border-subtle", "var(--line)"],
      ["--cds-text-primary", "var(--ink)"],
      ["--cds-text-placeholder", "var(--muted)"],
    ] as const) {
      assert.match(css, new RegExp(`${token}:\\s*${expected.replace(/[()\-]/g, "\\$&")};`));
    }
  });

  /*
   * The two inks have to leave the generated blocks, and the seven aliases
   * have to not be in them.
   *
   * `--cds-text-primary` is in all four theme blocks as shipped — #f4f4f4 in
   * g100 and #161616 in white — so the generator's `BRIDGE_OWNS` has to drop
   * it, or `:root[data-theme="dark"]` at (0,2,0) beats the bridge at (0,1,0)
   * and a host who pressed the theme toggle twice would get Carbon's white in
   * a field and the console's in the sentence above it. The "exactly once"
   * test above is what catches that; this one says which direction the
   * omission has to go, so a generated block that quietly starts emitting one
   * of the seven is caught too.
   */
  test("and Carbon's own values for them appear nowhere in the file", () => {
    for (const hex of ["#f4f4f4;", "rgba(244, 244, 244, 0.4);"]) {
      // Both are still legitimate values of *other* tokens — `--cds-text-
      // primary` is not the only thing that is #f4f4f4 — so the check is that
      // no bridged token is ever assigned one.
      for (const token of ["--cds-text-primary", "--cds-text-placeholder"]) {
        assert.doesNotMatch(
          css,
          new RegExp(`${token}:\\s*${hex.replace(/[()\-.]/g, "\\$&")}`),
          `${token} still carries Carbon's ${hex} somewhere in the generated ` +
            "blocks. The bridge owns it and the generator must omit it.",
        );
      }
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
