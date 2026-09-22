/**
 * Round 2 — Unseal. The launch content: nine tins, one word in each.
 *
 * As with recruitment.ts and glass-bridge.ts this is a literal, imported like
 * any other module — no I/O, no clock, no randomness. The host's per-round
 * settings arrive on `startRound`; what is in this file is only the default.
 *
 * ## Where the content comes from
 *
 * SPEC.md: "6 existing Scrambled items + 3". The six are the existing Scrambled
 * board from the team-building repo, **verbatim** — cue, answer and note — and
 * the three additions are the umbrella tier, which the existing board has
 * nothing in: "The umbrella tier needs three long words added; they are in the
 * round file with the same `cue / ans / note` shape."
 *
 * That gives the four tiers SPEC.md describes:
 *
 * | Tin | Letters | Words |
 * | --- | --- | --- |
 * | ○ circle | 4–5 | RAFT |
 * | △ triangle | 6 | MODULE, GOSSIP, UNSEAL |
 * | ☆ star | 8 | SENTINEL, PROVIDER |
 * | ☂ umbrella | 11+ | DECLARATIVE, IDEMPOTENCY, ORCHESTRATION |
 *
 * A tier with more than one word hands them out by arcade player number, so
 * two people sitting together are not unscrambling the same word. The circle
 * tier has exactly one, which is what the existing content gives it, and
 * everybody who picks the circle gets RAFT. That is a small hole — the first
 * person to solve it out loud has solved it for the tier — and it is the price
 * of "reuse the existing items verbatim". A host who wants it closed adds a
 * second four- or five-letter word and passes their own items to
 * `unsealRound`; nothing else has to change.
 *
 * ## One cue is its own word backwards
 *
 * `T F A R` is RAFT reversed. The other five existing cues are not — SENTINEL
 * backwards is LENITNES and the cue is `N E L S I T E N` — so this is a
 * coincidence of a four-letter word rather than a pattern, and there is
 * nothing in the tier for anybody to spot. It is kept as it is, because the
 * brief was to reuse the existing items verbatim, and a test records it so
 * that a future change to the content does not quietly introduce the pattern
 * that this one does not have.
 *
 * ## The additions
 *
 * Three words with nothing to verify in them: each is a term of art rather
 * than a fact, so there is no date, no branding and no acquisition to be wrong
 * about. The notes are the same shape as the existing six — one line, what the
 * thing is, with the joke where the word has one.
 */

import type { ArcadeRoundConfig, UnsealItem } from "../engine/types.ts";

/** SPEC.md: "Sixty seconds." */
export const UNSEAL_SECONDS = 60;

/**
 * Nine tins.
 *
 * The six existing Scrambled items are first, in their original order, with
 * their shape read off the length of the word: RAFT is four letters and
 * therefore a circle, MODULE and GOSSIP and UNSEAL are six and therefore
 * triangles, SENTINEL and PROVIDER are eight and therefore stars. SPEC.md
 * assigns exactly these, by name, so the mapping is not an inference.
 */
export const UNSEAL_ITEMS: readonly UnsealItem[] = [
  {
    shape: "circle",
    cue: "T F A R",
    answer: "RAFT",
    note: "The consensus protocol behind integrated storage in Vault, Consul and Nomad.",
  },
  {
    shape: "star",
    cue: "N E L S I T E N",
    answer: "SENTINEL",
    note: "Policy as code across the enterprise products.",
  },
  {
    shape: "star",
    cue: "R E V I D O R P",
    answer: "PROVIDER",
    note: "The Terraform plugin that talks to an actual API.",
  },
  {
    shape: "triangle",
    cue: "D U E L M O",
    answer: "MODULE",
    note: "Reusable Terraform. The thing everyone means to write and never does.",
  },
  {
    shape: "triangle",
    cue: "S I P G O S",
    answer: "GOSSIP",
    note: "How Consul agents find out who is still alive.",
  },
  {
    shape: "triangle",
    cue: "N E A L U S",
    answer: "UNSEAL",
    note: "What you do to a Vault after it starts. Shamir shares, or auto-unseal via a KMS.",
  },
  {
    shape: "umbrella",
    cue: "V A E T C R A D I L E",
    answer: "DECLARATIVE",
    note: "You describe the end state. Terraform works out the steps to get there.",
  },
  {
    shape: "umbrella",
    cue: "T C E M Y N P I D O E",
    answer: "IDEMPOTENCY",
    note: "Apply it twice, get the same result. The second apply is the one that proves it.",
  },
  {
    shape: "umbrella",
    cue: "T A H R S O C I N T E O R",
    answer: "ORCHESTRATION",
    note: "What Nomad does: place the work, keep it running, move it when a node goes away.",
  },
];

/** The round as the host gets it before they change anything. */
export function unsealRound(
  items: readonly UnsealItem[] = UNSEAL_ITEMS,
  seconds: number = UNSEAL_SECONDS,
): ArcadeRoundConfig {
  return { kind: "unseal", items, seconds };
}
