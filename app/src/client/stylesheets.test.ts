/**
 * The two stylesheets share a namespace, and this is what says so out loud.
 *
 * The console loads `participant.css` whole — the right-hand column embeds the
 * participant view, so it needs the participant view's styling — and then loads
 * `host.css` after it. Both files are written as though they own their class
 * names. They do not: a name in both lands on both surfaces, and which
 * declaration wins is decided by the cascade rather than by either author.
 *
 * That is how the Gganbu recap came to draw its cues at 26px in a 13px panel.
 * `participant.css` sizes `.a-gganbu-cue` for a phone held at arm's length;
 * the console reused the name for six index rows; `host.css` set no font-size
 * on it, so the phone's rule had nothing to beat and won by inheritance. Six
 * wrapped sentences, on the panel a host glances at between questions, for as
 * long as nobody looked closely.
 *
 * Nothing caught it, because nothing in this repository reads CSS. These tests
 * are that reader. They are deliberately not a general CSS linter — they assert
 * the one property the two files cannot give themselves, which is knowing when
 * they have started sharing something new.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const CLIENT = import.meta.dirname;
const HOST = join(CLIENT, "host", "host.css");
const PARTICIPANT = join(CLIENT, "participant", "participant.css");

/**
 * Every class name a stylesheet mentions in a selector.
 *
 * Regex and not a real parser on purpose: the question is "which names does
 * this file claim", and a name in a selector is a claim whether or not the
 * block around it is one this crude a reader fully understands. Comments go
 * first so a class named in prose is not counted as a claim — several are.
 *
 * Innermost blocks are what the match finds, so a rule nested in `@media` or
 * `@container` is read exactly like a top-level one, which is right: a nested
 * rule collides just as hard.
 */
function classNames(path: string): ReadonlySet<string> {
  const src = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();
  for (const block of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const hit of (block[1] ?? "").matchAll(/\.([A-Za-z0-9_-]+)/g)) {
      const name = hit[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/**
 * The names both files already use, each with the reason it is tolerable.
 *
 * This is an inventory and not a blessing. Every entry is a place where the
 * cascade is deciding something an author should have decided, and the reasons
 * below are mostly "the console happens to declare enough to win" — which is
 * luck that a later edit can spend without noticing.
 *
 * The test compares this list against the files in both directions, so adding
 * a collision fails and removing one fails too. The second half matters as much
 * as the first: a list that is allowed to keep naming names that no longer
 * collide stops being an inventory and becomes decoration.
 */
const KNOWN_SHARED: Readonly<Record<string, string>> = {
  "a-gganbu-cue":
    "The one that bit. The console's rule is scoped under `.a-gganbu-host` " +
    "and answers the phone's font-size, line-height and max-width by name; " +
    "see the regression test below.",
  compact:
    "Rendered only inside the participant preview, where the participant's " +
    "styling is the styling that is wanted.",
  "p-root":
    "The participant view's own root. The console renders it only to hold " +
    "the preview, so the participant's rules are correct there by definition.",
  field:
    "Both files style form fields. The console declares its own width, " +
    "colour and font on `.field` and loads second, so it wins the properties " +
    "it names — and inherits the rest.",
  label: "Same shape as `.field`, and the leaked properties are cosmetic.",
  on: "A state modifier in both. The console's own rules are more specific.",
  "t-answer":
    "Trivia answer rows on both surfaces. The console leaves `flex` and " +
    "`min-width` to the participant's rule, which happens to want the same " +
    "thing a row in a list wants.",
  "t-note":
    "The console draws this as `pb-note t-note` and sizes `.pb-note` at 13px. " +
    "It beats the participant's 14px only because `host.css` loads later. " +
    "Drop the companion class and the note silently grows.",
};

describe("the two client stylesheets share a namespace", () => {
  it("shares exactly the class names that are written down, and no others", () => {
    const host = classNames(HOST);
    const participant = classNames(PARTICIPANT);
    const shared = [...host].filter((n) => participant.has(n)).sort();
    const known = Object.keys(KNOWN_SHARED).sort();

    assert.deepEqual(
      shared,
      known,
      "host.css and participant.css share a class name that KNOWN_SHARED does " +
        "not account for, or account for one they no longer share. The console " +
        "loads both files, so a shared name styles both surfaces and the " +
        "cascade picks the winner. Either scope the console's rule under a " +
        "host-only ancestor and answer the leaked properties by name, or " +
        "rename the console's class; then update KNOWN_SHARED with the reason.",
    );
  });

  it("finds real names, not an empty read", () => {
    // The assertion above passes trivially if `classNames` returns nothing —
    // a changed path, a rename, a regex that stopped matching. This is the
    // test that the test works.
    const host = classNames(HOST);
    assert.ok(host.size > 100, `host.css yielded ${host.size} class names`);
    assert.ok(host.has("ctl-button"), "host.css should claim .ctl-button");
    assert.ok(
      classNames(PARTICIPANT).has("a-stakes"),
      "participant.css should claim .a-stakes",
    );
  });

  it("never lets the console's Gganbu cue go unscoped again", () => {
    // The specific regression. An unscoped `.a-gganbu-cue` in host.css is the
    // exact shape of the original bug, because the participant's rule is the
    // one that then decides the size.
    const src = readFileSync(HOST, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const block of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (block[1] ?? "").trim();
      if (!selector.includes(".a-gganbu-cue")) continue;
      assert.ok(
        selector.includes(".a-gganbu-host"),
        `host.css styles .a-gganbu-cue through "${selector}", which is not ` +
          "scoped to the console's recap. participant.css sizes the same " +
          "class for the phone, at up to 26px with a 34ch cap, and the " +
          "console loads that file for the preview column.",
      );
    }
  });

  it("keeps answering the three properties the phone's cue declares", () => {
    // Scoping alone is not enough: the leak was font-size, line-height and
    // max-width, and a scoped rule that stops naming them lets them back in.
    const src = readFileSync(HOST, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((b) =>
      (b[1] ?? "").includes(".a-gganbu-host .a-gganbu-cue"),
    );
    assert.ok(rule, "host.css should scope .a-gganbu-cue under .a-gganbu-host");
    const body = rule[2] ?? "";
    for (const prop of ["font-size", "line-height", "max-width"]) {
      assert.match(
        body,
        new RegExp(`(^|;)\\s*${prop}\\s*:`),
        `the scoped cue rule must answer ${prop}, which participant.css sets`,
      );
    }
  });
});
