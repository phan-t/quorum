/**
 * The twenty-question set the acceptance round plays, frozen.
 *
 * It is kept here as the **text of a question file** rather than as a
 * `Question[]`, because the acceptance test is meant to read it the way a
 * session reads one: file → `importTriviaJson` → `loadTrivia`. A fixture of
 * pre-built `Question` objects would skip the one step that turns a
 * `"correct": "C"` into an index, and that step is what the hand transcription
 * in `trivia-round.test.ts` exists to check.
 *
 * **Frozen on purpose. Do not sync this to
 * `config/event.example/trivia-questions.json`.** It began as a snapshot of
 * that file's first twenty questions — the set the acceptance round was
 * written around — and it never needs to be anything else again. The example
 * is the worked example of the format and the thing a host copies, so it is
 * content that moves: questions get added, retimed, reordered, rewritten.
 * Every hand-computed total in `trivia-round.test.ts` is arithmetic on the
 * timers below, so while the round played the example, retiming a question in
 * a content file broke a number somebody had worked out on paper (issue #2).
 * Pinning the round here is what unties that knot; re-syncing this file by
 * hand would tie it again somewhere nobody is looking.
 *
 * The example's `note` prose is deliberately left out. Nothing in the round
 * simulation reads a note, and twenty paragraphs of the example's editorial
 * writing copied under `src/` would be a second home for content that has
 * exactly one.
 *
 * What the *shape* of this set is for — flatten any of it and the acceptance
 * round still passes while testing less:
 *
 *   - **Three different timers, 20 s / 15 s / 10 s.** The speed weighting is a
 *     fraction of each question's own limit, so a set on a single timer cannot
 *     tell a correct weighting from one that divides by a constant. The five
 *     ten-second questions in the middle are where the same five-second tap is
 *     worth visibly less.
 *   - **Twenty questions.** The streak bonus caps at the sixth consecutive
 *     answer, and the round has to walk past the cap, break it, and climb back
 *     — which takes about this many.
 *   - **Four answers each, and no `basePoints` anywhere.** Every question is
 *     worth 1000 before weighting, which is what keeps the expected totals
 *     arithmetic a person can check by hand.
 */
export const ACCEPTANCE_SET_JSON = `{
  "title": "Frozen fixture: the acceptance round",
  "questions": [
    {
      "text": "In what year was HashiCorp founded?",
      "answers": ["2008", "2010", "2012", "2015"],
      "correct": "C",
      "timeLimitSec": 20,
      "round": "History"
    },
    {
      "text": "Which was HashiCorp's first product?",
      "answers": ["Terraform", "Vagrant", "Vault", "Consul"],
      "correct": "B",
      "timeLimitSec": 15,
      "round": "History"
    },
    {
      "text": "Who co-founded HashiCorp with Armon Dadgar?",
      "answers": ["Mitchell Hashimoto", "Solomon Hykes", "Kelsey Hightower", "Adam Jacob"],
      "correct": "A",
      "timeLimitSec": 15,
      "round": "History"
    },
    {
      "text": "What is HashiCorp's published product design philosophy called?",
      "answers": ["The HashiCorp Way", "The Tao of HashiCorp", "The Blue Book", "Infrastructure Manifesto"],
      "correct": "B",
      "timeLimitSec": 15,
      "round": "History"
    },
    {
      "text": "Which HashiCorp product was released first?",
      "answers": ["Vault", "Consul", "Nomad", "Boundary"],
      "correct": "B",
      "timeLimitSec": 20,
      "round": "History"
    },
    {
      "text": "Which two products were announced together at HashiConf Digital 2020?",
      "answers": ["Vault & Consul", "Boundary & Waypoint", "Nomad & Packer", "Terraform & Sentinel"],
      "correct": "B",
      "timeLimitSec": 20,
      "round": "History"
    },
    {
      "text": "Which language are Terraform, Vault, Consul and Nomad written in?",
      "answers": ["Rust", "Go", "Java", "Python"],
      "correct": "B",
      "timeLimitSec": 10,
      "round": "Speed round"
    },
    {
      "text": "What is HashiCorp's policy-as-code framework called?",
      "answers": ["Rego", "Gatekeeper", "Sentinel", "Guardrail"],
      "correct": "C",
      "timeLimitSec": 10,
      "round": "Speed round"
    },
    {
      "text": "In Vagrant, what is a packaged base image called?",
      "answers": ["A crate", "An image", "A box", "A template"],
      "correct": "C",
      "timeLimitSec": 10,
      "round": "Speed round"
    },
    {
      "text": "Which consensus protocol backs integrated storage in Vault, Consul and Nomad?",
      "answers": ["Paxos", "Raft", "Zab", "Two-phase commit"],
      "correct": "B",
      "timeLimitSec": 10,
      "round": "Speed round"
    },
    {
      "text": "What is IBM's long-standing nickname?",
      "answers": ["Big Iron", "Big Blue", "The Blue Giant", "Blue Sky"],
      "correct": "B",
      "timeLimitSec": 10,
      "round": "Speed round"
    },
    {
      "text": "Which port does Vault's HTTP API listen on by default?",
      "answers": ["8080", "8200", "8500", "4646"],
      "correct": "B",
      "timeLimitSec": 20,
      "round": "Deep cuts"
    },
    {
      "text": "By default, Vault splits its unseal key using which scheme?",
      "answers": ["RSA key splitting", "Diffie-Hellman exchange", "Shamir's Secret Sharing", "AES key wrapping"],
      "correct": "C",
      "timeLimitSec": 20,
      "round": "Deep cuts"
    },
    {
      "text": "What best describes a Vault dynamic secret?",
      "answers": ["A secret that rotates yearly", "A credential generated on demand, with a lease", "An encrypted static value", "A secret shared between two apps"],
      "correct": "B",
      "timeLimitSec": 20,
      "round": "Deep cuts"
    },
    {
      "text": "In Nomad, what is the set of tasks that are always placed together on one client called?",
      "answers": ["A pod", "A task group", "A batch", "A cluster"],
      "correct": "B",
      "timeLimitSec": 20,
      "round": "Deep cuts"
    },
    {
      "text": "Which product scans code and systems for leaked secrets?",
      "answers": ["Vault Sentinel", "Vault Radar", "Consul Watch", "Vault Scout"],
      "correct": "B",
      "timeLimitSec": 15,
      "round": "Deep cuts"
    },
    {
      "text": "Which licence did HashiCorp adopt for its products in August 2023?",
      "answers": ["Apache 2.0", "Mozilla Public License 2.0", "Business Source License", "GNU AGPL"],
      "correct": "C",
      "timeLimitSec": 20,
      "round": "Licence and brand"
    },
    {
      "text": "Which open-source fork of Terraform was created in response to that licence change?",
      "answers": ["Terragrunt", "OpenTofu", "Terrakube", "Terraspace"],
      "correct": "B",
      "timeLimitSec": 15,
      "round": "Licence and brand"
    },
    {
      "text": "In April 2024, Terraform Cloud was renamed to what?",
      "answers": ["Terraform Enterprise", "HCP Terraform", "Terraform One", "HashiCorp Terraform"],
      "correct": "B",
      "timeLimitSec": 20,
      "round": "Licence and brand"
    },
    {
      "text": "In which year did IBM complete its acquisition of HashiCorp?",
      "answers": ["2023", "2024", "2025", "2026"],
      "correct": "C",
      "timeLimitSec": 20,
      "round": "IBM"
    }
  ]
}`;
