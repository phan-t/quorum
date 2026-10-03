/**
 * What the vendoring crawl reads, and the comment that broke it.
 *
 * `scripts/copy-client-assets.mjs` walks the import graph from one entry point
 * per Carbon component the console mounts, copies every module it reaches into
 * `dist/vendor`, and refuses the build if a module names a bare specifier
 * `SPECIFIER_TABLE` does not cover. That refusal is the guard that keeps a
 * vendored tree from shipping with a hole in it, and it works: adding
 * `cds-number-input` to the entry points with the table untouched failed the
 * build with
 *
 *     @carbon/web-components/es/components/number-input/number-input.js
 *     imports "@carbon/utilities", which SPECIFIER_TABLE does not cover.
 *
 * Then it fired a second time, correctly, on `@internationalized/number` — and
 * a third time on **nothing at all**. `@carbon/utilities`' carousel chunk
 * documents a callback in prose:
 *
 *     * …it calls the 'onViewChangeEnd' callback with the response from
 *     * 'getCallbackResponse'.
 *
 * `from 'getCallbackResponse'` matches the specifier pattern, so the build
 * refused a tree that was in fact complete, naming a module no package has.
 *
 * The repair is to scan code rather than prose, with the same character walk
 * `controls.test.ts` uses to read the console's own TypeScript for Carbon
 * tags — and for the same reason, reached from the other side of the fence: a
 * regex that treats `//` as a line comment eats the rest of any line holding a
 * URL, and a scanner that has eaten the line finds nothing and passes.
 *
 * These tests are why the stripper lives in its own module. Importing the
 * crawl to test it would run a build.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { stripComments } from "../../scripts/strip-comments.mjs";

/** The one pattern the crawl asks every vendored module. */
const SPECIFIER_RE =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g;

function specifiers(src: string): readonly string[] {
  return [...src.matchAll(SPECIFIER_RE)]
    .map((m) => m[1] ?? m[2])
    .filter((s): s is string => s !== undefined);
}

describe("the vendoring crawl reads code and not prose", () => {
  test("a specifier named in a comment is not a specifier", () => {
    const src = [
      'import { a } from "lit";',
      "// a line comment naming `from \"not-a-package\"`",
      '/* and a block one: the response from \'getCallbackResponse\' */',
      'export * from "@internationalized/number";',
    ].join("\n");
    assert.deepEqual(specifiers(src), [
      "lit",
      "not-a-package",
      "getCallbackResponse",
      "@internationalized/number",
    ]);
    assert.deepEqual(specifiers(stripComments(src)), [
      "lit",
      "@internationalized/number",
    ]);
  });

  test("and a `//` inside a string is not a comment", () => {
    // The failure a regex stripper has, and the one that matters most: it
    // would blank the rest of the line and the crawl would then miss the
    // import on it. Carbon's modules carry URLs in licence headers and
    // `sourceMappingURL` lines.
    const src =
      'const u = "https://example.test/x"; import "./sibling.js";';
    const out = stripComments(src);
    assert.ok(out.includes('"https://example.test/x"'), out);
    assert.deepEqual(specifiers(out), ["./sibling.js"]);
  });

  test("and a template literal is left intact, because a specifier in one is real", () => {
    const src = "const s = `a template naming from \"lit-html\"`;";
    assert.equal(stripComments(src), src);
  });

  test("and an escaped quote does not run the scanner off the end", () => {
    const src = 'const s = "a \\" quote"; // from "nope"\nimport "lit";';
    assert.deepEqual(specifiers(stripComments(src)), ["lit"]);
  });

  test("and offsets still line up afterwards", () => {
    // Comment bodies become spaces and block-comment newlines are kept, so a
    // line number in a failure message still means something in the file.
    const src = ['import "lit";', "/* two", "   lines */", 'import "x";'].join(
      "\n",
    );
    const out = stripComments(src);
    assert.equal(out.length, src.length);
    assert.equal(out.split("\n").length, src.split("\n").length);
  });

  /*
   * And the module that actually broke it, read off disk.
   *
   * The two assertions are in opposite directions on purpose. The first says
   * the trap is still in the installed package, so this guard is still load-
   * bearing rather than a rule about nothing — if `@carbon/utilities` rewords
   * that line, it goes red and the stripper can be reconsidered. The second
   * says the stripper handles it.
   */
  test("and the chunk that broke it names no specifier once its prose is gone", () => {
    const chunk = join(
      import.meta.dirname,
      "..",
      "..",
      "node_modules",
      "@carbon",
      "utilities",
      "es",
      "chunk-wkQsBGBN.js",
    );
    let src: string;
    try {
      src = readFileSync(chunk, "utf8");
    } catch {
      // The chunk is a build artefact of a transitive dependency and its hashed
      // name moves with the version. A rename is not a failure of the
      // stripper, and the tests above do not depend on this file.
      return;
    }
    assert.ok(
      specifiers(src).includes("getCallbackResponse"),
      "@carbon/utilities' carousel chunk no longer reads as importing " +
        "`getCallbackResponse`. The stripComments pass in the crawl was " +
        "added for exactly that line; check whether it is still earning its " +
        "place before relying on it.",
    );
    for (const spec of specifiers(stripComments(src))) {
      assert.ok(
        spec.startsWith(".") || spec.startsWith("@") || !spec.includes(" "),
        `${spec} is not a module specifier`,
      );
      assert.notEqual(spec, "getCallbackResponse");
    }
  });

  /*
   * And the crawl actually uses it.
   *
   * Every test above is about `stripComments` and not about the one line that
   * calls it, which is the gap a mutation found: taking `stripComments` back
   * out of `copy-client-assets.mjs` left all of them green. The build does go
   * red — loudly, naming `getCallbackResponse` — and the build is the right
   * place for that guard, because it is a hard stop that nobody can land
   * around. This is the cheap second half, read as text for the reason the
   * whole file is: importing the crawl runs a build.
   */
  test("and the crawl scans the stripped source rather than the raw one", () => {
    const crawl = readFileSync(
      join(import.meta.dirname, "..", "..", "scripts", "copy-client-assets.mjs"),
      "utf8",
    );
    assert.match(
      crawl,
      /stripComments\(source\)\.matchAll\(SPECIFIER_RE\)/,
      "copy-client-assets.mjs no longer runs its specifier scan over " +
        "stripComments(source). A comment that reads as `from \"x\"` then " +
        "refuses a complete tree; @carbon/utilities has one.",
    );
    assert.match(crawl, /from "\.\/strip-comments\.mjs"/);
  });

  test("and the real console's own entry graph still reads as code", () => {
    // The guard against a stripper that blanks everything, which is how a
    // scanner comes to find nothing and pass.
    const main = readFileSync(
      join(import.meta.dirname, "host", "main.ts"),
      "utf8",
    );
    const out = stripComments(main);
    assert.ok(out.length > 100_000, `main.ts read as ${out.length} characters`);
    const found = specifiers(out);
    assert.ok(
      found.includes(
        "@carbon/web-components/es/components/number-input/number-input.js",
      ),
      "the number input's side-effect import is not in main.ts's specifiers",
    );
    assert.ok(found.length > 10, `found ${found.length} specifiers in main.ts`);
  });
});
