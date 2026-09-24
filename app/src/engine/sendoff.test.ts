/**
 * Walking a send-off.
 *
 * The forward and back walk is one function on purpose, so these mostly check
 * the shapes a real file can take: no opening photos, no closing, one message,
 * none at all. Every one of those is a send-off somebody will actually stage,
 * and each is a way for a two-directional walk to fall off an end.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Activity, Event, SendoffContent, SessionState } from "./types.ts";
import { newSession, reduce } from "./reducer.ts";

const ACT: Activity[] = [{ id: "trivia", title: "t", kind: "trivia", spotCap: 2 }];

function content(over: Partial<SendoffContent> = {}): SendoffContent {
  return {
    name: "Sai Linn Thu",
    subtitle: "Last day 30 September 2026",
    opening: { photos: ["p01.jpg", "p02.jpg"], seconds: 40, music: null },
    kudos: [
      { from: "Jessica Ang", message: "one" },
      { from: "Yong Wen", message: "two" },
    ],
    closing: { photos: [], line: "Thank you, Sai." },
    ...over,
  };
}

function ready(c: SendoffContent = content()): SessionState {
  let s = newSession({ sid: "s", title: "t", joinCode: "hvs.a", activities: ACT });
  for (const e of [
    { type: "open" },
    { type: "start" },
    { type: "loadSendoff", content: c },
  ] as Event[]) {
    s = reduce(s, e, 1000).state;
  }
  return s;
}

/** Walk one way and report each stop as "phase" or "phase:index". */
function walk(s: SessionState, dir: "sendoffNext" | "sendoffBack", n = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = reduce(s, { type: dir } as Event, 1000);
    if (r.state.seq === s.seq) break;
    s = r.state;
    const so = s.sendoff;
    if (!so) break;
    out.push(so.phase === "kudos" ? `kudos:${so.at}` : so.phase);
  }
  return out;
}

describe("the walk", () => {
  test("goes opening, every message, closing, done — and then stops", () => {
    assert.deepEqual(walk(ready(), "sendoffNext"), ["kudos:0", "kudos:1", "closing", "done"]);
  });

  test("comes back the same way, and stops at the opening", () => {
    let s = ready();
    for (let i = 0; i < 4; i += 1) s = reduce(s, { type: "sendoffNext" } as Event, 1000).state;
    assert.equal(s.sendoff?.phase, "done");
    assert.deepEqual(walk(s, "sendoffBack"), ["closing", "kudos:1", "kudos:0", "opening"]);
  });

  test("starts on the messages when there are no opening photos", () => {
    const s = ready(content({ opening: { photos: [], seconds: 40, music: null } }));
    assert.equal(s.sendoff?.phase, "kudos");
    assert.deepEqual(walk(s, "sendoffNext"), ["kudos:1", "closing", "done"]);
  });

  test("skips a closing that has neither photos nor a line", () => {
    const s = ready(content({ closing: { photos: [], line: null } }));
    assert.deepEqual(walk(s, "sendoffNext"), ["kudos:0", "kudos:1", "done"]);
    // and stepping back out of `done` lands on the last real thing, not on an
    // empty closing frame in front of the room
    let end = s;
    for (let i = 0; i < 3; i += 1) end = reduce(end, { type: "sendoffNext" } as Event, 1000).state;
    assert.deepEqual(walk(end, "sendoffBack", 1), ["kudos:1"]);
  });

  test("a closing with photos but no line is still a stop", () => {
    const s = ready(content({ closing: { photos: ["p03.jpg"], line: null } }));
    assert.deepEqual(walk(s, "sendoffNext"), ["kudos:0", "kudos:1", "closing", "done"]);
  });

  test("survives a send-off that is only photos", () => {
    const s = ready(content({ kudos: [], closing: { photos: [], line: null } }));
    assert.deepEqual(walk(s, "sendoffNext"), ["done"]);
    assert.deepEqual(walk(reduce(s, { type: "sendoffNext" } as Event, 1000).state, "sendoffBack"), ["opening"]);
  });
});

describe("loading it", () => {
  test("refuses a send-off with neither messages nor photos", () => {
    let s = newSession({ sid: "s", title: "t", joinCode: "hvs.a", activities: ACT });
    s = reduce(s, { type: "open" } as Event, 1000).state;
    const empty = content({ kudos: [], opening: { photos: [], seconds: 40, music: null } });
    const r = reduce(s, { type: "loadSendoff", content: empty } as Event, 1000);
    assert.equal(r.state.seq, s.seq);
  });

  test("can be replaced before it starts and not after", () => {
    const s = ready();
    assert.ok(reduce(s, { type: "loadSendoff", content: content() } as Event, 1000).applied);
    const started = reduce(s, { type: "sendoffNext" } as Event, 1000).state;
    const after = reduce(started, { type: "loadSendoff", content: content() } as Event, 1000);
    assert.equal(after.state.seq, started.seq, "a started send-off was replaced");
  });

  test("a restart rewinds it but keeps the content", () => {
    let s = ready();
    for (let i = 0; i < 3; i += 1) s = reduce(s, { type: "sendoffNext" } as Event, 1000).state;
    const back = reduce(s, { type: "restartSession" } as Event, 1000).state;
    assert.equal(back.sendoff?.phase, "opening");
    assert.equal(back.sendoff?.at, 0);
    assert.equal(back.sendoff?.content.kudos.length, 2, "a restart threw the messages away");
  });
});

describe("what each surface is told", () => {
  test("only the host is told what is next", async () => {
    const { renderStateFor } = await import("../server/views.ts");
    const s = ready();
    const opts = { now: 1000, lastSeen: new Map() };
    const host = renderStateFor(s, { ...opts, role: "host" } as never);
    const screen = renderStateFor(s, { ...opts, role: "screen" } as never);
    assert.equal(host.sendoff?.next?.from, "Jessica Ang");
    assert.equal(screen.sendoff?.next, undefined, "a non-host surface was told the next message");
  });
});
