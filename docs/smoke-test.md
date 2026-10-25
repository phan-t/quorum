# The swarm: a smoke test with real sockets

`npm run swarm` opens N real WebSockets against a running Quorum, joins them,
drives a session from the host's seat, plays it, and reports what the *clients*
saw. A host cannot rehearse this alone, and nothing else in this repository
load-tests a running server.

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

# a third of the room in Europe, and a deploy in the middle of trivia
npm run swarm -- 30 --url https://quorum.example.com --code … --host-token … \
  --far 10 --latency 140 --jitter 80 \
  --restart-after 40 --restart-cmd 'aws ecs stop-task --cluster quorum --task …'
```

| Flag | |
| --- | --- |
| `--from-session` | play the staged event's own plan and timings |
| `--questions N` | how many trivia questions to play (default 5) |
| `--screen-token` | connect a Desktop and measure it |
| `--late N` | N bots arrive after the session has started |
| `--churn N` | N bots drop and rejoin on their token |
| `--stagger MS` | space the joins, to get past the join limit |
| `--seed N` | fixes each bot's choices; timing still follows the wall clock |
| `--latency MS` | one-way delay each direction for the far bots |
| `--jitter MS` | up to this much more, per frame, in order |
| `--far N` | how many bots are far (the last N); all of them if omitted |
| `--restart-after S` | run `--restart-cmd` this many seconds in |
| `--restart-cmd CMD` | whatever restarts the server: `aws ecs stop-task …`, or a local `pkill` |

## Why it exists

`npm run bots` drives the reducer in memory. It is the right tool for testing
the game rules at headcount, such as normalisation, ties, and refused joins.
It opens no socket, so it proves none of the following:

- twenty phones connecting at once, which is what a QR code on a screen
  produces
- broadcast fan-out and frame size, per socket
- the join rate limiter, which until recently keyed on the load balancer rather
  than the joiner and would have refused a room joining together
- the count that never reaches "20 of 20"

Those failures show up in a live room, and they happen between the phone and
the reducer. The swarm is the only test that covers that path.

## What it does

**The host is a bot too.** It issues the same `host.cmd` frames the console
does, with no driving mode and no test-only endpoint. It waits on the room
rather than a clock, so it closes a question when everyone who could answer
has, and leaves a round when the round has ended itself. A list of commands
with sleeps between them tests only whether the server accepts commands in an
order somebody wrote down, and a real host does not work that way.

**It runs a whole event.** It plays the lobby, a holding card, trivia, every
arcade round, the sealed standings, the reveal, the send-off, and the final
frame. Every round plays so that every round's *code* runs, because a sample
would leave branches that typecheck but have never once executed.

**It can also rehearse the event you are about to run.** `--from-session`
reads the staged console setup, which is the same blob the console loads, and
plays that plan, at those timings, with that holding card. The default mode
sweeps every round fast to check that this build works. A rehearsal checks
whether Thursday will work, so it needs your three rounds at your clock rather
than five at somebody else's.

The setup is the console's own and the server never looks inside it, so the
swarm is the only thing asserting its shape. It treats every field as unknown
and falls back to the sweep, saying so, rather than quietly rehearsing a
different event from the one staged. The report names any round it cannot
drive, such as Gganbu or a round a later console offers, and says it was
skipped.

**It connects all three surfaces.** It opens a socket per bot, one for the
host, and one for the Desktop when `--screen-token` is given. The Desktop and
the console both receive a full state on every roster change, so they carry the
heaviest frames, and leaving them out would understate the load.

**Bots arrive late and reconnect.** `--late` brings bots in after the session
has started, which exercises the code that gives somebody a zero in an activity
they were never in. `--churn` drops bots and reconnects them on their
`rejoinToken`, which every event sees when a phone sleeps.

**Bots play by reacting to `state`.** There is no script of expected frames. A
bot reads the segment, the trivia phase, the arcade round and its own `arcadeMine`, and
acts. It answers a question at a randomised delay, taps during Plan / Apply,
picks a shape and taps letters in Unseal, picks a pane on the Bridge, types a
Recruitment answer, and backs a player when it is drained.

Each bot's *choices* come from a seeded PRNG, so `--seed` fixes which answer it
picks and which pane. It does not fix the run: tap trains and late presses are
wall-clock, so two runs on one seed give similar but not identical totals. The
network is the thing under test and cannot be made deterministic.

**It measures what the client saw.** The server's own view does not count as
evidence, because a broadcast the server sent and a frame a phone actually
received are different claims, and the bugs this looks for are in the
difference. Every number in the report is counted on a bot socket.

## What it reports

A run ends with a report in the shape `npm run bots` uses, with numbers first
and then checks that pass or fail, so a bad run is clear without reading the
numbers.

**Joining.** The time from socket open to `welcome`, as p50, p95, and slowest.
It lists any bot refused, with the reason, and any bot that never arrived.

**Frames.** Count and bytes received, per bot socket and for the host socket,
and the largest single frame seen. These numbers show whether a host laptop on
a video call can keep up, and they are per socket because a laptop drains one
socket. The Desktop is measured too when
`--screen-token` is given, and reported separately.

**Gaps.** Every `seq` gap seen by any bot, and whether the resync that follows
recovers it. A gap that never closes means a phone has stopped matching the
room's state without showing any error.

**Play.** Frames sent, and how each was answered: applied, accepted but
changing nothing, refused, or not answered at all. Host commands refused, and
host commands that got no reply. Any bot that finished on a different segment
from the others, which is what a desync looks like in the report.

Refusals are expected. The engine is correct to refuse a tap that arrived after
a round closed, and a run has dozens of them. A frame that gets no answer is
the fault.

**Distance**, when `--latency` or `--jitter` is given. Reply round trips and
the share of frames refused, for far bots and near bots side by side. Far bots
are refused a little more, because a tap that lands after a lock is refused for
them sooner. A gap much wider than the near bots' means the grace does not
cover the distance.

**The server went away**, when it did. When the server closes a socket the run
did not, every bot, the host, and the Desktop reconnect the way `net.ts` does,
with the same backoff and on the rejoin token. The report gives how many
sockets were dropped, how long they took to come back, any that never did,
frames that were in flight and lost with the process, and trivia answers sent
again because the server came back without them.

**Timing.** The round trip from a play frame to its reply, as p50, p95, and
slowest, where an ack and a refusal both count as replies. When the server's
loop is busy, this delay becomes a missed beat in Tug of Raft.

**The afternoon, as a participant had it.** It reports how much of the run was spent in a
game rather than in a lobby; what share of that had nothing to press; the
longest unbroken stretch with nothing to press; and per round, how many times
each bot acted and how many acted not at all.

This is the only part of the report that is about whether the event was worth
attending. The server can work perfectly while the afternoon is still dull,
and SPEC names that failure directly: "a person knocked out at minute six with
fifteen minutes of watching left was the failure this had to design out." A
bot can tell at every instant whether it could press anything, so the run
measures whether the design achieved that, rather than leaving it to a reading
of the code.

Each bot samples itself on a fixed 500ms clock rather than on broadcasts. A
bot with nothing to press is also a bot nobody is broadcasting about, so
sampling on frames would have counted the quietest stretches for the least.

A run fails if anybody sat longer than **60 seconds** with nothing pressable.
That number is a judgement call. It is a named constant, so changing it is a
deliberate decision.

## What a failure looks like

The exit code is non-zero if any check fails, so this can gate a deploy. Checks
are deliberately about the room rather than the code:

- every bot joined, or the reason it did not is a reason the host chose
- every socket the server dropped came back as itself
- no bot saw a `seq` gap that stayed open, where a gap counts as closed only
  when a *later* frame answers the resync and never by the frame that revealed
  it
- every bot ended on the same segment, and at least one bot joined
- every frame sent got an answer, applied or refused
- no host command was refused, and none went unanswered
- nobody sat longer than a minute with nothing to press

## What it is not

It does not assert scores. `npm run bots` already does that against the
reducer, deterministically, and doing it again over a socket would be a slower
copy of a better test. If the swarm's scores are wrong and the bots' are right,
the bug is in the wire or the projection, which is what the gap and desync
checks are for.

It does not walk a whole session. The run of show plays three questions and
four arcade rounds, which is enough to exercise every code path without taking
twenty minutes.

It survives a restart, but its bots are always the build they started with.
They send and read whatever frames this checkout's `protocol.ts` describes, so a
run across a deploy shows that the room came back. It does not show that an old
tab can read the new server's frames, which is the case that breaks a live
event. **After a deploy that changes a frame's shape, reload any Desktop or
console that was already open.** They reconnect without reloading, by design,
so an open tab keeps running the old JavaScript against the new server's
frames; when a frame narrowed, the old code reads a field that is no longer
sent and throws while rendering, and the surface stops updating with nothing on
it to say so. `PROTOCOL_VERSION` (`app/src/protocol.ts`) plus the check in
`client/shared/protocol-guard.ts` covers most of this from one deploy to the
next, because a phone reloads itself and the console and the Desktop say they
are stale. The check runs in the client that is *already* open, though, so it
cannot cover the deploy that introduces it, nor one where the shape changed and
the version did not. Reloading the two long-lived tabs covers all of it and
takes a few seconds.

It does not replace a human at a rehearsal. It cannot tell you the Desktop is
unreadable over a compressed share, or that a round drags. It tells you the
service stayed up and stayed consistent while sixty sockets used it.

**Bot names are fixed by index**, so a second run against the *same* session is
refused with `nickname_taken` for every bot. Stage a fresh session per run.

## Rehearsing a restart locally

The local store has to outlive the process, so this needs DynamoDB Local
(`docker compose up -d`, or the same image under Podman with `-inMemory`) and
something that starts the server again when it exits, as ECS does:

```bash
while true; do QUORUM_ENV=local QUORUM_ADMIN_KEY=localdev PORT=3000 \
  node --experimental-strip-types src/server/main.ts; sleep 3; done
```

Then `--restart-cmd 'pkill -TERM -f src/server/main.ts'`. A first run of 20
bots, 8 of them at 140 ms ± 80 ms, with the SIGTERM four seconds before a
question's deadline: all 22 sockets back in 6–7 s, the question paused through
the gap and resumed on the five-second floor, every check green.

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

It used to be ten of everything, checked before the code was read, and this
harness found that on its first run. Eleven bots from one machine
could not all join, and neither could a room behind one office NAT, which
cannot stagger. The limit now separates an attempt from a failed attempt: a
join code is 143 bits and nobody guesses one, so code-guessing was never the
threat. An attacker differs from a room because the attacker's attempts fail.

Verified against the deployed service after the change: 25 bots, a host, a
Desktop, three late arrivals and three reconnects, all admitted from one
address, every check green. Under the old limit that run was 10 joined and 15
refused.

Sixty bots is a few megabytes of traffic and a couple of minutes. The service
is a single task by design, so a swarm large enough to overload it would also
overload a real event. That is why it runs before an event and not during one.
