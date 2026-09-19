# Quorum — the service

The TypeScript service behind [SPEC.md](../SPEC.md). Today it is Phase 0 of
[BUILD-PLAN.md](../BUILD-PLAN.md): the game engine and the bot harness that
proves it. There is no server, no client and no database yet.

## Prerequisites

- **Node 24.** Node runs TypeScript directly by stripping the types, so there
  is no build step and no bundler in the loop. Node 22 works with the same
  `--experimental-strip-types` flag the scripts already pass.
- **Docker**, for DynamoDB Local. Optional: without it the server runs with an
  in-memory store and says so.

No AWS credentials, ever, locally. See [Persistence](#persistence).

```
app$ npm install
app$ npm run bots -- 30
```

## Scripts

| | |
| --- | --- |
| `npm run bots -- 30` | Drives 30 simulated participants through a whole session against the reducer, in memory, and prints a readable summary. `--seed <n>` replays a run exactly; `--seed random` picks one and prints it |
| `npm test` | The engine's unit tests, on Node's own test runner |
| `npm run test:watch` | The same, re-run on save |
| `npm run typecheck` | `tsc --noEmit`. Node strips types without checking them, so this is the only thing that does |
| `npm run dev` | The server on `:3000`, hot-reloading, persisting to DynamoDB Local |
| `npm run dev:memory` | The same with no store at all, for when you do not want a container |

## Persistence

The in-memory state is the truth while the process runs. The store is what
makes a restart survivable: every accepted event rewrites the session's
`SNAPSHOT` and appends an `EVENT#`, and on boot the process recovers every
session in `lobby` or `running` before it opens its port.

```
app$ docker compose up -d     # DynamoDB Local on :8000
app$ npm run dev              # creates the table, then serves
```

Which store is used comes from the environment, and the default is the one that
needs nothing:

| | |
| --- | --- |
| *(nothing set)* | In-memory. What `npm test` and the bot harness run against |
| `QUORUM_STORE=memory` | In-memory, explicitly |
| `QUORUM_ENV=local` | DynamoDB Local on `:8000`, table `quorum-local`, **created on boot** |
| `QUORUM_TABLE=<name>` | DynamoDB, resolved normally. Production: the table is Terraform's, the credentials are the task role's |

`QUORUM_DYNAMO_ENDPOINT` overrides the endpoint if DynamoDB Local is not on
`:8000`. There are no credentials in the code; the local path signs with a pair
of throwaway values because DynamoDB Local rejects an unsigned request.

A store that will not answer at boot is logged and the process falls back to
memory rather than refusing to start. A write that fails mid-session is
counted, logged once per streak, and shown on `/healthz` — the session keeps
playing, because losing durability is better than losing someone's answer.

**The host's two exports**, both `Authorization: Bearer <host token>`:

```
GET /api/sessions/:sid/export.csv      Name, <Activity> Raw, <Activity> Pts, …, Spot Awards, TOTAL
GET /api/sessions/:sid/events.jsonl    the event log, for settling a dispute
```

### The bot harness is the test that matters

Unit tests prove a rule. The bot harness proves the rules hold together for a
whole session at the headcount of a real huddle — thirty joins, awkward
nicknames, a late arrival, a facilitator on bench credit, a seal before the last
activity, and a reveal. Nobody is going to find thirty humans to rehearse with,
and two browser tabs do not produce a duplicate nickname or a phone that sleeps
during the arcade.

It is deliberately loud about **rejected** events. `reduce` refuses an event by
returning a `reject` effect and leaving `seq` alone, and the easy mistake for
every caller after this one — the server, the console, the client — is to treat
a refusal as a success. The harness counts refusals, prints them with their
reason, and asserts that nobody whose join was refused appears in the standings.
The checks at the end of the report are the bit to read first; a non-zero exit
means one failed.

## Layout

```
src/
├── engine/
│   ├── types.ts      # the domain: Event, Effect, SessionState. No behaviour
│   ├── scoring.ts    # SCORING.md as code: normalisation, Bench Credit,
│   │                 # Spot Awards, ranking, the tiebreak
│   ├── reducer.ts    # reduce(state, event, now) -> {state, effects}, and replay
│   └── *.test.ts     # the rules, with a fake clock
├── server/
│   ├── main.ts       # HTTP + WebSocket, boot, recovery-before-listen, exports
│   ├── runtime.ts    # the driver: sockets in, effects out. No game rules
│   ├── persist.ts    # the `persist` effect's write path: per-session, in order,
│   │                 # never on the game's critical path
│   ├── recovery.ts   # snapshot + replay on boot, and everyone marked away
│   ├── export.ts     # the scoresheet and the event log
│   └── store/        # memory and DynamoDB behind one interface
└── bots/
    └── simulate.ts   # the harness. The engine's first consumer
```

Imports carry explicit `.ts` extensions, because that is what Node resolves at
runtime; `rewriteRelativeImportExtensions` keeps `tsc` happy about it.

## Why the engine is a pure reducer

`reduce(state, event, now) -> {state, effects}`. No I/O, no clock, no
randomness: `now` arrives on the call and anything generated arrives on the
event. Effects are *described* — broadcast this, persist that, reject this one —
and someone else performs them.

Three things follow, and each of them is a problem this shape removes rather
than solves later.

**Replay.** A session is its event log. The host's laptop dying twenty minutes
into a huddle is the failure that actually ends an event, and recovery is
`replay(newSession(...), events)` — the same function, run again, producing the
same state. That only holds while the reducer cannot read a clock or a random
number, which is why `now` is a parameter and not a call.

**Testability.** The rules are the interesting part and browsers are the slow
part. A scoring rule is a function call with a fake clock, and thirty
participants playing a full session is this harness, in milliseconds. If the
rules lived in request handlers they would need a server, a socket and a
database to ask what happens when two people tie.

**One implementation of the rules.** The client will run the same reducer for
optimistic UI: apply the event locally, show the result immediately, and let the
server's broadcast confirm or correct it. A phone on hotel wifi feels instant
and still cannot invent points, because the server runs the same function over
the same events and its answer wins. Two implementations of the scoring rules,
one in the server and one in the client, would disagree eventually — and the
disagreement would surface in front of thirty people.

The cost is that nothing in `engine/` can do anything by itself. Every effect
needs a caller willing to perform it, and that caller does not exist yet. Phase
1 writes it.
