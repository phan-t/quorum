/**
 * Tug of Raft on the wire.
 *
 * This round has no answer to hide — nobody drains, there is nothing to know,
 * and SPEC.md builds it that way deliberately: "the arcade needs one round
 * that is pure noise". So the claims here are a different shape from the
 * bridge's and Unseal's, and the first one is the round's reason for
 * existing:
 *
 * 1. **There is one clock, and it is the server's.** Every surface is sent
 *    the beat as a *grid* — an absolute start instant and a beat length —
 *    never as a tempo it would have to start its own interval from. A tempo
 *    would let each surface begin wherever its frame happened to land, drift
 *    by whatever its timer owes, and invite taps at instants the server is
 *    not counting. SPEC.md: "the beat means everyone is capped at the same
 *    rate, so the skill is rhythm, not hardware" — which is only true if
 *    every phone is drawing the beat the server judges.
 * 2. **The client derives an election exactly as the engine does.** The
 *    engine stores no election, because it has no clock; the phone derives
 *    one from `lastBeat` and the grid. The two are the same arithmetic on the
 *    same numbers, and this file checks that against `resolveBeat` itself.
 * 3. **No participant frame carries what another player did.** Nothing here
 *    is secret, but per-player beat counts are still somebody else's play,
 *    and DESIGN.md puts every number on the console.
 *
 * Asserted against the serialised frame wherever the claim is about what is
 * in the bytes, for the reason glass-bridge.test.ts gives.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newSession, replay } from "../engine/reducer.ts";
import type { Activity, Event, SessionState } from "../engine/types.ts";
import { TUG_BEAT_TOLERANCE, resolveBeat } from "../engine/arcade.ts";
import { tugBeatAt, tugElectionAt, tugRope } from "../client/shared/view.ts";
import { renderStateFor } from "./views.ts";
import type { ArcadeTugView, RenderState } from "../protocol.ts";

const ACTIVITIES: readonly Activity[] = [
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

const T0 = 1_700_000_000_000;
/** SPEC.md: 100 bpm, which is a beat every 600 ms. */
const BEAT_MS = 600;

function session(events: readonly Event[], at = T0): SessionState {
  const base = newSession({
    sid: "ses_tug",
    title: "Test",
    joinCode: "hvs.testtesttest",
    activities: ACTIVITIES,
  });
  return replay(
    base,
    events.map((event) => ({ event, at })),
  );
}

function entered(extra: readonly Event[] = []): SessionState {
  return session([
    { type: "open" },
    { type: "join", pid: "p1", nickname: "Priya" },
    { type: "join", pid: "p2", nickname: "Kenji" },
    { type: "join", pid: "p3", nickname: "Ade" },
    { type: "join", pid: "p4", nickname: "Grace" },
    { type: "start" },
    { type: "setSegment", segment: "arcade" },
    { type: "enterArcade", activityId: "arcade" },
    ...extra,
  ]);
}

const START: Event = {
  type: "startRound",
  round: "tug_of_raft",
  config: {
    kind: "tug_of_raft",
    pulls: 3,
    pullSeconds: 25,
    bpm: 100,
    seed: 12345,
  },
};

function pulling(
  extra: readonly { event: Event; at: number }[] = [],
): SessionState {
  return replay(entered([START, { type: "beginPlay" }]), extra);
}

function view(
  state: SessionState,
  role: "participant" | "host" | "screen",
  pid?: string,
  now = T0,
): RenderState {
  return renderStateFor(state, {
    role,
    ...(pid === undefined ? {} : { pid }),
    lastSeen: new Map(),
    now,
  });
}

function wire(
  state: SessionState,
  role: "participant" | "host" | "screen",
  pid?: string,
): string {
  return JSON.stringify({ t: "state", seq: 1, state: view(state, role, pid) });
}

/** One tap on the beat `n` of the pull, exactly. */
function onBeat(pid: string, n: number): { event: Event; at: number } {
  return {
    event: { type: "tapBeat", pid, at: T0 + n * BEAT_MS },
    at: T0 + n * BEAT_MS,
  };
}

/* ------------------------------------------------------------------ */
/* 1. One clock, and it is the server's                                */
/* ------------------------------------------------------------------ */

describe("the heartbeat travels as the server's grid", () => {
  it("sends the start instant and the beat length, to every role", () => {
    const state = pulling();
    for (const role of ["participant", "screen", "host"] as const) {
      const t = view(state, role, "p1").arcade?.tug;
      assert.equal(t?.pullStartedAt, T0, `${role}: no start instant`);
      assert.equal(t?.beatMs, BEAT_MS, `${role}: no beat length`);
      assert.equal(t?.pullEndsAt, T0 + 25_000, `${role}: no deadline`);
    }
  });

  it("sends no bare tempo that a surface could start its own interval from", () => {
    // A `bpm` on the wire is the invitation to write
    // `setInterval(60000 / bpm)`, which is a second clock: it starts on
    // whichever frame arrived, drifts by whatever the timer owes, and within
    // one 25-second pull is asking for taps at instants the server is not
    // counting. The grid is the whole projection, so there is nothing to
    // start an interval *from*.
    for (const role of ["participant", "screen", "host"] as const) {
      assert.ok(
        !wire(pulling(), role, "p1").includes('"bpm"'),
        `${role}: a bare tempo is on the wire`,
      );
    }
  });

  it("omits the two epochs while the round card is up, rather than zeroing them", () => {
    // A surface handed a zero would start the heartbeat in 1970 and show
    // every node in an election before the round began.
    const t = view(entered([START]), "screen").arcade?.tug;
    assert.equal(t?.pullStartedAt, undefined);
    assert.equal(t?.pullEndsAt, undefined);
    assert.equal(t?.beatMs, BEAT_MS);
  });

  it("carries the window and the election rule, so no client keeps its own copy", () => {
    const t = view(pulling(), "participant", "p1").arcade?.tug;
    assert.equal(t?.toleranceMs, BEAT_MS * TUG_BEAT_TOLERANCE);
    assert.equal(t?.missesToElection, 3);
    assert.equal(t?.electionMs, 2_000);
  });

  it("restarts the grid at each pull, so beat 0 is that pull's own start", () => {
    const later = replay(pulling(), [
      { event: { type: "nextPull", seed: 999 }, at: T0 + 25_000 },
    ]);
    const t = view(later, "screen").arcade?.tug;
    assert.equal(t?.pull, 1);
    assert.equal(t?.pullStartedAt, T0 + 25_000);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The client's arithmetic is the engine's                          */
/* ------------------------------------------------------------------ */

describe("the client draws the beat the engine judges", () => {
  /** The projection a phone actually holds, at the top of the first pull. */
  function tugView(): ArcadeTugView {
    const t = view(pulling(), "participant", "p1").arcade?.tug;
    assert.ok(t !== undefined);
    return t;
  }

  it("agrees with the engine about which instants are on the beat", () => {
    const t = tugView();
    const play = pulling().arcade?.play;
    assert.ok(play?.kind === "tug_of_raft");
    // A whole beat's worth of instants, 10 ms apart, judged both ways.
    for (let ms = 0; ms <= 1_200; ms += 10) {
      const at = T0 + ms;
      const client = tugBeatAt(t, at);
      const engine = resolveBeat(play, -1, at);
      assert.ok(client !== null);
      assert.equal(
        client.onBeat,
        engine.onBeat,
        `disagreed about ${ms} ms into the pull`,
      );
      assert.equal(client.beat, engine.beat, `disagreed about the beat at ${ms} ms`);
    }
  });

  it("agrees with the engine about when a node is timed out", () => {
    const t = tugView();
    const play = pulling().arcade?.play;
    assert.ok(play?.kind === "tug_of_raft");
    // Somebody who hit beat 2 and then went quiet. The engine times them out
    // from the third consecutively missed beat — beat 5 — for two seconds,
    // and then counts again from the first beat after that.
    for (let ms = 0; ms <= 20_000; ms += 25) {
      const at = T0 + ms;
      assert.equal(
        tugElectionAt(t, 2, at).inElection,
        resolveBeat(play, 2, at).inElection,
        `disagreed about the election at ${ms} ms`,
      );
    }
  });

  it("puts the first election exactly where SPEC.md puts it", () => {
    // "Miss three beats in a row and your node times out … for two seconds."
    //
    // Hit beat 0 and then say nothing. Beats 1, 2 and 3 are the three missed
    // ones, so the window is *dated* from beat 3 — 1800 ms in — and runs for
    // two seconds, to 3800 ms.
    //
    // It cannot be *detected* until beat 3 has actually gone by, and that is
    // right rather than an off-by-one: standing at beat 3 you have missed two
    // and are still in time to hit the third. So the first instant that is
    // judged as timed out is the one that rounds to beat 4.
    const t = tugView();
    assert.equal(tugElectionAt(t, 0, T0 + 3 * BEAT_MS).inElection, false);
    assert.equal(tugElectionAt(t, 0, T0 + 4 * BEAT_MS).inElection, true);
    // The window's own edges, dated from beat 3 as above.
    assert.equal(tugElectionAt(t, 0, T0 + 3 * BEAT_MS + 1_999).inElection, true);
    assert.equal(tugElectionAt(t, 0, T0 + 3 * BEAT_MS + 2_001).inElection, false);
    assert.equal(tugElectionAt(t, 0, T0 + 4 * BEAT_MS).endsAt, T0 + 3 * BEAT_MS + 2_000);
  });

  it("is handed the last beat it needs to derive all of that, and nothing more", () => {
    const mid = pulling([onBeat("p1", 2)]);
    const mine = view(mid, "participant", "p1").arcadeMine?.tug;
    assert.equal(mine?.lastBeat, 2);
    assert.equal(mine?.onBeats, 1);
    // There is no election *state* on the wire in either direction — only the
    // two rule constants it is derived from. The engine has no clock to write
    // a window with, and the phone has no need of one to read: a stored
    // `electionUntil` would be a second fact for a frame to disagree with.
    const frame = wire(mid, "participant", "p1");
    assert.ok(!frame.includes('"inElection"'));
    assert.ok(!frame.includes('"electionUntil"'));
    assert.ok(!frame.includes('"electionEndsAt"'));
    assert.ok(frame.includes('"missesToElection":3'));
  });
});

/* ------------------------------------------------------------------ */
/* 3. The rope                                                         */
/* ------------------------------------------------------------------ */

describe("the rope", () => {
  it("is the same two numbers on every surface", () => {
    const mid = pulling([onBeat("p1", 1), onBeat("p2", 1), onBeat("p1", 2)]);
    const play = mid.arcade?.play;
    assert.ok(play?.kind === "tug_of_raft");
    const expected = view(mid, "screen").arcade?.tug?.totals;
    for (const role of ["participant", "host"] as const) {
      assert.deepEqual(view(mid, role, "p1").arcade?.tug?.totals, expected);
    }
  });

  it("sits dead centre before anybody has pulled, and does not pin early", () => {
    assert.equal(tugRope([0, 0]), 0.5);
    // One tap against nothing is not the rope against the stop: a share
    // cannot be read as a landslide off a single beat in a room of four.
    assert.ok(tugRope([1, 0]) === 0);
    assert.equal(tugRope([3, 1]), 0.25);
    assert.equal(tugRope([1, 3]), 0.75);
  });
});

/* ------------------------------------------------------------------ */
/* 4. What a phone is not sent                                         */
/* ------------------------------------------------------------------ */

describe("a phone gets its own rope end and nobody else's count", () => {
  it("withholds the sides, the leaders and the per-player counts", () => {
    const mid = pulling([onBeat("p1", 1), onBeat("p2", 1)]);
    const phone = view(mid, "participant", "p1").arcade?.tug;
    assert.equal(phone?.sides, undefined);
    assert.equal(phone?.leaders, undefined);
    assert.equal(phone?.onBeats, undefined);
    assert.ok(!wire(mid, "participant", "p1").includes('"onBeats":{'));
  });

  it("gives the Desktop the two clusters, because it draws them", () => {
    const mid = pulling();
    const screen = view(mid, "screen").arcade?.tug;
    assert.equal(Object.keys(screen?.sides ?? {}).length, 4);
    // Balanced to within one by construction: alternate dealing, not a coin
    // flip, so a 3-against-17 rope cannot happen.
    const a = Object.values(screen?.sides ?? {}).filter((s) => s === 0).length;
    const b = Object.values(screen?.sides ?? {}).filter((s) => s === 1).length;
    assert.ok(Math.abs(a - b) <= 1);
    // The per-player counts are the console's alone.
    assert.equal(screen?.onBeats, undefined);
    assert.notEqual(view(mid, "host").arcade?.tug?.onBeats, undefined);
  });

  it("tells each phone its own end of the rope", () => {
    const mid = pulling();
    const sides = view(mid, "screen").arcade?.tug?.sides ?? {};
    for (const pid of ["p1", "p2", "p3", "p4"]) {
      assert.equal(view(mid, "participant", pid).arcadeMine?.tug?.side, sides[pid]);
    }
  });

  it("drains nobody, which is the round's one hard promise", () => {
    // SPEC.md: "Nobody drains. This is deliberate: two elimination rounds
    // back-to-back is a downer." A node that says nothing for the whole pull
    // calls election after election and is still on the Floor at the end.
    const quiet = replay(pulling(), [
      { event: { type: "nextPull", seed: 7 }, at: T0 + 25_000 },
      { event: { type: "nextPull", seed: 8 }, at: T0 + 50_000 },
      { event: { type: "endRound" }, at: T0 + 75_000 },
    ]);
    const grid = view(quiet, "screen").arcade?.grid ?? [];
    assert.equal(grid.length, 4);
    assert.ok(grid.every((c) => c.standing === "floor"));
    assert.equal(view(quiet, "screen").arcade?.inLounge, 0);
  });
});
