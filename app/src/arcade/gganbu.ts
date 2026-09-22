/**
 * Round 4 — Gganbu. The launch content: six Over/Under prompts.
 *
 * As with the other round files this is a literal, imported like any other
 * module — no I/O, no clock, no randomness. The host's per-round settings
 * arrive on `startRound`; what is in this file is only the default. The pairs
 * are drawn from a seed the boundary supplies, for the same reason Tug of
 * Raft's sides are.
 *
 * ## The content, and how much of it to trust
 *
 * This is played in front of a room of solutions architects who will know
 * most of these cold, so a prompt whose answer is wrong is not a small
 * failure: it is the one failure the round has. SPEC.md asks for six items
 * "each carrying a note", with "three flagged VERIFY exactly as the trivia
 * bank flags dates", and the flags here are not decoration — they are the
 * three whose answer turns on a date rather than on a port number.
 *
 * **The three unflagged prompts are default port numbers.** They are the
 * safest facts in this repository: they are in every getting-started guide,
 * they have not moved in a decade, and if one were wrong the room would
 * correct it in four seconds and nobody would be misled for longer than that.
 *
 * **The three flagged prompts are release years**, which is exactly the class
 * of fact the trivia bank flags: a date, and the thing people remember if it
 * is said confidently and wrongly.
 *
 * All three were checked against sources on **23 September 2026**, the same
 * way the trivia bank records its ✅ Verified questions, and all three hold:
 *
 * - Vagrant 0.1.0 — 7 March 2010. Under 2011.
 * - Terraform 0.1 — 28 July 2014. Under 2015.
 * - Terraform 1.0 GA — 8 June 2021, announced at HashiConf Europe. Over 2020.
 *
 * The flag stays on them anyway, because that is what it is for: it marks the
 * prompts whose answer can move, or can turn out to have been recorded
 * differently somewhere else, and it tells whoever reuses this bank for a
 * later event which three to check again. Each threshold is a clear year away
 * from its answer, so none of them is close enough to flip on a disputed
 * month.
 *
 * ## Why over/under, and not a date question
 *
 * The wager is the round. An over/under has no partial credit and no argument
 * about what counts, which is what lets somebody stake five tokens on it
 * fifteen seconds after reading it.
 */

import type { ArcadeRoundConfig, OverUnderItem } from "../engine/types.ts";
import {
  GGANBU_PROMPT_SECONDS,
  GGANBU_START_TOKENS,
} from "../engine/arcade.ts";

/**
 * Six prompts, in order: the three ports first, the three years after.
 *
 * Deliberate. The ports are the ones an SA knows without thinking, so the
 * first two prompts are where the room learns that the button does what it
 * says and that wagering one token is a waste of a prompt. The years are where
 * the tokens actually move.
 *
 * The answers do not alternate, and are not meant to: a player who works out
 * that the round alternates has stopped reading the prompts.
 */
export const GGANBU_PROMPTS: readonly OverUnderItem[] = [
  {
    cue: "Vault's default API port",
    threshold: "8000",
    answer: "over",
    note: "8200. That is the API listener; 8201 is cluster traffic between nodes.",
    verify: false,
  },
  {
    cue: "Consul's default HTTP API port",
    threshold: "9000",
    answer: "under",
    note: "8500. DNS is on 8600, and the LAN and WAN gossip pools are on 8301 and 8302.",
    verify: false,
  },
  {
    cue: "Nomad's default HTTP port",
    threshold: "4000",
    answer: "over",
    note: "4646. RPC is 4647 and Serf is 4648 — the three sit together, one apart.",
    verify: false,
  },
  {
    // ⚠️ VERIFY — SPEC.md's own example of a prompt, and a date.
    cue: "Vagrant's first public release",
    threshold: "2011",
    answer: "under",
    note: "2010 — version 0.1.0 in March, two years before HashiCorp itself. Vagrant is the product the company grew out of.",
    verify: true,
  },
  {
    // ⚠️ VERIFY — a date.
    cue: "Terraform's first release",
    threshold: "2015",
    answer: "under",
    note: "2014 — Terraform 0.1 in July, about two years after the company was founded. It supported AWS and DigitalOcean.",
    verify: true,
  },
  {
    // ⚠️ VERIFY — a date, and the one most likely to be misremembered, because
    // Terraform was in production use for years before it called itself 1.0.
    cue: "The year Terraform reached 1.0",
    threshold: "2020",
    answer: "over",
    note: "2021 — June, at HashiConf Europe. Seven years after 0.1, and the release that promised the state file would stay compatible.",
    verify: true,
  },
];

/** The round as the host gets it before they change anything. */
export function gganbuRound(
  seed: number,
  prompts: readonly OverUnderItem[] = GGANBU_PROMPTS,
  secondsPerPrompt: number = GGANBU_PROMPT_SECONDS,
  startTokens: number = GGANBU_START_TOKENS,
): ArcadeRoundConfig {
  return { kind: "gganbu", prompts, secondsPerPrompt, startTokens, seed };
}
