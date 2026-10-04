/**
 * Every trivia command the console can send survives the wire.
 *
 * The same guard `protocol.sendoff.test.ts` exists for, and the same bug it was
 * written after: `HostCommand` is a TypeScript union and `parseHostCommand` is
 * a runtime switch, and nothing makes the two agree. Auto and its slider
 * type-checked everywhere on the send-off and then came back "Unrecognised
 * command." from the server, because the parser had never heard of them. A
 * console with a button that can only ever be refused is worse than no button.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseClientMessage, type HostCommand } from "./protocol.ts";

/** What the console actually puts on the socket. */
function roundTrip(cmd: HostCommand): HostCommand | null {
  const frame = JSON.stringify({ t: "host.cmd", cid: "c1", cmd });
  const parsed = parseClientMessage(frame);
  assert.equal(parsed?.t, "host.cmd");
  return parsed !== null && parsed.t === "host.cmd" ? parsed.cmd : null;
}

describe("trivia's commands on the wire", () => {
  const commands: HostCommand[] = [
    { name: "trivia.open", suddenDeath: false },
    { name: "trivia.close" },
    { name: "trivia.reveal" },
    { name: "trivia.next" },
    { name: "trivia.auto", auto: true },
    { name: "trivia.auto", auto: false },
    { name: "trivia.speed", seconds: 5 },
  ];

  for (const cmd of commands) {
    test(`${cmd.name} survives`, () => {
      assert.deepEqual(roundTrip(cmd), cmd);
    });
  }

  test("refuses a speed that is not a number", () => {
    assert.equal(roundTrip({ name: "trivia.speed", seconds: "fast" } as never), null);
    assert.equal(roundTrip({ name: "trivia.speed", seconds: Number.NaN } as never), null);
    assert.equal(roundTrip({ name: "trivia.speed" } as never), null);
  });

  test("refuses an auto that is not a boolean", () => {
    // Not defaulted, for the reason `trivia.open`'s `suddenDeath` is not: a
    // mode that moves the room on its own is never inferred from an absence.
    assert.equal(roundTrip({ name: "trivia.auto", auto: "yes" } as never), null);
    assert.equal(roundTrip({ name: "trivia.auto" } as never), null);
  });

  test("the speed's range is not the wire's business", () => {
    // Range-checked in the engine, which is the only place that may decide
    // what the slider means. The wire asks only whether it is a number, so an
    // out-of-range one crosses and is clamped rather than being silently
    // dropped by a parser with its own opinion.
    assert.deepEqual(roundTrip({ name: "trivia.speed", seconds: 900 }), {
      name: "trivia.speed",
      seconds: 900,
    });
  });
});

describe("a tap on a sudden death (#41)", () => {
  const tap = (index: number): unknown =>
    parseClientMessage(JSON.stringify({ t: "trivia.answer", cid: "c1", index, choice: 2 }));

  test("carries the tiebreak's index and reaches the runtime", () => {
    // The view shows a tiebreak at -1; the phone answers with what it was shown.
    assert.deepEqual(tap(-1), { t: "trivia.answer", cid: "c1", index: -1, choice: 2 });
  });
  test("but no other negative index does", () => {
    assert.equal(tap(-2), null);
    assert.equal(tap(-0.5), null);
  });
});
