/**
 * Copies the clients' static assets (HTML, CSS) into `dist/` next to the
 * JavaScript `tsc` emitted, so the whole of `dist/client` can be served as-is,
 * and vendors the browser ES modules the console imports from `node_modules`
 * into `dist/vendor`.
 *
 * Twelve lines of fs is cheaper than a bundler, and a bundler is a dependency
 * that would need keeping current for a product that ships three pages.
 */

import { copyFileSync, cpSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
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

/* ------------------------------------------------------------------ */
/* Vendored browser modules                                            */
/* ------------------------------------------------------------------ */

/**
 * Carbon's web components, served from the container, as modules.
 *
 * No bundler and no CDN. A live session runs in a room, sometimes on
 * conference wifi behind a captive portal, and a console that needs
 * `1.www.s81c.com` to resolve before a host can press Next is a console that
 * does not work at the only moment it matters. Carbon's own CDN is not even a
 * viable vendoring *source* — issue #28 records `version/v2.64.0/button.min.js`
 * and the v2.63.0 equivalent both returning 404. So the files come out of
 * `node_modules`, which means out of the lockfile, which means the same bytes
 * on every machine and in the image.
 *
 * Why a crawl rather than `cpSync` of the whole package: `@carbon/web-components`
 * unpacks to 70 MB and ~5,000 modules, and the console imports one component.
 * Copying the tree would put 5,000 files in the image to serve 32, and would
 * make the request count unknowable from reading this file. The crawl copies
 * exactly what is reachable from the entry points below, and prints the count
 * so a component added in a later step shows its cost in the build log.
 *
 * Why no rewriting: the copied files keep their bare specifiers — `lit`,
 * `lit/directives/class-map.js` — and the browser resolves them through the
 * import map in `host/index.html`. Rewriting them would mean editing third
 * party JavaScript with a regex, which is the first step towards being a
 * bundler. `SPECIFIER_TABLE` below is the one table that decides both where a
 * bare specifier is copied from and what the import map says, so the two
 * cannot disagree — and `checkImportMap` fails the build if they do.
 */

const nodeModules = resolve(here, "..", "node_modules");
const vendorOut = resolve(here, "..", "dist", "vendor");

/**
 * Where the crawl starts. One entry per component the console mounts.
 *
 * `button.js` and not `components/button/index.js`: the index also pulls in
 * `button-set` and `button-skeleton`, which are eleven more modules for two
 * elements nothing renders. The same rule for the rest — `tag/index.js` would
 * bring the skeleton and all three interactive tags, and `select/index.js` the
 * skeleton, so each element is named by its own module.
 *
 * `select-item.js` is listed separately because `select.js` does not import
 * it — read its imports: `cds-select` finds its options with
 * `item.matches("cds-select-item")` and `getAttribute`, which work on an
 * element the browser has never upgraded, so nothing in the graph reaches the
 * second `customElements.define`.
 *
 * Measured by removing the line and rebuilding from clean: `main.js` imports
 * the module directly, the file is not in `dist/vendor`, the request 404s, and
 * a failed import takes the whole entry module with it — `#app` has no
 * children and the console renders **nothing at all**. One line in the
 * browser's console and nothing on the server side. Loud rather than subtle,
 * which is the good case; the bad case would be noticing at 1:55pm.
 */
const ENTRY_POINTS = [
  "@carbon/web-components/es/components/button/button.js",
  "@carbon/web-components/es/components/tag/tag.js",
  "@carbon/web-components/es/components/text-input/text-input.js",
  "@carbon/web-components/es/components/select/select.js",
  "@carbon/web-components/es/components/select/select-item.js",
];

/**
 * Every bare specifier the vendored tree is allowed to contain, and the path
 * under `node_modules` it resolves to. A key ending in `/` is a prefix, which
 * is what an import map calls a scope-less trailing-slash mapping and what
 * covers `lit/directives/*` and `@carbon/icons/es/*` without listing each one.
 *
 * Fixed rather than computed from `package.json` `exports` fields on purpose.
 * Carbon's exports map is `{"./es/components/*": {"default": "./es/components/*"}}`
 * and lit's is conditional on `development`; resolving either properly means
 * implementing Node's algorithm, and implementing it slightly differently from
 * the browser is how a vendored tree comes to 404 one module in thirty-two.
 * Thirteen literal lines, checked against the filesystem on every build by
 * `checkTable`, is the cheaper correctness.
 *
 * The entries past `@lit/reactive-element` are not reached by step 1's single
 * button. They are listed because issue #28's later steps mount components
 * that do reach them — the tooltip pulls `@floating-ui/dom`, every icon-ful
 * component pulls `@carbon/icons/es/*` and `@carbon/icon-helpers` — and
 * because `checkTable` verifies all thirteen against the installed tree, so a
 * line that has gone stale fails this build rather than that one.
 */
const SPECIFIER_TABLE = {
  "@carbon/web-components/": "@carbon/web-components/",
  lit: "lit/index.js",
  "lit/": "lit/",
  "lit-html": "lit-html/lit-html.js",
  "lit-html/": "lit-html/",
  "lit-element": "lit-element/index.js",
  "lit-element/": "lit-element/",
  "@lit/reactive-element": "@lit/reactive-element/reactive-element.js",
  "@lit/reactive-element/": "@lit/reactive-element/",
  "@lit-labs/ssr-dom-shim": "@lit-labs/ssr-dom-shim/index.js",
  "@floating-ui/dom": "@floating-ui/dom/dist/floating-ui.dom.esm.js",
  "@carbon/icon-helpers": "@carbon/icon-helpers/es/index.js",
  "@carbon/icons/": "@carbon/icons/",
};

/** Where a vendored file is served from, given its path under `node_modules`. */
const VENDOR_URL = "/vendor/";

/**
 * Every module specifier in a file.
 *
 * A regex and not a parser, for the same reason `stylesheets.test.ts` reads
 * CSS with one: the question is "which specifiers does this file name", and
 * every form that answers it ends in a quoted string. It has to cope with
 * minified ESM — lit ships `export*from"lit-element/lit-element.js"` with no
 * space after `export` — so the anchor is `from` or `import` immediately
 * followed by the quote, rather than the keyword plus whitespace. A false
 * positive cannot pass silently: an unresolvable specifier throws below.
 */
const SPECIFIER_RE = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g;

/** A bare specifier's absolute path, or null when the table does not cover it. */
function resolveBare(spec) {
  const exact = SPECIFIER_TABLE[spec];
  if (exact !== undefined) return resolve(nodeModules, exact);
  for (const [key, value] of Object.entries(SPECIFIER_TABLE)) {
    if (key.endsWith("/") && spec.startsWith(key)) {
      return resolve(nodeModules, value + spec.slice(key.length));
    }
  }
  return null;
}

/** The table entry a specifier matched, for the import map's sake. */
function tableKeyFor(spec) {
  if (SPECIFIER_TABLE[spec] !== undefined) return spec;
  for (const key of Object.keys(SPECIFIER_TABLE)) {
    if (key.endsWith("/") && spec.startsWith(key)) return key;
  }
  return null;
}

/** Every table entry points at something that is actually installed. */
function checkTable() {
  for (const [key, value] of Object.entries(SPECIFIER_TABLE)) {
    const target = resolve(nodeModules, value);
    try {
      // A prefix entry names a directory; an exact entry names a file. Both
      // are `stat`-able, and neither being there is a table that has drifted
      // from the lockfile.
      statSync(target);
    } catch {
      throw new Error(
        `SPECIFIER_TABLE["${key}"] points at ${value}, which is not in ` +
          `node_modules. Either the dependency moved its files or the entry ` +
          `is stale; both are decided by the lockfile, so fix the table.`,
      );
    }
  }
}

/**
 * Follow the import graph from the entry points, copying as it goes.
 *
 * Returns the set of table keys the graph actually reached, which is what the
 * import map has to carry — no more, so that a dangling `/vendor/...` entry
 * for a package nobody imports cannot sit in the HTML looking correct.
 */
function vendor() {
  const copied = new Set();
  const reachedKeys = new Set();
  let bytes = 0;

  const visit = (abs, from) => {
    if (copied.has(abs)) return;
    const rel = relative(nodeModules, abs);
    if (rel.startsWith("..") || rel.startsWith(sep)) {
      throw new Error(`${rel} escapes node_modules (imported by ${from})`);
    }
    let source;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      throw new Error(
        `${rel} is imported by ${from} but is not in node_modules`,
      );
    }
    copied.add(abs);
    const dest = resolve(vendorOut, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    bytes += Buffer.byteLength(source);

    for (const match of source.matchAll(SPECIFIER_RE)) {
      const spec = match[1] ?? match[2];
      if (spec === undefined) continue;
      // `.map` is skipped and so is anything that would only be reached
      // through one: the browser asks for a source map when devtools are open
      // and a session is not run with devtools open.
      if (spec.endsWith(".map")) continue;
      if (spec.startsWith(".")) {
        visit(resolve(dirname(abs), spec), rel);
        continue;
      }
      const key = tableKeyFor(spec);
      if (key === null) {
        throw new Error(
          `${rel} imports "${spec}", which SPECIFIER_TABLE does not cover. ` +
            `Add it there — the same table is what the import map in ` +
            `host/index.html has to carry.`,
        );
      }
      reachedKeys.add(key);
      visit(resolveBare(spec), rel);
    }
  };

  for (const entry of ENTRY_POINTS) {
    const key = tableKeyFor(entry);
    if (key === null) {
      throw new Error(`entry point "${entry}" is not in SPECIFIER_TABLE`);
    }
    reachedKeys.add(key);
    visit(resolveBare(entry), "ENTRY_POINTS");
  }

  return { count: copied.size, bytes, reachedKeys };
}

/**
 * The import map the crawl implies, and the one `host/index.html` carries.
 *
 * The HTML is committed, because an import map injected at build time is an
 * import map no reviewer reads. So the build compares the two and fails on
 * drift, which is the only thing that keeps a hand-written map honest: a
 * missing entry is a module that 404s in the browser with nothing in any log
 * on this side, and a stale entry is a path that resolves to nothing.
 */
function checkImportMap(reachedKeys) {
  const expected = {};
  for (const key of [...reachedKeys].sort()) {
    expected[key] = VENDOR_URL + SPECIFIER_TABLE[key];
  }
  const htmlPath = resolve(src, "host", "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const found = html.match(
    /<script type="importmap">([\s\S]*?)<\/script>/,
  );
  if (found === null) {
    throw new Error(`no <script type="importmap"> in ${htmlPath}`);
  }
  const actual = JSON.parse(found[1]).imports ?? {};
  const want = JSON.stringify(expected, null, 2);
  const have = JSON.stringify(
    Object.fromEntries(Object.entries(actual).sort()),
    null,
    2,
  );
  if (want !== have) {
    throw new Error(
      `the import map in host/index.html does not match what the crawl ` +
        `reached.\n\nexpected:\n${want}\n\nfound:\n${have}\n`,
    );
  }
}

checkTable();
const { count, bytes, reachedKeys } = vendor();
checkImportMap(reachedKeys);
console.log(
  `vendored modules → ${vendorOut}\n` +
    `  ${count} modules · ${(bytes / 1024).toFixed(0)} KB raw · ` +
    `${reachedKeys.size} import-map entries`,
);
