/**
 * The runbook: which segments this event runs, and in what order.
 *
 * This list decides what the space bar does, which is the one control the
 * whole console is built around. It is worth tests: everything else new here
 * is a widget, and this is a rule.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Segment } from "../../engine/types.ts";
import {
  HOLDING_STEPS_MAX,
  RUNBOOK_MOVABLE,
  TRAY_MAX,
  TRAY_MIN,
  addHoldingStep,
  anchorHoldingCards,
  clampTray,
  defaultRunbook,
  dropRunbook,
  entryById,
  freshStepId,
  holdingSteps,
  isLastIncludedSegment,
  isRemovableStep,
  moveRunbook,
  nextEntryAfter,
  nextInRunbook,
  parseRunbook,
  parseTrayWidth,
  removeStep,
  runbookIncluded,
  runbookIncludedEntries,
  runbookOrder,
  runbookRail,
  runbookSummary,
  setEntryCard,
  toggleRunbook,
  type Runbook,
} from "./runbook.ts";

const LABEL: Readonly<Record<Segment, string>> = {
  lobby: "Lobby",
  holding: "Holding card",
  trivia: "Trivia",
  arcade: "Arcade",
  sendoff: "Send-off",
  standings: "Standings",
  final: "Final",
};

describe("the runbook", () => {
  it("starts as the run of show the product shipped with", () => {
    assert.deepEqual(runbookOrder(defaultRunbook()), [
      "lobby",
      "holding",
      "trivia",
      "arcade",
      "standings",
      "final",
    ]);
  });

  /*
   * The send-off is in the rail and out of the order, which is the one step
   * that starts that way. It draws an event's own `sendoff.json` and there is
   * no sensible frame for an event that staged none, so it is switched on for
   * the afternoon that has one rather than walked into by every other.
   */
  it("lists the send-off, and leaves it out of the running order", () => {
    const book = defaultRunbook();
    assert.equal(entryById(book, "sendoff")?.included, false);
    assert.ok(!runbookIncluded(book).includes("sendoff"));
    assert.deepEqual(runbookIncluded(toggleRunbook(book, "sendoff")), [
      "holding",
      "trivia",
      "arcade",
      "standings",
      "sendoff",
    ]);
  });

  it("keeps the lobby first and the final last whatever the host does", () => {
    let book = defaultRunbook();
    book = moveRunbook(book, "standings", -1);
    book = toggleRunbook(book, "trivia");
    const order = runbookOrder(book);
    assert.equal(order[0], "lobby");
    assert.equal(order[order.length - 1], "final");
  });

  it("moves a segment one place at a time", () => {
    const moved = moveRunbook(defaultRunbook(), "standings", -1);
    assert.deepEqual(runbookIncluded(moved), [
      "holding",
      "trivia",
      "standings",
      "arcade",
    ]);
  });

  it("refuses to move off either end rather than wrapping", () => {
    const book = defaultRunbook();
    assert.equal(moveRunbook(book, "holding", -1), book);
    assert.equal(moveRunbook(book, "sendoff", 1), book);
  });

  it("drops a segment at a position, for the pointer path", () => {
    const dropped = dropRunbook(defaultRunbook(), "holding", 3);
    assert.deepEqual(runbookIncluded(dropped), [
      "trivia",
      "arcade",
      "standings",
      "holding",
    ]);
  });

  it("clamps a drop past the end rather than refusing it", () => {
    const dropped = dropRunbook(defaultRunbook(), "holding", 99);
    assert.equal(runbookIncluded(dropped).at(-1), "holding");
  });

  it("takes a segment out and puts it back", () => {
    const out = toggleRunbook(defaultRunbook(), "arcade");
    assert.deepEqual(runbookIncluded(out), ["holding", "trivia", "standings"]);
    assert.deepEqual(
      runbookIncluded(toggleRunbook(out, "arcade")),
      runbookIncluded(defaultRunbook()),
    );
  });

  it("refuses to take the last segment out, and says which one that is", () => {
    let book = defaultRunbook();
    for (const kind of ["holding", "trivia", "arcade"] as const) {
      book = toggleRunbook(book, kind);
    }
    assert.deepEqual(runbookIncluded(book), ["standings"]);
    assert.equal(isLastIncludedSegment(book, "standings"), true);
    assert.equal(toggleRunbook(book, "standings"), book);
    assert.deepEqual(runbookIncluded(book), ["standings"]);
  });

  it("does not call a segment the last one when it is already out", () => {
    const book = toggleRunbook(defaultRunbook(), "arcade");
    assert.equal(isLastIncludedSegment(book, "arcade"), false);
  });

  it("lists every segment for the rail, in or out", () => {
    const book = toggleRunbook(defaultRunbook(), "trivia");
    assert.deepEqual(
      runbookRail(book).map((e) => [e.kind, e.included]),
      [
        ["lobby", true],
        ["holding", true],
        ["trivia", false],
        ["arcade", true],
        ["standings", true],
        ["sendoff", false],
        ["final", true],
      ],
    );
  });
});

describe("what the space bar does next", () => {
  it("walks the host's order", () => {
    const book = moveRunbook(defaultRunbook(), "standings", -1);
    assert.equal(nextInRunbook(book, "lobby"), "holding");
    assert.equal(nextInRunbook(book, "trivia"), "standings");
    assert.equal(nextInRunbook(book, "standings"), "arcade");
    assert.equal(nextInRunbook(book, "arcade"), "final");
  });

  it("skips what the host took out", () => {
    const book = toggleRunbook(defaultRunbook(), "trivia");
    assert.equal(nextInRunbook(book, "holding"), "arcade");
  });

  it("does not strand a host who jumped to a segment they took out", () => {
    const book = toggleRunbook(defaultRunbook(), "trivia");
    assert.equal(nextInRunbook(book, "trivia"), "arcade");
  });

  it("has nothing queued after the final", () => {
    assert.equal(nextInRunbook(defaultRunbook(), "final"), null);
  });

  it("offers the front when the current segment is not in the book at all", () => {
    const book: never[] = [];
    assert.equal(nextInRunbook(book, "trivia"), "lobby");
  });

  it("reads back as a sentence for the checklist", () => {
    assert.equal(
      runbookSummary(defaultRunbook(), LABEL),
      "Holding card, Trivia, Arcade, then Standings",
    );
    assert.equal(
      runbookSummary(
        toggleRunbook(
          toggleRunbook(toggleRunbook(defaultRunbook(), "holding"), "trivia"),
          "arcade",
        ),
        LABEL,
      ),
      "Standings",
    );
  });
});

describe("the runbook across a refresh", () => {
  it("round-trips through JSON", () => {
    const book = toggleRunbook(moveRunbook(defaultRunbook(), "arcade", -1), "holding");
    assert.deepEqual(parseRunbook(JSON.stringify(book)), book);
  });

  it("accepts the wrapped shape as well as a bare list", () => {
    const book = defaultRunbook();
    assert.deepEqual(parseRunbook(JSON.stringify({ book })), book);
  });

  it("gives the default runbook back for anything unusable", () => {
    assert.equal(parseRunbook(null), null);
    assert.equal(parseRunbook(""), null);
    assert.equal(parseRunbook("{"), null);
    assert.equal(parseRunbook("42"), null);
  });

  it("appends a segment the stored order has never heard of", () => {
    const stored = JSON.stringify([{ kind: "trivia", included: true }]);
    const book = parseRunbook(stored);
    assert.ok(book);
    assert.deepEqual(
      book.map((e) => e.kind),
      ["trivia", "holding", "arcade", "standings", "sendoff"],
    );
    // Appended the way the default has it: in the rail, out of the order.
    assert.equal(book.find((e) => e.kind === "sendoff")?.included, false);
  });

  it("drops entries that are not segments, and duplicates", () => {
    const stored = JSON.stringify([
      { kind: "trivia", included: true },
      { kind: "trivia", included: false },
      { kind: "lobby", included: true },
      { kind: "nonsense", included: true },
      "nope",
      null,
    ]);
    const book = parseRunbook(stored);
    assert.ok(book);
    assert.deepEqual(
      book.map((e) => e.kind),
      ["trivia", "holding", "arcade", "standings", "sendoff"],
    );
    assert.equal(book[0]?.included, true);
  });

  it("refuses to restore a stored runbook with nothing in it", () => {
    const stored = JSON.stringify(
      RUNBOOK_MOVABLE.map((kind) => ({ kind, included: false })),
    );
    const book = parseRunbook(stored);
    assert.ok(book);
    assert.deepEqual(runbookIncluded(book), [...RUNBOOK_MOVABLE]);
  });
});


/*
 * An afternoon with two off-platform stretches in it: the TTX before trivia
 * and the coffee break after the arcade. Both are holding steps, they are not
 * interchangeable, and the space bar has to tell them apart — which is the
 * whole reason a step has an id.
 */
describe("more than one holding step", () => {
  function twoHoldings(): Runbook {
    // Lobby · TTX · Trivia · Arcade · Coffee · Standings · Final
    // A new step lands last, which is now behind the send-off as well as the
    // standings, so it walks up two places rather than one.
    let book = setEntryCard(defaultRunbook(), "holding", "card-1");
    book = addHoldingStep(book, "card-2");
    book = moveRunbook(book, "step-6", -1);
    book = moveRunbook(book, "step-6", -1);
    return book;
  }

  it("holds two steps of the same kind, each with its own card", () => {
    const book = twoHoldings();
    assert.deepEqual(
      book.map((e) => [e.kind, e.id, e.card ?? null]),
      [
        ["holding", "holding", "card-1"],
        ["trivia", "trivia", null],
        ["arcade", "arcade", null],
        ["holding", "step-6", "card-2"],
        ["standings", "standings", null],
        ["sendoff", "sendoff", null],
      ],
    );
  });

  it("walks both of them, in order, on the space bar", () => {
    const book = twoHoldings();
    const walk: string[] = [];
    let at: string | null = "lobby";
    for (let i = 0; i < 10; i += 1) {
      const next = nextEntryAfter(book, at);
      if (next === null) break;
      walk.push(next.id);
      at = next.id;
    }
    assert.deepEqual(walk, [
      "holding",
      "trivia",
      "arcade",
      "step-6",
      "standings",
      "final",
    ]);
  });

  it("numbers the steps by position, not by kind", () => {
    const book = twoHoldings();
    assert.deepEqual(
      runbookIncludedEntries(book).map((e) => e.id),
      ["holding", "trivia", "arcade", "step-6", "standings"],
    );
  });

  it("takes one holding step out without touching the other", () => {
    const book = toggleRunbook(twoHoldings(), "step-6");
    assert.deepEqual(runbookIncluded(book), [
      "holding",
      "trivia",
      "arcade",
      "standings",
    ]);
    assert.equal(nextEntryAfter(book, "arcade")?.id, "standings");
    // Still in the rail, still one click away.
    assert.equal(entryById(book, "step-6")?.included, false);
  });

  it("moves and drops the right one when two rows are the same kind", () => {
    const moved = moveRunbook(twoHoldings(), "step-6", -1);
    assert.deepEqual(
      moved.map((e) => e.id),
      ["holding", "trivia", "step-6", "arcade", "standings", "sendoff"],
    );
    const dropped = dropRunbook(twoHoldings(), "step-6", 0);
    assert.deepEqual(
      dropped.map((e) => e.id),
      ["step-6", "holding", "trivia", "arcade", "standings", "sendoff"],
    );
  });

  it("deletes a step the host added, and never one the product ships with", () => {
    const book = twoHoldings();
    assert.equal(isRemovableStep(entryById(book, "step-6")!), true);
    assert.equal(isRemovableStep(entryById(book, "holding")!), false);
    assert.deepEqual(
      removeStep(book, "step-6").map((e) => e.id),
      ["holding", "trivia", "arcade", "standings", "sendoff"],
    );
    assert.equal(removeStep(book, "holding"), book);
  });

  it("keeps at least one step in, even when deleting one", () => {
    let book = defaultRunbook();
    book = addHoldingStep(book, "card-2");
    for (const id of ["holding", "trivia", "arcade", "standings"]) {
      book = toggleRunbook(book, id);
    }
    assert.deepEqual(runbookIncluded(book), ["holding"]);
    const only = book.find((e) => e.included);
    assert.equal(only?.id, "step-6");
    assert.equal(removeStep(book, "step-6"), book);
  });

  it("gives every added step an id nothing else is using", () => {
    let book = defaultRunbook();
    book = addHoldingStep(book, "card-1");
    book = addHoldingStep(book, "card-1");
    const ids = book.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(freshStepId(book), "step-8");
  });

  it("stops at a ceiling rather than a rail nobody can read", () => {
    let book = defaultRunbook();
    for (let i = 0; i < HOLDING_STEPS_MAX + 4; i += 1) {
      book = addHoldingStep(book, "card-1");
    }
    assert.equal(holdingSteps(book).length, HOLDING_STEPS_MAX);
    assert.equal(addHoldingStep(book, "card-1"), book);
  });

  it("points a step at a different card, and only a holding step", () => {
    const book = setEntryCard(twoHoldings(), "step-6", "card-3");
    assert.equal(entryById(book, "step-6")?.card, "card-3");
    assert.equal(entryById(setEntryCard(book, "trivia", "card-3"), "trivia")?.card, undefined);
  });

  it("falls back to the front when the step it was on has been deleted", () => {
    const book = removeStep(twoHoldings(), "step-6");
    assert.equal(nextEntryAfter(book, "step-6")?.id, "lobby");
    assert.equal(nextEntryAfter(book, null)?.id, "lobby");
  });
});

describe("a runbook stored by the build that had one holding card", () => {
  it("reads back unchanged, because the ids it never wrote are the kinds", () => {
    const stored = JSON.stringify([
      { kind: "holding", included: true },
      { kind: "trivia", included: true },
      { kind: "arcade", included: false },
      { kind: "standings", included: true },
    ]);
    const book = parseRunbook(stored);
    assert.ok(book);
    assert.deepEqual(
      book.map((e) => [e.kind, e.id, e.included]),
      [
        ["holding", "holding", true],
        ["trivia", "trivia", true],
        ["arcade", "arcade", false],
        ["standings", "standings", true],
        // Appended by this build, out of the order: a runbook written before
        // the send-off existed must not gain a step the host never chose.
        ["sendoff", "sendoff", false],
      ],
    );
  });

  it("anchors its holding step to the card the old key migrated into", () => {
    const stored = parseRunbook(
      JSON.stringify([{ kind: "holding", included: true }]),
    );
    assert.ok(stored);
    const book = anchorHoldingCards(stored, "card-1");
    assert.equal(entryById(book, "holding")?.card, "card-1");
    // Idempotent: a second pass changes nothing and does not re-point a step
    // the host has since pointed somewhere else.
    assert.equal(anchorHoldingCards(book, "card-9"), book);
  });

  it("round-trips a book with two holding steps through JSON", () => {
    let book = setEntryCard(defaultRunbook(), "holding", "card-1");
    book = addHoldingStep(book, "card-2");
    assert.deepEqual(parseRunbook(JSON.stringify(book)), book);
  });

  it("keeps two holding steps apart across a refresh", () => {
    const book = parseRunbook(
      JSON.stringify([
        { kind: "holding", included: true, id: "holding", card: "card-1" },
        { kind: "holding", included: true, id: "step-5", card: "card-2" },
      ]),
    );
    assert.ok(book);
    assert.deepEqual(
      book.map((e) => e.id),
      ["holding", "step-5", "trivia", "arcade", "standings", "sendoff"],
    );
  });

  it("still refuses two rows with the same id", () => {
    const book = parseRunbook(
      JSON.stringify([
        { kind: "holding", included: true, id: "step-5", card: "card-1" },
        { kind: "holding", included: false, id: "step-5", card: "card-2" },
      ]),
    );
    assert.ok(book);
    assert.equal(book.filter((e) => e.id === "step-5").length, 1);
    assert.equal(entryById(book, "step-5")?.card, "card-1");
  });
});

describe("the preview column's width", () => {
  it("clamps to something the preview and the grid can both live with", () => {
    assert.equal(clampTray(10), TRAY_MIN);
    assert.equal(clampTray(9999), TRAY_MAX);
    assert.equal(clampTray(320), 320);
    assert.equal(clampTray(Number.NaN), TRAY_MIN);
  });

  it("reads a stored width, and ignores junk", () => {
    assert.equal(parseTrayWidth("360"), 360);
    assert.equal(parseTrayWidth("9999"), TRAY_MAX);
    assert.equal(parseTrayWidth("nope"), null);
    assert.equal(parseTrayWidth(""), null);
    assert.equal(parseTrayWidth(null), null);
    assert.equal(parseTrayWidth("-5"), null);
  });
});
