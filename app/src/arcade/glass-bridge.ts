/**
 * Round 5 — The Glass Bridge. The launch content: six steps, two panes each,
 * one real HashiCorp feature and one invented one.
 *
 * As with recruitment.ts this is a literal, imported like any other module —
 * no I/O, no clock, no randomness. The host's per-round settings arrive on
 * `startRound`; what is in this file is only the default.
 *
 * ## Where the twelve items come from
 *
 * SPEC.md asks for "the existing three real and three fake Real-or-Fake items,
 * **re-paired within a product** and made up to six pairs with three
 * additions", and its own example of a pair is *Vault Transit Secrets Engine*
 * against the invented *Vault Lease Broker Mesh* — both Vault.
 *
 * Those two sentences cannot both be satisfied. Pairing within a product needs
 * a real **and** a fake for each of six products: twelve items. The existing
 * six are three reals and three fakes spread across six *different* products
 * (Vault, Consul and Boundary real; Terraform, Packer and Nomad fake), so
 * "three additions" would only reach nine, and three of the six steps would
 * have to pair two products against each other — which is the round giving the
 * answer away, because *Vault Transit Secrets Engine* next to *Packer
 * Provisioner Mesh* is a question about which product you have heard of.
 *
 * The reading taken here keeps **within a product**, which is the constraint
 * with a reason behind it, and writes **six** additions rather than three:
 * a fake for each of the three existing reals, and a real for each of the
 * three existing fakes. All six existing items survive verbatim, which is what
 * "reuse the existing content" was for.
 *
 * ## The reals
 *
 * Every real here is a documented HashiCorp feature and the notes say what it
 * does. This is played in front of a room of solutions architects, so a
 * "real" that turns out not to be real is the failure that costs the round its
 * credibility — the ⚠️ VERIFY discipline the trivia bank uses for dates
 * applies to every one of them, and the report that shipped this round lists
 * which ones the author was least certain of.
 *
 * ## The fakes
 *
 * Each invented name is built out of vocabulary that *is* real for that
 * product — leases, anti-entropy, bastions, drift, provisioners, Sentinel —
 * so the pane is tempting rather than silly, and each note names the real
 * thing it was built from. That is the existing Real-or-Fake voice: "Packer
 * has provisioners. It does not have a mesh."
 *
 * The reveal note is stored per pane rather than per step because the big
 * screen reads out both at the reveal: the fake's note is the joke, and the
 * real one's is the thing somebody learns.
 */

import type {
  ArcadeRoundConfig,
  GlassStep,
  WaveSeconds,
} from "../engine/types.ts";

/**
 * SPEC.md: "wave 1 blind at 12 s per step, wave 2 at 9 s … wave 3 at 6 s".
 *
 * Six steps at 12 + 9 + 6 seconds is 162 seconds of Floor, which with the
 * 20 s round card and the 20 s reveal is the 3.5 minutes the round table
 * budgets. The three numbers corroborate the six steps.
 */
export const GLASS_BRIDGE_WAVE_SECONDS: WaveSeconds = [12, 9, 6];

/**
 * Six steps, in bridge order.
 *
 * `real` alternates irregularly (0, 1, 1, 0, 1, 0) because a player who spots
 * that the left pane is always the real one has not played the round, they
 * have read the source. The order within a pair is content, not chance: the
 * engine has no randomness, and a host who wants a different arrangement
 * passes different steps to `startRound`.
 */
export const GLASS_BRIDGE_STEPS: readonly GlassStep[] = [
  {
    product: "Vault",
    panes: [
      {
        label: "Vault Transit Secrets Engine",
        note: "Encryption as a service — apps send plaintext, Vault returns ciphertext, keys never leave.",
      },
      {
        label: "Vault Lease Broker Mesh",
        note: "Vault issues leases and renews and revokes them. There is no broker, and there is no mesh.",
      },
    ],
    real: 0,
  },
  {
    product: "Consul",
    panes: [
      {
        label: "Consul Anti-Entropy Beacon",
        note: "Consul really does run anti-entropy between an agent and the catalog. It does not run a beacon.",
      },
      {
        label: "Consul Gossip Pool",
        note: "Consul agents use LAN and WAN gossip pools for membership and failure detection.",
      },
    ],
    real: 1,
  },
  {
    product: "Boundary",
    panes: [
      {
        label: "Boundary Identity Bastion",
        note: "Boundary is what you deploy instead of a bastion host. It does not ship one.",
      },
      {
        label: "Boundary Host Catalog",
        note: "A host catalog is how Boundary groups the hosts behind a target.",
      },
    ],
    real: 1,
  },
  {
    product: "Terraform",
    panes: [
      {
        label: "Terraform Workspaces",
        note: "One configuration, more than one named state: terraform workspace new staging.",
      },
      {
        label: "Terraform Drift Guard",
        note: "Drift detection is real; this product name is not.",
      },
    ],
    real: 0,
  },
  {
    product: "Packer",
    panes: [
      {
        label: "Packer Provisioner Mesh",
        note: "Packer has provisioners. It does not have a mesh.",
      },
      {
        label: "Packer Builders",
        note: "A builder is the plugin that produces the image for one platform — amazon-ebs, qemu, docker.",
      },
    ],
    real: 1,
  },
  {
    product: "Nomad",
    panes: [
      {
        label: "Nomad Task Drivers",
        note: "Task drivers — docker, exec, java, qemu — are how Nomad actually runs a task.",
      },
      {
        label: "Nomad Sentinel Scheduler",
        note: "Nomad has a scheduler and Sentinel is real — but not this.",
      },
    ],
    real: 0,
  },
];

/** The round as the host gets it before they change anything. */
export function glassBridgeRound(
  steps: readonly GlassStep[] = GLASS_BRIDGE_STEPS,
  waveSeconds: WaveSeconds = GLASS_BRIDGE_WAVE_SECONDS,
): ArcadeRoundConfig {
  return { kind: "glass_bridge", steps, waveSeconds };
}
