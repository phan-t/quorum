# Quorum — architecture

The technical design for [SPEC.md](SPEC.md). Decisions are stated with the
reasoning, because the next person to touch this will want to know which ones
were load-bearing.

## Shape

One container. One process. One AWS ECS Fargate task behind an Application
Load Balancer, talking to one DynamoDB table.

```
  phones / laptops / the screen-share tab
              │  HTTPS + WebSocket
              ▼
   Route 53 ── ALB (TLS, idle timeout 3600s)
              │
              ▼
   ECS Fargate service, desired_count = 1
   ┌───────────────────────────────────────┐
   │  node process                         │
   │   ├─ static SPA (participant, host,   │
   │   │   screen — one bundle, three      │
   │   │   entry routes)                   │
   │   ├─ REST (Fastify)                   │
   │   ├─ WebSocket hub (ws)               │
   │   └─ game engine: pure reducers,      │
   │       in-memory session state,        │
   │       server-side timers              │
   └──────────────┬────────────────────────┘
                  │  snapshot + event log
                  ▼
           DynamoDB (on-demand)          SSM Parameter Store (admin key)
```

**Stack:** Node 22, TypeScript end to end. Fastify for HTTP, `ws` for
WebSockets, Preact + Vite for the three clients. One language means the
message protocol is a single `protocol.ts` shared by server and clients, and
the game engine's reducers run unchanged in the test suite and in the browser
(the phone predicts the next state locally, then reconciles with the server).

### Why one stateful process, not serverless

The obvious AWS-native shape is API Gateway WebSockets → Lambda → DynamoDB,
with EventBridge or Step Functions for the timers. It was considered and
rejected:

- **Latency is the product.** Speed-weighted trivia and a red-light game with
  a 250 ms grace window need the answer path to be one process reading a map,
  not a Lambda cold start plus a DynamoDB round trip plus an API Gateway
  post-to-connection. In-memory fan-out to sixty sockets is sub-millisecond.
- **Timers are awkward without a process.** "Close question 7 at 14:32:51.200"
  is a `setTimeout`. In serverless it is a scheduled rule with one-minute
  granularity or a Step Functions wait, and either way the closing logic runs
  somewhere other than where the state is.
- **The scale argument goes the other way.** This runs for two hours a few
  times a year for under a hundred people. Serverless is priced and shaped for
  the opposite problem. A single small Fargate task is a rounding error on the
  bill, and the game engine is drastically simpler when it can assume it is
  the only writer.

The cost is that there is no high availability: one task, and a restart is a
~20-second gap. [Durability and restart](#durability-and-restart) makes that
gap survivable, and the [deploy policy](#deploying-around-a-live-session)
makes it rare. That trade is correct for this product and would be wrong for
a public one.

### The game engine

Every session is a state machine driven by a pure reducer:

```ts
reduce(state: SessionState, event: Event, now: number): { state: SessionState; effects: Effect[] }
```

Events are host commands, participant inputs, timer expiries, and connection
changes. Effects are `broadcast`, `send(to)`, `schedule(at, timerEvent)`,
`persist(snapshot | eventRecord)`. The process is a thin driver that applies
effects. Nothing else touches state.

This is not architectural piety. It buys three things the product needs:
the trivia and arcade rules are unit-tested as functions of `(state, event,
now)` with a fake clock; a session is *replayable* from its event log, which
is how a restart recovers and how a scoring dispute is settled after the
fact; and the phone can run the same reducer on its own inputs for zero-lag
feedback in the tap games, then accept the server's answer as truth.

## Data model

One DynamoDB table, on-demand capacity, single-table design. It is small: a
session with sixty people and twenty questions is on the order of two
thousand items and under a megabyte.

| PK | SK | Item |
| --- | --- | --- |
| `SESSION#<sid>` | `META` | title, state, joinCode, hostTokenHash, screenTokenHash, seal, activities[], tiebreakOrder[], createdAt, ttl |
| `SESSION#<sid>` | `SNAPSHOT` | full in-memory state, JSON, version, seq — rewritten on every transition |
| `SESSION#<sid>` | `EVENT#<seq:010d>` | one game event: type, payload, at, byPid — append-only |
| `SESSION#<sid>` | `PARTICIPANT#<pid>` | nickname, nicknameKey, playerNumber, rejoinTokenHash, joinedAt, kicked |
| `SESSION#<sid>` | `SCORE#<activityId>#<pid>` | raw, status (`played`/`bench`/`unset`), publishedAt |
| `SESSION#<sid>` | `SPOT#<seq>` | pid, activityId, reason, at |
| `SESSION#<sid>` | `CONTENT#<activityId>` | the parsed trivia set or arcade config for this session |
| `CODE#<joinCode>` | `ACTIVE` | sid — exists only while the session is joinable |

GSI: none. Join codes are looked up by their own PK; everything else is a
query on `SESSION#<sid>`. The `SNAPSHOT` item is the fast path for restart;
`EVENT#` items are the audit trail and the slow path when a snapshot is
suspected. `SCORE#` and `SPOT#` are also derivable from events but are written
as their own items so the export is a query, not a replay.

**Retention.** `ttl` on every item is 90 days from session close. Nicknames
are the only personal data and there is no reason to keep them longer than
the next event's planning.

**What is not in the database.** Launch content (the trivia set, the arcade
rounds) ships in the container from the repo files and is copied into
`CONTENT#` when a session is created, so a session is self-contained and a
content change in the repo never rewrites a session in flight.

## WebSocket protocol

JSON text frames. Every message is `{ "t": "<type>", ...fields }`. Server
broadcasts carry `seq`, a per-session monotonic counter; a client that sees a
gap sends `resync` and gets a full `state`. Client messages carry `cid`, a
client-generated id echoed in the `ack` so the phone can reconcile its
prediction.

One socket per client. Role is fixed at `hello`: participant, host, or screen.

### Connection

| Type | Direction | Fields |
| --- | --- | --- |
| `hello` | C→S | `role`, then one of: `{ joinCode, nickname }`, `{ rejoinToken }`, `{ hostToken }`, `{ screenToken }` |
| `welcome` | S→C | `pid`, `rejoinToken` (participant), `sid`, `serverTime` |
| `refused` | S→C | `reason` (`nickname_taken`, `lobby_locked`, `no_such_code`, `kicked`), `message` |
| `state` | S→C | full render state for that role, `seq` |
| `resync` | C→S | — |
| `ping` / `pong` | C↔S | `t0`, `t1` — see [clocks](#clocks-and-fairness) |

### Session and segments

| Type | Direction | Fields |
| --- | --- | --- |
| `segment` | S→all | `kind`, `seq`, segment payload (holding title/line/until; standings top5 or `sealed`; …) |
| `roster` | S→all | `[{ pid, nickname, playerNumber, conn }]` — `conn` is `on`/`away` |
| `seal` | S→all | `state`: `live`/`sealed`/`revealed` |
| `own` | S→C | `total`, `byActivity` — the participant's own points strip, omitted while sealed |
| `toast` | S→all | `kind`: `spot`, `text` |

### Trivia

```jsonc
// S→all
{ "t": "trivia.open", "seq": 412,
  "qid": "q07", "index": 7, "of": 20,
  "question": "Which product does secrets management…?",
  "answers": [{ "i": 1, "text": "Consul" }, { "i": 2, "text": "Boundary" },
              { "i": 3, "text": "Vault" },  { "i": 4, "text": "Nomad" }],
  "opensAt": 1790337171200, "closesAt": 1790337191200, "base": 1000 }

// C→S
{ "t": "trivia.answer", "cid": "a8f2", "qid": "q07", "choice": 3 }

// S→C
{ "t": "ack", "cid": "a8f2", "ok": true }

// S→all, every 500 ms while open, and on every change past 90% answered
{ "t": "trivia.count", "qid": "q07", "answered": 24, "of": 27 }

// S→all
{ "t": "trivia.reveal", "seq": 431, "qid": "q07", "correct": [3],
  "distribution": [2, 1, 21, 3], "note": "Dynamic credentials are the bit people forget.",
  "top5": [{ "pid": "p12", "nickname": "Priya", "points": 6420 }, …] }

// S→C, private, after reveal
{ "t": "trivia.mine", "qid": "q07", "correct": true, "points": 874, "streak": 3 }
```

The `state` for a participant mid-question includes whether they have
answered, so a reload during a question shows "locked in", not the answers.

### Arcade

The arcade is one segment with a round-level state machine inside it. Rounds
share an envelope and differ in `floor`:

```jsonc
// S→all
{ "t": "arcade.round", "seq": 520, "round": "plan_apply", "index": 1, "of": 5,
  "phase": "card" | "floor" | "reveal",
  "startsAt": 1790337300000, "endsAt": 1790337375000,
  "floor": { /* round-specific public state, see below */ },
  "lounge": { "backable": ["p03", "p12", …], "backs": { "p07": "p12", … } } }

// S→C, private
{ "t": "arcade.me", "status": "floor" | "drained" | "away",
  "banked": 15, "roundPoints": 15, "playerNumber": "017",
  "me": { /* round-specific private state */ } }

// C→S — one message type, `kind` is round-specific
{ "t": "arcade.input", "cid": "9c1", "kind": "tap", "n": 7, "at": 1790337312850 }
{ "t": "arcade.input", "cid": "9c2", "kind": "letter", "i": 4 }
{ "t": "arcade.input", "cid": "9c3", "kind": "wager", "side": "over", "n": 3 }
{ "t": "arcade.input", "cid": "9c4", "kind": "pane", "step": 2, "choice": 0 }
{ "t": "arcade.input", "cid": "9c5", "kind": "back", "pid": "p12" }

// S→C
{ "t": "arcade.drained", "reason": "state_lock", "banked": 15,
  "line": "Error: state lock held by another process" }
```

Round-specific `floor` payloads, briefly:

| Round | Public `floor` | Private `me` |
| --- | --- | --- |
| `recruitment` | `item { cue }`, `itemEndsAt`, `solved: [pid]` | `answered`, `correct` |
| `plan_apply` | `light: "plan"/"apply"`, `lightChangedAt`, `nextTurnHintAt`, `target`, `progress: { pid: n }`, `finished: [pid]` | `n`, `checkpoint` |
| `unseal` | `shapes: { pid: "circle" }`, `progress: { pid: k }`, `cracked: [pid]` | `word` (scrambled), `taps`, `hintsUsed` |
| `tug_of_raft` | `pull: 1..3`, `sides: { a: [pid], b: [pid] }`, `rope: -1..1`, `beatEpoch`, `bpm` | `side`, `onBeat`, `misses`, `electing` |
| `gganbu` | `item { prompt, line }`, `itemEndsAt`, `tokens: { pid: n }` | `rival`, `tokens`, `wager` |
| `glass_bridge` | `step`, `wave`, `waveEndsAt`, `broken: [[step, choice]]`, `position: { pid: step }` | `wave`, `step`, `fallen` |

**Tap batching.** `plan_apply` and `tug_of_raft` produce up to ten taps a
second per player. The client batches taps into one `arcade.input` per 100 ms
carrying the count and the client timestamp of the *last* tap; the server
credits the count and judges the light against the timestamp. Sixty players
is then at most 600 messages a second inbound and one 10 Hz `arcade.round`
broadcast outbound, which `ws` handles without noticing.

### Host

```jsonc
// C→S
{ "t": "host.cmd", "cid": "h41", "cmd": "trivia.open", "qid": "q07" }
{ "t": "host.cmd", "cid": "h42", "cmd": "segment", "kind": "holding",
  "title": "Agentic Security TTX", "line": "Abhijeet has the room. Back here at 2:40.", "until": 1790338800000 }
{ "t": "host.cmd", "cid": "h43", "cmd": "seal" }
{ "t": "host.cmd", "cid": "h44", "cmd": "participant.release", "pid": "p07" }
{ "t": "host.cmd", "cid": "h45", "cmd": "spot", "pid": "p12", "activityId": "trivia", "reason": "best recovery of the afternoon" }
```

The full command list mirrors the console's buttons one to one: `segment`,
`lobby.lock`, `trivia.open|close|reveal|next|reask|sudden_death`,
`arcade.start|advance|pause|skip`, `seal|reveal|unseal`, `participant.rename|
release|kick|bench|played`, `spot`, `manual.draft|publish`. Host commands
that would be destructive from the wrong state are rejected with a
`refused` explaining why, not silently ignored — the console shows the
refusal inline.

The host and screen receive everything participants receive plus
`trivia.count`, per-participant answer state, and (host only) correctness
before reveal.

### Clocks and fairness

The server is the clock. Every timed thing is sent as an absolute server
epoch (`closesAt`, `lightChangedAt`, `beatEpoch`), never as "20 seconds from
now", so a client that receives the message late still counts down to the
right instant.

Clients estimate their offset with `ping { t0 } → pong { t0, t1 }` every 10
seconds and take the median of the last five. The countdowns you see are
`closesAt − (Date.now() + offset)`.

For **scoring**, the server never trusts a client timestamp. Response time is
`serverReceivedAt − opensAt − min(rtt ÷ 2, 250 ms)`, where `rtt` is the
server's own recent measurement of that socket. The cap matters: without it a
client on a bad connection could be *advantaged* by a large correction, and
with it the worst case is a quarter-second gift that applies equally to
everyone on a poor link. The red-light grace in `plan_apply` is the same
number for the same reason.

### Keepalive

Protocol-level `ping` every 10 s from the client; WebSocket-level ping every
25 s from the server; a socket with no traffic for 30 s is marked `away` and
its participant shows amber on the console. The ALB idle timeout is raised to
3600 s so a participant who leaves their phone face-down through the holding
page is not silently disconnected.

## REST endpoints

REST is for things that are not real-time: creating sessions, uploading
files, exporting. Everything live goes over the socket.

| Method | Path | Auth | Does |
| --- | --- | --- | --- |
| `POST` | `/api/sessions` | admin key | Creates a session; returns `sid`, `joinCode`, host and screen tokens (shown once) |
| `GET` | `/api/sessions/:sid` | host | Session config and current state summary |
| `PATCH` | `/api/sessions/:sid` | host | Title, activities, tiebreak order, roster paste |
| `POST` | `/api/sessions/:sid/content/trivia` | host | CSV upload; validates and replaces the set; returns line-numbered errors on failure |
| `POST` | `/api/sessions/:sid/content/arcade` | host | Round selection and per-round settings |
| `POST` | `/api/sessions/:sid/manual/:activityId` | host | Draft scores (typed or pasted); returns fuzzy-match proposals for confirmation |
| `GET` | `/api/sessions/:sid/export.csv` | host | The `scoresheet.csv` shape: `Name, <Activity> Raw, <Activity> Pts, …, Spot Awards, TOTAL` |
| `GET` | `/api/sessions/:sid/events.jsonl` | host | The event log, for disputes |
| `GET` | `/j/:code` | — | Serves the participant app with the code prefilled |
| `GET` | `/healthz` | — | `200 { ok, sessionsLive, socketsOpen, version }` — also the deploy-freeze signal |
| `GET` | `/status` | — | Plain-text version of the above, for humans |

**Auth.** Three bearer tokens, all 128-bit random, base32, compared by hash:
the **admin key** (one, from SSM, creates sessions), the **host token** (per
session, in the console URL fragment so it never hits a log), the **screen
token** (per session, view-only). No user accounts, as specified. Participant
identity is the rejoin token issued at `hello`. That is the whole security
model; it is proportionate to a team quiz.

Rate limits: `hello` at 10 per minute per IP; `/api/sessions` at 10 per hour.
Nicknames ≤ 24 characters, stripped of control characters, rendered as text
never HTML.

## Durability and restart

The in-memory state is the truth while the process runs; DynamoDB is what
makes a restart survivable.

**On every reducer transition** the driver writes the new `SNAPSHOT` and the
`EVENT#` that caused it, in that order, asynchronously, with in-order
delivery per session. Participant inputs during a hot round (taps) are
folded into the snapshot rather than logged individually — a tap is not an
audit event, an answer is.

**On start** the process scans for sessions in `lobby` or `running`, loads
each `SNAPSHOT`, replays any `EVENT#` with `seq` greater than the snapshot's
(there should be none or one), and re-arms timers from the state: a
`closesAt` in the past fires immediately, one in the future is scheduled.

**On SIGTERM** (ECS stop, deploy) the process stops accepting `hello`, writes
final snapshots, closes every socket with code `1012 Service Restart`, and
exits. ECS gives it 30 s. Clients treat `1012` as "reconnect with backoff
starting at 1 s", and the rejoin token gets them back as themselves.

**What a mid-game restart looks like from the room.** Roughly twenty seconds
(task stop, new task pull and start, health check) during which phones show
the reconnect banner. Then everyone is back on the same segment. If a trivia
question was open, the snapshot has the answers received before the process
died and lost the ones sent during the gap; the console shows this question
flagged with "n answers may be missing" and a **re-ask** button, and the host
chooses. Nothing about the scoreboard is ever inconsistent, because scores
are derived from persisted events.

**What is not durable.** Socket-level state (who is connected) is rebuilt
from reconnects. Rate-limit counters reset. That is fine.

## AWS topology

| Resource | Choice | Why |
| --- | --- | --- |
| Region | `ap-southeast-2` (Sydney) | Where the host usually is; the latency correction handles the rest of APJ |
| VPC | One, two public subnets across two AZs, **no NAT gateway** | The task needs egress to DynamoDB, ECR, and CloudWatch. A NAT gateway is ~$45/month for the privilege of a private subnet; instead the task sits in a public subnet with a public IP and a security group that accepts traffic **only from the ALB**. Same exposure, a third of the bill |
| ALB | Internet-facing, HTTPS only, HTTP→HTTPS redirect, idle timeout 3600 | WebSockets need a Layer 7 proxy that supports the upgrade; ALB does, NLB would need TLS on the task |
| ACM | Certificate for `quorum.<domain>`, DNS-validated | |
| Route 53 | A/AAAA alias to the ALB | |
| ECS | One cluster, one Fargate service, desired count 1, 0.5 vCPU / 1 GB, `minimumHealthyPercent 0`, `maximumHealthyPercent 100` | Two tasks must never run at once: the second would have an empty memory and the ALB would send it new sockets. The 0/100 setting makes a deploy stop-then-start, which is the honest shape of a single-writer service |
| ECR | One repository, images tagged `sha-<short>`, lifecycle rule keeps the last 20 | |
| DynamoDB | One table, on-demand, TTL enabled, PITR on | On-demand because the traffic is two hours of writes then nothing |
| SSM Parameter Store | `/quorum/<env>/admin_key` SecureString | Injected into the task via the task definition's `secrets` — the container sees an env var, the value never enters Terraform state |
| CloudWatch | Log group, 30-day retention; metrics for open sockets and event-loop lag; one alarm on `RunningTaskCount < 1` | |
| IAM | Task execution role (pull image, read SSM, write logs); task role (DynamoDB on the one table) | Least privilege is cheap here because there are two roles |

Not in the design: CloudFront (the static bundle is 200 KB and served by the
same process), WAF, Auto Scaling, a second region.

### Terraform layout

```
services/quorum/
├── app/                      # the service (later)
├── infra/
│   ├── bootstrap/            # OIDC providers + IAM roles for HCP Terraform and GitHub.
│   │                         # CLI-driven, applied once by a human with their own credentials.
│   ├── modules/
│   │   ├── network/          # VPC, subnets, security groups
│   │   ├── service/          # ECS cluster, task definition, service, ALB, ACM, Route 53
│   │   └── data/             # DynamoDB table, SSM parameters (value ignored after create)
│   └── envs/
│       ├── staging/          # cloud { workspaces { name = "quorum-staging" } }
│       └── prod/             # cloud { workspaces { name = "quorum-prod" } }
├── SPEC.md · ARCHITECTURE.md · DESIGN.md · README.md
```

Each `envs/<env>` is an HCP Terraform workspace with that directory as its
working directory and `modules/**` in its trigger patterns, so a module change
plans in both and a staging-only change plans in staging only.

## Delivery: HCP Terraform and GitHub Actions

Terraform state and runs live in HCP Terraform. Container images are built by
GitHub Actions. Neither holds a long-lived AWS credential.

### Workspaces

| Workspace | Directory | Execution | Apply |
| --- | --- | --- | --- |
| `quorum-bootstrap` | `infra/bootstrap` | CLI-driven | Manual, by a human, rarely |
| `quorum-staging` | `infra/envs/staging` | VCS-driven | Auto-apply |
| `quorum-prod` | `infra/envs/prod` | VCS-driven | Manual confirm |

**VCS-driven for the environments.** Every PR touching `infra/**` gets a
speculative plan posted as a GitHub status check by HCP Terraform itself;
every merge to `main` queues a real run. The alternative, CLI-driven, means
someone applies from a laptop, which means the state of production depends on
whose laptop and which branch. The repo is the source of truth for the
infrastructure and VCS-driven is the setting that makes that literally true.
`terraform plan` from a laptop still works against a VCS workspace as a
speculative plan, which is all a laptop should do.

**Bootstrap is the exception** because it creates the very roles the other
workspaces authenticate with. It is applied once with a human's own AWS
credentials and touched again only to change a trust policy.

### Credentials: dynamic, via OIDC — no stored keys anywhere

This is the point of using HCP Terraform for this and it is worth being
explicit about.

**HCP Terraform → AWS.** The bootstrap workspace creates an IAM OIDC identity
provider for `app.terraform.io` and a role, `quorum-tfc-run`, whose trust
policy allows `sts:AssumeRoleWithWebIdentity` only when the token's
`sub` matches
`organization:<org>:project:quorum:workspace:quorum-*:run_phase:*`. The
`quorum-staging` and `quorum-prod` workspaces carry two environment
variables — `TFC_AWS_PROVIDER_AUTH=true` and `TFC_AWS_RUN_ROLE_ARN` — and
nothing else. Every run gets a credential minted for that run that expires
when the run does. If tighter is wanted later, split into a plan role
(read-only) and an apply role by adding `run_phase:plan` / `run_phase:apply`
to two trust policies; the mechanism is the same.

**GitHub Actions → AWS.** Same idea, other issuer. Bootstrap creates an OIDC
provider for `token.actions.githubusercontent.com` and a role,
`quorum-gha-ecr-push`, trusting `sub =
repo:<org>/team-building:ref:refs/heads/main` with `aud =
sts.amazonaws.com`. Its permissions are `ecr:GetAuthorizationToken` and push
to the one repository. The workflow declares `permissions: id-token: write`
and uses `aws-actions/configure-aws-credentials` with `role-to-assume`.

**Why no static keys, stated once.** An access key in a GitHub secret or a
workspace variable does not expire, is not scoped to a branch, survives the
departure of whoever created it, ends up in a fork's secrets or a debug log,
and needs a rotation nobody schedules. An OIDC token lives minutes, names the
exact repository and branch (or workspace and run phase) that minted it, and
cannot be used from anywhere else. There is no scenario in this design where
a long-lived AWS key is the right answer, so there is none.

**GitHub Actions → HCP Terraform** is the one place a stored token exists: a
team token, scoped to the two environment workspaces, held as a GitHub secret
`TFC_TOKEN`, used only to set a variable and queue a run. HCP Terraform does
not yet accept GitHub's OIDC tokens for API calls; when it does, this secret
goes too.

### What lives where

| Kind | Where | Examples |
| --- | --- | --- |
| Infrastructure shape | Terraform code in the repo | Everything in `modules/` |
| Per-environment values | HCP Terraform **Terraform variables** | `image_tag`, `domain_name`, `hosted_zone_id`, `desired_count`, `task_cpu`, `task_memory`, `log_retention_days` |
| Cloud auth | HCP Terraform **environment variables** | `TFC_AWS_PROVIDER_AUTH`, `TFC_AWS_RUN_ROLE_ARN` |
| Runtime secrets | **SSM Parameter Store**, SecureString, injected by ECS at task start | `/quorum/prod/admin_key` |
| Runtime non-secret config | Task definition `environment`, set by Terraform because Terraform knows the values | `QUORUM_TABLE`, `AWS_REGION`, `QUORUM_ENV`, `LOG_LEVEL` |

The rule: **a secret's value never passes through Terraform.** Terraform
creates the SSM parameter with a placeholder and `lifecycle { ignore_changes
= [value] }`; a human sets the real value once with the AWS CLI. Terraform
state is encrypted at rest in HCP Terraform, but plan output is shown to
anyone who can see a run, and a secret in a variable is a secret in every
plan. The application reads secrets from its environment at startup, so it
does not know or care that SSM exists.

### The deploy decision: the image tag is a Terraform variable

Two ways to get a new image into ECS, and mixing them is the mistake:

- **A.** Actions registers a new task definition and calls `UpdateService`.
  Terraform owns the rest. Requires `ignore_changes = [task_definition]` on
  the service, two renderers of the task definition (one in HCL, one in the
  workflow), and a Terraform apply that either fights the deploy or is
  blindfolded to it.
- **B.** Actions pushes the image and sets `image_tag` in the workspace; a
  Terraform run applies it. Terraform is the only thing that ever writes an
  ECS resource.

**B.** The reasoning:

1. **One owner.** The task definition is HCL, full stop. Environment
   variables, secrets, CPU, memory and the image are in one place with one
   diff. There is no `ignore_changes` and no second template.
2. **The deployed version is in state and in run history.** "What is in prod
   right now?" is a question HCP Terraform answers, with who changed it and
   the plan they saw.
3. **The plan is the review.** A deploy run's plan says: one task definition
   revision, one service update, image `sha-abc123` → `sha-def456`. If it says
   anything else, something is wrong and the human confirming prod sees it
   before it happens. Option A has no equivalent moment.
4. **Deploy frequency is low.** This ships a few times a month. A plan/apply
   cycle of two to three minutes is not a cost anyone will feel. The
   argument for A is deploy speed, and it does not apply here.

The mechanism, so it is concrete: the `release` job calls the HCP Terraform
API to `PATCH` the workspace variable `image_tag`, then `POST /runs` for that
workspace with the message `deploy sha-<short> (<commit subject>)`. Updating a
variable does not itself trigger a run on a VCS workspace, so the explicit run
is required, and the run uses the tracked branch's current commit — which is
the same commit that built the image, because the job runs on merge to `main`.
`hashicorp/tfc-workflows-github` provides actions for both calls.

An infrastructure-only merge (a change under `infra/`) triggers its own
VCS run and picks up whatever `image_tag` is set. That is exactly why B does
not fight: the image is a variable, not code, so code changes and image
changes are orthogonal inputs to the same single owner.

### Workflows

**`quorum-ci.yml` — on pull request** touching `services/quorum/**`:

```
lint-test:      npm ci · eslint · tsc --noEmit · vitest (reducers, protocol, CSV import)
build-image:    docker build (no push) — proves the Dockerfile still builds
terraform:      terraform fmt -check -recursive
                terraform validate  (init -backend=false; no credentials needed)
```

HCP Terraform posts the speculative plan for each environment workspace as
its own status check. All four checks are required to merge.

**`quorum-deploy.yml` — on push to `main`** touching `services/quorum/app/**`
or the Dockerfile:

```
build-push:     permissions: { id-token: write, contents: read }
                configure-aws-credentials (role: quorum-gha-ecr-push, OIDC)
                docker build · tag sha-<short> and main · push both

release-staging: needs build-push
                set image_tag = sha-<short> on quorum-staging · create run · wait
                (auto-apply) · curl https://quorum-staging.<domain>/healthz
                expect version == sha-<short>

release-prod:   needs release-staging · environment: prod
                freeze check (below)
                set image_tag on quorum-prod · create run
                → the run waits in HCP Terraform for a human to confirm
```

The prod confirm lives in HCP Terraform, not in a GitHub environment
approval, because the thing worth a human's eyes is the plan, and the plan is
in HCP Terraform. A GitHub approval would be a button next to a log; the
Terraform confirm is a button next to the diff.

### Deploying around a live session

A deploy is a task stop and start. Every WebSocket drops, the room sees a
reconnect banner for twenty seconds, and any answer sent in the gap is lost.
The service survives this ([above](#durability-and-restart)); the session
should never have to.

The policy is **don't**, enforced three ways because "don't" on its own is a
Slack message someone missed:

1. **The service says whether it is busy.** `/healthz` reports
   `sessionsLive`. The `release-prod` job fetches it first and fails, loudly,
   with the session count in the message, if it is non-zero. `force=true` as
   a manual `workflow_dispatch` input overrides it, for the case where the
   deploy *is* the fix.
2. **Event days are frozen.** A repository variable `QUORUM_DEPLOY_FREEZE`
   (`1` or a date) is checked by the same job. Whoever owns an event sets it
   the day before and clears it after. This catches the session that is about
   to start and does not yet count as live.
3. **Prod applies are manual.** Even if both checks are wrong, the run sits in
   HCP Terraform until someone clicks, and someone clicking at 2:45pm on an
   event day is a person who can be asked to wait.

Draining was considered and rejected: ALB connection draining keeps old
sockets open on the old task while new ones go to the new task, which with
in-memory state gives two tasks with different ideas of the session. That is
worse than a clean twenty-second gap. Scaling to two tasks with a shared
state store would remove the problem and is the first thing to do if this
ever becomes something other than a tool used two hours at a time — and a
strong hint that it should not.

## Local development

```
services/quorum/app$ docker compose up        # DynamoDB Local on :8000
services/quorum/app$ npm run dev              # server on :3000 with hot reload, clients via Vite
                                              # prints the three URLs and a fresh admin key
services/quorum/app$ npm run seed             # creates a session from the repo's launch content,
                                              # prints join code, host and screen links
services/quorum/app$ npm run bots -- 30       # 30 fake participants that join, answer at random
                                              # speeds, tap during red lights, and back players
```

No AWS credentials are needed locally; the DynamoDB client points at the
local endpoint when `QUORUM_ENV=local`. The reducers run under `vitest` with a
fake clock, which is where the game rules are actually developed — the
browser is for the feel, not the logic.

The bots matter more than they sound. The failure modes that hurt in a live
room (thirty reconnects at once, a tap flood, the count that never reaches
"27 of 27") do not appear with two browser tabs, and a bot swarm is the only
rehearsal a host can run alone.

**Staging** is the same Terraform with `desired_count = 0` between uses. Set
it to 1 for a rehearsal, run the bots against it, set it back.

## Cost

Always-on, Sydney, USD, approximate:

| | Monthly |
| --- | --- |
| Fargate, 0.5 vCPU / 1 GB, 730 h | ~18 |
| ALB, fixed hourly + minimal LCU | ~20 |
| DynamoDB on-demand, PITR, a few sessions | < 1 |
| Route 53 hosted zone | 0.50 |
| ECR, CloudWatch, data transfer | ~2 |
| HCP Terraform | Free tier (well under 500 resources) |
| GitHub Actions | Included minutes |
| **Total** | **~$40** |

Parking the service between events (`desired_count = 0`) takes Fargate to
zero and leaves the ALB as the floor at ~$20. Below that means giving up the
ALB — TLS on the task with a public IP that changes on every restart — and
is not worth the operational cost for the money.

The cost of the thing it replaces is a Kahoot licence and the scorekeeper's
afternoon.
