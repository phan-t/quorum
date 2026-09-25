/**
 * The question-file importer.
 *
 * The bias throughout: a file that is wrong must fail *here*, with a message
 * naming the question and the key, rather than load and be discovered live.
 * So most of these tests are about rejection, and several of them are about
 * rejecting things a laxer parser would happily accept.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { formatErrors, importTriviaJson } from "./import.ts";

function ok(text: string) {
  const result = importTriviaJson(text);
  assert.ok(result.ok, `expected a load, got: ${result.ok ? "" : formatErrors(result.errors).join(" / ")}`);
  return result.questions;
}

function errs(text: string): string[] {
  const result = importTriviaJson(text);
  assert.ok(!result.ok, "expected a rejection");
  return formatErrors(result.errors);
}

const ONE = {
  text: "In what year was HashiCorp founded?",
  answers: ["2008", "2010", "2012", "2015"],
  correct: "C",
  timeLimitSec: 20,
};

/** The wrapped file, with `ONE` patched by the caller. */
function file(patch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ questions: [{ ...ONE, ...patch }], ...extra });
}

describe("what loads", () => {
  it("reads the wrapped shape", () => {
    const qs = ok(JSON.stringify({ title: "HashiCorp & IBM trivia", questions: [ONE] }));
    assert.equal(qs.length, 1);
    assert.equal(qs[0]?.text, ONE.text);
    assert.deepEqual(qs[0]?.answers, ONE.answers);
    assert.equal(qs[0]?.timeLimitSec, 20);
  });

  it("reads a bare list too", () => {
    assert.equal(ok(JSON.stringify([ONE, { ...ONE, text: "Another?" }])).length, 2);
  });

  it("turns the answer's letter into a 0-based index, once", () => {
    assert.deepEqual(ok(file({ correct: "A" }))[0]?.correct, [0]);
    assert.deepEqual(ok(file({ correct: "D" }))[0]?.correct, [3]);
  });

  it("accepts several correct answers, sorted and deduplicated", () => {
    assert.deepEqual(ok(file({ correct: ["D", "A", "D"] }))[0]?.correct, [0, 3]);
  });

  it("is not fussy about the letter's case or its whitespace", () => {
    assert.deepEqual(ok(file({ correct: " c " }))[0]?.correct, [2]);
  });

  it("allows two and three answers", () => {
    assert.equal(ok(file({ answers: ["Yes", "No"], correct: "B" }))[0]?.answers.length, 2);
    assert.equal(ok(file({ answers: ["a", "b", "c"], correct: "C" }))[0]?.answers.length, 3);
  });

  it("trims text and answers", () => {
    const q = ok(file({ text: "  Padded?  ", answers: [" 2008 ", "2010"], correct: "A" }))[0];
    assert.equal(q?.text, "Padded?");
    assert.deepEqual(q?.answers, ["2008", "2010"]);
  });

  it("defaults the optional keys", () => {
    const q = ok(file())[0];
    assert.equal(q?.note, null);
    assert.equal(q?.round, null);
    assert.equal(q?.basePoints, 1000);
    assert.equal(q?.tiebreak, undefined);
  });

  it("carries note, round, basePoints and tiebreak when given", () => {
    const q = ok(file({ note: " Founded in Seattle. ", round: "History", basePoints: 500, tiebreak: true }))[0];
    assert.equal(q?.note, "Founded in Seattle.");
    assert.equal(q?.round, "History");
    assert.equal(q?.basePoints, 500);
    assert.equal(q?.tiebreak, true);
  });

  it("leaves tiebreak off rather than false, so an old set serialises unchanged", () => {
    assert.ok(!("tiebreak" in (ok(file({ tiebreak: false }))[0] ?? {})));
  });

  it("keeps 0 base points, which SPEC calls a warm-up", () => {
    assert.equal(ok(file({ basePoints: 0 }))[0]?.basePoints, 0);
  });

  it("treats an explicit null note or round as absent", () => {
    const q = ok(file({ note: null, round: null }))[0];
    assert.equal(q?.note, null);
    assert.equal(q?.round, null);
  });
});

describe("what is refused", () => {
  it("names the JSON error rather than saying the file is bad", () => {
    assert.match(errs("{ nope")[0] ?? "", /not valid JSON/);
  });

  it("refuses a file that is neither an object nor a list", () => {
    assert.match(errs('"just a string"')[0] ?? "", /must be an object/);
  });

  it("refuses a file with no questions list", () => {
    assert.match(errs('{"title":"x"}')[0] ?? "", /no "questions" list/);
  });

  it("refuses an empty set", () => {
    assert.match(errs('{"questions":[]}')[0] ?? "", /no questions/);
  });

  it("refuses a top-level key nothing reads", () => {
    assert.match(errs(file({}, { rounds: [] }))[0] ?? "", /"rounds" key, which nothing reads/);
  });

  it("refuses a misspelled question key rather than defaulting it", () => {
    // The whole point: "timelimitSec" silently defaulting is how a 20-second
    // question becomes something else in front of the room.
    assert.match(errs(file({ timelimitSec: 30 }))[0] ?? "", /Nothing reads a "timelimitSec" key/);
  });

  it("addresses errors by the question's position", () => {
    const text = JSON.stringify({ questions: [ONE, { ...ONE, correct: "Z" }] });
    assert.match(errs(text)[0] ?? "", /^Question 2, correct:/);
  });

  it("refuses a number where a letter belongs, and refuses to guess which", () => {
    // The CSV counted from 1 and the engine counts from 0, so a bare 2 is "B"
    // to the author and "C" to the code. Naming one would be a confident wrong
    // answer in the one place this format exists to make impossible.
    const m = errs(file({ correct: 2 }))[0] ?? "";
    assert.match(m, /not a number/);
    assert.match(m, /from 1, as the old CSV did, 2 is "B"/);
    assert.match(m, /from 0 it is "C"/);
    assert.match(errs(file({ correct: [2] }))[0] ?? "", /from 1, as the old CSV did, 2 is "B"/);
  });

  it("still refuses a number with no sensible reading either way", () => {
    const m = errs(file({ correct: 9 }))[0] ?? "";
    assert.match(m, /Use the answer's letter, not a number\. Write the one you mean\./);
  });

  it("refuses a letter past the answers given", () => {
    assert.match(errs(file({ answers: ["a", "b"], correct: "D" }))[0] ?? "", /no answer D; this question has 2/);
  });

  it("refuses a letter that is not one", () => {
    assert.match(errs(file({ correct: "E" }))[0] ?? "", /not an answer letter/);
  });

  it("refuses a missing or empty correct", () => {
    assert.match(errs(file({ correct: undefined }))[0] ?? "", /Missing/);
    assert.match(errs(file({ correct: [] }))[0] ?? "", /No correct answer is marked/);
  });

  it("refuses one answer, and five", () => {
    assert.match(errs(file({ answers: ["only"], correct: "A" }))[0] ?? "", /at least 2 answers/);
    assert.match(errs(file({ answers: ["a", "b", "c", "d", "e"], correct: "A" }))[0] ?? "", /the most is 4/);
  });

  it("refuses a blank answer rather than shifting the letters", () => {
    assert.match(errs(file({ answers: ["a", "", "c"], correct: "A" }))[0] ?? "", /Answer B is blank/);
  });

  it("refuses two answers that read the same", () => {
    // Whichever is marked, the reveal contradicts half the room.
    assert.match(errs(file({ answers: ["Consul", "consul"], correct: "A" }))[0] ?? "", /appears twice/);
  });

  it("refuses a blank or missing question", () => {
    assert.match(errs(file({ text: "   " }))[0] ?? "", /blank/);
    assert.match(errs(file({ text: undefined }))[0] ?? "", /Missing, or not a string/);
  });

  it("refuses a timer outside the range, and one that is not whole", () => {
    assert.match(errs(file({ timeLimitSec: 3 }))[0] ?? "", /outside 5–120/);
    assert.match(errs(file({ timeLimitSec: 200 }))[0] ?? "", /outside 5–120/);
    assert.match(errs(file({ timeLimitSec: 20.5 }))[0] ?? "", /not a whole number/);
    assert.match(errs(file({ timeLimitSec: "20" }))[0] ?? "", /not a whole number/);
  });

  it("refuses over-long text, counting code points", () => {
    assert.match(errs(file({ text: "x".repeat(201) }))[0] ?? "", /201 characters/);
    // Four astral code points, not eight UTF-16 units.
    assert.equal(ok(file({ text: "🎉".repeat(200) }))[0]?.text.length, 400);
    assert.match(errs(file({ text: "🎉".repeat(201) }))[0] ?? "", /201 characters/);
  });

  it("refuses an over-long answer", () => {
    assert.match(errs(file({ answers: ["x".repeat(81), "b"], correct: "B" }))[0] ?? "", /81 characters/);
  });

  it("refuses a non-boolean tiebreak and negative points", () => {
    assert.match(errs(file({ tiebreak: "yes" }))[0] ?? "", /is not true or false/);
    assert.match(errs(file({ basePoints: -1 }))[0] ?? "", /not a whole number of points/);
  });

  it("reports every problem at once, not just the first", () => {
    const text = JSON.stringify({
      questions: [{ ...ONE, correct: "Z" }, { ...ONE, timeLimitSec: 1 }, { ...ONE, text: "" }],
    });
    const lines = errs(text);
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? "", /^Question 1,/);
    assert.match(lines[1] ?? "", /^Question 2,/);
    assert.match(lines[2] ?? "", /^Question 3,/);
  });

  it("loads nothing at all when one question is wrong", () => {
    const result = importTriviaJson(JSON.stringify({ questions: [ONE, { ...ONE, correct: "Z" }] }));
    assert.ok(!result.ok);
  });
});

describe("the committed example set", () => {
  // The example the README points people at. If it stops loading, the thing we
  // tell people to copy is broken.
  const text = readFileSync(
    new URL("../../../config/event.example/trivia-questions.json", import.meta.url),
    "utf8",
  );

  it("loads", () => {
    assert.equal(ok(text).length, 40);
  });

  it("marks exactly one correct answer per question, inside its own answers", () => {
    for (const [i, q] of ok(text).entries()) {
      assert.equal(q.correct.length, 1, `question ${i + 1}`);
      const at = q.correct[0] ?? -1;
      assert.ok(at >= 0 && at < q.answers.length, `question ${i + 1} points outside its answers`);
    }
  });

  it("round-trips: what it loads re-exports and loads the same", () => {
    const first = ok(text);
    const letters = ["A", "B", "C", "D"];
    const again = ok(
      JSON.stringify({
        questions: first.map((q) => ({
          text: q.text,
          answers: q.answers,
          correct: q.correct.map((c) => letters[c]),
          timeLimitSec: q.timeLimitSec,
        })),
      }),
    );
    assert.deepEqual(again, first);
  });
});
