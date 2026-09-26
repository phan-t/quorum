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
  //
  // What this block is allowed to assert is the point of it. These are the
  // *invariants* a question set has to satisfy — it parses, one correct answer
  // each, a round card behind every scored question, timers the room can live
  // with — and nothing here is a transcription of what the file happens to say
  // today. The example is content: it gets reordered, retimed and rewritten,
  // and none of that should be a build break (issue #2). The arithmetic that
  // used to be pinned to this file now plays the frozen fixture in
  // `bots/acceptance-set.ts`, and the file itself is played, content and all,
  // by the second `describe` in `bots/trivia-round.test.ts`.
  const text = readFileSync(
    new URL("../../../config/event.example/trivia-questions.json", import.meta.url),
    "utf8",
  );

  /**
   * The correct answer of every question, read off the file by a person.
   *
   * This is a transcription, which the block header above says this file does
   * not do — and the exception is deliberate, because removing it lost real
   * coverage. Decoupling the acceptance test from this file (issue #2) moved
   * the bots onto a frozen fixture, and everything that now checks the example
   * derives its expectations *from the example*. A `correct` letter changed
   * from C to B is then perfectly self-consistent: the file loads, the letter
   * is inside the answer list, exactly one answer is marked, the round plays,
   * and every score agrees with itself. Nothing noticed. An adversarial review
   * of that commit found it by mutation, and it is the one class that got
   * worse rather than better.
   *
   * A second human reading is the only thing that can catch it, which is what
   * this is. It is keyed by question text rather than by index so that
   * reordering the file — the content edit issue #2 exists to allow — does not
   * touch it; only changing an *answer* does, and changing an answer should
   * be a deliberate act with a test to match.
   */
  const CORRECT: ReadonlyArray<readonly [string, string, string]> = [
    ["In what year was HashiCorp founded", "C", "2012"],
    ["Which was HashiCorp's first product", "B", "Vagrant"],
    ["Who co-founded HashiCorp with Armon Dadgar", "A", "Mitchell Hashimoto"],
    ["What is HashiCorp's published product design", "B", "The Tao of HashiCorp"],
    ["Which HashiCorp product was released first", "B", "Consul"],
    ["Which two products were announced together", "B", "Boundary & Waypoint"],
    ["Which language are Terraform, Vault, Consul", "B", "Go"],
    ["What is HashiCorp's policy-as-code framework", "C", "Sentinel"],
    ["In Vagrant, what is a packaged base image", "C", "A box"],
    ["Which consensus protocol backs integrated", "B", "Raft"],
    ["What is IBM's long-standing nickname", "B", "Big Blue"],
    ["Which port does Vault's HTTP API listen on", "B", "8200"],
    ["By default, Vault splits its unseal key", "C", "Shamir's Secret Sharing"],
    ["What best describes a Vault dynamic secret", "B", "A credential generated on demand, with a lease"],
    ["In Nomad, what is the set of tasks", "B", "A task group"],
    ["Which product scans code and systems for l", "B", "Vault Radar"],
    ["Which licence did HashiCorp adopt", "C", "Business Source License"],
    ["Which open-source fork of Terraform", "B", "OpenTofu"],
    ["In April 2024, Terraform Cloud was renamed", "B", "HCP Terraform"],
    ["In which year did IBM complete its acquisi", "C", "2025"],
    ["Which programming language was developed a", "C", "Fortran"],
    ["Where is IBM's corporate headquarters", "B", "Armonk, New York"],
    ["Which company did IBM acquire for about", "B", "Red Hat"],
    ["IBM's Deep Blue defeated which world chess", "C", "Garry Kasparov"],
    ["Which is the world's southernmost capital", "B", "Wellington"],
    ["The Merlion is the landmark of which city", "C", "Singapore"],
    ["Which of these countries has the largest l", "C", "Australia"],
    ["In Japan, \"Golden Week\" falls across which", "B", "April\u2013May"],
  ];

  it("marks the answer a person reading the file would mark", () => {
    // `ok` returns every question, tiebreakers included and flagged; the split
    // into a scored set and a sudden-death pool happens downstream. So this
    // reads the whole file, which is what a person transcribing it did.
    const all = ok(text);
    // Every question in the file is named above, so a question *added* to the
    // example fails here until somebody reads it and writes down its answer.
    // That is the intent: adding a question is a content edit, and vouching
    // for its answer is the one part of it a second person should do.
    assert.equal(
      all.length,
      CORRECT.length,
      "a question was added or removed: read it and record its answer above",
    );
    for (const [stem, letter, answer] of CORRECT) {
      const q = all.find((x) => x.text.startsWith(stem));
      assert.ok(q, `no question starts with ${JSON.stringify(stem)}`);
      // `correct` is a list of indices — the importer allows more than one in
      // principle, and a separate test asserts the example marks exactly one.
      const marked = "ABCDEFGH"[q.correct[0] ?? -1];
      assert.equal(
        marked,
        letter,
        `${stem}…: the file marks ${marked}, a reader marked ${letter}`,
      );
      // The letter and the text are transcribed separately on purpose: a
      // reordered answer list moves the letter without changing which answer
      // is right, and only checking both catches the reorder that silently
      // re-points the letter at a different answer.
      assert.equal(
        q.answers[q.correct[0] ?? -1],
        answer,
        `${stem}…: answer ${marked} is not what a reader recorded`,
      );
    }
  });

  it("loads", () => {
    // No count asserted here on purpose: adding a question is a content edit,
    // and a content edit that has to be mirrored by a literal under `app/src`
    // is exactly what this file stopped doing. The one count worth pinning is
    // the game's shape, below, and it is pinned because three documents state
    // it in prose.
    assert.ok(ok(text).length > 0);
  });

  it("is a 24-question game with four tiebreakers behind it", () => {
    // The two numbers are the shape `docs/running-an-event.md` builds a
    // fifteen-minute slot around, `config/README.md` and
    // `config/event.example/README.md` both state them, and they are separate
    // on purpose: a tiebreaker is lifted out of the scored set, so flagging
    // four does not make the game twenty-eight questions long. The example is
    // what every event gets copied from, so if it drifts back to forty the
    // drift is here — and changing these is a decision that has to be written
    // down in those three documents too, which is why it is pinned while the
    // questions themselves are free to move.
    const loaded = ok(text);
    assert.equal(loaded.filter((q) => q.tiebreak !== true).length, 24);
    assert.equal(loaded.filter((q) => q.tiebreak === true).length, 4);
  });

  it("carries the notes and the round cards the reveal is for", () => {
    // SPEC calls `note` "the bit people learn from", and a set with none is a
    // set where a lit tile is the whole reveal. Round values are what put a
    // card up in front of the room, so every scored question needs one; a
    // tiebreaker is never part of a round and must not claim to be.
    const loaded = ok(text);
    assert.ok(
      loaded.filter((q) => q.note !== null).length >= 10,
      "at least ten questions carry a note",
    );
    for (const [i, q] of loaded.entries()) {
      if (q.tiebreak === true) assert.equal(q.round, null, `question ${i + 1} is a tiebreaker`);
      else assert.ok(q.round !== null, `question ${i + 1} has no round`);
    }
  });

  it("gives nothing in the file longer than twenty seconds", () => {
    // The audience answers most of these on sight, and a timer they have
    // already beaten is dead air the host has to talk over. The tiebreakers are
    // held to the same bound even though sudden death never reads the field,
    // because a 30 in the file reads as a considered 30 to whoever edits it
    // next and this set has nothing that needs one.
    for (const [i, q] of ok(text).entries()) {
      assert.ok(q.timeLimitSec >= 10, `question ${i + 1} is under ten seconds`);
      assert.ok(q.timeLimitSec <= 20, `question ${i + 1} runs ${q.timeLimitSec}s`);
    }
  });

  it("marks exactly one correct answer per question, inside its own answers", () => {
    for (const [i, q] of ok(text).entries()) {
      assert.equal(q.correct.length, 1, `question ${i + 1}`);
      const at = q.correct[0] ?? -1;
      assert.ok(at >= 0 && at < q.answers.length, `question ${i + 1} points outside its answers`);
    }
  });

  it("offers four answers on every question and leaves basePoints alone", () => {
    // SPEC's "Trivia" describes the game as four answers with shape and colour
    // and the phone is laid out for four, so the worked example shows the full
    // shape even though the importer accepts two and three for a set that needs
    // them. `basePoints` is the other half of the same choice, recorded in
    // `config/event.example/README.md`: the example deliberately sets none, so
    // every question is worth the same 1000 before speed weighting and a host
    // reading the file can see the scoring without doing any sums.
    for (const [i, q] of ok(text).entries()) {
      assert.equal(q.answers.length, 4, `question ${i + 1} offers ${q.answers.length} answers`);
      assert.equal(q.basePoints, 1000, `question ${i + 1} overrides basePoints`);
    }
  });

  it("asks each question once, however the set is ordered", () => {
    // Reordering and rewriting this file is meant to be a content-only edit,
    // and the edit that goes wrong that way is a paste that leaves a question in
    // twice. Two identical stems are a tile the room has already seen and a
    // second helping of points for whoever remembers the first.
    const stems = ok(text).map((q) => q.text.toLowerCase());
    assert.equal(new Set(stems).size, stems.length, "a question stem appears twice");
  });

  it("round-trips: what it loads re-exports and loads the same", () => {
    const first = ok(text);
    const letters = ["A", "B", "C", "D"];
    const again = ok(
      JSON.stringify({
        // Every optional key goes back out as well, because the round trip is
        // only worth anything if it carries what the file actually says. An
        // export that dropped `note` and `round` would still load and would
        // still be a quiz — just a silent one with no round cards.
        questions: first.map((q) => ({
          text: q.text,
          answers: q.answers,
          correct: q.correct.map((c) => letters[c]),
          timeLimitSec: q.timeLimitSec,
          ...(q.note === null ? {} : { note: q.note }),
          ...(q.round === null ? {} : { round: q.round }),
          ...(q.tiebreak === true ? { tiebreak: true } : {}),
        })),
      }),
    );
    assert.deepEqual(again, first);
  });
});
