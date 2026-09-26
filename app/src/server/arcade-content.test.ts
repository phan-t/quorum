/**
 * Staged arcade content, at the seam where a round is configured.
 *
 * Four of the six arcade rounds carry content — Recruitment's emoji, Unseal's
 * tins, the Bridge's panes, Gganbu's prompts — and until staging existed each
 * one was a TypeScript literal compiled into the build, so correcting a wrong
 * Vault default meant a deploy. `loadArcadeContent` puts an event's own content
 * in the session state; `commandToEvent` is where it is picked up, because that
 * is where the round factories are called and where `runtime.state` is in hand.
 *
 * **The property this file is for is the fallback, not the feature.** A session
 * that staged nothing has to behave exactly as it did before any of this
 * existed, and "exactly" here means the identical array: the tests below assert
 * *identity* against `RECRUITMENT_ITEMS` and friends, not deep equality, so a
 * change that quietly hands the factory a copy — or a merged object, or an
 * empty array — fails rather than passing on a structural match.
 *
 * Asserted against the event `commandToEvent` returns rather than through a
 * socket, on purpose: the content is the answer key and deliberately never
 * reaches a frame a browser could be made to echo, so there is nothing on the
 * wire to assert on. `arcade.test.ts` is where the not-on-the-wire half lives.
 *
 * Its own file rather than an addition to arcade.test.ts: `main.ts` listens on
 * import, and node's test runner gives each file its own process — the reason
 * the promo, send-off and export HTTP tests are each their own file too.
 *
 * Every fixture below is invented, and deliberately unlike the shipped content:
 * `STAGED-*` appears in exactly one place, so finding it in a config is
 * unambiguous.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { newSession, replay } from "../engine/reducer.ts";
import type {
  ArcadeContent,
  ArcadeRoundConfig,
  EmojiItem,
  Event,
  GlassStep,
  OverUnderItem,
  SessionState,
  UnsealItem,
} from "../engine/types.ts";
import type { HostCommand } from "../protocol.ts";
import { DEFAULT_ACTIVITIES, SessionRegistry, SessionRuntime } from "./runtime.ts";
import { Persister } from "./persist.ts";
import { MemoryStore } from "./store/memory.ts";
import { recoverSessions, rehydrate } from "./recovery.ts";
import type { LoadedSession } from "./store/types.ts";
import { RECRUITMENT_ITEMS } from "../arcade/recruitment.ts";
import { UNSEAL_ITEMS } from "../arcade/unseal.ts";
import { GLASS_BRIDGE_STEPS } from "../arcade/glass-bridge.ts";
import { GGANBU_PROMPTS } from "../arcade/gganbu.ts";

process.env["PORT"] = "0";
process.env["QUORUM_ADMIN_KEY"] = "test-admin-" + Math.random().toString(36).slice(2);

const { server, persister, commandToEvent } = await import("./main.ts");

before(async () => {
  if (!server.listening) await once(server, "listening");
});

after(async () => {
  await persister.drain();
  server.close();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const STAGED_RECRUITMENT: readonly EmojiItem[] = [
  {
    cue: "🪁🧪",
    answer: "STAGED-RECRUITMENT",
    accept: ["sr"],
    note: "STAGED-RECRUITMENT-NOTE.",
  },
];

const STAGED_UNSEAL: readonly UnsealItem[] = [
  {
    shape: "triangle",
    cue: "DEGATS",
    answer: "STAGED-UNSEAL",
    note: "STAGED-UNSEAL-NOTE.",
  },
];

const STAGED_BRIDGE: readonly GlassStep[] = [
  {
    product: "STAGED-BRIDGE",
    panes: [
      { label: "STAGED-BRIDGE-REAL", note: "STAGED-BRIDGE-REAL-NOTE." },
      { label: "STAGED-BRIDGE-FAKE", note: "STAGED-BRIDGE-FAKE-NOTE." },
    ],
    real: 0,
  },
];

const STAGED_GGANBU: readonly OverUnderItem[] = [
  {
    cue: "STAGED-GGANBU",
    threshold: "7",
    answer: "over",
    note: "STAGED-GGANBU-NOTE.",
    verify: false,
  },
];

let n = 0;

/**
 * A runtime holding a session that has staged `content`, or nothing.
 *
 * The content goes in through the reducer rather than by editing the state:
 * `loadArcadeContent` is the only writer, and a test that set the field by hand
 * would still pass if the event arm were deleted.
 */
function runtimeWith(content: ArcadeContent | null): SessionRuntime {
  n += 1;
  const base = newSession({
    sid: `ses_ac_${n}`,
    title: `Arcade content ${n}`,
    joinCode: `hvs.arcadecontent${String(n).padStart(3, "0")}xxxxx`,
    activities: DEFAULT_ACTIVITIES,
  });
  const events: Event[] = [
    { type: "open" },
    { type: "start" },
    ...(content ? [{ type: "loadArcadeContent" as const, content }] : []),
  ];
  const state = replay(
    base,
    events.map((event) => ({ event, at: 1_700_000_000_000 })),
  );
  if (content) {
    assert.ok(
      state.arcadeContent,
      "the fixture's loadArcadeContent was refused — the reducer arm changed",
    );
  }
  const runtime = new SessionRuntime(state, {
    hostTokenHash: "h",
    screenTokenHash: "s",
  });
  // Fixed, so Gganbu's and Tug of Raft's boundary-drawn seeds do not make two
  // otherwise identical configs differ.
  runtime.rng = () => 0.5;
  return runtime;
}

/** The config `cmd` would start a round with, or a failure naming what came back. */
function configFor(runtime: SessionRuntime, cmd: HostCommand): ArcadeRoundConfig {
  const event = commandToEvent(cmd, runtime);
  assert.ok(event, `${cmd.name} produced no event`);
  assert.equal(event.type, "startRound", `${cmd.name} produced a ${event.type}`);
  assert.ok(event.type === "startRound");
  return event.config;
}

const RECRUITMENT_CMD: HostCommand = {
  name: "arcade.round",
  kind: "recruitment",
  secondsPerItem: 20,
};
const UNSEAL_CMD: HostCommand = { name: "arcade.round", kind: "unseal", seconds: 60 };
const BRIDGE_CMD: HostCommand = {
  name: "arcade.round",
  kind: "glass_bridge",
  waveSeconds: [12, 9, 6],
};
const GGANBU_CMD: HostCommand = {
  name: "arcade.round",
  kind: "gganbu",
  secondsPerPrompt: 15,
  startTokens: 10,
};
const TUG_CMD: HostCommand = {
  name: "arcade.round",
  kind: "tug_of_raft",
  pulls: 3,
  pullSeconds: 25,
  bpm: 100,
};

function recruitmentItems(runtime: SessionRuntime): readonly EmojiItem[] {
  const config = configFor(runtime, RECRUITMENT_CMD);
  assert.ok(config.kind === "recruitment");
  return config.items;
}

function unsealItems(runtime: SessionRuntime): readonly UnsealItem[] {
  const config = configFor(runtime, UNSEAL_CMD);
  assert.ok(config.kind === "unseal");
  return config.items;
}

function bridgeSteps(runtime: SessionRuntime): readonly GlassStep[] {
  const config = configFor(runtime, BRIDGE_CMD);
  assert.ok(config.kind === "glass_bridge");
  return config.steps;
}

function gganbuPrompts(runtime: SessionRuntime): readonly OverUnderItem[] {
  const config = configFor(runtime, GGANBU_CMD);
  assert.ok(config.kind === "gganbu");
  return config.prompts;
}

/* ------------------------------------------------------------------ */
/* A session that staged nothing                                        */
/* ------------------------------------------------------------------ */

describe("a session that staged nothing", () => {
  it("plays the compiled content, the same array and not a copy of it", () => {
    const runtime = runtimeWith(null);
    // Identity, not deepEqual: "behaves exactly as it does today" is the whole
    // safety property, and a deep match would also accept a rebuilt array.
    assert.equal(recruitmentItems(runtime), RECRUITMENT_ITEMS);
    assert.equal(unsealItems(runtime), UNSEAL_ITEMS);
    assert.equal(bridgeSteps(runtime), GLASS_BRIDGE_STEPS);
    assert.equal(gganbuPrompts(runtime), GGANBU_PROMPTS);
  });

  it("has no arcadeContent key at all, rather than an empty one", () => {
    // Absent, not `{}`. The distinction is the one the September outage turned
    // on, and it is why every read of this field is optional-chained.
    const runtime = runtimeWith(null);
    assert.equal("arcadeContent" in runtime.state, false);
    assert.equal(runtime.state.arcadeContent, undefined);
  });

  it("refuses an upload that stages no rounds, leaving the defaults alone", () => {
    const runtime = runtimeWith(null);
    const after = replay(runtime.state, [
      { event: { type: "loadArcadeContent", content: {} }, at: 1_700_000_000_001 },
    ]);
    assert.equal(after.arcadeContent, undefined);
    assert.equal(recruitmentItems(new SessionRuntime(after, {
      hostTokenHash: "h",
      screenTokenHash: "s",
    })), RECRUITMENT_ITEMS);
  });
});

/* ------------------------------------------------------------------ */
/* A session that staged something                                      */
/* ------------------------------------------------------------------ */

describe("a session that staged content", () => {
  it("plays the staged items on every round that has them", () => {
    const runtime = runtimeWith({
      recruitment: STAGED_RECRUITMENT,
      unseal: STAGED_UNSEAL,
      glassBridge: STAGED_BRIDGE,
      gganbu: STAGED_GGANBU,
    });
    assert.deepEqual(recruitmentItems(runtime), STAGED_RECRUITMENT);
    assert.deepEqual(unsealItems(runtime), STAGED_UNSEAL);
    assert.deepEqual(bridgeSteps(runtime), STAGED_BRIDGE);
    assert.deepEqual(gganbuPrompts(runtime), STAGED_GGANBU);
    // And the compiled content is genuinely not what was handed over, which
    // `deepEqual` above would not catch if a fixture ever matched the literal.
    assert.notEqual(recruitmentItems(runtime), RECRUITMENT_ITEMS);
    assert.notEqual(unsealItems(runtime), UNSEAL_ITEMS);
    assert.notEqual(bridgeSteps(runtime), GLASS_BRIDGE_STEPS);
    assert.notEqual(gganbuPrompts(runtime), GGANBU_PROMPTS);
  });

  it("leaves the other three rounds on the compiled content", () => {
    // One key staged, four rounds configured. Each arm reads exactly one key,
    // so staging Gganbu cannot reach the Bridge — this is the assertion that
    // says so rather than the comment that claims it.
    const runtime = runtimeWith({ gganbu: STAGED_GGANBU });
    assert.deepEqual(gganbuPrompts(runtime), STAGED_GGANBU);
    assert.equal(recruitmentItems(runtime), RECRUITMENT_ITEMS);
    assert.equal(unsealItems(runtime), UNSEAL_ITEMS);
    assert.equal(bridgeSteps(runtime), GLASS_BRIDGE_STEPS);
  });

  it("changes nothing at all about a round the host never runs", () => {
    // A host stages the Bridge and then runs Recruitment. The staged key sits
    // in the state unread: the event Recruitment starts with must be identical
    // to the one an unstaged session would have produced, field for field,
    // including the numbers the host set.
    const staged = runtimeWith({ glassBridge: STAGED_BRIDGE });
    const plain = runtimeWith(null);
    assert.deepEqual(
      commandToEvent(RECRUITMENT_CMD, staged),
      commandToEvent(RECRUITMENT_CMD, plain),
    );
    assert.deepEqual(
      commandToEvent(UNSEAL_CMD, staged),
      commandToEvent(UNSEAL_CMD, plain),
    );
    assert.deepEqual(
      commandToEvent(GGANBU_CMD, staged),
      commandToEvent(GGANBU_CMD, plain),
    );
  });

  it("does not reach Tug of Raft, which has no content to stage", () => {
    // `ArcadeContent` has no key for it and the arm reads none. Pinned because
    // "unaffected" is only obvious while nobody adds a fifth key.
    const staged = runtimeWith({
      recruitment: STAGED_RECRUITMENT,
      unseal: STAGED_UNSEAL,
      glassBridge: STAGED_BRIDGE,
      gganbu: STAGED_GGANBU,
    });
    const plain = runtimeWith(null);
    assert.deepEqual(commandToEvent(TUG_CMD, staged), commandToEvent(TUG_CMD, plain));
    const config = configFor(staged, TUG_CMD);
    assert.ok(config.kind === "tug_of_raft");
    assert.deepEqual(Object.keys(config).sort(), ["bpm", "kind", "pullSeconds", "pulls", "seed"]);
  });

  it("plays the later upload when two stage the same round", () => {
    // The reducer merges key by key; what this pins is that the call site
    // reads the merged value and not the first one written.
    const runtime = runtimeWith({ unseal: UNSEAL_ITEMS.slice(0, 1) });
    const merged = replay(runtime.state, [
      {
        event: { type: "loadArcadeContent", content: { unseal: STAGED_UNSEAL } },
        at: 1_700_000_000_002,
      },
    ]);
    runtime.state = merged;
    assert.deepEqual(unsealItems(runtime), STAGED_UNSEAL);
  });
});

/* ------------------------------------------------------------------ */
/* Persistence and recovery                                            */
/* ------------------------------------------------------------------ */

/**
 * `arcadeContent` is a plain optional field on `SessionState`, so the snapshot
 * should carry it with no code anywhere — the store writes the state whole and
 * `rehydrate` uses `snapshot.state` as its base. That is a claim about two
 * files nobody edited, which is exactly the kind that is worth an assertion.
 *
 * The other half is the one `recovery.ts` exists to get right: a row written
 * before staging shipped has no `arcadeContent` attribute at all. It must come
 * back **absent**, not null and not `{}`, because every read of it is
 * optional-chained and a null would be read as "staged nothing" by luck rather
 * than by design. No migration is added for it: there is nothing to migrate to,
 * since absent already means "play the compiled content", which is what that
 * session was playing before the deploy.
 *
 * **One gap these tests found and do not paper over.** The reducer's
 * `loadArcadeContent` arm returns `effects: []` — no `persist` and no
 * `broadcast`. `SessionRuntime.apply` gates both the snapshot write and the
 * stored-event write on the engine's own `persist` effect, so staging writes
 * nothing to the store: the content survives only from the next transition that
 * *does* persist, and a crash in the window between the upload and that
 * transition loses it. Nothing here can fix that — the effect belongs in
 * `engine/reducer.ts`, which this change deliberately does not touch, and
 * `loadTrivia` one arm below returns `[BROADCAST_STATE, PERSIST]` for exactly
 * this reason. It is reported, not asserted, so that the arm can be corrected
 * without a test here having to move.
 */
describe("staged content across a restart", () => {
  let store: MemoryStore;
  let persist: Persister;

  before(() => {
    store = new MemoryStore();
    persist = new Persister(store, () => {});
  });

  it("rides in the snapshot with no code in recovery.ts or the stores", async () => {
    const registry = new SessionRegistry(persist);
    const created = registry.add(
      newSession({
        sid: "ses_ac_snap",
        title: "Staged",
        joinCode: "hvs.arcadecontentsnapxxxxxxx",
        activities: DEFAULT_ACTIVITIES,
      }),
    );
    const now = 1_700_000_000_000;
    created.runtime.apply({ type: "open" }, now);
    created.runtime.apply({ type: "start" }, now);
    created.runtime.apply(
      { type: "loadArcadeContent", content: { unseal: STAGED_UNSEAL } },
      now,
    );
    // The join is not decoration and it is not "a realistic session" either: it
    // is here because `loadArcadeContent` returns **no effects at all**, so
    // staging on its own writes no snapshot and no stored event. The next
    // transition that does persist is what puts `arcadeContent` in the table.
    // See the note on this suite: that gap is the engine's to close and is
    // reported rather than worked around, and this line is what keeps this test
    // about the claim it can actually make — that the *field* rides along in a
    // snapshot with no code in `recovery.ts` or either store.
    created.runtime.apply({ type: "join", pid: "p1", nickname: "Priya" }, now);
    await persist.drain();

    const loaded = await store.loadSession("ses_ac_snap");
    assert.ok(loaded?.snapshot, "no snapshot was written");
    const built = rehydrate(loaded);
    assert.equal(built?.from, "snapshot");
    assert.deepEqual(built?.state.arcadeContent?.unseal, STAGED_UNSEAL);

    // And the recovered session still plays it — the point of persisting it.
    const registry2 = new SessionRegistry(new Persister(store, () => {}));
    const recovered = await recoverSessions(store, registry2, () => {});
    assert.equal(recovered.length, 1);
    const back = registry2.bySessionId("ses_ac_snap");
    assert.ok(back);
    assert.deepEqual(unsealItems(back), STAGED_UNSEAL);
    // The rounds nobody staged are still on the compiled content after a
    // restart, which is the fallback surviving the trip rather than the value.
    assert.equal(recruitmentItems(back), RECRUITMENT_ITEMS);
    assert.equal(bridgeSteps(back), GLASS_BRIDGE_STEPS);
    assert.equal(gganbuPrompts(back), GGANBU_PROMPTS);
  });

  it("recovers an old row with no arcadeContent attribute, as absent", async () => {
    const own = new MemoryStore();
    const p = new Persister(own, () => {});
    const registry = new SessionRegistry(p);
    const created = registry.add(
      newSession({
        sid: "ses_ac_old",
        title: "Old row",
        joinCode: "hvs.arcadecontentoldxxxxxxxx",
        activities: DEFAULT_ACTIVITIES,
      }),
    );
    const now = 1_700_000_000_000;
    created.runtime.apply({ type: "open" }, now);
    created.runtime.apply({ type: "start" }, now);
    created.runtime.apply({ type: "join", pid: "p1", nickname: "Priya" }, now);
    await p.drain();

    const loaded = await own.loadSession("ses_ac_old");
    assert.ok(loaded?.snapshot);
    // The row as the code before staging shipped wrote it: no `arcadeContent`
    // attribute, and no `version`/`writtenAt` either, since that code predates
    // the version being read back. `delete` rather than `= undefined`, because
    // DynamoDB does not store an absent attribute and the census reads the key.
    const aged = structuredClone(loaded.snapshot.state) as unknown as Record<
      string,
      unknown
    >;
    delete aged["arcadeContent"];
    assert.equal("arcadeContent" in aged, false);
    const row: LoadedSession = {
      ...loaded,
      snapshot: { seq: loaded.snapshot.seq, state: aged as unknown as SessionState },
    };

    const built = rehydrate(row);
    assert.ok(built, "an old row did not rebuild");
    // Absent, not null and not empty. A null here would be read by
    // `?.recruitment` as undefined and fall back correctly *by luck*; the
    // point is that it is absent by design and every reader is written for it.
    assert.equal("arcadeContent" in built.state, false);
    assert.equal(built.state.arcadeContent, undefined);
    assert.deepEqual(built.notes, []);

    // And the recovered session plays the compiled content, which is what it
    // was playing before the deploy. This is the whole reason no shim is added.
    const registry2 = new SessionRegistry(new Persister(own, () => {}));
    own.loadRecoverable = async () => [row];
    const recovered = await recoverSessions(own, registry2, () => {});
    assert.equal(recovered.length, 1, "the old row did not come back");
    const back = registry2.bySessionId("ses_ac_old");
    assert.ok(back);
    assert.equal(back.state.arcadeContent, undefined);
    assert.equal(recruitmentItems(back), RECRUITMENT_ITEMS);
    assert.equal(unsealItems(back), UNSEAL_ITEMS);
    assert.equal(bridgeSteps(back), GLASS_BRIDGE_STEPS);
    assert.equal(gganbuPrompts(back), GGANBU_PROMPTS);
  });
});
