/**
 * The frame budget (#45).
 *
 * The Desktop has no scroll: whatever does not fit 16:9 is simply not seen.
 * Most scenes are sized so it always fits, but a reveal carries the event's
 * own content — a two-line question over a two-line note, seven items with a
 * paragraph each, thirteen or seventeen Unseal words — and no fixed size is
 * right for all of it.
 *
 * So the parts of a scene that may give way say so with `data-fit`, and after
 * every paint they are shrunk together, in steps, until the frame holds.
 * Everything else keeps its size: the trivia podium is not marked, which is
 * how it stays whole under a long question. `zoom` rather than a transform,
 * because a transform leaves the layout box where it was and the frame would
 * still overflow.
 */

/** No smaller than this: below it the codec turns a note into grey fuzz. */
export const FIT_FLOOR = 0.6;
const FIT_STEP = 0.05;

/**
 * The largest zoom, from 1 down in steps to `floor`, at which nothing
 * overflows. At the floor it stops even if the frame still overflows: a
 * clipped last row is better than text nobody can read.
 */
export function fitZoom(overflowsAt: (zoom: number) => boolean, floor = FIT_FLOOR): number {
  let zoom = 1;
  while (zoom > floor && overflowsAt(zoom)) {
    zoom = Math.max(floor, Math.round((zoom - FIT_STEP) * 100) / 100);
  }
  return zoom;
}

/** Spills past its own box. */
function overflows(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 1;
}

/**
 * Something on the stage reaches into its padding, which is the 5% safe
 * margin a video call's tile crops. `scrollHeight` can't say so: it counts
 * neither the margin nor what a centred column pushes off its top.
 */
function spills(frame: HTMLElement): boolean {
  const box = frame.getBoundingClientRect();
  const style = getComputedStyle(frame);
  const top = box.top + parseFloat(style.paddingTop) - 1;
  const bottom = box.bottom - parseFloat(style.paddingBottom) + 1;
  return Array.from(frame.children).some((child) => {
    // Out of flow is on purpose: Plan / Apply's light covers the whole screen.
    const position = getComputedStyle(child).position;
    if (position === "absolute" || position === "fixed") return false;
    const r = child.getBoundingClientRect();
    return r.height > 0 && (r.top < top || r.bottom > bottom);
  });
}

/**
 * A part only counts as overflowing itself when it clips, like the Unseal
 * recap. A tight `line-height` lets a heading's glyphs hang a pixel below its
 * box, which `scrollHeight` reports, and nobody sees.
 */
function clips(el: HTMLElement): boolean {
  return getComputedStyle(el).overflowY !== "visible";
}

/** Fit `frame`'s visible `[data-fit]` parts. Cheap when there are none. */
export function fitFrame(frame: HTMLElement): void {
  const parts = Array.from(frame.querySelectorAll<HTMLElement>("[data-fit]"));
  for (const p of parts) p.style.removeProperty("zoom");
  const shown = parts.filter((p) => p.getClientRects().length > 0);
  if (shown.length === 0) return;
  const clipping = shown.filter(clips);
  const zoom = fitZoom((z) => {
    for (const p of shown) p.style.setProperty("zoom", String(z));
    return spills(frame) || overflows(frame) || clipping.some(overflows);
  });
  // Set again because the floor is returned without being measured.
  for (const p of shown) p.style.setProperty("zoom", String(zoom));
}
