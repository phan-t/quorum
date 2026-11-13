# Scoring

These are the rules Quorum implements. They predate the software, because they
were worked out for sessions run on a spreadsheet. They are reproduced here
because the spec refers to them constantly, and a reader should not have to go
and find them.

This is now the only copy. The operational version that used to sit alongside
them covered how to hold the spreadsheet, when to share it, and when to stop
sharing it. It has been removed, and the parts that are still used are in
[docs/running-an-event.md](docs/running-an-event.md). A rule change is made
here and nowhere else.

**Everyone competes as an individual.** There are no teams and, in a typical
session, exactly one winner.

## Never add raw scores

Activities score in wildly different units: a judged rubric out of 20, a
speed-weighted trivia score in the thousands, a count of arcade rounds
survived. If they were summed, the activity with the biggest numbers would
decide the winner, and the other activities would barely change the result.

## Normalisation

Every activity is normalised to the same ceiling:

> **The top scorer in an activity gets 100.**
> **Everyone else gets `round(100 × their raw ÷ the top raw)`.**

The formula is applied to each activity, and nothing else adds to a total.
Three activities give 300 points available in all.

| | Raw | Top raw | Points |
| --- | --- | --- | --- |
| Trivia, Priya | 18,400 | 18,400 | **100** |
| Trivia, Kenji | 14,720 | 18,400 | **80** |
| Trivia, Sam | 9,200 | 18,400 | **50** |

The formula works at any headcount and keeps real margins, so a player who
doubles another's raw score still gets double the points. It also makes each
activity worth the same whatever it was scored out of.

**A rank table would lose the margins.** With 25 people,
"1st = 100, 2nd = 80, 3rd = 65…" puts almost the entire room on the same score
and throws away every margin.

**There is no minimum score.** Someone will suggest one, such as 40 points for
turning up. A minimum compresses the scores at the bottom of the field, which
is where the competition is closest. A person on 12 after the trivia is not
discouraged by the number itself. They are discouraged if there is nothing left
to play for, and every remaining activity is still worth 100 to them however
the last one went.

**Nobody scores themselves.** Where a facilitator competes in an activity
someone else judges, the judge scores blind.

## Tiebreak

Normalised scores produce round numbers, so a tie at the top is likelier than
it sounds.

1. **Highest score in the tiebreak activity**, which the session config names.
   This is usually the judged activity, because it most rewards thinking with
   other people.
2. **Sudden death**, where the first correct answer to one question wins. It
   scores no points.

Quorum does not implement a coin flip, because a winner decided by one is what
people remember about the session.

## What participants see

Every surface shows **the top five only**, and never the full ranking. The
bottom of an individual leaderboard has someone's name on it in front of their
whole team. The software enforces this, so it no longer depends on whoever is
running the spreadsheet.

Each participant also sees **their own total, without a rank**. A participant
can try to add to a total, but a rank of "23rd" gives them a reason to stop
playing.

## Seal and reveal

Standings can be sealed. While they are sealed, no surface shows cumulative
standings. That includes the Desktop, the host console's public view, and a
participant's own total.

Sealing changes how people play. With a single prize, only a few people can
still win by the last activity, and everyone else keeps playing because nobody
knows who those people are. Seal the standings before the final activity and
reveal them at the end.

## Removed: Spot Awards and Bench Credit

Both were rules here, and both have been removed. They are recorded here
because the arguments for them were good ones. They were removed on evidence
from twelve particular sessions, and nobody found the reasoning wrong. If the
shape of a session changes, read this section before reinventing either of
them.

**Spot Awards** were 10 points, granted by the facilitator of an activity to any
individual for anything they liked, such as the sharpest question, the best
recovery, or drawing out someone who had not spoken. A facilitator could grant
two per activity, with a mandatory reason, announced out loud. They existed so
that someone who reads the room well could still win at the last activity.
They were granted **twice, in one of twelve sessions**. A total of 300 with no
other source of points is simpler to run and to explain. Spot Awards guarded
against a player falling out of contention early, and every activity being
worth another 100 already handles that.

**Bench Credit** let a facilitator sit out the activity they ran and be credited
the mean of their normalised points across the activities they played in full:
someone who scored 90 and 70 was credited 80 for the one they ran, their own
demonstrated level, so volunteering neither rewarded nor punished them. It was
applied after normalisation, changed nobody else's score, and generalised
unchanged if one person ran two activities. The same status was used for a late
joiner, so that an activity they were never in was not a zero. **It was never used
in twelve sessions**, which fits sessions where the facilitator ran everything
and did not compete.

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
human decision. No status in the software credits them, and an activity
somebody did not play counts as zero towards their total. The same goes
for a late joiner. Both are now things to say out loud before the first activity
rather than things the arithmetic handles:

> "Whoever runs an activity isn't competing in it. There's no clever
> compensation for that any more — we just say so now, up front."

If a session ever has three people who each run one activity and all expect to
compete, bring back the arithmetic above. It is written down here so that
nobody has to work it out again at a prize-giving.
