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
import { TABLE_SIZE } from "@carbon/web-components/es/components/data-table/defs.js";

import {
  CARBON_BUTTON_KINDS,
  CARBON_BUTTON_SIZES,
  CARBON_INPUT_SIZES,
  CARBON_INPUT_TYPES,
  CARBON_NUMBER_INPUT_FLOOR,
  CARBON_NUMBER_INPUT_SIZES,
  CARBON_NUMBER_INPUT_SM_GUTTER,
  CARBON_NUMBER_INPUT_TYPES,
  CARBON_TABLE_SIZES,
  CARBON_TABLE_WRAPPER_PARTS,
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
      // The arcade's twelve setup fields. A third tag rather than a case the
      // two above already cover, which is why `isFieldTag` is a list of names:
      // a `cds-number-input` retargets exactly as the other two do —
      // `delegatesFocus`, the `<input>` in a shadow root, the host as
      // `event.target` — and was none of the five names on the list until it
      // was put there. Measured on the running console with the name removed:
      // a space dispatched on the `<input>` inside the Pulls field pressed the
      // primary once, `Open the lobby   (space)`, and swallowed the space.
      ["CDS-NUMBER-INPUT", "field field-num"],
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
    for (const tag of ["CDS-TEXT-INPUT", "CDS-SELECT", "CDS-NUMBER-INPUT"]) {
      const verdict = spaceVerdict(key({ target: on(tag, "field") }));
      assert.notEqual(verdict, "fire", tag);
      assert.notEqual(verdict, "handBackAndFire", tag);
    }
  });

  /*
   * And the arcade's own panel, said against the classes `main.ts` writes.
   *
   * The twelve are not one control repeated in one place: they are in a
   * `.field-row` for the rounds with a single setting and in an `.a-cfg-cell`
   * for the three that have two or three, and the one that matters most is the
   * panel the primary button sits under. A space that fired the primary while
   * the host was typing `25` into Tug of Raft's seconds-a-pull would announce
   * the round from a setup panel, with the number half entered.
   */
  test("every arcade setup field keeps the key, in both of its layouts", () => {
    for (const cls of ["field field-num", "field field-num a-cfg-num"]) {
      assert.equal(
        spaceVerdict(key({ target: on("CDS-NUMBER-INPUT", ...cls.split(" ")) })),
        "ignore",
        cls,
      );
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
      "cds-number-input",
      "cds-table",
      "cds-table-head",
      "cds-table-header-row",
      "cds-table-header-cell",
      "cds-table-body",
      "cds-table-row",
      "cds-table-cell",
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
   * `number` is not a text field's type, which is why the arcade's twelve are
   * a different element.
   *
   * This test was written as step 3's scope boundary — "which is why fifteen
   * fields are not Carbon's" — and the half of it that was wrong was the
   * count, not the constraint. There are **twelve** arcade setup fields, on
   * `main` and in every commit that has ever built one; "fifteen" was the
   * console's total field count, and it reached three source files and a
   * commit message. The twelve are Carbon's now, on `cds-number-input`.
   *
   * What the assertion still holds is the reason they could not be
   * `cds-text-input`: `INPUT_TYPE` has no `number`, so a `type="number"` with
   * a `min` and a `max` is not something this component can carry. If Carbon
   * ever adds one, this goes red and whoever reads it finds out that the two
   * components have converged and that there may now be one field type here
   * rather than two.
   */
  test("and `number` is not among them, which is why twelve fields are a different element", () => {
    assert.ok(
      !CARBON_INPUT_TYPE_VALUES.includes("number"),
      "Carbon's INPUT_TYPE now has `number`. The arcade's twelve setup " +
        "fields are on cds-number-input because cds-text-input could not " +
        "carry a type=number with its min and max; check whether it forwards " +
        "`min`/`max`/`step` now, and whether the two components should still " +
        "be two.",
    );
    assert.ok(CARBON_INPUT_TYPE_VALUES.includes("text"));
  });

  test("and every size and type written at a call site is one Carbon has", () => {
    const seen: Record<string, string[]> = {
      tagSize: [],
      tagType: [],
      inputSize: [],
      inputType: [],
      numberSize: [],
      numberType: [],
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
      // The number field's own two scales. **Not** `CARBON_INPUT_SIZE_VALUES`,
      // which is the whole point of the suite below: `INPUT_SIZE` has `xs` and
      // `xl`, this component's stylesheet implements neither, and a field
      // asking for one renders at `md`'s 40px with nothing said anywhere.
      scan("carbonNumberInput(", [
        ["size", CARBON_NUMBER_INPUT_SIZES, "numberSize"],
        ["inputType", CARBON_NUMBER_INPUT_TYPES, "numberType"],
      ]);
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
    // And the arcade's twelve, which is a count and not a floor: a thirteenth
    // or an eleventh is a thing to look at rather than a thing to pass.
    assert.equal(
      seen["numberSize"]!.length,
      12,
      `number-field sizes found: ${seen["numberSize"]!.length}, expected the ` +
        "arcade's twelve. A field built without one would not compile; a " +
        "thirteenth means the panel grew and this number should say so.",
    );
    assert.equal(
      seen["numberType"]!.length,
      12,
      `number-field types found: ${seen["numberType"]!.length}`,
    );
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
        "carbonNumberInput(",
      ]) {
        for (const call of callsTo(src, open)) {
          if (!call.startsWith(open)) continue;
          calls += 1;
          assert.doesNotMatch(
            call.replace(/\s+/g, " "),
            // `min`, `max`, `step` and `hide-steppers` join the list for the
            // number fields. The first three are the reason that component is
            // here at all, and written into `attrs` they would be strings
            // nothing types rather than the required numbers — a call site
            // that dropped one would compile and the field would stop being
            // clamped. `hide-steppers` is the width decision, and it is a
            // required boolean so that it is made once.
            /attrs: \{[^}]*\b(?:kind|size|type|min|max|step|hide-label|hide-steppers|label-text|max-count):/,
            `${name} writes a Carbon attribute inside attrs at ${open}…, ` +
              "which is the one spelling the unions and the required fields " +
              "in carbon.ts cannot see.",
          );
        }
      }
    }
    assert.ok(calls >= 24, `the scan found ${calls} Carbon call sites`);
  });

  test("and every field and picker hides Carbon's label, which is the decision", () => {
    let fields = 0;
    for (const [name, src] of hostSources()) {
      if (name === CARBON_DOOR) continue;
      for (const open of [
        "carbonTextInput(",
        "carbonSelect(",
        "carbonNumberInput(",
      ]) {
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
    assert.equal(
      fields,
      16,
      `the scan found ${fields} Carbon fields at call sites, expected 16 — ` +
        "three text fields, the one picker and the arcade's twelve.",
    );
  });

  /*
   * And every number field is `type="number"` with its steppers off.
   *
   * This test exists because a mutation came back green. Changing one call
   * site's `inputType: "number"` to `"text"` — a value the union allows, so it
   * compiles — passed `npm run typecheck` and all 47 tests in this file, and
   * on the running console the inner `<input>`'s `min`, `max` and `step` were
   * all the empty string while the **host** still carried `min="1" max="9"`.
   * A field that looks clamped from the outside and is clamped by nothing.
   *
   * The cause is one ternary in Carbon's template, which writes the three
   * attributes in the `number` branch and `""` otherwise. The union cannot
   * catch it, because `"text"` is a real value of a real property; what makes
   * it wrong is that the arcade's twelve are the fields the clamps were the
   * whole reason for.
   *
   * `hideSteppers` is held in the same test for the same shape of reason: it
   * is a decision about this panel taken once — see `host.css` — and a field
   * that drew its two 32px steppers would take 80px of its 112px box for the
   * gutter. That one is at least visible; this one is not, which is why they
   * are asserted together and the message says which is which.
   */
  test("and every number field is a number, with its steppers off", () => {
    let seen = 0;
    for (const [name, src] of hostSources()) {
      if (name === CARBON_DOOR) continue;
      for (const call of callsTo(src, "carbonNumberInput(")) {
        if (!call.startsWith("carbonNumberInput(")) continue;
        seen += 1;
        const flat = call.replace(/\s+/g, " ");
        assert.match(
          flat,
          /inputType: "number"/,
          `${name} builds a Carbon number field with inputType other than ` +
            '"number". Carbon writes min, max and step onto the inner ' +
            "<input> in the number branch only, and the empty string " +
            "otherwise — so the host keeps its min and max attributes, the " +
            "field looks clamped, and nothing clamps it. Measured.",
        );
        assert.match(
          flat,
          /hideSteppers: true/,
          `${name} builds a Carbon number field with Carbon's two stepper ` +
            "buttons drawn. At sm that is a 64px control in an 80px gutter, " +
            "in a 112px field, twelve times — see host.css.",
        );
        // And both clamps are written at the site, as numbers rather than
        // through `attrs`. The factory makes them required, so this is the
        // half that says they are not `min: Number(x)` of something empty.
        assert.match(flat, /min: \d+/, `${name}: min is not a literal`);
        assert.match(flat, /max: \d+/, `${name}: max is not a literal`);
      }
    }
    assert.equal(seen, 12, `the scan found ${seen} number fields, expected 12`);
  });

  /*
   * And the twelve are saved off Carbon's event, not off `change`.
   *
   * The second mutation that came back green. Writing the save listener as
   * `field.addEventListener("change", …)` compiles, passes every test in this
   * file, and on the running console takes the arcade's running order and all
   * twelve timings out of `localStorage` completely: edited a field, waited,
   * and `localStorage.getItem("quorum.host.arcade.v1")` was **null** where the
   * unmutated build had written all twelve. A console reloaded at 2:45pm comes
   * back with the default order and nothing anywhere says why.
   *
   * `cds-number-input` inherits `CDSTextInput`'s `change` re-emitter and
   * replaces the template that called it, so a native `change` — `composed:
   * false` — stops at the shadow boundary. Verified on the page: a `change`
   * listener on the host fired 0 times while Carbon's own fired once.
   *
   * A source scan rather than a behaviour test, because the behaviour needs a
   * DOM. It is the cheap half; the browser is the other half.
   */
  test("and their save listener is Carbon's event rather than `change`", () => {
    const main = hostSources().find(([n]) => n === "main.ts")?.[1] ?? "";
    assert.match(
      main,
      /addEventListener\(\s*CARBON_NUMBER_INPUT_EVENT\s*,/,
      "main.ts no longer registers the arcade setup fields' save listener " +
        "with CARBON_NUMBER_INPUT_EVENT.",
    );
    // And nothing listens for `change` on a TIMING_FIELDS entry. Scoped to the
    // loop that walks them, because the three text fields legitimately do:
    // `cds-text-input` re-emits `change` composed and `cds-number-input` does
    // not, which is the whole distinction.
    const loop = /for \(const \[field\] of TIMING_FIELDS\) \{[\s\S]*?\n\}/.exec(
      main,
    );
    assert.notEqual(loop, null, "the TIMING_FIELDS listener loop has moved");
    assert.doesNotMatch(
      loop?.[0] ?? "",
      /"change"/,
      "the arcade's twelve setup fields are saved off a `change` event, " +
        "which a cds-number-input never fires at its host. The order and " +
        "every timing stop reaching localStorage, silently. Measured.",
    );
  });
});

/*
 * ------------------------------------------------------------------
 * The arcade's twelve, and the component that carries their clamps
 * ------------------------------------------------------------------
 *
 * `cds-number-input` is the sixth tag and the only one so far whose own
 * stylesheet had to be argued with. These tests are what hold the three claims
 * `carbon.ts` makes about it, each against the installed package rather than
 * against a comment, so a version bump that invalidates one of them says so.
 *
 * All three are read as **text**. The enum and the stylesheet both live in
 * `number-input.js`, which calls `customElements.define` at import time — and
 * this repo's tests run under `node:test` with no DOM at all, so importing it
 * would take the whole file out with a ReferenceError before anything
 * asserted. `defs.js` for this component exports a validation-status enum and
 * nothing else, so unlike the button, the tag and the text field there is no
 * side-effect-free module to read the values from. Text it is, and the last
 * test in this block is the guard against a read that found nothing.
 */
describe("the arcade's twelve setup fields are Carbon's number input", () => {
  const COMPONENT = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "node_modules",
    "@carbon",
    "web-components",
    "es",
    "components",
    "number-input",
    "number-input.js",
  );
  const js = readFileSync(COMPONENT, "utf8");
  /** The compiled stylesheet, which the component imports as a JS module. */
  const sheet = readFileSync(
    COMPONENT.replace("number-input.js", "number-input.scss.js"),
    "utf8",
  );

  /*
   * The clamps reach the element that enforces them. This is the whole reason
   * the twelve could convert at all, and it is one template line.
   *
   * `cds-text-input` forwards no `min`, no `max` and no `step`, which is why
   * these fields were not that component. This one writes all three onto the
   * `<input type="number">` in its shadow root — and only in the `number`
   * branch, which is why `inputType` has a union and why `"text"` is the value
   * that would take them back off.
   */
  test("forwards min, max and step onto the inner input", () => {
    for (const attr of ["min", "max", "step"]) {
      assert.match(
        js.replace(/\s+/g, " "),
        new RegExp(
          `${attr}="\\$\\{this\\.type === "number" \\? if_non_empty_default\\(this\\.${attr}\\) : ""\\}"`,
        ),
        `cds-number-input no longer forwards ${attr} to its inner <input>. ` +
          "That is the one property that made the arcade's twelve setup " +
          "fields convertible: without it they are clamped by nothing.",
      );
    }
  });

  /*
   * And it does not re-emit `change`, which is the trap.
   *
   * `CDSNumberInput extends CDSTextInput`, and `CDSTextInput` binds `@change`
   * precisely so that a composed `change` reaches the host — a native one is
   * `composed: false` and stops at the boundary. `CDSNumberInput` replaces
   * `render()` and binds `@input`, `@focus`, `@blur` and `@keydown` and not
   * `@change`, so the inherited handler is never called.
   *
   * Written as two assertions in opposite directions, because either one alone
   * would pass for the wrong reason: the first says the trap is still there,
   * the second says the parent still does the thing the child fails to
   * inherit. If the first goes red, `main.ts` can listen for `change` again
   * and the comment there should go.
   */
  test("and does not re-emit `change`, which is why the save listener is not one", () => {
    assert.doesNotMatch(
      js,
      /@change=/,
      "cds-number-input now binds @change. Its save listener in main.ts " +
        "listens for CARBON_NUMBER_INPUT_EVENT because it did not — check " +
        "whether a composed `change` now reaches the host.",
    );
    const parent = readFileSync(
      COMPONENT.replace(
        join("number-input", "number-input.js"),
        join("text-input", "text-input.js"),
      ),
      "utf8",
    );
    assert.match(
      parent,
      /@change=/,
      "cds-text-input has stopped binding @change too. The three text fields " +
        "on this console listen for it.",
    );
    assert.match(js, /static get eventInput\(\)/);
    assert.match(js, /return `cds-number-input`/);
  });

  /*
   * The sizes are the three the stylesheet implements, in both directions.
   *
   * There is no enum to hold them against — `size` is a bare reflected string
   * with no validation — so the sheet is the only honest source: a size
   * Carbon does not implement produces a class that matches nothing and a
   * control at `md`'s 40px, silently, which is the `danger--tertiary` failure
   * in a second place.
   */
  test("asks only for the three sizes the stylesheet implements", () => {
    for (const size of CARBON_NUMBER_INPUT_SIZES) {
      if (size === "md") {
        // `md` is the component's own default and the unmodified metrics: the
        // sheet's only `.cds--number--md` is the skeleton's block-size, and
        // the live control gets 2.5rem from the base declaration instead.
        // That is what makes `md` the one size `--nosteppers` works at, so the
        // override in `carbon.ts` names no class for it.
        assert.match(
          js,
          /this\.size = "md"/,
          "cds-number-input's default size is no longer md, which is the " +
            "size the override in carbon.ts writes no class for.",
        );
        for (const rule of sheet
          .split("}")
          .filter((r) => r.includes(".cds--number--md"))) {
          assert.match(
            rule,
            /cds--skeleton/,
            "Carbon now has a non-skeleton .cds--number--md modifier, so md " +
              "is no longer the unmodified default and the override's " +
              "selector for it needs that class.",
          );
        }
        continue;
      }
      assert.ok(
        sheet.includes(`.cds--number--${size}`),
        `.cds--number--${size} is not in the component's stylesheet, so ` +
          `size: "${size}" would render at the default metrics.`,
      );
    }
    // The other direction, which is the half that catches a union copied from
    // the text field's. `INPUT_SIZE` has five values and this component
    // implements three of them.
    for (const absent of CARBON_INPUT_SIZE_VALUES.filter(
      (s) => !(CARBON_NUMBER_INPUT_SIZES as readonly string[]).includes(s),
    )) {
      assert.ok(
        !sheet.includes(`.cds--number--${absent}`),
        `Carbon now implements .cds--number--${absent}. ` +
          "CARBON_NUMBER_INPUT_SIZES should grow, and the note in carbon.ts " +
          "about the two scales not being one scale should shrink.",
      );
    }
    assert.deepEqual([...CARBON_NUMBER_INPUT_SIZES], ["sm", "md", "lg"]);
  });

  test("and only the two types its template branches on", () => {
    // The enum, read as text for the reason at the top of this block.
    const values = [
      ...js.matchAll(/NUMBER_INPUT_TYPE\["[A-Z]+"\] = "([a-z]+)"/g),
    ].map((m) => m[1] as string);
    assert.deepEqual(
      [...values].sort(),
      [...CARBON_NUMBER_INPUT_TYPES].sort(),
      "carbon.ts's number-input types and Carbon's NUMBER_INPUT_TYPE have " +
        "drifted apart.",
    );
    assert.ok(values.length >= 2, `the enum read as ${values.length} values`);
  });

  /*
   * And it puts a live-region role on the element a host types into.
   *
   * `role="alert"` and `aria-atomic="true"` are literals in this component's
   * template, on the `<input>`, with nothing on the host asking for them.
   * `cds-text-input` writes neither. An explicit role replaces an element's
   * implicit one, so a number field stops being a field.
   *
   * Measured in the running browser on three light-DOM inputs differing only
   * in those two attributes: `textbox "plain probe" (number)` against
   * `alert "alert probe" (number)`, and back to `textbox` with them removed.
   * The name survived in all three, which is why `hide-label` and the step 3
   * naming decision needed no revisiting; the role did not.
   *
   * `carbon.ts` removes both. These two assertions are what stop that removal
   * from quietly becoming a no-op: the first says Carbon still writes them, the
   * second says the text field still does not, so a release that fixes it
   * upstream or breaks the other one shows up here.
   */
  test("and a live-region role on the input, which the factory takes back off", () => {
    const flat = js.replace(/\s+/g, " ");
    assert.match(
      flat,
      /role="alert"/,
      "cds-number-input no longer writes role=\"alert\" onto its inner " +
        "<input>. The removal in carbon.ts removes nothing; delete it and " +
        "the reading beside it.",
    );
    assert.match(flat, /aria-atomic="true"/);
    const parent = readFileSync(
      COMPONENT.replace(
        join("number-input", "number-input.js"),
        join("text-input", "text-input.js"),
      ),
      "utf8",
    );
    assert.doesNotMatch(
      parent.replace(/\s+/g, " "),
      /role="alert"/,
      "cds-text-input has started writing role=\"alert\" too. The three text " +
        "fields on this console would need the same removal.",
    );
    // And there is no `aria-label` binding on either, which is what makes the
    // shadow `<label for="input">` the only name a Carbon field has. The
    // removal above must not be read as having anything to do with naming.
    assert.doesNotMatch(flat, /aria-label="\$\{this\.label/);
    /*
     * And `carbon.ts` still takes them off.
     *
     * The third mutation that came back green. Emptying `unmakeLiveRegion`
     * compiles and passes every test here, and on the running console all
     * twelve inner `<input>`s carry `role="alert"` again — a form control
     * announced as an assertive live region instead of a number field. The two
     * assertions above are about Carbon's template and stay green either way,
     * which is exactly how a removal comes to be deleted later for looking
     * like it does nothing.
     */
    const door = hostSources().find(([n]) => n === CARBON_DOOR)?.[1] ?? "";
    assert.match(
      door,
      /removeAttribute\("role"\)/,
      "carbon.ts no longer removes role from a number field's inner input. " +
        "Measured in the browser: with it left on, an <input type=number> " +
        'reads as `alert "…" (number)` where the same input without it reads ' +
        'as `textbox "…" (number)`.',
    );
    assert.match(door, /removeAttribute\("aria-atomic"\)/);
  });

  /*
   * ---- the two values `hide-steppers` is supposed to take off ----------
   *
   * `carbon.ts` adopts one stylesheet into each field's shadow root, and the
   * whole of its argument is that both declarations below are Carbon's own
   * `--nosteppers` values, re-asserted where Carbon's cascade drops them.
   * These are what make that argument falsifiable: if Carbon fixes either
   * upstream, the override becomes a disagreement rather than a repair, and it
   * should be deleted rather than kept because nothing noticed.
   */
  test("whose `hide-steppers` leaves a gutter at every size but md", () => {
    const flat = sheet.replace(/\s+/g, "");
    // The size modifier, at two classes and an attribute.
    assert.ok(
      flat.includes(
        `.cds--number--sm.cds--number input[type=number]`.replace(/\s+/g, ""),
      ),
      "the .cds--number--sm padding rule has moved; the override in " +
        "carbon.ts is built to out-specify exactly that selector.",
    );
    assert.ok(
      flat.includes(`padding-inline-end:${CARBON_NUMBER_INPUT_SM_GUTTER}`),
      `the sm gutter is no longer ${CARBON_NUMBER_INPUT_SM_GUTTER}.`,
    );
    // And the repair, at one class and an attribute — a class short of the
    // thing it has to beat, which is the bug.
    assert.ok(
      flat.includes(
        `.cds--number--nosteppers input[type=number]`.replace(/\s+/g, ""),
      ),
      "the .cds--number--nosteppers padding rule has moved or has gained a " +
        "class. If it now out-specifies the size modifiers, `hide-steppers` " +
        "works on its own and the padding half of the override in carbon.ts " +
        "should go.",
    );
    // Measured in the browser, which is the only place specificity is
    // actually resolved: sm + hide-steppers computed 16px / 80px — the same
    // two numbers as sm *with* steppers — and md + hide-steppers computed
    // 16px / 0px.
  });

  test("and a floor sized for steppers it is not drawing", () => {
    const flat = sheet.replace(/\s+/g, "");
    assert.equal(
      (flat.match(/min-inline-size:/g) ?? []).length,
      1,
      "the component's stylesheet now has more than one min-inline-size. " +
        "The override in carbon.ts is written against the one in the base " +
        "declaration and may no longer be reaching the right one.",
    );
    assert.ok(
      flat.includes(`min-inline-size:${CARBON_NUMBER_INPUT_FLOOR}`),
      `the floor is no longer ${CARBON_NUMBER_INPUT_FLOOR}.`,
    );
    // The point: `--nosteppers` touches the padding and not the floor, so a
    // field drawing no steppers keeps 150px of room for them.
    const nosteppers = sheet
      .split("}")
      .filter((r) => r.includes(".cds--number--nosteppers"));
    assert.ok(nosteppers.length > 0, "no --nosteppers rules in the sheet");
    for (const rule of nosteppers) {
      assert.ok(
        !rule.includes("min-inline-size"),
        "Carbon's --nosteppers now resets min-inline-size. The floor half " +
          "of the override in carbon.ts should go.",
      );
    }
  });

  test("and the sheet and the component read as themselves", () => {
    // Every assertion above passes trivially against an empty read, which is
    // the failure this whole file keeps finding.
    assert.ok(js.length > 10_000, `number-input.js read as ${js.length} bytes`);
    assert.ok(
      sheet.length > 10_000,
      `number-input.scss.js read as ${sheet.length} bytes`,
    );
    assert.ok(js.includes("cds-number-input"), "the tag is not in the module");
    assert.ok(sheet.includes(".cds--number"), "no .cds--number in the sheet");
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

/*
 * ------------------------------------------------------------------
 * Step 4: the scoring grid
 * ------------------------------------------------------------------
 *
 * The grid is seven `cds-table*` elements around the console's own cells.
 * What these hold is what the measurements in `host.css` and `carbon.ts`
 * rest on, read against the installed package, so that a Carbon release
 * which changes any of it turns something red here rather than in front of
 * a room.
 */
describe("the scoring grid is Carbon's table", () => {
  const DIR = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "node_modules",
    "@carbon",
    "web-components",
    "es",
    "components",
    "data-table",
  );
  const read = (f: string): string =>
    readFileSync(join(DIR, f), "utf8").replace(/\s+/g, " ");

  test("asks only for sizes Carbon's table has, in both directions", () => {
    assert.deepEqual(
      [...CARBON_TABLE_SIZES].sort(),
      Object.values(TABLE_SIZE).sort(),
      "carbon.ts's table sizes and Carbon's TABLE_SIZE have drifted apart.",
    );
  });

  /*
   * A cell is a bare slot. That is why the raw `<input>`, its points, its
   * clear button and its refusal bubble are still light-DOM elements that
   * `host.css` styles and `scoring.ts` finds with `querySelector` — Enter
   * walking down a column is `tbody.querySelectorAll("input.sc-raw")`. A cell
   * that started rendering its own markup around the slot would not break
   * that, but it would put Carbon's styling between the console and its own
   * field, and the measurements would need taking again.
   */
  test("whose cells render nothing but their slot", () => {
    assert.match(
      read("table-cell.js"),
      /render\(\) \{ return html`<slot><\/slot>`; \}/,
      "cds-table-cell renders more than a bare <slot> now. The grid's cells " +
        "hold the console's own field; re-measure the row and check the field " +
        "is still the element that takes focus.",
    );
  });

  /*
   * The two wrapper parts `host.css` takes out of the box tree, and the
   * reason it has to. If a part is renamed, `.sc-grid::part(…)` matches
   * nothing, the inner box is a scroll container again, and the sticky header
   * scrolls away with the rows — measured, with the rule removed: 60px of
   * scroll moved the header 60px.
   */
  test("whose two wrapper boxes are the parts host.css names", () => {
    const table = read("table.js");
    for (const part of CARBON_TABLE_WRAPPER_PARTS) {
      assert.ok(
        table.includes(`part="${part}"`),
        `cds-table no longer renders part="${part}". host.css takes it out ` +
          "of the box tree to keep the scoring grid's header sticky; find " +
          "what replaced it.",
      );
    }
    const css = readFileSync(join(import.meta.dirname, "host.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ");
    // Each part on its own, so the rule can be written as one list or as two
    // rules and either still counts.
    for (const part of CARBON_TABLE_WRAPPER_PARTS) {
      assert.match(
        css,
        new RegExp(`\\.sc-grid::part\\(${part}\\)[^{]*\\{[^}]*display: contents;`),
        `host.css no longer takes cds-table's ${part} part out of the box tree.`,
      );
    }
    // And the reason, still there: the inner box scrolls.
    assert.match(
      read("data-table.scss.js"),
      /\.cds--data-table_inner-container\{[^}]*overflow-x:auto/,
      "cds-table's inner box is no longer overflow-x: auto. The display: " +
        "contents rule in host.css may be repairing nothing now; re-measure " +
        "the sticky header without it.",
    );
  });

  /*
   * `cds-table` caches its header row once and dereferences the cache with no
   * null check, and it hands its `size` only to the rows that exist when the
   * size is set. These two are why `scoring.ts` builds the header row before
   * the table and why every row carries `size` itself. If either goes red,
   * Carbon has fixed it, and the comment on `carbonTable` or
   * `CarbonTableRowOpts` is describing a trap that is no longer there.
   */
  test("which caches its header row, and sizes only the rows it can see", () => {
    const table = read("table.js");
    assert.ok(
      table.includes("this.headerCount = this._tableHeaderRow.children.length;"),
      "cds-table no longer dereferences its cached header row unchecked in " +
        "firstUpdated.",
    );
    assert.match(
      table,
      /if \(changedProperties\.has\("size"\)\) \{ forEach\(this\.querySelectorAll\(this\.constructor\.selectorAllRows\), \(elem\) => \{ elem\.setAttribute\("size", this\.size\);/,
      "cds-table has changed how it hands its size to rows.",
    );
  });
});

/*
 * ------------------------------------------------------------------
 * Step 5: the console's type is Carbon's
 * ------------------------------------------------------------------
 *
 * `host.css` sizes its text from Carbon's type tokens, which
 * `gen-carbon-tokens.mjs` emits from `@carbon/type` into `carbon-tokens.css`.
 * Three things a reader cannot see at a glance and nothing else checks:
 * that no rule has gone back to a number, that every token a rule names is
 * one the file declares — a `var()` with no fallback and no declaration is
 * the initial value, `medium`, 16px, silently — and that the declared values
 * are still Carbon's.
 */
describe("the console's type is Carbon's", () => {
  const blank = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const hostCss = blank(
    readFileSync(join(import.meta.dirname, "host.css"), "utf8"),
  );
  const tokensCss = readFileSync(
    join(import.meta.dirname, "carbon-tokens.css"),
    "utf8",
  );

  /** Every declaration in host.css, as `[selector, property, value]`. */
  const declarations = (): readonly (readonly [string, string, string])[] => {
    const out: (readonly [string, string, string])[] = [];
    for (const rule of hostCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = (rule[1] ?? "").trim().replace(/\s+/g, " ");
      // Split on `;` rather than matching `prop: value;`, so a last
      // declaration with no semicolon is still read.
      for (const decl of (rule[2] ?? "").split(";")) {
        const at = decl.indexOf(":");
        if (at === -1) continue;
        out.push([
          sel,
          decl.slice(0, at).trim().toLowerCase(),
          decl.slice(at + 1).trim(),
        ]);
      }
    }
    return out;
  };

  test("every size in host.css is a Carbon token, but the preview's", () => {
    const raw: string[] = [];
    for (const [sel, prop, v] of declarations()) {
      if (prop === "font") {
        // The shorthand carries a size, and nothing here uses it.
        raw.push(`${sel} { font: ${v} }`);
        continue;
      }
      if (prop !== "font-size") continue;
      if (/^var\(--cds-[a-z0-9-]+-font-size\)$/.test(v) || v === "inherit") {
        continue;
      }
      // The one exemption, argued at the rule: the phone preview keeps the
      // 13px it inherited before step 5, because it is the phone's look.
      if (sel === ".preview-frame" && v === "13px") continue;
      raw.push(`${sel} { font-size: ${v} }`);
    }
    assert.deepEqual(
      raw,
      [],
      "host.css sizes text with a number again. Pick the Carbon token; the " +
        "mapping is at the head of host.css.",
    );
  });

  test("and the old chrome idiom is gone: no caps, no em tracking", () => {
    const idiom: string[] = [];
    for (const [sel, prop, v] of declarations()) {
      if (prop === "text-transform" && /uppercase/i.test(v)) {
        idiom.push(`${sel} { text-transform: ${v} }`);
      }
      if (prop === "letter-spacing" && /em\b/.test(v)) {
        idiom.push(`${sel} { letter-spacing: ${v} }`);
      }
    }
    assert.deepEqual(
      idiom,
      [],
      "Carbon has no caps style and tracks in px. Write the text in the case " +
        "it reads in, and take the token's letter-spacing.",
    );
  });

  test("and every token a rule names is one carbon-tokens.css declares", () => {
    const used = new Set(
      [...hostCss.matchAll(/var\((--cds-[a-z0-9-]+-(?:font-size|font-weight|line-height|letter-spacing))\)/g)]
        .map((m) => m[1] as string),
    );
    assert.ok(used.size >= 20, `found only ${used.size} type tokens in use`);
    const declared = blank(tokensCss);
    for (const name of used) {
      assert.ok(
        new RegExp(`${name}\\s*:`).test(declared),
        `${name} is read in host.css and declared nowhere, so it resolves to ` +
          "the initial value — 16px medium, for a font-size — with no error.",
      );
    }
  });

  test("and the declared values are @carbon/type's own", async () => {
    const type = (await import("@carbon/type")) as unknown as Record<
      string,
      { fontSize: string; fontWeight?: number; lineHeight: number; letterSpacing: string | number }
    >;
    const live = blank(tokensCss);
    const declared = [
      ...live.matchAll(/(--cds-([a-z0-9-]+)-font-size):\s*([^;]+);/g),
    ];
    // Every token the generator lists, so one commented out is a failure here
    // and not only a missing size somewhere on the page.
    assert.equal(declared.length, 7, "carbon-tokens.css declares the seven type tokens");
    for (const [, , token, size] of declared) {
      const key = (token as string).replace(/-([a-z0-9])/g, (_, c: string) =>
        c.toUpperCase(),
      );
      const t = type[key];
      assert.ok(t, `@carbon/type has no ${key}`);
      assert.equal(size, t.fontSize, `${token} font-size`);
      for (const [prop, want] of [
        ["font-weight", String(t.fontWeight ?? 400)],
        ["line-height", String(t.lineHeight)],
        ["letter-spacing", t.letterSpacing === 0 ? "0" : String(t.letterSpacing)],
      ] as const) {
        const m = new RegExp(`--cds-${token}-${prop}:\\s*([^;]+);`).exec(live);
        assert.equal(m?.[1], want, `${token} ${prop}`);
      }
    }
  });
});
