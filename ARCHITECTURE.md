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
| `refused` | S→C | `reason` (`nickname_taken`, `invalid_nickname`, `lobby_locked`, `no_such_code`, `not_joinable`, `kicked`, `bad_token`, `rate_limited`, `malformed`), `message` |
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

**There is no `trivia.*` message family.** This section used to sketch one —
`trivia.open`, `trivia.count`, `trivia.reveal`, `trivia.mine` — and it was not
built, for two reasons worth keeping.

The first is that Phase 1 already decided a broadcast means "re-send the
projection for that role". Four delta message types alongside that would be a
second, parallel way for a surface to go stale, and the surfaces that go stale
are the ones nobody notices until a live session.

The second is that the sketch broadcast too widely. `trivia.open` and
`trivia.count` were `S→all`, and `trivia.reveal` carried `distribution` to
everyone — but DESIGN says the distribution is a Desktop thing, and SPEC
says a phone must reveal nothing about correctness until the reveal, because a
phone that turns green is visible to the person sitting next to you.

So trivia rides in `RenderState`, projected per role, as one `trivia` block
plus a participant-only `triviaMine`. What each role is sent:

| field | participant | screen | host |
| --- | --- | --- | --- |
| `text`, `answers` | on open | on open | always |
| `correct` | reveal | reveal | always |
| `distribution` | never | reveal | always |
| `note` | reveal | reveal | always |
| `podium` | reveal | reveal | reveal |
| `answered` / `eligible` | never | always | always |
| `answeredBy` | never | never | always |

The rule is enforced by **omission, not by nulling**: a field a role may not
see is absent from the object, so `JSON.stringify` never writes the key and the
word does not appear in the bytes on that socket. That turns "was it sent?"
into a property of the wire that a test can assert against a raw frame, rather
than a discipline a renderer has to keep.

`triviaMine` is a three-state union — `unanswered`, `locked`, `revealed` —
so the locked state has no correctness field to forget to strip.

Client to server is one message:

```jsonc
// C→S
{ "t": "trivia.answer", "cid": "a8f2", "index": 7, "choice": 2 }
```

No timestamp: the server times the tap itself and corrects it for that
socket's measured round trip. See "Clocks and fairness" above.

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

Round-specific `floor` payloads, briefly. **"Public" here means the Desktop
and the host, not a phone.** The projection is per role and enforced by leaving
a field out rather than nulling it, so a key a phone may not have never appears
in its bytes.

The one that decides `plan_apply` is the epoch of the *next* light change —
this table used to list it as `nextTurnHintAt` in the public payload, and that
is unshippable: a client holding it can tap flat out, stop 401 ms before every
lock, and never be caught. It goes to the screen and the host only, as
`nextChangeAt` and its 400 ms telegraph `headTurnsAt`. `progress` and
`finished` are likewise withheld from phones; a phone is told its own count and
nothing about anyone else's.


| Round | Public `floor` | Private `me` |
| --- | --- | --- |
| `recruitment` | `item { cue }`, `itemEndsAt`, `solved: [pid]` | `answered`, `correct` |
| `plan_apply` | `light: "plan"/"apply"`, `lightChangedAt`, `target`, `checkpoints` | `n`, `checkpoint` |
| `unseal` | `shapes: { pid: "circle" }`, `progress: { pid: k }`, `cracked: [pid]` | `word` (scrambled), `taps`, `hintsUsed` |
| `tug_of_raft` | `pull: 1..3`, `sides: { a: [pid], b: [pid] }`, `rope: -1..1`, `beatEpoch`, `bpm` | `side`, `onBeat`, `misses`, `electing` |
| `gganbu` | `item { prompt, line }`, `itemEndsAt`, `tokens: { pid: n }` | `rival`, `tokens`, `wager` |
| `glass_bridge` | `step`, `wave`, `stepEndsAt`, `broken: (0\|1\|null)[]` indexed by step, `position: { pid: step }` | `wave`, `step`, `fallen` |

**The Glass Bridge's public payload is the whole game, so three things are
deliberately absent from it.**

The answer key never travels: each step is split at `startRound` into a
showable half (the product and the two labels) and a key (which pane is real,
and *both* notes — the fake's note says why it is fake, so it is the answer
too). Nothing outside the reveal may read the key.

`broken` is written only when a step **closes**, never as a player falls. With
two panes, "the left one broke" is "the right one is real", so publishing a
break live would hand the answer to everyone still standing on that step. By
the time an entry is non-null, everyone who could have used it has stepped —
which is exactly what waves 2 and 3 are promised, and no more.

No per-player pane choice appears anywhere, because **a pane that held
identifies the real pane just as completely as a pane that broke**. The engine
does not store one: a pane that holds advances you and a pane that breaks
drains you, so `position` is a count and nothing can be joined back to a pane.

There is also no screen-only secret here — the Desktop is in the room — so
a participant's view must be a *subset* of the public one rather than a
different cut of it.

**Taps, as built.** This section used to describe batching ten taps into one
`arcade.input` per 100 ms carrying a *client* timestamp, and a 10 Hz
`arcade.round` broadcast. Neither exists, and the client timestamp in
particular should not: the server times the tap itself, as it does a trivia
answer, because a client timestamp is a number the player's own device chooses
about whether they beat the lock.

What is built: one `arcade.tap` per tap, and **an ordinary tap produces no
broadcast and no write at all**. Only a milestone — a checkpoint, a crossing,
a drain, a light turn — moves points or the room's state, and only those fan
out. The phone counts optimistically in between, so the button answers the
thumb rather than the link. There is no periodic broadcast anywhere.

Sixty players tapping flat out is therefore ~600 inbound messages a second and
close to nothing outbound, which is the opposite way round from the design
above and the reason it was abandoned.

### Host

```jsonc
// C→S
{ "t": "host.cmd", "cid": "h41", "cmd": "trivia.open", "qid": "q07" }
{ "t": "host.cmd", "cid": "h42", "cmd": "segment", "kind": "holding",
  "title": "Agentic Security TTX", "line": "Ade has the room. Back here at 2:40.", "until": 1790338800000 }
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

The host and screen receive everything participants receive plus the answered
count, and the host alone receives per-participant answer state and correctness
before the reveal. The per-role table under "Trivia" above is the authority on
which is which.

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
| `POST` | `/api/sessions/:sid/content/trivia` | host | JSON question file; validates and replaces the set; rejects with `invalid_questions` and errors addressed by question number |
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

## Delivery: a person with a session

The original design here was OIDC federation — HCP Terraform to AWS, GitHub
Actions to AWS, no stored credential anywhere, the image tag as a Terraform
variable so a deploy was an apply. It is a good design and it is not the one
that runs, because the account it deploys into forbids the identities it needs:
`iam:CreateOpenIDConnectProvider` and `iam:CreateUser` are both an explicit
deny, and the account holds 0 users and 0 identity providers against 46 roles.

That is a deliberate policy — only humans with a current session act in that
account — and there is no way to satisfy it with a machine identity, including
the "just store an access key" fallback, because there is no user to hold a key.

**So the deploy is `make deploy`, run by a person with an eight-hour session.**
Runs still execute in HCP Terraform — what changed is how its workers get AWS
credentials. Rather than federating an identity, doormat pushes a copy of the
operator's STS session into a variable set (`awscreds`, then `tfawscreds`), and
it expires with that session. It is a credential refresh before every apply
instead of no credential at all, which is worse than OIDC and was the only
option the account left open.
`make up` and `make down` raise and park the service around an event. The image
tag is still a Terraform variable and the apply is still the deploy, so the task
definition keeps one owner and a deploy is still a reviewable diff — only the
thing holding the credential changed.

**CI stays, and needs no credential**: typecheck, tests, `terraform fmt` and
`validate`, and a container build that proves the Dockerfile compiles. That is
most of what the pipeline was worth, and a fork's PR runs all of it.

This is a smaller loss than it looks. Quorum runs two hours a few times a year.
There is no release cadence to automate, and someone has to be present to raise
the service before an event anyway. Deploy-on-merge was solving a problem this
service does not have.

**If the guardrail is ever lifted**, the way back is short: create the two OIDC
providers and the two roles, and move `make deploy`'s three steps into a
workflow. Nothing in the application or the Terraform assumes a human.

See [infra/README.md](infra/README.md) for the commands.

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
