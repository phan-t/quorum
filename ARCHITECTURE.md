# Quorum architecture

The technical design for [SPEC.md](SPEC.md). Decisions are stated with the
reasoning, because the next person to touch this will want to know which ones
were load-bearing.

## Shape

Quorum runs as one container and one process, in one AWS ECS Fargate task
behind an Application Load Balancer, and it talks to one DynamoDB table.

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
there is no web framework, no bundler, and no UI library. The three clients are
plain TypeScript and plain DOM, compiled by `tsc` into `dist/client` and served
by the same process.

The short dependency list is deliberate. Node strips the types and runs the
server's TypeScript directly, so there is no build step between an edit and a
running server, and the only compile in the project is the one a browser
forces. The three pages only redraw a projection the server sends them, and
that job does not need a framework.

One language means the message protocol is a single `protocol.ts` shared by
server and clients, and the game engine's reducers are the same functions in the
test suite and on the server.

### Why one stateful process instead of serverless

The usual serverless design on AWS is API Gateway WebSockets → Lambda →
DynamoDB, with EventBridge or Step Functions for the timers. It was considered
and rejected:

- **The answer path has to be fast.** Speed-weighted trivia and a red-light
  game with a 250 ms grace window need the answer path to be one process
  reading a map. A Lambda cold start plus a DynamoDB round trip plus an API
  Gateway post-to-connection is far slower, and in-memory fan-out to sixty
  sockets is sub-millisecond.
- **Timers are awkward without a process.** "Close question 7 at 14:32:51.200"
  is a `setTimeout`. In serverless it is a scheduled rule with one-minute
  granularity or a Step Functions wait, and either way the closing logic runs
  somewhere other than where the state is.
- **The scale favours one process.** This runs for two hours a few times a
  year for under a hundred people. Serverless is priced and shaped for many
  users and uneven traffic. A single small Fargate task costs about $18 a
  month, and the game engine is much simpler when it can assume it is the only
  writer.

The cost is that there is no high availability. There is one task, and a
restart is a ~20-second gap. [Durability and restart](#durability-and-restart)
makes that gap survivable, and the rule about not deploying during an event
makes it rare. A person keeps that rule, because no pipeline enforces it, and
it is written down in [infra/README.md](infra/README.md). The trade suits a
private team event, and a public product would need high availability.

### The game engine

Every session is a state machine driven by a pure reducer:

```ts
reduce(state: SessionState, event: Event, now: number): { state: SessionState; effects: Effect[] }
```

Events are host commands, participant inputs, timer expiries, and connection
changes. Effects are `broadcast`, `send(to)`, `schedule(at, timerEvent)`, and
`persist(snapshot | eventRecord)`. The process is a thin driver that applies
effects, and nothing else touches state.

The reducer gives the product three things it needs. The trivia and arcade
rules are unit-tested as functions of `(state, event,
now)` with a fake clock. A session is *replayable* from its event log, so a
restart recovers by replaying it and a scoring dispute is settled from it after
the fact. And the rules have exactly one implementation, so no second copy in a
client can disagree with it.

The clients import `engine/types.ts` for its types and nothing else. They do not
run the reducer. Where a surface needs to feel instant, as the tap counter in
Plan / Apply does, it counts optimistically in the browser and lets the next
broadcast correct it. That is a counter, and the rules still have one copy.

## Data model

One DynamoDB table, on-demand capacity, single-table design. It is small: a
session with sixty people and twenty questions is on the order of two
thousand items and under a megabyte.

| PK | SK | Item |
| --- | --- | --- |
| `SESSION#<sid>` | `META` | sid, title, joinCode, phase, seal, hostTokenHash, screenTokenHash, the console's opaque `setup` blob, createdAt, updatedAt, ttl |
| `SESSION#<sid>` | `SNAPSHOT` | full in-memory state, JSON, version, seq, at; rewritten on every transition |
| `SESSION#<sid>` | `EVENT#<seq:010d>` | one game event: type, the event itself, at, byPid; append-only |
| `SESSION#<sid>` | `PARTICIPANT#<pid>` | nickname, nicknameKey, playerNumber, rejoinTokenHashes[], joinedAt, kicked |
| `SESSION#<sid>#PROMO` | `PROMO` | the event's promo card, one HTML page, chars, at |
| `SESSION#<sid>#ASSET` | `ASSET#<key>` | one send-off photo or the music file: bytes (Binary), contentType, size, at |

**The promo card and the send-off assets are in partitions of their own**, and
recovery depends on that. Both are content served *beside* a session and never
part of one, and both are large: a card is a quarter of a megabyte and
forty-three photos are seven. Keeping them under `SESSION#<sid>` would mean the
recovery query dragging all of it back to discard it, and the obvious fix,
`FilterExpression: "SK <> :promo"`, is one DynamoDB refuses outright, because a
filter may not name a key attribute. That was shipped once and broke every
`loadSession` and every `loadRecoverable`; see the commit that moved the card.
A separate partition needs no filter, and the read is a `GetCommand` by exact
key either way.

GSI: none, and every read is a query on `SESSION#<sid>` or a get by exact key
inside it. The `SNAPSHOT` item is the fast path for restart; `EVENT#` items
are the audit trail and the slow path when a snapshot is suspected.

**Join codes have no item.** A `CODE#<joinCode>` / `ACTIVE` row was written on
create and deleted on close, and this section described it as the way join
codes were looked up, which was never built. A phone's join resolves against
`SessionRegistry.byCode`, an in-memory map the process rebuilds at boot from
the snapshots it is loading anyway. The row was a third record of a fact two
other records already carry, and nothing read it, so nothing could catch it
drifting from them. It came out with #22, which is about exactly that kind of
drift between the other two. Rows written before then are left alone and
expire on their own `ttl`.

**Scores have no items of their own.** They are fields of the session state, so
they ride in the `SNAPSHOT` and are derivable from the `EVENT#` log, and the CSV
export is built from the loaded state. A row per score per activity would be a
second place for the same number to live, and if the two ever disagreed, the
room would see it.

**Finding a session at boot takes a `Scan`.** There is no index on `phase`, so
recovery scans the table for `META` items in `draft`, `lobby`, `running`, or
`closed` and then reads each of those partitions. That is affordable because
this table holds a handful of `META` rows and the TTL clears them at 90 days;
`DynamoStore.loadRecoverable` says what to do instead if that ever stops being
true.

**Retention.** `ttl` on every item is 90 days from session close. Nicknames
are the only personal data, and there is no reason to keep them longer than
the next event's planning.

That clock only runs if nothing keeps resetting it, and for a while something
did. Every boot recovered every `closed` session and wrote its rows straight
back, and every SIGTERM wrote every session the registry held, so a deploy
re-stamped the whole table and a finished session's rows never reached 90 days
while the service kept shipping. A session is now **retired by age**: past
`REOPEN_WINDOW_MS` from its `updatedAt`, a `closed` session is left in the
table and is not recovered into the registry. `updatedAt` now reports when the
session last changed, and writing a row back no longer moves it. Its scores
stay exportable by sid the whole time, because the export path reads the store
directly. See `RECOVERABLE_PHASES` and `retiredByAge` in
`app/src/server/store/types.ts`.

**Where content comes from.** The arcade's items ship in the container, as
modules under `src/arcade/`, and are attached to the round when the host starts
it, which is also why a round's answer key never travels on a host command.
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

`protocol.ts` is the authority on all of this. It is a union type, so the
compiler checks what the tables below only describe.

### Server to client

There are **eight** of them, and that is the whole list.

| Type | Direction | Fields |
| --- | --- | --- |
| `welcome` | S→C | `role`, `sid`, `pid` and `rejoinToken` (participant only), `serverTime`, `protocol` |
| `refused` | S→C | `reason` (`no_such_code`, `nickname_taken`, `invalid_nickname`, `lobby_locked`, `kicked`, `bad_token`, `not_joinable`, `rate_limited`, `malformed`), `message` |
| `state` | S→C | `seq`, and the whole `RenderState` projected for that role |
| `roster` | S→all | `seq`, `[{ pid, nickname, playerNumber, conn }]`; `conn` is `on`/`away` |
| `seal` | S→all | `seq`, `state`: `live`/`sealed`/`revealed` |
| `ack` | S→C | `cid`, `applied` |
| `refusedCmd` | S→C | `cid`, `code`, `message`; says why a host command was refused |
| `pong` | S→C | `t0`, `t1`; see [clocks](#clocks-and-fairness) |

**There is no `toast` frame any more.** There was one, carrying `seq`, `kind`,
and `text`, and Spot Awards were the only thing that ever produced it. It came
out with them, along with `Effect`'s `what: "toast"` and its `subject` pid, the
Desktop's toast bar, and the console's toast list. A broadcast channel with no
producer is unreachable code, and the next person would have to work out for
themselves that it is unreachable. The frame can come back with whatever needs
it, and [SCORING.md](SCORING.md#removed-spot-awards-and-bench-credit) says what
was here.

**There is no `segment` frame and no `own` frame.** Both were sketched here and
neither was built, for the reason the trivia deltas below were not. A segment
change and a points change are both changes to the render state, and every
other change already reaches a surface by re-sending the projection. A second,
parallel path would be a second way for a surface to go stale, and a stale
surface usually goes unnoticed until a live session.

So the segment is `state.segment`, the holding card is `state.holding`, the
standings are `state.standings`, and the participant's own points strip is
`state.own`. That last one is present only for a participant, and while the
session is sealed the key is left out of the object altogether.

### Client to server

`hello`, `resync`, `ping`, `host.cmd`, and one frame per thing a participant can
do: `trivia.answer`, `arcade.answer`, `arcade.tap`, `arcade.step`,
`arcade.shape`, `arcade.letter`, `arcade.docs`, `arcade.beat`, `arcade.back`.

`hello` is three shapes, one per role: `{ role: "participant", joinCode,
nickname, rejoinToken? }`, `{ role: "host", hostToken }`, `{ role: "screen",
screenToken }`.

**None of the participant frames carries a timestamp**, and that is the single
most repeated decision in `protocol.ts`. The server measures every instant that
is worth points from its own clock and its own latency estimate for that
socket. That includes how fast a trivia answer arrived, whether a tap landed
before the state lock, and how long a runner took to choose a pane. A
client-supplied `at` would be a number worth points, which is a number worth
forging.

### Trivia

**There is no `trivia.*` message family.** This section used to sketch one,
made of `trivia.open`, `trivia.count`, `trivia.reveal`, and `trivia.mine`. It
was not built, for two reasons.

The first is that Phase 1 already decided a broadcast means "re-send the
projection for that role". Four delta message types alongside that would be
the same second path to a stale surface that a segment frame would have been.

The second is that the sketch broadcast too widely. `trivia.open` and
`trivia.count` were `S→all`, and `trivia.reveal` carried `distribution` to
everyone, but DESIGN says the distribution is a Desktop thing, and SPEC
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
leak. It waits for the phone's own tap, because a number that climbs while
somebody is still reading the question puts them on a second clock. After the
tap it is the only thing on the phone that moves. DESIGN had put it only on the
console and the Desktop, and on a video call the Desktop is the tile nobody can
read.

The rule is enforced by **leaving the field out**: a field a role may not see
is absent from the object, so `JSON.stringify` never writes the key and the
word does not appear in the bytes on that socket. A null field would still
write the key. Leaving it out turns "was it sent?" into a property of the wire
that a test can assert against a raw frame, so no renderer has to remember to
hide it.

`triviaMine` is a three-state union of `unanswered`, `locked`, and `revealed`,
so the locked state has no correctness field to forget to strip.

Client to server is one message:

```jsonc
// C→S
{ "t": "trivia.answer", "cid": "a8f2", "index": 7, "choice": 2 }
```

It has no timestamp. The server times the tap itself and corrects it for that
socket's measured round trip; see "Clocks and fairness" below.

The `state` for a participant mid-question includes whether they have
answered, so a reload during a question shows "locked in" and keeps the answers
hidden.

### Arcade

The arcade is one segment with a round-level state machine inside it. Like
trivia, it rides in `RenderState` and has no frames of its own: one
`arcade` block projected per role, plus a participant-only `arcadeMine`.

`ArcadeView` carries the envelope every round shares: `round`, `roundIndex`,
`phase` (`idle`, `card`, `running`, or `reveal`), `startedAt`, `endsAt`, the
`grid` of players, and how many are `onFloor` and `inLounge`. It then carries
exactly one optional round block, which is one of `recruitment`, `planApply`,
`unseal`, `tug`, `gganbu`, or `glass`. `ArcadeMine` is the same idea for one
player: their player number, standing, banked and total, who they are backing,
and the same one-of-six round block cut for them.

**All six designed rounds are built.** Gganbu was the last, and its content
held it back after its wiring was done. The pairing, wagers, and scoring were
in the engine while `arcade.round` had no `gganbu` variant, because six
prompts that every player knows produce six tied pairs. The prompts were
rewritten and the round finished, so SPEC.md's round table and what a session
can play are now the same list.

Gganbu is also the sharpest case of the projection rule below. A wager is a
pick *and* a stake, and it must reach nobody but the player who made it until
the prompt settles. So `gganbuFloorView`, the round's only public view,
carries only a **count** of who has wagered and never the map of wagers. The
wagers are absent from the value every projection is handed, so nothing has to
filter them out of frames on the way past, and a careless object spread cannot
leak them.

**"Public" here means what the Desktop and the host see.** A participant gets
less. The projection is per role and enforced by leaving a field out, so a key
a participant may not have never appears in its bytes.

The field that decides Plan / Apply is the epoch of the *next* light change. A
client holding it can tap flat out, stop 401 ms before every lock, and never be
caught, so it goes to the screen and the host only, with its 400 ms telegraph.

The resource counts are handled differently, because they are not a secret:
SPEC.md names this round's finish order as its example of a Floor being a
public surface. The screen and the host get `leaders`, the top five on the
Floor, which is what the light's ticker draws. That is less than
`finishOrder` says, because a runner on 119 has not crossed and the next lock
can still catch them. A participant gets its own count, and one number about
one other person: `backedResources`, the count of the runner they have already
bet on, so the Lounge card can show them their own stake. That is one runner,
the one they chose, and never the whole board. The engine enforces the bet's
timing either way: `betStands` refuses a bet placed after the crossing it is
betting on.

**The Glass Bridge's public payload is the whole game, so three things are
deliberately absent from it.**

The answer key never travels: each step is split at `startRound` into a
showable half (the product and the two labels) and a key (which pane is real,
and *both* notes, because the fake's note says why it is fake, so it is the
answer too). Nothing outside the reveal may read the key.

`broken` is written only when a step **closes**, never as a player falls. With
two panes, "the left one broke" is "the right one is real", so publishing a
break live would hand the answer to everyone still standing on that step. By
the time an entry is non-null, everyone who could have used it has stepped,
which is what waves 2 and 3 are promised and no more.

No per-player pane choice appears anywhere, because **a pane that held
identifies the real pane just as completely as a pane that broke**. The engine
does not store one: a pane that holds advances you and a pane that breaks
drains you, so a position is a count and nothing can be joined back to a pane.

There is also no screen-only secret here, because the Desktop is in the room.
A participant's view must therefore be a *subset* of the public one and cannot
be a different cut of it.

**Input is one frame per thing a player does:**
`arcade.answer`, `arcade.tap`, `arcade.step`, `arcade.shape`, `arcade.letter`,
`arcade.docs`, `arcade.beat`, `arcade.back`. A single `arcade.input` carrying a
`kind` was the earlier sketch and would have made every round's payload
optional on every other round's frame. With separate frames, the parser rejects
a pane choice sent during Unseal and the engine does not have to.

Each of them carries the `round` it was meant for, and the ones that can cross
a boundary carry the item or step as well, for the reason `trivia.answer`
carries an index. A frame in flight when the host advances is a commitment to
something the player never saw, and the engine refuses it rather than applying
it to whatever is open now.

**Taps, as built.** This section used to describe batching ten taps into one
frame per 100 ms carrying a *client* timestamp, and a 10 Hz broadcast. Neither
exists, and the client timestamp in particular should not. The server times the
tap itself, as it does a trivia answer, because a client timestamp is a number
the player's own device chooses about whether they beat the lock.

What is built: one `arcade.tap` per tap, and in Plan/Apply **an ordinary tap
produces no broadcast and no write at all**. Only a milestone (a checkpoint, a
crossing, a drain, or a light turn) moves points or the room's state, and only
those fan out. The client counts optimistically in between, so the button
responds to each tap without waiting for the server.

Sixty players tapping flat out is therefore ~600 inbound messages a second and
close to nothing outbound, which is the opposite way round from the design
above and the reason it was abandoned.

**Tug of Raft is the exception, and it batches broadcasts on a short tick.** A
beat is credited when it lands on the beat, once per beat, and outside an
election. A credited beat is a state change the rope has to show, so `tapBeat`
does return broadcasts, to the player who tapped, the host, and the screen,
and never `to: "all"`. Thirty players at 100 bpm is around fifty credits a
second, and a fan-out for each would be some fifteen hundred frames a second
to move a rope by a pixel. So `SessionRuntime` holds those audiences and sends
each of them at most one frame per `BEAT_FLUSH_MS` (120 ms, about a fifth of a
beat). The window opens on the first beat it holds and is not re-armed, so a
room that never stops tapping still gets a frame every tick. The engine credits
the beat the instant it lands either way, and the tick decides only when the
*picture* goes out, which is why it lives at the boundary instead of in the
reducer. A credited beat also appends an event row; the snapshot write that
follows it coalesces in the `Persister`, so the rope writes one snapshot at a
time instead of one per beat.

### Host

One frame carries every console button:

```jsonc
// C→S
{ "t": "host.cmd", "cid": "h41", "cmd": { "name": "trivia.open", "suddenDeath": false } }
{ "t": "host.cmd", "cid": "h42", "cmd": { "name": "holding",
  "title": "Agentic Security TTX", "line": "Ade has the room. Back here at 2:40." } }
{ "t": "host.cmd", "cid": "h43", "cmd": { "name": "seal", "state": "sealed" } }
{ "t": "host.cmd", "cid": "h44", "cmd": { "name": "participant.release", "pid": "p07" } }
{ "t": "host.cmd", "cid": "h45", "cmd": { "name": "score.set", "activityId": "ttx",
  "pid": "p12", "raw": 17 } }
```

The command is an object with a `name`, so each command's own arguments are
typed with it, and a command that needs none is `{ name }` and nothing else. A
bare string with sibling fields could not be typed that way. `cmd` is `null`
when the frame could not be parsed. The frame still arrives, so the server can
answer `refusedCmd` on that `cid`, because a console that gets silence cannot
tell a rejected click from a dropped one.

`HostCommand` in `protocol.ts` is the list. Grouped by what they do:

| Group | Commands |
| --- | --- |
| Session | `open`, `start`, `close`, `session.reopen`, `session.restart` |
| Room | `segment`, `holding`, `seal`, `practice`, `lobby.lock` |
| People | `participant.kick`, `participant.release` |
| Scoring | `score.set`, `score.status` |
| Trivia | `trivia.open`, `trivia.close`, `trivia.reveal`, `trivia.next` |
| Arcade | `arcade.enter`, `arcade.round`, `arcade.begin`, `arcade.next`, `arcade.nextStep`, `arcade.nextWave`, `arcade.nextPull`, `arcade.end`, `arcade.reveal` |
| Send-off | `sendoff.next`, `sendoff.back`, `sendoff.auto`, `sendoff.speed` |

**`session.restart` carries `confirm`**, which must be the session's own join
code, and the server refuses the command without it. The socket already
belongs to the host, so this is not authentication. It stops a frame that only
names the command from firing it. Every other command is expressible as a
bare `{ name }`, which is acceptable for a command that shows a holding card
and not for the command that restarts the whole session.

**`arcade.round` carries settings and never content.** The emoji items, the
eighteen panes, and the tins all live on the server and are attached when the
round starts. A round config on the wire would be the answer key leaving the
server on a frame the console could be made to echo.

Host commands that would be destructive from the wrong state are refused with a
`refusedCmd` that explains why, and the console shows the refusal inline, in
the button.

The host and the screen receive everything participants receive, and receive the
answered count unconditionally where a phone waits for its own tap; the host
alone receives per-participant answer state. The host sees *who*
has answered and never *what* they answered. The console's job is to decide
whether to wait, and a grid of choices would be the answer key on a screen the
host sometimes shares by accident. The per-role table under "Trivia" above is
the authority on which is which.

### Clocks and fairness

All timing comes from the server's clock. Every timed thing is sent as an
absolute server epoch (`closesAt`, `lightChangedAt`, `beatEpoch`), never as
"20 seconds from now", so a client that receives the message late still counts
down to the right instant.

Clients estimate their offset with `ping { t0 } → pong { t0, t1 }` every 10
seconds and take the median of the last five. The countdowns you see are
`closesAt − (Date.now() + offset)`.

For **scoring**, the server never trusts a client timestamp. Response time is
`serverReceivedAt − opensAt − min(rtt ÷ 2, 250 ms)`, where `rtt` is the
server's own recent measurement of that socket. Without the cap, a client on a
bad connection could be *advantaged* by a large correction. With it, the worst
case is a quarter-second gift that applies equally to everyone on a poor link.
The red-light grace in `plan_apply` is the same number for the same reason,
except in a round's first two locks, which give 600 ms so the opening is
forgiving while the room learns the light.

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
| `POST` | `/api/sessions` | admin key | Creates a session; optional `activities` (the event's own scored set, validated all-or-nothing, rejected as `invalid_activities` with errors addressed by position; absent means the default set) and an opaque `setup` blob the console reads back; returns `sid`, `joinCode`, and the host and screen tokens (shown once) |
| `GET` | `/api/sessions` | admin key | Every session this task holds: sid, title, join code, phase, segment, counts, and age. Never the tokens |
| `POST` | `/api/sessions/:sid/close` | admin key | Retires a session. Refuses one with sockets attached unless `?force=1` |
| `POST` | `/api/sessions/:sid/content/trivia` | host | JSON question file; validates and replaces the set; rejects with `invalid_questions` and errors addressed by question number |
| `POST` | `/api/sessions/:sid/content/sendoff` | host | The send-off file. It holds keys only, and the photos follow, one request each |
| `POST` | `/api/sessions/:sid/content/promo` | host | The promo card, one self-contained HTML page |
| `POST` | `/api/sessions/:sid/assets/<key>` | host | One send-off photo or the music file, as bytes |
| `GET` | `/api/sessions/:sid/assets/<key>` | — | That asset back, for the Desktop to draw. No token; see below |
| `GET`/`HEAD` | `/api/sessions/:sid/promo` | — | The promo card. No token; the Desktop sends `HEAD` to ask whether there is one to frame |
| `GET` | `/api/sessions/:sid/setup` | host | The staged console setup, as the text it arrived as. The console asks once, on load |
| `GET` | `/api/sessions/:sid/export.csv` | host | The scoresheet: `Name, <Activity> Raw, <Activity> Pts, …, TOTAL` |
| `GET` | `/api/sessions/:sid/events.jsonl` | host | The event log, for disputes |
| `GET` | `/healthz` | — | `200 { ok, sessionsLive, socketsOpen, version, store, persist }` |
| `GET` | `/status` | — | Plain-text version of the above, for humans |
| `GET` | `/`, `/j/:code`, `/host`, `/screen` | — | The three client shells; `/j/:code` is the participant page with the code prefilled |

**Two reads carry no token, on purpose.** An `<iframe>`, an `<img>`, and an
`<audio>` cannot carry an `Authorization` header, and the promo card and the
send-off assets are exactly those three elements' sources on the Desktop.

That is acceptable for these and nowhere else in this service because of what
they are: a poster and a montage the room is seconds away from watching on a
shared screen. They hold no scores, no roster, and no names. It still takes an
unguessable session id to ask, and a session with no card answers exactly as an
unknown session does, so it is not a session-id oracle either. Everything that
*writes* them needs the host token.

**`/healthz` stays `ok` while persistence is degraded.** The session is still
playable, and pulling the task out of the load balancer would end it, which is
far worse than a gap in the audit trail. A degraded store shows up in the
`persist` block.

**Unknown session and wrong token answer alike**, everywhere here, because a
404 that appears only for a real sid is a session-id oracle.

**Auth.** Three bearer tokens, all compared by hash in constant time: the
**admin key** (one, from SSM, creates and retires sessions), the **host token**
(per session, in the console URL fragment so it never hits a log), and the
**screen token** (per session, view-only). Tokens are 128-bit random, base32;
the join code is separate and is `hvs.` plus 24 base62 characters. There are no
user accounts, as specified. Participant identity is the rejoin token issued at
`hello`. That is the whole security model, and it is proportionate to a team
quiz.

Rate limits: `hello` at 10 per minute per address; `/api/sessions` at 10 per
hour. Behind the ALB the socket's peer address is one ENI for the entire room, so
the task is told to read `X-Forwarded-For` instead. See `QUORUM_TRUST_PROXY` in
the task definition and `clientAddress` in `server/address.ts`.

Nicknames are ≤ 24 characters, are stripped of control characters, and are
always rendered as text and never as HTML.

## Durability and restart

While the process runs, the in-memory state is authoritative, and DynamoDB
holds enough of it for a restart to be survivable.

**On every reducer transition** the driver writes the new `SNAPSHOT` and the
`EVENT#` that caused it, in that order, asynchronously, with in-order
delivery per session. Participant inputs during a hot round (taps) are
folded into the snapshot and are not logged individually, because a tap is not
an audit event. An answer is, so answers are logged.

**On start** the process scans for sessions in `draft`, `lobby`, `running`, or
`closed`, loads each `SNAPSHOT`, replays any `EVENT#` with `seq` greater than
the snapshot's (there should be none or one), marks everybody the snapshot
thought was present as `away`, and re-arms timers from the state: a `closesAt`
in the past fires immediately, and one in the future is scheduled. All of this
happens before the port opens.

**An open trivia question is the exception: its clock stops.** The process is
up well before the ALB has seen it healthy, so a deadline re-armed at boot
used to close the question before any phone could get back to it. Recovery
instead applies `pauseQuestion` at the newest instant the rows prove the old
process was alive (`lastAliveAt`: the snapshot's write time, or a later
event's), which keeps the elapsed and remaining time and clears `closesAt`. The
first participant to reconnect applies `resumeQuestion`, and the question
carries on with the time it had left, never less than five seconds. A question
whose deadline had already passed is not paused and closes as before. The
arcade's clocks are not paused; a round in flight still re-arms from the
state.

**The snapshot says which shape it is.** `version` is the writer's
`SNAPSHOT_VERSION` and `at` is the writer's clock, and recovery reads both. A
field added to a round in flight arrives missing on every row written before the
deploy, so recovery carries a migration per field. The version lets that
migration say what it is looking at, and lets it be retired on evidence from
the table. `recoverSessions` logs the vintage of everything it loaded at
every boot, and `server/recovery.ts` has the procedure under `RETIREMENT`. The
version never decides *whether* a migration runs. A row written before this was
read back has no version at all, so the absent field is what triggers the fix,
and the version only gets to say the row was surprising.

`draft` and `closed` are in that list because both were left out once and both
cost a session. A host sets an event up the day before, which is exactly the
gap `draft` covers, and `reopen` exists to undo an accidental close, which a
restart would otherwise make permanent. In both cases the rows were still in
the table and the export still worked, while the console got `bad_token` for a
link that was correct; see the comment on `loadRecoverable`.

**On SIGTERM** (ECS stop, deploy) the process stops accepting `hello`, writes
final snapshots, closes every socket with code `1012 Service Restart`, and
exits. ECS gives it 30 s. Clients treat `1012` as a reconnect, backing off
300 ms, 800 ms, 1.6 s, 3.2 s, 6.4 s, and then every 10 s, and the rejoin token
gets them back as themselves. A client also tries at once when the tab wakes,
so nobody waits out a backoff their phone slept through.

**What a mid-game restart looks like from the room.** For roughly twenty
seconds (task stop, new task pull and start, and health check), surfaces show
the reconnect banner. Then everyone is back on the same segment. If a trivia
question was open, the snapshot has the answers received before the process
died, and the question waits, paused, until the room is back (above). A phone
keeps its last trivia tap until a `state` shows the server holding it, and
sends it again on the first `state` after a reconnect if the same question is
still open with nothing from it. A tap made into the gap, or accepted by a
process that died before writing it, still counts. The scoreboard is never
inconsistent, because scores are derived from persisted events.

**There is no re-ask.** This paragraph used to promise one, with a flag on the
affected question and a button to ask it again, and none of it exists. There is
no event in the engine, no command on the wire, and nothing in the console that
counts how many answers a gap swallowed. A host who loses answers to a restart
is holding a question that scored some of the room and not the rest, and the
only tool for that is the one any other scoring problem uses: `score.set` for a
raw number, or `score.status` to clear the cell back to `unset`. This is stated
here because a host who expects a re-ask button would go looking for it during
a live session.

**What is not durable.** Socket-level state (who is connected) is rebuilt
from reconnects, and rate-limit counters reset. Neither needs to survive a
restart.

## AWS topology

| Resource | Choice | Why |
| --- | --- | --- |
| Region | `ap-southeast-2` (Sydney) | Where the host usually is; the latency correction handles the rest of APJ |
| VPC | One, two public subnets across two AZs, **no NAT gateway** | The task needs egress to DynamoDB, ECR, and CloudWatch. A NAT gateway costs ~$45/month and would only buy a private subnet. Instead, the task sits in a public subnet with a public IP and a security group that accepts traffic **only from the ALB**. The exposure is the same, and the bill is a third |
| ALB | Internet-facing, HTTPS only, HTTP→HTTPS redirect, idle timeout 3600 | WebSockets need a Layer 7 proxy that supports the upgrade. ALB does, and NLB would need TLS on the task |
| ACM | Certificate for `quorum.<domain>`, DNS-validated | |
| Route 53 | A/AAAA alias to the ALB | |
| ECS | One cluster, one Fargate service, desired count 1, 0.5 vCPU / 1 GB, `minimumHealthyPercent 0`, `maximumHealthyPercent 100` | Two tasks must never run at once, because the second would have an empty memory and the ALB would send it new sockets. The 0/100 setting makes a deploy stop the old task before starting the new one, which is the correct order for a service with a single writer |
| ECR | One repository, images tagged `sha-<short>`, lifecycle rule keeps the last 20 | |
| DynamoDB | One table, on-demand, TTL enabled, PITR on | On-demand because the traffic is two hours of writes then nothing |
| SSM Parameter Store | `/quorum/<env>/admin_key` SecureString | Injected into the task via the task definition's `secrets`, so the container sees an env var and the value never enters Terraform state |
| CloudWatch | Log group, 30-day retention; Container Insights at `enabled` (the standard level; enhanced is off); one alarm on `RunningTaskCount < 1` | No custom metrics are emitted. Open sockets and store health are on `/healthz` and `/status`, because those are what a host in front of the room checks. Nobody would open a dashboard during the two hours of an event, so one was not worth the code |
| IAM | Task execution role (pull image, read SSM, write logs); task role (DynamoDB on the one table) | Least privilege is cheap here because there are two roles |

The design leaves out CloudFront (the static bundle is 200 KB and served by the
same process), WAF, Auto Scaling, and a second region.

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

**There is one environment, with one workspace and one apply.** `infra/` is
the root and is the HCP Terraform workspace `quorum`, CLI-driven: a human runs
`make deploy` or `make up` and HCP Terraform executes the apply.

There was a second workspace for the registry and the OIDC providers. The
providers are gone (see below), and a registry alone did not justify a second
apply, a second variable set, and a cross-workspace lookup, so the repository
moved into `infra/ecr.tf`. The cost is that `terraform destroy` now takes the
images with it. The service is parked at zero between events and is rarely
destroyed, so that seldom happens.

There is also no staging environment. It appeared in this document as
`envs/staging` with its own workspace, and it was never built. One event a
month gives no release schedule that needs a staging run, and a second
always-on ALB would cost the same $20 a month as the real one. Changes are
tried with `npm run dev` and the bot harness.

The workspace is deliberately **not** VCS-connected, and `versions.tf` sets out
why at length. The main reasons are that the CLI uploads a gitignored
`terraform.tfvars` that a VCS run would not have, `image_tag` has no default on
purpose, and `desired_count` defaults to 1, so a VCS run would quietly raise a
parked service.

## Delivery

The original design here was OIDC federation: HCP Terraform to AWS, GitHub
Actions to AWS, no stored credential anywhere, and the image tag as a Terraform
variable so a deploy was an apply. It is a good design, but it does not run
here, because the account it deploys into forbids the identities it needs.
`iam:CreateOpenIDConnectProvider` and `iam:CreateUser` are both an explicit
deny, and the account holds 0 users and 0 identity providers against 46 roles.

That is a deliberate policy, under which only humans with a current session act
in that account. No machine identity can satisfy it, including the "just store
an access key" fallback, because there is no user to hold a key.

**So the deploy is `make deploy`, run by a person with an eight-hour session.**
Runs still execute in HCP Terraform, and only the way its workers get AWS
credentials has changed. Instead of a federated identity, doormat pushes a copy
of the operator's STS session into a variable set (`awscreds`, then
`tfawscreds`), and it expires with that session. That means a credential
refresh before every apply, which is worse than OIDC's lack of any stored
credential, and it was the only option the account left open.

`make up` and `make down` raise and park the service around an event. The image
tag is still a Terraform variable and the apply is still the deploy, so the task
definition keeps one owner and a deploy is still a reviewable diff. Only the
holder of the credential changed.

**CI stays, and needs no credential**: typecheck, tests, `terraform fmt` and
`validate`, and a container build that proves the Dockerfile compiles. That is
most of what the pipeline was worth, and a fork's PR runs all of it.

Losing deploy-on-merge costs little. Quorum runs two hours a few times a year,
so there is no release cadence to automate, and someone has to be present to
raise the service before an event anyway.

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

**`npm run build:client` is required.** The server serves `dist/client`,
and without it the process starts, answers `/healthz`, and returns
`client_not_built` for every page. `npm run dev` watches only the server.
`npm run watch:client` watches the clients, and `npm run client:dev`
builds them and serves them on their own.

Tests run under **`node --test`**, with `--experimental-strip-types` so Node
reads the TypeScript directly. There is no test framework here and no `vitest`,
for the reason there is no bundler: the runtime already does it. A fake clock is
a number passed to `reduce`, because `reduce` cannot read one.

The bots cover failure modes that two browser tabs never show and that hurt in
a live room, such as thirty joins at once, a duplicate nickname, or a late
arrival with a zero in the activity they missed. A bot swarm is also the only
rehearsal a host can run alone.

**The bots are not a load test and cannot be pointed at a deployment.** They
have no network layer at all: events go straight into `reduce`, the clock is a
counter, and the whole run is in one process. They prove the engine behaves at
real headcount. The swarm (`npm run swarm`,
[docs/smoke-test.md](docs/smoke-test.md)) tests the socket path, with real
WebSockets against a running server, far-away players on an added delay and
jitter, and a restart in the middle that every socket has to come back from.

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
zero and leaves the ALB as the floor at ~$20. Going lower means dropping the
ALB and putting TLS on the task, behind a public IP that changes on every
restart, and that operational cost is not worth the saving.

Quorum replaces a Kahoot licence and an afternoon of the scorekeeper's time.
