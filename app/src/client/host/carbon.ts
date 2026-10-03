/**
 * The one door onto Carbon's elements, and the things Carbon will not tell
 * you about.
 *
 * Four tags come through here: `cds-button` (steps 1 and 2), and `cds-tag`,
 * `cds-text-input` and `cds-select` with its `cds-select-item` (step 3). Every
 * enumerated attribute is a union, so a value Carbon does not have is a
 * compile error at the line that writes it rather than something a host finds
 * in front of a room — see the `danger--tertiary` story below, which is why
 * this file exists at all.
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
 *
 * ---- and what reaches a field --------------------------------------
 *
 * The same reading, done again for step 3's components, because "Carbon
 * forwards almost nothing" is a property of how these templates are written
 * rather than a fact about buttons.
 *
 * `cds-text-input` renders `<input id="input">` into a shadow root, again
 * opened with `delegatesFocus: true`, and binds `autocomplete`, `disabled`,
 * `name`, `pattern`, `placeholder`, `readonly`, `required`, `type`, a
 * `maxlength` from `max-count`, `.value`, and an `aria-describedby` of its
 * own. There is no `aria-label` binding at all. The accessible name comes from
 * the shadow `<label for="input">`, fed by the `label` property or the
 * `label-text` slot — which is why {@link CarbonTextInputOpts} has a
 * **required** `label` and no `ariaLabel`, and why `hideLabel` is how the
 * console keeps its own visible label without drawing Carbon's second one.
 *
 * Two consequences that are easy to miss and silent when missed:
 *
 *   - An `aria-label` on the host stays on the host, exactly as on a button.
 *     All three fields converted in step 3 carried one.
 *   - A document `<label for>`, or a `<label>` wrapped around the host,
 *     associates with **nothing**. Label association needs a labelable
 *     element; a custom element with no form-associated internals is not one,
 *     and the `<input>` that is labelable sits in a shadow root a document
 *     `for` cannot reach. The console had both forms — `<label
 *     for="restart-word">` on the wipe's field, `<label class="field-row">`
 *     wrapped round the card editor's two — and both would have gone dead on
 *     conversion with nothing anywhere to say so. `label` plus `hideLabel` is
 *     the replacement, and `main.ts` demotes the two dead `<label>`s to the
 *     elements they now are.
 *
 * `cds-select` is the same shape: the name comes from `labelText`, hidden with
 * `hideLabel`, and its options are `cds-select-item` children which it clones
 * into a real `<select>` in its shadow root. One event does not survive the
 * boundary: a native `change` is `composed: false`, so a `change` listener on
 * the host never fires. `input` is composed and does. `cds-text-input` re-
 * emits `change` as a composed event for exactly this reason and `cds-select`
 * does not, so {@link carbonSelect} names the event its callers have to use.
 *
 * `cds-tag` forwards nothing, because it is not interactive: it is a box with
 * a slot in it. Carbon's two interactive tags are not used here, and
 * `host.css` records why.
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

/* ====================================================================== */
/* Step 3: tags, fields, and the one picker                               */
/* ====================================================================== */

/** The other four tags. Named once each, here; `controls.test.ts` checks that. */
const CARBON_TAG_TAG = "cds-tag";
const CARBON_TEXT_INPUT_TAG = "cds-text-input";
const CARBON_SELECT_TAG = "cds-select";
const CARBON_SELECT_ITEM_TAG = "cds-select-item";

/**
 * Carbon's tag sizes, spelled the way `TAG_SIZE` spells them.
 *
 * 18px, 24px and 32px, declared as `--cds-layout-size-height-sm/-md/-lg` on
 * `:host(cds-tag)`. The console asks for `sm`.
 */
export const CARBON_TAG_SIZES = ["sm", "md", "lg"] as const;

export type CarbonTagSize = (typeof CARBON_TAG_SIZES)[number];

/**
 * Carbon's tag types, which are its ten colours.
 *
 * The console asks for `gray` — the default — and recolours it from the
 * product palette in `host.css`: a `gray` tag reads exactly
 * `--cds-tag-background-gray` and `--cds-tag-color-gray`, both inheritable.
 * The nine coloured types are listed because the union has to hold what
 * `TAG_TYPE` holds in both directions, which is the half that catches a type
 * Carbon has dropped across a version bump.
 */
export const CARBON_TAG_TYPES = [
  "red",
  "magenta",
  "purple",
  "blue",
  "cyan",
  "teal",
  "green",
  "gray",
  "cool-gray",
  "warm-gray",
] as const;

export type CarbonTagType = (typeof CARBON_TAG_TYPES)[number];

export interface CarbonTagOpts extends ElemOptions {
  readonly size: CarbonTagSize;
  readonly type: CarbonTagType;
}

/**
 * A Carbon tag: a static chip with its label in the default slot.
 *
 * Deliberately not `cds-selectable-tag` or `cds-operational-tag`, which are
 * Carbon's two interactive tags. Both render an inner `cds-tag` carrying
 * `role="button"` and a `tabindex`, so the element that takes focus is a
 * custom element standing in for a button — on a console whose own accounting
 * is "36 real buttons, zero divs with handlers" — and both bind the pressed
 * state as `?aria-pressed="${selected}"`, a *boolean* attribute binding, so an
 * unselected tag carries no `aria-pressed` at all and announces as a button
 * with no state. That is the failure this branch's third commit reverted the
 * two disclosures for, and it is why the runbook's In/Out chips stay
 * hand-built `<button aria-pressed>`s. `host.css` has it beside the rule.
 */
export function carbonTag(
  opts: CarbonTagOpts,
  children?: readonly Child[],
): HTMLElement {
  const { size, type, attrs, ...rest } = opts;
  return hx(
    CARBON_TAG_TAG,
    { ...rest, attrs: { ...attrs, size, type } },
    children,
  );
}

/**
 * Carbon's input sizes, spelled the way `INPUT_SIZE` spells them.
 *
 * `sm` is 32px, which is the height the console's `.field` has always been, so
 * the conversion costs no vertical space. Note there is no `2xl` here where
 * `BUTTON_SIZE` has one: the two scales are not the same scale, which is why
 * each union is held against its own enum rather than against "Carbon's
 * sizes".
 */
export const CARBON_INPUT_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;

export type CarbonInputSize = (typeof CARBON_INPUT_SIZES)[number];

/**
 * Carbon's input types, spelled the way `INPUT_TYPE` spells them.
 *
 * **There is no `number` here, and that is step 3's scope boundary.**
 * `cds-text-input` supports textual types only, and its template forwards no
 * `min`, `max` or `step` either. The console's fifteen arcade setup fields are
 * `type="number"` with a `min` and a `max` on every one, so putting them on
 * this component would silently drop both clamps and the arrow-key stepping
 * with them. Carbon's component for them is `cds-number-input` — a different
 * element, with two stepper buttons and a dependency on `@carbon/utilities`
 * that nothing else here pulls. Issue #28 step 3 names `cds-text-input` and
 * does not name that one, so the number fields stay hand-built and the issue
 * decides.
 *
 * Writing `inputType: "number"` is a compile error, which is the only form of
 * that paragraph a future edit cannot skip.
 */
export const CARBON_INPUT_TYPES = [
  "email",
  "password",
  "tel",
  "text",
  "url",
] as const;

export type CarbonInputType = (typeof CARBON_INPUT_TYPES)[number];

export interface CarbonTextInputOpts
  extends Omit<ElemOptions, "type" | "placeholder"> {
  readonly size: CarbonInputSize;
  readonly inputType: CarbonInputType;
  /**
   * The accessible name, and the only way a Carbon field has one.
   *
   * Required rather than optional. It lands on the shadow
   * `<label for="input">`, which is the single route to naming the `<input>`
   * that actually takes focus: an `aria-label` on the host is announced by
   * nothing, and a document `<label for>` cannot reach across the boundary. A
   * field with no name is not something this console renders, so the type says
   * so rather than a comment.
   */
  readonly label: string;
  /**
   * Draw Carbon's label, or leave the job to the console's own.
   *
   * `true` at every call site, decided once — see `host.css`. Carbon's label
   * is 12px above the box with 8px under it, a ~20px stacked header on a
   * surface whose fields have a 90px label column beside them.
   */
  readonly hideLabel: boolean;
  readonly placeholder?: string;
  /** `maxlength` on the inner input, through Carbon's `max-count`. */
  readonly maxCount?: number;
}

/**
 * A Carbon text field.
 *
 * Returns `HTMLElement`, like every factory here: callers set attributes and
 * read `value` off the host, which Carbon declares `reflect: true`, so the
 * attribute and the property are the same bit before and after the upgrade. A
 * caller that wants an `HTMLInputElement` wants the `<input>` in the shadow
 * root, which is not theirs to have.
 */
export function carbonTextInput(
  opts: CarbonTextInputOpts,
  children?: readonly Child[],
): HTMLElement {
  const {
    size,
    inputType,
    label,
    hideLabel,
    placeholder,
    maxCount,
    attrs,
    ...rest
  } = opts;
  return hx(
    CARBON_TEXT_INPUT_TAG,
    {
      ...rest,
      attrs: {
        ...attrs,
        size,
        type: inputType,
        label,
        ...(hideLabel ? { "hide-label": "" } : {}),
        ...(placeholder === undefined ? {} : { placeholder }),
        ...(maxCount === undefined ? {} : { "max-count": maxCount }),
      },
    },
    children,
  );
}

/**
 * A Carbon field's text, read and written.
 *
 * The property, not the attribute, and the pair exists for the same reason
 * `dom.ts` exports both halves of `setDisabled`: a caller that writes one way
 * and reads the other gets something plausible and wrong.
 *
 * `cds-text-input`'s getter returns the live `<input>`'s value once the shadow
 * root exists and its own `_value` before that, so reading it is always
 * current. The `value` *attribute* is not: Carbon declares the property
 * `reflect: true`, so the attribute trails the property by a Lit update, and
 * reading the attribute mid-keystroke returns the previous character.
 *
 * `?? ""` is not defensive. Before `customElements.define` has upgraded the
 * element there is no accessor at all and this reads `undefined`, which
 * `String()` would turn into the five-character word "undefined" — a card
 * titled `undefined`, or a confirmation field that compares a word nobody
 * typed. `main.ts` imports the component modules in its first statements and a
 * module's imports run before its body, so on this console the upgrade has
 * always happened; the fallback is for the day that stops being true, which is
 * the day it would otherwise be found in front of a room.
 */
export function fieldValue(el: HTMLElement): string {
  const v = (el as { value?: unknown }).value;
  return typeof v === "string" ? v : "";
}

export function setFieldValue(el: HTMLElement, value: string): void {
  (el as { value?: unknown }).value = value;
}

/**
 * Take the caret out of a Carbon field.
 *
 * Measured in Chrome 154, `host.blur()` alone is enough: `document.
 * activeElement` goes to the body and `shadowRoot.activeElement` goes to null
 * in the same call. The second blur is here for the reason `releaseFocus`
 * gives for carrying the same pair — `delegatesFocus` makes the host answer
 * for focus that is really on an element inside its shadow root, and whether
 * blurring the host unfocuses that element is a detail of how a browser
 * implements focus delegation rather than something the spec pins down. What
 * this line holds up is the card editor's Escape and Enter, which exist so
 * that a space at 14:00 starts the session instead of typing a space into a
 * card title, so the console does not find out per browser. Blurring something
 * already blurred is free.
 */
export function blurField(el: HTMLElement): void {
  el.blur();
  const inner = el.shadowRoot?.activeElement;
  if (inner instanceof HTMLElement) inner.blur();
}

/**
 * The event a {@link carbonSelect} reports a pick with.
 *
 * Carbon's own, `CDSSelect.eventSelect`, dispatched `bubbles` and `composed`
 * with the new value in `detail`. It is named here because the obvious
 * listener is wrong in a way nothing reports: a native `change` is
 * `composed: false`, so it stops at the shadow boundary and a `change`
 * listener on the host never fires at all — no error, no warning, and a picker
 * that still looks and behaves correctly until somebody tries to pick
 * something. `cds-text-input` re-emits `change` as a composed event for
 * exactly this reason; `cds-select` does not.
 */
export const CARBON_SELECT_EVENT = "cds-select-selected";

export interface CarbonSelectOpts extends ElemOptions {
  readonly size: CarbonInputSize;
  /** The accessible name. Same mechanism, and same reason, as a field's. */
  readonly labelText: string;
  readonly hideLabel: boolean;
}

/**
 * A Carbon select, wrapping a real `<select>`.
 *
 * The console's one picker is a native `<select>` on purpose — `main.ts` calls
 * it "the one widget on this page that is keyboard-operable everywhere without
 * this file having to reimplement one" — and that property survives the
 * conversion, because what Carbon renders into its shadow root is a `<select>`
 * with each {@link carbonSelectItem}'s option cloned into it. It watches its
 * own children with a `MutationObserver`, so options appended after the host
 * is built still arrive.
 *
 * Listen with {@link CARBON_SELECT_EVENT}.
 */
export function carbonSelect(
  opts: CarbonSelectOpts,
  children?: readonly Child[],
): HTMLElement {
  const { size, labelText, hideLabel, attrs, ...rest } = opts;
  return hx(
    CARBON_SELECT_TAG,
    {
      ...rest,
      attrs: {
        ...attrs,
        size,
        "label-text": labelText,
        ...(hideLabel ? { "hide-label": "" } : {}),
      },
    },
    children,
  );
}

export interface CarbonSelectItemOpts extends Omit<ElemOptions, "value"> {
  readonly value: string;
  readonly selected?: boolean;
}

/**
 * One option in a {@link carbonSelect}. Its label is its `text`.
 *
 * `text` and not Carbon's `label` attribute, deliberately. `cds-select` builds
 * each `<option>` with *both* — `label="${label}"` and `${textContent}` as
 * content — and a browser shows an `<option>`'s `label` attribute in
 * preference to its text when both are present. Passing the name as `text`
 * leaves the attribute empty, Carbon's `if_non_empty_default` drops it, and
 * the option reads as the card's name, which is what the hand-built
 * `<option>` did.
 */
export function carbonSelectItem(opts: CarbonSelectItemOpts): HTMLElement {
  const { value, selected, attrs, ...rest } = opts;
  return hx(CARBON_SELECT_ITEM_TAG, {
    ...rest,
    attrs: {
      ...attrs,
      value,
      ...(selected === true ? { selected: "" } : {}),
    },
  });
}
