/**
 * The one door onto Carbon's elements, and the things Carbon will not tell
 * you about.
 *
 * Thirteen tags come through here: `cds-button` (steps 1 and 2); `cds-tag`,
 * `cds-text-input`, `cds-select` with its `cds-select-item` and
 * `cds-number-input` (step 3); and the seven `cds-table*` elements the scoring
 * grid is built from (step 4). Every enumerated attribute is a union, so a
 * value Carbon does not have is a compile error at the line that writes it
 * rather than something a host finds in front of a room — see the
 * `danger--tertiary` story below, which is why this file exists at all, and
 * see {@link CARBON_NUMBER_INPUT_SIZES} for the same failure waiting in a
 * component that validates its `size` against nothing.
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
 * `cds-number-input` is the same shape again and loses the same event, which
 * is the thing to carry away from reading three of these templates: what a
 * component forwards is a property of how its own `render()` was written, and
 * inheriting from one that forwards something is not inheriting the
 * forwarding. `CDSNumberInput extends CDSTextInput` and still has no `@change`
 * binding, because it replaces the template that had one. See
 * {@link CARBON_NUMBER_INPUT_EVENT}.
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
 * **There is no `number` here, and it is still not a mistake.**
 * `cds-text-input` supports textual types only, and its template forwards no
 * `min`, `max` or `step` either, so putting a clamped number field on this
 * component would drop both clamps and the arrow-key stepping with them.
 * Carbon's component for one is {@link carbonNumberInput}, which is a
 * different element and is below.
 *
 * Writing `inputType: "number"` is a compile error, which is the only form of
 * that paragraph a future edit cannot skip. `controls.test.ts` holds the other
 * half: the day Carbon adds `number` to `INPUT_TYPE`, a test goes red and
 * whoever reads it finds out that the two components have converged.
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

/* ====================================================================== */
/* Step 3, finished: the arcade's twelve number fields                    */
/* ====================================================================== */

/**
 * The sixth tag. Named once, here; `controls.test.ts` checks that.
 *
 * `CDSNumberInput extends CDSTextInput`, so `label`, `hideLabel`, `disabled`,
 * `readonly`, `name`, `invalid` and `value` are the field properties already
 * documented at the top of this file, and everything that reading says about
 * naming a Carbon field applies here unchanged. What this component adds is
 * `min`, `max`, `step`, two stepper buttons and a `type` of its own that is
 * **not** `INPUT_TYPE`.
 *
 * It overrides `render()` completely, which is where every difference that
 * matters lives — including the three that are silent: no `@change` binding,
 * `role="alert"` on the `<input>`, and a `min-inline-size` and stepper gutter
 * that `hide-steppers` does not take off. Each is read, measured and answered
 * below. Read against
 * `@carbon/web-components@2.64.0/es/components/number-input/number-input.js`.
 */
const CARBON_NUMBER_INPUT_TAG = "cds-number-input";

/**
 * A number input's sizes — three, and **not** {@link CARBON_INPUT_SIZES}.
 *
 * This is the `danger--tertiary` failure waiting in a second place, and it is
 * why this union is written out rather than reusing the text field's.
 * `cds-number-input` declares `size` as a bare reflected string with no enum
 * behind it and no validation, and its stylesheet implements exactly three:
 *
 *   .cds--number--sm   input block-size 2rem,   controls 4rem, buttons 2rem
 *   (none)             input block-size 2.5rem, controls 5rem, buttons 2.5rem
 *   .cds--number--lg   input block-size 3rem,   controls 6rem, buttons 3rem
 *
 * `md` is the unmodified default and is the component's own `size` default.
 * There is no `.cds--number--xs` or `.cds--number--xl` anywhere in the sheet.
 * So `size: "xs"` — which `INPUT_SIZE` has, and which a reviewer reaching for
 * the field's union would get — writes `class="cds--number cds--number--xs"`,
 * matches nothing, and renders a 40px control where a 24px one was asked for.
 * No warning, no fallback, nothing in any log.
 *
 * `controls.test.ts` holds this union against the installed stylesheet in both
 * directions, which is the half that catches Carbon implementing a fourth size
 * or dropping one across a version bump. It is *not* held against an enum,
 * because there is none to hold it against: this component's `defs.js` exports
 * a validation-status enum and nothing else.
 */
export const CARBON_NUMBER_INPUT_SIZES = ["sm", "md", "lg"] as const;

export type CarbonNumberInputSize = (typeof CARBON_NUMBER_INPUT_SIZES)[number];

/**
 * A number input's two types, spelled the way `NUMBER_INPUT_TYPE` spells them.
 *
 * `number` is a native `<input type="number">`. `text` is a locale-formatted
 * text box, and it is the only thing `@carbon/utilities`' `NumberFormatter`
 * and `NumberParser` are read for — the dependency the vendoring table grew
 * two entries for is paid entirely by a branch the console does not take.
 *
 * The console asks for `number`, and the difference is not cosmetic: under
 * `text` the clamps stop being attributes on the inner input, because the
 * template writes `min`, `max` and `step` only in the `number` branch and the
 * empty string otherwise. `type: "text"` is the one value of this union that
 * silently takes the clamps back off the element that enforces them. Carbon
 * still range-checks a `text` value in `_getInputValidity`, which is a
 * validity flag and not a constraint on the element.
 */
export const CARBON_NUMBER_INPUT_TYPES = ["number", "text"] as const;

export type CarbonNumberInputType = (typeof CARBON_NUMBER_INPUT_TYPES)[number];

/**
 * The event a {@link carbonNumberInput} reports a change with, and the reason
 * it has to be named here at all.
 *
 * **`cds-number-input` does not re-emit `change`.** This is the trap
 * `cds-select` set in step 3, appearing in a component that inherits from one
 * which had already fixed it. `CDSTextInput` binds `@change` in its template
 * and re-dispatches a composed `change` for exactly this reason, with a
 * comment upstream saying so. `CDSNumberInput` replaces `render()` wholesale,
 * and its `<input>` binds `@input`, `@focus`, `@blur` and `@keydown` — **no
 * `@change`** — so the inherited `_handleChange` is never called. A native
 * `change` is `composed: false`, so it stops at the shadow boundary, and a
 * `change` listener on the host never fires at all.
 *
 * No error, no warning, and a field that looks and behaves correctly until
 * something downstream of that listener was supposed to have happened. On this
 * console it is the arcade's running order and its twelve timings being
 * written to `localStorage`, which is the thing that brings a console reloaded
 * at 2:45pm back with the order still set.
 *
 * This is the component's own, `CDSNumberInput.eventInput`, dispatched
 * `bubbles` and `composed` from `_handleInput` and from each stepper's click,
 * with `{ value, direction }` in `detail`. It fires per keystroke rather than
 * on commit, which is a real difference from `change` and not a detail: a
 * caller that was debouncing nothing now writes storage per character.
 */
export const CARBON_NUMBER_INPUT_EVENT = "cds-number-input";

export interface CarbonNumberInputOpts
  extends Omit<ElemOptions, "type" | "placeholder"> {
  readonly size: CarbonNumberInputSize;
  readonly inputType: CarbonNumberInputType;
  /**
   * The accessible name, and the only way a Carbon field has one.
   *
   * Required, for the reason {@link CarbonTextInputOpts}'s is: the name comes
   * from the shadow `<label for="input">` and from nothing else. This
   * component's template is the text field's in that one respect — a single
   * `<label class="${labelClasses}" for="input">` holding the `label` property
   * or the `label-text` slot, carrying `cds--visually-hidden` when
   * `hideLabel` — and it binds no `aria-label` onto the `<input>` either.
   */
  readonly label: string;
  /** Carbon's own label, or the console's. See `host.css`; `true` everywhere. */
  readonly hideLabel: boolean;
  /**
   * The clamps, as numbers, and required rather than optional.
   *
   * These are the whole reason this component is here instead of
   * {@link carbonTextInput}, so a call site that forgets one is a compile
   * error rather than a field that has quietly stopped being clamped.
   *
   * They reach the inner `<input type="number">`, which is the element that
   * enforces them:
   *
   *     min="${this.type === "number" ? if_non_empty_default(this.min) : ""}"
   *
   * Note the ternary, and see {@link CARBON_NUMBER_INPUT_TYPES}.
   *
   * What "enforce" means for a native number input is worth being exact about,
   * because it is less than the word suggests — and it is exactly what the
   * hand-built fields did, so none of it is a change. `min` and `max` clamp
   * the steppers and the arrow keys, and they set `validity.rangeOverflow` /
   * `rangeUnderflow` and `:out-of-range`. **They do not refuse a typed
   * value.** Measured on the hand-built field before the conversion: 999 typed
   * into the `min="5" max="60"` seconds-per-item field stays 999, and
   * `main.ts`'s own integer guard — finite, integer, greater than zero — is
   * what decides what goes on the wire, so 999 went. The conversion carries
   * the clamps onto the same kind of element and adds Carbon's visible invalid
   * state, which is the one thing here that is new.
   */
  readonly min: number;
  readonly max: number;
  /**
   * How far one arrow key or one stepper press moves the value.
   *
   * Optional, because Carbon's default is `"1"` and so is the native default
   * for `<input type="number">`: leaving it out is what the hand-built fields
   * had, none of which carried a `step`. Passing it writes it onto the inner
   * input in the `number` branch beside the clamps.
   */
  readonly step?: number;
  /**
   * Draw Carbon's two stepper buttons, or not.
   *
   * Required, and a boolean rather than an absence, because it is a decision
   * about this panel and not a per-field preference — the same shape as
   * `hideLabel`, and `host.css` argues it with the measurements.
   *
   * `true` writes `hide-steppers`, which puts `.cds--number--nosteppers` on
   * the wrapper, leaves `.cds--number__controls` out of the template, and
   * drops the inner input's `padding-inline-end` from 5rem to 0.
   */
  readonly hideSteppers: boolean;
}

/**
 * The two values Carbon's stylesheet puts on a number input's box that
 * `hide-steppers` is supposed to take off and does not, spelled the way the
 * sheet spells them.
 *
 * Named here so `controls.test.ts` can hold them against the installed sheet.
 * The repair below is an argument about two declarations and a selector
 * specificity, and the day Carbon changes any of the three the argument has to
 * be re-read rather than silently kept.
 */
export const CARBON_NUMBER_INPUT_FLOOR = "9.375rem";
export const CARBON_NUMBER_INPUT_SM_GUTTER = "5rem";

/**
 * `hide-steppers`, made to mean what it says.
 *
 * This is the one place in this migration that styles the inside of a Carbon
 * component, and the reason it is not the beginning of a habit is that it adds
 * no value of Carbon's own: both declarations below are Carbon's own
 * `.cds--number--nosteppers` values, re-asserted where Carbon's cascade drops
 * them. Nothing here is a disagreement with the design system.
 *
 * ---- what `hide-steppers` does, and the two things it misses ----------
 *
 * Setting it takes `.cds--number__controls` out of the template entirely — the
 * buttons are not rendered, which is the part that works — and puts
 * `.cds--number--nosteppers` on the wrapper. The compiled sheet then has two
 * problems, both measured on the running console.
 *
 * **1. The gutter survives at every size but `md`.** The base declaration on
 * the inner `<input>` is `padding-inline: 1rem 6rem`, and each size restates
 * the second half:
 *
 *     .cds--number--sm.cds--number input[type=number]  { padding-inline-end: 5rem }   (0,2,1)
 *     .cds--number--lg.cds--number input[type=number]  { padding-inline-end: 7rem }   (0,2,1)
 *     .cds--number--nosteppers    input[type=number]   { padding-inline-end: 0 }      (0,1,1)
 *
 * The repair is a class short of the thing it has to beat. At `md` there is no
 * size class, so `--nosteppers` ties with the base rule and wins on order; at
 * `sm` and `lg` it loses on specificity. Measured, by moving `size` on a live
 * field and reading the computed padding back:
 *
 *     sm + hide-steppers      16px / 80px     the gutter, with nothing in it
 *     md + hide-steppers      16px /  0px     what the attribute promises
 *     lg + hide-steppers      16px / 112px    the gutter, with nothing in it
 *     sm + steppers           16px / 80px     identical to sm + hide-steppers
 *     md + steppers           16px / 96px
 *
 * `sm + hide-steppers` and `sm + steppers` being the same two numbers is the
 * whole finding. And padding is inside a `box-sizing: border-box` box, so it
 * cannot be crushed: 16 + 80 is a hard 96px floor on the box, which is what a
 * 47px cell measured when the floor below had already been lifted.
 *
 * **2. The floor is sized for the gutter and `--nosteppers` never mentions
 * it.** The base declaration also carries `min-inline-size: 9.375rem` — 150px,
 * which at `sm` is 16px of lead-in, 80px of steppers and 54px of digits — and
 * there is exactly one `min-inline-size` in the component's entire stylesheet,
 * in that declaration. So a field drawing no steppers keeps a floor that
 * exists to hold them.
 *
 * ---- what the two cost, before the repair ----------------------------
 *
 * At 1280×800 with the twelve converted:
 *
 *                                        host    inner box   spill
 *   a `.field-row` field, any width       112         150       38
 *   an `.a-cfg-cell`, tray at 248         151         150        0
 *   an `.a-cfg-cell`, tray at 560          47         150      103
 *
 * and at the splitter's far end — the tray dragged to its 560px maximum, which
 * is the setup panel's narrowest at 414px — six of the panel's rows overflowed
 * by 85 to 113px, against 5px on `main`. Three 150px fields and two 8px gaps
 * is 466px of demand in a 157px row.
 *
 * ---- and why it has to be an adopted sheet ---------------------------
 *
 * Measured both ways on the running page. A *document* rule carrying
 * `!important` and naming both `cds-number-input input` and
 * `cds-number-input .cds--number input[type=number]` moves the computed
 * `min-inline-size` not at all: it stays 150px, because a document rule does
 * not match inside a shadow tree. The same declaration in a sheet adopted into
 * the shadow root takes it to 0px. There is no `::part` on this component and
 * neither value is a custom property, so the adopted sheet is the only door —
 * which is a different answer from `cds-tag`, whose box is the host and whose
 * radius a document rule *does* reach, and `host.css` records that one.
 *
 * The alternative that is not on the list is leaving the overflow in: three
 * fields painting over each other and over the splitter, at a tray width the
 * host can drag to. The one that is on the list and was rejected is a field
 * 38px wider than the 7rem `host.css` chose on purpose — and 150px does not
 * fit beside its 8.5em label column in a 157px row either, so it buys an
 * overflow rather than removing one.
 *
 * Scoped as tightly as the argument: adopted only when `hideSteppers` is true,
 * because with the steppers drawn neither value is vestigial. The selector is
 * built from the `size` in hand rather than written for all three, so the rule
 * names the class it has to beat and nothing else. `controls.test.ts` holds
 * {@link CARBON_NUMBER_INPUT_FLOOR} and
 * {@link CARBON_NUMBER_INPUT_SM_GUTTER} against the installed stylesheet and
 * checks that `--nosteppers` is still written at the specificity that loses —
 * so a Carbon release that fixes either upstream turns a test red rather than
 * leaving a dead rule behind.
 */
const noStepperSheets = new Map<CarbonNumberInputSize, CSSStyleSheet>();

function noStepperSheet(size: CarbonNumberInputSize): CSSStyleSheet {
  const cached = noStepperSheets.get(size);
  if (cached !== undefined) return cached;
  // `md` has no modifier class, so there is none to name and none to beat;
  // the two classes below already out-specify the base declaration.
  const sized = size === "md" ? "" : `.cds--number--${size}`;
  const at = `.cds--number--nosteppers${sized}.cds--number`;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    // Carbon's own `--nosteppers` values, at a specificity that reaches the
    // element. Both `type`s, because the component's declarations name both
    // and a future `inputType: "text"` must not quietly keep the gutter.
    `${at} input[type="number"], ${at} input[type="text"] {` +
      " min-inline-size: 0; padding-inline-end: 0; }" +
      // And the invalid variant, which Carbon also restates per size: an
      // out-of-range value needs room for the warning glyph, and 3rem is the
      // figure `--nosteppers` asks for. Without this line a field that goes
      // invalid takes the 7rem `sm` gutter back and spills again — at the one
      // moment the host is being told something.
      `${at} input[type="number"][data-invalid], ${at} input[type="text"][data-invalid],` +
      `${at} .cds--number__input-wrapper--warning input[type="number"],` +
      `${at} .cds--number__input-wrapper--warning input[type="text"] {` +
      " padding-inline-end: 3rem; }",
  );
  noStepperSheets.set(size, sheet);
  return sheet;
}

/**
 * And the second repair, which is not about width at all: a number field is a
 * field again.
 *
 * `cds-number-input`'s template writes, on the `<input>` it renders:
 *
 *     role="alert"
 *     aria-atomic="true"
 *
 * `cds-text-input`'s writes neither, and nothing on the host asks for them:
 * they are literals in the template, so every one of these fields has them.
 * `role="alert"` is a live-region role with no form semantics, and an explicit
 * role replaces an element's implicit one — so the element a host types a
 * number into stops being a number field and becomes an assertive
 * announcement, whose contents `aria-atomic` says to read in full every time
 * they change.
 *
 * Measured, because the reasoning above is spec-reading and this console's
 * accessibility is not something a migration gets to spend on an argument.
 * Three inputs in the light DOM of the running page, each with a `<label
 * for>`, differing only in these two attributes, read back out of Chrome's
 * accessibility tree:
 *
 *   <input type="number">                           textbox "plain probe" (number)
 *   <input type="number" role="alert" aria-atomic>  alert   "alert probe" (number)
 *   <input type="text">                             textbox "text probe"  (text)
 *
 * and then, with the two attributes removed from the middle one and the tree
 * re-read: `textbox "alert probe" (number)`. The name survives either way —
 * that is the `<label for="input">` `hide-label` keeps, and it is why the
 * naming decision from step 3 needed no revisiting — but the role does not.
 *
 * So the two attributes come off. This is a removal and not an addition: what
 * is left is the element's own semantics, which is what the hand-built
 * `<input type="number">` had and what the accessibility tree reported for all
 * twelve on `main`. Nothing here asserts anything about the field that the
 * field does not already say about itself.
 *
 * They come off once and stay off. Both are static attributes in a Lit
 * template, so they are cloned into the shadow root at first render and no
 * later update touches them — verified by typing into a field, which
 * re-renders it, and re-reading: still absent.
 *
 * `controls.test.ts` holds the attributes against the installed template in
 * both directions, so a Carbon release that stops writing them turns a test
 * red rather than leaving a removal that removes nothing.
 */
function unmakeLiveRegion(input: HTMLElement): void {
  input.removeAttribute("role");
  input.removeAttribute("aria-atomic");
}

function prepareNumberInput(
  el: HTMLElement,
  size: CarbonNumberInputSize,
  hideSteppers: boolean,
): void {
  // One sheet per size, shared by every field that asks for it. A
  // `CSSStyleSheet` adopted into many roots is the API's own intent, and is
  // why this is not twelve stylesheets.
  const sheet = hideSteppers ? noStepperSheet(size) : null;
  const prepare = (): boolean => {
    const root = el.shadowRoot;
    if (root === null) return false;
    const input = root.querySelector("input");
    if (input !== null) unmakeLiveRegion(input);
    if (sheet !== null && !root.adoptedStyleSheets.includes(sheet)) {
      // Appended, so it is last and wins every tie with the component's own.
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
    return input !== null;
  };
  // Lit builds its render root in `connectedCallback`, so a field that has
  // only just been created has no `shadowRoot` yet — and a skipped round's
  // settings block is not in the document at all until the host puts the round
  // back into the order, so "created" and "connected" can be minutes apart.
  // `updateComplete` resolves after the first update, which is the first
  // connection, so the two branches between them cover both.
  if (!prepare()) {
    void (el as { updateComplete?: Promise<unknown> }).updateComplete?.then(
      prepare,
    );
  }
}

/**
 * A Carbon number field, with its clamps on the element that enforces them.
 *
 * Returns `HTMLElement`, like every factory here, and {@link fieldValue} /
 * {@link setFieldValue} read and write it unchanged: `CDSNumberInput`
 * overrides the `value` getter to `return super.value`, which is the live
 * `<input>`'s value once the shadow root exists and `_value` before that.
 *
 * Listen with {@link CARBON_NUMBER_INPUT_EVENT} and not with `change`.
 */
export function carbonNumberInput(
  opts: CarbonNumberInputOpts,
  children?: readonly Child[],
): HTMLElement {
  const {
    size,
    inputType,
    label,
    hideLabel,
    min,
    max,
    step,
    hideSteppers,
    attrs,
    ...rest
  } = opts;
  const el = hx(
    CARBON_NUMBER_INPUT_TAG,
    {
      ...rest,
      attrs: {
        ...attrs,
        size,
        type: inputType,
        label,
        min,
        max,
        ...(step === undefined ? {} : { step }),
        ...(hideLabel ? { "hide-label": "" } : {}),
        ...(hideSteppers ? { "hide-steppers": "" } : {}),
      },
    },
    children,
  );
  prepareNumberInput(el, size, hideSteppers);
  return el;
}

/* ====================================================================== */
/* Step 4: the scoring grid                                               */
/* ====================================================================== */

/**
 * The seven table tags. Named once each, here; `controls.test.ts` checks that.
 *
 * What these elements are, read against
 * `@carbon/web-components@2.64.0/es/components/data-table/`, because it is not
 * what the name suggests. None of them renders a `<table>`. Each is a light-DOM
 * host given a CSS table `display` by its *parent's* shadow sheet —
 * `::slotted(cds-table-body){display:table-row-group}`,
 * `::slotted(cds-table-cell){display:table-cell}` — and an ARIA role in its
 * own `connectedCallback`: `table`, `rowgroup`, `row`, `columnheader`, `cell`.
 * A cell's template is a bare `<slot>`, so everything the console puts in a
 * cell stays in the light DOM: the raw `<input>`, its points, its clear button
 * and its refusal bubble are the console's own elements, styled by `host.css`
 * and found by `querySelector` exactly as before.
 *
 * `cds-table` itself is the one that renders structure, and it is two
 * wrapper boxes deep — see {@link CARBON_TABLE_WRAPPER_PARTS}.
 */
const CARBON_TABLE_TAG = "cds-table";
const CARBON_TABLE_HEAD_TAG = "cds-table-head";
const CARBON_TABLE_HEADER_ROW_TAG = "cds-table-header-row";
const CARBON_TABLE_HEADER_CELL_TAG = "cds-table-header-cell";
const CARBON_TABLE_BODY_TAG = "cds-table-body";
const CARBON_TABLE_ROW_TAG = "cds-table-row";
const CARBON_TABLE_CELL_TAG = "cds-table-cell";

/**
 * Carbon's table sizes, spelled the way `TABLE_SIZE` spells them.
 *
 * Row heights of 24, 32, 40, 48 and 64px, as `block-size` on
 * `::slotted(cds-table-row[size=…])`. The console asks for `xs`, and its own
 * 22px field plus a pixel of padding either side and a hairline is what
 * actually sets the row: 25px, the height the hand-built grid has always been.
 */
export const CARBON_TABLE_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;

export type CarbonTableSize = (typeof CARBON_TABLE_SIZES)[number];

/**
 * The two wrapper boxes in `cds-table`'s shadow tree, which `host.css` takes
 * out of the box tree.
 *
 * `cds-table` renders its slot two boxes deep:
 *
 *     <div part="inner-container" class="cds--data-table_inner-container">
 *       <div part="content" class="cds--data-table-content">
 *         <slot>
 *
 * The inner box is `overflow-x: auto`; the content box is `display: table`
 * with no role. Left alone, the first takes the sticky header — it becomes
 * the header's scroll container, and it never scrolls — and the second puts a `LayoutTable` node between the grid's
 * `table` and its rows. `host.css` sets `display: contents` on both, argued
 * there with the measurements.
 *
 * Neither box is reachable from a document selector, but both are parts. They
 * are named here so `controls.test.ts` can hold them against the installed
 * template: the day Carbon renames a part, the rule in `host.css` stops
 * matching anything, and a test going red is the only way that is not found
 * by a header scrolling away mid-session.
 */
export const CARBON_TABLE_WRAPPER_PARTS = [
  "inner-container",
  "content",
] as const;

export interface CarbonTableOpts extends ElemOptions {
  readonly size: CarbonTableSize;
}

export interface CarbonTableRowOpts extends ElemOptions {
  /**
   * Required on every row, and not inherited from the table.
   *
   * `cds-table` stamps its `size` onto its rows in `updated()`, and only when
   * its own `size` changes — `querySelectorAll(selectorAllRows)` at that
   * moment, and never again. The grid's rows arrive afterwards, one per person
   * as they join, so a row that relied on the table would carry no `size` at
   * all and get none of the `[size=xs]` rules. Each row says it itself.
   */
  readonly size: CarbonTableSize;
}

/**
 * A Carbon table. Its children are one {@link carbonTableHead} and one
 * {@link carbonTableBody}.
 *
 * **The header row has to be in it before it is connected.** `cds-table`'s
 * `firstUpdated` caches `querySelector("cds-table-header-row,cds-table-row")`,
 * and its `updated()` and its body-change handler both dereference that cache
 * without a null check — a table connected with no rows throws on its first
 * update and again on every row that arrives. The scoring grid builds its
 * header row up front and refills its cells in place, so the row the table
 * cached is the row it keeps.
 *
 * A third thing it does on every body change, recorded so nobody goes
 * looking: `updateExpandable()` runs `headerCount += expandable ? 1 : -1`, so
 * with no expandable rows the count falls by one per row that arrives — -15
 * after a fifteen-person session. It is read only to set `colspan` on
 * expanded rows, which this grid has none of, so it is wrong and harmless.
 */
export function carbonTable(
  opts: CarbonTableOpts,
  children?: readonly Child[],
): HTMLElement {
  const { size, attrs, ...rest } = opts;
  return hx(CARBON_TABLE_TAG, { ...rest, attrs: { ...attrs, size } }, children);
}

export function carbonTableHead(
  opts: ElemOptions,
  children?: readonly Child[],
): HTMLElement {
  return hx(CARBON_TABLE_HEAD_TAG, opts, children);
}

export function carbonTableHeaderRow(
  opts: CarbonTableRowOpts,
  children?: readonly Child[],
): HTMLElement {
  const { size, attrs, ...rest } = opts;
  return hx(
    CARBON_TABLE_HEADER_ROW_TAG,
    { ...rest, attrs: { ...attrs, size } },
    children,
  );
}

/**
 * A column header. Never sortable here: `is-sortable` turns the cell's label
 * into a `<button part="sort-button">`, which would put a focusable element in
 * a header the grid's tab order is built to skip.
 */
export function carbonTableHeaderCell(
  opts: ElemOptions,
  children?: readonly Child[],
): HTMLElement {
  return hx(CARBON_TABLE_HEADER_CELL_TAG, opts, children);
}

export function carbonTableBody(
  opts: ElemOptions,
  children?: readonly Child[],
): HTMLElement {
  return hx(CARBON_TABLE_BODY_TAG, opts, children);
}

export function carbonTableRow(
  opts: CarbonTableRowOpts,
  children?: readonly Child[],
): HTMLElement {
  const { size, attrs, ...rest } = opts;
  return hx(
    CARBON_TABLE_ROW_TAG,
    { ...rest, attrs: { ...attrs, size } },
    children,
  );
}

export function carbonTableCell(
  opts: ElemOptions,
  children?: readonly Child[],
): HTMLElement {
  return hx(CARBON_TABLE_CELL_TAG, opts, children);
}

/* ====================================================================== */
/* The UI Shell: header, side nav, header panel                           */
/* ====================================================================== */

/**
 * Carbon's UI Shell, which the console has been laid out in since the
 * three columns moved onto it: a 48px `cds-header` across the top, a 256px
 * `cds-side-nav` on the left and a 256px `cds-header-panel` on the right,
 * with the console's centre panel in the space between.
 *
 * Read against `@carbon/web-components@2.64.0/es/components/ui-shell/`, all
 * four are containers: each renders a `<slot>` (`cds-header-name` wraps its
 * slot in an `<a>`) and carries its own geometry on `:host` or on a shadow
 * box. So the console's runbook buttons, roster, preview and controls stay
 * the console's own light-DOM elements inside them, with every keyboard
 * path and `aria-*` they had. What Carbon takes over is position and size:
 *
 *   cds-header         fixed, top, full width, 3rem tall, role="banner"
 *   cds-side-nav       its shadow box is fixed at top 3rem, bottom 0, left 0,
 *                      16rem wide when expanded; role="navigation"
 *   cds-header-panel   fixed at top 3rem, bottom 0, right 0; 16rem wide and
 *                      `overflow-y: auto` only when `expanded`, 0 otherwise
 *
 * Two of those are traps the factories close, both silent if missed:
 *
 *   - `cds-side-nav` defaults to `collapse-mode="responsive"`, which collapses
 *     it to an overlay that opens on hover. The console's runbook is not a
 *     menu to be summoned, so the factory always writes `fixed` and
 *     `expanded` — without `expanded` a fixed side nav is drawn at 0 width.
 *   - `cds-header-panel` is 0px wide until `expanded`. The factory writes it,
 *     because a tray that is present and invisible is the worst of both.
 *
 * Below 66rem (1056px) Carbon's stylesheet takes the side nav to 0 width. The
 * console's floor is 1280×800, so that breakpoint is never met on a host
 * laptop; it is recorded so nobody is surprised on a narrower window.
 */
const CARBON_HEADER_TAG = "cds-header";
const CARBON_HEADER_NAME_TAG = "cds-header-name";
const CARBON_SIDE_NAV_TAG = "cds-side-nav";
const CARBON_HEADER_PANEL_TAG = "cds-header-panel";

export interface CarbonLandmarkOpts extends ElemOptions {
  /**
   * The landmark's accessible name. Required: there are three landmarks on
   * the page and a reader lists them by name. Set on the host, which is the
   * element that carries the role, so — unlike a button's — it is read.
   */
  readonly label: string;
}

export function carbonHeader(
  opts: CarbonLandmarkOpts,
  children?: readonly Child[],
): HTMLElement {
  const { label, attrs, ...rest } = opts;
  return hx(
    CARBON_HEADER_TAG,
    { ...rest, attrs: { ...attrs, "aria-label": label } },
    children,
  );
}

/**
 * The header's product name. Carbon renders it as an `<a>`; with no `href`
 * it is an anchor without a destination, which is not focusable and reads as
 * text, and that is what the session title is.
 */
export function carbonHeaderName(
  opts: ElemOptions,
  children?: readonly Child[],
): HTMLElement {
  return hx(CARBON_HEADER_NAME_TAG, opts, children);
}

export function carbonSideNav(
  opts: CarbonLandmarkOpts,
  children?: readonly Child[],
): HTMLElement {
  const { label, attrs, ...rest } = opts;
  return hx(
    CARBON_SIDE_NAV_TAG,
    {
      ...rest,
      attrs: {
        ...attrs,
        "aria-label": label,
        "collapse-mode": "fixed",
        expanded: "",
      },
    },
    children,
  );
}

export function carbonHeaderPanel(
  opts: CarbonLandmarkOpts,
  children?: readonly Child[],
): HTMLElement {
  const { label, attrs, ...rest } = opts;
  return hx(
    CARBON_HEADER_PANEL_TAG,
    {
      ...rest,
      attrs: {
        ...attrs,
        role: "complementary",
        "aria-label": label,
        expanded: "",
      },
    },
    children,
  );
}
