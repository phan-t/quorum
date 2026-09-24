# Quorum

One URL that runs a team-building session end to end: join with a nickname
and a code, stay on the page, and the host drives what it shows — lobby,
trivia, Hashi Arcade, the sealed standings, the reveal.

Today the same session runs on a Kahoot, a host-driven browser board and a
spreadsheet, and every seam between them is a name match done by a person
during a three-minute break. This replaces the seams, not the activities.

**Status: specified, not built.** These are design documents. There is no
code and no infrastructure yet, and it will not exist for the 25 Sep 2026
huddle — run that one on the existing tools.

## What's here

| File | For |
| --- | --- |
| [`docs/sendoff.md`](docs/sendoff.md) | The send-off segment: kudos, photos and music for the part of an event that is not a game — and why it is a segment rather than an activity |
| [`SPEC.md`](SPEC.md) | What it does and why: the three surfaces, the session lifecycle, trivia and its question file, the arcade's six rounds and the Lounge, manual entry for the TTX, the holding page, failure modes at a live event, open questions |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How it is built: one stateful process on ECS Fargate, the data model, the WebSocket protocol, AWS topology, HCP Terraform with OIDC, GitHub Actions, the deploy decision, restart behaviour, local dev, cost |
| [`DESIGN.md`](DESIGN.md) | What it looks like: the shared tokens, the phone-first participant view, the host console, the Desktop over compressed video, and the arcade's Squid Game register with its copy |

## Three things that carry over unchanged

**Scoring** is [SCORING.md](SCORING.md),
made automatic. Top scorer in each activity gets 100, everyone else scales;
Spot Awards are 10 points with a required reason; facilitators and late
joiners get Bench Credit. The service computes it; it does not change it.

**Seal and reveal** is a real state, not a display toggle. Sealed means no
surface shows cumulative standings — not the Desktop, not a phone, not a
running total — until the host reveals.

**The content** is what is already in this repo: the 20-question set ships as
`trivia-questions.json`,
and the eighteen arcade items in
`hashi-arcade/index.html` become
rounds 0, 2 and 5.

## The one new idea

**Nobody sits out.** The arcade is Squid Game — staff in pink, players with
numbers, a calm voice announcing the next game — but losing a round does not
eliminate you. You are *drained*, and you land in the VIP Lounge, where you
back a player still on the Floor and score when they do. Every round starts
with everyone back in. A person knocked out at minute six with fifteen
minutes of watching left was the failure this had to design out.

- [BUILD-PLAN.md](BUILD-PLAN.md) — the order to build it in, and what has to
  exist before the first deploy.

---

## Where this came from

The activities Quorum automates were worked out first as a private activity
library: a trivia question bank, the arcade rounds, facilitation notes, and a
normalisation rule for scoring activities that count in different units. Those
sessions ran on a Kahoot, a host-driven browser board and a spreadsheet, and
Quorum was built to replace the seams between them rather than the material.

That library was folded into this repository in September 2026, once the
service had taken over everything the seams were for. What survived is
[the question bank](docs/question-bank.md),
[how to run a session](docs/running-an-event.md) and
[the scoring rules](SCORING.md). What did not survive was the half of it that
existed to hold three unrelated tools together.
