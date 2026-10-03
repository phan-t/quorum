/**
 * Types for `strip-comments.mjs`, so `vendor-crawl.test.ts` can import it
 * under `strict`.
 *
 * Hand-written and two lines, rather than turning `allowJs` on for the whole
 * project: `tsconfig.json` includes `src/**​/*.ts` and nothing else, and the
 * build script this module serves runs under plain `node` with no
 * `--experimental-strip-types`, so it cannot import a `.ts` and the module
 * cannot move into `src/`. NodeNext resolution finds this file by name.
 */
export declare function stripComments(src: string): string;
