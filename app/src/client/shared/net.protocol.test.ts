/**
 * The client runtime actually does the comparison, on every `welcome`.
 *
 * `protocol-guard.test.ts` pins the decision; this file pins the *wire*. They
 * are separate failures and the second one is the one #33 is about: the check
 * existed as a constant on the frame for the whole life of the repository and
 * no client under `client/` ever read it, so a perfectly correct decision
 * function that nothing called would be the same bug wearing a new coat.
 *
 * What is asserted here, and nothing else:
 *
 * - `onProtocol` fires on every welcome, matching or not, and is handed the
 *   server's version and this build's;
 * - `"halt"` stops the client dead — no state delivered, no reconnect, the
 *   socket closed — because a surface on its way to a reload must not first
 *   render a frame of a shape it may not understand;
 * - `"continue"` leaves the client working, because the console and the
 *   Desktop keep driving a session under a banner.
 *
 * ## The two globals
 *
 * `QuorumClient`'s constructor registers a `visibilitychange` listener and an
 * `online` listener — the phone that slept through the holding page is the
 * failure this product actually has, and that wake-up is worth more than the
 * purity of this file. This repository otherwise has no DOM in its tests and
 * that is still the rule; these two stubs are the smallest thing that lets the
 * real runtime be exercised, they are put back afterwards, and nothing here
 * asserts anything about them. The transport is injected, which is what keeps
 * `socketUrl()` — and therefore `location` — out of it entirely.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { PROTOCOL_VERSION, type ServerMessage } from "../../protocol.ts";
import { QuorumClient, type ConnStatus } from "./net.ts";
import type { Transport, TransportHandlers } from "./transport.ts";
import type { ProtocolAction } from "./protocol-guard.ts";

/* ---- the two globals, borrowed and given back ---- */

const stub = {
  addEventListener(): void {},
  removeEventListener(): void {},
  visibilityState: "visible",
};
let hadDocument = false;
let hadWindow = false;

/**
 * Every client a scenario built, stopped afterwards.
 *
 * Not tidiness: a `welcome` starts a ping interval and a state-grace timeout,
 * and a run that left thirty of them behind would be a run that does not end.
 */
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

/* ---- a socket this file drives by hand ---- */

interface Wire {
  readonly client: QuorumClient;
  /** Deliver a frame as though the server had sent it. */
  serve(msg: ServerMessage): void;
  /** Every `onProtocol` call, as [theirs, ours]. */
  readonly seen: readonly (readonly [number, number])[];
  readonly states: readonly string[];
  readonly statuses: readonly ConnStatus[];
  readonly closed: () => boolean;
  readonly welcomed: () => number;
}

function wire(answer: (theirs: number) => ProtocolAction): Wire {
  // An array rather than a `let`: the compiler cannot see a write that happens
  // inside a callback, so a nullable variable assigned there stays narrowed to
  // `null` and calling through it does not typecheck.
  const opened: TransportHandlers[] = [];
  let closed = false;
  const seen: (readonly [number, number])[] = [];
  const states: string[] = [];
  const statuses: ConnStatus[] = [];
  let welcomed = 0;

  const transport = (h: TransportHandlers): Transport => {
    opened.push(h);
    return {
      send() {},
      close() {
        closed = true;
      },
    };
  };

  const client = new QuorumClient({
    hello: () => ({ t: "hello", role: "screen", screenToken: "t" }),
    transport,
    onProtocol: (theirs, ours) => {
      seen.push([theirs, ours]);
      return answer(theirs);
    },
    onWelcome: () => {
      welcomed += 1;
    },
    onState: (s) => {
      states.push(s.segment);
    },
    onStatus: (s) => {
      statuses.push(s);
    },
  });
  built.push(client);
  client.start();

  return {
    client,
    serve: (msg) => opened[opened.length - 1]?.onMessage(msg),
    seen,
    states,
    statuses,
    closed: () => closed,
    welcomed: () => welcomed,
  };
}

function welcome(protocol: number): ServerMessage {
  return { t: "welcome", role: "screen", sid: "s", serverTime: Date.now(), protocol };
}

/** The smallest `state` frame that is a real one. */
function state(seq: number): ServerMessage {
  return {
    t: "state",
    seq,
    state: {
      sid: "s",
      title: "A session",
      subtitle: null,
      phase: "running",
      segment: "lobby",
      seal: "live",
      reveals: 0,
      practice: false,
      holding: null,
      roster: [],
      joinsLocked: false,
      standings: [],
      activities: [],
    },
  };
}

/* ------------------------------------------------------------------ */

describe("the welcome frame's protocol version reaches the surface", () => {
  test("every welcome is offered, with the server's version and this build's", () => {
    const w = wire(() => "continue");
    w.serve(welcome(PROTOCOL_VERSION));
    assert.deepEqual(w.seen, [[PROTOCOL_VERSION, PROTOCOL_VERSION]]);
  });

  test("a mismatching welcome too, with the number the server actually sent", () => {
    const w = wire(() => "continue");
    w.serve(welcome(PROTOCOL_VERSION + 7));
    assert.deepEqual(w.seen, [[PROTOCOL_VERSION + 7, PROTOCOL_VERSION]]);
  });

  test("it is this build's compiled-in constant and not whatever arrived", () => {
    // The bug would be passing `msg.protocol` for both, which agrees with
    // itself forever and can never be a mismatch.
    const w = wire(() => "continue");
    w.serve(welcome(99));
    assert.equal(w.seen[0]?.[1], PROTOCOL_VERSION);
    assert.notEqual(w.seen[0]?.[0], w.seen[0]?.[1]);
  });

  test("a welcome on every reconnect, not only the first", () => {
    // A deploy is a reconnect. If the check only ran on the first welcome of a
    // page's life it would never run in the case it exists for.
    const w = wire(() => "continue");
    w.serve(welcome(PROTOCOL_VERSION));
    w.serve(welcome(PROTOCOL_VERSION + 1));
    assert.equal(w.seen.length, 2);
  });
});

describe("halt stops the client before it renders anything", () => {
  test("no welcome is delivered to the page", () => {
    const w = wire(() => "halt");
    w.serve(welcome(PROTOCOL_VERSION + 1));
    assert.equal(w.welcomed(), 0);
  });

  test("and no state, which is the frame that would have thrown", () => {
    const w = wire(() => "halt");
    w.serve(welcome(PROTOCOL_VERSION + 1));
    w.serve(state(1));
    assert.deepEqual(
      w.states,
      [],
      "a halted client must not hand the page a frame of an unknown shape",
    );
  });

  test("the socket is closed and the status says we stopped on purpose", () => {
    const w = wire(() => "halt");
    w.serve(welcome(PROTOCOL_VERSION + 1));
    assert.ok(w.closed(), "the transport must be closed, not left reconnecting");
    assert.equal(w.client.status, "gone");
    assert.ok(!w.statuses.includes("live"), "and must never have gone live");
  });

  test("nothing that is still in flight gets in afterwards", () => {
    // Closing a socket does not un-queue what the far end already sent, so a
    // frame can land after the decision not to want any. A halted surface
    // halted *because* the next frame may be a shape it cannot render.
    const w = wire(() => "halt");
    w.serve(welcome(PROTOCOL_VERSION + 1));
    w.serve(state(1));
    w.serve(welcome(PROTOCOL_VERSION + 1));
    w.serve(state(2));
    assert.equal(w.seen.length, 1, "the check does not run again on a dead client");
    assert.equal(w.welcomed(), 0);
    assert.deepEqual(w.states, []);
    assert.equal(w.client.status, "gone", "and it stays stopped, never reconnecting");
  });
});

describe("continue leaves a client that still works", () => {
  test("the page gets its welcome and its state", () => {
    const w = wire(() => "continue");
    w.serve(welcome(PROTOCOL_VERSION + 1));
    w.serve(state(1));
    assert.equal(w.welcomed(), 1);
    assert.deepEqual(w.states, ["lobby"]);
    assert.equal(w.client.status, "live");
  });

  test("a client with no `onProtocol` at all is unaffected", () => {
    // The hook is optional — `bots/` and `swarm` build clients too — and a
    // caller that omits it must get the behaviour it had before #33 rather
    // than a client that halts on an undefined answer.
    const opened: TransportHandlers[] = [];
    const bare = new QuorumClient({
      hello: () => ({ t: "hello", role: "screen", screenToken: "t" }),
      transport: (h) => {
        opened.push(h);
        return { send() {}, close() {} };
      },
    });
    built.push(bare);
    bare.start();
    opened[0]?.onMessage(welcome(PROTOCOL_VERSION + 1));
    assert.equal(bare.status, "live");
  });
});
