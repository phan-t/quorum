/**
 * The built-in sudden-death pool.
 *
 * SCORING.md settles a tie with "sudden death — one question, first correct
 * answer wins, no points", and is emphatic that there is never a coin flip.
 * That promise is only keepable if the engine always has a question to ask,
 * and the honest place for a tiebreak question is **outside the scored set**:
 * a sudden death that consumes one of the twenty has changed the game it was
 * supposed to settle.
 *
 * So a loaded set may carry its own tiebreakers — questions the file flags
 * `tiebreak`, lifted out of the twenty by `loadTrivia` — and when it carries
 * none, which is the ordinary case, sudden death draws on these.
 *
 * ## Where this file should live
 *
 * With the rest of the trivia content, in `src/trivia/`, next to the importer
 * that will one day fill the pool from a CSV column. It is here because the
 * change that added it was fenced to `src/engine/` and `src/arcade/`, and a
 * default the engine depends on is worse absent than misfiled. Moving it is a
 * rename and an import.
 *
 * ## The content
 *
 * A tiebreak question is asked to two people who are already tied at the top,
 * in front of a room, with no timer. It wants to be decidable rather than
 * clever: a fact someone either knows or does not, with no rounding and no
 * "well it depends". These are all definitional or numeric, and none of them
 * turns on a date, a rebrand or an acquisition — the three things the trivia
 * bank's ⚠️ VERIFY flag exists for, and the three things most likely to have
 * moved since this was written.
 *
 * **None of them is about a product, and that is the constraint that matters
 * most here.** This pool is what an event whose file flags nothing draws on,
 * which means it is asked alongside a scored set it has never seen. It used to
 * ask Raft, Vault's default API port and policy-as-code, and the committed
 * example set asks all three of those in different words — so the tie the pool
 * existed to settle would have been settled by two finalists racing to retype
 * an answer the whole room heard twenty minutes earlier. Choosing less obvious
 * products does not fix that, because any product question is one that some
 * event's set may also ask; general knowledge is the only kind that cannot
 * collide with a product quiz at all. It is the same instinct as the question
 * bank's Round F, which is deliberately geography and culture rather than
 * product trivia, and tiebreak.test.ts holds the line against the committed
 * example.
 *
 * `basePoints: 0` is belt and braces. Sudden death settles to nothing anyway
 * — `settleQuestion` returns early on it — but a question that would score
 * nothing even if it were asked for points cannot be turned into a scored
 * question by a bug somewhere else.
 */

import type { Question } from "./types.ts";

/**
 * Five, which is four more than a session should ever need.
 *
 * Each is spent when it is asked, so a host who runs sudden death twice gets
 * two different questions, and a host who exhausts the pool gets a refusal
 * rather than a question the room has already heard the answer to.
 */
export const DEFAULT_TIEBREAKERS: readonly Question[] = [
  {
    text: "What is the capital of Canada?",
    answers: ["Toronto", "Vancouver", "Ottawa", "Montreal"],
    timeLimitSec: 30,
    correct: [2],
    note: "Ottawa. Toronto is the largest city and takes most of the room, which is the whole reason the question works.",
    round: null,
    basePoints: 0,
    tiebreak: true,
  },
  {
    text: "Mount Fuji stands on which of Japan's main islands?",
    answers: ["Hokkaido", "Honshu", "Kyushu", "Shikoku"],
    timeLimitSec: 30,
    correct: [1],
    note: "Honshu, about 100km south-west of Tokyo. All four really are main islands, so there is nothing to rule out by elimination.",
    round: null,
    basePoints: 0,
    tiebreak: true,
  },
  {
    text: "The deepest known point in the sea lies in which ocean?",
    answers: ["The Atlantic", "The Indian", "The Pacific", "The Southern"],
    timeLimitSec: 30,
    correct: [2],
    note: "The Pacific — Challenger Deep, at the south end of the Mariana Trench, just under 11,000m. Published depths for it differ by tens of metres depending on the survey, which is why the question asks for the ocean instead.",
    round: null,
    basePoints: 0,
    tiebreak: true,
  },
  {
    text: "How many keys does a standard full-size piano have?",
    answers: ["76", "85", "88", "92"],
    timeLimitSec: 30,
    correct: [2],
    note: "88 — 52 white and 36 black, a little over seven octaves. 76 and 85 are both real keyboard sizes, which is what makes them fair to offer.",
    round: null,
    basePoints: 0,
    tiebreak: true,
  },
  {
    text: "The Ural Mountains are the conventional boundary between which two continents?",
    answers: [
      "Europe and Asia",
      "Asia and Africa",
      "Europe and Africa",
      "Asia and North America",
    ],
    timeLimitSec: 30,
    correct: [0],
    note: "Europe and Asia. Where one ends and the other begins is a convention rather than a geological fact, and the Urals are the line the convention settled on.",
    round: null,
    basePoints: 0,
    tiebreak: true,
  },
];
