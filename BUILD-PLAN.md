# Quorum build plan

This plan takes [SPEC.md](SPEC.md) to a running service in an order where
every phase ends with something you can show someone.

The plan **deploys an almost-empty service first.** The pipeline, the
WebSocket, the host control loop, and the state machine are the risky parts,
and they fail together. The games are content that sits on top of them, so
once those parts work, each game adds to the service without changing them.

---

## Phase 0: Foundations

Nothing is deployed in this phase, and every later phase depends on it.

- Repo scaffolding under `app/`: TypeScript, one process, server plus three
  clients. *In the end it was built without Vite. The server runs its
  TypeScript directly and `tsc` alone emits the clients, so there is no bundler
  anywhere.*
- The **game engine as a pure reducer**, `(state, event) => state`, with no I/O.
  This is the most important structural decision in the build, because it lets
  a session recover from a restart mid-game and lets the rules be tested
  without a browser
- Unit tests for scoring: normalisation and ties
- `docker compose` for DynamoDB Local, and `npm run dev` with hot reload
- **The bot harness** (`npm run bots -- 30`). Build it in Phase 0. Every
  later phase is validated by thirty fake participants, because you will not
  get thirty people to test a round for you.

**Done when:** `npm test` proves the scoring rules, and thirty bots can join a
session in memory.

## Phase 1: Walking skeleton

This is the first deploy, and its content is deliberately trivial.

- Join with nickname + join code → lobby
- Host console: start session, switch segment, end session
- **The holding page**, which is the simplest possible segment and one the TTX
  needs anyway
- Participant page follows the host with no navigation
- WebSocket reconnect with state resync
- Terraform: one workspace, `quorum` (VPC, ALB, ECS, DynamoDB, ACM, Route53,
  ECR), HCP Terraform remote execution
- GitHub Actions: PR and push checks only, which are typecheck, test, container
  build, and `terraform fmt`/`validate`

**Done when:** you can open the URL on your phone, join, and watch the page
change because someone clicked a button on a laptop.

> **Amended during Phase 1.** This phase was planned around OIDC federation, a
> separate bootstrap workspace, and a merge to `main` deploying itself. The
> account ruled all three out, and the original acceptance criterion ("a merge
> to `main` puts a new version there without you touching a console") cannot be
> met here. It was dropped deliberately and is not unfinished work:
>
> - **No OIDC and no CI/CD.** The AWS account denies all non-human credentials.
>   `CreateOpenIDConnectProvider` and `CreateUser` are both explicit denies, and
>   the account has zero IAM users and zero identity providers. GitHub Actions
>   cannot obtain AWS credentials, so there is no deploy job. A human runs
>   `make deploy` with 8-hour credentials, and HCP Terraform executes the apply
>   remotely against `tfawscreds`.
> - **One workspace instead of three.** `quorum-bootstrap` and the
>   per-environment split were consolidated into a single `quorum` workspace,
>   and the existing ECR repository was imported instead of recreated.
>
> Anyone reading this later needs to know about both changes. A stale
> directory list left over from the three-workspace layout kept CI red for
> several days while every other job passed.

This phase carries most of the project's risk. By the end of it, everything
hard about the infrastructure has either been made to work or shown not to.

## Phase 2: Scoreboard

After this phase, the service is useful even with no games in it.

- Manual score entry for the TTX and anything off-platform
- Normalisation to Huddle Points, live
- Seal and reveal as a real state across all three surfaces
- Desktop surface
- CSV export at the end of a session

**Done when:** you could run the 25 September huddle on it with Kahoot and the
existing arcade, typing scores in by hand, and it would be better than the
spreadsheet.

If the project had stalled here, it would still have been worth building.

> **Status: met.** Everything on the list above is built, tested, and merged,
> and the acceptance criterion is no longer a claim about the future. The
> service has been deployed and has run a full session with a live room.
>
> This note used to say the opposite, at length: that the criterion was not met
> because the service had never been in front of anyone, and that it still
> needed a deploy and a rehearsal with real people. Both have happened. The
> note stays because the distinction it drew still applies to every phase
> below: *built, tested, and merged* never meant *it worked in front of thirty
> people*.

## Phase 3: Trivia

- JSON question-file import, with the optional keys
- Question flow: open, answer, lock, reveal, leaderboard
- Speed-weighted scoring with the latency correction
- Sudden-death mode for a tiebreak
- The 20-question launch set loads as it ships

**Done when:** thirty bots play a full 20-question round and the scores match a
hand-computed expectation.

> **Built 19 Sep 2026, with two specified features deliberately not built.**
> Both are small, and neither shows until a host needs it:
>
> - **Re-ask.** ARCHITECTURE promises that after a restart mid-question the
>   console flags it with "n answers may be missing" and offers a re-ask
>   button. The restart resumes the question on its recovered deadline, or
>   closes it if that deadline has passed, but nothing tells the host that
>   answers were lost. This needs a `reaskQuestion` event and durable state
>   that marks the gap.
> - **The per-activity podium toggle.** SPEC says a host can turn off even the
>   activity top five, "default on", for a last activity that is completely
>   blind. There is no state for it, so the podium always shows.
>
> The build also deliberately differs from ARCHITECTURE as it was written: there
> is no `trivia.*` message family. Trivia travels in `RenderState`, projected
> per role. ARCHITECTURE has been corrected to match, including the fact that
> its sketch sent the answer distribution to every phone, which DESIGN forbids.
>
> **As built, sudden death cannot serve as SCORING.md's tiebreak.** It is a
> mode on a question, so it consumes one from the loaded set, and after the
> last question `nextQuestion` refuses with `no_more_questions`. A host who
> wants to settle a tie has to carry a spare question in the set. Either
> SCORING.md should say so explicitly, or sudden death needs to work off a
> question that is not part of the scored set.
>
> **Closed 24 Sep 2026 by the JSON question file**, whose `tiebreak` key marks
> a question as a tiebreaker: outside the twenty, in the pool sudden death
> draws on. The CSV had no way to express that without inventing a column.
>
> One difference between the engine and the mock remains. The engine does not
> close a sudden-death question automatically on the first correct tap. The
> host closes it, and the Desktop shows the winner's name as soon as it is
> known, while the mock closes it automatically. The engine's behaviour is the
> one to keep, and the mock should follow it.

## Phase 4: The arcade

Build the rounds one at a time, in this order. Each round takes a day or two.

1. **Recruitment** (Emoji Decode), which has no elimination, tests the round
   scaffolding, and hands out player numbers
2. **The Lounge**. Build the loop of being drained, backing a player, and
   scoring *before* the second game. The whole format depends on it, and it is
   the mechanic most likely to need redesign once real people use it
3. **Plan / Apply**, the first round that drains players and the one most
   sensitive to timing
4. **The Glass Bridge**, which reuses Real-or-Fake content *(built 20 Sep 2026)*
5. **Unseal**, **Tug of Raft**, and **Gganbu**, in any order

**Done when:** five rounds run end to end and nobody who gets drained in round
one is bored in round four. The second clause is the real acceptance test, and
only people can check it, because bots do not get bored.

> **Round 0, the Lounge, and Round 1 built 20 Sep 2026.** Verification found
> three bugs that the test suite could not have caught and that were obvious in
> a browser, so a passing suite says little about whether a page renders:
>
> - **Every surface rendered a blank page.** A client file imported the
>   arcade's content from outside `src/client/`, `tsc` emitted it beside
>   `dist/client`, and both servers served only `/client/*`. The module graph
>   404'd, the page stayed empty, and nothing threw. The fix serves the whole
>   emitted tree.
> - **The Desktop's sixty-player grid was never visible.** `.s-light` set
>   `display: flex`, which silently overrides the UA's `[hidden]` rule, so a
>   full-bleed light sat on top of the grid for every segment. Eleven other
>   elements each had a hand-written `[hidden]` rule, and the twelfth was
>   missed. The fix applies once, globally.
> - **The participant could not make the losing move.** The tap button was
>   `disabled` during APPLY, so nobody could be drained by tapping. The only players who could lose were
>   those whose taps arrived late over a bad connection, which is the exact
>   opposite of what the 250 ms grace is for.
>
> **Still open, each with a failing `todo` test naming the file:** the engine
> forgives an APPLY tap that lands after the light returns to PLAN, a round
> ending within 250 ms of a lock accepts taps received after the close,
> Recruitment arms two competing timers, and the drained strike flickers off
> between `endRound` and `revealRound`.
>
> **Hardened 20 Sep 2026**, after the user confirmed that participants join on
> **laptops instead of phones**. SPEC and DESIGN have been corrected, and the
> participant surface can now be operated by keyboard throughout (Space or Enter
> taps, keys 1 to 4 answer, with the hints shown only where there is a real
> pointer). Auto-repeat is deliberately rejected, because holding down the space
> bar would beat any hand on a trackpad, so a tap takes one physical press,
> exactly as a click does. All four todo tests are fixed, every announcer line
> is rendered, the per-item clock is sent to clients and shown, and the
> broadcast load for sixty players fell from ~22,200 frames and ~113 MB a round
> to ~2,600 and ~27 MB.
>
> **Still open, and each one needs a decision:**
>
> - **The participant surface is still a 480 px centred column on a laptop.**
>   It reads as a deliberate play column and makes the arcade's tap button
>   ~590 px tall, which suits a race. But it is a phone layout used on a laptop,
>   and a participant surface designed for laptops is a separate piece of design.
> - **`HOUSE.arcadeEnd` has no reliable trigger.** There is no command that ends
>   the arcade, because the host just moves the segment on. So the service
>   infers that the games have concluded when the session is outside the arcade
>   with a round already played, and the line does not appear at all if the
>   host seals the standings first.
> - **The Desktop has no Recruitment item clock.** `itemEndsAt` now reaches
>   every role, so the room's own twenty-second countdown is available. Putting
>   one on the screen is a design choice.
> - **The scripted mock desynchronises above `speed=1` for the arcade.** The
>   director's schedule scales but the item and light timers do not, so
>   Plan/Apply starts on top of a still-running Recruitment. This only affects
>   demo pacing, but run arcade work at `speed=1`.
>
> **The Glass Bridge (round 5) followed on 20 Sep**, which makes three rounds
> built. That is the point where this plan says to stop and play them with real
> people before deciding whether the other three are wanted. Its leak is closed
> by the engine's structure: the engine never records which pane a player
> chose, because a pane that *held* identifies the real one as well as a pane
> that broke, and `broken` is published only when a step closes.
>
> One thing is left untidy. `stepPane` takes no `at`, unlike `tap`, so the
> latency-corrected instant is passed as the event's `now`. It is correct and
> confined to one call site, but decision time decides a 15-point award, so the
> event should carry it explicitly.

## Phase 5: Operations

**Queued 23 Sep 2026: tell participants how scoring works.** Nothing on the
participant surface explains the numbers it shows them. They get a strip
reading `YOU 143 · TRIVIA 80 · ARCADE 63` and, since the per-round rules
landed, one line about how the current round scores, and nothing else.

These things are never explained anywhere a participant can look:

- **Why a trivia score of 14,300 appears as 80.** Each activity is normalised
  so its top scorer takes 100 and everyone else scales against them. This is
  the most confusing part of the scoring model, and the one people will ask
  about at 3:15.
- **That an activity you did not play is a zero**, because nothing credits it
  any more. Bench Credit and Spot Awards were both here and both came out. See
  [SCORING.md](SCORING.md#removed-spot-awards-and-bench-credit).
- **That only the top five are ever shown**, and that this is deliberate so
  nobody's name sits at the bottom of a list in front of their team.

The design assumes the host explains all of it in the 2:00 welcome, and the
event README carries a short version for that purpose. That covers the people
in the room during the welcome, and leaves nothing for anyone who joins late,
stops listening, or later wonders why their number looks small.

The explanation belongs on the **standings screen**, because that is where
somebody looks at their own number and starts to wonder about it. It would take
the same form as the per-round play rules: static text with no state, so it has
nothing that could leak. It was deliberately not built before the 25 September
huddle. Two days out, the console already had a layout rework, a modular
runbook, a resizable tray, and a banner change in progress, and another change
to the participant surface would have added more risk than the missing
explanation cost.


- A runbook: pre-session checklist, what to do when the host's browser dies,
  how to restore a session
- Load test at 2× expected headcount
- The deploy-freeze check wired into the release job
- A rehearsal with real people who are not you

**Deferred here from Phase 2 (19 Sep 2026): the first live smoke test.** Every
surface so far has only ever run against the mock. Against the deployed
service, by hand: create a session, join it from a phone, type scores into the
console, seal, reveal, and pull `export.csv`. It is deliberately not a bot run,
because it is there to check what bots do not do. Do this *before* the
rehearsal, so that the rehearsal's first ten minutes
are not spent on a bug nobody had looked for while a room of people waits.

**Done when:** someone who is not you can host a session from the runbook.

---

## Sequencing notes

**Phase 1 carries the most risk.** If credentials, the ALB idle timeout, or the
Fargate task cause problems, they appear in this phase, and credentials did,
which is why there is no CI/CD. Allow time for it, and do not start Phase 3
until a deploy is routine.

**Phase 2 is the first point where stopping leaves something useful behind.**
Aim to reach it before interest in the project drops.

**Phase 4 holds most of the games and most of the risk of scope growth.** Six
rounds are specified, and a standard run uses five. Build three, play them with
real people, then decide whether the other three are wanted.

**Do not use a live event for the first outing.** Run a throwaway session with
a handful of colleagues first. Failures such as someone's phone sleeping, flaky
hotel wifi, or two people picking the same nickname do not show up in a bot
run.

---

## Where the content ends up

The activity library holds two kinds of material, and they end up in
different places. Deciding that once saves deciding it again at each phase.

**Content moves here, and guides do not.** *Settled 24 Sep 2026: the library
was folded in entirely. The last two rows no longer
hold after that; see the note below the table.*

| | Today | After |
| --- | --- | --- |
| Trivia questions | `question-bank.md` + a Kahoot CSV | Ships in this repo as the example set in `config/event.example/`. *In the end it is staged per event over REST instead of copied into a `CONTENT#` row, which does not exist. See ARCHITECTURE.md.* |
| Arcade items | A `ROUNDS` array inside a host-driven HTML page | Ships here as structured round content |
| Facilitator guides | Activity READMEs | **Stay in the library.** They are about running a session with people, which is the same whatever software is underneath |
| The existing HTML boards and Kahoot import | Activity folders | **Stay, as the fallback.** Retire them only after this service has run a real session without incident |

> **What actually happened.** The library was deleted on 24 Sep 2026, before
> the first real session, so the last two rows are now out
> of date. The guides did not "stay in the library", because there was no
> library left, and what was worth keeping became
> [`docs/running-an-event.md`](docs/running-an-event.md) and
> [`docs/question-bank.md`](docs/question-bank.md). The HTML boards and the
> Kahoot import were deleted with it, so the documented fallback is gone: if
> this service does not start, there is no second way to run the session. The
> host made that choice deliberately.

Content has to move because this repo is public and the library is private. A
public build cannot pull launch content out of a private repo without awkward
credentials in CI, so content that ships in the container has to live here.

**Move content in the phase that uses it**, with trivia content in Phase 3 and
arcade content in Phase 4, instead of in one upfront migration. Moving content
that nothing uses yet only creates two copies to keep in step.

**Remove one thing during the move.** The question bank carries a "Round S"
template for a round about a person being celebrated, including a note naming a
specific colleague and their leaving date. Keep the template, but remove the
name, because this repo is public. Generalise the template as it moves.

---

## What has to exist before Phase 1 can deploy

These are inputs from a human with the right access, and none of them is code.
See the questions in the handover conversation.

All of these were settled during Phase 1. The table stays as a record of what
an equivalent deployment needs and what each input resolved to here.

| | Needed for | Resolved to |
| --- | --- | --- |
| AWS account ID and region | Every Terraform resource | `ap-southeast-2`. The account ID lives in gitignored `terraform.tfvars` and is not recorded here |
| A hostname, and a Route53 zone or delegated subdomain | ACM certificate, ALB listener | `quorum.tphan.sbx.hashidemos.io`. Note that `tphan.aws.hashidemos.io` has no NS delegation and will hang ACM validation |
| HCP Terraform org name, and a project | The workspace | the org from `TF_CLOUD_ORGANIZATION`, and one workspace, `quorum` |
| Dynamic provider credentials permitted in that org | The no-stored-keys design | the `AWS Authentication` varset (`tfawscreds`), with remote execution |
| Spend approval, ~$40/month | Running it at all | parked at `desired_count = 0` between events |
| Tagging and cost-centre conventions | Whatever the account requires | none |

**There is no bootstrap apply and no OIDC provider.** Both were planned, and
the account makes both impossible because it denies non-human credentials
outright. A deploy is a human running `make deploy` with short-lived
credentials, and HCP Terraform performs the apply. By design and by the
account's policy, nothing in GitHub Actions can reach AWS.
