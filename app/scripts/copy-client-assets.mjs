/**
 * Copies the clients' static assets (HTML, CSS) into `dist/` next to the
 * JavaScript `tsc` emitted, so the whole of `dist/client` can be served as-is.
 *
 * Twelve lines of fs is cheaper than a bundler, and a bundler is a dependency
 * that would need keeping current for a product that ships three pages.
 */

import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "src", "client");
const out = resolve(here, "..", "dist", "client");

mkdirSync(out, { recursive: true });
cpSync(src, out, {
  recursive: true,
  filter: (from) => !/\.(ts|map)$/.test(from),
});

console.log(`client assets → ${out}`);
