/**
 * Console buttons, with the two rules DESIGN.md puts on them.
 *
 * - Destructive or irreversible actions are two-step, and the confirm is
 *   *inline*: the button becomes "Hide it from the room? [Yes] [No]". Never a
 *   modal — a modal that steals focus during a live question is how a host
 *   presses the wrong thing.
 * - The confirm asks about the thing that is about to happen, so it is allowed
 *   to be a function of the current state: one button whose action flips with
 *   the state must not ask the same question either way.
 * - Refusals are inline, in the button, for three seconds: "can't reveal —
 *   question still open", then back to normal. The host is looking at the
 *   button they pressed, not at a notification area.
 */

import { h, isDisabled, replace } from "../shared/dom.ts";
import { carbonButton, type CarbonKind } from "./carbon.ts";

/**
 * The armed controls are Carbon buttons. Issue #28 steps 1 and 2.
 *
 * One factory, and the class the wrapper already carried decides everything
 * Carbon needs to know: which `kind`, which `size`, and whether the control is
 * one of the two that Carbon cannot build at all.
 *
 *   `.ctl-primary`  `kind="primary"`, `size="lg"` — 48px, Carbon's own default
 *                   size, against everything else's 32px. See `host.css`.
 *   `.ctl-danger`   `kind="danger-tertiary"`.
 *   `.ctl-row`      not Carbon. A 22px roster row, 11px mono — see below.
 *   anything else   `kind="tertiary"`, `size="sm"` — 32px, fixed: Carbon pins
 *                   a button's min and max block size to the same token per
 *                   size, which is the property the hand-built button spent a
 *                   `min-height: 31px` and a `white-space: nowrap` buying.
 *
 * The "on" state is the fifth: `kind="primary"` as well, because a filled
 * button is how Carbon says a thing is on and a tertiary cannot be filled from
 * outside — Carbon paints a tertiary's border and its label from one token, so
 * a fill drawn on the host leaves the label the colour of the fill. `host.css`
 * recolours the primary to the console's gold for it. {@link Control.setOn} is
 * what moves it, because a class toggled on the wrapper is not something this
 * file can see.
 *
 * The kinds are {@link CarbonKind} values and every Carbon button on the
 * console is built by {@link carbonButton}, so a kind Carbon does not have is
 * a compile error rather than a bare unstyled `<button>` in front of a room.
 * `carbon.ts` has the whole of why that matters; the short version is that
 * step 1 shipped `danger--tertiary` — the CSS class's spelling, not the
 * attribute's — and Carbon said nothing in any log on either side.
 */

/** Carbon's kinds, spelled the way `BUTTON_KIND` spells them. */
export const KIND_DEFAULT: CarbonKind = "tertiary";
export const KIND_DANGER: CarbonKind = "danger-tertiary";
export const KIND_PRIMARY: CarbonKind = "primary";

/**
 * The micro-buttons the migration stops at, and the measurement that decided
 * it rather than a preference.
 *
 * `free` and `kick` live in an opened roster row: 22px tall, 11px mono, two of
 * them side by side in a column that holds sixty people without scrolling.
 * Carbon reaches 22px — `--cds-layout-size-height-xs` is declared on
 * `:host(cds-button)` and a document rule on a host beats a `:host` rule, so
 * `cds-button { --cds-layout-size-height-xs: 22px }` lands, measured. It is
 * still the wrong trade: `xs` is 24px on Carbon's scale and 11px is off
 * `body-compact-01` as well, so two tokens come off the system at once, and
 * the gutter is the third. Even at Carbon's condensed density a button
 * reserves 46px of chrome around its label, so `kick` goes from 35px wide to
 * roughly 65px — in a 22px row, in a two-column roster. #28 called this where
 * the system starts fighting and the number agrees.
 *
 * So `.ctl-row` builds a real `<button class="ctl-button">` and `host.css`
 * still has the rules that draw it. It is the one branch in this file and it
 * is a class test, like the kind is.
 */
const PLAIN_CLASS = "ctl-row";

/**
 * The console's own buttons, as a tag test.
 *
 * `releaseFocus` and `spaceVerdict` both used to ask `tagName === "BUTTON"`,
 * and a Carbon button is never that. The element that takes focus is the
 * `<cds-button>` host — its shadow root is opened with `delegatesFocus: true`,
 * so `document.activeElement` and a document-level listener's `event.target`
 * are both retargeted to the host, and neither ever sees the `<button>` inside.
 *
 * What a wrong answer here actually costs, measured rather than assumed,
 * because the two callers are not the same:
 *
 *   `spaceVerdict` would return "fire" instead of "handBackAndFire". Both
 *   verdicts end in `preventDefault()` and a click on the primary, so the
 *   console does not *visibly* misbehave today — the difference is only the
 *   blur. That is exactly why `controls.test.ts` asserts the verdict rather
 *   than an outcome: the verdict is the stated safety property, and the day a
 *   verdict grows a third consequence is the day asserting the outcome would
 *   have been asserting nothing. Mutating this line back to `"BUTTON"` turns
 *   that test red and changes nothing you can see in a browser.
 *
 *   `releaseFocus` would decline to blur a focused Carbon host. That branch is
 *   belt to `bindSpace`'s braces for now, because `control()` re-renders its
 *   button on every fire and the focused element is destroyed anyway. It is
 *   written for `handsBackSpace`, whose buttons do not re-render and which
 *   issue #28 step 2 points at the other 21 sites.
 */
function isButtonTag(tagName: string): boolean {
  return tagName === "BUTTON" || tagName === "CDS-BUTTON";
}

/**
 * A field, as a tag test, and the most expensive thing on this branch so far.
 *
 * `spaceVerdict` has always excused text fields by tag name — `INPUT`,
 * `TEXTAREA`, `SELECT` — because a field owns every key that lands in it, and
 * that is what makes "type the word to arm the wipe" a guard the space bar
 * cannot help with.
 *
 * A Carbon field is none of those three. `<cds-text-input>` renders its
 * `<input>` into a shadow root, so a keydown dispatched on that `<input>` is
 * retargeted on its way out: a document-level listener's `event.target` is the
 * **host**, whose `tagName` is `CDS-TEXT-INPUT`. It is not a field tag and not
 * a button tag, so without this line the verdict falls all the way through to
 * `"fire"` — and the space bar a host pressed while typing a holding card's
 * title would `preventDefault()` the space and press the primary button
 * instead. On the lobby panel that is "Open the lobby"; mid-session it is
 * whatever the run of show does next, in front of the room, with a card title
 * that is missing a word.
 *
 * The console's own fields are safe because a native `<input>` *is* the event
 * target. #28 step 3 converted three of them and then the arcade's twelve, and
 * step 4 converts the scoring grid's hundred and thirty-five, so this is the
 * line that has to be right before that step rather than after it.
 *
 * `CDS-SELECT` is here for the same retargeting and a smaller consequence: a
 * space on a focused native `<select>` opens the list, and the console must not
 * take that key either.
 *
 * `CDS-NUMBER-INPUT` is the arcade's twelve setup fields, and it is a *third*
 * tag rather than a case the first two already covered — which is the whole
 * reason this is a list of tag names and not a check for a hyphen. A Carbon
 * number field retargets identically: `delegatesFocus: true`, the `<input>` in
 * a shadow root, `event.target` on a document listener is the host. Measured
 * with the tag removed and the client rebuilt, below.
 *
 * Twelve number fields is twelve places a host types a two-digit number into a
 * panel headed by the button that starts the round, and a space that pressed
 * the primary instead of landing in the field would announce the round the
 * host was still setting up.
 */
function isFieldTag(tagName: string): boolean {
  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    tagName === "CDS-TEXT-INPUT" ||
    tagName === "CDS-SELECT" ||
    tagName === "CDS-NUMBER-INPUT"
  );
}

export interface Control {
  readonly el: HTMLElement;
  /** Show a refusal in place of the label for three seconds. */
  flash(message: string, kind?: "error" | "ok"): void;
  setLabel(label: string): void;
  setDisabled(disabled: boolean): void;
  /**
   * Say whether the state this control names is on.
   *
   * Carries the `.on` class, which is what `host.css` has always keyed the
   * gold fill off, *and* re-renders — because "on" is now a different Carbon
   * `kind` and not only a different colour. A caller that toggles the class by
   * hand gets the class and not the kind, which is why this exists at all.
   */
  setOn(on: boolean): void;
  /** Drop out of a half-pressed confirm, e.g. when the state changed under it. */
  disarm(): void;
}

interface Opts {
  label: string;
  className?: string;
  /**
   * Two-step when present. The question replaces the label while armed, and
   * it says what pressing Yes will do — not "Really?".
   */
  question?: string | (() => string);
  title?: string;
  onFire: (control: Control) => void;
}

const FLASH_MS = 3_000;
const ARM_TIMEOUT_MS = 6_000;

/**
 * Hand the space bar back.
 *
 * A button keeps focus after it is clicked, and a focused button owns space.
 * So the host clicks Lock joining, or a round pill, or a roster action, then
 * presses space mid-sentence to advance — and nothing visible happens, because
 * space re-pressed the button they clicked last. They have to look down, which
 * is the one thing this console exists to avoid.
 *
 * Every control blurs itself the moment it has fired, so space always means
 * "next". The deliberate exception is the inline confirm, which focuses its
 * Yes on purpose and is left alone here and in {@link bindSpace}.
 */
export function releaseFocus(within?: HTMLElement): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (!isButtonTag(active.tagName)) return;
  if (isConfirmButton(active)) return;
  // `within.contains()` is asked about the host and not about what is focused
  // inside it, which is the only form that works for both: a shadow root's
  // contents are not `contains`ed by anything in the document.
  if (within !== undefined && !within.contains(active)) return;
  active.blur();
  // And again, inside. `delegatesFocus` makes the host answer for the focus
  // that is really on the `<button>` in its shadow root, and whether
  // `host.blur()` alone unfocuses that button is a detail of how a browser
  // implements focus delegation rather than something the spec pins down. The
  // console cannot afford to find out per browser, and blurring an element
  // that is already blurred is free.
  const inner = active.shadowRoot?.activeElement;
  if (inner instanceof HTMLElement) inner.blur();
}

/**
 * The same promise for a plain button — the rail, the round pills — which is
 * not a {@link Control} and so does not re-render itself on the way out.
 */
export function handsBackSpace<T extends HTMLElement>(button: T): T {
  button.addEventListener("click", () => releaseFocus(button));
  return button;
}

function isConfirmButton(el: HTMLElement): boolean {
  return classesOwnSpace(classesOf(el));
}

/**
 * An element's classes as a plain array.
 *
 * `className` rather than `classList`: the client is compiled against a lib
 * whose `DOMTokenList` is not iterable, and a string split is the one form
 * that reads the same in the browser and in a test that has no DOM at all.
 */
function classesOf(el: HTMLElement): string[] {
  return String(el.className ?? "").split(/\s+/).filter((c) => c !== "");
}

/**
 * The only two classes the space bar hands itself over to.
 *
 * Written as a list rather than as a check on a DOM node so it can be stated
 * once and tested once. It is a short list on purpose, and every button on
 * this console that is *not* on it is a button space will blur rather than
 * press — see {@link spaceVerdict}. That is what keeps the wipe off the space
 * bar: its arm button, its field and its fire button are ordinary widgets, and
 * ordinary widgets do not get the key.
 */
function classesOwnSpace(classes: readonly string[]): boolean {
  return classes.includes("ctl-yes") || classes.includes("ctl-no");
}

/** What the space bar does about one keydown, decided before anything moves. */
export type SpaceVerdict =
  /** Not ours. The browser keeps it — a text field, or a half-pressed confirm. */
  | "ignore"
  /** A button is holding the key hostage: blur it, then advance the show. */
  | "handBackAndFire"
  /** Advance the show. */
  | "fire";

/** The parts of a keydown this decision looks at, and nothing else. */
export interface SpaceKey {
  readonly key: string;
  readonly code: string;
  readonly repeat: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly target: {
    readonly tagName: string;
    readonly isContentEditable: boolean;
    readonly classes: readonly string[];
  } | null;
}

/**
 * Whether this keydown advances the run of show.
 *
 * Pure, and exported, because it is a safety property rather than a
 * convenience: the console has controls on it that wipe an afternoon, and
 * "space cannot reach them" has to be something a test can assert rather than
 * something this file remembers. Everything it can return either ignores the
 * key or fires *the primary button* — there is no verdict that presses the
 * button under the cursor, which is the whole point.
 */
export function spaceVerdict(ev: SpaceKey): SpaceVerdict {
  if (ev.key !== " " && ev.code !== "Space") return "ignore";
  if (ev.repeat) return "ignore";
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return "ignore";
  const tag = ev.target?.tagName;
  // A text field owns every key that lands in it, which is why typing a
  // confirmation word is a guard the space bar cannot help with. The list is
  // {@link isFieldTag} because a Carbon field reports its host's tag and not
  // the `<input>`'s — see there.
  if (tag !== undefined && isFieldTag(tag)) return "ignore";
  if (ev.target?.isContentEditable === true) return "ignore";
  if (tag !== undefined && isButtonTag(tag)) {
    // Only the Yes and No of a half-pressed confirm, which took focus
    // deliberately and is being answered. Any other button has already done
    // its job and is holding the key hostage.
    if (classesOwnSpace(ev.target?.classes ?? [])) return "ignore";
    return "handBackAndFire";
  }
  return "fire";
}

export function control(opts: Opts): Control {
  const el = h("span", {
    class: `ctl${opts.className ? ` ${opts.className}` : ""}`,
  });
  // Everything Carbon needs is a function of the wrapper's class, decided
  // once: `.ctl-danger` is the console's existing word for "this is the
  // destructive one" and `.ctl-primary` for "this is the one", so the mapping
  // to Carbon's kinds needs no second vocabulary.
  const classes = classesOf(el);
  const danger = classes.includes("ctl-danger");
  const primary = classes.includes("ctl-primary");
  const plain = classes.includes(PLAIN_CLASS);
  const size = primary ? "lg" : "sm";
  let label = opts.label;
  let disabled = false;
  let armed = false;
  let on = false;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let armTimer: ReturnType<typeof setTimeout> | null = null;

  const api: Control = {
    el,
    flash(message, kind = "error") {
      if (flashTimer !== null) clearTimeout(flashTimer);
      armed = false;
      renderFlash(message, kind);
      flashTimer = setTimeout(() => {
        flashTimer = null;
        render();
      }, FLASH_MS);
    },
    setLabel(next) {
      if (next === label) return;
      label = next;
      if (flashTimer === null) render();
    },
    setDisabled(next) {
      if (next === disabled) return;
      disabled = next;
      if (next) armed = false;
      if (flashTimer === null) render();
    },
    setOn(next) {
      if (next === on) return;
      on = next;
      el.classList.toggle("on", next);
      if (flashTimer === null) render();
    },
    disarm() {
      if (!armed) return;
      armed = false;
      render();
    },
  };

  /** The confirm wording for right now, or null when this is a one-press control. */
  function question(): string | null {
    if (opts.question === undefined) return null;
    return typeof opts.question === "function" ? opts.question() : opts.question;
  }

  function fire(): void {
    if (disabled) return;
    if (opts.question !== undefined && !armed) {
      armed = true;
      render();
      if (armTimer !== null) clearTimeout(armTimer);
      armTimer = setTimeout(() => api.disarm(), ARM_TIMEOUT_MS);
      return;
    }
    armed = false;
    render();
    // Fired, so the space bar goes back to the run of show. See `releaseFocus`.
    releaseFocus(el);
    opts.onFire(api);
  }

  function renderFlash(message: string, kind: "error" | "ok"): void {
    replace(el, [
      h("span", {
        class: `ctl-flash ctl-flash-${kind}`,
        text: message,
        attrs: { role: "status" },
      }),
    ]);
  }

  /**
   * One button, in whichever of the two shapes this control is.
   *
   * The confirm's Yes and No come through here too, and that is the point.
   * They stand in for the button that was just pressed, in the place it was,
   * and `host.css` has always sized them to be exactly it — so when the
   * control is Carbon they have to be Carbon, or the row jumps by the
   * difference between a 31px rounded box and a 32px square one at the moment
   * the host is answering a question about something irreversible.
   *
   * What that does *not* move is the keyboard. `spaceVerdict` decides by tag
   * and by class name, `classesOwnSpace` reads `className`, and a Carbon host
   * carries the class exactly as a `<button>` does. `delegatesFocus` means
   * `yes.focus()` focuses the real `<button>` in the shadow root, and the
   * space bar activates that natively — which is the behaviour `spaceVerdict`
   * returns "ignore" in order to leave alone.
   */
  function button(
    className: string,
    text: string,
    kind: CarbonKind,
    extra?: { readonly disabled?: boolean; readonly title?: string },
  ): HTMLElement {
    const common = {
      class: className,
      type: "button",
      text,
      ...(extra?.disabled === undefined ? {} : { disabled: extra.disabled }),
      ...(extra?.title === undefined ? {} : { title: extra.title }),
    };
    return plain
      ? h("button", common)
      : carbonButton({ ...common, kind, size });
  }

  function render(): void {
    const asked = armed ? question() : null;
    if (asked !== null) {
      const yes = button("ctl-yes", "Yes", KIND_DANGER);
      const no = button("ctl-no", "No", KIND_DEFAULT);
      yes.addEventListener("click", fire);
      no.addEventListener("click", () => api.disarm());
      replace(el, [
        h("span", { class: "ctl-question", text: asked }),
        yes,
        no,
      ]);
      // Focus twice, and the second one is the one that does it.
      //
      // Lit renders a component's shadow root in a microtask *after* the
      // element is connected, so at this line a Carbon button's shadow root is
      // still empty — measured — and `delegatesFocus` has nothing to delegate
      // to: `focus()` returns having done nothing and `document.activeElement`
      // is the body. Which would quietly undo the property this file exists to
      // hold. With nothing focused, the next space bar is `spaceVerdict`'s
      // "fire" and presses the primary instead of answering the question the
      // host is looking at — on a control whose question is "Really close?".
      //
      // The synchronous call is for `.ctl-row`'s plain `<button>`, where it
      // works and a frame of delay would be a frame with nothing focused. The
      // deferred one is for Carbon's, and it asks twice whether the question is
      // still up, because a frame is long enough for Escape or for the state
      // to change under it.
      yes.focus();
      if (document.activeElement !== yes) {
        requestAnimationFrame(() => {
          if (armed && yes.isConnected) yes.focus();
        });
      }
      return;
    }
    // "On" outranks everything but the primary, which is already it: a filled
    // button is Carbon's way of saying a state is on, and a tertiary cannot be
    // filled from outside its shadow root.
    const kind =
      on || primary ? KIND_PRIMARY : danger ? KIND_DANGER : KIND_DEFAULT;
    const control = button("ctl-button", label, kind, {
      disabled,
      ...(opts.title === undefined ? {} : { title: opts.title }),
    });
    // Carbon's own host listener calls `stopPropagation()` on a click when the
    // button is disabled, which does not stop a second listener on the same
    // element — `fire()`'s own `if (disabled) return` is what does, and it is
    // load-bearing rather than defensive.
    control.addEventListener("click", fire);
    replace(el, [control]);
  }

  render();
  return api;
}

/** The one primary button. Same place, same key, labelled with what it does. */
export function primaryControl(onFire: (c: Control) => void): Control {
  const c = control({ label: "…", className: "ctl-primary", onFire });
  return {
    ...c,
    setLabel(next) {
      // The space-bar hint is part of the label, because the label is the
      // only place a host is looking.
      c.setLabel(next === "" ? "" : `${next}   (space)`);
    },
  };
}

/**
 * Bind the space bar to a control, without stealing it from a text field.
 *
 * Debounced, and deaf to key repeat: the host is driving this with their eyes
 * on the video call, and a bounced key that advanced two segments would put
 * the wrong thing in front of the room with nothing to undo it.
 */
const SPACE_DEBOUNCE_MS = 350;

export function bindSpace(target: Control): () => void {
  let lastFired = 0;
  const handler = (ev: KeyboardEvent): void => {
    const el = ev.target as HTMLElement | null;
    // The decision is made by {@link spaceVerdict}, which is pure and tested:
    // a focused button owns the space bar only if it is the Yes or No of a
    // half-pressed confirm. Any other button has already done its job and is
    // holding the key hostage — it hands it back rather than firing a second
    // time. This is the belt to `releaseFocus`'s braces, and it covers the
    // buttons this file does not own, like the theme toggle and the restart
    // panel's.
    const verdict = spaceVerdict({
      key: ev.key,
      code: ev.code,
      repeat: ev.repeat,
      metaKey: ev.metaKey,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      target:
        el === null
          ? null
          : {
              tagName: el.tagName,
              isContentEditable: el.isContentEditable === true,
              classes: classesOf(el),
            },
    });
    if (verdict === "ignore") return;
    if (verdict === "handBackAndFire") el?.blur();
    ev.preventDefault();
    const now = Date.now();
    if (now - lastFired < SPACE_DEBOUNCE_MS) return;
    lastFired = now;
    // `button, cds-button`, because the control's own button is now the
    // latter and the former is still what a `.ctl-yes` is. A plain
    // `querySelector("button")` finds neither when the control is Carbon's:
    // the `<button>` is inside a shadow root, which `querySelector` does not
    // enter, so this returned null and the space bar did nothing at all —
    // silently, since there is no button to fail to click.
    // `isDisabled`, not `.disabled`: a Carbon button has the attribute and not
    // the IDL property, and `.click()` on a custom element dispatches the
    // event whatever the element thinks of it — so without this the space bar
    // would fire a control the console has disabled.
    const button = target.el.querySelector<HTMLElement>("button, cds-button");
    if (button !== null && !isDisabled(button)) button.click();
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

/** Escape disarms every half-pressed confirm on the page. */
export function bindEscape(controls: () => readonly Control[]): void {
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    for (const c of controls()) c.disarm();
  });
}
