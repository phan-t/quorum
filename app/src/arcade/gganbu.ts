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
 * bank flags dates".
 *
 * ## A certainty is a bug in this round, not a safe choice
 *
 * The first version of this bank was three default ports and three release
 * years, chosen because ports are the safest facts in the repository. They
 * are — and that was the defect. Gganbu is the only round where two people
 * stake something against each other by name, and a prompt both halves of a
 * pair know cold produces two minimum wagers and a tie. Six of those is a
 * betting round that cannot generate a bet. Safety was measured against the
 * wrong risk: being wrong is one failure mode, and being certain is the other.
 *
 * So every threshold below is set a plausible distance from its answer, close
 * enough that a well-informed player thinks *I believe it is X, and I am not
 * sure enough to put five tokens on it*, and far enough that no patch release
 * or disputed month can move the answer across the line. Why each one is a
 * real bet, and not merely an obscure fact:
 *
 * - **Parallelism, over/under 15.** Most people carry "about ten" and some
 *   carry "about twenty". The threshold sits between the two beliefs.
 * - **Max lease TTL, over/under 720.** 720 hours is thirty days, which is the
 *   round number everybody's mental model rounds to. The default is 768.
 * - **KV value size, over/under 1024.** The two candidate answers a room will
 *   offer are half a megabyte and a megabyte, and the threshold is exactly the
 *   second one.
 * - **Nomad's first release, over/under 2016.** Nomad reads as a reaction to
 *   the orchestrator era and is routinely placed a year or two later than it
 *   belongs.
 * - **Terraform 0.12, over/under 2018.** The HCL rewrite was public and
 *   heavily written about in 2018 and shipped in 2019, so the honest answer
 *   depends on which event you filed as the release.
 * - **Vault 1.0, over/under 2017.** Vault was in serious production use for
 *   years before it called itself 1.0, so an earlier year feels right; the
 *   1.0 announcement itself describes "nearly four years" of work behind it.
 *
 * ## Verified
 *
 * Every answer below was checked against a published source on **26 September
 * 2026**, the way the trivia bank records its ✅ Verified questions. Folklore
 * was not accepted for any of them:
 *
 * - Terraform's `-parallelism` default is **10** — `terraform apply` command
 *   reference, developer.hashicorp.com: "Limit the number of concurrent
 *   operations as Terraform walks the graph. Defaults to 10."
 * - Vault's `default_lease_ttl` and `max_lease_ttl` both default to
 *   **"768h"** — Vault server configuration reference,
 *   developer.hashicorp.com.
 * - Consul's `kv_max_value_size` default is **512KB** — Consul agent
 *   configuration reference: the limit "defaults to raft's suggested max size
 *   (512KB)".
 * - Nomad was released publicly in **September 2015** — the announcement post
 *   "HashiCorp Nomad" on the HashiCorp blog, dated 28 September 2015; 0.1.0
 *   is the earliest build published at releases.hashicorp.com/nomad.
 * - Terraform **0.12** shipped **22 May 2019** — "Announcing Terraform 0.12",
 *   HashiCorp blog, dated 22 May 2019. Beta 1 is dated 28 February 2019, so
 *   the release and every beta are on the same side of the 2018 line; the only
 *   thing on the other side is the preview post, dated 28 June 2018, which is
 *   what makes this prompt a bet rather than a recall.
 * - Vault reached **1.0** in **December 2018** — "HashiCorp Vault 1.0",
 *   HashiCorp blog, dated 4 December 2018, which is also where "the fourth
 *   HashiCorp project to reach 1.0" and the batch token description come from.
 *
 * Kubernetes reached 1.0 on **21 July 2015**, two months before Nomad's
 * announcement — the Google Cloud Platform blog's "Kubernetes V1 Released",
 * dated July 2015. Checked because the note says it out loud.
 *
 * Batch tokens: Vault's tokens concept page — batch tokens are "encrypted
 * blobs that carry enough information for them to be used for Vault actions,
 * but they require no storage on disk to track them".
 *
 * ## Which three carry the flag, and why those three
 *
 * The flag is not a confidence rating. It marks the prompts whose answer can
 * *move*, or can be recorded differently somewhere else, so that whoever
 * reuses this bank for a later event knows which three to check again. SPEC
 * fixes the count at three, so the three go to the answers most likely to have
 * moved by then:
 *
 * - **Vault's default max lease TTL** and **Consul's maximum KV value size**
 *   are defaults in a configuration file. A release can change either, and
 *   neither would announce itself.
 * - **Terraform 0.12's year** is the one date here that different sources
 *   record differently, because the preview, the betas and the release are
 *   not the same event.
 *
 * That is a change from the port-era bank, where the flags were on all three
 * dates. It is the same rule applied to different content: Nomad's 2015 and
 * Vault's 2018 are settled history that every source agrees on, and both
 * thresholds sit a clear year or more away, so neither can move. A default in
 * a config file can. If the count were not fixed at three, all six would
 * carry it; given three, they belong on the values.
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
 * Six prompts, in order.
 *
 * The order does one job: the first prompt has to tell the room that this is
 * not a recall round. Parallelism does that — almost nobody is sure between
 * ten and twenty — so the very first wager is a judgement and the room learns
 * in fifteen seconds that reading the threshold is the game.
 *
 * The flagged prompts are no longer grouped at the end. In the port-era bank
 * they were, because the bank had two halves: three prompts nobody could get
 * wrong, then three that mattered. There are no halves now, and where the
 * dates sit is not information a player should be able to use.
 *
 * The answers do not alternate, and are not meant to: a player who works out
 * that the round alternates has stopped reading the prompts.
 */
export const GGANBU_PROMPTS: readonly OverUnderItem[] = [
  {
    cue: "Terraform's default parallelism",
    threshold: "15",
    answer: "under",
    note: "10 — concurrent resource operations while Terraform walks the graph, not concurrent modules or providers. The same default applies to plan, apply and destroy.",
    verify: false,
  },
  {
    // ⚠️ VERIFY — a default in a config file, which a release can change.
    cue: "Vault's default max lease TTL, in hours",
    threshold: "720",
    answer: "over",
    note: "768 — thirty-two days, not the thirty that 720 hours would be. The default lease TTL is the same 768 hours, so out of the box the default and the ceiling are one number.",
    verify: true,
  },
  {
    // ⚠️ VERIFY — a default in a config file, and one tied to Raft's own
    // suggested maximum rather than to a number Consul picked.
    cue: "Consul's maximum KV value size, in kilobytes",
    threshold: "1024",
    answer: "under",
    note: "512 — the size Raft itself suggests as a maximum, which is where Consul's default comes from. Every KV write goes through the Raft log, so a large value is a cost the whole cluster pays, not just the node that took the write.",
    verify: true,
  },
  {
    cue: "Nomad's first public release",
    threshold: "2016",
    answer: "under",
    note: "2015 — announced in September, three years after HashiCorp itself and about two months after Kubernetes reached 1.0. It reads as a later product than it is.",
    verify: false,
  },
  {
    // ⚠️ VERIFY — a date, and the one in this bank most likely to be recorded
    // differently elsewhere: the preview, the betas and the release are three
    // separate events.
    cue: "The year Terraform 0.12 shipped",
    threshold: "2018",
    answer: "over",
    note: "2019 — May. The preview came out in June of the year before, which is why this one splits a room: the HCL rewrite was public for eleven months before it was a release.",
    verify: true,
  },
  {
    cue: "The year Vault reached 1.0",
    threshold: "2017",
    answer: "over",
    note: "2018 — December, and the fourth HashiCorp project to reach 1.0. It introduced batch tokens: encrypted blobs carrying everything needed to act, and needing no write to storage to exist.",
    verify: false,
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
