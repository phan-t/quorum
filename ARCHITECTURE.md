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
   │   ├─ three static clients             │
   │   │   (participant, host, screen),    │
   │   │   served from dist/client         │
   │   ├─ REST (node:http)                 │
   │   ├─ WebSocket hub (ws)               │
   │   └─ game engine: pure reducers,      │
   │       in-memory session state,        │
   │       server-side timers              │
   └──────────────┬────────────────────────┘
                  │  snapshot + event log
                  ▼
           DynamoDB (on-demand)          SSM Parameter Store (admin key)
```

**Stack:** Node 24, TypeScript end to end, and almost nothing else. The whole
dependency list is `ws` and the two AWS SDK packages; HTTP is `node:http`, and
there is no web framework, no bundler and no UI library. The three clients are
plain TypeScript and plain DOM, compiled by `tsc` into `dist/client` and served
by the same process.

That is a choice rather than an omission. The server runs its TypeScript
directly — Node strips the types — so there is no build step between an edit and
a running server, and the only compile in the project is the one a browser
forces. A framework would have to earn its place against three pages whose
entire job is to redraw a projection the server sends them.

One language means the message protocol is a single `protocol.ts` shared by
server and clients, and the game engine's reducers are the same functions in the
test suite and on the server.

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
gap survivable, and the rule about not deploying during an event — which is a
rule a person keeps, not a pipeline, and lives in
[infra/README.md](infra/README.md) — makes it rare. That trade is correct for
this product and would be wrong for a public one.

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
fact; and the rules have exactly one implementation, so there is no second one
in a client to disagree with it.

The clients import `engine/types.ts` for its types and nothing else. They do not
run the reducer. Where a surface needs to feel instant — the tap counter in
Plan / Apply — it counts optimistically in the browser and lets the next
broadcast correct it, which is a counter and not a second copy of the rules.

## Data model

One DynamoDB table, on-demand capacity, single-table design. It is small: a
session with sixty people and twenty questions is on the order of two
thousand items and under a megabyte.

| PK | SK | Item |
| --- | --- | --- |
| `SESSION#<sid>` | `META` | sid, title, joinCode, phase, seal, hostTokenHash, screenTokenHash, the console's opaque `setup` blob, createdAt, updatedAt, ttl |
| `SESSION#<sid>` | `SNAPSHOT` | full in-memory state, JSON, version, seq — rewritten on every transition |
| `SESSION#<sid>` | `EVENT#<seq:010d>` | one game event: type, the event itself, at, byPid — append-only |
| `SESSION#<sid>` | `PARTICIPANT#<pid>` | nickname, nicknameKey, playerNumber, rejoinTokenHashes[], joinedAt, kicked |
| `SESSION#<sid>#PROMO` | `PROMO` | the event's promo card, one HTML page, chars, at |
| `SESSION#<sid>#ASSET` | `ASSET#<key>` | one send-off photo or the music file: bytes (Binary), contentType, size, at |
| `CODE#<joinCode>` | `ACTIVE` | sid — exists only while the session is joinable |

**The promo card and the send-off assets are in partitions of their own**, and
that is load-bearing rather than tidy. Both are content served *beside* a
session and never part of one, and both are large — a card is a quarter of a
megabyte and forty-three photos are seven. Keeping them under `SESSION#<sid>`
would mean the recovery query dragging all of it back to discard it, and the
obvious fix, `FilterExpression: "SK <> :promo"`, is one DynamoDB refuses
outright: a filter may not name a key attribute. That was shipped once and
broke every `loadSession` and every `loadRecoverable`; see the commit that
moved the card. A separate partition needs no filter, and the read is a
`GetCommand` by exact key either way.

GSI: none. Join codes are looked up by their own PK; everything else is a
query on `SESSION#<sid>`. The `SNAPSHOT` item is the fast path for restart;
`EVENT#` items are the audit trail and the slow path when a snapshot is
suspected.

**Scores and spot awards have no items of their own.** They are fields of the
session state, so they ride in the `SNAPSHOT` and are derivable from the
`EVENT#` log, and the CSV export is built from the loaded state rather than
from a second set of rows. A row per score per activity would be a second
place for the same number to live, and the first time the two disagreed it
would be in front of a room.

**Finding a session at boot is a `Scan`, not a query.** There is no index on
`phase`, so recovery scans the table for `META` items in `draft`, `lobby`,
`running` or `closed` and then reads each of those partitions. That is
affordable because this table holds a handful of `META` rows and the TTL
clears them at 90 days; `DynamoStore.loadRecoverable` says what to do instead
if that ever stops being true.

**Retention.** `ttl` on every item is 90 days from session close. Nicknames
are the only personal data and there is no reason to keep them longer than
the next event's planning.

**Where content comes from.** The arcade's items ship in the container, as
modules under `src/arcade/`, and are attached to the round when the host starts
it — which is also why a round's answer key never travels on a host command.
The trivia set and the send-off arrive per session over REST and become engine
state, so they are in the `SNAPSHOT` like everything else. Neither has an item
of its own, and a content change in the repo cannot rewrite a session already
in flight, because a running session holds what it was given.

## WebSocket protocol

JSON text frames. Every message is `{ "t": "<type>", ...fields }`. Server
broadcasts carry `seq`, a per-session monotonic counter; a client that sees a
gap sends `resync` and gets a full `state`. Client messages carry `cid`, a
client-generated id echoed in the `ack` so a client can reconcile an optimistic
update.

One socket per client. Role is fixed at `hello`: participant, host, or screen.

`protocol.ts` is the authority on all of this, and it is a union type rather
than a document, so the compiler checks what the tables below only describe.

### Server to client

There are **nine** of them, and that is the whole list.

| Type | Direction | Fields |
| --- | --- | --- |
| `welcome` | S→C | `role`, `sid`, `pid` and `rejoinToken` (participant only), `serverTime`, `protocol` |
| `refused` | S→C | `reason` (`no_such_code`, `nickname_taken`, `invalid_nickname`, `lobby_locked`, `kicked`, `bad_token`, `not_joinable`, `rate_limited`, `malformed`), `message` |
| `state` | S→C | `seq`, and the whole `RenderState` projected for that role |
| `roster` | S→all | `seq`, `[{ pid, nickname, playerNumber, conn }]` — `conn` is `on`/`away` |
| `seal` | S→all | `seq`, `state`: `live`/`sealed`/`revealed` |
| `toast` | S→all | `seq`, `kind`: `spot`/`text`, `text` |
| `ack` | S→C | `cid`, `applied` |
| `refusedCmd` | S→C | `cid`, `code`, `message` — why a host command was refused |
| `pong` | S→C | `t0`, `t1` — see [clocks](#clocks-and-fairness) |

**There is no `segment` frame and no `own` frame.** Both were sketched here and
neither was built, for the reason the trivia deltas below were not: a segment
change and a points change are both changes to the render state, and re-sending
the projection is already how every other change reaches a surface. A second,
parallel path is a second way for a surface to go stale, and the surfaces that
go stale are the ones nobody notices until a live session.

So the segment is `state.segment`, the holding card is `state.holding`, the
standings are `state.standings`, and the participant's own points strip is
`state.own` — present only for a participant, and omitted entirely while sealed
rather than nulled.

### Client to server

`hello`, `resync`, `ping`, `host.cmd`, and one frame per thing a participant can
do: `trivia.answer`, `arcade.answer`, `arcade.tap`, `arcade.step`,
`arcade.shape`, `arcade.letter`, `arcade.docs`, `arcade.beat`, `arcade.back`.

`hello` is three shapes, one per role: `{ role: "participant", joinCode,
nickname, rejoinToken? }`, `{ role: "host", hostToken }`, `{ role: "screen",
screenToken }`.

**None of the participant frames carries a timestamp**, and that is the single
most repeated decision in `protocol.ts`. Every instant that is worth points —
how fast a trivia answer arrived, whether a tap landed before the state lock,
how long a runner took to choose a pane — is measured by the server from its own
clock and its own latency estimate for that socket. A client-supplied `at` would
be a number worth points, which is a number worth forging.

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
| `answered` / `eligible` | once that phone has locked in | always | always |
| `answeredBy` | never | never | always |

`answered` / `eligible` is the one row that is not about secrecy. A count of
how many people have answered carries no choice, so there is nothing in it to
leak; it waits for the phone's own tap because a number climbing under a
question somebody is still reading is a second clock. After the tap it is the
only thing on the phone that moves, and DESIGN had put it only on the console
and the Desktop — which, on a video call, is the tile nobody can read.

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

The arcade is one segment with a round-level state machine inside it. Like
trivia, it rides in `RenderState` rather than in frames of its own: one
`arcade` block projected per role, plus a participant-only `arcadeMine`.

`ArcadeView` carries the envelope every round shares — `round`, `roundIndex`,
`phase` (`idle` / `card` / `running` / `reveal`), `startedAt`, `endsAt`, the
`grid` of players, and how many are `onFloor` and `inLounge` — and then exactly
one optional round block: `recruitment`, `planApply`, `unseal`, `tug` or
`glass`. `ArcadeMine` is the same idea for one player: their player number,
standing, banked and total, who they are backing, and the same one-of-five
round block cut for them.

**Five of the six designed rounds are built.** Gganbu is in the engine —
pairing, wagers, scoring — and is reachable from nowhere: `arcade.round` has no
`gganbu` variant, so `parseClientMessage` refuses one on the wire, and the
console lists it disabled so a host can see the shape of the run of show
without starting something that does not exist. SPEC.md's round table is the
design; this is what a session can play.

**"Public" means the Desktop and the host, not a participant.** The projection
is per role and enforced by leaving a field out rather than nulling it, so a
key a participant may not have never appears in its bytes.

The one that decides Plan / Apply is the epoch of the *next* light change. A
client holding it can tap flat out, stop 401 ms before every lock, and never be
caught, so it goes to the screen and the host only, with its 400 ms telegraph.
A participant is told its own count and nothing about anyone else's.

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
drains you, so a position is a count and nothing can be joined back to a pane.

There is also no screen-only secret here — the Desktop is in the room — so
a participant's view must be a *subset* of the public one rather than a
different cut of it.

**Input is one frame per thing a player does**, not one generic envelope.
`arcade.answer`, `arcade.tap`, `arcade.step`, `arcade.shape`, `arcade.letter`,
`arcade.docs`, `arcade.beat`, `arcade.back`. A single `arcade.input` carrying a
`kind` was the earlier sketch and would have made every round's payload
optional on every other round's frame; separate frames mean the parser rejects
a pane choice sent during Unseal instead of the engine having to.

Each of them carries the `round` it was meant for, and the ones that can cross
a boundary carry the item or step as well, for the reason `trivia.answer`
carries an index: a frame in flight when the host advances is a commitment to
something the player never saw, and the engine refuses it rather than applying
it to whatever is open now.

**Taps, as built.** This section used to describe batching ten taps into one
frame per 100 ms carrying a *client* timestamp, and a 10 Hz broadcast. Neither
exists, and the client timestamp in particular should not: the server times the
tap itself, as it does a trivia answer, because a client timestamp is a number
the player's own device chooses about whether they beat the lock.

What is built: one `arcade.tap` per tap, and in Plan/Apply **an ordinary tap
produces no broadcast and no write at all**. Only a milestone — a checkpoint, a
crossing, a drain, a light turn — moves points or the room's state, and only
those fan out. The client counts optimistically in between, so the button
answers the finger rather than the link.

Sixty players tapping flat out is therefore ~600 inbound messages a second and
close to nothing outbound, which is the opposite way round from the design
above and the reason it was abandoned.

**Tug of Raft is the exception, and it is a tick rather than a clock.** A beat
that is credited — on the beat, one per beat, outside an election — is a state
change the rope has to show, so `tapBeat` does return broadcasts, to the player
who tapped, the host and the screen, and never `to: "all"`. Thirty players at
100 bpm is around fifty credits a second and a fan-out each would be some
fifteen hundred frames a second to move a rope by a pixel, so `SessionRuntime`
holds those audiences and sends each of them at most one frame per
`BEAT_FLUSH_MS` (120 ms, about a fifth of a beat). The window opens on the
first beat it holds and is not re-armed, so a room that never stops tapping
still gets a frame every tick rather than starving. The engine credits the beat
the instant it lands either way — the tick decides only when the *picture* goes
out, which is why it lives at the boundary and not in the reducer. A credited
beat also appends an event row; the snapshot behind it coalesces in
the `Persister`, so the rope writes one snapshot at a time and not one per
beat.

### Host

One frame carries every console button:

```jsonc
// C→S
{ "t": "host.cmd", "cid": "h41", "cmd": { "name": "trivia.open", "suddenDeath": false } }
{ "t": "host.cmd", "cid": "h42", "cmd": { "name": "holding",
  "title": "Agentic Security TTX", "line": "Ade has the room. Back here at 2:40." } }
{ "t": "host.cmd", "cid": "h43", "cmd": { "name": "seal", "state": "sealed" } }
{ "t": "host.cmd", "cid": "h44", "cmd": { "name": "participant.release", "pid": "p07" } }
{ "t": "host.cmd", "cid": "h45", "cmd": { "name": "spot.grant", "pid": "p12",
  "activityId": "trivia", "reason": "best recovery of the afternoon" } }
```

The command is an object with a `name`, not a bare string with sibling fields,
so each command's own arguments are typed with it and a command that needs none
is `{ name }` and nothing else. `cmd` is `null` when the frame could not be
parsed — it still arrives, so the server can answer `refusedCmd` on that `cid`,
because a console that gets silence cannot tell a rejected click from a dropped
one.

`HostCommand` in `protocol.ts` is the list. Grouped by what they do:

| Group | Commands |
| --- | --- |
| Session | `open`, `start`, `close`, `session.reopen`, `session.restart` |
| Room | `segment`, `holding`, `seal`, `practice`, `lobby.lock` |
| People | `participant.kick`, `participant.release` |
| Scoring | `score.set`, `score.status`, `spot.grant`, `spot.revoke` |
| Trivia | `trivia.open`, `trivia.close`, `trivia.reveal`, `trivia.next` |
| Arcade | `arcade.enter`, `arcade.round`, `arcade.begin`, `arcade.next`, `arcade.nextStep`, `arcade.nextWave`, `arcade.nextPull`, `arcade.end`, `arcade.reveal` |
| Send-off | `sendoff.next`, `sendoff.back`, `sendoff.auto`, `sendoff.speed` |

Two of them are worth singling out.

**`session.restart` carries `confirm`**, which must be the session's own join
code, and the server refuses the command without it. It is not authentication —
the socket is already the host's — it is the reason this one command cannot be
fired by a frame that merely names it. Every other command is expressible as a
bare `{ name }`, which is fine for a command that shows a holding card and is
not fine for the one that wipes the afternoon.

**`arcade.round` carries settings and never content.** The emoji items, the
eighteen panes, the tins: all of them live on the server and are attached when
the round starts. A round config on the wire would be the answer key leaving the
server on a frame the console could be made to echo.

Host commands that would be destructive from the wrong state are refused with a
`refusedCmd` explaining why, not silently ignored — the console shows the
refusal inline, in the button.

The host and the screen receive everything participants receive, and receive the
answered count unconditionally where a phone waits for its own tap; the host
alone receives per-participant answer state. *Who*
has answered, never *what* they answered: the console's job is to decide whether
to wait, and a grid of choices would be the answer key on a screen the host
sometimes shares by accident. The per-role table under "Trivia" above is the
authority on which is which.

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

REST is for things that are not real-time: creating sessions, loading content,
exporting, and operating the service between events. Everything live goes over
the socket.

| Method | Path | Auth | Does |
| --- | --- | --- | --- |
| `POST` | `/api/sessions` | admin key | Creates a session; optional `activities` (the event's own scored set, validated all-or-nothing, rejected as `invalid_activities` with errors addressed by position — absent means the default set) and an opaque `setup` blob the console reads back; returns `sid`, `joinCode`, host and screen tokens (shown once) |
| `GET` | `/api/sessions` | admin key | Every session this task holds: sid, title, join code, phase, segment, counts, age. Never the tokens |
| `POST` | `/api/sessions/:sid/close` | admin key | Retires a session. Refuses one with sockets attached unless `?force=1` |
| `POST` | `/api/sessions/:sid/content/trivia` | host | JSON question file; validates and replaces the set; rejects with `invalid_questions` and errors addressed by question number |
| `POST` | `/api/sessions/:sid/content/sendoff` | host | The send-off file. Keys, not bytes — the photos follow one request each |
| `POST` | `/api/sessions/:sid/content/promo` | host | The promo card, one self-contained HTML page |
| `POST` | `/api/sessions/:sid/assets/<key>` | host | One send-off photo or the music file, as bytes |
| `GET` | `/api/sessions/:sid/assets/<key>` | — | That asset back, for the Desktop to draw. No token; see below |
| `GET`/`HEAD` | `/api/sessions/:sid/promo` | — | The promo card. No token; `HEAD` is how the Desktop asks whether there is one to frame |
| `GET` | `/api/sessions/:sid/setup` | host | The staged console setup, as the text it arrived as. The console asks once, on load |
| `GET` | `/api/sessions/:sid/export.csv` | host | The scoresheet: `Name, <Activity> Raw, <Activity> Pts, …, Spot Awards, TOTAL` |
| `GET` | `/api/sessions/:sid/events.jsonl` | host | The event log, for disputes |
| `GET` | `/healthz` | — | `200 { ok, sessionsLive, socketsOpen, version, store, persist }` |
| `GET` | `/status` | — | Plain-text version of the above, for humans |
| `GET` | `/`, `/j/:code`, `/host`, `/screen` | — | The three client shells; `/j/:code` is the participant page with the code prefilled |

**Two reads carry no token, on purpose.** An `<iframe>`, an `<img>` and an
`<audio>` cannot carry an `Authorization` header, and the promo card and the
send-off assets are exactly those three elements' sources on the Desktop.

That is acceptable for these and nowhere else in this service because of what
they are: a poster and a montage the room is seconds away from watching on a
shared screen. No scores, no roster, no names. It still takes an unguessable
session id to ask, and a session with no card answers exactly as an unknown
session does, so it is not a session-id oracle either. Everything that *writes*
them needs the host token.

**`/healthz` stays `ok` while persistence is degraded.** The session is still
playable, and pulling the task out of the load balancer would end it — a far
worse outcome than a gap in the audit trail. The `persist` block is where a
degraded store is visible.

**Unknown session and wrong token answer alike**, everywhere here: a 404 that
appears only for a real sid is a session-id oracle.

**Auth.** Three bearer tokens, all compared by hash in constant time: the
**admin key** (one, from SSM, creates and retires sessions), the **host token**
(per session, in the console URL fragment so it never hits a log), the **screen
token** (per session, view-only). Tokens are 128-bit random, base32; the join
code is separate and is `hvs.` plus 24 base62 characters. No user accounts, as
specified. Participant identity is the rejoin token issued at `hello`. That is
the whole security model; it is proportionate to a team quiz.

Rate limits: `hello` at 10 per minute per address; `/api/sessions` at 10 per
hour. Behind the ALB the socket's peer address is one ENI for the entire room, so
the task is told to read `X-Forwarded-For` instead — see `QUORUM_TRUST_PROXY` in
the task definition and `clientAddress` in `server/address.ts`.

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

**On start** the process scans for sessions in `draft`, `lobby`, `running` or
`closed`, loads each `SNAPSHOT`, replays any `EVENT#` with `seq` greater than
the snapshot's (there should be none or one), marks everybody the snapshot
thought was present as `away`, and re-arms timers from the state: a `closesAt`
in the past fires immediately, one in the future is scheduled. All of this
happens before the port opens.

`draft` and `closed` are in that list because both were left out once and both
cost a session. A host sets an event up the day before, which is exactly the
gap `draft` covers; and `reopen` exists to undo an accidental close, which a
restart would otherwise make permanent. In both cases the rows were still in
the table and the export still worked, while the console got `bad_token` for a
link that was correct — see the comment on `loadRecoverable`.

**On SIGTERM** (ECS stop, deploy) the process stops accepting `hello`, writes
final snapshots, closes every socket with code `1012 Service Restart`, and
exits. ECS gives it 30 s. Clients treat `1012` as a reconnect, backing off
300 ms, 800 ms, 1.6 s, 3.2 s, 6.4 s and then every 10 s — with an immediate
attempt when the tab wakes, so nobody waits out a backoff their phone slept
through — and the rejoin token gets them back as themselves.

**What a mid-game restart looks like from the room.** Roughly twenty seconds
(task stop, new task pull and start, health check) during which surfaces show
the reconnect banner. Then everyone is back on the same segment. If a trivia
question was open, the snapshot has the answers received before the process
died and lost the ones sent during the gap. Nothing about the scoreboard is
ever inconsistent, because scores are derived from persisted events.

**There is no re-ask.** This paragraph used to promise one — a flag on the
affected question and a button to ask it again — and none of it exists: no
event in the engine, no command on the wire, and nothing in the console that
counts how many answers a gap swallowed. A host who loses answers to a restart
is holding a question that scored some of the room and not the rest, and the
only tools for that are the ones any other scoring problem uses: `score.set`
for a raw number, or `score.status` to bench somebody for the activity. Said
plainly here because a host who believes in a re-ask button will go looking for
it at the worst possible moment.

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
| CloudWatch | Log group, 30-day retention; Container Insights at `enabled` (standard, not enhanced); one alarm on `RunningTaskCount < 1` | No custom metrics are emitted. Open sockets and store health are on `/healthz` and `/status`, which is where somebody standing in front of a room actually looks; a dashboard nobody opens during the two hours that matter was not worth the code |
| IAM | Task execution role (pull image, read SSM, write logs); task role (DynamoDB on the one table) | Least privilege is cheap here because there are two roles |

Not in the design: CloudFront (the static bundle is 200 KB and served by the
same process), WAF, Auto Scaling, a second region.

### Terraform layout

```
quorum/
├── app/                      # the service
├── infra/                    # the root, and the whole of it
│   ├── main.tf               # the three module calls
│   ├── ecr.tf                # the one repository and its lifecycle policy
│   ├── variables.tf · outputs.tf · versions.tf
│   └── modules/
│       ├── network/          # VPC, two public subnets, security groups
│       ├── service/          # ECS cluster, task definition, service, ALB, ACM, Route 53, logs, alarm
│       └── data/             # DynamoDB table, SSM parameter (value ignored after create)
├── SPEC.md · ARCHITECTURE.md · DESIGN.md · README.md
```

**One environment, one workspace, one apply.** `infra/` is the root and is the
HCP Terraform workspace `quorum`, CLI-driven: a human runs `make deploy` or
`make up` and HCP Terraform executes the apply.

There was a second workspace for the registry and the OIDC providers. The
providers are gone — see below — and a registry alone did not justify a second
apply, a second variable set and a cross-workspace lookup, so the repository
moved into `infra/ecr.tf`. The trade is that `terraform destroy` now takes the
images with it; since the service is parked at zero rather than destroyed, that
cost rarely comes due.

There is likewise no staging environment. It appeared in this document as
`envs/staging` with its own workspace, and it was never built: one event a
month does not have a release train to rehearse, and a second always-on ALB is
the same $20 a month as the real one. Rehearsal is `npm run dev` and the bot
harness.

The workspace is deliberately **not** VCS-connected, and `versions.tf` sets out
why at length — the short version is that the CLI uploads a gitignored
`terraform.tfvars` that a VCS run would not have, `image_tag` has no default on
purpose, and `desired_count` defaults to 1, so a VCS run would quietly raise a
parked service.

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
quorum/app$ docker compose up -d       # DynamoDB Local on :8000
quorum/app$ npm run build:client       # tsc emits the three clients into dist/client
quorum/app$ npm run dev                # server on :3000, QUORUM_ENV=local, --watch
quorum/app$ npm run bots -- 30         # 30 simulated participants through a whole session
quorum/app$ npm test                   # the rules, under node --test
quorum/app$ npm run typecheck          # tsc --noEmit — the only thing that reads the types
```

No AWS credentials are needed locally; the DynamoDB client points at the local
endpoint when `QUORUM_ENV=local`, and `npm run dev:memory` skips the container
entirely. A store that will not answer at boot is logged and the process falls
back to memory rather than refusing to start.

**`npm run build:client` is not optional.** The server serves `dist/client`,
and without it the process starts, answers `/healthz`, and returns
`client_not_built` for every page. `npm run dev` watches the server, not the
clients; `npm run watch:client` is the other half, and `npm run client:dev`
builds them and serves them on their own.

Tests run under **`node --test`**, with `--experimental-strip-types` so Node
reads the TypeScript directly. There is no test framework here and no `vitest`,
for the reason there is no bundler: the runtime already does it. A fake clock is
a number passed to `reduce`, because `reduce` cannot read one.

The bots matter more than they sound. The failure modes that hurt in a live
room (thirty joins at once, a duplicate nickname, a late arrival, a facilitator
on bench credit) do not appear with two browser tabs, and a bot swarm is the
only rehearsal a host can run alone.

**The bots are not a load test and cannot be pointed at a deployment.** They
have no network layer at all: events go straight into `reduce`, the clock is a
counter, and the whole run is in one process. They prove the engine behaves at
real headcount. Thirty concurrent WebSockets, thirty reconnects during a deploy,
a tap flood arriving over a real link — none of that is exercised anywhere, and
that gap is worth knowing about rather than assuming the harness covers it.

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
