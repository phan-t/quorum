/**
 * A JavaScript source with its comments blanked out, so a scan over it reads
 * code.
 *
 * Extracted into its own module, with no side effects, for one reason: the
 * vendoring crawl in `copy-client-assets.mjs` imports it and so does
 * `vendor-crawl.test.ts`, and importing the crawl itself would run a build.
 *
 * ---- why the crawl needs this at all ---------------------------------
 *
 * `SPECIFIER_RE` is a regex over the whole file, which is the right shape for
 * the question "which modules does this file name" — every form that answers
 * it ends in a quoted string — and it has one failure the console found the
 * day `cds-number-input` was added. `@carbon/utilities/es/chunk-wkQsBGBN.js`
 * carries this JSDoc line:
 *
 *     * …it calls the 'onViewChangeEnd' callback with the response from
 *     * 'getCallbackResponse'.
 *
 * `from 'getCallbackResponse'` matches, nothing in `SPECIFIER_TABLE` covers
 * it, and the build refuses a tree that is in fact complete:
 *
 *     Error: @carbon/utilities/es/chunk-wkQsBGBN.js imports
 *     "getCallbackResponse", which SPECIFIER_TABLE does not cover.
 *
 * Measured, by adding `number-input.js` to `ENTRY_POINTS` and the one real
 * table entry it needs and nothing else. The guard was right to be loud and
 * wrong about why, which is the worst kind of correct: the obvious repair is a
 * table entry for a specifier that does not exist, and that entry would then
 * have to point somewhere, and `checkTable` would reject every path because
 * there is no such package. The next repair after that is loosening the regex,
 * and a regex that tolerates `getCallbackResponse` is one that tolerates a
 * real specifier the table has missed. So the comment is removed instead, and
 * what is scanned is code.
 *
 * ---- a walk rather than a regex --------------------------------------
 *
 * The same reasoning `controls.test.ts` records for its own stripper, which
 * reads the console's TypeScript for Carbon tags, and the same conclusion
 * reached from the other side of the fence. A regex that treats `//` as a line
 * comment eats the rest of the line whenever one appears inside a string —
 * `https://…` does — and a scanner that has eaten the line finds nothing and
 * passes, which is the failure neither of these two guards may have.
 *
 * So: quotes are tracked, backslash escapes are skipped, and template literals
 * are left intact, because a specifier written in one is still a specifier.
 * Comment bodies become spaces rather than vanishing, and newlines inside a
 * block comment are kept, so every offset and line number a failure message
 * prints still lines up with the file on disk.
 *
 * A regex literal containing a quote or a slash — `/["']/` — is not tracked,
 * because the scan's question is unaffected by one: a regex body cannot hold
 * an `import` or a `from` that this would otherwise have to read, and the
 * minified ESM this walks over contains none that would mislead it. If that
 * ever stops being true the symptom is loud, which is the only reason the
 * simplification is allowed: an uncovered specifier throws.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      out.push(c);
      i++;
      while (i < src.length) {
        const d = src[i];
        out.push(d);
        i++;
        if (d === "\\") {
          if (i < src.length) {
            out.push(src[i]);
            i++;
          }
          continue;
        }
        if (d === c) break;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
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
