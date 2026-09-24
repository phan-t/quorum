/**
 * Every send-off command the console can send survives the wire.
 *
 * `HostCommand` is a TypeScript union and `parseHostCommand` is a runtime
 * switch, and nothing makes the two agree. Adding Auto and the speed slider
 * type-checked everywhere and then came back "Unrecognised command." from the
 * server, because the parser had never heard of them — the console had a
 * button that could only ever be refused.
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

describe("the send-off's commands on the wire", () => {
  const commands: HostCommand[] = [
    { name: "sendoff.next" },
    { name: "sendoff.back" },
    { name: "sendoff.auto", auto: true },
    { name: "sendoff.auto", auto: false },
    { name: "sendoff.speed", seconds: 4 },
  ];

  for (const cmd of commands) {
    test(`${cmd.name} survives`, () => {
      assert.deepEqual(roundTrip(cmd), cmd);
    });
  }

  test("refuses a speed that is not a number", () => {
    assert.equal(roundTrip({ name: "sendoff.speed", seconds: "fast" } as never), null);
    assert.equal(roundTrip({ name: "sendoff.speed", seconds: Number.NaN } as never), null);
  });

  test("refuses an auto that is not a boolean", () => {
    assert.equal(roundTrip({ name: "sendoff.auto", auto: "yes" } as never), null);
  });
});
