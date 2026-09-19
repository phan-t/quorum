/**
 * A small RFC 4180 CSV reader.
 *
 * Pure: it takes the file's text and returns records. Reading the file is the
 * caller's problem, because the importer runs in the engine's world — no fs,
 * no network — and because the same text arrives from an HTTP upload, a test
 * fixture and a replayed event log.
 *
 * Nothing here knows what a question is. See ./import.ts for that.
 */

/** One record, with the 1-based file line its first field started on. */
export interface CsvRecord {
  readonly line: number;
  readonly fields: readonly string[];
}

export class CsvParseError extends Error {
  /** 1-based line the unreadable field started on. */
  readonly line: number;
  constructor(line: number, message: string) {
    super(message);
    this.name = "CsvParseError";
    this.line = line;
  }
}

/**
 * Parse CSV text into records.
 *
 * Handles quoted fields containing commas, doubled quotes (`""`) inside a
 * quoted field, and quoted fields containing newlines — the line number
 * reported for a record is where the record *started*, which is the line a
 * human counts to when the error message says "line 14".
 *
 * A UTF-8 BOM is stripped: Excel writes one, and without this the first header
 * would be `﻿Question`, which matches no column name and fails the whole
 * import with an error about a header that looks perfectly correct.
 *
 * Wholly blank lines are dropped, so a trailing newline is not a 1-field
 * record that then fails validation for being an empty question.
 */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const records: CsvRecord[] = [];

  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let started = false;

  const endField = (): void => {
    fields.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    // A single empty field is a blank line, not a record.
    if (!(fields.length === 1 && fields[0] === "")) {
      records.push({ line: recordLine, fields });
    }
    fields = [];
    started = false;
  };

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (!started) {
      recordLine = line;
      started = true;
    }

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (c === "\n") line += 1;
        field += c;
      }
      continue;
    }

    if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\r") {
      // \r\n, or a lone \r from an old Mac export: either ends the record.
      if (src[i + 1] === "\n") i += 1;
      endRecord();
      line += 1;
    } else if (c === "\n") {
      endRecord();
      line += 1;
    } else {
      field += c;
    }
  }

  if (quoted) {
    throw new CsvParseError(
      recordLine,
      "A quoted field is never closed — check for a stray double quote.",
    );
  }
  if (started) endRecord();

  return records;
}
