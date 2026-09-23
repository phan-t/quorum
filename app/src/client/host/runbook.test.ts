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
  RUNBOOK_MOVABLE,
  TRAY_MAX,
  TRAY_MIN,
  clampTray,
  defaultRunbook,
  dropRunbook,
  isLastIncludedSegment,
  moveRunbook,
  nextInRunbook,
  parseRunbook,
  parseTrayWidth,
  runbookIncluded,
  runbookOrder,
  runbookRail,
  runbookSummary,
  toggleRunbook,
} from "./runbook.ts";

const LABEL: Readonly<Record<Segment, string>> = {
  lobby: "Lobby",
  holding: "Holding card",
  trivia: "Trivia",
  arcade: "Arcade",
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
    assert.equal(moveRunbook(book, "standings", 1), book);
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
    assert.deepEqual(runbookIncluded(toggleRunbook(out, "arcade")), [
      ...RUNBOOK_MOVABLE,
    ]);
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
      ["trivia", "holding", "arcade", "standings"],
    );
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
      ["trivia", "holding", "arcade", "standings"],
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
