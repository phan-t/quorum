# Scoring

The rules Quorum implements. They predate the software — they were worked out
for sessions run on a spreadsheet, and they are reproduced here because the
spec defers to them constantly and a reader should not have to go and find
them.

This is now the only copy. The operational version that used to live alongside
them — how to hold the spreadsheet, when to share it, when to go dark — is
gone, and what survived of it is in
[docs/running-an-event.md](docs/running-an-event.md). A rule change lands here
and nowhere else.

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

One formula, applied per activity, and nothing else adds to a total. Three
activities, 300 points available, and that is the whole of it.

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
demoralised if there is nothing left to play for, and what keeps that true is
that every remaining activity is worth a fresh 100 to them however the last one
went.

**Nobody scores themselves.** Where a facilitator competes in an activity
someone else judges, the judge scores blind.

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
not the Desktop, not the host console's public view, not a participant's own
total.

This is a real mechanic, not a display toggle. With a single prize, only a
handful of people can still mathematically win by the last activity, and the
only thing keeping everyone else playing is that nobody knows who those people
are. Seal before the final activity; reveal at the end.

## Removed: Spot Awards and Bench Credit

Both were rules here and both are gone. Recorded rather than deleted, because
the arguments for them were good ones and the reason they went was evidence
about twelve particular sessions, not a finding that the reasoning was wrong. If
the shape of a session changes, this is the section to read before reinventing
either of them.

**Spot Awards** were 10 points, granted by the facilitator of an activity to any
individual for anything they liked — the sharpest question, the best recovery,
the person who drew out someone who had not spoken. Two per activity, with a
mandatory reason, announced out loud. They existed so that someone who reads the
room well is never mathematically out of it by the last activity. They were
granted **twice, in one of twelve sessions**. A total of 300 with no side
channel is simpler to run and simpler to explain, and the thing they were
guarding against — a player out of contention early — is already handled by
every activity being worth a fresh 100.

**Bench Credit** let a facilitator sit out the activity they ran and be credited
the mean of their normalised points across the activities they played in full:
someone who scored 90 and 70 was credited 80 for the one they ran, their own
demonstrated level, so volunteering neither rewarded nor punished them. It was
applied after normalisation, changed nobody else's score, and generalised
unchanged if one person ran two activities. The same status was used for a late
joiner, so that an activity they were never in was not a zero. **It never fired
in twelve sessions**, which is consistent with the facilitator running
everything and simply not competing.

### What was lost with Bench Credit, in the words that were here

The case for it was:

> A facilitator knows the answers to the activity they run. They should still be
> able to win: they are part of the team, and excluding them punishes the people
> who volunteer to do the work.

And the failure mode it was guarding against:

> Said up front it reads as fair. Discovered at the prize-giving it reads as a
> stitch-up, however good the arithmetic is.

That failure mode has not been removed, only the arithmetic that answered it. A
facilitator who runs one activity and plays the others is now either scored
normally in the round where they knew the answers, or left off the board by a
human decision — there is no status in the software that credits them, and an
activity somebody did not play counts as zero towards their total. The same goes
for a late joiner. Both are now things to say out loud before the first activity
rather than things the arithmetic handles:

> "Whoever runs an activity isn't competing in it. There's no clever
> compensation for that any more — we just say so now, up front."

Removed on evidence from twelve sessions. If a session ever has three people
each running one activity and all three expecting to compete, the arithmetic
above is the thing to bring back, and it is written down here so that nobody has
to work it out again at a prize-giving.
