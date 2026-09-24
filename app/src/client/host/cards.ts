/**
 * Holding cards: the slides an *off-platform* activity is run in.
 *
 * The holding card is not a filler screen. The Agentic Security TTX has no
 * Quorum surface at all, so for thirty-five minutes the holding card **is**
 * the TTX as far as thirty people are concerned — it is the only thing on the
 * projector, and it is what a host points at when somebody comes back from
 * the corridor and asks what is going on. An afternoon has several of those
 * stretches (the TTX, the coffee break, the five minutes while the arcade is
 * reset) and they do not all want the same words.
 *
 * So there is a list of cards rather than one card, each with a name, and a
 * runbook step points at one of them. That is the whole feature, and all of
 * it is console-side: `setHolding` on the wire has always taken a title and a
 * second line, so showing a card is sending its two strings. Nothing here
 * reaches the engine, the protocol or the server, and nothing here goes to
 * the room until the host asks for it.
 *
 * This file is the list and nothing else — no DOM, no commands, no storage
 * calls — for the reason runbook.ts gives: the part most likely to be wrong
 * at 2:45pm is the part that has tests.
 */

/** A card is a name (its title) and the line under it. Both go to the room. */
export interface HoldingCard {
  /** Stable, and referenced by runbook steps. Never shown to anybody. */
  readonly id: string;
  /** The big line on the screen, and the name the console calls it by. */
  readonly title: string;
  /** The small line under it. */
  readonly line: string;
}

export type HoldingDeck = readonly HoldingCard[];

/** The lengths the fields enforce, so storage cannot hold a longer one. */
export const CARD_TITLE_MAX = 80;
export const CARD_LINE_MAX = 140;

/**
 * A ceiling, so that the list stays a list.
 *
 * Twelve is more stretches than an afternoon has, and it keeps the card
 * chooser on a runbook step short enough to read at a 216px tray. Hitting it
 * is answered in words, like every other refusal on this console.
 */
export const CARD_MAX = 12;

/** What the console calls a card with no title yet. */
export const CARD_UNNAMED = "Holding card";

/** One empty card: the state a browser that has never seen Quorum starts in. */
export function defaultDeck(): HoldingDeck {
  return [{ id: "card-1", title: "", line: "" }];
}

/** The card's name for the runbook, the rail and the buttons. */
export function cardName(card: HoldingCard | null | undefined): string {
  const given = card?.title.trim() ?? "";
  return given === "" ? CARD_UNNAMED : given;
}

/** `null` rather than a throw: a step may point at a card that was deleted. */
export function cardById(
  deck: HoldingDeck,
  id: string | null | undefined,
): HoldingCard | null {
  if (id === null || id === undefined) return null;
  return deck.find((c) => c.id === id) ?? null;
}

/**
 * Which card the room is looking at, worked out from the two strings on the
 * wire. Used after a reload to pick the console's place back up: the engine
 * stores a title and a line, not a card id, and it never will — a card id is
 * console vocabulary and putting one on the wire would be a protocol change
 * for a feature that does not need one.
 */
export function cardMatching(
  deck: HoldingDeck,
  title: string | null | undefined,
  line: string | null | undefined,
): HoldingCard | null {
  const t = (title ?? "").trim();
  const l = (line ?? "").trim();
  if (t === "" && l === "") return null;
  return deck.find((c) => c.title.trim() === t && c.line.trim() === l) ?? null;
}

/** An id nothing in the deck is using. */
export function freshCardId(deck: HoldingDeck): string {
  let n = deck.length + 1;
  while (deck.some((c) => c.id === `card-${n}`)) n += 1;
  return `card-${n}`;
}

function clamp(card: HoldingCard): HoldingCard {
  return {
    id: card.id,
    title: card.title.slice(0, CARD_TITLE_MAX),
    line: card.line.slice(0, CARD_LINE_MAX),
  };
}

/**
 * Add a card. Refused at {@link CARD_MAX} by returning the deck unchanged,
 * which is how every other list on this console says no — the caller has the
 * words.
 */
export function addCard(
  deck: HoldingDeck,
  card?: { title?: string; line?: string },
): HoldingDeck {
  if (deck.length >= CARD_MAX) return deck;
  return [
    ...deck,
    clamp({
      id: freshCardId(deck),
      title: card?.title ?? "",
      line: card?.line ?? "",
    }),
  ];
}

/** Rewrite one card's words. Unknown id is a no-op, not a throw. */
export function editCard(
  deck: HoldingDeck,
  id: string,
  patch: { title?: string; line?: string },
): HoldingDeck {
  if (!deck.some((c) => c.id === id)) return deck;
  return deck.map((c) =>
    c.id === id
      ? clamp({
          id: c.id,
          title: patch.title ?? c.title,
          line: patch.line ?? c.line,
        })
      : c,
  );
}

/**
 * Remove a card.
 *
 * Removing the last one is refused: a console with no holding card at all is
 * a console where SHIFT+H has nothing to put up, and SHIFT+H is the key a
 * host reaches for when something has gone wrong. Same rule and the same
 * shape as "keep at least one segment" and "keep at least one round".
 *
 * Removing a card that runbook steps point at is *allowed* — see
 * {@link isLastCard} for the one that is not. Those steps are left dangling
 * on purpose rather than quietly repointed: a step that silently started
 * showing different words is worse than a step that says it needs a card.
 */
export function removeCard(deck: HoldingDeck, id: string): HoldingDeck {
  if (deck.length <= 1) return deck;
  if (!deck.some((c) => c.id === id)) return deck;
  return deck.filter((c) => c.id !== id);
}

/** True when {@link removeCard} would refuse — so the console can say why. */
export function isLastCard(deck: HoldingDeck, id: string): boolean {
  return deck.length <= 1 && deck.some((c) => c.id === id);
}

/** Move a card one place. Off either end is a no-op rather than a wrap. */
export function moveCard(
  deck: HoldingDeck,
  id: string,
  delta: -1 | 1,
): HoldingDeck {
  const from = deck.findIndex((c) => c.id === id);
  if (from === -1) return deck;
  const to = from + delta;
  if (to < 0 || to >= deck.length) return deck;
  const next = [...deck];
  const moved = next[from];
  const other = next[to];
  if (moved === undefined || other === undefined) return deck;
  next[from] = other;
  next[to] = moved;
  return next;
}

/* ------------------------------------------------------------------ */
/* Keeping it across a refresh                                         */
/* ------------------------------------------------------------------ */

/**
 * The deck as stored, or `null` when nothing usable is there.
 *
 * Best-effort on purpose, like the runbook: a browser with storage off, or a
 * value written by an older build, gets a working console and never a broken
 * one.
 */
export function parseDeck(raw: string | null): HoldingDeck | null {
  if (raw === null || raw === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(v)
    ? (v as unknown[])
    : typeof v === "object" &&
        v !== null &&
        Array.isArray((v as { cards?: unknown }).cards)
      ? (v as { cards: unknown[] }).cards
      : null;
  if (list === null) return null;

  const deck: HoldingCard[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = o["id"];
    if (typeof id !== "string" || id === "") continue;
    if (deck.some((c) => c.id === id)) continue;
    if (deck.length >= CARD_MAX) break;
    deck.push(
      clamp({
        id,
        title: typeof o["title"] === "string" ? o["title"] : "",
        line: typeof o["line"] === "string" ? o["line"] : "",
      }),
    );
  }
  // A deck with nothing in it is a state the editor refuses to produce, so a
  // stored one is corrupt; the safe reading of corrupt is "one blank card".
  if (deck.length === 0) return null;
  return deck;
}

/**
 * The one card written by the build that only had one, as card number one.
 *
 * `quorum.host.holding.v1` held `{title, line}`. A host who wrote their card
 * on Thursday night must find it on Friday morning — dropping it and showing
 * them an empty field would be this change costing them the thing it was
 * supposed to give them. So the old key is read, turned into `card-1`, and
 * the runbook's holding step points at it.
 *
 * `null` when there is nothing there or nothing usable in it, which is the
 * signal to start from {@link defaultDeck}.
 */
export function migrateDeck(legacyRaw: string | null): HoldingDeck | null {
  if (legacyRaw === null || legacyRaw === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(legacyRaw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const title = typeof o["title"] === "string" ? o["title"] : "";
  const line = typeof o["line"] === "string" ? o["line"] : "";
  // An empty card is what an untouched console stores, and it is not worth
  // migrating — `defaultDeck()` is the same thing.
  if (title.trim() === "" && line.trim() === "") return null;
  return [clamp({ id: "card-1", title, line })];
}
