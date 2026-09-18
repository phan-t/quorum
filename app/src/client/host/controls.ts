/**
 * Console buttons, with the two rules DESIGN.md puts on them.
 *
 * - Destructive or irreversible actions are two-step, and the confirm is
 *   *inline*: the button becomes "Really seal? [Yes] [No]". Never a modal — a
 *   modal that steals focus during a live question is how a host presses the
 *   wrong thing.
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
  /** Two-step when present. The question replaces the label while armed. */
  question?: string;
  title?: string;
  onFire: (control: Control) => void;
}

const FLASH_MS = 3_000;
const ARM_TIMEOUT_MS = 6_000;

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
    if (armed && opts.question !== undefined) {
      const yes = h("button", { class: "ctl-yes", type: "button", text: "Yes" });
      const no = h("button", { class: "ctl-no", type: "button", text: "No" });
      yes.addEventListener("click", fire);
      no.addEventListener("click", () => api.disarm());
      replace(el, [
        h("span", { class: "ctl-question", text: opts.question }),
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
    if (ev.key !== " " && ev.code !== "Space") return;
    if (ev.repeat) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const el = ev.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (el?.isContentEditable) return;
    // If a button already has focus, space is that button's.
    if (tag === "BUTTON") return;
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
