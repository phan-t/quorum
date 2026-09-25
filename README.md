# Quorum

One URL that runs a team-building session from start to finish. People join
with a nickname and a code, stay on the same page all afternoon, and the host
drives what it shows: the lobby, trivia, the Hashi Arcade, the sealed
standings and the reveal.

These sessions used to run on Kahoot, a host-driven browser board and a
spreadsheet. Every seam between those tools was a name match done by hand
during a three-minute break. Quorum replaces the seams. The activities are
the same ones that were already being run.

**Status: built and in use.** It has run a full session with a live room.
Deploys are `make deploy` from a laptop with a current AWS session. The
service is parked at zero between events and raised with `make up`.

## What's here

| File | For |
| --- | --- |
| [`docs/sendoff.md`](docs/sendoff.md) | The send-off segment: kudos, photos and music for the part of an event that is not a game, and why it is a segment rather than an activity |
| [`docs/event-config.md`](docs/event-config.md) | Staging an event: the directory, `session.json`, and the one command that loads it |
| [`docs/running-an-event.md`](docs/running-an-event.md) | Running the afternoon from the console |
| [`SPEC.md`](SPEC.md) | What it does and why: the three surfaces, the session lifecycle, trivia and its question file, the arcade's six rounds and the Lounge, manual entry for the TTX, the holding page, and how things fail at a live event |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How it is built: one stateful process on ECS Fargate, the data model, the WebSocket protocol, AWS topology, HCP Terraform, restart behaviour, local dev and cost |
| [`DESIGN.md`](DESIGN.md) | What it looks like: the shared tokens, the phone-first participant view, the host console, the Desktop over compressed video, and the arcade's Squid Game styling |
| [`SCORING.md`](SCORING.md) | The scoring rules, unchanged from how they were run by hand |

## What carries over from the old way

**Scoring** is [SCORING.md](SCORING.md), made automatic. The top scorer in
each activity gets 100 and everyone else scales from there. Spot Awards are
10 points and need a reason. Facilitators and late joiners get Bench Credit.
The service applies those rules without changing them.

**Seal and reveal** is a state rather than a display toggle. While a session
is sealed, no surface shows cumulative standings. Not the Desktop, not a
phone, not a running total, until the host reveals them.

**The content** is the material these sessions already used. A question set
is a JSON file per event. The committed example is
[`config/event.example/trivia-questions.json`](config/event.example/trivia-questions.json),
and a real event's questions live in its own gitignored directory under
`config/events/`. The arcade's existing items became rounds 0, 2 and 5,
which are Recruitment, Unseal and The Glass Bridge.

## The one new idea

**Nobody sits out.** The arcade is styled after Squid Game, with staff in
pink, players with numbers and a calm voice announcing the next game, but
losing a round does not eliminate you. You are *drained* instead, and you
land in the VIP Lounge, where you back a player still on the Floor and score
when they do. Every round starts with everyone back in. Someone knocked out
at minute six with fifteen minutes left to watch was the problem this had to
design out.

[BUILD-PLAN.md](BUILD-PLAN.md) has the order it was built in, and what had to
exist before the first deploy.

---

## Licence

[Business Source License 1.1](LICENSE), the licence HashiCorp's own products
use. In short: read it, change it, run it for your own team's events. You may
not offer it to other people as a hosted service. On 18 September 2030 it
becomes Mozilla Public License 2.0 and those restrictions fall away.

---

## Where this came from

The activities Quorum automates were worked out first as a private activity
library: a trivia question bank, the arcade rounds, facilitation notes, and a
rule for normalising scores across activities that count in different units.

That library was folded into this repository once the service had taken over
everything the seams were for. What survived is
[the question bank](docs/question-bank.md),
[how to run a session](docs/running-an-event.md) and
[the scoring rules](SCORING.md). The rest of it existed only to hold three
unrelated tools together, so it went.
