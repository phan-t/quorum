/**
 * Phase 4's acceptance test: sixty bots play Recruitment and then Plan / Apply
 * through the *runtime* (`SessionRuntime`, fake sockets, fake clock), so the
 * path under test is the one a real tap takes — the socket boundary corrects
 * the tap's instant and applies the grace, the reducer banks or drains, the
 * settlement pays the Lounge, the projection puts it on the wire.
 *
 * **The expectation is not the engine.** Nothing in this file imports from
 * `engine/arcade.ts`. The oracle is {@link expectRecruitment} and
 * {@link expectPlanApply}, written from the numbers in SPEC.md "Hashi Arcade"
 * (the two round texts and the "Arcade scoring summary" table) and the
 * latency rule in ARCHITECTURE.md "Clocks and fairness":
 *
 *   Recruitment  10 per correct answer within the item's timer, +5 to each of
 *                the first three correct in the room, per item. Floor max 90.
 *   Plan / Apply checkpoints at 30 / 60 / 90 bank 5 each; crossing banks +10;
 *                first three across +15 / +10 / +5. Floor max 40. A tap during
 *                APPLY drains, with a 250 ms grace after the lock. Banked
 *                points survive the drain. Lounge: backed runner crosses +10,
 *                backed runner wins +15, the larger and never both. Lounge
 *                max 15. Tap instants are `received − min(rtt ÷ 2, 250 ms)`.
 *
 * Seven bots' totals are also worked out by hand in the comments and asserted
 * as literals, so a mistake shared by the oracle and the engine would still be
 * caught on numbers a person can check.
 *
 * Deterministic: the light schedule and the thirty-one "ordinary" bots come
 * off a seeded PRNG; the twenty-eight with a job (see `SPECIAL`) are fixed.
 * Same seed, same round, same numbers.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  Activity,
  Event,
  ParticipantId,
  SessionState,
} from "../engine/types.ts";
import { newSession, replay } from "../engine/reducer.ts";
import { computeStandings } from "../engine/scoring.ts";
import { SessionRegistry, type Client } from "../server/runtime.ts";
import { arcadeGrid, renderStateFor } from "../server/views.ts";
import { RECRUITMENT_ITEMS, recruitmentRound } from "../arcade/recruitment.ts";

/* ------------------------------------------------------------------ */
/* The oracle: SPEC.md, in integers                                     */
/* ------------------------------------------------------------------ */

/** Recruitment: "Every correct answer within the timer scores 10; the first three correct in the room score +5." */
const R_CORRECT = 10;
const R_FIRST_BONUS = 5;
const R_FIRST_PLACES = 3;
const R_SECONDS_PER_ITEM = 20;

/** Plan / Apply: "Checkpoints at 30, 60 and 90 resources bank 5 each. Crossing the line banks +10, and the first three across get +15 / +10 / +5." */
const PA_TARGET = 120;
const PA_CHECKPOINTS: readonly number[] = [30, 60, 90];
const PA_CHECKPOINT_BANK = 5;
const PA_CROSS = 10;
const PA_FINISH: readonly number[] = [15, 10, 5];
/** "…backed runner crosses +10, backed runner wins +15" — the larger, not the sum (SPEC "Arcade scoring summary"). */
const PA_BACKED_CROSSES = 10;
const PA_BACKED_WINS = 15;
/** "There is a 250 ms grace after the lock for network latency." */
const PA_GRACE_MS = 250;
const PA_SECONDS = 75;

/** ARCHITECTURE.md: the correction is `min(rtt ÷ 2, 250 ms)`, zero when unmeasured. */
const CORRECTION_CAP_MS = 250;

function specCorrection(rtt: readonly number[]): number {
  if (rtt.length === 0) return 0;
  assert.equal(rtt.length % 2, 1, "use an odd number of RTT samples");
  const sorted = [...rtt].sort((a, b) => a - b);
  const median = sorted[(sorted.length - 1) / 2] ?? 0;
  return Math.min(median / 2, CORRECTION_CAP_MS);
}

/** SPEC.md: "matched after lowercasing and stripping non-letters, with an accept list". */
function specFold(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}]/gu, "");
}

/**
 * The seven items, transcribed by hand from SPEC.md and the existing Emoji
 * Decode board, so `src/arcade/recruitment.ts` is checked against this and not
 * the other way round.
 *
 * Waypoint is fourth and is not from SPEC: a round of exactly the six products
 * the room can recite is a round whose last two answers are arrived at by
 * elimination, and the content file says why the seventh sits where it does.
 * Transcribed here anyway, because the point of this table is to be an
 * independent reading of the board and not a copy of it.
 */
const ITEMS: readonly { readonly answer: string; readonly accept: readonly string[] }[] = [
  { answer: "Vault", accept: [] },
  { answer: "Terraform", accept: ["tf"] },
  { answer: "Consul", accept: [] },
  { answer: "Waypoint", accept: [] },
  { answer: "Packer", accept: [] },
  { answer: "Boundary", accept: [] },
  { answer: "Nomad", accept: [] },
];

/**
 * The last item, which behaves differently from the others.
 *
 * The round's own Floor timer is `beginPlay + n × 20 s`, and each item timer
 * fires 100 ms late, so by the last item the item window has drifted 100 ms per
 * item past the round's clock: an answer at the buzzer on the last item lands
 * after the Floor has closed and is refused. Two bots are written to sit either
 * side of that, so the drift is asserted rather than discovered, and both index
 * off this rather than a literal that a seventh item made wrong.
 */
const LAST_ITEM = ITEMS.length - 1;

function specMatches(item: number, typed: string): boolean {
  const it = ITEMS[item];
  assert.ok(it);
  const f = specFold(typed);
  if (f === "") return false;
  return f === specFold(it.answer) || it.accept.some((a) => specFold(a) === f);
}

/* ------------------------------------------------------------------ */
/* Seeded PRNG                                                          */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260920;

/**
 * The Plan / Apply plan's own seed.
 *
 * Picked, not derived: the assertions in "the plan is what it says it is" want a
 * plan with a particular shape — about half the room across the line, at least
 * twelve drained, and somebody in the Lounge on each of the three payouts — and
 * a seed either produces that or it does not. `SEED + 3` is the light
 * schedule's, chosen the same way, for the same reason.
 */
const PLAN_SEED = SEED + 1;

/* ------------------------------------------------------------------ */
/* The clock                                                            */
/* ------------------------------------------------------------------ */

/** A fixed wall clock: 25 Sep 2026 15:00 UTC. The runtime never reads the real one. */
const T0 = Date.UTC(2026, 8, 25, 15, 0, 0);

/** Recruitment's Floor opens here. Items are 20 s, so item i opens at RECRUIT_BEGIN + i × 20 100 (100 ms timer lag). */
const RECRUIT_BEGIN = T0 + 90_000;
/** The item timer fires this late, as a real setTimeout does. */
const ITEM_LAG_MS = 100;
const itemStart = (i: number): number => RECRUIT_BEGIN + i * (R_SECONDS_PER_ITEM * 1000 + ITEM_LAG_MS);
const itemEnds = (i: number): number => itemStart(i) + R_SECONDS_PER_ITEM * 1000;
/** The round's own clock is `beginPlay + 6 × 20 s`; the Floor timer fires 100 ms after it. */
const RECRUIT_ENDS = RECRUIT_BEGIN + ITEMS.length * R_SECONDS_PER_ITEM * 1000;
const RECRUIT_END_ROUND = RECRUIT_ENDS + ITEM_LAG_MS;

/** Plan / Apply's Floor opens here and closes 75 s later; the Floor timer fires 200 ms after that. */
const PA_BEGIN = RECRUIT_END_ROUND + 30_000;
const PA_ENDS = PA_BEGIN + PA_SECONDS * 1000;
const PA_END_ROUND = PA_ENDS + 200;

/* ------------------------------------------------------------------ */
/* The light schedule                                                   */
/* ------------------------------------------------------------------ */

interface Phase {
  readonly light: "plan" | "apply";
  readonly from: number;
  /** Exclusive. The last phase is cut at the Floor's close. */
  readonly to: number;
}

/** SPEC.md: "Phases alternate on random durations between 2 and 6 seconds", starting on PLAN. */
function lightSchedule(): Phase[] {
  const rng = mulberry32(SEED + 3);
  const out: Phase[] = [];
  let t = PA_BEGIN;
  let light: "plan" | "apply" = "plan";
  while (t < PA_ENDS) {
    const d = 2_000 + Math.floor(rng() * 4_001);
    const to = Math.min(PA_ENDS, t + d);
    out.push({ light, from: t, to });
    t = to;
    light = light === "plan" ? "apply" : "plan";
  }
  return out;
}

const SCHEDULE: readonly Phase[] = lightSchedule();
const APPLIES: readonly Phase[] = SCHEDULE.filter((p) => p.light === "apply");
const PLANS: readonly Phase[] = SCHEDULE.filter((p) => p.light === "plan");

function phaseAt(t: number): Phase {
  const p = SCHEDULE.find((ph) => ph.from <= t && t < ph.to);
  assert.ok(p, `no light phase at ${t - PA_BEGIN} ms into the round`);
  return p;
}

/** The first APPLY that starts after `t`. */
function nextApplyAfter(t: number): Phase {
  const p = APPLIES.find((ph) => ph.from > t);
  assert.ok(p, `no APPLY after ${t - PA_BEGIN} ms into the round`);
  return p;
}

/** The k-th lock instant (0-based). */
const lock = (k: number): number => {
  const p = APPLIES[k];
  assert.ok(p, `no APPLY #${k}`);
  return p.from;
};

/* ------------------------------------------------------------------ */
/* The plan: who does what, when                                        */
/* ------------------------------------------------------------------ */

interface Recruit {
  readonly answer: string;
  readonly delayMs: number;
}

/** A tap, as the instant the frame reaches the server. */
interface Tap {
  readonly recv: number;
}

interface Back {
  readonly at: number;
  readonly backing: ParticipantId;
}

interface Bot {
  readonly pid: ParticipantId;
  readonly nickname: string;
  /** The server's RTT samples for this socket. Empty = never measured. */
  readonly rtt: readonly number[];
  /** Joins between the two rounds rather than in the lobby. */
  readonly late?: boolean;
  recruit(item: number): Recruit | null;
  taps(): readonly Tap[];
  backs(): readonly Back[];
}

/**
 * Ordinary taps keep clear of every light change: the thumb comes off the
 * glass at least this long after a PLAN begins and before it ends, so after
 * the latency correction (≤ 250 ms) the judged instant is unambiguous.
 */
const MARGIN_MS = 300;

/**
 * A frame that lands such that the *corrected* instant is exactly `thumb`:
 * the phone's one-way latency is what the correction takes back off.
 */
function recvFor(thumb: number, rtt: readonly number[]): number {
  return thumb + specCorrection(rtt);
}

/** Taps at `rate` per second through every PLAN, as corrected instants, up to `limit` of them. */
function planThumbs(rate: number, limit = Infinity): number[] {
  const out: number[] = [];
  for (const ph of PLANS) {
    for (let k = 0; ; k += 1) {
      const u = ph.from + MARGIN_MS + Math.round((k * 1000) / rate);
      if (u >= ph.to - MARGIN_MS) break;
      out.push(u);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const tapsAt = (thumbs: readonly number[], rtt: readonly number[]): Tap[] =>
  thumbs.map((u) => ({ recv: recvFor(u, rtt) }));

const NONE = (): null => null;
const correctAt = (delayMs: number) => (item: number): Recruit => {
  const it = ITEMS[item];
  assert.ok(it);
  return { answer: it.answer, delayMs };
};

/** A runner who taps at `rate` until `slipAfter` resources, then taps into the next lock, then backs `backing`. */
function slipper(
  rtt: readonly number[],
  rate: number,
  slipAfter: number,
  slipPlusMs: number,
  backing: ParticipantId | null,
  backDelayMs = 800,
): Pick<Bot, "taps" | "backs"> {
  const before = planThumbs(rate, slipAfter);
  const slipAt = nextApplyAfter(before[before.length - 1] ?? PA_BEGIN).from + slipPlusMs;
  return {
    taps: () => tapsAt([...before, slipAt], rtt),
    backs: () => (backing === null ? [] : [{ at: slipAt + backDelayMs, backing }]),
  };
}

const WINNER = "p001";
const FIFTH = "p004";
const SURVIVOR = "p012";
const ZERO = "p006";
const DOOMED = "p019";

const SPECIAL: readonly Bot[] = [
  {
    // Right and first on every item, and the fastest thumb in the room. The
    // Floor max on both rounds.
    pid: WINNER, nickname: "Priya", rtt: [],
    recruit: correctAt(1_500),
    taps: () => tapsAt(planThumbs(8), []),
    backs: () => [],
  },
  {
    // Second on every item they answer, typing it every way but plainly:
    // "TF", "vault!", "WAYPOINT!", " Nomad ". Sits out Consul. Second across
    // the line.
    pid: "p002", nickname: "Kenji", rtt: [40, 40, 40],
    recruit: (item) => {
      const typed = ["vault!", "TF", null, "WAYPOINT!", " packer ", "BOUNDARY", " Nomad "][item];
      return typed === null || typed === undefined ? null : { answer: typed, delayMs: 2_000 };
    },
    taps: () => tapsAt(planThumbs(7.5), [40, 40, 40]),
    backs: () => [],
  },
  {
    // Never types a thing; fourth across.
    pid: "p003", nickname: "Ade", rtt: [],
    recruit: NONE,
    taps: () => tapsAt(planThumbs(6.5), []),
    backs: () => [],
  },
  {
    // Fifth across: three checkpoints and the crossing, no place bonus. 25.
    pid: FIFTH, nickname: "Sam", rtt: [],
    recruit: NONE,
    taps: () => tapsAt(planThumbs(5.5), []),
    backs: () => [],
  },
  {
    // Third correct on Vault and Consul, fourth on Terraform. Reaches exactly
    // 90 resources, taps into the next lock, and backs the winner — who is
    // already across by then, so the bet pays nothing and the round is the
    // 15 they banked. This is the room's arithmetic on the exploit: the same
    // bet placed before Priya crossed would have been worth 15.
    pid: "p005", nickname: "Zoë", rtt: [],
    recruit: (item) => (item < 3 ? correctAt(3_000)(item) : null),
    ...slipper([], 6, 90, 400, WINNER),
  },
  {
    // Drained in the first lock with nothing banked; backs the winner. 15.
    pid: ZERO, nickname: "Late", rtt: [],
    recruit: NONE,
    taps: () => tapsAt([lock(0) + 400], []),
    backs: () => [{ at: lock(0) + 1_200, backing: WINNER }],
  },
  {
    // Bengaluru on hotel Wi-Fi: 4 s round trip, correction capped at 250. A
    // frame 499 ms after the first lock corrects to +249 — inside the grace,
    // a resource. One at 500 ms after the second lock corrects to +250 and
    // is a drain. Backs the winner.
    pid: "p007", nickname: "Hotel", rtt: [4_000, 4_100, 3_900],
    recruit: correctAt(5_000),
    taps: () => [
      ...tapsAt(planThumbs(4).filter((u) => u < lock(1)), [4_000, 4_100, 3_900]),
      { recv: lock(0) + 499 },
      { recv: lock(1) + 500 },
    ],
    backs: () => [{ at: lock(1) + 1_300, backing: WINNER }],
  },
  {
    // Sydney on fibre: a frame 259 ms after the first lock corrects to +249.
    // A resource, and never drained.
    pid: "p008", nickname: "Fibre", rtt: [20, 20, 20],
    recruit: correctAt(4_000),
    taps: () => [...tapsAt(planThumbs(4), [20, 20, 20]), { recv: lock(0) + 259 }],
    backs: () => [],
  },
  {
    // Never measured: no correction. Inside the grace at +100 on the first
    // lock; a plain drain 1.5 s into the third. Backs the survivor who never
    // crosses: nothing.
    pid: "p009", nickname: "Unmeasured", rtt: [],
    recruit: NONE,
    taps: () => [
      ...tapsAt(planThumbs(3).filter((u) => u < lock(2)), []),
      { recv: lock(0) + 100 },
      { recv: lock(2) + 1_500 },
    ],
    backs: () => [{ at: lock(2) + 2_300, backing: SURVIVOR }],
  },
  {
    // Wrong every time, and on the board at 0 for it. Drained in the second
    // lock; backs the winner, then changes their mind to a runner who never
    // crosses. The bet that counts is the last one: nothing.
    pid: "p010", nickname: "Switcher", rtt: [100, 100, 100],
    recruit: () => ({ answer: "Vagrant", delayMs: 6_000 }),
    taps: () => tapsAt([...planThumbs(5).filter((u) => u < lock(1)), lock(1) + 600], [100, 100, 100]),
    backs: () => [
      { at: lock(1) + 1_400, backing: WINNER },
      { at: lock(1) + 3_600, backing: SURVIVOR },
    ],
  },
  {
    // Right on the even items. Drained in the third lock and never backs
    // anybody: banked points only.
    pid: "p011", nickname: "Skipper", rtt: [200, 200, 200],
    recruit: (item) => (item % 2 === 0 ? correctAt(7_000)(item) : null),
    taps: () => tapsAt([...planThumbs(4).filter((u) => u < lock(2)), lock(2) + 500], [200, 200, 200]),
    backs: () => [],
  },
  {
    // "tf" for Terraform and nothing else. 119 resources and stops: three
    // checkpoints, never across, never drained. 15.
    pid: SURVIVOR, nickname: "Survivor", rtt: [],
    recruit: (item) => (item === 1 ? { answer: "tf", delayMs: 2_500 } : null),
    taps: () => tapsAt(planThumbs(6, 119), []),
    backs: () => [],
  },
  {
    // Right at exactly the buzzer on every item but the last — "within the
    // timer" — and with a second to spare on the last one, where the buzzer is
    // already past the Floor's close. Twenty-nine resources on the Floor, never
    // drained: banked nothing, which SPEC says is the intended shape.
    pid: "p013", nickname: "Snail", rtt: [],
    recruit: (item) => correctAt(item === LAST_ITEM ? 19_000 : R_SECONDS_PER_ITEM * 1000)(item),
    taps: () => tapsAt(planThumbs(2, 29), []),
    backs: () => [],
  },
  {
    // Does nothing whatsoever, in either round. On the board at 0.
    pid: "p014", nickname: "Hermit", rtt: [],
    recruit: NONE,
    taps: () => [],
    backs: () => [],
  },
  {
    // Fast and wrong: a near miss on every item, first in the room every
    // time, and not one of the first three *correct*.
    pid: "p015", nickname: "Typo", rtt: [],
    recruit: (item) => ({
      answer: ["Valut", "Terrafrom", "Consol", "Waypont", "Paker", "Bounday", "Nomads"][item] ?? "",
      delayMs: 1_000,
    }),
    taps: () => tapsAt(planThumbs(3.5), []),
    backs: () => [],
  },
  {
    // Right, 50 ms after the item's timer but before the (late) item change
    // on every item but the last: accepted, locked in, worth nothing. Right
    // with time to spare on the last one, where 50 ms late is past the Floor.
    pid: "p016", nickname: "JustLate", rtt: [],
    recruit: (item) => correctAt(item === LAST_ITEM ? 19_400 : R_SECONDS_PER_ITEM * 1000 + 50)(item),
    taps: () => tapsAt(planThumbs(3), []),
    backs: () => [],
  },
  {
    // Right, 150 ms after the item's timer — after the item has moved on.
    // Refused every time.
    pid: "p017", nickname: "MovedOn", rtt: [],
    recruit: correctAt(R_SECONDS_PER_ITEM * 1000 + 150),
    taps: () => tapsAt(planThumbs(3), []),
    backs: () => [],
  },
  {
    // Forty-five resources, drained, backs Doomed — who is drained later.
    // Keeps the 5 from the first checkpoint and nothing from the Lounge.
    pid: "p018", nickname: "Coral", rtt: [],
    recruit: NONE,
    ...slipper([], 5, 45, 400, DOOMED),
  },
  {
    // Runs slowly — never near the line — until the last lock of the round, and taps into it.
    pid: DOOMED, nickname: "Doomed", rtt: [],
    recruit: correctAt(8_000),
    taps: () => {
      const last = APPLIES[APPLIES.length - 1];
      assert.ok(last);
      return tapsAt([...planThumbs(2.5).filter((u) => u < last.from), last.from + 400], []);
    },
    backs: () => [],
  },
  {
    // Crosses, then taps into a lock. Their button is done: not a drain.
    pid: "p020", nickname: "Ghost", rtt: [],
    recruit: NONE,
    taps: () => {
      const thumbs = planThumbs(7);
      const across = thumbs[PA_TARGET - 1];
      assert.ok(across, "Ghost must cross");
      return tapsAt([...thumbs, nextApplyAfter(across).from + 600], []);
    },
    backs: () => [],
  },
  {
    // Drained in the first lock, then taps on the next green: refused. Backs
    // the fifth across: 10.
    pid: "p021", nickname: "Stray", rtt: [],
    recruit: NONE,
    taps: () => {
      const next = PLANS.find((p) => p.from > lock(0));
      assert.ok(next);
      return tapsAt([lock(0) + 700, next.from + 500], []);
    },
    backs: () => [{ at: lock(0) + 1_500, backing: FIFTH }],
  },
  {
    // Never drained, and tries to back the winner from the Floor: refused.
    pid: "p022", nickname: "FloorBacker", rtt: [],
    recruit: correctAt(9_000),
    taps: () => tapsAt(planThumbs(3), []),
    backs: () => [{ at: PA_BEGIN + 10_000, backing: WINNER }],
  },
  {
    // Drained in the first lock. Backs themself (refused), backs Late who is
    // in the Lounge too (refused), then the winner: 15.
    pid: "p023", nickname: "Narcissist", rtt: [],
    recruit: NONE,
    taps: () => tapsAt([lock(0) + 900], []),
    backs: () => [
      { at: lock(0) + 1_000, backing: "p023" },
      { at: lock(0) + 1_100, backing: ZERO },
      { at: lock(0) + 1_200, backing: WINNER },
    ],
  },
  {
    // Drained in the second lock, and places the bet 50 ms after the Floor
    // closes: refused, the Floor has locked.
    pid: "p024", nickname: "LateBet", rtt: [],
    recruit: NONE,
    taps: () => tapsAt([...planThumbs(3).filter((u) => u < lock(1)), lock(1) + 400], []),
    backs: () => [{ at: PA_ENDS + 50, backing: WINNER }],
  },
  {
    // A tap 100 ms after the Floor closes, unmeasured: refused, floor locked.
    pid: "p025", nickname: "Overtime", rtt: [],
    recruit: NONE,
    taps: () => [...tapsAt(planThumbs(3), []), { recv: PA_ENDS + 100 }],
    backs: () => [],
  },
  {
    // The same frame on a 400 ms round trip corrects to 100 ms *before* the
    // close: the thumb was on the glass in time, so it counts.
    pid: "p026", nickname: "OvertimeFibre", rtt: [400, 400, 400],
    recruit: NONE,
    taps: () => [...tapsAt(planThumbs(3), [400, 400, 400]), { recv: PA_ENDS + 100 }],
    backs: () => [],
  },
  {
    // A tap after the round has ended: nothing to tap.
    pid: "p027", nickname: "AfterClose", rtt: [],
    recruit: NONE,
    taps: () => [...tapsAt(planThumbs(3), []), { recv: PA_END_ROUND + 100 }],
    backs: () => [],
  },
  {
    // The edge of the grace, from an unmeasured socket: 249 ms after the
    // first lock is a resource, 250 ms after the second is a drain. Backs the
    // fifth across: 10.
    pid: "p028", nickname: "Edge", rtt: [],
    recruit: NONE,
    taps: () => [
      ...tapsAt(planThumbs(4).filter((u) => u < lock(1)), []),
      { recv: lock(0) + PA_GRACE_MS - 1 },
      { recv: lock(1) + PA_GRACE_MS },
    ],
    backs: () => [{ at: lock(1) + 1_000, backing: FIFTH }],
  },
];

const ORDINARY_NAMES = [
  "Grace", "Ola", "Yuki", "Tomasz", "Aisha", "Mateo", "Ines", "Ravi", "Hana",
  "Femi", "Lena", "Diego", "Noor", "Kai", "Sofia", "Emeka", "Mira", "Jonas",
  "Bao", "Chidi", "Dana", "Eli", "Farah", "Gus", "Hiro", "Ida", "Juno",
  "Kofi", "Lior", "Maya", "Nia",
];

const RTT_PROFILES: readonly (readonly number[])[] = [
  [],
  [30, 40, 50],
  [180, 200, 220],
  [900, 1_000, 1_100],
  [40, 4_000, 46], // one bufferbloated packet: the median ignores it
];

const RATES = [2.5, 3, 3.5, 4, 4.5, 5];

/**
 * Thirty-one bots whose behaviour comes off the PRNG. Recruitment: 15% sit an
 * item out, 20% get it wrong, the rest are right in some casing at some point
 * in the window. Plan / Apply: a tap rate, and a 40% chance of slipping into
 * one of the locks; the drained back one of three runners who are never
 * drained — the winner, the fifth across, the survivor who never crosses — so
 * the Lounge pays 15, 10 or 0.
 */
function ordinaryBots(): Bot[] {
  // Two streams rather than one. The Recruitment plan and the Plan / Apply plan
  // used to be drawn from the same PRNG, in that order, so the number of emoji
  // items decided how far along the stream every tap rate, every slip and every
  // bet in the *next* round started. Adding a seventh emoji item therefore
  // re-rolled Plan / Apply: nineteen bots crossed instead of twenty, and a
  // hundred numbers in this file moved for a reason that had nothing to do with
  // them. Separate streams mean each round's plan is a function of its own seed
  // and of nothing else.
  const rRecruit = mulberry32(SEED);
  const rng = mulberry32(PLAN_SEED);
  return ORDINARY_NAMES.map((nickname, i) => {
    const pid = `p${String(i + 29).padStart(3, "0")}`;
    const rtt = RTT_PROFILES[i % RTT_PROFILES.length] ?? [];
    const recruits: (Recruit | null)[] = ITEMS.map((it, item) => {
      const r = rRecruit();
      const delayMs = 3_500 + Math.floor(rRecruit() * 14_500);
      if (r < 0.15) return null;
      // A real HashiCorp product that is not on the board: Waypoint used to be
      // that product and is now item 4, so a bot typing it would be right.
      if (r < 0.35) return { answer: "Vagrant", delayMs };
      const variants = [it.answer, it.answer.toUpperCase(), ` ${it.answer} `, `${it.answer}!`, ...it.accept];
      const answer = variants[Math.floor(rRecruit() * variants.length)] ?? it.answer;
      // The oracle must not depend on an answer the plan meant to be right
      // being refused by a misprint in this table.
      assert.ok(specMatches(item, answer));
      return { answer, delayMs };
    });
    const rate = RATES[Math.floor(rng() * RATES.length)] ?? 3;
    const slips = rng() < 0.4;
    const slipLock = Math.floor(rng() * (APPLIES.length - 1));
    const slipPlus = 400 + Math.floor(rng() * 1_000);
    const backing = [WINNER, FIFTH, SURVIVOR][Math.floor(rng() * 3)] ?? WINNER;
    const taps = slips
      ? tapsAt([...planThumbs(rate).filter((u) => u < lock(slipLock)), lock(slipLock) + slipPlus], rtt)
      : tapsAt(planThumbs(rate), rtt);
    const backs: Back[] = slips ? [{ at: lock(slipLock) + slipPlus + 900, backing }] : [];
    return {
      pid,
      nickname,
      rtt,
      recruit: (item) => recruits[item] ?? null,
      taps: () => taps,
      backs: () => backs,
    };
  });
}

const LATECOMER: Bot = {
  // Joins between the rounds. Player 060, a Recruitment total of nothing, and
  // a full Plan / Apply.
  pid: "p060", nickname: "Latecomer", rtt: [40, 4_000, 46], late: true,
  recruit: NONE,
  taps: () => tapsAt(planThumbs(4.5), [40, 4_000, 46]),
  backs: () => [],
};

const BOTS: readonly Bot[] = [...SPECIAL, ...ordinaryBots(), LATECOMER];
const EARLY: readonly Bot[] = BOTS.filter((b) => !b.late);
const byPid = new Map(BOTS.map((b) => [b.pid, b]));
const rttOf = (pid: ParticipantId): readonly number[] => byPid.get(pid)?.rtt ?? [];

/* ------------------------------------------------------------------ */
/* The expectation, from the plan alone                                 */
/* ------------------------------------------------------------------ */

interface ExpectedAnswer {
  readonly typed: string;
  readonly recv: number;
  /** Accepted by the engine (before the item moved on / the round ended). */
  readonly applied: boolean;
  readonly correct: boolean;
  readonly points: number;
}

interface ExpectedItem {
  /** Every answer sent, in arrival order. */
  readonly answers: readonly (ExpectedAnswer & { readonly pid: ParticipantId })[];
  readonly firstThree: readonly ParticipantId[];
}

interface ExpectedRecruitment {
  readonly items: readonly ExpectedItem[];
  /** Points this round; everyone in the room, at zero if nothing. */
  readonly banked: ReadonlyMap<ParticipantId, number>;
}

function expectRecruitment(): ExpectedRecruitment {
  const banked = new Map<ParticipantId, number>(EARLY.map((b) => [b.pid, 0]));
  const items: ExpectedItem[] = [];
  ITEMS.forEach((_, item) => {
    const start = itemStart(item);
    const ends = itemEnds(item);
    // The engine stops taking answers for this item when the next item opens
    // (100 ms after the timer), or when the Floor timer ends the round.
    const closesTo = item + 1 < ITEMS.length ? ends + ITEM_LAG_MS : RECRUIT_END_ROUND;
    const sent = EARLY.flatMap((b) => {
      const r = b.recruit(item);
      return r ? [{ bot: b, typed: r.answer, recv: start + r.delayMs }] : [];
    }).sort((a, b) => a.recv - b.recv || a.bot.pid.localeCompare(b.bot.pid));
    const answers: (ExpectedAnswer & { pid: ParticipantId })[] = [];
    const firstThree: ParticipantId[] = [];
    let solved = 0;
    for (const s of sent) {
      const applied = s.recv < closesTo;
      // "Every correct answer *within the timer*."
      const correct = applied && s.recv <= ends && specMatches(item, s.typed);
      let points = 0;
      if (correct) {
        points = R_CORRECT + (solved < R_FIRST_PLACES ? R_FIRST_BONUS : 0);
        if (solved < R_FIRST_PLACES) firstThree.push(s.bot.pid);
        solved += 1;
      }
      answers.push({ pid: s.bot.pid, typed: s.typed, recv: s.recv, applied, correct, points });
      if (points) banked.set(s.bot.pid, (banked.get(s.bot.pid) ?? 0) + points);
    }
    items.push({ answers, firstThree });
  });
  return { items, banked };
}

type Refusal =
  | "not_on_the_floor"
  | "floor_locked"
  | "wrong_round_phase"
  | "not_in_the_lounge"
  | "cannot_back_yourself"
  | "cannot_back_a_drained_player";

interface ExpectedTap {
  readonly pid: ParticipantId;
  readonly recv: number;
  readonly at: number;
  readonly outcome: "resource" | "drain" | "ignored" | Refusal;
}

interface ExpectedBack {
  readonly pid: ParticipantId;
  readonly at: number;
  readonly backing: ParticipantId;
  readonly outcome: "ok" | Refusal;
}

interface ExpectedPlanApply {
  readonly taps: readonly ExpectedTap[];
  readonly backs: readonly ExpectedBack[];
  readonly resources: ReadonlyMap<ParticipantId, number>;
  readonly drained: ReadonlySet<ParticipantId>;
  readonly finishOrder: readonly ParticipantId[];
  /** The final bet, per Lounge seat that placed one. */
  readonly backing: ReadonlyMap<ParticipantId, ParticipantId>;
  /** This round's points, Floor and Lounge. Everyone in the round, at zero if nothing. */
  readonly banked: ReadonlyMap<ParticipantId, number>;
  /** How many checkpoint/crossing events moved points, for the frame count. */
  readonly milestones: number;
  /** Of those, how many were a crossing — the ones the big screen draws. */
  readonly crossings: number;
}

type Move =
  | { readonly at: number; readonly order: 1; readonly kind: "tap"; readonly pid: ParticipantId }
  | { readonly at: number; readonly order: 1; readonly kind: "back"; readonly pid: ParticipantId; readonly backing: ParticipantId };

/** Every tap and bet in the round, in the order the server sees them. */
function moves(): Move[] {
  const out: Move[] = [];
  for (const b of BOTS) {
    for (const t of b.taps()) out.push({ at: t.recv, order: 1, kind: "tap", pid: b.pid });
    for (const k of b.backs()) out.push({ at: k.at, order: 1, kind: "back", pid: b.pid, backing: k.backing });
  }
  return out.sort((a, b) => a.at - b.at || a.pid.localeCompare(b.pid) || a.kind.localeCompare(b.kind));
}

function expectPlanApply(): ExpectedPlanApply {
  const resources = new Map<ParticipantId, number>();
  const banked = new Map<ParticipantId, number>(BOTS.map((b) => [b.pid, 0]));
  const drained = new Set<ParticipantId>();
  const finishOrder: ParticipantId[] = [];
  const backing = new Map<ParticipantId, ParticipantId>();
  /** When each bet now standing was placed, which is what pays it. */
  const betAt = new Map<ParticipantId, number>();
  /** When each crossing landed, which is what a bet is judged against. */
  const crossedAt = new Map<ParticipantId, number>();
  const taps: ExpectedTap[] = [];
  const backs: ExpectedBack[] = [];
  let milestones = 0;

  for (const m of moves()) {
    if (m.kind === "tap") {
      const at = m.at - specCorrection(rttOf(m.pid));
      let outcome: ExpectedTap["outcome"];
      if (m.at >= PA_END_ROUND) outcome = "wrong_round_phase";
      else if (drained.has(m.pid)) outcome = "not_on_the_floor";
      else if (at >= PA_ENDS) outcome = "floor_locked";
      else if (finishOrder.includes(m.pid)) outcome = "ignored";
      else {
        const ph = phaseAt(at);
        if (ph.light === "apply" && at - ph.from >= PA_GRACE_MS) {
          outcome = "drain";
          drained.add(m.pid);
        } else {
          outcome = "resource";
          const n = (resources.get(m.pid) ?? 0) + 1;
          resources.set(m.pid, n);
          let gained = 0;
          if (PA_CHECKPOINTS.includes(n)) gained += PA_CHECKPOINT_BANK;
          if (n === PA_TARGET) {
            gained += PA_CROSS + (PA_FINISH[finishOrder.length] ?? 0);
            finishOrder.push(m.pid);
            crossedAt.set(m.pid, m.at);
          }
          if (gained > 0) {
            milestones += 1;
            banked.set(m.pid, (banked.get(m.pid) ?? 0) + gained);
          }
        }
      }
      taps.push({ pid: m.pid, recv: m.at, at, outcome });
    } else {
      let outcome: ExpectedBack["outcome"];
      if (m.at >= PA_END_ROUND) outcome = "wrong_round_phase";
      else if (!drained.has(m.pid)) outcome = "not_in_the_lounge";
      else if (m.at >= PA_ENDS) outcome = "floor_locked";
      else if (m.backing === m.pid) outcome = "cannot_back_yourself";
      else if (drained.has(m.backing)) outcome = "cannot_back_a_drained_player";
      else {
        outcome = "ok";
        backing.set(m.pid, m.backing);
        betAt.set(m.pid, m.at);
      }
      backs.push({ pid: m.pid, at: m.at, backing: m.backing, outcome });
    }
  }

  // The Lounge settles when the Floor stops: crossed 10, won 15, the larger.
  // And only for a bet that was down before its runner crossed — the crossing
  // is on the big screen the moment it happens, so a later bet is a reading
  // of the result rather than a bet on it.
  for (const [pid, backed] of backing) {
    if (drained.has(backed)) continue;
    const finished = crossedAt.get(backed);
    if (finished !== undefined && (betAt.get(pid) ?? 0) >= finished) continue;
    const won = finishOrder[0] === backed;
    const crossed = finishOrder.includes(backed);
    const pay = won ? PA_BACKED_WINS : crossed ? PA_BACKED_CROSSES : 0;
    if (pay) banked.set(pid, (banked.get(pid) ?? 0) + pay);
  }

  return {
    taps,
    backs,
    resources,
    drained,
    finishOrder,
    backing,
    banked,
    milestones,
    crossings: finishOrder.length,
  };
}

/* ------------------------------------------------------------------ */
/* Driving the runtime                                                  */
/* ------------------------------------------------------------------ */

const ACTIVITIES: readonly Activity[] = [
  { id: "ttx", title: "Agentic Security TTX", kind: "manual", spotCap: 2 },
  { id: "trivia", title: "Trivia", kind: "trivia", spotCap: 2 },
  { id: "arcade", title: "Hashi Arcade", kind: "arcade", spotCap: 2 },
];

/** What the driver's clock reads, for the wire checks inside a fake socket's send(). */
let clock = T0;

interface Counts {
  state: number;
  roster: number;
  other: number;
}

interface Wire {
  readonly participant: Counts;
  readonly host: Counts;
  readonly screen: Counts;
  /** Per participant pid, state frames received. */
  readonly perPhone: Map<ParticipantId, number>;
  /** Anything a phone was sent that it must not have been. */
  readonly leaks: string[];
}

function newCounts(): Counts {
  return { state: 0, roster: 0, other: 0 };
}

/**
 * Every future light change, as the strings a leak would have to contain: the
 * epoch itself and the telegraph 400 ms before it. The Floor's close is not
 * secret and is excluded even where the last phase ends on it.
 */
function futureLightEpochs(now: number): string[] {
  const out: string[] = [];
  for (const ph of SCHEDULE) {
    if (ph.to > now && ph.to < PA_ENDS) out.push(String(ph.to), String(ph.to - 400));
  }
  return out;
}

function inspectPhoneFrame(frame: string, wire: Wire, pid: ParticipantId): void {
  if (frame.includes('"nextChangeAt"')) wire.leaks.push(`${pid}: nextChangeAt`);
  if (frame.includes('"headTurnsAt"')) wire.leaks.push(`${pid}: headTurnsAt`);
  if (frame.includes('"finishOrder"')) wire.leaks.push(`${pid}: finishOrder`);
  if (frame.includes('"crossed"')) wire.leaks.push(`${pid}: crossed`);
  if (frame.includes('"hostExtras"')) wire.leaks.push(`${pid}: hostExtras`);
  for (const s of futureLightEpochs(clock)) {
    if (frame.includes(s)) wire.leaks.push(`${pid}: the epoch ${s} of a future light change`);
  }
  // Recruitment's answer is the whole game, and it is not in the bytes until
  // the reveal — not under "answer", and not anywhere else in the frame.
  if (frame.includes('"recruitment"') && !frame.includes('"phase":"reveal"')) {
    if (frame.includes('"answer"')) wire.leaks.push(`${pid}: recruitment answer key`);
    if (frame.includes('"recap"')) wire.leaks.push(`${pid}: recruitment recap`);
    for (const it of ITEMS) {
      if (frame.includes(`"${it.answer}"`)) wire.leaks.push(`${pid}: the word ${it.answer}`);
    }
  }
}

function fakeClient(
  role: "participant" | "host" | "screen",
  wire: Wire,
  pid?: ParticipantId,
  rtt: readonly number[] = [],
): Client {
  const counts = wire[role];
  const socket = {
    readyState: 1,
    send(frame: string) {
      const t = (JSON.parse(frame) as { t: string }).t;
      if (t === "state") counts.state += 1;
      else if (t === "roster") counts.roster += 1;
      else counts.other += 1;
      if (role === "participant" && pid) {
        if (t === "state") wire.perPhone.set(pid, (wire.perPhone.get(pid) ?? 0) + 1);
        inspectPhoneFrame(frame, wire, pid);
      }
    },
  } as unknown as Client["socket"];
  return {
    socket,
    role,
    ...(pid ? { pid } : {}),
    lastSeen: T0,
    seq: 0,
    rtt: [...rtt],
    pingSentAt: null,
  };
}

interface Outcome {
  readonly applied: boolean;
  readonly code: string | undefined;
}

interface Played {
  readonly runtime: ReturnType<SessionRegistry["add"]>["runtime"];
  readonly initial: SessionState;
  /** After Recruitment's endRound, before its reveal. */
  readonly recruitmentEnded: SessionState;
  /** After Plan / Apply's endRound, before its reveal. */
  readonly planApplyEnded: SessionState;
  /** Each item's engine state at the instant before the item moved on. */
  readonly items: readonly SessionState[];
  readonly answerOutcomes: ReadonlyMap<string, Outcome>;
  readonly tapOutcomes: readonly Outcome[];
  readonly backOutcomes: readonly Outcome[];
  readonly wire: Wire;
  /** The wire counts for one ordinary, non-milestone tap. */
  readonly ordinaryTapFrames: number;
  /** Wire counts over the Plan / Apply Floor only. */
  readonly planApplyWire: { participant: Counts; host: Counts; screen: Counts };
  /** State frames each phone received over the Plan / Apply Floor only. */
  readonly phoneStateFrames: ReadonlyMap<ParticipantId, number>;
  /** The participant view of one phone while the light was PLAN, and the raw frame. */
  readonly phoneFramePlan: string;
  readonly phoneFrameApply: string;
}

function play(): Played {
  const registry = new SessionRegistry();
  const initial = newSession({
    sid: "ses-arcade-acceptance",
    title: "Example Team Offsite",
    joinCode: "RAFT",
    activities: ACTIVITIES,
  });
  const { runtime } = registry.add(initial, T0);
  const wire: Wire = {
    participant: newCounts(),
    host: newCounts(),
    screen: newCounts(),
    perPhone: new Map(),
    leaks: [],
  };
  const clients = new Map<ParticipantId, Client>();
  const host = fakeClient("host", wire);
  const screen = fakeClient("screen", wire);
  runtime.clients.add(host);
  runtime.clients.add(screen);

  const must = (event: Event, at: number, what: string): void => {
    clock = at;
    const out = runtime.apply(event, at);
    assert.ok(out.applied, `${what}: ${out.rejection?.code ?? "not applied"}`);
  };
  const join = (bot: Bot, at: number): void => {
    must({ type: "join", pid: bot.pid, nickname: bot.nickname }, at, `join ${bot.nickname}`);
    const client = fakeClient("participant", wire, bot.pid, bot.rtt);
    clients.set(bot.pid, client);
    runtime.clients.add(client);
  };
  const clientOf = (pid: ParticipantId): Client => {
    const c = clients.get(pid);
    assert.ok(c, `${pid} has a socket`);
    return c;
  };

  let now = T0;
  must({ type: "open" }, now, "open");
  for (const bot of EARLY) join(bot, (now += 400));
  must({ type: "start" }, (now += 20_000), "start");
  must({ type: "setSegment", segment: "arcade" }, (now += 1_000), "segment");
  must({ type: "enterArcade", activityId: "arcade" }, (now += 1_000), "enter");

  /* ---- Round 0: Recruitment ---- */

  must(
    { type: "startRound", round: "recruitment", config: recruitmentRound() },
    (now += 2_000),
    "start recruitment",
  );
  assert.ok(RECRUIT_BEGIN > now, "the card is up before the Floor opens");
  must({ type: "beginPlay" }, RECRUIT_BEGIN, "begin recruitment");
  assert.equal(runtime.state.arcade?.endsAt, RECRUIT_ENDS);

  const items: SessionState[] = [];
  const answerOutcomes = new Map<string, Outcome>();
  ITEMS.forEach((_, item) => {
    const start = itemStart(item);
    const sent = EARLY.flatMap((b) => {
      const r = b.recruit(item);
      return r ? [{ bot: b, typed: r.answer, recv: start + r.delayMs }] : [];
    }).sort((a, b) => a.recv - b.recv || a.bot.pid.localeCompare(b.bot.pid));
    // The item's timer, or the Floor's, fires here; answers after it are
    // still sent, because a phone does not know the item has moved on.
    const closesTo = item + 1 < ITEMS.length ? itemEnds(item) + ITEM_LAG_MS : RECRUIT_END_ROUND;
    for (const s of sent.filter((x) => x.recv < closesTo)) {
      clock = s.recv;
      const out = runtime.submitAnswer(clientOf(s.bot.pid), item, s.typed, s.recv);
      answerOutcomes.set(`${item}:${s.bot.pid}`, { applied: out.applied, code: out.rejection?.code });
    }
    items.push(runtime.state);
    if (item + 1 < ITEMS.length) must({ type: "nextItem" }, closesTo, `item ${item + 2}`);
    else must({ type: "endRound" }, closesTo, "end recruitment");
    for (const s of sent.filter((x) => x.recv >= closesTo)) {
      clock = s.recv;
      const out = runtime.submitAnswer(clientOf(s.bot.pid), item, s.typed, s.recv);
      answerOutcomes.set(`${item}:${s.bot.pid}`, { applied: out.applied, code: out.rejection?.code });
    }
  });
  const recruitmentEnded = runtime.state;
  now = RECRUIT_END_ROUND;
  must({ type: "revealRound" }, (now += 3_000), "reveal recruitment");

  /* ---- between rounds: the latecomer ---- */

  join(LATECOMER, (now += 2_000));

  /* ---- Round 1: Plan / Apply ---- */

  must(
    {
      type: "startRound",
      round: "plan_apply",
      config: { kind: "plan_apply", target: PA_TARGET, seconds: PA_SECONDS },
    },
    (now += 3_000),
    "start plan/apply",
  );
  assert.ok(PA_BEGIN > now);
  must({ type: "beginPlay" }, PA_BEGIN, "begin plan/apply");
  assert.equal(runtime.state.arcade?.endsAt, PA_ENDS);

  const paStart = {
    participant: { ...wire.participant },
    host: { ...wire.host },
    screen: { ...wire.screen },
    perPhone: new Map(wire.perPhone),
  };

  // The first light is scheduled by the driver the way the runtime's timer
  // does it on the first tick: PLAN, until the end of the first phase.
  const first = SCHEDULE[0];
  assert.ok(first && first.light === "plan");
  must({ type: "setLight", light: "plan", until: first.to }, PA_BEGIN, "schedule the first light");

  const tapOutcomes: Outcome[] = [];
  const backOutcomes: Outcome[] = [];
  let ordinaryTapFrames = -1;
  let phoneFramePlan = "";
  let phoneFrameApply = "";
  let nextPhase = 1;
  let ended = false;

  for (const m of moves()) {
    // Turn every light that is due before this move.
    while (nextPhase < SCHEDULE.length && (SCHEDULE[nextPhase]?.from ?? Infinity) <= m.at) {
      const ph = SCHEDULE[nextPhase];
      assert.ok(ph);
      must({ type: "setLight", light: ph.light, until: ph.to }, ph.from, `light ${nextPhase}`);
      if (ph.light === "apply" && phoneFrameApply === "") {
        phoneFrameApply = JSON.stringify(runtime.viewFor(clientOf(WINNER), ph.from));
      }
      nextPhase += 1;
    }
    if (!ended && m.at >= PA_END_ROUND) {
      must({ type: "endRound" }, PA_END_ROUND, "end plan/apply");
      ended = true;
    }
    clock = m.at;
    if (m.kind === "tap") {
      const before = wire.participant.state + wire.host.state + wire.screen.state + wire.participant.roster;
      const out = runtime.tap(clientOf(m.pid), 1, m.at);
      const after = wire.participant.state + wire.host.state + wire.screen.state + wire.participant.roster;
      tapOutcomes.push({ applied: out.applied, code: out.rejection?.code });
      // Any accepted tap that moved no points: the frames it cost.
      if (ordinaryTapFrames === -1 && out.applied) {
        const mine = runtime.viewFor(clientOf(m.pid), m.at).arcadeMine;
        if ((mine?.banked ?? 0) === 0 && (mine?.planApply?.resources ?? 0) > 0) {
          ordinaryTapFrames = after - before;
        }
      }
      if (phoneFramePlan === "" && out.applied && m.pid === WINNER) {
        phoneFramePlan = JSON.stringify(runtime.viewFor(clientOf(WINNER), m.at));
      }
    } else {
      const out = runtime.back(clientOf(m.pid), m.backing, m.at);
      backOutcomes.push({ applied: out.applied, code: out.rejection?.code });
    }
  }
  if (!ended) must({ type: "endRound" }, PA_END_ROUND, "end plan/apply");
  const planApplyEnded = runtime.state;
  const planApplyWire = {
    participant: {
      state: wire.participant.state - paStart.participant.state,
      roster: wire.participant.roster - paStart.participant.roster,
      other: wire.participant.other - paStart.participant.other,
    },
    host: {
      state: wire.host.state - paStart.host.state,
      roster: wire.host.roster - paStart.host.roster,
      other: wire.host.other - paStart.host.other,
    },
    screen: {
      state: wire.screen.state - paStart.screen.state,
      roster: wire.screen.roster - paStart.screen.roster,
      other: wire.screen.other - paStart.screen.other,
    },
  };
  const phoneStateFrames = new Map<ParticipantId, number>();
  for (const b of BOTS) {
    phoneStateFrames.set(
      b.pid,
      (wire.perPhone.get(b.pid) ?? 0) - (paStart.perPhone.get(b.pid) ?? 0),
    );
  }
  must({ type: "revealRound" }, PA_END_ROUND + 3_000, "reveal plan/apply");
  // Nothing in this file waits on a timer: the runtime armed real ones from
  // the fake clock, and they must not fire into the next test file.
  runtime.clearArcadeTimers();
  runtime.clearQuestionTimer();

  return {
    runtime,
    initial,
    recruitmentEnded,
    planApplyEnded,
    items,
    answerOutcomes,
    tapOutcomes,
    backOutcomes,
    wire,
    ordinaryTapFrames,
    planApplyWire,
    phoneStateFrames,
    phoneFramePlan,
    phoneFrameApply,
  };
}

/* ------------------------------------------------------------------ */
/* Hand-computed anchors                                                */
/* ------------------------------------------------------------------ */

/**
 * Priya: right and first on all seven items, 10 + 5 each → 105. First across
 * the line: 30, 60, 90 bank 5 each (15), crossing 10, first place 15 → 40.
 *   105 + 40
 */
const PRIYA = 145;

/**
 * Kenji: right and second on six items (sits out Consul) → 6 × 15 = 90.
 * Second across: 15 + 10 + 10 → 35.
 *   90 + 35
 */
const KENJI = 125;

/**
 * Zoë: third correct on Vault (Priya, Kenji, Zoë) and on Consul (Kenji sits
 * it out) → 15 each; *fourth* on Terraform, behind Survivor's "tf" at 2.5 s →
 * 10. Recruitment 40. Ninety resources exactly (15 banked), then drained —
 * and the bet she then places on Priya is placed after Priya is across, so it
 * pays nothing. 15 in the round.
 *
 * She is the reason the Lounge is timed at all. With the bet paid she
 * finished on 30: more than Sam's honest 25 for a fifth-place crossing, and
 * bought by reading the finish off the big screen.
 *   15 + 10 + 15 + 15
 */
const ZOE = 55;
const ZOE_PLAN_APPLY = 15;

/**
 * Sam: nothing typed; fifth across the line — three checkpoints and the
 * crossing, no place bonus. 25, which beats a perfect Lounge (15).
 */
const SAM = 25;

/** Late: drained in the first lock with nothing banked; backed the winner. */
const LATE = 15;

/** Snail: right at the buzzer on six items and with a second to spare on the seventh, 10 each; 29 resources banks nothing. */
const SNAIL = 70;

/** Hermit: nothing, and on the board for it. */
const HERMIT = 0;

/* ------------------------------------------------------------------ */
/* The round                                                            */
/* ------------------------------------------------------------------ */

describe("sixty bots play Recruitment and Plan / Apply", () => {
  const recruit = expectRecruitment();
  const pa = expectPlanApply();
  const played = play();
  const finalState = played.runtime.state;

  test("the launch content is what SPEC says it is", () => {
    assert.equal(RECRUITMENT_ITEMS.length, ITEMS.length);
    RECRUITMENT_ITEMS.forEach((it, i) => {
      assert.equal(it.answer, ITEMS[i]?.answer, `item ${i + 1} answer`);
      assert.deepEqual([...it.accept], [...(ITEMS[i]?.accept ?? [])], `item ${i + 1} accept list`);
      assert.equal([...it.cue].length > 0, true, `item ${i + 1} has a cue`);
    });
    assert.equal(recruitmentRound().kind, "recruitment");
    assert.equal(
      (recruitmentRound() as { secondsPerItem: number }).secondsPerItem,
      R_SECONDS_PER_ITEM,
    );
  });

  test("the plan is what it says it is", () => {
    assert.equal(BOTS.length, 60);
    assert.equal(new Set(BOTS.map((b) => b.pid)).size, 60);
    assert.equal(EARLY.length, 59);
    // SPEC: 2–6 s phases, PLAN first, over 75 s.
    assert.ok(SCHEDULE.length >= 10, `only ${SCHEDULE.length} light phases`);
    for (const ph of SCHEDULE.slice(0, -1)) {
      assert.ok(ph.to - ph.from >= 2_000 && ph.to - ph.from <= 6_000);
    }
    assert.equal(SCHEDULE[0]?.light, "plan");
    // The shape SPEC tunes for: about half the room crosses; a good number
    // are drained; the Lounge pays 15, 10 and 0 to somebody each.
    assert.ok(pa.finishOrder.length >= 20 && pa.finishOrder.length <= 40, `${pa.finishOrder.length} crossed`);
    assert.ok(pa.drained.size >= 12, `${pa.drained.size} drained`);
    assert.equal(pa.finishOrder[0], WINNER);
    assert.equal(pa.finishOrder[1], "p002");
    assert.equal(pa.finishOrder[4], FIFTH, "Sam is fifth across");
    assert.ok(!pa.finishOrder.includes(SURVIVOR) && !pa.drained.has(SURVIVOR));
    assert.ok(!pa.drained.has(WINNER) && !pa.drained.has(FIFTH));
    assert.equal(pa.resources.get(SURVIVOR), 119);
    assert.equal(pa.resources.get("p005"), 90, "Zoë is drained at exactly 90");
    assert.equal(pa.resources.get("p018"), 45, "Coral is drained at exactly 45");
    assert.equal(pa.resources.get("p013"), 29);
    // Coral's bet on Doomed lands before Doomed is drained.
    const coral = pa.backs.find((b) => b.pid === "p018");
    assert.equal(coral?.outcome, "ok");
    assert.ok(pa.drained.has(DOOMED));
    const doomedDrain = pa.taps.find((t) => t.pid === DOOMED && t.outcome === "drain");
    assert.ok(doomedDrain && coral && doomedDrain.at > coral.at);
    // OvertimeFibre's corrected tap lands on a green light, or the case is moot.
    assert.equal(phaseAt(PA_ENDS - 100).light, "plan", "pick a seed whose last phase is PLAN");
    const lounge = [...pa.backing.entries()].map(([pid, b]) => ({ pid, pay: (pa.banked.get(pid) ?? 0) }));
    assert.ok(lounge.length >= 8, `${lounge.length} bets placed`);
    assert.ok(pa.backs.some((b) => b.outcome === "ok" && b.backing === FIFTH));
    assert.ok(pa.backs.some((b) => b.outcome === "ok" && b.backing === SURVIVOR));
    // Recruitment: at least one ordinary bot takes a first-three bonus, and
    // some answers are wrong, silent, and late.
    const ordinaryFirst = recruit.items.some((it) =>
      it.firstThree.some((pid) => pid >= "p029"),
    );
    assert.ok(ordinaryFirst, "an ordinary bot is among the first three on some item");
    const wrong = recruit.items.flatMap((it) => it.answers).filter((a) => a.applied && !a.correct);
    assert.ok(wrong.length >= 20, `${wrong.length} wrong or late answers`);
  });

  test("Recruitment: every answer's points, the first three per item, and the refusals", () => {
    recruit.items.forEach((want, item) => {
      const got = played.items[item]?.arcade?.play;
      assert.ok(got && got.kind === "recruitment", `item ${item + 1} state`);
      assert.equal(got.at, item);
      // Who is on record for this item: exactly the accepted answers.
      const accepted = want.answers.filter((a) => a.applied);
      assert.deepEqual(
        Object.keys(got.answered).sort(),
        accepted.map((a) => a.pid).sort(),
        `item ${item + 1}: who is locked in`,
      );
      for (const a of accepted) {
        assert.equal(got.answered[a.pid], a.correct, `item ${item + 1} ${a.pid} "${a.typed}" correct`);
      }
      // The first three correct, in arrival order.
      assert.deepEqual(got.solvedOrder.slice(0, R_FIRST_PLACES), want.firstThree, `item ${item + 1} first three`);
      assert.equal(
        got.solvedOrder.length,
        accepted.filter((a) => a.correct).length,
        `item ${item + 1} solved count`,
      );
      for (const a of want.answers) {
        const out = played.answerOutcomes.get(`${item}:${a.pid}`);
        assert.ok(out, `item ${item + 1} ${a.pid} was sent`);
        assert.equal(out.applied, a.applied, `item ${item + 1} ${a.pid} accepted`);
        if (!a.applied) assert.equal(out.code, "wrong_round_phase", `item ${item + 1} ${a.pid}`);
      }
    });
    // Typo is first to type on every item and never among the first three.
    for (const it of recruit.items) assert.ok(!it.firstThree.includes("p015"));
    // JustLate is locked in for nothing on every item but the last; MovedOn is
    // refused on all of them.
    for (let item = 0; item < LAST_ITEM; item += 1) {
      assert.deepEqual(played.answerOutcomes.get(`${item}:p016`), { applied: true, code: undefined });
      assert.equal(played.items[item]?.arcade?.play?.kind === "recruitment" && played.items[item]?.arcade?.banked["p016"], undefined);
    }
    for (let item = 0; item < ITEMS.length; item += 1) {
      assert.deepEqual(played.answerOutcomes.get(`${item}:p017`), { applied: false, code: "wrong_round_phase" });
    }
  });

  test("Recruitment: the banked points, and nobody is drained", () => {
    const arcade = played.recruitmentEnded.arcade;
    assert.ok(arcade);
    assert.equal(arcade.phase, "idle");
    for (const [pid, want] of recruit.banked) {
      assert.equal(arcade.banked[pid] ?? 0, want, `${pid} banked`);
      assert.equal(arcade.totals[pid], want, `${pid} total after round 0`);
      assert.equal(arcade.standing[pid], "floor");
    }
    assert.deepEqual(arcade.lounge, {});
    // Seven items at 10 + 5 for a first-three finish: the Floor max moved with
    // the seventh item, and SPEC's table of 90 counts six.
    assert.equal(arcade.banked[WINNER], 105, "the Floor max");
    assert.equal(Math.max(...Object.values(arcade.banked)), 105);
  });

  test("the latecomer is Player 060 and nobody was renumbered", () => {
    const arcade = finalState.arcade;
    assert.ok(arcade);
    assert.equal(arcade.playerNumbers[LATECOMER.pid], 60);
    EARLY.forEach((b, i) => assert.equal(arcade.playerNumbers[b.pid], i + 1, b.nickname));
    const grid = arcadeGrid(finalState, arcade);
    assert.equal(grid.length, 60);
    assert.deepEqual(grid.map((c) => c.playerNumber), Array.from({ length: 60 }, (_, i) => i + 1));
    // No Recruitment total, a full Plan / Apply.
    assert.equal(played.recruitmentEnded.arcade?.totals[LATECOMER.pid], undefined);
    assert.equal(finalState.arcade?.totals[LATECOMER.pid], pa.banked.get(LATECOMER.pid));
    assert.ok((pa.banked.get(LATECOMER.pid) ?? 0) >= 25, "the latecomer crossed");
  });

  test("Plan / Apply: every tap's outcome", () => {
    assert.equal(played.tapOutcomes.length, pa.taps.length);
    pa.taps.forEach((want, i) => {
      const got = played.tapOutcomes[i];
      assert.ok(got);
      const where = `${want.pid} tap at +${want.recv - PA_BEGIN} ms (judged +${want.at - PA_BEGIN})`;
      switch (want.outcome) {
        case "resource":
        case "drain":
          assert.deepEqual(got, { applied: true, code: undefined }, `${where}: ${want.outcome}`);
          break;
        case "ignored":
          assert.deepEqual(got, { applied: false, code: undefined }, `${where}: already across`);
          break;
        default:
          assert.deepEqual(got, { applied: false, code: want.outcome }, where);
      }
    });
    const play = played.planApplyEnded.arcade?.play;
    assert.ok(play && play.kind === "plan_apply");
    assert.deepEqual(play.finishOrder, pa.finishOrder, "who crossed, in order");
    assert.deepEqual(
      Object.fromEntries([...pa.resources].sort()),
      Object.fromEntries(Object.entries(play.resources).sort()),
      "resources",
    );
    assert.deepEqual(
      Object.entries(played.planApplyEnded.arcade?.standing ?? {})
        .filter(([, s]) => s === "drained")
        .map(([pid]) => pid)
        .sort(),
      [...pa.drained].sort(),
      "who was drained",
    );
  });

  test("Plan / Apply: the grace, at the wire's numbers", () => {
    const of = (pid: ParticipantId) => pa.taps.filter((t) => t.pid === pid);
    // Hotel: +499 corrects to +249 and is a resource; +500 corrects to +250 and drains.
    const hotel = of("p007");
    assert.equal(hotel.find((t) => t.recv === lock(0) + 499)?.outcome, "resource");
    assert.equal(hotel.find((t) => t.recv === lock(1) + 500)?.outcome, "drain");
    assert.ok(pa.drained.has("p007"));
    // Fibre: +259 on a 20 ms round trip is +249 — a resource, and never drained.
    assert.equal(of("p008").find((t) => t.recv === lock(0) + 259)?.outcome, "resource");
    assert.ok(!pa.drained.has("p008"));
    // Grace: +249 unmeasured is a resource; +250 is a drain.
    const grace = of("p028");
    assert.equal(grace.find((t) => t.recv === lock(0) + 249)?.outcome, "resource");
    assert.equal(grace.find((t) => t.recv === lock(1) + 250)?.outcome, "drain");
    // Unmeasured: +100 is a resource; 1.5 s into a lock is a drain.
    assert.equal(of("p009").find((t) => t.recv === lock(0) + 100)?.outcome, "resource");
    assert.equal(of("p009").find((t) => t.recv === lock(2) + 1_500)?.outcome, "drain");
    // And the engine agreed on every one of them — the outcomes test above
    // compared them all; this names the ones the grace exists for.
    const drainedAt = (pid: ParticipantId) => played.planApplyEnded.arcade?.lounge[pid]?.at;
    assert.equal(drainedAt("p007"), lock(1) + 500);
    assert.equal(drainedAt("p028"), lock(1) + 250);
    assert.equal(drainedAt("p008"), undefined);
  });

  test("Plan / Apply: the Floor closes on the corrected instant", () => {
    const overtime = pa.taps.find((t) => t.pid === "p025" && t.recv === PA_ENDS + 100);
    const fibre = pa.taps.find((t) => t.pid === "p026" && t.recv === PA_ENDS + 100);
    const after = pa.taps.find((t) => t.pid === "p027" && t.recv === PA_END_ROUND + 100);
    assert.equal(overtime?.outcome, "floor_locked");
    assert.equal(fibre?.outcome, "resource");
    assert.equal(after?.outcome, "wrong_round_phase");
    const play = played.planApplyEnded.arcade?.play;
    assert.ok(play && play.kind === "plan_apply");
    assert.equal(play.resources["p026"], pa.resources.get("p026"));
  });

  test("Plan / Apply: the Lounge's bets and refusals", () => {
    assert.equal(played.backOutcomes.length, pa.backs.length);
    pa.backs.forEach((want, i) => {
      const got = played.backOutcomes[i];
      const where = `${want.pid} backs ${want.backing} at +${want.at - PA_BEGIN} ms`;
      if (want.outcome === "ok") assert.deepEqual(got, { applied: true, code: undefined }, where);
      else assert.deepEqual(got, { applied: false, code: want.outcome }, where);
    });
    const lounge = played.planApplyEnded.arcade?.lounge ?? {};
    for (const [pid, backing] of pa.backing) {
      assert.equal(lounge[pid]?.backing, backing, `${pid}'s final bet`);
    }
    // Every drained player has a seat; a seat with no bet is `backing: null`.
    assert.deepEqual(Object.keys(lounge).sort(), [...pa.drained].sort());
    assert.equal(lounge["p011"]?.backing, null, "Skipper never backed anyone");
    assert.equal(lounge["p024"]?.backing, null, "LateBet's bet came after the lock");
    assert.equal(lounge["p010"]?.backing, SURVIVOR, "Switcher's last word");
    // The refusal codes, one each.
    const codeOf = (pid: ParticipantId, backing: ParticipantId) =>
      pa.backs.find((b) => b.pid === pid && b.backing === backing)?.outcome;
    assert.equal(codeOf("p022", WINNER), "not_in_the_lounge");
    assert.equal(codeOf("p023", "p023"), "cannot_back_yourself");
    assert.equal(codeOf("p023", ZERO), "cannot_back_a_drained_player");
    assert.equal(codeOf("p024", WINNER), "floor_locked");
    assert.equal(pa.taps.find((t) => t.pid === "p021" && t.outcome === "not_on_the_floor") !== undefined, true);
  });

  test("Plan / Apply: the banked points, Floor and Lounge", () => {
    const arcade = played.planApplyEnded.arcade;
    assert.ok(arcade);
    for (const [pid, want] of pa.banked) {
      assert.equal(arcade.banked[pid] ?? 0, want, `${pid} (${byPid.get(pid)?.nickname}) banked in Plan / Apply`);
    }
    assert.equal(Math.max(...Object.values(arcade.banked)), 40, "the Floor max");
    // The Lounge, by name: 15 for the winner, 10 for a crosser, 0 for a
    // runner who never crossed, 0 for a runner who was drained after the bet.
    assert.equal(arcade.banked[ZERO], 15);
    assert.equal(arcade.banked["p021"], 10, "Stray backed Sam");
    assert.equal(arcade.banked["p018"], 5, "Coral: one checkpoint, and Doomed let them down");
    // Switcher and Unmeasured: checkpoints only, because the last bet was on a
    // runner who never crossed.
    const cpBank = (pid: ParticipantId) => PA_CHECKPOINTS.filter((c) => c <= (pa.resources.get(pid) ?? 0)).length * PA_CHECKPOINT_BANK;
    assert.equal(arcade.banked["p010"] ?? 0, cpBank("p010"), "Switcher's last bet was on a non-crosser");
    assert.equal(arcade.banked["p009"] ?? 0, cpBank("p009"), "Unmeasured backed a non-crosser");
  });

  test("the totals are cumulative across rounds, and the hand-computed ones", () => {
    const totals = finalState.arcade?.totals ?? {};
    for (const b of BOTS) {
      const want = (recruit.banked.get(b.pid) ?? 0) + (pa.banked.get(b.pid) ?? 0);
      assert.equal(totals[b.pid], want, `${b.nickname}'s arcade raw`);
    }
    assert.equal(totals[WINNER], PRIYA, "Priya");
    assert.equal(totals["p002"], KENJI, "Kenji");
    assert.equal(totals["p005"], ZOE, "Zoë");
    assert.equal(played.planApplyEnded.arcade?.banked["p005"], ZOE_PLAN_APPLY, "Zoë's round: the 15 she banked, and nothing for a bet placed after the winner was across");
    assert.equal(totals[FIFTH], SAM, "Sam");
    assert.equal(totals[ZERO], LATE, "Late");
    assert.equal(totals["p013"], SNAIL, "Snail");
    assert.equal(totals["p014"], HERMIT, "Hermit");
    // The oracle agrees with the hand arithmetic, so the two are not just
    // agreeing with each other.
    assert.equal((recruit.banked.get(WINNER) ?? 0) + (pa.banked.get(WINNER) ?? 0), PRIYA);
    assert.equal((recruit.banked.get("p005") ?? 0) + (pa.banked.get("p005") ?? 0), ZOE);
    assert.equal(pa.banked.get(FIFTH), SAM);
    // SPEC's tuning rule: crossing the line — in last place — beats a perfect
    // Lounge, and a player drained at 90 who backed the winner does not tie
    // the player who won.
    const lastAcross = pa.finishOrder[pa.finishOrder.length - 1];
    assert.ok(lastAcross);
    assert.equal(pa.banked.get(lastAcross), 25);
    assert.ok(25 > PA_BACKED_WINS);
    assert.ok(ZOE_PLAN_APPLY < 40);
    // A player who survives the round without reaching a checkpoint banks
    // nothing, and a perfect Lounge beats them. SPEC says that is the shape.
    assert.equal(pa.banked.get("p013"), 0);
  });

  test("draining lasts one round: everyone was back on the Floor with banked cleared and totals kept", () => {
    // Recruitment's totals were in place when Plan / Apply's card went up,
    // and its banked column was empty.
    const log = played.runtime.log;
    const startPa = log.findIndex((r) => r.event.type === "startRound" && r.event.round === "plan_apply");
    assert.ok(startPa > 0);
    const atCard = replay(played.initial, log.slice(0, startPa + 1).map((r) => ({ event: r.event, at: r.at })));
    const arcade = atCard.arcade;
    assert.ok(arcade);
    assert.equal(arcade.phase, "card");
    assert.deepEqual(arcade.banked, {});
    assert.deepEqual(arcade.lounge, {});
    for (const b of BOTS) assert.equal(arcade.standing[b.pid], "floor", b.nickname);
    for (const [pid, want] of recruit.banked) assert.equal(arcade.totals[pid], want);
  });

  test("the raw scores land at the reveal and normalise like any other activity", () => {
    // Before the reveal: Recruitment's totals only.
    const before = played.planApplyEnded.scores["arcade"] ?? {};
    for (const [pid, want] of recruit.banked) {
      assert.deepEqual(before[pid], { raw: want, status: "played" }, `${pid} before the reveal`);
    }
    assert.equal(before[LATECOMER.pid], undefined);
    // After: everyone in the round, at zero if they scored nothing.
    const scores = finalState.scores["arcade"] ?? {};
    for (const b of BOTS) {
      const raw = (recruit.banked.get(b.pid) ?? 0) + (pa.banked.get(b.pid) ?? 0);
      assert.deepEqual(scores[b.pid], { raw, status: "played" }, b.nickname);
    }
    assert.deepEqual(scores["p014"], { raw: 0, status: "played" }, "Hermit is on the board at 0");
    // SCORING.md: top raw is 100, everyone else round(100 × raw ÷ top).
    const standings = computeStandings(finalState);
    const top = PRIYA;
    for (const b of BOTS) {
      const raw = (recruit.banked.get(b.pid) ?? 0) + (pa.banked.get(b.pid) ?? 0);
      const row = standings.find((s) => s.pid === b.pid);
      assert.equal(row?.perActivity["arcade"]?.points, Math.round((100 * raw) / top), b.nickname);
    }
    assert.equal(standings.find((s) => s.pid === "p002")?.perActivity["arcade"]?.points, 86); // 125/145
  });

  test("a phone is never sent the light schedule, the answer key or the Floor's results", () => {
    assert.deepEqual(played.wire.leaks.slice(0, 20), [], `${played.wire.leaks.length} leaks`);
    // The raw serialised frame, once on green and once on pink.
    for (const frame of [played.phoneFramePlan, played.phoneFrameApply]) {
      assert.ok(frame.length > 0);
      assert.ok(frame.includes('"light":"'), frame.slice(0, 200));
      assert.ok(frame.includes('"lightChangedAt":'), "the current light's start is sent");
      assert.ok(!frame.includes("nextChangeAt"));
      assert.ok(!frame.includes("headTurnsAt"));
      assert.ok(!frame.includes("finishOrder"));
      assert.ok(!frame.includes("hostExtras"));
      // And no phone is told anybody else's resource count or banked points.
      assert.ok(!frame.includes('"resources":{'));
      assert.ok(!frame.includes('"banked":{'));
    }
    assert.ok(played.phoneFrameApply.includes('"light":"apply"'));
  });

  test("an ordinary tap costs no frames, and a milestone costs three, not sixty", (t) => {
    assert.equal(played.ordinaryTapFrames, 0, "a non-milestone tap fanned frames out");
    const w = played.planApplyWire;
    const n = BOTS.length;
    const lights = SCHEDULE.length; // the first light's scheduling plus each turn
    const drains = pa.drained.size;
    const ownBets = pa.backs.filter((b) => b.outcome === "ok").length;

    // What is genuinely room-wide, and it is a short list: the light turning,
    // somebody being drained (the dormitory grid moves for everyone), and the
    // round ending.
    const roomWide = lights + drains + 1; // + endRound

    // ---- before ----
    //
    // Every milestone used to be `to: "all"` as well, and every `to: "all"`
    // state broadcast also forced a roster resend — a second full frame on
    // every socket, and for the host a second whole RenderState rather than a
    // delta. These four numbers are what that costs on *this* Floor: 11 600
    // state frames and 11 580 roster frames to the phones over a 75 s Floor
    // with sixty players, about 118 MB at the frame size below, roughly 300
    // frames a second.
    //
    // They are re-measured rather than inherited, and it is worth saying why so
    // that nobody reads them as the original observation. The roster-resend fix
    // was argued against a Floor of a slightly different shape: Recruitment had
    // six items, and this file drew its whole arcade from one PRNG stream in
    // round order, so the number of emoji items decided where Plan / Apply's
    // taps, slips and bets began. Seven items and a stream of Plan / Apply's own
    // moved every absolute count in this test. The claim is the ratio at the
    // bottom, which did not move; these four are only good for the Floor
    // `SCHEDULE` and `PLAN_SEED` describe, and they change when it does.
    const wasAll = roomWide + pa.milestones;
    const before = {
      participantState: wasAll * n + ownBets,
      participantRoster: wasAll * n,
      hostState: wasAll + ownBets + wasAll, // + the roster resend's full state
      screenState: wasAll + ownBets,
    };
    assert.deepEqual(before, {
      participantState: 11_600,
      participantRoster: 11_580,
      hostState: 406,
      screenState: 213,
    }, "the baseline these numbers are measured against has moved");

    // ---- after ----
    //
    // A checkpoint goes to the tapping phone and the console; a crossing goes
    // to the big screen as well, because `crossed` and `finishOrder` are on
    // its projection and nothing else on it moved. A roster frame goes out
    // when the roster changes, which during a Floor is never.
    const after = {
      participantState: roomWide * n + pa.milestones + ownBets,
      participantRoster: 0,
      hostState: roomWide + pa.milestones + ownBets,
      screenState: roomWide + pa.crossings + ownBets,
    };
    assert.deepEqual(after, {
      participantState: 2_573,
      participantRoster: 0,
      hostState: 213,
      screenState: 83,
    });

    // And the measurement itself, from the fake sockets, against both.
    assert.equal(w.participant.state, after.participantState);
    assert.equal(w.participant.roster, after.participantRoster);
    assert.equal(w.host.state, after.hostState);
    assert.equal(w.host.roster, 0, "the host is never sent a roster delta");
    assert.equal(w.screen.state, after.screenState);
    assert.equal(w.screen.roster, after.participantRoster);

    // Every phone still hears every room-wide broadcast: the saving is in what
    // was never theirs to hear, not in dropping frames they needed.
    const perPhone = played.phoneStateFrames;
    for (const b of BOTS) {
      const got = perPhone.get(b.pid) ?? 0;
      assert.ok(
        got >= roomWide,
        `${b.nickname} received ${got} state frames over the Floor, expected at least ${roomWide}`,
      );
    }

    const bytes = played.phoneFramePlan.length;
    const summary = {
      lights,
      milestones: pa.milestones,
      crossings: pa.crossings,
      drains,
      bets: ownBets,
      before,
      after,
      approxBytesPerStateFrame: bytes,
      beforeMB: Math.round((before.participantState * bytes) / 1e6),
      afterMB: Math.round((after.participantState * bytes) / 1e6),
    };
    t.diagnostic(JSON.stringify(summary));
    // The whole point, as one assertion: better than a four-fold cut on the
    // state frames and the roster traffic gone entirely.
    assert.ok(
      after.participantState * 4 < before.participantState,
      JSON.stringify(summary),
    );
  });

  test("the whole run replays from its event log to the same state", () => {
    const again = replay(
      played.initial,
      played.runtime.log.map((r) => ({ event: r.event, at: r.at })),
    );
    assert.deepEqual(again, played.runtime.state);
  });
});

/* ------------------------------------------------------------------ */
/* Non-default targets                                                  */
/* ------------------------------------------------------------------ */

describe("checkpoints are quarter marks of the target", () => {
  function planAt(target: number): SessionState {
    const s0 = newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES });
    const events: Event[] = [
      { type: "open" },
      { type: "join", pid: "p1", nickname: "Priya" },
      { type: "join", pid: "p2", nickname: "Kenji" },
      { type: "start" },
      { type: "enterArcade", activityId: "arcade" },
      { type: "startRound", round: "plan_apply", config: { kind: "plan_apply", target, seconds: 75 } },
      { type: "beginPlay" },
      { type: "setLight", light: "plan", until: T0 + 60_000 },
    ];
    return replay(s0, events.map((event) => ({ event, at: T0 })));
  }
  const tapN = (s: SessionState, pid: string, n: number): SessionState =>
    replay(s, Array.from({ length: n }, () => ({ event: { type: "tap", pid, at: T0 + 1 } as Event, at: T0 + 1 })));

  test("target 60: 15 / 30 / 45 bank 5 each; a crossing is 25 + place", () => {
    // SPEC: "Getting caught at 75% keeps what you banked at 50%" — the quarter
    // marks of 60 are 15, 30, 45, by hand.
    const s = planAt(60);
    const view = renderStateFor(s, { role: "participant", pid: "p1", lastSeen: new Map(), now: T0 });
    assert.deepEqual(view.arcade?.planApply?.checkpoints, [15, 30, 45]);
    const banked = (st: SessionState, pid: string) => st.arcade?.banked[pid] ?? 0;
    assert.equal(banked(tapN(s, "p1", 14), "p1"), 0);
    assert.equal(banked(tapN(s, "p1", 15), "p1"), 5);
    assert.equal(banked(tapN(s, "p1", 29), "p1"), 5);
    assert.equal(banked(tapN(s, "p1", 30), "p1"), 10);
    assert.equal(banked(tapN(s, "p1", 45), "p1"), 15);
    assert.equal(banked(tapN(s, "p1", 59), "p1"), 15);
    assert.equal(banked(tapN(s, "p1", 60), "p1"), 15 + 10 + 15, "first across");
    const both = tapN(tapN(s, "p1", 60), "p2", 60);
    assert.equal(banked(both, "p2"), 15 + 10 + 10, "second across");
    // Nothing banked at 30 or 60 taps *past* the line: the button is done.
    assert.equal(banked(tapN(both, "p1", 60), "p1"), 40);
  });

  test("target 4: 1 / 2 / 3, once each, and the fourth tap crosses", () => {
    const s = planAt(4);
    const view = renderStateFor(s, { role: "participant", pid: "p1", lastSeen: new Map(), now: T0 });
    assert.deepEqual(view.arcade?.planApply?.checkpoints, [1, 2, 3]);
    const banked = (st: SessionState) => st.arcade?.banked["p1"] ?? 0;
    assert.equal(banked(tapN(s, "p1", 1)), 5);
    assert.equal(banked(tapN(s, "p1", 2)), 10);
    assert.equal(banked(tapN(s, "p1", 3)), 15);
    assert.equal(banked(tapN(s, "p1", 4)), 40);
    const play = tapN(s, "p1", 4).arcade?.play;
    assert.ok(play && play.kind === "plan_apply");
    assert.deepEqual(play.finishOrder, ["p1"]);
  });

  test("target 2 and 1: a checkpoint is never on or past the line", () => {
    for (const target of [2, 1]) {
      const s = planAt(target);
      const view = renderStateFor(s, { role: "participant", pid: "p1", lastSeen: new Map(), now: T0 });
      const cps = view.arcade?.planApply?.checkpoints ?? [];
      for (const c of cps) assert.ok(c > 0 && c < target, `target ${target}: checkpoint ${c}`);
      assert.equal(new Set(cps).size, cps.length, "no checkpoint pays twice");
      // Crossing: 10 + 15 for first, plus whatever the checkpoints are worth.
      assert.equal(tapN(s, "p1", target).arcade?.banked["p1"], cps.length * 5 + 25);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Known discrepancies, left visible                                    */
/* ------------------------------------------------------------------ */

describe("known discrepancies against SPEC", () => {
  const base = newSession({ sid: "s", title: "t", joinCode: "RAFT", activities: ACTIVITIES });
  const toPlay: readonly Event[] = [
    { type: "open" },
    { type: "join", pid: "p1", nickname: "Priya" },
    { type: "join", pid: "p2", nickname: "Kenji" },
    { type: "start" },
    { type: "enterArcade", activityId: "arcade" },
    { type: "startRound", round: "plan_apply", config: { kind: "plan_apply", target: 120, seconds: 75 } },
    { type: "beginPlay" },
    { type: "setLight", light: "plan", until: T0 + 3_000 },
  ];
  const planning = (): SessionState => replay(base, toPlay.map((event) => ({ event, at: T0 })));

  test(
    "a tap made during APPLY that reaches the server after the light has gone back to PLAN is a drain",
    () => {
      // Lock at +3000 for 2000 ms; PLAN again at +5000. A 400 ms round trip
      // phone taps at +4900 — 1.9 s into the lock, the phone plainly showing
      // pink — and the frame lands at +5100, after the flip back to green.
      // SPEC: "During APPLY (pink), any tap is … drained."
      const s = replay(planning(), [
        { event: { type: "setLight", light: "apply", until: T0 + 5_000 }, at: T0 + 3_000 },
        { event: { type: "setLight", light: "plan", until: T0 + 9_000 }, at: T0 + 5_000 },
        // correctedTapAt() at the boundary: at = 5100 − 200 = 4900, inside
        // the APPLY that just ended, so the grace does not reach it and the
        // reducer judges it against `applySince`, not against the light now.
        { event: { type: "tap", pid: "p1", at: T0 + 4_900 }, at: T0 + 5_100 },
      ]);
      assert.equal(s.arcade?.standing["p1"], "drained");
    },
  );

  test(
    "a participant who joins mid-round can either play or back somebody",

    () => {
      const s = replay(planning(), [
        { event: { type: "join", pid: "p3", nickname: "Midway" }, at: T0 + 1_000 },
      ]);
      const view = renderStateFor(s, { role: "participant", pid: "p3", lastSeen: new Map(), now: T0 + 1_000 });
      assert.equal(view.arcadeMine?.standing, "floor", "the phone shows them on the Floor");
      const tap = replay(s, [{ event: { type: "tap", pid: "p3", at: T0 + 1_500 }, at: T0 + 1_500 }]);
      const back = replay(s, [{ event: { type: "backPlayer", pid: "p3", backing: "p1" }, at: T0 + 1_500 }]);
      assert.ok(
        tap.seq > s.seq || back.seq > s.seq,
        "neither a tap nor a bet is accepted from a mid-round joiner",
      );
    },
  );

  test(
    "Recruitment's last item gets its full twenty seconds",
    () => {
      // Two items for brevity, driven through the runtime because the defect
      // was two clocks racing, and only the runtime has clocks.
      //
      // The item timer fires 300 ms late (event-loop lag), so item 2 opens at
      // +20 300 and its own twenty seconds run to +40 300. The Floor timer was
      // armed for `beginPlay + 2 × 20 s` = +40 000 and ended the round there,
      // 300 ms early — every round, on the last item, by the accumulated
      // item-timer lag. One of the two owns the ending, and for Recruitment it
      // is the item's: the round is six twenty-second items, not a two-minute
      // Floor that happens to contain six of them.
      const registry = new SessionRegistry();
      const initial = newSession({ sid: "s3", title: "t", joinCode: "RAFT", activities: ACTIVITIES });
      const { runtime } = registry.add(initial, T0);
      const setup: readonly Event[] = [
        { type: "open" },
        { type: "join", pid: "p1", nickname: "Priya" },
        { type: "start" },
        { type: "enterArcade", activityId: "arcade" },
        {
          type: "startRound",
          round: "recruitment",
          config: recruitmentRound(RECRUITMENT_ITEMS.slice(0, 2)),
        },
        { type: "beginPlay" },
      ];
      for (const event of setup) assert.ok(runtime.apply(event, T0).applied, event.type);
      const client: Client = {
        socket: { readyState: 1, send() {} } as unknown as Client["socket"],
        role: "participant", pid: "p1", lastSeen: T0, seq: 0, rtt: [], pingSentAt: null,
      };
      runtime.clients.add(client);

      assert.equal(runtime.armedItemAt, T0 + 20_000, "item 1 owns its twenty seconds");
      assert.equal(runtime.armedFloorAt, null, "and no second clock is racing it");

      assert.ok(runtime.apply({ type: "nextItem" }, T0 + 20_300).applied);
      assert.equal(runtime.armedItemAt, T0 + 40_300, "item 2 gets its own twenty");
      assert.equal(runtime.armedFloorAt, null);
      // The round's clock on the wire agrees with the clock that will end it,
      // so the countdown does not run out while the item is still open.
      assert.equal(runtime.state.arcade?.endsAt, T0 + 40_300);

      // 19.9 s into item 2: inside the item, and it counts. 10 for correct,
      // +5 for being first in the room.
      const out = runtime.submitAnswer(client, 1, "Terraform", T0 + 40_200);
      assert.ok(out.applied, out.rejection?.code);
      assert.equal(runtime.state.arcade?.banked["p1"], R_CORRECT + R_FIRST_BONUS);
      runtime.clearArcadeTimers();
    },
  );

  test(
    "a tap received after the Floor has closed is refused even when the round ends inside a lock's grace",
    () => {
      const registry = new SessionRegistry();
      const initial = newSession({ sid: "s2", title: "t", joinCode: "RAFT", activities: ACTIVITIES });
      const { runtime } = registry.add(initial, T0);
      for (const event of toPlay) assert.ok(runtime.apply(event, T0).applied, event.type);
      // The last lock lands 100 ms before the Floor closes at +75 000.
      assert.ok(runtime.apply({ type: "setLight", light: "apply", until: T0 + 80_000 }, T0 + 74_900).applied);
      const client: Client = {
        socket: { readyState: 1, send() {} } as unknown as Client["socket"],
        role: "participant", pid: "p1", lastSeen: T0, seq: 0, rtt: [], pingSentAt: null,
      };
      runtime.clients.add(client);
      // Received 100 ms *after* the Floor closed, from an unmeasured socket.
      const out = runtime.tap(client, 0, T0 + 75_100);
      runtime.clearArcadeTimers();
      assert.deepEqual(out, { applied: false, rejection: { code: "floor_locked", message: "The Floor is closed." } });
    },
  );

  test(
    "the pink strike stays on a drained player between the end of the round and its reveal",
    () => {
      const s = replay(planning(), [
        { event: { type: "setLight", light: "apply", until: T0 + 5_000 }, at: T0 + 3_000 },
        { event: { type: "tap", pid: "p1", at: T0 + 3_500 }, at: T0 + 3_500 },
        { event: { type: "endRound" }, at: T0 + 75_000 },
      ]);
      const arcade = s.arcade;
      assert.ok(arcade);
      assert.equal(arcade.standing["p1"], "drained");
      assert.equal(arcadeGrid(s, arcade).find((c) => c.pid === "p1")?.struck, true);
    },
  );
});
