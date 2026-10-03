/**
 * Generates `src/client/host/carbon-tokens.css` — Carbon's theme, re-keyed
 * under this repo's three-state selectors.
 *
 * Why generate rather than install: `@carbon/web-components` ships no
 * theme-only CSS on npm. The one stylesheet artifact in the package is
 * `@carbon/styles`' 1.1 MB `styles.css`, which carries 105 `@font-face` rules
 * for IBM Plex and a full component reset — neither of which this console
 * wants. The tokens themselves are plain data in `@carbon/themes`, so the
 * token file is written out from there and committed, which keeps the browser
 * payload to the 234 custom properties the components actually read.
 *
 * Why committed rather than built: `build:client` is `tsc` plus a copy, and a
 * reviewer has to be able to read the diff when a Carbon upgrade moves a
 * colour. A generated file in the tree is reviewable; a generated file in
 * `dist/` is not. Run this by hand after bumping `@carbon/web-components`:
 *
 *     node scripts/gen-carbon-tokens.mjs
 *
 * and commit what changes. The header it writes records the `@carbon/themes`
 * version it read, so a stale file is visible without running anything.
 *
 * ---- what is in here, and what is deliberately not ----------------------
 *
 * COLOUR TOKENS. `@carbon/themes` exports each theme as a flat object of 234
 * colours plus `colorScheme`. `colorScheme` is dropped: `tokens.css` already
 * declares the CSS `color-scheme` property in every one of these states, and
 * `--cds-color-scheme` is a property no Carbon component reads.
 *
 * COMPONENT TOKENS. This is the part that is not obvious and that a
 * theme-tokens-only file gets wrong. `--cds-button-tertiary` is *not* in the
 * 234 — Carbon keeps per-component colours in a separate set, published by
 * `@carbon/themes` as `buttonTokens`, `tagTokens` and three more, keyed by
 * theme name. The compiled component CSS reads them with a hardcoded fallback
 * baked in at Carbon's build time, and that fallback is the *light* theme's
 * value: `var(--cds-button-tertiary, #0f62fe)`. So a token file carrying only
 * the 234 leaves `kind="tertiary"` rendering Carbon Blue 60 — #0f62fe, which
 * is 3.62:1 on g100's own #161616 background and fails the 4.5:1 floor for a
 * button label. The fallback does not move when `data-theme` moves either, so
 * the omission looks like a theming bug rather than a missing token. All five
 * component groups are emitted here for that reason.
 *
 * TYPE AND LAYOUT TOKENS. Not emitted. `--cds-body-compact-01-font-size` and
 * `--cds-layout-size-height-sm` live in `@carbon/type` and `@carbon/layout`,
 * not in a theme, and their compiled fallbacks (14px, 32px) are the values
 * Carbon intends. Issue #28 step 5 is where the console decides whether to
 * push its own 13/11 through them; until it does, naming them here would be
 * deciding it by accident.
 *
 * NO `[data-surface="screen"]` BLOCK. `tokens.css` pins every token under
 * that selector because the big screen must not follow the theme switch. This
 * file is loaded by `host/index.html` alone and the console never sets
 * `data-surface`, so the block would be unreachable. If a fourth surface ever
 * loads this file, it needs one.
 */

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as themes from "@carbon/themes";

const require = createRequire(import.meta.url);
const THEMES_VERSION = require("@carbon/themes/package.json").version;
const WC_VERSION = require("@carbon/web-components/package.json").version;

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "src", "client", "host", "carbon-tokens.css");

/**
 * The five component-token groups `@carbon/themes` publishes, with the key
 * each one uses for the `white` theme — `whiteTheme`, not `white`, because
 * `white` is a reserved word in the generator Carbon runs upstream.
 */
const COMPONENT_GROUPS = [
  "buttonTokens",
  "tagTokens",
  "notificationTokens",
  "statusTokens",
  "contentSwitcherTokens",
];
const THEME_KEY = { g100: "g100", white: "whiteTheme" };

/** `--cds-` plus Carbon's own kebab spelling. Theirs, not ours: `layer01` is
 *  `--cds-layer-01` and not `--cds-layer01`, and guessing that wrong is
 *  silent — the property simply never matches. */
function prop(name) {
  return `--cds-${themes.formatTokenName(name)}`;
}

/**
 * The tokens the bridge below owns, which are therefore left out of every
 * generated block.
 *
 * This is deliberate and it is the only reason the bridge can be a single
 * `:root` rule. `:root[data-theme="dark"]` is specificity (0,2,0) and `:root`
 * is (0,1,0), so a generated `--cds-focus: #ffffff` under the explicit-dark
 * selector would beat a bridge declaration written afterwards under `:root`,
 * and the console would show two focus-ring colours again the moment someone
 * pressed the theme toggle twice. Leaving the token out of the generated
 * blocks removes the race rather than winning it.
 */
const BRIDGE_OWNS = new Set(["--cds-focus"]);

/**
 * Every declaration for one theme, sorted.
 *
 * Sorted rather than left in export order so that a Carbon upgrade that only
 * reorders its exports produces no diff, and one that changes a colour
 * produces exactly one line of diff.
 */
function declarations(theme) {
  const lines = [];
  for (const [name, value] of Object.entries(themes[theme])) {
    if (name === "colorScheme") continue;
    lines.push([prop(name), value]);
  }
  for (const group of COMPONENT_GROUPS) {
    for (const [name, byTheme] of Object.entries(themes[group])) {
      lines.push([prop(name), byTheme[THEME_KEY[theme]]]);
    }
  }
  lines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return lines.filter(([k]) => !BRIDGE_OWNS.has(k));
}

/** One block. `indent` because the light block sits inside a media query. */
function block(selector, theme, indent) {
  const pad = " ".repeat(indent);
  const body = declarations(theme)
    .map(([k, v]) => `${pad}  ${k}: ${v};`)
    .join("\n");
  return `${pad}${selector} {\n${body}\n${pad}}`;
}

const HEADER = `/*
 * Carbon's theme tokens, for the console only. GENERATED — do not edit.
 *
 *   node scripts/gen-carbon-tokens.mjs
 *
 * from @carbon/themes ${THEMES_VERSION}, for @carbon/web-components ${WC_VERSION}.
 * See that script's header for what is in here and what is deliberately not.
 *
 * Loaded by \`host/index.html\` alone, after \`shared/tokens.css\`. The
 * participant and Desktop surfaces never see it: \`tokens.css\` is the product
 * palette, loaded by all three, and issue #28 step 6 is the decision to leave
 * it that way.
 *
 * Three states, the same three \`tokens.css\` uses, in the same order, each
 * beating the last:
 *
 *   :root                                 g100 (#161616), the default
 *   @media (prefers-color-scheme: light)  white, when the viewer has not chosen
 *   :root[data-theme="light"]             an explicit choice
 *   :root[data-theme="dark"]              an explicit choice
 *
 * g90 and g10 are not emitted. Carbon ships four themes; this console has two
 * and \`shared/theme.ts\` is a three-state control over those two.
 */`;

const BRIDGE = `/* ---- the bridge ---------------------------------------------------------
 *
 * Two tokens cross between the two systems. Everything else on either side is
 * left alone, because a bridge that grows is a second design system.
 *
 * 1. \`--cds-focus\` takes the console's \`--action\`.
 *
 *    g100's focus colour is #ffffff and white's is #0f62fe. The console's
 *    focus ring is \`--ibm-blue\`, which is \`var(--action)\` #1060ff — and
 *    \`tokens.css\` records why: the ring *was* Carbon Blue 60 #0f62fe, and HDS
 *    \`color-foreground-action\` is a half-step off it and is already what the
 *    sign-in button uses, so the two were made to agree. Without this line the
 *    console draws a white ring on its Carbon controls and a blue one on its
 *    own, two inches apart, on one surface.
 *
 *    Non-text UI, 3:1 floor. #1060ff measures 3.57:1 on #161616 and 5.07:1 on
 *    #ffffff. It clears, with less headroom than the 3.89:1 it had on #0a0a0f.
 *
 *    Declared once under \`:root\` and omitted from the four generated blocks
 *    above, so there is no specificity race with the explicit-theme selectors.
 *    \`--action\` is an HDS constant and does not move between themes, so one
 *    declaration is correct in all four states.
 *
 * 2. \`--ground\` takes Carbon's \`background\`.
 *
 *    This is the decision that makes step 1 wider than issue #28 describes:
 *    the Carbon controls sit on Carbon's own #161616 rather than on the
 *    console's #0a0a0f. It goes in this direction — the console's token taking
 *    Carbon's value — because \`shared/tokens.css\` is loaded by all three
 *    surfaces and must not change, and this file is loaded by the console
 *    alone. Same selectors as \`tokens.css\`, same specificity, later in the
 *    document: the cascade picks these by source order.
 *
 *    In the light theme Carbon's \`background\` is #ffffff, which is already
 *    what \`tokens.css\` sets \`--ground\` to, so the light theme does not move
 *    at all. Only the dark theme does, from #0a0a0f to #161616.
 *
 *    Every dark-theme contrast figure in \`host.css\` that named \`--ground\` was
 *    measured against #0a0a0f and has been recomputed; \`host.css\`'s header
 *    carries the table. \`tokens.css\` keeps its own figures, which are still
 *    correct for the two surfaces that still ground at #0a0a0f.
 *
 *    \`--panel\` #14141d and \`--panel-2\` #1d1d28 are NOT bridged, and that is a
 *    measurement and not an oversight: #14141d against #161616 is 1.01:1 and
 *    #1d1d28 against #161616 is 1.08:1, so the console's panels now sit within
 *    a hair of the page behind them and \`--panel\` is very slightly the darker
 *    of the two. Mapping them to Carbon's \`layer-01\` #262626 and \`layer-02\`
 *    #393939 would restore the step, and would also move eleven \`host.css\`
 *    figures that were measured on #14141d and #1d1d28. That is a decision
 *    about the console's whole surface rather than about one button, so step 1
 *    reports the number and changes nothing.
 */
:root {
  --cds-focus: var(--action);
  --ground: var(--cds-background);
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --ground: var(--cds-background);
  }
}

:root[data-theme="light"] {
  --ground: var(--cds-background);
}

:root[data-theme="dark"] {
  --ground: var(--cds-background);
}`;

const css = [
  HEADER,
  "",
  block(":root", "g100", 0),
  "",
  "@media (prefers-color-scheme: light) {",
  block(':root:not([data-theme="dark"])', "white", 2),
  "}",
  "",
  block(':root[data-theme="light"]', "white", 0),
  "",
  block(':root[data-theme="dark"]', "g100", 0),
  "",
  BRIDGE,
  "",
].join("\n");

writeFileSync(out, css, "utf8");
const count = declarations("g100").length;
console.log(
  `carbon tokens → ${out}\n` +
    `  @carbon/themes ${THEMES_VERSION} · ${count} properties × 4 blocks · ` +
    `${(Buffer.byteLength(css) / 1024).toFixed(1)} KB`,
);
