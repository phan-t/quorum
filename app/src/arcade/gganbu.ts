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
 * bank flags dates" — see "Why all six carry the flag" below for why the
 * count grew when the dates left.
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
 * - **check_update_interval, over/under 1 minute.** The name sounds like a
 *   health-check interval, which would be seconds; it is the interval on the
 *   *output* of an unchanged check, which is minutes.
 * - **Nomad's default task CPU, over/under 250 MHz.** A room that has written
 *   a job file remembers setting `cpu`, not what happens when you do not.
 * - **KV value size, over/under 1024.** The two candidate answers a room will
 *   offer are half a megabyte and a megabyte, and the threshold is exactly the
 *   second one.
 * - **max_request_duration, over/under 60.** A minute is the number people
 *   reach for on any request deadline. It is ninety seconds.
 *
 * ## Verified
 *
 * Every answer below was checked against a published source on **27 September
 * 2026**, the way the trivia bank records its ✅ Verified questions. Folklore
 * was not accepted for any of them:
 *
 * - Terraform's `-parallelism` default is **10** — `terraform apply` command
 *   reference, developer.hashicorp.com: "Limit the number of concurrent
 *   operations as Terraform walks the graph. Defaults to 10."
 * - Vault's `default_lease_ttl` and `max_lease_ttl` both default to
 *   **"768h"** — Vault server configuration reference.
 * - Consul's `check_update_interval` defaults to **"5m"** — Consul agent
 *   configuration reference: the interval "controls how often check output
 *   from checks in a steady state is synchronized with the server", and a
 *   check that changes state syncs immediately regardless.
 * - Nomad's `resources` block defaults to **`cpu = 100`** MHz and
 *   **`memory = 300`** MB — Nomad job specification, `resources`.
 * - Consul's `kv_max_value_size` default is **512KB** — Consul agent
 *   configuration reference: the limit "defaults to raft's suggested max size
 *   (512KB)".
 * - Vault's listener `max_request_duration` defaults to **"90s"** — Vault TCP
 *   listener configuration reference.
 *
 * ## Why all six carry the flag
 *
 * The flag is not a confidence rating. It marks a prompt whose answer can
 * *move*, or be recorded differently somewhere else, so that whoever reuses
 * this bank for a later event knows what to check again.
 *
 * Every prompt here is now a default in a configuration file, and a release
 * can change any of them without announcing it. So the honest count is six.
 *
 * It was three, when half the bank was release dates: Nomad's 2015 and
 * Vault 1.0's 2018 are settled history that every source agrees on, sitting a
 * clear year from their thresholds, so nothing about them could move and a
 * flag on them would have meant nothing. Those dates are gone — they were the
 * weaker half of the bank, because a year is either known or guessed and
 * neither produces the hesitation a wager needs — and with them goes the
 * reason the count was three.
 *
 * Flagging three of six now would mean choosing which three to stop checking,
 * and there is no such three. A flag spent on a chosen few is worth less than
 * no flag at all, because it tells the next reader the unflagged ones are
 * settled.
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
 * The rest is spread so that no two prompts about the same product sit next
 * to each other. A pair who have just watched a Vault prompt settle should
 * not be able to warm up for the next one.
 *
 * The answers do not alternate, and are not meant to: a player who works out
 * that the round alternates has stopped reading the prompts.
 */
export const GGANBU_PROMPTS: readonly OverUnderItem[] = [
  {
    // ⚠️ VERIFY — every prompt in this bank is a default a release can change.
    // See "Which prompts carry the flag" above: the honest answer is all of
    // them, and the flag is worth nothing if it is spent on a chosen few.
    cue: "Terraform's default parallelism",
    threshold: "15",
    answer: "under",
    note: "10. Concurrent resource operations while Terraform walks the graph, not concurrent modules or providers. Raising it moves the bottleneck to the provider's rate limit.",
    verify: true,
  },
  {
    // ⚠️ VERIFY
    cue: "Vault's default max lease TTL, in hours",
    threshold: "720",
    answer: "over",
    note: "768. Thirty-two days, not the thirty that 720 hours would be. The default lease TTL is the same number, so out of the box the default and the ceiling match.",
    verify: true,
  },
  {
    // ⚠️ VERIFY
    cue: "Consul's default check_update_interval, in minutes",
    threshold: "1",
    answer: "over",
    note: "5. How long Consul holds the output of a check that has not changed state, so a thousand checks writing a fresh timestamp do not become a thousand writes. A check that does change state syncs at once.",
    verify: true,
  },
  {
    // ⚠️ VERIFY
    cue: "Nomad's default task CPU, in MHz",
    threshold: "250",
    answer: "under",
    note: "100, beside a default of 300 MB of memory. Deliberately small, because Nomad bin-packs: a task that never says what it needs is sized like a sidecar, and finds out under load.",
    verify: true,
  },
  {
    // ⚠️ VERIFY — and this one is Raft's number rather than Consul's, so it
    // can move for a reason that has nothing to do with Consul.
    cue: "Consul's maximum KV value size, in kilobytes",
    threshold: "1024",
    answer: "under",
    note: "512, which is the maximum Raft itself suggests and where Consul's default comes from. Every KV write goes through the Raft log, so a large value costs the whole cluster and not just the node that took it.",
    verify: true,
  },
  {
    // ⚠️ VERIFY
    cue: "Vault's default max_request_duration, in seconds",
    threshold: "60",
    answer: "over",
    note: "90, set per listener. It is a deadline and not a timeout: Vault cancels the request's context, so the work stops rather than finishing unwatched. A minute is the number most people reach for.",
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
