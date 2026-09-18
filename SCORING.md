# Scoring

The rules Quorum implements. They predate the software — they were worked out
for sessions run on a spreadsheet, and they are reproduced here because the
spec defers to them constantly and a reader should not have to go and find
them.

They are also still run by hand. The activity library keeps an operational
version of the same rules — how to hold the spreadsheet, when to share it, when
to go dark — and the two are identical by intent. A rule change has to land in
both.

**Everyone competes as an individual.** There are no teams and, in a typical
session, exactly one winner.

## Never add raw scores

Activities score in wildly different units: a judged rubric out of 20, a
speed-weighted trivia score in the thousands, a count of arcade rounds
survived. Summing them means whichever activity has the biggest numbers
silently decides the winner and the others become decoration.

## Normalisation

Every activity is normalised to the same ceiling:

> **The top scorer in an activity gets 100.**
> **Everyone else gets `round(100 × their raw ÷ the top raw)`.**

One formula, applied per activity. Three activities, 300 points available.

| | Raw | Top raw | Points |
| --- | --- | --- | --- |
| Trivia — Priya | 18,400 | 18,400 | **100** |
| Trivia — Kenji | 14,720 | 18,400 | **80** |
| Trivia — Sam | 9,200 | 18,400 | **50** |

It works at any headcount, preserves real margins — beating the field by double
still reads as double — and makes each activity worth exactly the same
regardless of what it scored out of.

**Rank tables are the obvious alternative and they fail here.** With 25 people,
"1st = 100, 2nd = 80, 3rd = 65…" puts almost the entire room on the same score
and throws away every margin.

**No floor.** Someone will suggest a minimum — 40 points for turning up. It
compresses the field exactly where the competition is interesting. A person
sitting on 12 after the trivia is not demoralised by the number; they are
demoralised if there is nothing left to play for, which is what Spot Awards are
for.

## Spot Awards

10 points, granted by the facilitator of an activity to any individual, for
anything they like: the sharpest question, the best recovery, the answer that
made the room laugh, the person who drew out someone who had not spoken.

Two per activity by default. They exist so that someone who reads the room well
is never mathematically out of it by the last activity.

**A reason is mandatory.** They are a facilitation tool, announced out loud —
not a rounding error. Quorum requires the field because a field that may be
blank will be blank.

## Bench Credit

A facilitator knows the answers to the activity they run. They should still be
able to win: they are part of the team, and excluding them punishes the people
who volunteer to do the work.

1. **They sit out the activity they run.** No answering, no advising, no
   hinting. Staff for that activity, not a player.
2. **They are credited their own average.** For the activity they facilitated,
   they score the mean of their normalised points across the activities they
   played in full. Someone who scores 90 and 70 is credited 80 for the one they
   ran — their own demonstrated level, so volunteering neither rewards nor
   punishes them. It generalises unchanged if one person runs two activities.
3. **Nobody scores themselves.** Where a facilitator competes in an activity
   someone else judges, the judge scores blind.

Bench Credit is applied after normalisation and changes nobody else's score. A
participant on bench for an activity cannot receive that activity's Spot
Awards.

**Say it out loud before the first activity.** Thirty seconds:

> "Three of us are running an activity each. We each sit out the one we run,
> and we're credited our own average for it, so volunteering doesn't cost us
> the prize. Nobody scores themselves."

Said up front it reads as fair. Discovered at the prize-giving it reads as a
stitch-up, however good the arithmetic is.

## Tiebreak

Normalised scores produce round numbers, so a tie at the top is likelier than
it sounds.

1. **Highest score in the tiebreak activity**, which the session config names —
   conventionally the judged one, because it is the activity that most rewards
   thinking with other people.
2. **Sudden death** — one question, first correct answer wins, no points.

Never a coin flip. People remember the coin flip. Quorum does not implement
one.

## What participants see

**Top five only, never the full ranking**, on every surface. The bottom of an
individual leaderboard has someone's name on it in front of their whole team.
This is enforced in software rather than left to whoever is running the
spreadsheet.

Each participant also sees **their own total, without a rank**. A total is a
number to add to; "23rd" is a reason to stop playing.

## Seal and reveal

Standings can be sealed. Sealed means no surface shows cumulative standings —
not the big screen, not the host console's public view, not a participant's own
total.

This is a real mechanic, not a display toggle. With a single prize, only a
handful of people can still mathematically win by the last activity, and the
only thing keeping everyone else playing is that nobody knows who those people
are. Seal before the final activity; reveal at the end.
