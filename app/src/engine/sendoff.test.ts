/**
 * Walking a send-off, and the run it walks through.
 *
 * The forward and back walk is one function on purpose, so these mostly check
 * the shapes a real file can take: no opening photos, no closing, one message,
 * none at all. Every one of those is a send-off somebody will actually stage,
 * and each is a way for a two-directional walk to fall off an end.
 *
 * The rest is the plan: the photographs and the messages are dealt into one
 * sequence now, and the two properties that matter to the room are that every
 * photograph is used and that a split message is never interrupted.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Activity, Event, SendoffContent, SessionState } from "./types.ts";
import { newSession, reduce } from "./reducer.ts";
import { buildPlan, longestSlide, partsOf, slideMs, splitMessage } from "./sendoff.ts";

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
    { type: "loadSendoff", content: c, seed: 7 },
  ] as Event[]) {
    s = reduce(s, e, 1000).state;
  }
  return s;
}

/** Walk one way and report each stop as "phase" or "phase:index". */
function walk(s: SessionState, dir: "sendoffNext" | "sendoffBack", n = 20): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = reduce(s, { type: dir } as Event, 1000);
    if (r.state.seq === s.seq) break;
    s = r.state;
    const so = s.sendoff;
    if (!so) break;
    out.push(so.phase === "run" ? `run:${so.at}` : so.phase);
  }
  return out;
}

describe("the walk", () => {
  test("holds on the title card, then walks the run, closing, done — and stops", () => {
    const s = ready();
    assert.equal(s.sendoff?.phase, "title", "a send-off started without being asked to");
    const slides = s.sendoff!.plan.length;
    const steps = walk(s, "sendoffNext");
    assert.deepEqual(steps.slice(0, slides), [...Array(slides).keys()].map((i) => `run:${i}`));
    assert.deepEqual(steps.slice(slides), ["closing", "done"]);
  });

  test("comes back the same way, and stops at the title card", () => {
    let s = ready();
    const slides = s.sendoff!.plan.length;
    for (let i = 0; i < slides + 2; i += 1) {
      s = reduce(s, { type: "sendoffNext" } as Event, 1000).state;
    }
    assert.equal(s.sendoff?.phase, "done");
    const back = walk(s, "sendoffBack");
    assert.equal(back[0], "closing");
    assert.equal(back.at(-1), "title", "back did not come to rest on the title card");
    // and there is nowhere before it
    let atTitle = s;
    for (let i = 0; i < back.length; i += 1) {
      atTitle = reduce(atTitle, { type: "sendoffBack" } as Event, 1000).state;
    }
    assert.equal(
      reduce(atTitle, { type: "sendoffBack" } as Event, 1000).state.seq,
      atTitle.seq,
      "the walk went back past the title card",
    );
  });

  test("a send-off with no photos is still a run of its messages", () => {
    const s = ready(content({ opening: { photos: [], seconds: 40, music: null } }));
    assert.equal(s.sendoff?.phase, "title");
    assert.equal(s.sendoff?.plan.length, 2);
    assert.deepEqual(walk(s, "sendoffNext"), ["run:0", "run:1", "closing", "done"]);
  });

  test("skips a closing that has neither photos nor a line", () => {
    const s = ready(content({ closing: { photos: [], line: null } }));
    assert.equal(walk(s, "sendoffNext").at(-1), "done");
    assert.ok(!walk(s, "sendoffNext").includes("closing"));
  });

  test("survives a send-off that is only photos", () => {
    const s = ready(content({ kudos: [], closing: { photos: [], line: null } }));
    assert.deepEqual(walk(s, "sendoffNext"), ["run:0", "run:1", "done"]);
  });
});

describe("the plan", () => {
  const many = content({
    opening: {
      photos: [...Array(43).keys()].map((i) => `p${i}.jpg`),
      seconds: 40,
      music: null,
    },
    kudos: [...Array(13).keys()].map((i) => ({ from: `f${i}`, message: `m${i}` })),
  });

  test("uses every photograph exactly once", () => {
    const plan = buildPlan(many, 99);
    const keys = plan.flatMap((s) => (s.kind === "photo" ? [s.key] : []));
    assert.equal(keys.length, 43);
    assert.equal(new Set(keys).size, 43, "a photograph was shown twice or dropped");
  });

  test("uses every message exactly once", () => {
    const plan = buildPlan(many, 99);
    const ats = plan.flatMap((s) => (s.kind === "kudo" ? [s.at] : []));
    assert.deepEqual([...new Set(ats)].sort((a, b) => a - b), [...Array(13).keys()]);
  });

  test("spreads the messages through the photographs rather than blocking them", () => {
    const plan = buildPlan(many, 99);
    // No message is adjacent to another message's *first* part, which is what
    // "spread" means here: the old shape was thirteen of them in a row.
    const firstParts = plan.flatMap((s, i) => (s.kind === "kudo" && s.part === 0 ? [i] : []));
    const gaps = firstParts.slice(1).map((at, i) => at - firstParts[i]!);
    assert.ok(Math.min(...gaps) >= 2, `two messages ran together: gaps ${gaps.join(",")}`);
    // and it opens and closes on photographs
    assert.equal(plan[0]?.kind, "photo");
    assert.equal(plan.at(-1)?.kind, "photo");
  });

  test("is the same plan for the same seed, and a different one otherwise", () => {
    assert.deepEqual(buildPlan(many, 99), buildPlan(many, 99));
    assert.notDeepEqual(buildPlan(many, 99), buildPlan(many, 100));
  });

  test("keeps a split message's parts together", () => {
    const long = "A ".repeat(200).trim() + ". " + "B ".repeat(200).trim() + ".";
    const plan = buildPlan(
      content({ kudos: [{ from: "f", message: long }], opening: { photos: ["a", "b"], seconds: 1, music: null } }),
      3,
    );
    const at = plan.findIndex((s) => s.kind === "kudo");
    const parts = plan.filter((s) => s.kind === "kudo").length;
    assert.ok(parts > 1, "a 400-character message was not split");
    for (let i = 0; i < parts; i += 1) {
      const slide = plan[at + i];
      assert.equal(slide?.kind, "kudo", "a photograph interrupted a message");
      assert.equal(slide.kind === "kudo" ? slide.part : -1, i);
    }
  });
});

describe("splitting a message", () => {
  test("leaves a short one whole", () => {
    assert.deepEqual(splitMessage("Thank you for everything."), ["Thank you for everything."]);
  });

  test("cuts at sentence ends, never mid-sentence", () => {
    const parts = splitMessage(`${"Word ".repeat(50).trim()}. ${"Other ".repeat(50).trim()}.`);
    assert.ok(parts.length > 1);
    for (const part of parts) assert.ok(!part.startsWith("."), "a slide began with a full stop");
  });

  test("does not cut inside a domain name", () => {
    // The first version of the splitter cut here and put a slide reading
    // "io, I was already so scarred..." in front of the room.
    const real = `${"Filler ".repeat(30).trim()} about consul.io, I was already so scarred by it. ${"More ".repeat(30).trim()}.`;
    for (const part of splitMessage(real)) {
      assert.ok(!part.startsWith("io,"), `cut inside a domain: ${part.slice(0, 40)}`);
    }
  });

  test("does not cut after an abbreviation that is not a sentence end", () => {
    const real = `${"Filler ".repeat(30).trim()} — e.g. the migration work — and more. ${"More ".repeat(30).trim()}.`;
    for (const part of splitMessage(real)) {
      assert.ok(!part.startsWith("the migration"), "cut after e.g.");
    }
  });

  test("leaves one enormous sentence whole rather than breaking it", () => {
    const one = `${"word ".repeat(120).trim()}.`;
    assert.deepEqual(splitMessage(one), [one]);
  });

  test("the longest slide is shorter than the longest message once split", () => {
    const c = content({
      kudos: [{ from: "f", message: `${"Aa ".repeat(150).trim()}. ${"Bb ".repeat(150).trim()}.` }],
    });
    assert.ok(longestSlide(c) < c.kudos[0]!.message.length, "splitting did not shorten the fit");
  });
});

describe("auto-advance", () => {
  test("is off when a send-off loads, because the host advances it", () => {
    assert.equal(ready().sendoff?.auto, false);
  });

  test("turns on and off, and a repeat is not an event", () => {
    const s = ready();
    const on = reduce(s, { type: "setSendoffAuto", auto: true } as Event, 1000);
    assert.ok(on.applied);
    assert.equal(on.state.sendoff?.auto, true);
    assert.equal(
      reduce(on.state, { type: "setSendoffAuto", auto: true } as Event, 1000).state.seq,
      on.state.seq,
    );
  });

  test("clamps the speed to the slider's range and refuses nonsense", () => {
    const s = ready();
    assert.equal(
      reduce(s, { type: "setSendoffSpeed", seconds: 999 } as Event, 1000).state.sendoff?.autoSeconds,
      12,
    );
    assert.equal(
      reduce(s, { type: "setSendoffSpeed", seconds: -4 } as Event, 1000).state.sendoff?.autoSeconds,
      2,
    );
    const bad = reduce(s, { type: "setSendoffSpeed", seconds: Number.NaN } as Event, 1000);
    assert.equal(bad.state.seq, s.seq);
  });

  test("a message holds longer than a photograph, and the slider moves both", () => {
    const c = content({ kudos: [{ from: "f", message: "x".repeat(200) }] });
    const plan = buildPlan(c, 5);
    const photo = plan.find((s) => s.kind === "photo")!;
    const kudo = plan.find((s) => s.kind === "kudo")!;
    assert.ok(slideMs(kudo, c, 4) > slideMs(photo, c, 4), "a message flashed past like a photo");
    assert.ok(slideMs(photo, c, 8) > slideMs(photo, c, 4), "the slider did not slow the photos");
    assert.ok(slideMs(kudo, c, 8) > slideMs(kudo, c, 4), "the slider did not slow the messages");
  });
});

describe("loading it", () => {
  test("refuses a send-off with neither messages nor photos", () => {
    let s = newSession({ sid: "s", title: "t", joinCode: "hvs.a", activities: ACT });
    s = reduce(s, { type: "open" } as Event, 1000).state;
    const empty = content({ kudos: [], opening: { photos: [], seconds: 40, music: null } });
    const r = reduce(s, { type: "loadSendoff", content: empty, seed: 1 } as Event, 1000);
    assert.equal(r.state.seq, s.seq);
  });

  test("can be replaced before it starts and not after", () => {
    const s = ready();
    assert.ok(reduce(s, { type: "loadSendoff", content: content(), seed: 2 } as Event, 1000).applied);
    const started = reduce(s, { type: "sendoffNext" } as Event, 1000).state;
    const after = reduce(started, { type: "loadSendoff", content: content(), seed: 2 } as Event, 1000);
    assert.equal(after.state.seq, started.seq, "a started send-off was replaced");
  });

  test("a restart rewinds it to the title card but keeps the content and the plan", () => {
    let s = ready();
    for (let i = 0; i < 3; i += 1) s = reduce(s, { type: "sendoffNext" } as Event, 1000).state;
    const plan = s.sendoff!.plan;
    const back = reduce(s, { type: "restartSession" } as Event, 1000).state;
    assert.equal(back.sendoff?.phase, "title");
    assert.equal(back.sendoff?.at, 0);
    assert.equal(back.sendoff?.content.kudos.length, 2, "a restart threw the messages away");
    assert.deepEqual(back.sendoff?.plan, plan, "a restart re-dealt the running order");
  });
});

describe("what each surface is told", () => {
  test("only the host is told what is next", async () => {
    const { renderStateFor } = await import("../server/views.ts");
    const s = ready();
    const opts = { now: 1000, lastSeen: new Map() };
    const host = renderStateFor(s, { ...opts, role: "host" } as never);
    const screen = renderStateFor(s, { ...opts, role: "screen" } as never);
    assert.ok(host.sendoff?.next?.from, "the host was not told the first message");
    assert.equal(screen.sendoff?.next, undefined, "a non-host surface was told the next message");
  });

  test("a message slide carries one part, not the whole message", async () => {
    const { renderStateFor } = await import("../server/views.ts");
    const long = `${"Alpha ".repeat(60).trim()}. ${"Beta ".repeat(60).trim()}.`;
    let s = ready(content({ kudos: [{ from: "f", message: long }] }));
    const opts = { now: 1000, lastSeen: new Map(), role: "screen" } as never;
    for (let i = 0; i < 20; i += 1) {
      s = reduce(s, { type: "sendoffNext" } as Event, 1000).state;
      const view = renderStateFor(s, opts).sendoff;
      if (view?.kudo) {
        assert.ok(view.parts > 1, "the long message was not split on the wire");
        assert.ok(
          view.kudo.message.length < long.length,
          "a surface was sent the whole message rather than one slide of it",
        );
        assert.deepEqual(view.kudo.message, partsOf({ from: "f", message: long })[view.part - 1]);
        return;
      }
    }
    assert.fail("never reached a message");
  });

  test("the music stops at the first message and does not come back", async () => {
    const { renderStateFor } = await import("../server/views.ts");
    let s = ready(
      content({
        opening: { photos: ["a.jpg", "b.jpg", "c.jpg"], seconds: 40, music: "song.mp3" },
      }),
    );
    const opts = { now: 1000, lastSeen: new Map(), role: "screen" } as never;
    let seenMessage = false;
    for (let i = 0; i < 20; i += 1) {
      s = reduce(s, { type: "sendoffNext" } as Event, 1000).state;
      const view = renderStateFor(s, opts).sendoff;
      if (!view) break;
      if (view.kudo) seenMessage = true;
      if (seenMessage) {
        assert.equal(view.music, null, "music was still playing under somebody's words");
      }
    }
    assert.ok(seenMessage, "never reached a message");
  });
});

describe("a send-off written by the old engine", () => {
  test("is brought up to shape rather than crashing the first projection", async () => {
    const { rehydrate } = await import("../server/recovery.ts");
    const started = ready();
    // What a snapshot from before the run existed looks like: an `opening` /
    // `kudos` walk, no plan, no auto.
    const legacy = {
      ...started,
      sendoff: {
        content: content(),
        phase: "kudos",
        at: 1,
        openingStartedAt: null,
      },
    };
    const out = rehydrate({
      meta: { sid: "s", title: "t", joinCode: "hvs.a" },
      snapshot: { seq: started.seq, state: legacy },
      events: [],
    } as never);
    const so = out?.state.sendoff;
    assert.ok(so, "the session did not come back");
    assert.equal(so.phase, "run");
    assert.ok(Array.isArray(so.plan) && so.plan.length > 0, "no plan was built");
    assert.equal(so.auto, false);
    // and it lands on the message the old state was showing
    const here = so.plan[so.at];
    assert.equal(here?.kind, "kudo");
    assert.equal(here.kind === "kudo" ? here.at : -1, 1);

    // the thing that used to throw
    const { renderStateFor } = await import("../server/views.ts");
    const view = renderStateFor(out!.state, {
      now: 1000,
      lastSeen: new Map(),
      role: "screen",
    } as never);
    assert.equal(view.sendoff?.kudo?.from, "Yong Wen");
  });
});
