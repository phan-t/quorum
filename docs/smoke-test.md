# The swarm: a smoke test with real sockets

`npm run swarm` opens N real WebSockets against a running Quorum, joins them,
drives a session from the host's seat, plays it, and reports what the *clients*
saw. It is the rehearsal a host cannot run alone and the load test nothing else
in this repository performs.

```bash
# against a local server
cd app && QUORUM_STORE=memory QUORUM_ADMIN_KEY=localdev PORT=3000 \
  node --experimental-strip-types src/server/main.ts     # another terminal

# `make stage` targets the deployed host and needs AWS credentials, so a local
# session is staged by calling the script directly.
QUORUM_URL=http://localhost:3000 QUORUM_ADMIN_KEY=localdev \
  EVENT=2026-03-12-example-offsite node app/scripts/stage-event.mjs

cd app && npm run swarm -- 6 --url http://localhost:3000 \
  --code hvs.xxxx --host-token XXXX

# a whole event: host bot, Desktop, a late joiner, a reconnect
npm run swarm -- 6 --url http://localhost:3000 \
  --code hvs.xxxx --host-token XXXX --screen-token YYYY \
  --late 1 --churn 1 --questions 3

# against the deployed service, before an event
make up && make stage EVENT=<event>
npm run swarm -- 60 --url https://quorum.example.com --code … --host-token …
```

| Flag | |
| --- | --- |
| `--from-session` | play the staged event's own plan and timings |
| `--questions N` | how many trivia questions to play (default 5) |
| `--screen-token` | connect a Desktop and measure it |
| `--late N` | N bots arrive after the session has started |
| `--churn N` | N bots drop and rejoin on their token |
| `--stagger MS` | space the joins, to get past the join limit |
| `--seed N` | fixes each bot's choices, not the wall clock |

## Why it exists

`npm run bots` drives the reducer in memory. It is the right tool for the game
rules at headcount — normalisation, ties, Bench Credit, refused joins — and it
proves none of the following, because it opens no socket:

- twenty phones connecting at once, which is what a QR code on a screen
  produces
- broadcast fan-out and frame size, per socket
- the join rate limiter, which until recently keyed on the load balancer rather
  than the joiner and would have refused a room joining together
- the count that never reaches "20 of 20"

Those are the failures that hurt in a room, and they live between the phone and
the reducer. The swarm is the only thing that exercises that gap.

## What it does

**The host is a bot too, not a script.** It issues the same `host.cmd` frames
the console does — no driving mode, no test-only endpoint — and it waits on the
room rather than a clock: it closes a question when everyone who could answer
has, and leaves a round when the round has ended itself. A list of commands
with sleeps between them tests the server's willingness to accept commands in
an order somebody wrote down, which is not what a host does.

**It runs a whole event.** Lobby, a holding card, trivia, every arcade round,
sealed standings, Spot Awards, the reveal, the send-off and the final frame.
Every round plays because the point is that every round's *code* runs; a sample
leaves branches that typecheck and have never once executed.

**Or the event you are about to run.** `--from-session` reads the staged
console setup — the same blob the console loads — and plays that plan, at those
timings, with that holding card. The two modes answer different questions. The
default asks "does this build work" and sweeps every round fast. Rehearsing
asks "will Thursday work", and needs your three rounds at your clock rather
than five at somebody else's.

The setup is the console's own and the server never looks inside it, so the
swarm is the only thing asserting its shape. It treats every field as unknown
and falls back to the sweep, saying so, rather than quietly rehearsing a
different event from the one staged. A round it cannot drive — Gganbu, or
something a later console offers — is named and skipped, not passed over in
silence.

**Three surfaces.** A socket per bot, one for the host, and one for the Desktop
when `--screen-token` is given. The Desktop and the console both receive a full
state on every roster change, so they carry the heaviest frames — which is why
they are worth measuring and why leaving them out understates the load.

**People behave like people.** `--late` brings bots in after the session has
started, which is the Bench Credit path. `--churn` drops bots and reconnects
them on their `rejoinToken`, the path every event hits when a phone sleeps.

**Bots play by reacting to `state`.** No script of expected frames: a bot reads
the segment, the trivia phase, the arcade round and its own `arcadeMine`, and
acts. It answers a question at a randomised delay, taps during Plan / Apply,
picks a shape and taps letters in Unseal, picks a pane on the Bridge, types a
Recruitment answer, and backs a player when it is drained.

Each bot's *choices* come from a seeded PRNG, so `--seed` fixes which answer it
picks and which pane. It does not fix the run: tap trains and late presses are
wall-clock, so two runs on one seed give similar but not identical totals. The
network is the thing under test and cannot be made deterministic.

**It measures what the client saw, not what the server thinks.** The server's
own view is not evidence: a broadcast the server believes it sent and a frame a
phone actually received are different claims, and the gap between them is the
bug. Every number in the report is counted on a bot socket.

## What it reports

A run ends with a report in the shape `npm run bots` uses — numbers first, then
checks that pass or fail, so a bad run is legible without reading the numbers.

**Joining.** Time from socket open to `welcome`, as p50 / p95 / slowest. Any
bot refused, with the reason. Any bot that never arrived.

**Frames.** Count and bytes received, per bot socket and for the host socket,
and the largest single frame seen. These are the numbers that decide whether a
host laptop on a video call can keep up, and they are per-socket because that
is what a laptop has to drain. The Desktop is measured too when
`--screen-token` is given, and reported separately.

**Gaps.** Every `seq` gap seen by any bot, and whether the resync that follows
recovers it. A gap that is never closed is a phone that has silently stopped
agreeing with the room.

**Play.** Frames sent, and how each was answered: applied, accepted but
changing nothing, refused, or not answered at all. Host commands refused, and
host commands that got no reply. Any bot that finished on a different segment
from the others, which is the shape a desync takes.

A refusal is not a fault. The engine refusing a tap that arrived after a round
closed is correct, and a run has dozens. Silence is the fault.

**Timing.** Round-trip from a play frame to its reply — an ack or a refusal,
since both are replies — as p50 / p95 / slowest. This is the number that turns
into a missed beat in Tug of Raft when the server's loop is busy.

## What a failure looks like

The exit code is non-zero if any check fails, so this can gate a deploy. Checks
are deliberately about the room rather than the code:

- every bot joined, or the reason it did not is a reason the host chose
- no bot saw a `seq` gap that stayed open — a gap counts as closed only when a
  *later* frame answers the resync, never the frame that revealed it
- every bot ended on the same segment, and at least one bot joined
- every frame sent got an answer, applied or refused
- no host command was refused, and none went unanswered

## What it is not

It does not assert scores. `npm run bots` already does that against the
reducer, deterministically, and doing it again over a socket would be a slower
copy of a better test. If the swarm's scores are wrong and the bots' are right,
the bug is in the wire or the projection, which is what the gap and desync
checks are for.

It does not open a Desktop socket, so the surface that receives the heaviest
frames is unmeasured. It does not test reconnect: `rejoinToken` is captured and
never used, so the restart storm — everyone coming back inside a second — is
still untested by anything.

It does not walk a whole session. The run of show plays three questions and
four arcade rounds, which is enough to exercise every code path without taking
twenty minutes.

It does not replace a human at a rehearsal. It cannot tell you the Desktop is
unreadable over a compressed share, or that a round drags. It tells you the
thing stayed up and stayed consistent while sixty sockets used it.

**Bot names are fixed by index**, so a second run against the *same* session is
refused with `nickname_taken` for every bot. Stage a fresh session per run.

## Running it against production

Against a deployed service the swarm creates real participants in a real
session, so stage a throwaway event for it rather than pointing it at the
session you are about to run. `make sessions` lists what exists and
`make close SID=… FORCE=1` retires the one you made.

## The join limit, which this found on its first run

The server admits **120 hellos a minute per IP**, and **5 failed ones**
(`limits.ts`). Every socket that says hello counts toward the first: the bots,
the host, the Desktop, and every reconnect and late arrival. The swarm works
that budget out and warns before the run when it cannot fit.

It used to be ten of everything, checked before the code was read — and that
is what this harness found on its first run. Eleven bots from one machine
could not all join, and neither could a room behind one office NAT, which
cannot stagger. The limit now separates an attempt from a failed attempt: a
join code is 143 bits and nobody guesses one, so code-guessing was never the
threat, and what distinguishes an attacker from a room is that the attacker
fails.

Verified against the deployed service after the change: 25 bots, a host, a
Desktop, three late arrivals and three reconnects, all admitted from one
address, every check green. Under the old limit that run was 10 joined and 15
refused.

Sixty bots is a few megabytes of traffic and a couple of minutes. The service
is a single task by design, so a swarm large enough to hurt it is also large
enough to hurt a real event — which is the point of running it before one
rather than during.
