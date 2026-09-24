# The send-off

A segment for the part of an event that is not a game: kudos collected in
advance, photos, and one person they are all about.

It exists because the huddle this service was built for closes on somebody's
last week, and the run of show is explicit that the send-off is the part to
protect if anything overruns. A thing that important should not be a browser
tab somebody remembers to switch to.

---

## A segment, not an activity

Trivia and the arcade are **activities**: they have a scoring bucket, they
normalise into Huddle Points, and the engine knows how to bank their totals.
The send-off scores nothing and nobody competes at it.

So it joins `holding` in `Segment` rather than the activity list. Three things
follow, and they are the reason for the choice:

- **It cannot touch the scoring path.** No bucket, no normalisation, no place
  in `withActivityTotals`. The most delicate code in the product does not get a
  new caller for a feature that does not score.
- **It is runbook-modular for free.** `Segment` is what the runbook orders,
  includes and excludes, so an event that does not need a send-off drops the
  step and an event with two milestones can hold two.
- **The standings never mention it.** An activity with a zero bucket would show
  up as a column of dashes on the scoreboard, and a send-off is not a thing
  anyone came last in.

---

## What the room sees

**One kudo at a time, filling the Desktop.** Not a wall of tiles. The Desktop
is read across a video call, at whatever size the worst connection in the room
is receiving, and a grid of twenty messages is a grid nobody reads. Photo,
message, and who wrote it.

**The host advances it.** This is the most important decision in the design and
the easiest one to get wrong. An auto-advancing montage walks past the moment
that lands — the message that makes the room go quiet, the photo somebody
reacts to — and the person it is all about is sitting there watching it happen.
The host presses the same space bar that drives every other segment. Auto-
advance exists as an option and is **off by default**, for the same reason a
timer is not the host.

**An opening montage, then silence.** Photos with music for thirty to forty
seconds, nobody speaking, and then the music stops and the messages begin. See
the music section: this shape is not a preference, it is the only one that
works over a video call.

---

## What the host sees

The console shows the **next** kudo before the room does.

This is the same rule as the trivia console showing the answer before the
reveal, and it exists for a better reason here. Kudos are written by people who
did not know the room they would be read into, and one of them will be a joke
that does not survive being read out at a farewell. A host who can see what is
next can skip it without anybody knowing there was something to skip. A host
who cannot is finding out at the same moment as the person it is about.

---

## The file

`config/events/<event>/sendoff.json`, beside the question set:

```json
{
  "for": {
    "name": "…",
    "subtitle": "Last day 30 September 2026"
  },
  "opening": {
    "photos": ["arrival.jpg", "offsite.jpg", "the-whiteboard.jpg"],
    "music": "send-off.mp3",
    "seconds": 40
  },
  "kudos": [
    { "from": "…", "message": "…", "photo": "…" }
  ],
  "closing": {
    "photo": "team.jpg",
    "line": "…"
  }
}
```

`photo` and `music` are filenames resolved against the event directory, the
same convention `questions` and `promo` already use in `session.json`. Every
field except `kudos` is optional: a send-off with no photos and no music is a
list of messages, which is still the thing.

---

## Photos

A question set is a few kilobytes of text. Twenty photos are tens of megabytes,
and a DynamoDB item stops at 400KB, so the question file's storage is not an
option and neither is engine state — the snapshot is replayed and broadcast,
and nobody should be shipping a JPEG through a reducer.

**One asset row per photo**, generalising the row the promo card uses.
Staging downscales each to about 1200px wide as JPEG, which lands around 150KB
— comfortably inside the row, and more resolution than a shared video call can
carry anyway. The alternative is a private S3 bucket served through the task
role, which is the right answer for a product with many events and the wrong
one to introduce the week you need it: new Terraform, new IAM, and a new way
for the afternoon to fail.

Downscaling happens at staging, on the host's machine, so the service never
holds the original and a 12MB photo from somebody's phone cannot become a
failed write at 3:40.

---

## Music

**Supported, scoped to the opening, and off unless the file says otherwise.**

Three things go wrong with music over a video call, and the first fails
silently:

1. **Tab audio is not shared unless somebody ticks a box.** Zoom, Teams and
   Meet each put it somewhere different in the share dialog. Nobody finds out
   it was off until afterwards, when someone asks whether there was meant to be
   music.
2. **Noise suppression treats music as noise.** Every platform's default
   processing is tuned to remove exactly this, so a backing track arrives thin,
   intermittent, or not at all.
3. **Music under a person reading aloud means neither is heard.** The room gets
   a muddy compromise instead of either thing.

So the music plays under the opening montage, while nobody is speaking, and
stops before the first message. A **preflight row** covers the first failure:
*play three seconds and ask somebody in the room whether they heard it.* That
is the only way to know, and it takes ten seconds at 1:50pm rather than
discovering it at 3:41.

Autoplay policy is the other constraint: a browser will not start audio without
a user gesture, and the gesture has to happen in the Desktop tab. The host
starting the segment from the console is not a gesture *in that tab*. So the
Desktop arms audio on the first click or key it receives — which the host makes
anyway when they open it — and the preflight row is also what proves it armed.

---

## What the participants see

Their own screen, not a shrunken copy of the Desktop. The phone shows the same
kudo's text without the photo, so somebody whose screen-share has frozen is
still reading along, and the person being celebrated is not watching the room
watch a second copy of themselves.

Nothing to tap. The points strip stays, because the competition has not been
settled yet at this point in most run of shows, and taking the scoreboard away
mid-send-off reads as the session having ended.

---

## Accessibility and the things that will be got wrong

- **Every photo needs alternative text.** A montage of images with no
  description is nothing at all to a screen reader, at the one moment in the
  session that is entirely about a person.
- **`prefers-reduced-motion` turns the animation into a cut.** The transitions
  are decoration; the messages are the content.
- **The messages are other people's words.** They are rendered as text, never
  as markup, and never through anything that would let a `<script>` in a kudos
  file reach the Desktop.
- **A kudo with no photo must look deliberate**, not broken — the message
  centred, rather than a message beside an empty frame.

---

## Not in scope

Collecting the kudos. A form, a channel thread and a nudge to fifteen people
a week ahead is what fills this file, and that is a facilitation problem the
run of show already covers. The service reads a file somebody else assembled.
