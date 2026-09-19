/**
 * Export: the two files a host takes away from a session.
 *
 * `scoresheet.csv` is the shape of the spreadsheet this service replaces —
 * `Name, <Activity> Raw, <Activity> Pts, …, Spot Awards, TOTAL` — so the
 * numbers land where whoever has kept the scores for years expects them.
 * Both raw and points are there because the raw column is what makes a
 * normalised score checkable: SCORING.md's rule is one line of arithmetic, and
 * an export that only showed the output would be asking to be trusted.
 *
 * `events.jsonl` is the audit trail, for settling a scoring dispute after the
 * fact. One JSON object per line, in seq order, exactly as it was stored.
 *
 * Both functions are pure, which is the point: the export is computed from a
 * `SessionState`, so it reads the same whether that state came from memory or
 * from a snapshot loaded after a restart.
 */

import { computeStandings } from "../engine/scoring.ts";
import type { SessionState } from "../engine/types.ts";
import type { StoredEvent } from "./store/types.ts";

/**
 * One CSV field.
 *
 * Quoted when it has to be, and a leading `=`, `+` or `@` is defanged with a
 * leading apostrophe: this file is opened in Excel by definition, and a
 * nickname is free text. `-` is deliberately left alone — it starts no
 * formula that matters here and mangling it would corrupt ordinary names.
 */
export function csvField(value: string | number | null): string {
  if (value === null) return "";
  let s = typeof value === "number" ? String(value) : value;
  if (/^[=+@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: readonly (string | number | null)[]): string {
  return cells.map(csvField).join(",");
}

/** The header, exported so a test can assert the shape without the numbers. */
export function scoresheetHeader(state: SessionState): string[] {
  const cols = ["Name"];
  for (const a of state.activities) {
    cols.push(`${a.title} Raw`, `${a.title} Pts`);
  }
  cols.push("Spot Awards", "TOTAL");
  return cols;
}

/**
 * The scoresheet, in standings order.
 *
 * Kicked participants are already out of `computeStandings`. Someone whose
 * nickname was released still appears: they played, the points are theirs, and
 * a phone swap must not cost anyone their afternoon.
 *
 * A bench row reads `bench` in the raw column and carries the credited points,
 * because "no raw score and 80 points" is otherwise the one cell in the file
 * that looks like a mistake.
 */
export function scoresheetCsv(state: SessionState): string {
  const standings = computeStandings(state);
  const lines = [csvRow(scoresheetHeader(state))];

  for (const s of standings) {
    const cells: (string | number | null)[] = [s.nickname];
    for (const a of state.activities) {
      const cell = s.perActivity[a.id];
      if (cell?.source === "bench") cells.push("bench", cell.points);
      else if (cell?.source === "normalised") cells.push(cell.raw, cell.points);
      else cells.push(null, null);
    }
    cells.push(s.spotPoints, s.total);
    lines.push(csvRow(cells));
  }

  // CRLF and a trailing newline: RFC 4180, and what every spreadsheet on a
  // host's laptop reads without a dialog box.
  return lines.join("\r\n") + "\r\n";
}

export function scoresheetFilename(state: SessionState): string {
  const slug =
    state.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "session";
  return `${slug}-scores.csv`;
}

/** The event log, one object per line, oldest first. */
export function eventsJsonl(records: readonly StoredEvent[]): string {
  return (
    [...records]
      .sort((a, b) => a.seq - b.seq)
      .map((r) =>
        JSON.stringify({
          seq: r.seq,
          at: r.at,
          type: r.event.type,
          event: r.event,
        }),
      )
      .join("\n") + (records.length > 0 ? "\n" : "")
  );
}

/**
 * The stored log and whatever this process has in memory, merged by seq.
 *
 * After a restart the store holds everything up to the moment the task died
 * and memory holds everything since; before one, the store may be a write or
 * two behind. Taking the union by seq means a dispute is settled from the
 * whole afternoon whichever of those is true, and a write that failed
 * silently does not quietly remove an event from the record.
 */
export function mergeEventLogs(
  stored: readonly StoredEvent[],
  live: readonly StoredEvent[],
): StoredEvent[] {
  const bySeq = new Map<number, StoredEvent>();
  for (const r of stored) bySeq.set(r.seq, r);
  for (const r of live) if (!bySeq.has(r.seq)) bySeq.set(r.seq, r);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
