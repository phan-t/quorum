/**
 * The built-in sudden-death pool, checked against the set that ships.
 *
 * The pool is drawn on by an event whose file flags no tiebreakers of its own,
 * so it is asked alongside a scored set nobody compared it to. It once asked
 * Raft, Vault's default API port and policy-as-code, all three of which
 * `config/event.example/trivia-questions.json` also asks — and a tie settled by
 * re-asking a question the room answered twenty minutes earlier is the one
 * thing sudden death must not be. These tests are the check nobody did.
 *
 * The example set is read through the real importer rather than parsed here,
 * because the importer is what turns a `"correct": "B"` into an index and the
 * comparison below is on the answer, not on the file.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Question } from "./types.ts";
import { DEFAULT_TIEBREAKERS } from "./tiebreak.ts";
import { formatErrors, importTriviaJson } from "../trivia/import.ts";

/**
 * The committed example, the file `config/README.md` tells a host to copy.
 *
 * Another event's file is not checked and cannot be — it is gitignored content
 * we never see. This is the one set we ship, so it is the one collision we can
 * be held to.
 */
const COMMITTED: readonly Question[] = (() => {
  const text = readFileSync(
    new URL("../../../config/event.example/trivia-questions.json", import.meta.url),
    "utf8",
  );
  const result = importTriviaJson(text);
  assert.ok(result.ok, `the committed example stopped loading: ${result.ok ? "" : formatErrors(result.errors).join(" / ")}`);
  return result.questions;
})();

/**
 * Case, punctuation and a leading article are not differences worth having.
 *
 * "The Pacific" and "Pacific" are the same answer shouted across a room, and a
 * comparison that treats them as distinct is a comparison that passes while the
 * collision it exists for sits in the file.
 */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Every answer a question can be won with, normalised. */
function correctAnswers(q: Question): string[] {
  return q.correct.map((i) => normalise(q.answers[i] ?? ""));
}

/** Every option a question offers, normalised. */
function options(q: Question): Set<string> {
  return new Set(q.answers.map(normalise));
}

describe("the built-in pool does not re-ask the committed set", () => {
  // Both of these compare answers rather than question text, and that is the
  // point: the collision that prompted them was a *reworded* question —
  // "Which consensus protocol backs Vault's, Consul's and Nomad's integrated
  // storage?" against "Which consensus protocol backs integrated storage in
  // Vault, Consul and Nomad?" — and no string comparison of the two stems, not
  // even a fuzzy one, would have separated them from two honestly different
  // questions.
  //
  // What they catch: the same fact asked in different words, the same fact
  // asked with different distractors, and an option list rebuilt around a
  // different correct answer.
  //
  // What they cannot catch: two questions about the same subject with genuinely
  // different answers (Vault's port here, Consul's port there), an answer
  // paraphrased past normalisation ("Raft" against "the Raft protocol"), and
  // any collision with an event file under `config/events/`, which is real
  // people's content and is never in the repository. They are a floor, not a
  // proof — a human still reads the pool next to the set.

  test("the two sets are both non-empty, so nothing here passes vacuously", () => {
    assert.ok(DEFAULT_TIEBREAKERS.length > 0, "the pool is empty");
    assert.ok(COMMITTED.length > 20, `the committed example has ${COMMITTED.length} questions`);
  });

  test("no pool question is won with an answer the committed set is won with", () => {
    const shipped = new Map<string, string>();
    for (const q of COMMITTED) {
      for (const answer of correctAnswers(q)) shipped.set(answer, q.text);
    }
    for (const q of DEFAULT_TIEBREAKERS) {
      for (const answer of correctAnswers(q)) {
        const clash = shipped.get(answer);
        assert.equal(
          clash,
          undefined,
          `"${q.text}" is won with the same answer as "${clash}" — the room has heard it`,
        );
      }
    }
  });

  test("no pool question is built from the committed set's options", () => {
    // Three of four shared, rather than all four, because the Raft collision
    // shared exactly three — both asked Paxos / Raft / Zab and differed only on
    // the fourth distractor. A question that reaches three has been assembled
    // from the same shortlist, whichever option it marks correct.
    for (const q of DEFAULT_TIEBREAKERS) {
      const mine = options(q);
      for (const other of COMMITTED) {
        let shared = 0;
        for (const answer of options(other)) if (mine.has(answer)) shared += 1;
        assert.ok(
          shared < 3,
          `"${q.text}" shares ${shared} options with "${other.text}"`,
        );
      }
    }
  });

  test("the pool does not re-ask itself either", () => {
    // Two tiebreakers on one fact is a pool of four dressed as a pool of five,
    // and it fails in the same place: the second sudden death of a session.
    const seen = new Map<string, string>();
    for (const q of DEFAULT_TIEBREAKERS) {
      for (const answer of correctAnswers(q)) {
        const clash = seen.get(answer);
        assert.equal(clash, undefined, `"${q.text}" and "${clash}" have the same answer`);
        seen.set(answer, q.text);
      }
    }
  });
});
