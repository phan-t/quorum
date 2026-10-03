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

import { h, hx, replace } from "../shared/dom.ts";

/**
 * The armed controls are Carbon buttons. Issue #28 step 1.
 *
 * One factory, one tag name, so the console's whole secondary-button
 * vocabulary moves together or not at all. The element is defined by the
 * `@carbon/web-components` import at the top of `host/main.ts`, which is the
 * console's entry point and runs before anything here builds a control; the
 * module is vendored into `dist/vendor` and resolved through the import map in
 * `host/index.html`.
 *
 * `size="sm"` is 32px, fixed: Carbon pins a button's min and max block size to
 * the same token per size, which is the property the hand-built button spent a
 * `min-height: 31px` and a `white-space: nowrap` buying. 31px is not reachable
 * at `sm` and 32 is near enough to it that nothing in the console's layout
 * moved. `kind` is the only thing that varies, and it varies by the one class
 * the wrapper already carried.
 *
 * The inline confirm's Yes and No are deliberately NOT Carbon. They are the
 * two buttons the space bar is allowed to reach, `spaceVerdict` decides that
 * by their class names, and `host.css` sizes them to stand in for exactly the
 * box they replace. Moving them is a change to the one keyboard-safety
 * property this file exists to hold, and it is not what step 1 is for.
 */
const CARBON_BUTTON = "cds-button";

/** Carbon's kinds, by the class the console already used to mean the same. */
const KIND_DEFAULT = "tertiary";
const KIND_DANGER = "danger--tertiary";

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

export interface Control {
  readonly el: HTMLElement;
  /** Show a refusal in place of the label for three seconds. */
  flash(message: string, kind?: "error" | "ok"): void;
  setLabel(label: string): void;
  setDisabled(disabled: boolean): void;
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
 * Whether a button the space bar is about to click would refuse it anyway.
 *
 * A native button has the IDL property. A Carbon one has the attribute, and
 * the attribute is the right thing to read for the same reason `dom.ts` writes
 * it: it is true before the upgrade as well as after. `.click()` on a custom
 * element dispatches the event whatever the element thinks of it, so without
 * this the space bar would fire a control the console has disabled.
 */
function isButtonDisabled(el: HTMLElement): boolean {
  return el instanceof HTMLButtonElement
    ? el.disabled
    : el.hasAttribute("disabled");
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
  // confirmation word is a guard the space bar cannot help with.
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return "ignore";
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
  // The kind is a function of the wrapper's class, decided once: `.ctl-danger`
  // is the console's existing word for "this is the destructive one", so the
  // mapping to Carbon's kind needs no second vocabulary.
  const danger = classesOf(el).includes("ctl-danger");
  let label = opts.label;
  let disabled = false;
  let armed = false;
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

  function render(): void {
    const asked = armed ? question() : null;
    if (asked !== null) {
      const yes = h("button", { class: "ctl-yes", type: "button", text: "Yes" });
      const no = h("button", { class: "ctl-no", type: "button", text: "No" });
      yes.addEventListener("click", fire);
      no.addEventListener("click", () => api.disarm());
      replace(el, [
        h("span", { class: "ctl-question", text: asked }),
        yes,
        no,
      ]);
      yes.focus();
      return;
    }
    const button = hx(CARBON_BUTTON, {
      class: "ctl-button",
      type: "button",
      text: label,
      disabled,
      attrs: { kind: danger ? KIND_DANGER : KIND_DEFAULT, size: "sm" },
      ...(opts.title === undefined ? {} : { title: opts.title }),
    });
    // Carbon's own host listener calls `stopPropagation()` on a click when the
    // button is disabled, which does not stop a second listener on the same
    // element — `fire()`'s own `if (disabled) return` is what does, and it is
    // load-bearing rather than defensive.
    button.addEventListener("click", fire);
    replace(el, [button]);
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
    const button = target.el.querySelector<HTMLElement>("button, cds-button");
    if (button !== null && !isButtonDisabled(button)) button.click();
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
