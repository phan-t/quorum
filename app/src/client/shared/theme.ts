/**
 * Theme: dark (the default), light, or whatever the viewer's OS says.
 *
 * The choice is stamped on <html> as data-theme and remembered per browser.
 * "System" stamps nothing, so the media query in tokens.css decides — which
 * is why there are three states rather than a boolean.
 *
 * Applied before first paint from an inline snippet in each page's <head>,
 * so a viewer who has chosen light never sees a dark frame first.
 */

export type Theme = "system" | "light" | "dark";

const KEY = "quorum.theme.v1";
const ORDER: readonly Theme[] = ["system", "light", "dark"];

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* private browsing: fall through to the default */
  }
  return "system";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* the page still works; the choice just will not survive a reload */
  }
}

/** What the viewer is actually looking at right now. */
export function effectiveTheme(): "light" | "dark" {
  const chosen = readTheme();
  if (chosen !== "system") return chosen;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

const LABEL: Record<Theme, string> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

/**
 * A three-state control, not a switch: "auto" is a real choice and the one
 * most people want, and a two-way toggle cannot express it.
 */
export function themeToggle(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-toggle";

  const paint = (): void => {
    const t = readTheme();
    btn.textContent = LABEL[t];
    btn.setAttribute("aria-label", `Theme: ${LABEL[t]}. Click to change.`);
    btn.dataset["theme"] = t;
  };

  btn.addEventListener("click", () => {
    const next = ORDER[(ORDER.indexOf(readTheme()) + 1) % ORDER.length]!;
    applyTheme(next);
    paint();
  });

  paint();
  return btn;
}

/** Call once, as early as possible. */
export function initTheme(): void {
  applyTheme(readTheme());
}
