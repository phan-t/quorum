/**
 * Round 3 — Tug of Raft. The round's defaults.
 *
 * The only round with no content at all: there is nothing to know, only a beat
 * to hit. That is deliberate and SPEC.md says why — "two elimination rounds
 * back-to-back is a downer, and the arcade needs one round that is pure
 * noise". It sits between Unseal and Gganbu for exactly that reason.
 *
 * What is here is the three numbers SPEC.md tunes and a note about the one
 * thing the host has to supply that the engine cannot: the seed. Sides are
 * "reshuffled by seed before each of three pulls", and the engine has no
 * randomness, so the seed is drawn at the socket boundary and arrives on the
 * config for the first pull and on `nextPull` for the other two — exactly as
 * Plan / Apply's light durations arrive on `setLight`.
 *
 * Three pulls of 25 seconds is 75 seconds of Floor, which with the 20 s round
 * card, the three reshuffles and the 20 s reveal is the three minutes the
 * round table budgets.
 */

import type { ArcadeRoundConfig } from "../engine/types.ts";
import {
  TUG_BPM,
  TUG_PULL_SECONDS,
  TUG_PULLS,
} from "../engine/arcade.ts";

/**
 * The round as the host gets it before they change anything.
 *
 * `seed` has no default. It is the one argument that must come from the
 * caller, because a default would be the same two sides every session — which
 * is not a reshuffle, it is a seating plan.
 */
export function tugOfRaftRound(
  seed: number,
  pulls: number = TUG_PULLS,
  pullSeconds: number = TUG_PULL_SECONDS,
  bpm: number = TUG_BPM,
): ArcadeRoundConfig {
  return { kind: "tug_of_raft", pulls, pullSeconds, bpm, seed };
}
