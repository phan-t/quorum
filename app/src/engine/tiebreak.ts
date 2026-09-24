/**
 * The built-in sudden-death pool.
 *
 * SCORING.md settles a tie with "sudden death — one question, first correct
 * answer wins, no points", and is emphatic that there is never a coin flip.
 * That promise is only keepable if the engine always has a question to ask,
 * and the honest place for a tiebreak question is **outside the scored set**:
 * a sudden death that consumes one of the twenty has changed the game it was
 * supposed to settle.
 *
 * So a loaded set may carry its own tiebreakers — questions the file flags
 * `tiebreak`, lifted out of the twenty by `loadTrivia` — and when it carries
 * none, which is the ordinary case, sudden death draws on these.
 *
 * ## Where this file should live
 *
 * With the rest of the trivia content, in `src/trivia/`, next to the importer
 * that will one day fill the pool from a CSV column. It is here because the
 * change that added it was fenced to `src/engine/` and `src/arcade/`, and a
 * default the engine depends on is worse absent than misfiled. Moving it is a
 * rename and an import.
 *
 * ## The content
 *
 * A tiebreak question is asked to two people who are already tied at the top,
 * in front of a room, with no timer. It wants to be decidable rather than
 * clever: a fact an SA either knows or does not, with no rounding and no "well
 * it depends". These are all definitional or numeric, and none of them turns
 * on a date, a rebrand or an acquisition — the three things the trivia bank's
 * ⚠️ VERIFY flag exists for, and the three things most likely to have moved
 * since this was written.
 *
 * `basePoints: 0` is belt and braces. Sudden death settles to nothing anyway
 * — `settleQuestion` returns early on it — but a question that would score
 * nothing even if it were asked for points cannot be turned into a scored
 * question by a bug somewhere else.
 */

import type { Question } from "./types.ts";

/**
 * Five, which is four more than a session should ever need.
 *
 * Each is spent when it is asked, so a host who runs sudden death twice gets
 * two different questions, and a host who exhausts the pool gets a refusal
 * rather than a question the room has already heard the answer to.
 */
export const DEFAULT_TIEBREAKERS: readonly Question[] = [
  {
    text: "Which consensus protocol backs Vault's, Consul's and Nomad's integrated storage?",
    answers: ["Paxos", "Raft", "Zab", "Gossip"],
    timeLimitSec: 30,
    correct: [1],
    note: "Raft. Gossip is real in Consul, but it is membership and failure detection, not consensus.",
    round: null,
    basePoints: 0,
    tiebreak: true,
  },
  {
    text: "What is Vault's default API port?",
    answers: ["8080", "8200", "8500", "4646"],
    timeLimitSec: 30,
    correct: [1],
    note: "8200 for the API, 8201 for cluster traffic. 8500 is Consul's HTTP API and 4646 is Nomad's.",
    round: null,
    basePoints: 0,
    tiebreak: true,
  },
  {
    text: "In Terraform, what is the plugin that talks to an actual API called?",
    answers: ["A module", "A provider", "A provisioner", "A backend"],
    timeLimitSec: 30,
    correct: [1],
    note: "A provider. A module is reusable configuration, a provisioner runs something on a resource, and a backend is where state lives.",
    round: null,
    basePoints: 0,
    tiebreak: true,
  },
  {
    text: "Which HashiCorp product is policy as code?",
    answers: ["Sentinel", "Boundary", "Waypoint", "Consul"],
    timeLimitSec: 30,
    correct: [0],
    note: "Sentinel, across the enterprise products.",
    round: null,
    basePoints: 0,
    tiebreak: true,
  },
  {
    text: "What does Packer produce?",
    answers: [
      "A container registry",
      "A machine image",
      "A Terraform module",
      "A service mesh",
    ],
    timeLimitSec: 30,
    correct: [1],
    note: "Machine images — identical ones for many platforms from one configuration. A builder is the plugin that makes one.",
    round: null,
    basePoints: 0,
    tiebreak: true,
  },
];
