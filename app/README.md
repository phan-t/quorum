# The Quorum service

This is the TypeScript service that [SPEC.md](../SPEC.md) specifies. Phases 0–4 of
[BUILD-PLAN.md](../BUILD-PLAN.md) are built: the game engine, the server, the
three browser clients, the store, and the staging and operations scripts. It
has been deployed and has run a live session. Phase 5 is operations work,
and it is not finished. The load test at twice headcount, the
rehearsal with people who are not the author, and the participant-facing
explanation of how scoring works are all still open.

## Prerequisites

- **Node 24.** Node runs TypeScript directly by stripping the types, so the
  server has no build step and there is no bundler anywhere. Node 22 works with
  the same `--experimental-strip-types` flag the scripts already pass.
- **Docker**, for DynamoDB Local. It is optional, because without it the server
  runs with an in-memory store and logs that it is doing so.

Local development never uses AWS credentials. See [Persistence](#persistence).

```
app$ npm install
app$ npm run build:client     # the browser cannot run .ts; tsc emits dist/client
app$ npm run dev              # server on :3000
```

**`build:client` is the only build step, and it is the one most likely to be
skipped.** The server serves `dist/client`. Without it, the process starts,
answers `/healthz`, and returns `client_not_built` for every page. `npm run
dev` watches only the server, so run `npm run watch:client` as well to rebuild
the clients.

## Scripts

| | |
| --- | --- |
| `npm run bots -- 30` | Drives 30 simulated participants through a whole session against the reducer, in memory, and prints a readable summary. `--seed <n>` replays a run exactly; `--seed random` picks one and prints it |
| `npm test` | The whole suite, covering the engine, server, clients, and importers, on Node's own test runner |
| `npm run test:watch` | The same, re-run on save |
| `npm run typecheck` | `tsc --noEmit`. Node strips types without checking them, so this is the only thing that does |
| `npm run build:client` | Compiles the three clients into `dist/client` and copies their HTML and CSS |
| `npm run watch:client` | The same, on save |
| `npm run client:dev` | Builds the clients and serves them on their own, against the mock |
| `npm run dev` | The server on `:3000`, hot-reloading, persisting to DynamoDB Local |
| `npm run dev:memory` | The same with no store at all, for when you do not want a container |
| `npm start` | The server with no watcher, which is what the container runs |

## Persistence

The in-memory state is authoritative while the process runs. The store lets
the session survive a restart: every accepted event rewrites the session's
`SNAPSHOT` and appends an `EVENT#`, and on boot the process recovers every
session in `draft`, `lobby`, `running`, or `closed` before it opens its port.
`draft` and `closed` are in that list because a session set up the day before,
and one closed by accident, both have to survive a restart. The comment on
`loadRecoverable` explains this.

```
app$ docker compose up -d     # DynamoDB Local on :8000
app$ npm run dev              # creates the table, then serves
```

Which store is used comes from the environment, and the default is the one that
needs nothing:

| | |
| --- | --- |
| *(nothing set)* | In-memory, which is what `npm test` and the bot harness run against |
| `QUORUM_STORE=memory` | In-memory, explicitly |
| `QUORUM_ENV=local` | DynamoDB Local on `:8000`, table `quorum-local`, **created on boot** |
| `QUORUM_TABLE=<name>` | DynamoDB, resolved normally. In production, Terraform creates the table and the task role supplies the credentials |

`QUORUM_DYNAMO_ENDPOINT` overrides the endpoint if DynamoDB Local is not on
`:8000`. There are no credentials in the code; the local path signs with a pair
of throwaway values because DynamoDB Local rejects an unsigned request.

A store that will not answer at boot is logged and the process falls back to
memory instead of refusing to start. A write that fails mid-session is
counted, logged once per streak, and shown on `/healthz`. The session keeps
playing, because losing durability costs less than losing someone's answer.

**The host's two exports**, both `Authorization: Bearer <host token>`:

```
GET /api/sessions/:sid/export.csv      Name, <Activity> Raw, <Activity> Pts, …, TOTAL
GET /api/sessions/:sid/events.jsonl    the event log, for settling a dispute
```

### The bot harness

Each unit test checks one rule. The bot harness checks that the rules hold
together for a whole session at the headcount of a real huddle, with thirty
joins, awkward nicknames, a late arrival taking a zero, a seal before the last
activity, and a reveal. It is the only test of that size, because a rehearsal
with thirty people is not practical and two browser tabs do not produce a
duplicate nickname.

**It has no network layer**, which bounds what it proves. Events go straight
into `reduce`, the clock is a counter, and the whole run is in one process, so
it cannot be pointed at a deployment and is not a load test. Thirty concurrent
sockets, a burst of reconnects during a deploy, and a flood of taps over a real
link are not exercised here or anywhere else.

It is deliberately loud about **rejected** events. `reduce` refuses an event by
returning a `reject` effect and leaving `seq` alone, and every other caller, including
the server, the console, and the client, is likely to treat a refusal as a
success. The harness counts refusals, prints them with their
reason, and asserts that nobody whose join was refused appears in the standings.
Read the checks at the end of the report first. A non-zero exit means one of
them failed.

## Layout

```
src/
├── protocol.ts       # the wire, shared by the server and all three clients.
│                     # Every frame's type, and the only parser of inbound bytes
├── engine/
│   ├── types.ts      # the domain: Event, Effect, SessionState. No behaviour
│   ├── scoring.ts    # SCORING.md as code: normalisation, ranking,
│   │                 # the tiebreak
│   ├── reducer.ts    # reduce(state, event, now) -> {state, effects}, and replay
│   ├── trivia.ts · arcade.ts · sendoff.ts · tiebreak.ts
│   └── *.test.ts     # the rules, with a fake clock
├── arcade/           # the rounds' content: emoji items, tins, panes, prompts.
│                     # Ships in the container and is attached when a round starts
├── trivia/ · sendoff/ · activities/
│                     # importers for the files an event supplies. Unknown keys
│                     # are errors; every rejection is addressed to an entry
├── server/
│   ├── main.ts       # HTTP + WebSocket, boot, recovery-before-listen, exports
│   ├── runtime.ts    # the driver: sockets in, effects out. No game rules
│   ├── views.ts      # the per-role projections. What each surface may know
│   ├── persist.ts    # the `persist` effect's write path: per-session, in order,
│   │                 # never on the game's critical path
│   ├── recovery.ts   # snapshot + replay on boot, and everyone marked away
│   ├── export.ts     # the scoresheet and the event log
│   ├── tokens.ts     # the three bearer tokens and the join code
│   ├── address.ts    # the joiner's address behind the load balancer
│   └── store/        # memory and DynamoDB behind one interface
├── client/
│   ├── participant/  # the page everyone playing is on
│   ├── host/         # the console. Not screen-shared
│   ├── screen/       # the Desktop. A pure output
│   └── shared/       # the socket, the DOM helpers, the tokens, and the mock
│                     # that lets all three run with no server
└── bots/
    └── simulate.ts   # thirty simulated participants, straight into `reduce`
```

The clients import `engine/types.ts` and `protocol.ts` for their **types** and
nothing else. They do not run the reducer: the rules have one implementation,
on the server.

Imports carry explicit `.ts` extensions, because that is what Node resolves at
runtime, and `rewriteRelativeImportExtensions` stops `tsc` rejecting them.

## Why the engine is a pure reducer

`reduce(state, event, now) -> {state, effects}` does no I/O, reads no clock,
and uses no randomness: `now` arrives on the call and anything generated arrives
on the event. The reducer only *describes* its effects, such as broadcasting,
persisting, or rejecting an event, and the caller performs them.

Three properties follow from that, and each would be harder to add later.

**Replay.** A session is its event log. If the host's laptop dies twenty minutes
into a huddle, the event ends unless the session can be recovered. Recovery is
`replay(newSession(...), events)`, which runs the same function again and
produces the same state. That only holds while the reducer cannot read a clock or a random
number, which is why `now` is a parameter instead of a call.

**Testability.** The rules need the most testing, and browsers make tests
slow. A scoring rule is a function call with a fake clock, and thirty
participants playing a full session is this harness, in milliseconds. If the
rules lived in request handlers they would need a server, a socket, and a
database to ask what happens when two people tie.

**One implementation of the rules.** The plan here was for the clients to run
the same reducer for optimistic UI, but they do not. They import its types and
nothing else. There is exactly one implementation of the scoring rules, and it
is on the server. With a second copy on the other side of the socket, the two
would eventually disagree, and the disagreement would show up in front of
thirty people.

Where a surface has to respond instantly, such as the tap counter in Plan / Apply, it
counts optimistically in the browser and lets the next broadcast correct it.
That counter holds no scoring rules, and it cannot invent points because the
server never reads it.

The cost of this design is that nothing in `engine/` acts by itself, because
every effect needs a caller to perform it. `server/runtime.ts` is that
caller.
