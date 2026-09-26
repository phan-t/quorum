/**
 * Round 2 — Unseal. The launch content: seventeen tins, one word in each.
 *
 * As with recruitment.ts and glass-bridge.ts this is a literal, imported like
 * any other module — no I/O, no clock, no randomness. The host's per-round
 * settings arrive on `startRound`; what is in this file is only the default.
 *
 * ## Where the content comes from
 *
 * The activity library was a private repo, folded into this one in September
 * 2026 and then deleted. Its history survives as a git bundle in `private/`,
 * which is where to look if one of these strings is ever in doubt.
 *
 * SPEC.md: "6 existing Scrambled items + 4". The Scrambled board from the
 * activity library is the start of this list, and the umbrella tier — which
 * the existing board has nothing in — is SPEC's addition: "The umbrella tier
 * needs three long words added; they are in the round file with the same
 * `cue / ans / note` shape."
 *
 * There are seventeen here rather than ten, and the extra seven are not
 * content SPEC asked for; they are the fix for the hole described under "Why
 * the circle tier has six" below. SPEC's ten is a floor on how much content
 * the round needs, not a cap: it counts the words that had to be *written*,
 * and it was written when nobody had yet worked out that a tier is solved for
 * everybody in it by one person on the call.
 *
 * That gives the four tiers SPEC.md describes:
 *
 * | Tin | Letters | Words |
 * | --- | --- | --- |
 * | ○ circle | 4–5 | RAFT, VAULT, SERF, DRIFT, TAINT, STATE |
 * | △ triangle | 6 | MODULE, GOSSIP, CANARY |
 * | ☆ star | 8 | SENTINEL, PROVIDER, BOUNDARY, WAYPOINT, SNAPSHOT |
 * | ☂ umbrella | 11+ | DECLARATIVE, IDEMPOTENCY, ORCHESTRATION |
 *
 * A tier with more than one word hands them out by arcade player number, so
 * two people sitting together are not unscrambling the same word.
 *
 * ## Why the circle tier has six
 *
 * The existing content gives it one, and for a while it shipped that way: one
 * word for the whole tier, so the first person to say RAFT out loud on the
 * call solved it for everybody who picked the circle. VAULT was added, which
 * made it a game for two people in ten and a formality for the rest — the
 * circle is the tier the cautious pick, and in a room of thirty it is the tier
 * most of the room is in.
 *
 * So the circle now has six and the star has five, and the fix is arithmetic
 * rather than clever: with six circles, a tier that a dozen people picked is
 * a dozen people on four or five different words, and one shout on the call
 * gives away a sixth of it. The thin tiers are triangle and umbrella, which is
 * the right way round — they are the tiers picked by people who came to play.
 *
 * ## Why UNSEAL is not in the triangle tier any more
 *
 * It was, and it is the one item from the existing board that had to go. The
 * round card behind the player reads *Game 2 — Unseal* for the twenty seconds
 * before the Floor opens, so a triangle tin holding UNSEAL is twenty points
 * printed on the wall: no scramble to solve, nothing learned, and an
 * unfairness aimed at whichever two or three players the tier dealt it to.
 * CANARY is a six-letter replacement with a Nomad note on it.
 *
 * `T F A R` stays, and the two decisions are not in conflict. RAFT's cue is
 * its own word backwards, which is a thing a player has to *notice* — a
 * four-letter word has twenty-four arrangements and one of them was always
 * going to look like something — and it is worth ten. UNSEAL was worth twenty
 * and needed noticing by nobody.
 *
 * ## The additions
 *
 * Eleven words with almost nothing to verify in them: each is a term of art or
 * a product name rather than a fact, so there is no date, no branding and no
 * acquisition to be wrong about. The claims that are made are small ones —
 * SERF is the library Consul and Nomad build membership on, and
 * `terraform taint` really is deprecated in favour of `-replace` — and none
 * names a version, because a version number is a second fact to be wrong about
 * in front of a room that would know.
 *
 * A product name is not as safe as it looks, though, and two of these proved
 * it. WAYPOINT's note said "one command from source to a running URL", which
 * describes Waypoint Community Edition — archived in January 2024 and no longer
 * actively maintained — rather than the HCP Waypoint that ships, whose shape is
 * templates, add-ons and actions. BOUNDARY's said "no key changes hands", which
 * is true of credential injection and not of credential brokering, where a
 * credential is fetched and handed to the user. Both read perfectly well aloud,
 * which is the problem with both: a word whose note is a sentence about a
 * product needs the same check as a word whose note is a date.
 *
 * The notes are the same shape as the existing six: one line, what the thing
 * is, with the joke where the word has one.
 */

import type { ArcadeRoundConfig, UnsealItem } from "../engine/types.ts";

/** SPEC.md: "Sixty seconds." */
export const UNSEAL_SECONDS = 60;

/**
 * Seventeen tins.
 *
 * The five surviving Scrambled items are first, in their original order, with
 * their shape read off the length of the word: RAFT is four letters and
 * therefore a circle, MODULE and GOSSIP are six and therefore triangles,
 * SENTINEL and PROVIDER are eight and therefore stars. SPEC.md assigns exactly
 * these, by name, so the mapping is not an inference. CANARY stands where
 * UNSEAL stood. Then the three umbrellas, then VAULT, then the four circles
 * and three stars the tiers were widened with.
 *
 * Additions go on the end because the tins are dealt by index: appending
 * leaves every other tin where it was, so a host who read the board yesterday
 * is still right about it today.
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
    cue: "R Y A C N A",
    answer: "CANARY",
    note: "Nomad's update block places one new allocation and waits for you to promote it.",
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
  {
    shape: "circle",
    cue: "L T V A U",
    answer: "VAULT",
    note: "Secrets, PKI and dynamic credentials. The round you are playing is named after starting one.",
  },
  {
    shape: "circle",
    cue: "R F S E",
    answer: "SERF",
    note: "The membership and failure-detection library Consul and Nomad are both built on.",
  },
  {
    shape: "circle",
    cue: "F T D I R",
    answer: "DRIFT",
    note: "What the infrastructure did while nobody was applying.",
  },
  {
    shape: "circle",
    cue: "N T I T A",
    answer: "TAINT",
    note: "terraform taint marked a resource for replacement. Deprecated in favour of -replace, and still the first thing anybody reaches for.",
  },
  {
    shape: "circle",
    cue: "T E S A T",
    answer: "STATE",
    note: "The record of what Terraform built. Game 1's lock is held on one of these.",
  },
  {
    shape: "star",
    cue: "R D Y N A O U B",
    answer: "BOUNDARY",
    note: "A target, a host set, and a session with a beginning and an end. With credentials injected, the user never sees the one that let them in.",
  },
  {
    shape: "star",
    cue: "P T W O N Y I A",
    answer: "WAYPOINT",
    note: "Templates, add-ons and actions a platform team publishes. The part of the platform the developer is meant to see.",
  },
  {
    shape: "star",
    cue: "H T S O P A N S",
    answer: "SNAPSHOT",
    note: "consul snapshot save. The thing you find out you were not taking.",
  },
];

/** The round as the host gets it before they change anything. */
export function unsealRound(
  items: readonly UnsealItem[] = UNSEAL_ITEMS,
  seconds: number = UNSEAL_SECONDS,
): ArcadeRoundConfig {
  return { kind: "unseal", items, seconds };
}
