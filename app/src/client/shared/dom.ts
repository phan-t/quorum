/**
 * The tiny render helper. Not a framework: element construction, a keyed list
 * reconciler, and two guarantees.
 *
 * 1. **Text is text.** There is no `innerHTML` anywhere in this file and no
 *    caller can smuggle markup through it. Nicknames arrive over a socket from
 *    people who chose them, and they are rendered with `textContent` or a text
 *    node, always.
 * 2. **Updating never rebuilds.** The console has text fields in it and the
 *    host is typing into them while state arrives; blowing the subtree away on
 *    every broadcast would eat their keystrokes. Pages build their DOM once and
 *    call small update functions.
 */

export type Child = Node | string | number | null | false | undefined;

export interface ElemOptions {
  class?: string;
  /** Set as `textContent`. Never parsed as markup. */
  text?: string | number;
  id?: string;
  type?: string;
  role?: string;
  title?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Anything else: data-*, aria-*, maxlength, autocomplete, inputmode… */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Record<string, (ev: Event) => void>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts?: ElemOptions,
  children?: readonly Child[],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (opts) applyOptions(el, opts);
  if (children) append(el, children);
  return el;
}

/**
 * `h()`, for a custom element.
 *
 * `h()` is keyed on `HTMLElementTagNameMap`, which is how `h("button", …)`
 * comes back typed as an `HTMLButtonElement` and how a typo in a tag name is
 * a compile error. A custom element is not in that map: `@carbon/web-components`
 * ships no `declare global` augmentation for its tags, so `h("cds-button")`
 * does not compile.
 *
 * The two ways out were a three-line `declare global` block adding `cds-button`
 * to the map, or this. This, because the augmentation would be a lie in both
 * directions: it would claim `document.createElement("cds-button")` returns a
 * `CDSButton` — it returns a bare `HTMLElement` until Carbon's module has run
 * and upgraded it — and it would put a tag in the *global* DOM type map from a
 * file the participant and Desktop surfaces also compile against, where that
 * element does not exist and importing it would be a mistake with no error.
 * A separate function makes the custom-element call sites findable by name,
 * which is what a migration spread over six steps actually needs.
 *
 * Both guarantees at the top of this file hold, because this shares `h()`'s
 * body: `text` is still `textContent` and there is still no `innerHTML` in
 * this file. A nickname rendered through `hx` is as safe as one through `h`.
 *
 * The return type is `HTMLElement` and deliberately not the component's class.
 * Callers set attributes, not properties — see `applyOptions` — so they never
 * need it, and a caller that reaches for a Carbon property is a caller that has
 * started depending on the upgrade having happened.
 */
export function hx(
  tag: string,
  opts?: ElemOptions,
  children?: readonly Child[],
): HTMLElement {
  const el = document.createElement(tag);
  if (opts) applyOptions(el, opts);
  if (children) append(el, children);
  return el;
}

function applyOptions(el: HTMLElement, o: ElemOptions): void {
  if (o.class !== undefined) el.className = o.class;
  if (o.text !== undefined) el.textContent = String(o.text);
  if (o.id !== undefined) el.id = o.id;
  if (o.role !== undefined) el.setAttribute("role", o.role);
  if (o.title !== undefined) el.title = o.title;
  if (o.type !== undefined) el.setAttribute("type", o.type);
  if (o.value !== undefined) el.setAttribute("value", o.value);
  if (o.placeholder !== undefined) el.setAttribute("placeholder", o.placeholder);
  if (o.disabled !== undefined) setDisabled(el, o.disabled);
  if (o.attrs) {
    for (const [k, v] of Object.entries(o.attrs)) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  if (o.on) {
    for (const [name, fn] of Object.entries(o.on)) {
      el.addEventListener(name, fn);
    }
  }
}

/**
 * `disabled`, on a native control or on a custom element.
 *
 * A native control has the IDL property and it is the only thing that works:
 * `<button disabled>` and `button.disabled = true` are the same bit.
 *
 * A custom element does not, until its definition has run and upgraded it.
 * Setting `.disabled` on an element that has not been upgraded writes an own
 * property that shadows the accessor the upgrade installs — Lit recovers from
 * that case, but "Lit recovers from it" is not a thing the one disabled button
 * on this console that closes a session should rest on. The attribute is
 * authoritative whenever the upgrade happens: Carbon declares `disabled`
 * reflecting, so the attribute is what the component reads on upgrade and what
 * it writes back afterwards.
 *
 * The test is the hyphen, because a custom element name is required to contain
 * one and no built-in tag name does.
 */
export function setDisabled(el: HTMLElement, disabled: boolean): void {
  if (el.tagName.includes("-")) {
    if (disabled) el.setAttribute("disabled", "");
    else el.removeAttribute("disabled");
    return;
  }
  (el as HTMLButtonElement).disabled = disabled;
}

/**
 * The same question, read back.
 *
 * Exported alongside {@link setDisabled} because a caller that writes with one
 * and reads with `.disabled` gets `undefined` on a custom element — which is
 * falsy, so the console would decide a disabled control is pressable and say
 * nothing about it. `host/main.ts` reads this on the wipe's own button.
 */
export function isDisabled(el: HTMLElement): boolean {
  return el instanceof HTMLButtonElement
    ? el.disabled
    : el.hasAttribute("disabled");
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(
      typeof c === "string" || typeof c === "number"
        ? document.createTextNode(String(c))
        : c,
    );
  }
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replace a container's contents. The only "re-render" primitive. */
export function replace(el: Node, children: readonly Child[]): void {
  clear(el);
  append(el, children);
}

/** `textContent`, but a no-op when unchanged so the console does not thrash. */
export function setText(el: HTMLElement, value: string | number): void {
  const s = String(value);
  if (el.textContent !== s) el.textContent = s;
}

export function setClass(el: HTMLElement, name: string, on: boolean): void {
  el.classList.toggle(name, on);
}

export function setAttr(
  el: HTMLElement,
  name: string,
  value: string | null,
): void {
  if (value === null) el.removeAttribute(name);
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export function qs<T extends HTMLElement>(sel: string, root?: ParentNode): T {
  const el = (root ?? document).querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el as T;
}

/**
 * Keyed list reconciliation. Rows that survive are updated in place, which is
 * what keeps a roster of sixty from flickering — and what stops the row the
 * host is about to click moving out from under the cursor.
 */
export interface KeyedList<T> {
  update(items: readonly T[]): void;
}

export function keyedList<T>(
  container: HTMLElement,
  key: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (el: HTMLElement, item: T) => void,
): KeyedList<T> {
  const rows = new Map<string, HTMLElement>();
  return {
    update(items) {
      const seen = new Set<string>();
      let cursor: ChildNode | null = container.firstChild;
      for (const item of items) {
        const k = key(item);
        seen.add(k);
        let row = rows.get(k);
        if (!row) {
          row = create(item);
          rows.set(k, row);
        }
        update(row, item);
        if (cursor === row) {
          cursor = row.nextSibling;
        } else {
          container.insertBefore(row, cursor);
        }
      }
      for (const [k, row] of rows) {
        if (!seen.has(k)) {
          row.remove();
          rows.delete(k);
        }
      }
    },
  };
}

/**
 * A screen-reader announcement that does not move anything on screen. Used for
 * the things conveyed visually by a colour change — sealed, reconnecting — so
 * nothing is colour-alone.
 */
export function liveRegion(root: HTMLElement): (msg: string) => void {
  const el = h("div", {
    class: "sr-only",
    attrs: { "aria-live": "polite", "aria-atomic": "true" },
  });
  root.appendChild(el);
  let last = "";
  return (msg) => {
    if (msg === last) return;
    last = msg;
    el.textContent = msg;
  };
}
