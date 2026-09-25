/**
 * `trivia-questions.json` -> `Question[]`. See SPEC.md "Trivia > question file".
 *
 * This replaced a Kahoot CSV importer. The CSV was the format because the
 * questions used to live in Kahoot; once the game moved into Quorum the
 * spreadsheet stopped earning its constraints — no comments, no nesting, no
 * way to mark a tiebreak question without inventing a thirteenth column, and
 * a `Correct answer(s)` cell whose 1-based numbers had to be read against
 * columns to mean anything.
 *
 * Three rules shape everything below:
 *
 * 1. **All or nothing.** Every question is validated and the file is rejected
 *    with addressed errors, rather than loading what parsed. SPEC.md: "a set
 *    with question 14 missing is worse than a set that failed to load in the
 *    dry run" — the first is discovered live, in front of everyone.
 * 2. **Answers are named by letter, and the letter becomes an index here,
 *    once.** `Question.correct` is 0-based everywhere inside the app. Letters
 *    are what the question bank writes and what a participant sees, and they
 *    are neither 0-based nor 1-based, so the off-by-one that the CSV's answer
 *    *numbers* invited has nowhere left to happen.
 * 3. **Unknown keys are errors.** A file with `"timelimitSec"` in it is a file
 *    whose author believes they set a timer. Silently defaulting it is how a
 *    20-second question becomes a 30-second one in front of thirty people.
 *
 * Pure. No fs: the caller supplies the text.
 */

import type { Question } from "../engine/types.ts";
import { DEFAULT_BASE_POINTS } from "../engine/trivia.ts";

/* ------------------------------------------------------------------ */
/* The format                                                          */
/* ------------------------------------------------------------------ */

/** `A` … `D`, in order. The index into `answers` is the index into this. */
export const ANSWER_LETTERS = ["A", "B", "C", "D"] as const;

/** Keys a question may carry. Anything else is rejected. */
export const QUESTION_KEYS = [
  "text",
  "answers",
  "correct",
  "timeLimitSec",
  "note",
  "round",
  "basePoints",
  "tiebreak",
] as const;

/** Keys the top-level object may carry. */
export const FILE_KEYS = ["title", "questions"] as const;

export const MAX_QUESTION_CHARS = 200;
export const MAX_ANSWER_CHARS = 80;
export const MIN_ANSWERS = 2;
export const MAX_ANSWERS = ANSWER_LETTERS.length;
export const MIN_TIME_LIMIT_SEC = 5;
export const MAX_TIME_LIMIT_SEC = 120;

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface ImportError {
  /** 1-based position in `questions`, or null for a whole-file problem. */
  readonly question: number | null;
  /** The offending key, or null for a whole-question problem. */
  readonly field: string | null;
  readonly message: string;
}

export type ImportResult =
  | { readonly ok: true; readonly questions: readonly Question[] }
  | { readonly ok: false; readonly errors: readonly ImportError[] };

/**
 * One error per line, rendered the way the host console lists them.
 *
 * Addressed by position rather than by question text: the text is the thing
 * most likely to be wrong, or missing, in a question that failed to load.
 */
export function formatErrors(errors: readonly ImportError[]): string[] {
  return errors.map((e) => {
    if (e.question === null) return e.message;
    const where = `Question ${e.question}`;
    return e.field === null ? `${where}: ${e.message}` : `${where}, ${e.field}: ${e.message}`;
  });
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export function importTriviaJson(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [{ question: null, field: null, message: `This is not valid JSON — ${detail}` }],
    };
  }

  // A bare list is accepted as well as the wrapped object. A file that is
  // only questions is a reasonable thing to write, and refusing it teaches
  // nothing: the wrapper exists to carry a title, not to be ceremony.
  let list: unknown;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (isRecord(parsed)) {
    const unknown = Object.keys(parsed).filter((k) => !(FILE_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      return {
        ok: false,
        errors: unknown.map((k) => ({
          question: null,
          field: k,
          message: `The file has a "${k}" key, which nothing reads. Expected ${FILE_KEYS.join(" and ")}.`,
        })),
      };
    }
    if (!("questions" in parsed)) {
      return {
        ok: false,
        errors: [{ question: null, field: null, message: 'The file has no "questions" list.' }],
      };
    }
    list = parsed["questions"];
  } else {
    return {
      ok: false,
      errors: [
        {
          question: null,
          field: null,
          message: 'The file must be an object with a "questions" list, or a list of questions.',
        },
      ],
    };
  }

  if (!Array.isArray(list)) {
    return {
      ok: false,
      errors: [{ question: null, field: "questions", message: "This must be a list." }],
    };
  }
  if (list.length === 0) {
    return {
      ok: false,
      errors: [{ question: null, field: "questions", message: "The file has no questions." }],
    };
  }

  const errors: ImportError[] = [];
  const questions: Question[] = [];
  for (const [i, raw] of list.entries()) {
    const before = errors.length;
    const question = readQuestion(i + 1, raw, errors);
    if (question && errors.length === before) questions.push(question);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, questions };
}

/* ------------------------------------------------------------------ */
/* One question                                                        */
/* ------------------------------------------------------------------ */

function readQuestion(at: number, raw: unknown, errors: ImportError[]): Question | null {
  const fail = (field: string | null, message: string): void => {
    errors.push({ question: at, field, message });
  };

  if (!isRecord(raw)) {
    fail(null, "This is not a question object.");
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!(QUESTION_KEYS as readonly string[]).includes(key)) {
      fail(key, `Nothing reads a "${key}" key. Check the spelling.`);
    }
  }

  /* question text */
  const text = typeof raw["text"] === "string" ? raw["text"].trim() : null;
  if (text === null) {
    fail("text", "Missing, or not a string.");
  } else if (text === "") {
    fail("text", "The question is blank.");
  } else if (glyphs(text) > MAX_QUESTION_CHARS) {
    fail("text", `${glyphs(text)} characters; the limit is ${MAX_QUESTION_CHARS}.`);
  }

  /* answers */
  const answers: string[] = [];
  const rawAnswers = raw["answers"];
  if (!Array.isArray(rawAnswers)) {
    fail("answers", "Missing, or not a list.");
  } else {
    for (const [i, value] of rawAnswers.entries()) {
      if (typeof value !== "string") {
        fail("answers", `Answer ${i + 1} is not a string.`);
        continue;
      }
      const trimmed = value.trim();
      if (trimmed === "") {
        // There is no such thing as a blank option: every answer shown is one
        // somebody can pick, and a blank tile is a tile that wins by accident.
        fail("answers", `Answer ${ANSWER_LETTERS[i] ?? i + 1} is blank. Leave it out instead.`);
        continue;
      }
      if (glyphs(trimmed) > MAX_ANSWER_CHARS) {
        fail(
          "answers",
          `Answer ${ANSWER_LETTERS[i] ?? i + 1} is ${glyphs(trimmed)} characters; the limit is ${MAX_ANSWER_CHARS}.`,
        );
      }
      answers.push(trimmed);
    }
    if (rawAnswers.length < MIN_ANSWERS) {
      fail("answers", `A question needs at least ${MIN_ANSWERS} answers; this one has ${rawAnswers.length}.`);
    } else if (rawAnswers.length > MAX_ANSWERS) {
      fail("answers", `${rawAnswers.length} answers; the most is ${MAX_ANSWERS}.`);
    }
    // Two identical options make `correct` a coin toss and make the reveal a
    // lie, whichever one is marked.
    const seen = new Set<string>();
    for (const a of answers) {
      const key = a.toLocaleLowerCase();
      if (seen.has(key)) fail("answers", `"${a}" appears twice.`);
      seen.add(key);
    }
  }

  /* correct — letters in the file, 0-based indices from here on */
  const correct = readCorrect(raw["correct"], answers, fail);

  /* time limit */
  let timeLimitSec = 0;
  const rawLimit = raw["timeLimitSec"];
  if (rawLimit === undefined) {
    fail("timeLimitSec", "Missing.");
  } else if (!isWholeNumber(rawLimit)) {
    fail("timeLimitSec", `${JSON.stringify(rawLimit)} is not a whole number of seconds.`);
  } else {
    timeLimitSec = rawLimit;
    if (timeLimitSec < MIN_TIME_LIMIT_SEC || timeLimitSec > MAX_TIME_LIMIT_SEC) {
      fail("timeLimitSec", `${timeLimitSec} is outside ${MIN_TIME_LIMIT_SEC}–${MAX_TIME_LIMIT_SEC} seconds.`);
    }
  }

  /* optional extras */
  const note = readOptionalText(raw["note"], "note", fail);
  const round = readOptionalText(raw["round"], "round", fail);

  let basePoints = DEFAULT_BASE_POINTS;
  const rawPoints = raw["basePoints"];
  if (rawPoints !== undefined && rawPoints !== null) {
    if (!isWholeNumber(rawPoints) || rawPoints < 0) {
      fail("basePoints", `${JSON.stringify(rawPoints)} is not a whole number of points.`);
    } else {
      // 0 is deliberate and legal: SPEC.md calls it a warm-up.
      basePoints = rawPoints;
    }
  }

  let tiebreak = false;
  const rawTiebreak = raw["tiebreak"];
  if (rawTiebreak !== undefined && rawTiebreak !== null) {
    if (typeof rawTiebreak !== "boolean") {
      fail("tiebreak", `${JSON.stringify(rawTiebreak)} is not true or false.`);
    } else {
      tiebreak = rawTiebreak;
    }
  }

  if (text === null || text === "") return null;
  const question: Question = { text, answers, timeLimitSec, correct, note, round, basePoints };
  // Absent rather than false, so a set with no tiebreakers serialises exactly
  // as one written before the flag existed.
  return tiebreak ? { ...question, tiebreak: true } : question;
}

/**
 * `"C"`, or `["A", "C"]` when more than one option counts.
 *
 * Numbers are refused, and the message deliberately **does not pick a letter**.
 * The file this format replaced marked the answer with a 1-based column number,
 * so a `2` here is most likely someone's half-finished migration meaning the
 * second answer — but it is just as readable as a 0-based index meaning the
 * third. Naming one of them would be a confident wrong answer in the one place
 * this format exists to make impossible, so the message gives both readings and
 * makes the author choose.
 */
function readCorrect(
  raw: unknown,
  answers: readonly string[],
  fail: (field: string | null, message: string) => void,
): number[] {
  const letters = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (letters === null) {
    if (typeof raw === "number") {
      fail("correct", numberMessage(raw));
    } else {
      fail("correct", 'Missing. Give the correct answer\'s letter, like "C".');
    }
    return [];
  }
  if (letters.length === 0) {
    fail("correct", "No correct answer is marked.");
    return [];
  }

  const correct: number[] = [];
  for (const entry of letters) {
    if (typeof entry === "number") {
      fail("correct", numberMessage(entry));
      continue;
    }
    if (typeof entry !== "string") {
      fail("correct", `${JSON.stringify(entry)} is not an answer letter.`);
      continue;
    }
    const letter = entry.trim().toUpperCase();
    const index = (ANSWER_LETTERS as readonly string[]).indexOf(letter);
    if (index < 0) {
      fail("correct", `"${entry}" is not an answer letter. Use ${ANSWER_LETTERS.join(", ")}.`);
      continue;
    }
    if (index >= answers.length) {
      // Only meaningful once `answers` itself parsed; when it did not, the
      // answers error already says what is wrong and this would just echo it.
      if (answers.length > 0) {
        fail("correct", `There is no answer ${letter}; this question has ${answers.length}.`);
      }
      continue;
    }
    if (!correct.includes(index)) correct.push(index);
  }

  correct.sort((a, b) => a - b);
  return correct;
}

/**
 * Both readings of a number, never one.
 *
 * The old CSV counted answers from 1 and the engine counts them from 0, so a
 * bare `2` is "B" to whoever wrote the CSV and "C" to whoever wrote the code.
 * Guessing gets it right half the time and is wrong silently the other half,
 * which is the failure this whole format was chosen to remove.
 */
function numberMessage(n: number): string {
  const oneBased = ANSWER_LETTERS[n - 1];
  const zeroBased = ANSWER_LETTERS[n];
  const readings =
    oneBased && zeroBased
      ? ` Counting answers from 1, as the old CSV did, ${n} is "${oneBased}"; counting from 0 it is "${zeroBased}".`
      : "";
  return `Use the answer's letter, not a number.${readings} Write the one you mean.`;
}

function readOptionalText(
  raw: unknown,
  field: string,
  fail: (field: string | null, message: string) => void,
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    fail(field, `${JSON.stringify(raw)} is not a string.`);
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Count code points, not UTF-16 units.
 *
 * "≤ 200 characters" is a statement about what fits on screen, and an emoji
 * or a CJK character is one of those regardless of how JavaScript stores it.
 */
function glyphs(s: string): number {
  return [...s].length;
}

function isWholeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
