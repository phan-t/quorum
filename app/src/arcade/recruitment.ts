/**
 * Round 0 — Recruitment. The launch content, grown out of the existing Emoji
 * Decode board.
 *
 * BUILD-PLAN.md moves content at the phase that consumes it, so this arrives
 * with the arcade rather than in an upfront migration.
 *
 * No I/O here either — this is a literal, imported like any other module. The
 * host's per-round settings arrive on `startRound`; what is in this file is
 * only the default.
 *
 * ## Seven items, not six
 *
 * SPEC.md says six, and six was the round being decided by elimination. Six
 * emoji pairs for six products, out of a set of six products this room could
 * recite in its sleep, means the last two answers are not decoded at all: they
 * are whichever names have not come up yet. The cue stops being read.
 *
 * Waypoint is the seventh, and it sits fourth rather than last on purpose. Last
 * would leave items 5 and 6 still answerable by elimination and then spring the
 * surprise once, when it is too late to matter. Fourth is where the room finds
 * out that the set is open, which is one item before the back half where
 * elimination would otherwise start.
 *
 * **What the seventh item costs.** Twenty seconds of Floor, which takes the
 * round to 140 s and puts it about 20 s past the 2.5 minutes SPEC's round table
 * budgets for it. It no longer costs any share of the ceiling: the Floor max is
 * `items × (5 + 5)`, so seven items is 70, which is 40% of the three-round order
 * the event actually runs. It was 105 and 50% while the answer paid 10 — the
 * round that paid half of everything being the one round nobody can be knocked
 * out of was what got the answer halved. Recruitment is still the largest single
 * round on the Floor, which is the part of the old argument that survived; what
 * is taken here is that a round decided by elimination is not worth its 2.5
 * minutes
 * either. SPEC.md's round table and its scoring summary both still say six items
 * and 90, and both are now behind this file.
 *
 * ## Two cues that did not produce their word
 *
 * `🏛️🤝` for Consul was a building and a handshake: it decodes to *diplomacy*,
 * or to *treaty*, or to *embassy*, and a player who gets Consul out of it did
 * so by knowing which products were left. It is now `🔎🕸️` — service discovery
 * and a service mesh, which are the two things the product is.
 *
 * `📡🐪` for Nomad had a satellite dish doing nothing that the camel was not
 * already doing better. `🏕️🐪` is a camp and a camel, which is one idea said
 * twice rather than two ideas said once.
 *
 * SPEC.md quotes `📡🐪` as an example of the existing content. It was quoting
 * the board, not specifying it.
 *
 * ## The notes
 *
 * These are read out at the reveal, by the House, in the Front-End Man's
 * voice. They were product blurbs — "Secrets management, dynamic credentials,
 * encryption as a service" is a slide, and it was the only copy in the arcade
 * not in voice. They now say the true thing about the product and then the dry
 * thing about it, which is what every other note in the arcade does.
 *
 * A note is a fact read out to a room that would know, so the true half of each
 * one is checked against the product's current documentation and not against
 * what the product used to be. Two of them failed that on the first pass and
 * are worth naming, because both failures are the kind a fluent sentence hides:
 *
 * - Waypoint's said "build, deploy and release from one command", which is
 *   Waypoint Community Edition — a repository archived in January 2024 and
 *   described by its own README as no longer actively maintained. HCP Waypoint
 *   is the product that ships, and it is a different shape: a platform team
 *   defines templates, add-on definitions and actions, and an application team
 *   helps itself. The seventh item is the one item on the board whose product
 *   the room may not use daily, which is exactly why its note had to be the
 *   most careful rather than the least.
 * - Boundary's said "nothing is handed out, so there is nothing to rotate".
 *   That is credential *injection*, where the worker authenticates to the
 *   target and "the user never sees the credential". Boundary also brokers,
 *   which fetches a credential and returns it to the user, so the note was a
 *   good line about half the product stated as though it were the whole of it.
 *   What survives is the part that is true either way: the address.
 */

import type { ArcadeRoundConfig, EmojiItem } from "../engine/types.ts";

/** SPEC.md: "Six items, 20 seconds each". Seven items is 20 seconds longer. */
export const RECRUITMENT_SECONDS_PER_ITEM = 20;

/**
 * Two emoji, one product, type it.
 *
 * `accept` carries the aliases a person will actually type under a twenty
 * second timer. Only Terraform has one today — SPEC.md names `tf` — and the
 * list is per item rather than global so that a future alias cannot make one
 * item's answer correct for another.
 */
export const RECRUITMENT_ITEMS: readonly EmojiItem[] = [
  {
    cue: "🔐🏦",
    answer: "Vault",
    accept: [],
    note: "Encryption as a service, PKI, and credentials that arrive with an expiry you did not ask for.",
  },
  {
    cue: "🌍🛠️",
    answer: "Terraform",
    accept: ["tf"],
    note: "terra + form. Infrastructure as code, and a plan output nobody reads to the end.",
  },
  {
    cue: "🔎🕸️",
    answer: "Consul",
    accept: [],
    note: "A consul is a diplomat. Service discovery and a service mesh, which turn out to be the same job.",
  },
  {
    cue: "🗺️🚩",
    answer: "Waypoint",
    accept: [],
    note: "Templates and add-ons a platform team publishes so that nobody has to ask them for an environment. Somewhere you pass through, not somewhere you stop.",
  },
  {
    cue: "🎒📦",
    answer: "Packer",
    accept: [],
    note: "One configuration, identical images on every platform. Nobody remembers which configuration built the one in production.",
  },
  {
    cue: "🚧📍",
    answer: "Boundary",
    accept: [],
    note: "Access to hosts you are never given the address of. You ask for the target by name, and the network stays none of your business.",
  },
  {
    cue: "🏕️🐪",
    answer: "Nomad",
    accept: [],
    note: "Containers, binaries, Java, VMs. It does not much care which node they end up on.",
  },
];

/** The round as the host gets it before they change anything. */
export function recruitmentRound(
  items: readonly EmojiItem[] = RECRUITMENT_ITEMS,
  secondsPerItem: number = RECRUITMENT_SECONDS_PER_ITEM,
): ArcadeRoundConfig {
  return { kind: "recruitment", items, secondsPerItem };
}
