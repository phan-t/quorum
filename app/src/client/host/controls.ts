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

import { h, replace } from "../shared/dom.ts";

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
  if (active.tagName !== "BUTTON") return;
  if (isConfirmButton(active)) return;
  if (within !== undefined && !within.contains(active)) return;
  active.blur();
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
  // confirmation word is a guard the space bar cannot help with.
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return "ignore";
  if (ev.target?.isContentEditable === true) return "ignore";
  if (tag === "BUTTON") {
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
    const button = h("button", {
      class: "ctl-button",
      type: "button",
      text: label,
      disabled,
      ...(opts.title === undefined ? {} : { title: opts.title }),
    });
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
    const button = target.el.querySelector("button");
    if (button instanceof HTMLButtonElement && !button.disabled) button.click();
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
