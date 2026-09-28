/**
 * Every scoring command the console can send survives the wire — and the one
 * that no longer exists does not.
 *
 * The same guard `protocol.trivia.test.ts` and `protocol.sendoff.test.ts` exist
 * for: `HostCommand` is a TypeScript union and `parseHostCommand` is a runtime
 * switch, and nothing makes the two agree. Written when Spot Awards and Bench
 * Credit were removed, because that change touched both ends of this boundary and
 * neither end had a test on it — `score.status` had no parse coverage at all, so
 * putting `bench` back in the accepted list broke nothing.
 *
 * Which matters in exactly one situation, and it is a real one. A console tab
 * left open across the deploy still has an `Alt+B` handler in it and will send
 * `{ name: "score.status", status: "bench" }`. The honest answer is a null
 * command and a `refusedCmd` on that cid — "Unrecognised command" on the glass,
 * which is a host who reloads. The dishonest answer is the status landing as
 * something else and quietly clearing the cell it was aimed at.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseClientMessage, type HostCommand } from "./protocol.ts";

/** What the console actually puts on the socket. */
function roundTrip(cmd: unknown): HostCommand | null {
  const frame = JSON.stringify({ t: "host.cmd", cid: "c1", cmd });
  const parsed = parseClientMessage(frame);
  assert.equal(parsed?.t, "host.cmd", "the frame itself did not parse");
  return parsed !== null && parsed.t === "host.cmd" ? parsed.cmd : null;
}

describe("scoring's commands on the wire", () => {
  const commands: HostCommand[] = [
    { name: "score.set", activityId: "ttx", pid: "p1", raw: 17 },
    { name: "score.set", activityId: "ttx", pid: "p1", raw: 0 },
    { name: "score.status", activityId: "ttx", pid: "p1", status: "played" },
    { name: "score.status", activityId: "ttx", pid: "p1", status: "unset" },
  ];

  for (const cmd of commands) {
    const what =
      cmd.name === "score.status" ? `${cmd.name} ${cmd.status}` : `${cmd.name} ${JSON.stringify(cmd)}`;
    test(`${what} survives`, () => {
      assert.deepEqual(roundTrip(cmd), cmd);
    });
  }

  test("a status the engine no longer has is refused, not coerced", () => {
    // `bench` is the one that was real. The rest are here so the check is about
    // the accepted list rather than about one string.
    for (const status of ["bench", "BENCH", "credited", "", null, 0, true]) {
      assert.equal(
        roundTrip({ name: "score.status", activityId: "ttx", pid: "p1", status }),
        null,
        `a status of ${JSON.stringify(status)} was accepted`,
      );
    }
  });

  test("a raw score that cannot be compared is refused at the boundary", () => {
    // NaN and Infinity poison the sort comparator, so they are refused here as
    // well as in the reducer — a number off the wire is the earliest place to
    // catch one.
    for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, -1, "17", null]) {
      assert.equal(
        roundTrip({ name: "score.set", activityId: "ttx", pid: "p1", raw }),
        null,
        `a raw of ${JSON.stringify(raw)} was accepted`,
      );
    }
  });

  test("the two retired Spot Award commands are gone from the parser", () => {
    // A console from before the removal sends these. They must come back as a
    // refusal rather than as a command the engine has no case for — `reduce`
    // switches exhaustively over `Event` and would fall off the end of it.
    assert.equal(
      roundTrip({ name: "spot.grant", pid: "p1", activityId: "ttx", reason: "why" }),
      null,
    );
    assert.equal(roundTrip({ name: "spot.revoke", seq: 4 }), null);
  });
});
