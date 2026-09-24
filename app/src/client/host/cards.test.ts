/**
 * Holding cards: the list, and the one thing about it that is not a widget.
 *
 * Which card a runbook step shows is what the space bar walks into, so the
 * list is worth tests for the same reason the runbook is. The migration is
 * worth them twice over: a host who writes their card the night before has to
 * find it the next morning, and "the storage key changed" is not a sentence
 * anybody wants to hear at 13:55.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  CARD_MAX,
  CARD_UNNAMED,
  addCard,
  cardById,
  cardMatching,
  cardName,
  defaultDeck,
  editCard,
  freshCardId,
  isLastCard,
  migrateDeck,
  moveCard,
  parseDeck,
  removeCard,
  type HoldingDeck,
} from "./cards.ts";

function twoCards(): HoldingDeck {
  return [
    { id: "card-1", title: "Agentic Security TTX", line: "Back at 14:20." },
    { id: "card-2", title: "Coffee break", line: "Ten minutes." },
  ];
}

describe("the deck", () => {
  it("starts as one blank card, so SHIFT+H always has something", () => {
    const deck = defaultDeck();
    assert.equal(deck.length, 1);
    assert.equal(deck[0]?.title, "");
  });

  it("calls a card by its title, and an untitled one by the segment's name", () => {
    assert.equal(cardName(twoCards()[0]), "Agentic Security TTX");
    assert.equal(cardName({ id: "x", title: "   ", line: "" }), CARD_UNNAMED);
    assert.equal(cardName(null), CARD_UNNAMED);
  });

  it("adds cards with ids nothing else is using", () => {
    let deck = defaultDeck();
    deck = addCard(deck, { title: "Coffee break" });
    assert.deepEqual(
      deck.map((c) => c.id),
      ["card-1", "card-2"],
    );
    // An id already taken is skipped rather than reused.
    const odd: HoldingDeck = [{ id: "card-2", title: "", line: "" }];
    assert.equal(freshCardId(odd), "card-3");
  });

  it("stops at a ceiling rather than growing a list nobody can read", () => {
    let deck = defaultDeck();
    for (let i = 0; i < CARD_MAX + 5; i += 1) deck = addCard(deck);
    assert.equal(deck.length, CARD_MAX);
    assert.equal(addCard(deck), deck);
  });

  it("edits one card and leaves the others alone", () => {
    const deck = editCard(twoCards(), "card-2", { title: "Tea break" });
    assert.equal(deck[0]?.title, "Agentic Security TTX");
    assert.equal(deck[1]?.title, "Tea break");
    assert.equal(deck[1]?.line, "Ten minutes.");
  });

  it("clamps what it is given to what the card can hold", () => {
    const deck = editCard(defaultDeck(), "card-1", { title: "x".repeat(300) });
    assert.equal(deck[0]?.title.length, 80);
  });

  it("ignores an edit to a card that is not there", () => {
    const deck = twoCards();
    assert.equal(editCard(deck, "card-9", { title: "nope" }), deck);
  });

  it("moves a card one place, and refuses to move off either end", () => {
    const deck = twoCards();
    assert.deepEqual(
      moveCard(deck, "card-2", -1).map((c) => c.id),
      ["card-2", "card-1"],
    );
    assert.equal(moveCard(deck, "card-1", -1), deck);
    assert.equal(moveCard(deck, "card-2", 1), deck);
  });

  it("removes a card, but never the last one", () => {
    const deck = twoCards();
    assert.deepEqual(
      removeCard(deck, "card-1").map((c) => c.id),
      ["card-2"],
    );
    const one = defaultDeck();
    assert.equal(isLastCard(one, "card-1"), true);
    assert.equal(removeCard(one, "card-1"), one);
    assert.equal(isLastCard(deck, "card-1"), false);
  });

  it("finds a card by id, and says null rather than throwing", () => {
    const deck = twoCards();
    assert.equal(cardById(deck, "card-2")?.title, "Coffee break");
    assert.equal(cardById(deck, "card-9"), null);
    assert.equal(cardById(deck, null), null);
  });

  it("recognises the card the room is looking at from its two strings", () => {
    const deck = twoCards();
    assert.equal(cardMatching(deck, "Coffee break", "Ten minutes.")?.id, "card-2");
    // Trimmed on both sides, because the console trims before it sends.
    assert.equal(cardMatching(deck, " Coffee break ", "Ten minutes.")?.id, "card-2");
    // Words nobody wrote, and the empty card a session starts with.
    assert.equal(cardMatching(deck, "Something else", ""), null);
    assert.equal(cardMatching(deck, "", ""), null);
  });
});

describe("the deck across a refresh", () => {
  it("round-trips through JSON, wrapped or bare", () => {
    const deck = twoCards();
    assert.deepEqual(parseDeck(JSON.stringify({ cards: deck })), deck);
    assert.deepEqual(parseDeck(JSON.stringify(deck)), deck);
  });

  it("gives nothing back for anything unusable", () => {
    assert.equal(parseDeck(null), null);
    assert.equal(parseDeck(""), null);
    assert.equal(parseDeck("{"), null);
    assert.equal(parseDeck("42"), null);
    assert.equal(parseDeck("[]"), null);
    assert.equal(parseDeck(JSON.stringify([{ title: "no id" }])), null);
  });

  it("drops duplicates and junk rather than refusing the whole deck", () => {
    const deck = parseDeck(
      JSON.stringify([
        { id: "card-1", title: "Kept", line: "yes" },
        { id: "card-1", title: "Dropped", line: "duplicate id" },
        { id: "", title: "Dropped", line: "no id" },
        "nope",
        null,
        { id: "card-2", title: 7, line: false },
      ]),
    );
    assert.ok(deck);
    assert.deepEqual(
      deck.map((c) => [c.id, c.title]),
      [
        ["card-1", "Kept"],
        ["card-2", ""],
      ],
    );
  });
});

describe("the card written by the build that only had one", () => {
  it("comes back as card one", () => {
    const deck = migrateDeck(
      JSON.stringify({
        title: "Agentic Security TTX",
        line: "Ade has the room. Back here at 2:40.",
      }),
    );
    assert.deepEqual(deck, [
      {
        id: "card-1",
        title: "Agentic Security TTX",
        line: "Ade has the room. Back here at 2:40.",
      },
    ]);
  });

  it("migrates a card with only one of its two lines written", () => {
    assert.deepEqual(migrateDeck(JSON.stringify({ title: "Back shortly" })), [
      { id: "card-1", title: "Back shortly", line: "" },
    ]);
  });

  it("has nothing to migrate from an untouched console", () => {
    assert.equal(migrateDeck(JSON.stringify({ title: "", line: "" })), null);
    assert.equal(migrateDeck(JSON.stringify({ title: "  ", line: " " })), null);
    assert.equal(migrateDeck(null), null);
    assert.equal(migrateDeck(""), null);
    assert.equal(migrateDeck("{"), null);
    assert.equal(migrateDeck("[]"), null);
  });
});
