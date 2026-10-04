/**
 * The Desktop's frame budget (#45).
 *
 * `fitZoom` is the search and is tested directly. Which parts give way is a
 * decision written into the scene's markup, which builds DOM at import, so —
 * like `recap.test.ts` — that half reads the source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FIT_FLOOR, fitZoom } from "./fit.ts";

describe("fitZoom", () => {
  test("leaves a frame that already fits at full size", () => {
    assert.equal(fitZoom(() => false), 1);
  });

  test("returns the largest step at which nothing overflows", () => {
    const tried: number[] = [];
    const zoom = fitZoom((z) => {
      tried.push(z);
      return z > 0.8;
    });
    assert.equal(zoom, 0.8);
    assert.deepEqual(tried, [1, 0.95, 0.9, 0.85, 0.8]);
  });

  test("stops at the floor rather than shrinking text out of legibility", () => {
    assert.equal(fitZoom(() => true), FIT_FLOOR);
  });
});

describe("the Desktop's reveals", () => {
  const src = readFileSync(join(import.meta.dirname, "main.ts"), "utf8");
  const decl = (name: string): string => {
    const m = src.match(new RegExp(`const ${name} = h\\([^;]*;`));
    assert.ok(m, `no declaration of ${name} in screen/main.ts`);
    return m[0];
  };

  for (const name of ["question", "rows", "note", "recap", "unsealRecap", "ggRecap", "ggPairs", "bridgeRecap", "grid"]) {
    test(`${name} gives way to a long reveal`, () => {
      assert.match(decl(name), /"data-fit"/);
    });
  }

  test("the trivia podium never does: it is what the room is waiting for", () => {
    assert.doesNotMatch(decl("podium"), /data-fit/);
  });

  test("the budget runs after every paint and on resize", () => {
    assert.match(src, /scene\?\.update\(state\);\n\s*refit\(\);/);
    assert.match(src, /addEventListener\("resize", refit\)/);
  });

  test("a drain inside the last one's dwell joins it rather than replacing it", () => {
    assert.match(src, /drainTimer !== null \? Array\.from\(drainLog\.querySelectorAll<HTMLElement>\("\.s-drain-who"\)\)/);
  });

  test("and again when a timed beat leaves the frame it was worked out for", () => {
    assert.match(src, /drainLog\.hidden = true;[\s\S]{0,120}refit\(\);/);
    assert.match(src, /winLog\.hidden = true;[\s\S]{0,120}refit\(\);/);
  });
});
