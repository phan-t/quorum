/**
 * The runbook: which segments this event runs, and in what order.
 *
 * Quorum was built for one afternoon and is being kept for the next one, and
 * the next one does not necessarily want a holding card, a trivia and an
 * arcade in that order. So the run of show stopped being a constant in the
 * client and became something the host sets up before the room arrives — the
 * same bargain the arcade's running order already makes, for the same reason:
 * which activities, in which order, is knowable at 9am, and a decision made
 * at 9am is a decision nobody has to make in front of thirty people.
 *
 * Nothing on the server knows about this. The engine holds no sequence at all
 * — `setSegment` takes any segment at any time and sets it — so the order is
 * entirely the console's, and the only thing it changes is what the primary
 * button offers next.
 *
 * **Lobby and Final are structural and are not in here.** The lobby is where
 * a session is opened and started; the console forces that panel while the
 * phase is `draft` whatever the host has chosen, so "take the lobby out" is a
 * setting that cannot be honoured. The final is the closing screen and the
 * only place the run of show can end. Both are pinned, first and last, and
 * everything between them is the host's.
 *
 * This file is the list and nothing else: no DOM, no commands, no timers. It
 * is pure so the part most likely to be wrong at 2:45pm is the part that has
 * tests.
 */

import type { Segment } from "../../engine/types.ts";

/** Opens the session. Pinned first. */
export const RUNBOOK_FIRST: Segment = "lobby";
/** Closes it. Pinned last. */
export const RUNBOOK_LAST: Segment = "final";

/** The segments a host may reorder, or take out and put back. */
export const RUNBOOK_MOVABLE: readonly Segment[] = [
  "holding",
  "trivia",
  "arcade",
  "standings",
];

export interface RunbookEntry {
  readonly kind: Segment;
  /** Out of the runbook, but still listed so it can be put back. */
  readonly included: boolean;
}

/** The movable segments only, in the host's order. */
export type Runbook = readonly RunbookEntry[];

/** Everything in, in the order the product shipped with. */
export function defaultRunbook(): Runbook {
  return RUNBOOK_MOVABLE.map((kind) => ({ kind, included: true }));
}

/** The movable segments that are in, in order. */
export function runbookIncluded(book: Runbook): readonly Segment[] {
  return book.filter((e) => e.included).map((e) => e.kind);
}

/** What the space bar walks: the lobby, the chosen middle, the final. */
export function runbookOrder(book: Runbook): readonly Segment[] {
  return [RUNBOOK_FIRST, ...runbookIncluded(book), RUNBOOK_LAST];
}

/**
 * Every segment, in the host's order, in or out — what the rail draws. The
 * ones that are out are still listed and still reachable: taking a segment
 * out of the runbook says "not by default", never "not at all", and a console
 * that could not jump to trivia because trivia was not in the plan would be a
 * console that had lost a feature at 2:45pm.
 */
export function runbookRail(book: Runbook): readonly RunbookEntry[] {
  return [
    { kind: RUNBOOK_FIRST, included: true },
    ...book,
    { kind: RUNBOOK_LAST, included: true },
  ];
}

/**
 * Move a segment one place up or down. Off either end is a no-op rather than
 * a wrap: a list that teleports under a cursor is a list nobody can reorder.
 */
export function moveRunbook(
  book: Runbook,
  kind: Segment,
  delta: -1 | 1,
): Runbook {
  const from = book.findIndex((e) => e.kind === kind);
  if (from === -1) return book;
  const to = from + delta;
  if (to < 0 || to >= book.length) return book;
  const next = [...book];
  const moved = next[from];
  const other = next[to];
  if (moved === undefined || other === undefined) return book;
  next[from] = other;
  next[to] = moved;
  return next;
}

/**
 * Drop a segment at a position, for the pointer path. `to` is an index into
 * the list as it stands; out-of-range clamps rather than refuses, because a
 * drag that ends two pixels past the last row means "put it last".
 */
export function dropRunbook(book: Runbook, kind: Segment, to: number): Runbook {
  const from = book.findIndex((e) => e.kind === kind);
  if (from === -1) return book;
  const at = Math.max(0, Math.min(book.length - 1, Math.round(to)));
  if (at === from) return book;
  const next = [...book];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return book;
  next.splice(at, 0, moved);
  return next;
}

/**
 * Take a segment out of the runbook, or put it back.
 *
 * Taking the last one out is refused: a run of show that is the lobby and
 * then the final is not a run of show, and the console says so in words
 * rather than quietly accepting it. Same rule, and the same wording shape, as
 * the arcade's "keep at least one round".
 */
export function toggleRunbook(book: Runbook, kind: Segment): Runbook {
  const entry = book.find((e) => e.kind === kind);
  if (entry === undefined) return book;
  if (entry.included && runbookIncluded(book).length <= 1) return book;
  return book.map((e) =>
    e.kind === kind ? { kind: e.kind, included: !e.included } : e,
  );
}

/** True when {@link toggleRunbook} would refuse — so the console can say why. */
export function isLastIncludedSegment(book: Runbook, kind: Segment): boolean {
  const entry = book.find((e) => e.kind === kind);
  return (
    entry !== undefined && entry.included && runbookIncluded(book).length <= 1
  );
}

/**
 * What the primary button offers after `current`.
 *
 * Walked over every segment in the host's order, not just the included ones,
 * and then forward to the first one that is in. So a host who jumped to a
 * segment they had taken out gets the next thing in their plan rather than
 * being stranded, and a host on the last segment gets `null`, which is the
 * console's cue to say "Nothing queued".
 */
export function nextInRunbook(book: Runbook, current: Segment): Segment | null {
  const all = runbookRail(book);
  const order = runbookOrder(book);
  const at = all.findIndex((e) => e.kind === current);
  // A segment the runbook has never heard of: fall back to the front.
  if (at === -1) return order[0] ?? null;
  for (let i = at + 1; i < all.length; i += 1) {
    const entry = all[i];
    if (entry !== undefined && entry.included) return entry.kind;
  }
  return null;
}

/** "Holding card, Trivia, then Standings" — for the pre-flight list. */
export function runbookSummary(
  book: Runbook,
  label: Readonly<Record<Segment, string>>,
): string {
  const names = runbookIncluded(book).map((k) => label[k]);
  if (names.length === 0) return "nothing";
  if (names.length === 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")}, then ${names[names.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* Keeping it across a refresh                                         */
/* ------------------------------------------------------------------ */

/**
 * A host who sets this up on Thursday finds it on Friday, and a console
 * reloaded at 2:45pm comes back with it still set. Best-effort on purpose: a
 * browser with storage turned off, or a stored value from an older build,
 * gets the default runbook and a working console, never a broken one.
 */
export function parseRunbook(raw: string | null): Runbook | null {
  if (raw === null || raw === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(v)
    ? (v as unknown[])
    : typeof v === "object" && v !== null && Array.isArray((v as { book?: unknown }).book)
      ? ((v as { book: unknown[] }).book)
      : null;
  if (list === null) return null;

  const book: RunbookEntry[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const kind = e["kind"];
    if (typeof kind !== "string") continue;
    if (!RUNBOOK_MOVABLE.includes(kind as Segment)) continue;
    if (book.some((b) => b.kind === kind)) continue;
    book.push({ kind: kind as Segment, included: e["included"] !== false });
  }
  // Anything the stored order left out is appended, so a build that adds a
  // segment does not leave it unreachable behind a stale entry in storage.
  for (const kind of RUNBOOK_MOVABLE) {
    if (!book.some((b) => b.kind === kind)) book.push({ kind, included: true });
  }
  // An empty runbook is a state the editor refuses to produce; a stored one
  // is corrupt, and the safe reading of corrupt is "everything".
  if (runbookIncluded(book).length === 0) {
    return book.map((e) => ({ kind: e.kind, included: true }));
  }
  return book;
}

/* ------------------------------------------------------------------ */
/* The tray's width                                                    */
/* ------------------------------------------------------------------ */

/**
 * How wide the preview column is, in pixels.
 *
 * The floor is the narrowest the preview is still worth looking at; the
 * ceiling is what leaves the scoring grid its ~700px without a sideways
 * scrollbar on a 1280px laptop, plus the rail. Both are clamped here rather
 * than at the drag site so the stored value and the dragged value cannot
 * disagree.
 */
export const TRAY_MIN = 216;
export const TRAY_MAX = 560;

export function clampTray(width: number): number {
  if (!Number.isFinite(width)) return TRAY_MIN;
  return Math.round(Math.max(TRAY_MIN, Math.min(TRAY_MAX, width)));
}

/** `null` when nothing usable is stored, which means "use the default". */
export function parseTrayWidth(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return clampTray(n);
}
