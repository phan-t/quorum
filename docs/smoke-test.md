# The swarm: a smoke test with real sockets

`npm run swarm` opens N real WebSockets against a running Quorum, joins them,
drives a session from the host's seat, plays it, and reports what the *clients*
saw. It is the rehearsal a host cannot run alone and the load test nothing else
in this repository performs.

```bash
# against a local server
cd app && npm run dev:memory                       # another terminal
make stage EVENT=2026-03-12-example-offsite        # prints the tokens
npm run swarm -- 9 --url http://localhost:3000 \
  --code hvs.xxxx --host-token XXXX

# against the deployed service, before an event
make up && make stage EVENT=<event>
npm run swarm -- 60 --url https://quorum.example.com --code … --host-token …
```

## Why it exists

`npm run bots` drives the reducer in memory. It is the right tool for the game
rules at headcount — normalisation, ties, Bench Credit, refused joins — and it
proves none of the following, because it opens no socket:

- twenty phones connecting at once, which is what a QR code on a screen
  produces
- the reconnect storm after a restart, when everyone comes back inside a second
- per-socket latency correction, which decides who won a speed-weighted
  question
- broadcast fan-out, frame size, and the `seq` gap and resync path
- the join rate limiter, which until recently keyed on the load balancer rather
  than the joiner and would have refused a room joining together
- the count that never reaches "20 of 20"

Those are the failures that hurt in a room, and they live between the phone and
the reducer. The swarm is the only thing that exercises that gap.

## What it does

**One socket per bot, plus one for the host.** The host socket issues the same
`host.cmd` frames the console does, so a run is unattended: open the lobby,
start, walk the trivia, enter the arcade, run each round, reveal, finish. There
is no separate driving mode and no test-only endpoint — if the console can do
it, the swarm does it the same way, and if the protocol changes underneath, the
swarm breaks the way a client would.

**Bots play by reacting to `state`.** No script of expected frames: a bot reads
the segment, the trivia phase, the arcade round and its own `arcadeMine`, and
acts. It answers a question at a randomised delay, taps during Plan / Apply,
picks a pane on the Bridge, types a Recruitment answer, and backs a player when
it is drained. Each bot's choices come from a seeded PRNG, so `--seed 99`
reproduces a run.

**It measures what the client saw, not what the server thinks.** The server's
own view is not evidence: a broadcast the server believes it sent and a frame a
phone actually received are different claims, and the gap between them is the
bug. Every number in the report is counted on a bot socket.

## What it reports

A run ends with a report in the shape `npm run bots` uses — numbers first, then
checks that pass or fail, so a bad run is legible without reading the numbers.

**Joining.** Time from socket open to `welcome`, as p50 / p95 / slowest. Any
bot refused, with the reason. Any bot that never arrived.

**Frames.** Count and bytes received per role. The largest single frame. The
busiest second. These are the numbers that decide whether a host laptop on a
video call can keep up, and they are per-socket because that is what a laptop
has to drain.

**Gaps.** Every `seq` gap seen by any bot, and whether the resync that follows
recovers it. A gap that is never closed is a phone that has silently stopped
agreeing with the room.

**Play.** Answers sent versus acked. Commands the host issued versus refused.
Any bot that finished on a different segment from the others, which is the
shape a desync takes.

**Timing.** Round-trip from a play frame to its `ack`, as p50 / p95 / slowest.
This is the number that turns into a missed beat in Tug of Raft when the
server's loop is busy.

## What a failure looks like

The exit code is non-zero if any check fails, so this can gate a deploy. Checks
are deliberately about the room rather than the code:

- every bot joined, or the reason it did not is a reason the host chose
- no bot saw a `seq` gap that stayed open
- no bot ended on a different segment from the rest
- every answer that was sent was acked
- no host command was refused that the run of show expected to work

## What it is not

It does not assert scores. `npm run bots` already does that against the
reducer, deterministically, and doing it again over a socket would be a slower
copy of a better test. If the swarm's scores are wrong and the bots' are right,
the bug is in the wire or the projection, which is what the gap and desync
checks are for.

It does not replace a human at a rehearsal. It cannot tell you the Desktop is
unreadable over a compressed share, or that a round drags. It tells you the
thing stayed up and stayed consistent while sixty sockets used it.

## Running it against production

Against a deployed service the swarm creates real participants in a real
session, so stage a throwaway event for it rather than pointing it at the
session you are about to run. `make sessions` lists what exists and
`make close SID=… FORCE=1` retires the one you made.

## The join limit, which this found on its first run

The server admits **ten hellos a minute per IP** (`main.ts`, `rateLimited`).
Every bot in a swarm shares one address, so a run of more than ten from one
machine is refused unless `--stagger 6500` spaces them past the window — which
takes two minutes for twenty bots and is not what a room does.

That is not only a harness problem. A team joining from one office shares one
public IP, and cannot stagger. Before `QUORUM_TRUST_PROXY` was set the whole
room shared the load balancer's address and the eleventh person to scan the QR
code was refused for a minute; with it set, the limit is per real client, which
is right for a distributed team and unchanged for a room behind one NAT.

Whether ten a minute is the right number is a decision nobody has made
deliberately. The swarm's job here is to make the number visible before a room
does.

Sixty bots is a few megabytes of traffic and a couple of minutes. The service
is a single task by design, so a swarm large enough to hurt it is also large
enough to hurt a real event — which is the point of running it before one
rather than during.
