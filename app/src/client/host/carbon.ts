/**
 * The one door onto `<cds-button>`, and the two things Carbon will not tell
 * you about.
 *
 * Issue #28 steps 1 and 2 put nine of the console's buttons on
 * `@carbon/web-components`. Both steps spelled the component's attributes at
 * the call site, which is how `danger--tertiary` shipped: Carbon's answer to a
 * kind it does not recognise is to render its inner `<button>` with no kind
 * class at all — no warning, no fallback, nothing in any log on either side —
 * and under `color-scheme: dark` an unstyled `<button>` is the UA's own grey
 * fill. Every `.ctl-danger` control on the console was a filled grey block,
 * Close session among them, and nothing anywhere said so.
 *
 * Step 2 answered that with a hand-maintained list of the three kinds
 * `controls.ts` asks for, read against `BUTTON_KIND` by a test. The list
 * covered three of seven call sites: `main.ts` spelled the other four itself,
 * `size` was checked nowhere at all, and a review changed one `kind: "ghost"`
 * in `main.ts` to `"ghost--x"` with typecheck and the whole suite still green.
 *
 * So the attributes are not spelled at call sites any more. {@link
 * carbonButton} is the only place in `src/client` that names the tag, and its
 * `kind` and `size` are unions, so a kind Carbon does not have is a compile
 * error at the site that writes it rather than a grey block in front of a
 * room. `controls.test.ts` holds the unions against `BUTTON_KIND` and
 * `BUTTON_SIZE` in the installed package, checks that this file is still the
 * only door, and reads the literals back out of every call site — because a
 * factory nobody is obliged to use is a convention, not a guard.
 *
 * ---- what reaches the focusable element -------------------------------
 *
 * A `<cds-button>` renders a `<button>` into a shadow root opened with
 * `delegatesFocus: true`. That inner `<button>` is the element assistive
 * technology sees, and its template — read in
 * `@carbon/web-components@2.64.0/es/components/button/button.js` — binds
 * exactly three of its ARIA attributes:
 *
 *   aria-label        from the `tooltip-text` attribute, in both branches of
 *                     the template, so the name survives `disabled` even
 *                     though the tooltip itself does not.
 *   aria-pressed      from `aria-pressed` on the host.
 *   aria-describedby  Carbon's own, for the badge slot and the danger
 *                     description.
 *
 * Nothing else crosses. An `aria-expanded`, an `aria-controls`, an
 * `aria-label` or a `title` set on the host stays on the host, where nothing
 * focusable ever reads it — the host is not the focusable element and never
 * appears in the accessibility tree as the button.
 *
 * That is why {@link CarbonButtonOpts} has a `tooltipText` and not an
 * `ariaLabel`, and why the console's two disclosure buttons — the wipe's arm
 * and the arcade's "Run a different round" — are hand-built `<button>`s in
 * `main.ts` rather than Carbon hosts. A control whose expanded state cannot be
 * announced is not an improvement on a `<button aria-expanded>`, and this
 * console's accessibility was built by hand and is not something the migration
 * gets to spend.
 */

import { hx, type Child, type ElemOptions } from "../shared/dom.ts";

/** The tag. Named once, here, and `controls.test.ts` checks that. */
const CARBON_BUTTON_TAG = "cds-button";

/**
 * Carbon's button kinds, spelled the way `BUTTON_KIND` spells them.
 *
 * The CSS-class spellings — `.cds--btn--danger--tertiary`, with two hyphens —
 * are deliberately not here, and `controls.test.ts` asserts that this list and
 * Carbon's enum hold exactly the same values in both directions: a value
 * missing from here is one the console cannot ask for, and a value here that
 * Carbon has dropped is a silent grey block waiting for a version bump.
 */
export const CARBON_BUTTON_KINDS = [
  "primary",
  "secondary",
  "tertiary",
  "ghost",
  "danger",
  "danger-primary",
  "danger-tertiary",
  "danger-ghost",
] as const;

export type CarbonKind = (typeof CARBON_BUTTON_KINDS)[number];

/**
 * Carbon's button sizes. A button's min and max block size are pinned to the
 * same token per size, which is the property the hand-built console button
 * spent a `min-height: 31px` buying: `sm` is 32px, `lg` is 48px.
 */
export const CARBON_BUTTON_SIZES = [
  "xs",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl",
] as const;

export type CarbonSize = (typeof CARBON_BUTTON_SIZES)[number];

export interface CarbonButtonOpts extends ElemOptions {
  readonly kind: CarbonKind;
  readonly size: CarbonSize;
  /**
   * The accessible name, and the only way to give a Carbon button one.
   *
   * It lands on the inner `<button>` as `aria-label`, which is what a reader
   * announces in place of the slotted label. It also draws Carbon's own
   * tooltip on hover and on focus, which is the trade: there is no property
   * that sets the name without the bubble. Leave it out and the name is the
   * slotted text, which is usually right.
   */
  readonly tooltipText?: string;
}

/**
 * A Carbon button.
 *
 * `type` defaults to `"button"` rather than being repeated at seven call
 * sites. Everything else is {@link ElemOptions}, so `class`, `text`,
 * `disabled`, `on` and `attrs` read exactly as they do for `h()`.
 */
export function carbonButton(
  opts: CarbonButtonOpts,
  children?: readonly Child[],
): HTMLElement {
  const { kind, size, tooltipText, attrs, ...rest } = opts;
  return hx(
    CARBON_BUTTON_TAG,
    {
      ...rest,
      type: rest.type ?? "button",
      attrs: {
        ...attrs,
        kind,
        size,
        ...(tooltipText === undefined ? {} : { "tooltip-text": tooltipText }),
      },
    },
    children,
  );
}
