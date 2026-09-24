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
  "sendoff",
];

/**
 * Steps that start *out* of the running order.
 *
 * Only the send-off, and the reason is the content: the other four surfaces
 * draw something sensible for any session, and a send-off draws what is in
 * that event's `sendoff.json`. An event that staged none and walked into the
 * step would put an empty frame in front of the room, at the one moment in an
 * afternoon that cannot be recovered with a shrug.
 *
 * So it is listed in the rail — discoverable, one click from being in — and
 * the host switches it on for the event that has one. This is the same
 * bargain the note makes when it says the send-off is runbook-modular: an
 * event that does not need one drops the step. It starts dropped.
 */
const RUNBOOK_OUT_BY_DEFAULT: readonly Segment[] = ["sendoff"];

function includedByDefault(kind: Segment): boolean {
  return !RUNBOOK_OUT_BY_DEFAULT.includes(kind);
}

/**
 * A step in the run of show.
 *
 * It used to be a segment kind and an in/out flag, and the kind was also the
 * key: one row per segment, found by `kind`. That stopped being enough the
 * moment an afternoon wanted two holding cards in two different places — a
 * TTX before trivia and a coffee break after the arcade are two steps of the
 * same kind, and a list keyed by kind cannot hold both.
 *
 * So a step now has an `id`, and that is what everything keys on. For the
 * four segments the product ships with, the id *is* the kind — `"holding"`,
 * `"trivia"`, `"arcade"`, `"standings"` — which is why a runbook written by
 * the previous build reads back unchanged: the ids it never wrote are the
 * values it would have written. Extra holding steps get ids of their own.
 *
 * `card` is which holding card this step shows, and it is the only content a
 * step carries. It is meaningless on the other kinds and is not set on them.
 * A step pointing at a card that has since been deleted is a real state, and
 * it is handled in words rather than by breaking the run of show — see
 * `cardForEntry` in main.ts.
 */
export interface RunbookEntry {
  readonly kind: Segment;
  /** Out of the runbook, but still listed so it can be put back. */
  readonly included: boolean;
  /** Stable, unique in the book. Equal to `kind` for the shipped four. */
  readonly id: string;
  /** Holding steps only: which card this one shows. */
  readonly card?: string;
}

/** The movable segments only, in the host's order. */
export type Runbook = readonly RunbookEntry[];

/**
 * A ceiling on holding steps, so the runbook stays something a host can read
 * in the rail without scrolling. Eight is more stretches than an afternoon
 * has, and hitting it is answered in words like every other refusal here.
 */
export const HOLDING_STEPS_MAX = 8;

/**
 * The order the product shipped with: everything in, except the steps
 * {@link RUNBOOK_OUT_BY_DEFAULT} names.
 */
export function defaultRunbook(): Runbook {
  return RUNBOOK_MOVABLE.map((kind) => ({
    kind,
    included: includedByDefault(kind),
    id: kind,
  }));
}

/** The step with this id, lobby and final included, or `null`. */
export function entryById(
  book: Runbook,
  id: string | null | undefined,
): RunbookEntry | null {
  if (id === null || id === undefined) return null;
  return runbookRail(book).find((e) => e.id === id) ?? null;
}

/** The movable segments that are in, in order. */
export function runbookIncluded(book: Runbook): readonly Segment[] {
  return runbookIncludedEntries(book).map((e) => e.kind);
}

/**
 * The same list as steps rather than as segment names — which is what the
 * console numbers its rows from, now that "the third thing that happens" and
 * "the third kind of thing" are not the same question.
 */
export function runbookIncludedEntries(book: Runbook): readonly RunbookEntry[] {
  return book.filter((e) => e.included);
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
    { kind: RUNBOOK_FIRST, included: true, id: RUNBOOK_FIRST },
    ...book,
    { kind: RUNBOOK_LAST, included: true, id: RUNBOOK_LAST },
  ];
}

/**
 * Move a step one place up or down. Off either end is a no-op rather than
 * a wrap: a list that teleports under a cursor is a list nobody can reorder.
 *
 * `id`, not `kind`, since two steps can be the same kind. For the shipped
 * four they are the same string, which is why every caller and every test
 * that passed a segment name still says what it meant.
 */
export function moveRunbook(
  book: Runbook,
  id: string,
  delta: -1 | 1,
): Runbook {
  const from = book.findIndex((e) => e.id === id);
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
export function dropRunbook(book: Runbook, id: string, to: number): Runbook {
  const from = book.findIndex((e) => e.id === id);
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
export function toggleRunbook(book: Runbook, id: string): Runbook {
  const entry = book.find((e) => e.id === id);
  if (entry === undefined) return book;
  if (entry.included && runbookIncluded(book).length <= 1) return book;
  return book.map((e) => (e.id === id ? { ...e, included: !e.included } : e));
}

/** True when {@link toggleRunbook} would refuse — so the console can say why. */
export function isLastIncludedSegment(book: Runbook, id: string): boolean {
  const entry = book.find((e) => e.id === id);
  return (
    entry !== undefined && entry.included && runbookIncluded(book).length <= 1
  );
}

/* ------------------------------------------------------------------ */
/* Holding steps                                                       */
/* ------------------------------------------------------------------ */

/** The prefix for the ids of holding steps a host added. Never `"holding"`. */
const STEP_PREFIX = "step-";

/** An id nothing in the book is using. */
export function freshStepId(book: Runbook): string {
  let n = book.length + 1;
  while (book.some((e) => e.id === `${STEP_PREFIX}${n}`)) n += 1;
  return `${STEP_PREFIX}${n}`;
}

/** How many holding steps the book holds, in or out. */
export function holdingSteps(book: Runbook): readonly RunbookEntry[] {
  return book.filter((e) => e.kind === "holding");
}

/**
 * Another holding step, showing `card`, at the end of the book.
 *
 * At the end and not next to the one it was added from: a new row that
 * appears where the host is looking is a row they can then move, and a new
 * row that appears in the middle of a list is a list that has rearranged
 * itself. Refused at {@link HOLDING_STEPS_MAX} by returning the book
 * unchanged; the caller has the words.
 */
export function addHoldingStep(book: Runbook, card: string): Runbook {
  if (holdingSteps(book).length >= HOLDING_STEPS_MAX) return book;
  return [
    ...book,
    { kind: "holding", included: true, id: freshStepId(book), card },
  ];
}

/**
 * Steps a host added can be deleted outright; the four the product ships with
 * can only be taken out, which is what the In/Out button is for. So the rail
 * always lists trivia, the arcade and the standings, whatever else is going
 * on — a console that could lose a segment permanently is a console that can
 * be set up wrong on Thursday and cannot be recovered on Friday.
 */
export function isRemovableStep(entry: RunbookEntry): boolean {
  return entry.id.startsWith(STEP_PREFIX);
}

/** Delete a step a host added. Anything else is a no-op. */
export function removeStep(book: Runbook, id: string): Runbook {
  const entry = book.find((e) => e.id === id);
  if (entry === undefined || !isRemovableStep(entry)) return book;
  // The same floor the In/Out button keeps: a run of show that is the lobby
  // and then the final is not a run of show.
  if (entry.included && runbookIncluded(book).length <= 1) return book;
  return book.filter((e) => e.id !== id);
}

/** Point a holding step at a different card. */
export function setEntryCard(book: Runbook, id: string, card: string): Runbook {
  return book.map((e) =>
    e.id === id && e.kind === "holding" ? { ...e, card } : e,
  );
}

/**
 * Give every holding step an explicit card.
 *
 * A step with no `card` is what the previous build's stored runbook looks
 * like, and it has to keep working. Reading it as "the first card" is the
 * right answer once — it is the card the old single-card key migrated into —
 * but leaving it implicit means the step would quietly change its words the
 * first time the host reordered the deck. So the console writes the id in
 * once, at start-up, and the implicit reading is only ever a fallback.
 */
export function anchorHoldingCards(book: Runbook, card: string): Runbook {
  if (!book.some((e) => e.kind === "holding" && e.card === undefined)) {
    return book;
  }
  return book.map((e) =>
    e.kind === "holding" && e.card === undefined ? { ...e, card } : e,
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
  const at = runbookRail(book).find((e) => e.kind === current);
  if (at === undefined) return runbookOrder(book)[0] ?? null;
  return nextEntryAfter(book, at.id)?.kind ?? null;
}

/**
 * The same walk, by step rather than by segment — which is what the console
 * actually uses now that two steps can be the same kind.
 *
 * Walked over every step in the host's order, not just the included ones, and
 * then forward to the first one that is in. So a host who jumped to a step
 * they had taken out gets the next thing in their plan rather than being
 * stranded, and a host on the last step gets `null`, which is the console's
 * cue to say "Nothing queued".
 *
 * An id the book has never heard of falls back to the front, which is where
 * `nextInRunbook` has always sent a segment it did not recognise. That is the
 * state a console lands in when the step it was standing on has just been
 * deleted underneath it, and the front is the one answer that is never wrong.
 */
export function nextEntryAfter(
  book: Runbook,
  id: string | null | undefined,
): RunbookEntry | null {
  const all = runbookRail(book);
  const at = id === null || id === undefined ? -1 : all.findIndex((e) => e.id === id);
  if (at === -1) return all[0] ?? null;
  for (let i = at + 1; i < all.length; i += 1) {
    const entry = all[i];
    if (entry !== undefined && entry.included) return entry;
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
    // No id is what the build before holding cards wrote, and for the four it
    // shipped with the id it would have written is the kind.
    const stored = e["id"];
    const id = typeof stored === "string" && stored !== "" ? stored : kind;
    // Deduped by id, not by kind: two holding steps are the point.
    if (book.some((b) => b.id === id)) continue;
    if (kind === "holding" && holdingSteps(book).length >= HOLDING_STEPS_MAX) {
      continue;
    }
    const card = e["card"];
    book.push({
      kind: kind as Segment,
      included: e["included"] !== false,
      id,
      ...(typeof card === "string" && card !== "" ? { card } : {}),
    });
  }
  // Anything the stored order left out is appended, so a build that adds a
  // segment does not leave it unreachable behind a stale entry in storage.
  for (const kind of RUNBOOK_MOVABLE) {
    if (!book.some((b) => b.id === kind)) {
      book.push({ kind, included: includedByDefault(kind), id: kind });
    }
  }
  // An empty runbook is a state the editor refuses to produce; a stored one
  // is corrupt, and the safe reading of corrupt is "everything".
  if (runbookIncluded(book).length === 0) {
    return book.map((e) => ({ ...e, included: true }));
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
