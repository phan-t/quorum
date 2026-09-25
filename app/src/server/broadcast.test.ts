/**
 * What a fan-out costs, and what the room is actually sent.
 *
 * Three claims, all about the boundary rather than about any rule:
 *
 * 1. **Tug of Raft's frames are coalesced, not sent per credited beat.** The
 *    engine credits every beat the instant it lands — that is the game — but
 *    the picture of the rope goes out on a tick. The reducer has said so
 *    since the round was written: "a throttled tick for the phones belongs at
 *    the boundary, not here."
 * 2. **Nothing is held across the end of a round.** A pull that settles, or a
 *    round that ends, takes the held frames out with it, so the rope on the
 *    screen never lags the result the host has already announced.
 * 3. **One broadcast projects the role-level view once.** Standings, the
 *    roster and the grid are a function of `(state, role)`; only `own`,
 *    `triviaMine` and `arcadeMine` are per-phone. A hundred phones must not
 *    mean a hundred sorts of the same scores.
 *
 * Plus a size budget on the frames themselves, because the thing that made
 * the rope expensive was never the cost of one send — it was frequency times
 * fan-out times frame size, and two of those three are guarded above.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { newSession, replay } from "../engine/reducer.ts";
import type { Activity, Event, SessionState } from "../engine/types.ts";
import { BEAT_FLUSH_MS, SessionRegistry, type Client } from "./runtime.ts";
import { prepareViews } from "./views.ts";

const ACTIVITIES: readonly Activity[] = [
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

const T0 = 1_700_000_000_000;
/** SPEC.md: 100 bpm, which is a beat every 600 ms. */
const BEAT_MS = 600;

const TUG: Event = {
  type: "startRound",
  round: "tug_of_raft",
  config: { kind: "tug_of_raft", pulls: 3, pullSeconds: 25, bpm: 100, seed: 12345 },
};

/** A session mid-pull, with `n` players on the rope. */
function pulling(n: number): SessionState {
  const pids = Array.from({ length: n }, (_, i) => `p_${(i + 1).toString(16).padStart(16, "0")}`);
  const events: Event[] = [
    { type: "open" },
    ...pids.map(
      (pid, i): Event => ({ type: "join", pid, nickname: `Player ${i + 1}` }),
    ),
    { type: "start" },
    { type: "setSegment", segment: "arcade" },
    { type: "enterArcade", activityId: "arcade" },
    TUG,
    { type: "beginPlay" },
  ];
  return replay(
    newSession({
      sid: "ses_broadcast",
      title: "Broadcast",
      joinCode: "hvs.aaaaaaaaaaaaaaaaaaaaaaaa",
      activities: ACTIVITIES,
    }),
    events.map((event) => ({ event, at: T0 })),
  );
}

function pidsOf(state: SessionState): string[] {
  return Object.values(state.participants)
    .sort((a, b) => a.playerNumber - b.playerNumber)
    .map((p) => p.pid);
}

interface Counted {
  readonly client: Client;
  /** Every `state` frame this socket was sent, newest last. */
  readonly frames: string[];
}

function counted(
  runtime: ReturnType<SessionRegistry["add"]>["runtime"],
  role: "participant" | "host" | "screen",
  pid?: string,
): Counted {
  const frames: string[] = [];
  const socket = {
    readyState: 1,
    send(frame: string) {
      if ((JSON.parse(frame) as { t: string }).t === "state") frames.push(frame);
    },
  } as unknown as Client["socket"];
  const client: Client = {
    socket,
    role,
    ...(pid ? { pid } : {}),
    lastSeen: T0,
    seq: 0,
    rtt: [],
    pingSentAt: null,
  };
  runtime.clients.add(client);
  return { client, frames };
}

function room(players = 4) {
  const state = pulling(players);
  const pids = pidsOf(state);
  const registry = new SessionRegistry();
  const { runtime } = registry.add(state, T0);
  const phones = pids.map((pid) => counted(runtime, "participant", pid));
  const host = counted(runtime, "host");
  const screen = counted(runtime, "screen");
  // What main.ts does as each socket arrives, so that counting starts from
  // the round rather than from the connect: the first room-wide broadcast
  // otherwise carries a roster nobody has been sent yet, and the console's
  // copy of it is a whole extra state frame.
  runtime.broadcastRoster(T0);
  for (const c of [...phones, host, screen]) {
    c.frames.length = 0;
    c.client.seq = 0;
  }
  return { runtime, pids, phones, host, screen };
}

/** One tap exactly on beat `n` of the pull. */
function beat(pid: string, n: number): { event: Event; now: number } {
  return { event: { type: "tapBeat", pid, at: T0 + n * BEAT_MS }, now: T0 + n * BEAT_MS };
}

/* ------------------------------------------------------------------ */
/* 1. The rope's frames ride a tick                                     */
/* ------------------------------------------------------------------ */

describe("Tug of Raft coalesces its frames", () => {
  it("credits the beat at once and sends nothing until the tick", () => {
    const { runtime, pids, phones, host, screen } = room();
    for (const pid of pids) {
      const b = beat(pid, 1);
      assert.equal(runtime.apply(b.event, b.now).applied, true);
    }
    // The engine has already counted every one of them: the round is decided
    // on the credit, not on the frame.
    const play = runtime.state.arcade?.play;
    assert.equal(play?.kind === "tug_of_raft" ? play.onBeats[pids[0] ?? ""] : null, 1);
    // And not one frame has gone out.
    for (const p of phones) assert.deepEqual(p.frames, []);
    assert.deepEqual(host.frames, []);
    assert.deepEqual(screen.frames, []);
    assert.equal(runtime.heldFrames, pids.length + 2, "a phone each, the host, the screen");

    runtime.flushFrames(T0 + BEAT_MS);
    for (const p of phones) assert.equal(p.frames.length, 1);
    assert.equal(host.frames.length, 1);
    assert.equal(screen.frames.length, 1);
    assert.equal(runtime.heldFrames, 0);
    runtime.clearArcadeTimers();
  });

  it("collapses a whole window of beats into one frame each", () => {
    const { runtime, pids, phones, host, screen } = room();
    // Four players, five beats: twenty credits, which before the tick was
    // twenty frames to the console and twenty to the screen.
    for (let n = 1; n <= 5; n += 1) {
      for (const pid of pids) {
        const b = beat(pid, n);
        assert.equal(runtime.apply(b.event, b.now).applied, true);
      }
    }
    assert.equal(host.frames.length, 0);
    runtime.flushFrames(T0 + 5 * BEAT_MS);
    assert.equal(host.frames.length, 1, "twenty credits, one console frame");
    assert.equal(screen.frames.length, 1);
    for (const p of phones) assert.equal(p.frames.length, 1);
    runtime.clearArcadeTimers();
  });

  it("holds nothing for a tap that was not credited", () => {
    const { runtime, pids } = room();
    const pid = pids[0];
    assert.ok(pid);
    // Half a beat out is off the beat, and "tap off the beat and nothing
    // happens" is the rule. Nothing happening must not arm the tick either.
    runtime.apply({ type: "tapBeat", pid, at: T0 + BEAT_MS / 2 }, T0 + BEAT_MS / 2);
    assert.equal(runtime.heldFrames, 0);
    runtime.clearArcadeTimers();
  });

  it("sends the held frames on its own, without anybody asking", async () => {
    const { runtime, pids, host } = room();
    const b = beat(pids[0] ?? "", 1);
    runtime.apply(b.event, b.now);
    assert.equal(host.frames.length, 0);
    await sleep(BEAT_FLUSH_MS * 3);
    assert.equal(host.frames.length, 1, "the tick fired by itself");
    assert.equal(runtime.heldFrames, 0);
    runtime.clearArcadeTimers();
  });
});

/* ------------------------------------------------------------------ */
/* 2. A round ending is never held                                      */
/* ------------------------------------------------------------------ */

describe("a round ending flushes the tick", () => {
  it("sends the last credits of a pull with the pull's result", () => {
    const { runtime, pids, phones, host } = room();
    for (const pid of pids) {
      const b = beat(pid, 1);
      runtime.apply(b.event, b.now);
    }
    assert.equal(host.frames.length, 0, "still held");
    runtime.apply({ type: "nextPull", seed: 999 }, T0 + BEAT_MS + 1);
    assert.equal(runtime.heldFrames, 0, "the pull took them with it");
    // One frame, not two: the held beat and the settled pull are the same
    // projection of the same state, so they coalesce into the frame that
    // carries the result.
    for (const p of phones) assert.equal(p.frames.length, 1);
    assert.equal(host.frames.length, 1);
    runtime.clearArcadeTimers();
  });

  it("does the same when the round ends outright", () => {
    const { runtime, pids, phones } = room();
    for (const pid of pids) {
      const b = beat(pid, 1);
      runtime.apply(b.event, b.now);
    }
    runtime.apply({ type: "endRound" }, T0 + BEAT_MS + 1);
    assert.equal(runtime.heldFrames, 0);
    // One, not two: the held beat and the ending are the same projection.
    for (const p of phones) assert.equal(p.frames.length, 1, "the rope was not left unsent");
    runtime.clearArcadeTimers();
  });
});

/* ------------------------------------------------------------------ */
/* 3. One projection per broadcast, spliced per phone                   */
/* ------------------------------------------------------------------ */

describe("a broadcast projects the role-level view once", () => {
  it("hands every phone the same roster, standings and grid objects", () => {
    const state = pulling(6);
    const pids = pidsOf(state);
    const views = prepareViews(state, new Map(), T0);
    const a = views.participant(pids[0]);
    const b = views.participant(pids[1]);
    // Identity, not equality. Two phones sharing the array is the whole
    // point: rebuilt per socket, these were a hundred sorts of the same
    // scores and a hundred walks of the same participant map.
    assert.equal(a.roster, b.roster);
    assert.equal(a.standings, b.standings);
    assert.equal(a.activities, b.activities);
    assert.equal(a.arcade, b.arcade);
    // And the three fields that are genuinely one player's are not shared.
    assert.notEqual(a.arcadeMine, b.arcadeMine);
    assert.equal(a.arcadeMine?.tug?.side !== undefined, true);
  });

  it("gives each surface exactly what projecting it alone would have", () => {
    const { runtime, pids, phones, host, screen } = room(6);
    runtime.broadcastState(T0 + BEAT_MS);
    for (const p of phones) {
      const solo = runtime.viewFor(p.client, T0 + BEAT_MS);
      assert.equal(
        p.frames[0],
        JSON.stringify({ t: "state", seq: 1, state: solo }),
        "the spliced frame is byte-for-byte the per-socket one",
      );
    }
    assert.equal(
      host.frames[0],
      JSON.stringify({ t: "state", seq: 1, state: runtime.viewFor(host.client, T0 + BEAT_MS) }),
    );
    assert.equal(
      screen.frames[0],
      JSON.stringify({ t: "state", seq: 1, state: runtime.viewFor(screen.client, T0 + BEAT_MS) }),
    );
    runtime.clearArcadeTimers();
  });
});

/* ------------------------------------------------------------------ */
/* 4. The frames themselves                                            */
/* ------------------------------------------------------------------ */

/**
 * Budgets, in bytes, for a hundred players mid-rope — the worst frame the
 * arcade produces, because Tug of Raft is the round where every surface
 * carries the whole grid.
 *
 * Measured at 18.4 KB per phone, 53.4 KB for the console, 20.6 KB for the big
 * screen and 1.9 MB for one full fan-out, with five per cent of headroom on
 * top. Five per cent is deliberate and it is worth knowing what it buys:
 * about ten bytes per per-player row, which is one timestamp-shaped number
 * added to `RosterEntry` or `ArcadeCell`. The test below adds exactly that
 * and checks these numbers reject it, so the claim is not left to prose.
 *
 * It is not a hair trigger, and the earlier version of this comment said it
 * was. A one-digit flag on a single row type costs 700 bytes at a hundred
 * players and passes; it shows up here only once a second or third field
 * joins it. The console is the least sensitive of the four because its frame
 * is the biggest, so a row-shaped regression trips the phone, the screen and
 * the fan-out first.
 *
 * If a deliberate change moves one of these, move the number and say why in
 * the commit — do not widen the budget to make room for an accident.
 */
const BUDGET = {
  phone: 19_400,
  host: 56_100,
  screen: 21_700,
  broadcast: 2_012_000,
} as const;

/**
 * Adds a field to every roster row reachable from a frame, the way a careless
 * addition to `RosterEntry` would, and answers how many rows it touched. The
 * shape it looks for is the roster's own — a row carrying `pid`, `nickname`
 * and `conn` — so it finds the roster wherever a view happens to hang it.
 */
function growEveryRosterRow(value: unknown, node: unknown, seen = new Set<object>()): number {
  if (node === null || typeof node !== "object") return 0;
  if (seen.has(node)) return 0;
  seen.add(node);
  if (Array.isArray(node)) {
    let found = 0;
    for (const item of node) found += growEveryRosterRow(value, item, seen);
    return found;
  }
  const row = node as Record<string, unknown>;
  let found = 0;
  if ("pid" in row && "nickname" in row && "conn" in row) {
    // A two-letter key on purpose. A long name would pad the regression out
    // and let a looser budget catch it; `at` is the cheapest a timestamp
    // field can realistically be, so this asks the hard version of the
    // question.
    row.at = value;
    found = 1;
  }
  for (const key of Object.keys(row)) found += growEveryRosterRow(value, row[key], seen);
  return found;
}

describe("what a frame costs at a hundred players", () => {
  it("stays inside its budget", () => {
    const state = pulling(100);
    const pids = pidsOf(state);
    const lastSeen = new Map(pids.map((p) => [p, T0]));
    const views = prepareViews(state, lastSeen, T0 + 3_000);

    const frame = (s: unknown) => JSON.stringify({ t: "state", seq: 1, state: s }).length;
    const phone = frame(views.participant(pids[0]));
    const host = frame(views.host());
    const screen = frame(views.screen());
    const broadcast = phone * pids.length + host + screen;

    assert.ok(phone <= BUDGET.phone, `phone frame ${phone} > ${BUDGET.phone}`);
    assert.ok(host <= BUDGET.host, `host frame ${host} > ${BUDGET.host}`);
    assert.ok(screen <= BUDGET.screen, `screen frame ${screen} > ${BUDGET.screen}`);
    assert.ok(
      broadcast <= BUDGET.broadcast,
      `one full fan-out ${broadcast} > ${BUDGET.broadcast}`,
    );
  });

  it("would fail on a timestamp added to every roster row", () => {
    // A budget is only worth having if it fails on the regression it names,
    // and at the fifteen per cent of headroom this started with it did not:
    // a field of exactly this shape landed inside the budget and the guard
    // said nothing. So the sensitivity is asserted here rather than claimed
    // above it, and tightening the numbers has something holding it in place.
    const state = pulling(100);
    const pids = pidsOf(state);
    const lastSeen = new Map(pids.map((p) => [p, T0]));
    const views = prepareViews(state, lastSeen, T0 + 3_000);

    const frame = (s: unknown) => JSON.stringify({ t: "state", seq: 1, state: s }).length;
    const phoneView = views.participant(pids[0]);
    const hostView = views.host();
    const screenView = views.screen();
    const touched =
      growEveryRosterRow(T0, phoneView) +
      growEveryRosterRow(T0, hostView) +
      growEveryRosterRow(T0, screenView);
    assert.equal(touched, 300, "a hundred roster rows in each of the three frames");

    const phone = frame(phoneView);
    const screen = frame(screenView);
    const broadcast = phone * pids.length + frame(hostView) + screen;

    // The console's frame is the biggest, so a hundred extra rows are a
    // smaller share of it and it is the one surface this does not trip. The
    // other three are what a row-shaped regression runs into first.
    assert.ok(phone > BUDGET.phone, `phone frame ${phone} still inside ${BUDGET.phone}`);
    assert.ok(screen > BUDGET.screen, `screen frame ${screen} still inside ${BUDGET.screen}`);
    assert.ok(
      broadcast > BUDGET.broadcast,
      `one full fan-out ${broadcast} still inside ${BUDGET.broadcast}`,
    );
  });

  it("costs one fan-out per tick, not one per credited beat", () => {
    // The whole point of the tick, stated in bytes. A hundred players at
    // 100 bpm credit about 167 beats a second between them; the console's
    // frame is the big one, so sending it per credit is the ten megabytes a
    // second that started this.
    const { runtime, pids, host } = room(100);
    let n = 1;
    for (const pid of pids) {
      runtime.apply({ type: "tapBeat", pid, at: T0 + n * BEAT_MS }, T0 + n * BEAT_MS);
      if (n < 4) n += 1;
    }
    assert.equal(host.frames.length, 0);
    runtime.flushFrames(T0 + 4 * BEAT_MS);
    assert.equal(host.frames.length, 1, "one console frame for a hundred credits");
    const bytes = host.frames.reduce((sum, f) => sum + f.length, 0);
    assert.ok(bytes <= BUDGET.host, `${bytes} bytes for the whole burst`);
    runtime.clearArcadeTimers();
  });
});
