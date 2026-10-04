/**
 * Recruitment's recap belongs to Recruitment.
 *
 * The Desktop's arcade scene has one `recap` list, filled with Recruitment's
 * emoji items and their notes at that round's reveal. Every other round's
 * branch has to keep it hidden, because nothing refills it: the Plan / Apply
 * branch showed it at its own reveal, and the room read the previous round's
 * answer key while the host read out this one (#40).
 *
 * The scene builds DOM at import, so — like the console's guards in
 * `host/controls.test.ts` — this reads the source rather than running it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const src = readFileSync(join(import.meta.dirname, "main.ts"), "utf8");

/** The body of `if (arcade.round === "<kind>") { … return; }`. */
function branch(kind: string): string {
  const open = `if (arcade.round === "${kind}") {`;
  const at = src.indexOf(open);
  assert.notEqual(at, -1, `no branch for ${kind} in screen/main.ts`);
  const end = src.indexOf("\n      return;\n    }", at);
  assert.notEqual(end, -1, `could not find the end of the ${kind} branch`);
  return src.slice(at, end);
}

describe("the Desktop's Recruitment recap", () => {
  for (const kind of ["plan_apply", "unseal", "tug_of_raft", "glass_bridge", "gganbu"]) {
    test(`stays hidden through ${kind}, in every phase`, () => {
      assert.match(
        branch(kind),
        /recap\.hidden = true;/,
        `${kind} must hide Recruitment's recap: nothing refills it, so ` +
          "showing it shows the previous round's answers.",
      );
    });
  }
});
