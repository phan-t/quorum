/**
 * A trivia tap the server never kept goes again after a reconnect.
 *
 * The phone shows "locked in" the instant it is tapped. A tap made while the
 * socket was down, or accepted by a process that died before writing it, left
 * that screen standing over an answer nobody scored. The globals are borrowed
 * the way `net.protocol.test.ts` borrows them, for the reason it gives.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type RenderState,
  type ServerMessage,
} from "../../protocol.ts";
import { QuorumClient } from "./net.ts";
import type { Transport, TransportHandlers } from "./transport.ts";

const stub = {
  addEventListener(): void {},
  removeEventListener(): void {},
  visibilityState: "visible",
};
let hadDocument = false;
let hadWindow = false;
const built: QuorumClient[] = [];

beforeEach(() => {
  const g = globalThis as Record<string, unknown>;
  hadDocument = "document" in g;
  hadWindow = "window" in g;
  g["document"] = stub;
  g["window"] = stub;
});

afterEach(() => {
  for (const c of built.splice(0)) c.stop();
  const g = globalThis as Record<string, unknown>;
  if (!hadDocument) delete g["document"];
  if (!hadWindow) delete g["window"];
});

/** A phone whose socket this file opens, drops and serves by hand. */
function phone() {
  const sockets: { h: TransportHandlers; sent: ClientMessage[]; open: boolean }[] = [];
  const client = new QuorumClient({
    hello: () => ({ t: "hello", role: "participant", joinCode: "c", nickname: "Priya" }),
    transport: (h): Transport => {
      const s = { h, sent: [] as ClientMessage[], open: true };
      sockets.push(s);
      return {
        send: (m) => {
          if (s.open) s.sent.push(m);
        },
        close: () => {
          s.open = false;
        },
      };
    },
  });
  built.push(client);
  client.start();
  const now = () => sockets[sockets.length - 1]!;
  return {
    client,
    serve: (m: ServerMessage) => now().h.onMessage(m),
    /** The link goes; the client's own backoff is skipped by reconnecting here. */
    drop: () => {
      now().open = false;
      now().h.onClose("gone");
    },
    reconnect: () => client.start(),
    answers: () =>
      sockets.flatMap((s) => s.sent).filter((m) => m.t === "trivia.answer"),
  };
}

const welcome: ServerMessage = {
  t: "welcome",
  role: "participant",
  sid: "s",
  pid: "p1",
  rejoinToken: "r",
  serverTime: Date.now(),
  protocol: PROTOCOL_VERSION,
};

function stateFrame(
  seq: number,
  index: number,
  mine: "unanswered" | "locked",
  text = "Which product does secrets management?",
  phase: "open" | "closed" = "open",
): ServerMessage {
  const state = {
    segment: "trivia",
    trivia: { index, text, phase, answers: ["A", "B"] },
    triviaMine: mine === "locked" ? { state: "locked", choice: 1 } : { state: "unanswered" },
  } as unknown as RenderState;
  return { t: "state", seq, state };
}

describe("a tap the server never kept", () => {
  test("goes again on the first state after a reconnect", () => {
    const p = phone();
    p.serve(welcome);
    p.serve(stateFrame(1, 3, "unanswered"));
    p.drop();
    p.client.answer(3, 1); // tapped into a dead socket
    assert.equal(p.answers().length, 0);

    p.reconnect();
    p.serve(welcome);
    p.serve(stateFrame(5, 3, "unanswered"));
    assert.deepEqual(
      p.answers().map((m) => (m.t === "trivia.answer" ? [m.index, m.choice] : null)),
      [[3, 1]],
    );
  });

  test("is not sent twice on an ordinary broadcast that overtakes it", () => {
    const p = phone();
    p.serve(welcome);
    p.serve(stateFrame(1, 3, "unanswered"));
    p.client.answer(3, 1);
    p.serve(stateFrame(2, 3, "unanswered"));
    assert.equal(p.answers().length, 1);
  });

  test("is forgotten once the server holds it", () => {
    const p = phone();
    p.serve(welcome);
    p.serve(stateFrame(1, 3, "unanswered"));
    p.client.answer(3, 1);
    p.serve(stateFrame(2, 3, "locked"));
    p.drop();
    p.reconnect();
    p.serve(welcome);
    p.serve(stateFrame(5, 3, "unanswered"));
    assert.equal(p.answers().length, 1, "only the original tap");
  });

  test("is not sent to a question that closed or moved on in the gap", () => {
    for (const after of [
      stateFrame(5, 3, "unanswered", undefined, "closed"),
      stateFrame(5, 4, "unanswered"),
      stateFrame(5, 3, "unanswered", "A different tiebreak"),
    ]) {
      const p = phone();
      p.serve(welcome);
      p.serve(stateFrame(1, 3, "unanswered"));
      p.drop();
      p.client.answer(3, 1);
      p.reconnect();
      p.serve(welcome);
      p.serve(after);
      assert.equal(p.answers().length, 0);
    }
  });
});
