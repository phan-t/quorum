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
 * a real **and** a fake for each of six products: twelve items. The library's
 * six are three reals and three fakes spread across six *different* products
 * (Vault, Consul and Boundary real; Terraform, Packer and Nomad fake), so
 * "three additions" would only reach nine, and three of the six steps would
 * have to pair two products against each other — which is the round giving the
 * answer away, because *Vault Transit Secrets Engine* next to *Packer
 * Provisioner Mesh* is a question about which product you have heard of.
 *
 * The reading taken here keeps **within a product**, which is the constraint
 * with a reason behind it, and writes twelve items rather than nine.
 *
 * ## The tell, which was worse than the arithmetic
 *
 * The first board took every real pane out of the documentation — Transit
 * Secrets Engine, Gossip Pool, Host Catalog, Workspaces, Builders, Task
 * Drivers — and gave every fake a product-shaped name: Lease Broker Mesh,
 * Anti-Entropy Beacon, Identity Bastion, Drift Guard, Provisioner Mesh,
 * Sentinel Scheduler. That is one rule, and an engineer has it by step two:
 * pick the plain one. Six for six, nobody falls, and a Glass Bridge nobody
 * falls off is a corridor. It also throws away the thing SPEC.md calls "the
 * whole point of the game in the show" — wave 2 pays for its nine seconds a
 * step with the knowledge of which panes broke under wave 1, and a board where
 * no pane breaks has nothing to sell it.
 *
 * So four of the six pairs are now the other way round: an obscure-but-real
 * feature against a plausible invention. Cubbyhole, Autopilot, ephemeral
 * resources and sysbatch are all real and all sound invented; Lockbox Engine,
 * Copilot, Transient Resources and Sysperiodic are all invented and all sound
 * like the feature next door.
 *
 * **Four and not six.** Boundary Host Catalog against Identity Bastion, and
 * Packer Builders against Provisioner Mesh, stay exactly as they were, because
 * a board where the strange-sounding pane is always the real one is the same
 * tell read backwards. Four pairs one way and two the other leaves no rule to
 * find, only six questions about six products.
 *
 * Two of the activity library's original six therefore survive verbatim: Host
 * Catalog and Provisioner Mesh, which are also the two whose notes are the
 * best writing in the round. SPEC's illustrative pair does not survive, and
 * that is deliberate — Vault is the product this room knows best, so it is the
 * product where the plain-pane rule was most certain to work. The example was
 * SPEC showing the shape of a pair, not naming a pane the board owes it.
 *
 * ## The reals
 *
 * Every real here is a documented HashiCorp feature, checked against
 * developer.hashicorp.com rather than recalled. This is played in front of a
 * room of solutions architects, so a "real" that turns out not to be real is
 * the failure that costs the round its credibility — the ⚠️ VERIFY discipline
 * the trivia bank uses for dates applies to every one of them, and it applies
 * harder now that the reals are the obscure side of four pairs.
 *
 * No note names a version number, which is the same discipline one step on: a
 * note that says which release added a feature is a second fact to be wrong
 * about, read out to the room as confidently as the first, and the round does
 * not need it to be funny or to teach anything.
 *
 * Nor does a note say more about the feature than its page does, which is a
 * separate failure and the one a real pane invites: Autopilot's note said that
 * new servers are "introduced one at a time", which sounds like the thing a
 * feature called Autopilot would do and is not on the page. What the page
 * documents is a stabilization period — a new server has to stay healthy for
 * it before it becomes a voter — so that is what the note says now. A real
 * pane is read out to the room as the fact, and an embellishment on the true
 * pane is worth as little as a wrong pane.
 *
 * ## The fakes
 *
 * Each invented name is built out of vocabulary that *is* real for that
 * product — leases, provisioners, autopilots, ephemerality, periodic jobs — so
 * the pane is tempting rather than silly, and each note names the real thing
 * it was built from. That is the existing Real-or-Fake voice: "Packer has
 * provisioners. It does not have a mesh."
 *
 * "Mesh" now appears once rather than twice. Two fakes ending in the same
 * invented noun is a smaller tell than the plain-pane rule, but it is the same
 * kind of tell, and it is free to not have.
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
 * The order is a difficulty curve and it is aimed at wave 1, who walk this
 * blind at twelve seconds a step with nothing to go on. **Step 1 is the
 * easiest pair on the board** — Packer, where the fake is a mesh — because a
 * bridge that takes its first wave out at step 1 has told the room nothing
 * and has given waves 2 and 3 nothing to watch. The inverted pairs start at
 * step 2 and the hardest is last, so wave 1 comes apart in the middle of the
 * bridge, in front of everybody, which is what the other two waves are
 * watching for. Boundary sits at step 3 as a breather between two of them.
 *
 * `real` runs 1, 0, 1, 1, 0, 0 — irregular, because a player who spots that
 * the answer is always the left pane has not played the round, they have read
 * the source. The order within a pair is content, not chance: the engine has
 * no randomness, and a host who wants a different arrangement passes different
 * steps to `startRound`.
 */
export const GLASS_BRIDGE_STEPS: readonly GlassStep[] = [
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
    product: "Vault",
    panes: [
      {
        label: "Vault Cubbyhole",
        note: "Storage scoped to one token. No other token can read it, and it goes when the token goes.",
      },
      {
        label: "Vault Lockbox Engine",
        note: "Vault has a cubbyhole and it has a KV store. It has never had a lockbox.",
      },
    ],
    real: 0,
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
    product: "Consul",
    panes: [
      {
        label: "Consul Copilot",
        note: "Autopilot is real and does what it sounds like. Nothing in Consul is called Copilot.",
      },
      {
        label: "Consul Autopilot",
        note: "Dead servers cleaned out of the Raft peer set, and a new server that has not stayed healthy for its stabilization time is not a voter yet: consul operator autopilot.",
      },
    ],
    real: 1,
  },
  {
    product: "Terraform",
    panes: [
      {
        label: "Terraform Ephemeral Resources",
        note: "An ephemeral block fetches a value for the length of the run and writes it to neither the state nor the plan file.",
      },
      {
        label: "Terraform Transient Resources",
        note: "Ephemeral resources are real. This is what they are not called.",
      },
    ],
    real: 0,
  },
  {
    product: "Nomad",
    panes: [
      {
        label: "Nomad Sysbatch Jobs",
        note: 'type = "sysbatch" runs a job to completion once on every client that matches its constraints.',
      },
      {
        label: "Nomad Sysperiodic Jobs",
        note: "A sysbatch job can be periodic — that is what the periodic block is for. There is no sysperiodic.",
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
