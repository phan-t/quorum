/**
 * A second summary, printed under node's own, that does not lie about a suite
 * that died.
 *
 * **The problem.** Work in a `describe` body runs while node is still
 * *collecting* tests, not running them. A throw there is not attributed to any
 * test, because at that moment there are no tests: the runner discards the
 * whole suite and every `test()` call the body had not reached yet. It prints
 * one `✖ <suite name>` line and then a summary that counts none of it:
 *
 *     ℹ tests 1330   ℹ pass 1330   ℹ fail 0
 *
 * against a true total of 1343. Thirteen tests gone, nothing failed. The exit
 * code is correct — node exits 1 and so does `npm test`, which is the only
 * reason issue #15 was a legibility bug and not a shipped-wrong-scores bug —
 * but the numbers a person reads say the run was green. The dangerous shape is
 * somebody confirming their own change against `pass`/`fail` while an
 * unrelated suite is quietly dead. In a 1597-test run the `✖` line is
 * thousands of lines up the scrollback and is contradicted by the totals
 * printed underneath it.
 *
 * A failing `before`/`beforeEach` hook has the same shape with a different
 * name: its tests are *registered* but `cancelled`, so the count holds steady
 * and `fail` is still 0. Moving describe-body work into a hook is therefore
 * only half a fix; the other half is here.
 *
 * **What this prints.** One line, always, as the last thing in the run:
 *
 *     ℹ verdict PASS — 1597 tests, 293 suites, nothing uncounted
 *     ℹ verdict FAIL — 13 of 1597 tests failed
 *     ℹ verdict FAIL — 1 suite never registered its tests
 *
 * It begins `ℹ ` on purpose: the habit this is defending is `grep '^ℹ
 * (tests|pass|fail)'`, and a verdict that does not survive that grep defends
 * nothing. Its *absence* is a signal too — no verdict line means the run never
 * reached a summary, which is worth noticing on its own.
 *
 * **Why not a minimum test count.** The obvious guard is asserting a floor:
 * `tests >= 1597`. It catches exactly this and nothing else, and it has to be
 * edited by hand on every commit that adds a test — which means it is edited
 * without thought, which means the one time the number dropped for a real
 * reason it gets bumped down with a shrug. It is also wrong in a worktree that
 * runs a subset. This reads the runner's own event stream instead, so it needs
 * no number, stays true as the suite grows, and names the suite that died
 * rather than reporting that a count moved.
 *
 * **How it tells the two apart.** node emits `test:fail` for a failing test
 * *and* for each of its ancestor suites, so counting every `test:fail` would
 * treble-count an ordinary failure. The ancestors carry
 * `details.error.failureType === "subtestsFailed"`; a suite that threw in its
 * own body carries `"testCodeFailure"`, and one whose hook threw carries
 * `"hookFailed"`. Anything that is a suite and is not `subtestsFailed` is a
 * suite that failed on its own account, and those are precisely the failures
 * `counts.failed` leaves out.
 */

import { relative } from "node:path";

/**
 * The parts of node's reporter events this reads.
 *
 * Declared structurally rather than imported from `node:test/reporters` so the
 * tests can hand it plain objects, and so a change to node's own typings
 * cannot quietly turn a live field into `unknown`.
 */
export interface ReporterEvent {
  readonly type: string;
  readonly data: {
    readonly name?: string | undefined;
    readonly file?: string | undefined;
    readonly details?:
      | {
          readonly type?: string | undefined;
          readonly error?: { readonly message?: string | undefined; readonly failureType?: string | undefined } | undefined;
        }
      | undefined;
    readonly counts?: SummaryCounts | undefined;
  };
}

/** The `counts` block of a `test:summary` event. */
export interface SummaryCounts {
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly suites: number;
}

/** A suite that failed without any of its tests failing: its tests never ran. */
export interface DeadSuite {
  readonly name: string;
  /** The test file, relative to the working directory. */
  readonly where: string;
  /** The first line of what it threw. */
  readonly why: string;
}

export interface Tally {
  readonly dead: DeadSuite[];
  /** The last summary seen. The run-wide one is emitted last, so it wins. */
  counts: SummaryCounts | null;
}

export function newTally(): Tally {
  return { dead: [], counts: null };
}

/** Fold one reporter event into the tally. */
export function observe(tally: Tally, event: ReporterEvent): void {
  if (event.type === "test:fail") {
    const details = event.data.details;
    if (details?.type !== "suite") return;
    // The ancestors of an ordinary failing test. Those failures are already in
    // `counts.failed`, counted once, on the test itself.
    if (details.error?.failureType === "subtestsFailed") return;
    tally.dead.push({
      name: event.data.name ?? "(unnamed suite)",
      where: event.data.file === undefined ? "(unknown file)" : relative(process.cwd(), event.data.file),
      why: firstLine(details.error?.message) ?? details.error?.failureType ?? "threw",
    });
    return;
  }
  if (event.type === "test:summary" && event.data.counts !== undefined) {
    tally.counts = event.data.counts;
  }
}

/** Everything this reporter prints, as one block, ready to write. */
export function verdict(tally: Tally): string {
  const lines: string[] = [""];
  if (tally.dead.length > 0) {
    const n = tally.dead.length;
    lines.push(
      `✖ ${count(n, "suite")} threw outside of a test, so the tests inside ${n === 1 ? "it" : "them"} were never registered.`,
      "  They are missing from the totals above, and `fail` does not count them.",
    );
    for (const d of tally.dead) {
      lines.push(`    ${d.where} › ${d.name}`);
      lines.push(`      ${d.why}`);
    }
    lines.push(
      "  Work belongs inside the tests — or in a lazily memoised call they share —",
      "  never in a `describe` body, where a throw is nobody's failure.",
      "",
    );
  }
  lines.push(`ℹ verdict ${headline(tally)}`, "");
  return lines.join("\n");
}

function headline(tally: Tally): string {
  const c = tally.counts;
  if (c === null) return "FAIL — the run never reached a summary; something killed the runner";
  const wrong: string[] = [];
  if (c.failed > 0) wrong.push(`${c.failed} of ${c.tests} tests failed`);
  if (c.cancelled > 0) wrong.push(`${count(c.cancelled, "test")} never ran`);
  const n = tally.dead.length;
  if (n > 0) wrong.push(`${count(n, "suite")} never registered ${n === 1 ? "its" : "their"} tests`);
  if (wrong.length === 0) return `PASS — ${count(c.tests, "test")}, ${count(c.suites, "suite")}, nothing uncounted`;
  return `FAIL — ${wrong.join("; ")}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function firstLine(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const line = message.split("\n")[0]?.trim();
  return line === undefined || line === "" ? undefined : line;
}

/**
 * The reporter itself. Wired up in `package.json` alongside `spec`, which does
 * the actual reporting; this only ever writes its block, last.
 */
export default async function* honestSummary(
  source: AsyncIterable<ReporterEvent>,
): AsyncGenerator<string> {
  const tally = newTally();
  for await (const event of source) observe(tally, event);
  yield verdict(tally);
}
