# Quorum — build plan

How to get from [SPEC.md](SPEC.md) to something running, in an order where
every phase ends with a thing you can show someone.

The sequencing principle: **deploy an almost-empty service first.** The
pipeline, the WebSocket, the host control loop and the state machine are the
risky parts, and they are risky together. Games are content on top of a proven
spine — build the spine first and the rest is additive.

---

## Phase 0 — Foundations

Nothing deployed. Everything after this depends on it.

- Repo scaffolding under `services/quorum/app`: TypeScript, one process,
  server + three clients built by Vite
- The **game engine as a pure reducer** — `(state, event) => state`, no I/O.
  This is the single most important structural decision in the build: it is what
  makes restart-mid-game recoverable and what makes the rules testable without
  a browser
- Unit tests for scoring: normalisation, Bench Credit, Spot Awards, ties
- `docker compose` for DynamoDB Local; `npm run dev` with hot reload
- **The bot harness** (`npm run bots -- 30`). Build this in Phase 0, not later.
  Every phase after this is validated by thirty fake participants, and you will
  not get thirty humans to test a round for you.

**Done when:** `npm test` proves the scoring rules, and thirty bots can join a
session in memory.

## Phase 1 — Walking skeleton

The first deploy. Content is deliberately trivial.

- Join with nickname + join code → lobby
- Host console: start session, switch segment, end session
- **The holding page** — the simplest possible segment, and the one the TTX
  needs anyway
- Participant page follows the host with no navigation
- WebSocket reconnect with state resync
- Terraform: one workspace, `quorum` (VPC, ALB, ECS, DynamoDB, ACM, Route53,
  ECR), HCP Terraform remote execution
- GitHub Actions: PR and push checks only — typecheck, test, container build,
  `terraform fmt`/`validate`

**Done when:** you can open the URL on your phone, join, and watch the page
change because someone clicked a button on a laptop.

> **Amended during Phase 1.** This phase was planned around OIDC federation, a
> separate bootstrap workspace, and a merge to `main` deploying itself. None of
> that survived contact with the account, and the original acceptance criterion
> ("a merge to `main` puts a new version there without you touching a console")
> is not achievable here — it was dropped deliberately, not left unfinished:
>
> - **No OIDC, no CI/CD.** The AWS account denies all non-human credentials —
>   `CreateOpenIDConnectProvider` and `CreateUser` are both explicit denies, and
>   the account has zero IAM users and zero identity providers. There is no way
>   for GitHub Actions to obtain AWS credentials, so there is no deploy job.
>   Deploys are `make deploy`, run by a human holding 8-hour credentials, with
>   HCP Terraform executing the apply remotely against `tfawscreds`.
> - **One workspace, not three.** `quorum-bootstrap` and the per-environment
>   split were consolidated into a single `quorum` workspace; the existing ECR
>   repository was imported rather than recreated.
>
> Both changes are load-bearing for anyone reading this later: a stale
> directory list left over from the three-workspace layout kept CI red for
> several days while every other job passed.

This is the phase that de-risks the project. Everything hard about the
infrastructure is either working or not by the end of it.

## Phase 2 — Scoreboard

Now it is useful even with no games in it.

- Manual score entry for the TTX and anything off-platform
- Normalisation to Huddle Points, live
- Seal and reveal as a real state across all three surfaces
- Spot Awards with a required reason
- Bench Credit
- Big screen surface
- CSV export at the end of a session

**Done when:** you could run the 25 September huddle on it with Kahoot and the
existing arcade, typing scores in by hand — and it would be better than the
spreadsheet.

That is a genuine milestone, not a notional one. If the project stalled here it
would still have been worth building.

> **Status.** Everything on the list above is built, tested and merged. The
> acceptance criterion is *not* met yet, and the distinction matters: it is a
> claim about running a real event, and the service has never been in front of
> anyone. Two things stand between here and true:
>
> - **A deploy.** Code on `main` is not code on the URL.
> - **A rehearsal with real people.** See the sequencing note below — the
>   failure modes that matter do not appear in a bot run.
>
> A single-handed smoke test against the live service is the smaller first
> step and is listed under Phase 5. Deferred on purpose on 19 Sep 2026, not
> forgotten.
>
> The 25 September huddle is deliberately *not* the first outing. It runs on
> Kahoot and the existing arcade artifacts; Quorum targets the huddle after it.

## Phase 3 — Trivia

- CSV import in the existing Kahoot shape, plus the optional columns
- Question flow: open, answer, lock, reveal, leaderboard
- Speed-weighted scoring with the latency correction
- Sudden-death mode for a tiebreak
- The 20-question launch set loads unmodified

**Done when:** thirty bots play a full 20-question round and the scores match a
hand-computed expectation.

> **Built 19 Sep 2026, with two specified things deliberately not built.**
> Both are small, both are real, and both are invisible until the moment they
> matter:
>
> - **Re-ask.** ARCHITECTURE promises that after a restart mid-question the
>   console flags it with "n answers may be missing" and offers a re-ask
>   button. The restart does the sane half — the question resumes on its
>   recovered deadline, or closes if that has passed — but nothing tells the
>   host answers were lost. Needs a `reaskQuestion` event and durable state
>   marking the gap.
> - **The per-activity podium toggle.** SPEC says a host can turn off even the
>   activity top five, "default on", for a last activity that is completely
>   blind. There is no state for it, so the podium always shows.
>
> Also deliberately divergent from ARCHITECTURE as written: there is no
> `trivia.*` message family. Trivia rides in `RenderState`, projected per role.
> ARCHITECTURE has been corrected to match, including that its sketch sent the
> answer distribution to every phone, which DESIGN forbids.
>
> **Sudden death cannot serve as SCORING.md's tiebreak as built.** It is a
> mode on a question, so it consumes one from the loaded set, and after the
> last question `nextQuestion` refuses with `no_more_questions`. A host who
> wants to settle a tie has to carry a spare question in the CSV. Either
> SCORING.md should say that out loud or sudden death needs to work off a
> question that is not part of the scored set.
>
> One engine/mock divergence left standing: the engine does not auto-close a
> sudden-death question on the first correct tap — the host closes it, and the
> big screen shows the winner's name as soon as it is known — while the mock
> closes it automatically. The engine's behaviour is the one to keep; the mock
> should follow it.

## Phase 4 — The arcade

Iterative, and the order matters. Each round is a day or two, not a week.

1. **Recruitment** (Emoji Decode) — no elimination, proves round scaffolding
   and hands out player numbers
2. **The Lounge** — build the drain → back-a-player → score loop *before* the
   second game. It is the mechanic the whole format rests on, and it is the one
   most likely to need redesign after you see it with real people
3. **Plan / Apply** — the first drain round, and the timing-sensitive one
4. **The Glass Bridge** — reuses Real-or-Fake content
5. **Unseal**, **Tug of Raft**, **Gganbu** — in whatever order appeals

**Done when:** five rounds run end to end and nobody who gets drained in round
one is bored in round four. That second clause is the actual acceptance test
and it needs humans, not bots.

## Phase 5 — Operations

- A runbook: pre-session checklist, what to do when the host's browser dies,
  how to restore a session
- Load test at 2× expected headcount
- The deploy-freeze check wired into the release job
- A rehearsal with real people who are not you

**Deferred here from Phase 2 (19 Sep 2026): the first live smoke test.** Every
surface so far has only ever run against the mock. Against the deployed
service, by hand: create a session, join it from a phone, type scores into the
console, seal, reveal, and pull `export.csv`. It is deliberately not a bot run
— the point is the things bots do not do. Do this *before* the rehearsal, not
as part of it; a rehearsal that spends its first ten minutes on a bug nobody
had looked for is a wasted room of people.

**Done when:** someone who is not you can host a session from the runbook.

---

## Sequencing notes

**Phase 1 is the risk.** If credentials, the ALB idle timeout or the Fargate
task fight you, that is where it happens — and credentials did, which is why
there is no CI/CD. Budget accordingly and do not
start Phase 3 until a deploy is boring.

**Phase 2 is the escape hatch.** It is the first point where stopping leaves
something valuable behind. Worth reaching before the enthusiasm curve dips.

**Phase 4 is where the fun is and where scope grows.** Six rounds are
specified; five is a standard run. Build three, play them with real people,
then decide whether the other three are wanted.

**Do not target a live event with the first outing.** Run a throwaway session
with a handful of colleagues first. The failure modes that matter — someone's
phone sleeping, a flaky hotel wifi, two people picking the same nickname — do
not show up in a bot run.

---

## Where the content ends up

The activity library holds two kinds of thing, and they end up in different
places. Worth deciding once rather than at each phase.

**Content moves here. Guides do not.**

| | Today | After |
| --- | --- | --- |
| Trivia questions | `question-bank.md` + a Kahoot CSV | Ships in this repo as the launch trivia set, loaded into `CONTENT#` at session create |
| Arcade items | A `ROUNDS` array inside a host-driven HTML page | Ships here as structured round content |
| Facilitator guides | Activity READMEs | **Stay in the library.** They are about running a session with humans, which is true whatever software is underneath |
| The existing HTML boards and Kahoot import | Activity folders | **Stay, as the fallback.** Retire them only after this service has run a real session without incident |

The forcing reason is that this repo is public and the library is private: a
public build cannot pull launch content out of a private repo without awkward
credentials in CI. Content that ships in the container has to live here.

**Move it at the phase that consumes it** — trivia content in Phase 3, arcade
content in Phase 4 — not in one upfront migration. Moving content nothing
consumes yet only creates two copies to keep in step.

**One thing to scrub on the way.** The question bank carries a "Round S"
template for a round about a person being celebrated, including a note naming a
specific colleague and their leaving date. The template is worth having; the
name is not, in a public repo. Generalise it as it moves.

---

## What has to exist before Phase 1 can deploy

These are inputs from a human with the right access, not code. See the
questions in the handover conversation.

All of these were settled during Phase 1. Kept as the record of what an
equivalent deployment needs, with what it resolved to here.

| | Needed for | Resolved to |
| --- | --- | --- |
| AWS account ID and region | Every Terraform resource | `ap-southeast-2`; the account id lives in gitignored `terraform.tfvars`, not here |
| A hostname, and a Route53 zone or delegated subdomain | ACM certificate, ALB listener | `quorum.tphan.sbx.hashidemos.io` — note `tphan.aws.hashidemos.io` has no NS delegation and will hang ACM validation |
| HCP Terraform org name, and a project | The workspace | org from `TF_CLOUD_ORGANIZATION`; one workspace, `quorum` |
| Dynamic provider credentials permitted in that org | The no-stored-keys design | the `AWS Authentication` varset (`tfawscreds`), remote execution |
| Spend approval, ~$40/month | Running it at all | parked at `desired_count = 0` between events |
| Tagging and cost-centre conventions | Whatever the account requires | — |

**There is no bootstrap apply and no OIDC provider.** Both were planned and
neither is possible: the account denies non-human credentials outright. A
deploy is a human running `make deploy` with short-lived credentials, and HCP
Terraform performs the apply. Nothing in GitHub Actions can reach AWS, by
design and by the account's policy.
