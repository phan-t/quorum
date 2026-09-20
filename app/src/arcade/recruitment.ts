/**
 * Round 0 — Recruitment. The launch content, moved here from the existing
 * Emoji Decode board.
 *
 * BUILD-PLAN.md moves content at the phase that consumes it, so this arrives
 * with the arcade rather than in an upfront migration. It is the *existing*
 * six items, verbatim, including the notes: reusing them is the point, because
 * they have already been played and they already land.
 *
 * No I/O here either — this is a literal, imported like any other module. The
 * host's per-round settings arrive on `startRound`; what is in this file is
 * only the default.
 */

import type { ArcadeRoundConfig, EmojiItem } from "../engine/types.ts";

/** SPEC.md: "Six items, 20 seconds each". */
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
    note: "Secrets management, dynamic credentials, encryption as a service.",
  },
  {
    cue: "🌍🛠️",
    answer: "Terraform",
    accept: ["tf"],
    note: "terra + form. Infrastructure as code.",
  },
  {
    cue: "🏛️🤝",
    answer: "Consul",
    accept: [],
    note: "A consul is a diplomat — service discovery and service mesh.",
  },
  {
    cue: "🎒📦",
    answer: "Packer",
    accept: [],
    note: "Identical machine images for many platforms from one config.",
  },
  {
    cue: "🚧📍",
    answer: "Boundary",
    accept: [],
    note: "Secure remote access without handing out SSH keys.",
  },
  {
    cue: "📡🐪",
    answer: "Nomad",
    accept: [],
    note: "The wandering scheduler — containers, binaries, Java, VMs.",
  },
];

/** The round as the host gets it before they change anything. */
export function recruitmentRound(
  items: readonly EmojiItem[] = RECRUITMENT_ITEMS,
  secondsPerItem: number = RECRUITMENT_SECONDS_PER_ITEM,
): ArcadeRoundConfig {
  return { kind: "recruitment", items, secondsPerItem };
}
