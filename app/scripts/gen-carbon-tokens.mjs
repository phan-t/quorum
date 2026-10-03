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
const BRIDGE_OWNS = new Set([
  "--cds-focus",
  "--cds-background",
  "--cds-layer-01",
  "--cds-layer-02",
  // Step 3's two. The other seven tokens the bridge declares are not theme
  // tokens at all — `@carbon/themes` does not export them — so they appear in
  // no generated block and need no entry here. See the bridge's own note.
  "--cds-text-primary",
  "--cds-text-placeholder",
]);

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
 * Thirteen tokens cross between the two systems. Everything else on either
 * side is left alone.
 *
 * It was four for steps 1 and 2, and the growth is the thing to understand
 * about step 3 rather than a sign of drift: \`cds-button\` reads almost nothing
 * from a theme — a tertiary's border and label come from one component token
 * and its focus halo from two — so four was all a button needed. Fields, tags
 * and pickers read a great deal, and nine more are what they turn out to
 * require. The reason it is nine and not thirty is below, and it is not what
 * step 3 was expected to find.
 *
 * Three of the four cross in the direction step 1 did not take: Carbon's token
 * takes the console's value, not the other way round. Step 1 bridged
 * \`--ground\` to \`var(--cds-background)\` and moved the console's dark page from
 * #0a0a0f to #161616, and the measurement that decided step 2 is what that
 * cost. The console's panels stayed at #14141d and #1d1d28, so they landed
 * 1.01:1 and 1.08:1 against the new page — \`--panel\` fractionally the *darker*
 * of the pair, the elevation model inverted, the panels gone.
 *
 * The obvious repair is Carbon's own layers, \`layer-01\` #262626 and
 * \`layer-02\` #393939. It is not available, and the reason is a number rather
 * than a preference. Four of the console's dark inks were derived by walking a
 * hue up in OKLCH until it cleared 4.5:1 on \`--panel-2\` #1d1d28, which means
 * they sit *at* the floor there and have nowhere to go:
 *
 *   ink                      on #1d1d28   on #393939   on #262626
 *   --muted         #8b8a9c     4.94         3.42         4.48
 *   --danger/--miss #f83b39     4.51         3.12         4.09
 *   --consul-ink    #ec447e     4.52         3.13         4.10
 *   --terraform-ink #a06ae6     4.53         3.13         4.11
 *
 * Eight pairings under AA, and the four inks live in \`shared/tokens.css\`,
 * which the participant and Desktop surfaces also read and which #28 step 6
 * keeps as it is. So Carbon's layers cannot be adopted here without retuning
 * the product palette for two surfaces that are not being migrated.
 *
 * The console's surfaces therefore stay exactly as the product defines them,
 * and Carbon is told what they are. That is the right direction for an overlay
 * anyway: a design system is given the product's ground, it does not hand the
 * product one.
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
 *    Non-text UI, 3:1 floor. #1060ff measures 3.89:1 on #0a0a0f and 5.07:1 on
 *    #ffffff. It clears.
 *
 * 2. \`--cds-background\` takes the console's \`--ground\`.
 *
 *    #0a0a0f dark, #ffffff light. Carbon reads it for one thing on this
 *    surface — the outer ring of a button's two-ring focus halo, which is
 *    drawn in the page colour so the inner ring reads against it — and will
 *    read it for more as steps 3 and 4 land fields, tags and the grid.
 *
 * 3 & 4. \`--cds-layer-01\` and \`--cds-layer-02\` take \`--panel\` and \`--panel-2\`.
 *
 *    #14141d and #1d1d28 dark, #fafafa and #f1f2f3 light. The console's two
 *    elevations, in Carbon's words for them, so that a Carbon component
 *    dropped onto a panel in a later step computes against the surface it is
 *    actually on. Nothing in \`cds-button\` reads a layer; these are here
 *    because the three are one idea and splitting them across two steps is how
 *    a bridge ends up with a token that disagrees with its neighbours.
 *
 * ---- 5 to 11: the seven tokens that are not tokens -----------------------
 *
 *    \`--cds-layer\`, \`--cds-layer-hover\`, \`--cds-layer-background\`,
 *    \`--cds-field\`, \`--cds-field-hover\`, \`--cds-border-strong\`,
 *    \`--cds-border-subtle\`.
 *
 *    These are the ones step 3 was not expecting, and they are not a colour
 *    decision — without them the components do not render.
 *
 *    \`cds-text-input\` paints its box with \`background-color: var(--cds-field)\`
 *    and draws its one edge with \`border-block-end: 1px solid
 *    var(--cds-border-strong)\`. Neither has a fallback, and neither token is
 *    among the 234 \`@carbon/themes\` exports: the theme ships \`field-01\`,
 *    \`field-02\`, \`field-03\` and \`border-strong-01..03\`, and the unnumbered
 *    name is an *alias for the current layer*, which Carbon sets with
 *
 *        .cds--layer-one, :root { --cds-field: var(--cds-field-01); … }
 *
 *    That rule is compiled into each component's own stylesheet, which Lit
 *    adopts into the shadow root — where \`:root\` matches nothing, because the
 *    root of a shadow tree is a \`ShadowRoot\` and not an element, and
 *    \`.cds--layer-one\` is a class no element here has. Carbon's intent is that
 *    the *document* loads \`@carbon/styles\`, where the same rule's \`:root\` does
 *    match. This console does not and will not: that stylesheet is the 1.1 MB
 *    artifact with 105 \`@font-face\` rules that this generator exists to avoid.
 *
 *    So on this console the aliases are undefined, a \`var()\` with no fallback
 *    is invalid at computed-value time, and the declaration behaves as
 *    \`unset\`. A field gets \`background-color: transparent\` and
 *    \`border-block-end-style: none\` — no fill, no edge, a caret and some text
 *    floating on the panel. Measured in the browser before the bridge grew.
 *    The same failure class as step 1's \`--cds-button-tertiary\` falling back
 *    to Carbon Blue 60, and worse, because there is no fallback to be wrong:
 *    there is nothing at all.
 *
 *    Pointed, like the layers, at the console's own surfaces:
 *
 *      --cds-layer             --panel      the current layer
 *      --cds-layer-hover       --panel-2    one step up
 *      --cds-layer-background  --ground     the page a layer sits on
 *      --cds-field             --panel      a field's fill
 *      --cds-field-hover       --panel-2
 *      --cds-border-strong     --muted      a field's one edge
 *      --cds-border-subtle     --line       structural hairlines
 *
 *    Contrast, computed, dark then light. Text at 4.5:1, non-text UI at 3:1.
 *
 *      the field's fill    --panel on --ground            1.08  1.04
 *      the field's edge    --muted on --panel             5.41  5.19   AA
 *      .rs-field's edge    --muted on --ground            5.84  5.42   AA
 *
 *    The edge carries the 3:1 and the fill does not, which is deliberate and
 *    is the one figure here that is a change rather than a translation.
 *    \`--cds-border-strong\` is Carbon's *control boundary*, and on a Carbon
 *    field it is the only edge there is: the component sets \`border: none\` and
 *    draws one rule along the bottom. The console's \`--line\` is HDS
 *    \`border-primary\`, a structural hairline, and it measures 1.33:1 dark and
 *    1.25:1 light on \`--panel\` — as a full 1px box round a boxed field that
 *    was under the floor already but traced the whole control, and as a single
 *    bottom rule under a fill 1.08:1 from its surround it would leave nothing
 *    identifying the field at all. \`--muted\` is the console's own quiet ink,
 *    clears 3:1 with room in both themes on both surfaces, and \`host.css\`
 *    redraws the hand-built \`.field\` to the same edge so the surface has one
 *    field rather than two.
 *
 * ---- 12 and 13: the two inks --------------------------------------------
 *
 *    \`--cds-text-primary\` takes \`--ink\`; \`--cds-text-placeholder\` takes
 *    \`--muted\`.
 *
 *      --cds-text-primary      --ink on --panel          16.80  18.72   AA
 *                              --ink on --ground         18.13  19.54   AA
 *      --cds-text-placeholder  --muted on --panel         5.41   5.19   AA
 *                              --muted on --ground        5.84   5.42   AA
 *
 *    \`text-primary\` is a field's ink and its caret, and Carbon's g100 value
 *    #f4f4f4 is a half-step off \`--ink\` #f6f5f3 — imperceptible alone and
 *    wrong beside it, because what a host reads is a Carbon field's text an
 *    inch under \`.a-item\`'s. Two whites on one panel is the kind of thing
 *    nobody can name and everybody can see.
 *
 *    \`text-placeholder\` is a measured failure rather than a preference.
 *    Carbon's is \`rgba(244, 244, 244, 0.4)\`, and composited over the surface
 *    it actually lands on it is **3.59:1** on \`--panel\` and 3.45:1 on Carbon's
 *    own \`field-01\` #262626 — under 4.5:1 on text, in both places, in the
 *    theme as shipped. The placeholder on the wipe's field is the word
 *    "restart", which is the instruction. \`--muted\` is 5.41:1.
 *
 * ---- what is NOT bridged, having been expected to be ---------------------
 *
 *    \`--cds-field-01\` #262626, \`--cds-field-02\` #393939,
 *    \`--cds-border-subtle-01\` #525252, \`--cds-layer-hover-01\` #333333 and
 *    \`--cds-layer-accent-01\` #393939 are read by **nothing on this console**.
 *    Every declaration that names them is inside the \`.cds--layer-one, :root\`
 *    block above, which never matches, so the numbered tokens are dead here
 *    and the unnumbered aliases are what the components read. Bridging them
 *    would be five lines that move no pixel — and the arithmetic that made
 *    them look dangerous, \`--muted\` at 4.48:1 on #262626, never arises,
 *    because no surface on this console is ever #262626.
 *
 *    \`--cds-text-secondary\` #c6c6c6 and \`--cds-text-helper\` #a8a8a8 are the
 *    stacked label and the helper text. Every field and the one picker is
 *    built with \`hide-label\` and no helper text, so both colours land in
 *    elements that are \`visually-hidden\` or \`hidden\`. The label decision is
 *    what takes them off the list; if #28 step 5 adopts Carbon's stacked
 *    label, they go back on it. Step 4's table cells read
 *    \`--cds-text-secondary\` too, as their text colour, and \`host.css\` sets
 *    them back to inheriting the console's ink rather than bridging it.
 *
 *    \`--cds-tag-background-gray\` and \`--cds-tag-color-gray\` are component
 *    tokens rather than palette, so they are set in \`host.css\` on \`cds-tag\`
 *    itself — exactly as \`--cds-button-disabled\` is set on \`cds-button\`, and
 *    for the reason recorded there: a component token declared on \`:root\` is a
 *    decision handed by inheritance to every component that reads it.
 *
 * All thirteen are declared once under \`:root\` and — for the six that
 * \`@carbon/themes\` exports at all — omitted from the four generated blocks
 * above, so there is no specificity race with the explicit-theme selectors.
 * \`:root[data-theme="dark"]\` is (0,2,0) and \`:root\` is (0,1,0), so a generated
 * \`--cds-background: #161616\` under the explicit-dark selector would beat a
 * bridge declaration written afterwards under \`:root\`, and the page would
 * change colour the moment someone pressed the theme toggle twice. Leaving the
 * token out of the generated blocks removes the race rather than winning it.
 * One declaration is correct in all four states because the right-hand side is
 * itself a \`tokens.css\` token that already moves with the theme.
 */
:root {
  --cds-focus: var(--action);
  --cds-background: var(--ground);
  --cds-layer-01: var(--panel);
  --cds-layer-02: var(--panel-2);

  /* Step 3. The layer-context aliases \`@carbon/styles\` would otherwise
     declare, and the two inks. See above for each one's figures. */
  --cds-layer: var(--panel);
  --cds-layer-hover: var(--panel-2);
  --cds-layer-background: var(--ground);
  --cds-field: var(--panel);
  --cds-field-hover: var(--panel-2);
  --cds-border-strong: var(--muted);
  --cds-border-subtle: var(--line);
  --cds-text-primary: var(--ink);
  --cds-text-placeholder: var(--muted);
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
