/**
 * Kahoot CSV -> `Question[]`. See SPEC.md "Trivia > CSV format".
 *
 * The existing Kahoot import file *is* the format: header names match by exact
 * text so a set that loads here is still a valid Kahoot import, and a set that
 * Kahoot accepts loads here. `Note`, `Round` and `Points` are extra columns
 * Kahoot ignores.
 *
 * Two rules shape everything below:
 *
 * 1. **All or nothing.** Every row is validated and the file is rejected with
 *    line-numbered errors, rather than loading what parsed. SPEC.md: "a set
 *    with question 14 missing is worse than a set that failed to load in the
 *    dry run" — the first is discovered live, in front of everyone.
 * 2. **The 1-based to 0-based conversion happens here, once.** `Question.correct`
 *    is 0-based everywhere inside the app. An off-by-one that survives the
 *    importer is an off-by-one nobody sees until a question is revealed to
 *    thirty people.
 *
 * Pure. No fs: the caller supplies the text.
 */

import type { Question } from "../engine/types.ts";
import { DEFAULT_BASE_POINTS } from "../engine/trivia.ts";
import { CsvParseError, parseCsv } from "./csv.ts";

/* ------------------------------------------------------------------ */
/* The format                                                          */
/* ------------------------------------------------------------------ */

export const COL_QUESTION = "Question";
export const COL_TIME_LIMIT = "Time limit (sec)";
export const COL_CORRECT = "Correct answer(s)";
export const COL_NOTE = "Note";
export const COL_ROUND = "Round";
export const COL_POINTS = "Points";

/** `Answer 1` … `Answer 4`, in order. */
export const ANSWER_COLUMNS = [
  "Answer 1",
  "Answer 2",
  "Answer 3",
  "Answer 4",
] as const;

/**
 * Columns the file must have.
 *
 * `Answer 3` and `Answer 4` are not here: SPEC.md allows two- and
 * three-answer questions "by leaving answer columns blank", and a set where
 * every question has two answers may reasonably omit the columns entirely.
 * Their *values* are optional either way.
 */
export const REQUIRED_COLUMNS = [
  COL_QUESTION,
  ANSWER_COLUMNS[0],
  ANSWER_COLUMNS[1],
  COL_TIME_LIMIT,
  COL_CORRECT,
] as const;

export const MAX_QUESTION_CHARS = 200;
export const MAX_ANSWER_CHARS = 80;
export const MIN_ANSWERS = 2;
export const MAX_ANSWERS = ANSWER_COLUMNS.length;
export const MIN_TIME_LIMIT_SEC = 5;
export const MAX_TIME_LIMIT_SEC = 120;

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface ImportError {
  /** 1-based line in the file. The header is line 1. */
  readonly line: number;
  /** The offending column's header text, or null for whole-row problems. */
  readonly column: string | null;
  readonly message: string;
}

export type ImportResult =
  | { readonly ok: true; readonly questions: readonly Question[] }
  | { readonly ok: false; readonly errors: readonly ImportError[] };

/** One error per line, rendered the way the host console lists them. */
export function formatErrors(errors: readonly ImportError[]): string[] {
  return errors.map((e) =>
    e.column === null
      ? `Line ${e.line}: ${e.message}`
      : `Line ${e.line}, ${e.column}: ${e.message}`,
  );
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export function importTriviaCsv(text: string): ImportResult {
  let records;
  try {
    records = parseCsv(text);
  } catch (err) {
    if (err instanceof CsvParseError) {
      return { ok: false, errors: [{ line: err.line, column: null, message: err.message }] };
    }
    throw err;
  }

  const header = records[0];
  if (!header) {
    return {
      ok: false,
      errors: [{ line: 1, column: null, message: "The file is empty." }],
    };
  }

  const names = header.fields.map((f) => f.trim());
  const errors: ImportError[] = [];

  const index = new Map<string, number>();
  for (const [i, name] of names.entries()) {
    if (name === "") continue;
    if (index.has(name)) {
      errors.push({
        line: header.line,
        column: name,
        message: `The column ${name} appears twice.`,
      });
      continue;
    }
    index.set(name, i);
  }
  for (const required of REQUIRED_COLUMNS) {
    if (!index.has(required)) {
      errors.push({
        line: header.line,
        column: required,
        message: `Missing the ${required} column. Header names must match Kahoot's exactly.`,
      });
    }
  }
  // Without a usable header there is nothing to say about the rows that would
  // not be noise: every one of them would fail the same way.
  if (errors.length > 0) return { ok: false, errors };

  const rows = records.slice(1);
  if (rows.length === 0) {
    return {
      ok: false,
      errors: [
        { line: header.line, column: null, message: "The file has no questions." },
      ],
    };
  }

  const questions: Question[] = [];
  for (const row of rows) {
    const before = errors.length;
    const question = readRow(row.line, row.fields, names, index, errors);
    if (question && errors.length === before) questions.push(question);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, questions };
}

/* ------------------------------------------------------------------ */
/* One row                                                             */
/* ------------------------------------------------------------------ */

function readRow(
  line: number,
  fields: readonly string[],
  names: readonly string[],
  index: ReadonlyMap<string, number>,
  errors: ImportError[],
): Question | null {
  // A row longer than the header is a misaligned row, and a misaligned row is
  // exactly the kind of thing that silently shifts every answer by one.
  // Trailing empties are not: plenty of editors write them.
  if (fields.length > names.length) {
    const extra = fields.slice(names.length).filter((f) => f.trim() !== "");
    if (extra.length > 0) {
      errors.push({
        line,
        column: null,
        message: `This row has ${fields.length} values but the header has ${names.length} columns.`,
      });
      return null;
    }
  }

  const cell = (column: string): string => {
    const at = index.get(column);
    if (at === undefined) return "";
    return (fields[at] ?? "").trim();
  };
  const fail = (column: string | null, message: string): void => {
    errors.push({ line, column, message });
  };

  /* question text */
  const text = cell(COL_QUESTION);
  if (text === "") {
    fail(COL_QUESTION, "The question is blank.");
  } else if (glyphs(text) > MAX_QUESTION_CHARS) {
    fail(
      COL_QUESTION,
      `${glyphs(text)} characters; the limit is ${MAX_QUESTION_CHARS} so it fits a phone.`,
    );
  }

  /* answers */
  const cells = ANSWER_COLUMNS.map((c) => cell(c));
  const answers: string[] = [];
  let gap = false;
  for (const [i, value] of cells.entries()) {
    if (value === "") {
      gap = true;
      continue;
    }
    // Blanks have to be trailing. "Answer 2 blank, Answer 3 filled" is not a
    // three-answer question with a hole: it is a file where the 1-based
    // `Correct answer(s)` no longer means what the author thinks it means.
    if (gap) {
      fail(
        ANSWER_COLUMNS[i] ?? null,
        "Answers must be filled in from Answer 1 with no blanks in between.",
      );
      gap = false;
    }
    if (glyphs(value) > MAX_ANSWER_CHARS) {
      fail(
        ANSWER_COLUMNS[i] ?? null,
        `${glyphs(value)} characters; the limit is ${MAX_ANSWER_CHARS}.`,
      );
    }
    answers.push(value);
  }
  if (answers.length < MIN_ANSWERS) {
    fail(
      ANSWER_COLUMNS[1],
      `A question needs at least ${MIN_ANSWERS} answers; this one has ${answers.length}.`,
    );
  }
  /* time limit */
  const rawLimit = cell(COL_TIME_LIMIT);
  let timeLimitSec = 0;
  if (rawLimit === "") {
    fail(COL_TIME_LIMIT, "The time limit is blank.");
  } else if (!isWholeNumber(rawLimit)) {
    fail(COL_TIME_LIMIT, `"${rawLimit}" is not a whole number of seconds.`);
  } else {
    timeLimitSec = Number(rawLimit);
    if (timeLimitSec < MIN_TIME_LIMIT_SEC || timeLimitSec > MAX_TIME_LIMIT_SEC) {
      fail(
        COL_TIME_LIMIT,
        `${timeLimitSec} is outside ${MIN_TIME_LIMIT_SEC}–${MAX_TIME_LIMIT_SEC} seconds.`,
      );
    }
  }

  /* correct answer(s) — 1-based in the file, 0-based from here on */
  const rawCorrect = cell(COL_CORRECT);
  const correct: number[] = [];
  if (rawCorrect === "") {
    fail(COL_CORRECT, "No correct answer is marked.");
  } else {
    for (const part of rawCorrect.split(";")) {
      const token = part.trim();
      if (token === "" || !isWholeNumber(token)) {
        fail(
          COL_CORRECT,
          `"${token}" is not an answer number. Use 1-based numbers, several separated by ";".`,
        );
        continue;
      }
      const oneBased = Number(token);
      if (oneBased < 1 || oneBased > answers.length) {
        fail(
          COL_CORRECT,
          `Answer ${oneBased} does not exist; this question has ${answers.length}.`,
        );
        continue;
      }
      const zeroBased = oneBased - 1;
      if (!correct.includes(zeroBased)) correct.push(zeroBased);
    }
  }

  /* optional extras */
  const note = blankToNull(cell(COL_NOTE));
  const round = blankToNull(cell(COL_ROUND));

  const rawPoints = cell(COL_POINTS);
  let basePoints = DEFAULT_BASE_POINTS;
  if (rawPoints !== "") {
    if (!isWholeNumber(rawPoints)) {
      fail(COL_POINTS, `"${rawPoints}" is not a whole number of points.`);
    } else {
      // 0 is deliberate and legal: SPEC.md calls it a warm-up.
      basePoints = Number(rawPoints);
    }
  }

  correct.sort((a, b) => a - b);
  return { text, answers, timeLimitSec, correct, note, round, basePoints };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Count code points, not UTF-16 units.
 *
 * "≤ 200 characters" is a statement about what fits on a phone, and an emoji
 * or a CJK character is one of those regardless of how JavaScript stores it.
 */
function glyphs(s: string): number {
  return [...s].length;
}

function isWholeNumber(s: string): boolean {
  return /^\d+$/.test(s);
}

function blankToNull(s: string): string | null {
  return s === "" ? null : s;
}
