# The send-off

A segment for the part of an event that is not a game: kudos collected in
advance, photos, and one person they are all about.

It exists because the huddle this service was built for closes on somebody's
last week, and the run of show is explicit that the send-off is the part to
protect if anything overruns. So it should not depend on somebody remembering
to switch to a browser tab.

---

## A segment rather than an activity

Trivia and the arcade are **activities**: they have a scoring bucket, they
normalise into Huddle Points, and the engine knows how to bank their totals.
The send-off scores nothing and nobody competes at it.

So it joins `holding` in `Segment` rather than the activity list. Three things
follow from that, and they are why it was chosen:

- **It cannot touch the scoring path.** It has no bucket, no normalisation, and
  no place in `withActivityTotals`. The most delicate code in the product does
  not get a new caller for a feature that does not score.
- **The runbook can include it or leave it out with no extra work.** `Segment`
  is what the runbook orders, includes, and excludes, so an event that does not
  need a send-off drops the step and an event with two milestones can hold two.
- **The standings never mention it.** An activity with a zero bucket would show
  up as a column of dashes on the scoreboard, and nobody comes last in a
  send-off.

---

## What the room sees

**One kudo at a time, filling the Desktop.** The Desktop is read across a video
call, at whatever size the worst connection in the room is receiving, so a wall
of twenty message tiles would be too small for anybody to read. Each slide sets
the message and who wrote it large.

**Kudos carry no photo.** The photos people send for a farewell are not
portraits of the person who wrote each message. They are group shots, and
nobody can say which of forty-three belongs beside which of fifteen messages.
Pairing them would mean guessing, and a wrong guess on a farewell slideshow is
shown to everyone at once. So photos and messages each get their own frame.
This follows from what the material is, and was not made to keep the design
simple.

**A Farewell card comes first and holds.** It shows the name and the date, and
nothing else, until the host presses. If the segment started moving straight
away, nobody would read the first frame, and the first frame is the only one
that says who this is for.

**Photos and messages share one run.** The photos and the messages are dealt
into a single sequence rather than played as a montage and then read as a list.
Both are shuffled, and the messages are spaced so every photo is used exactly
once and the run opens and closes on pictures. The old shape put forty-three
photographs in front of the room before a single person was quoted, which was
long enough for the room to stop looking at the photographs and for the
messages to arrive as a list to be got through. See `engine/sendoff.ts`.

**A long message is split across slides.** It is cut only at sentence ends, and
the author is shown on every slide. The real set runs to 489 characters, and
the whole of that on one screen is a paragraph the room reads rather than a
sentence it hears. Because every message is also set at one size, the longest
one was deciding the size of all thirteen. Splitting is most of why the type is
now roughly twice what it was.

**The host advances it.** This is the most important decision in the design and
the easiest one to get wrong. An auto-advancing montage moves on at a fixed
pace, past the message that makes the room go quiet and the photo somebody
reacts to, while the person it is all about sits there watching it happen.
The host presses the same space bar that drives every other segment. Auto-
advance exists as an option and is **off by default**, because a timer cannot
see how the room is reacting.

Auto is a button on the console rather than a setting in the file, because
both modes are wanted inside one segment: the photographs advance on their own
while the host talks over them, and then a message goes up and the room reads
it at its own pace. A slider sets seconds per photograph. A message holds
longer than whatever it says, scaled by its length, because the segment must
never take a message off the screen while the room is still reading it.
Space still advances early, Manual takes it back in one press, and the two
cards at either end never move on their own.

**The server keeps the clock.** Auto-advance runs on a timer in the session
rather than on each surface. Three surfaces counting separately would drift
apart, and if the console ran a slide ahead of the Desktop, the host could
press Skip on a message the room is still reading.

**Music plays across the whole run or not at all.** The track plays for the
whole run and stops at the closing card. This replaces an earlier rule that
scoped it to the photographs before the first message, which stopped meaning
anything once the photographs and the messages became one sequence. The rule
it keeps, explained in the music section, is that a track must not play under
somebody *reading aloud*, and the design keeps it because nobody reads aloud.

---

## What the host sees

The console shows the **next** kudo before the room does.

This is the same rule as the trivia console showing the answer before the
reveal, and it exists for a better reason here. Kudos are written by people who
did not know the room they would be read into, and one of them will be a joke
that does not survive being read out at a farewell. A host who can see what is
next can skip it without anybody knowing there was something to skip. Without
the preview, the host finds out at the same moment as the person it is about.

---

## The file

`config/events/<event>/sendoff.json`, beside the question set:

```json
{
  "for": {
    "name": "…",
    "subtitle": "Last day 20 March 2026"
  },
  "opening": {
    "photos": ["arrival.jpg", "offsite.jpg", "the-whiteboard.jpg"],
    "music": "send-off.mp3",
    "seconds": 40
  },
  "kudos": [
    { "from": "…", "message": "…" }
  ],
  "closing": {
    "photos": ["…"],
    "line": "…"
  }
}
```

The entries in both `photos` lists and `music` are filenames resolved against
the event directory, the same convention `additionalQuestions` and `promo`
already use in `session.json`.

**`for` is required**; everything else is optional, with one minimum. A
send-off is about somebody, and a file that does not say who gives the first
card nothing to show, so the importer refuses one without a `for.name` rather
than showing a blank Farewell card. `opening`, `closing`, and `kudos` may each
be left out, but not all of them: a file with no messages *and* no opening
photos has nothing to show, and is refused with those words.

So a send-off with no photos and no music is a list of messages, and a send-off
with photos and no messages is a montage, and both are valid. A send-off with
neither is a mistake, and the author should find that out at staging.

Unknown keys are errors, here as in the question file. A `"music"` key at the
top level instead of inside `opening` means the author believes they chose a
track, and if the importer ignored it silently, the send-off would run in
silence.

---

## Photos

A question set is a few kilobytes of text. Twenty photos are tens of megabytes,
and a DynamoDB item stops at 400KB, so photos cannot be stored the way the
question file is. Engine state is ruled out too, because the snapshot is
replayed and broadcast, and a JPEG should not pass through a reducer.

**One asset row per photo**, generalising the row the promo card uses. The
ceiling is `MAX_ASSET_BYTES`, 300,000 bytes, which leaves room for the key, the
content type, and the item's own overhead under DynamoDB's 400KB. The
alternative is a private S3 bucket served through the task role. That suits a
product with many events, but introducing it in the week of an event would need
new Terraform and new IAM, and would add a new way for the event to fail.

**You downscale photos before staging.** `make stage` uploads each file exactly
as it finds it on disk. It does not resize, re-encode, or convert anything,
because there is no image library in this repository, and adding one to the
staging path would put a native dependency between an event and its
photographs.

So downscale to about 1200px wide before you stage, which comes to about 150KB.
That is half the ceiling, and more resolution than a shared video call can carry
anyway. A photo straight off a phone is several megabytes and will be refused.

Instead, staging fails loudly and says exactly what went wrong. An oversized
photo is named, with its byte count and the advice to downscale it, and the run
carries on to the others rather than stopping at the first one. At the end it
prints the list of what did not go up, with the `curl` to retry exactly those.
That matters because a missing photo is invisible afterwards: the montage
preloads its keys and shows what decoded, so a hole in the run looks like a
photograph that was never chosen.

---

## Music

**Music is supported, plays across the whole run, and is off unless the file
says otherwise.**

It was scoped to the photographs before the first message for as long as the
run was a montage and then a list. Once the photographs and the messages were
dealt into one sequence there was no "before the first message" to scope it to,
and a track that faded up and down six times between photographs and quotations
would be worse than either leaving it on or leaving it off. So it starts when
the run starts and stops at the closing card: `music` is non-null in the view
only while the phase is `run`, so the view enforces it and no renderer has to
remember to.

This changes how the room is run, and that is the part to get right. The rule
below, that a track must not play under somebody *reading aloud*, still holds,
and the design now keeps it because nobody reads aloud. The people the messages
are for read them in silence, and the host talks over the photographs and stays
quiet during the quotations.

Three things go wrong with music over a video call, and the first gives no
warning:

1. **Tab audio is not shared unless somebody ticks a box.** Zoom, Teams, and
   Meet each put it somewhere different in the share dialog. Nobody finds out
   it was off until afterwards, when someone asks whether there was meant to be
   music.
2. **Noise suppression treats music as noise.** Every platform's default
   processing is tuned to remove exactly this, so a backing track arrives thin,
   intermittent, or not at all.
3. **Music under a person reading aloud means neither is heard.** The room hears
   a muddy mix of the two.

So the music runs under the whole run or not at all.

**The track will be a short loop.** An asset is a DynamoDB row and the item
limit is 400KB, so `MAX_ASSET_BYTES` is 300,000, which is about 43 seconds at
56 kbps mono. A run takes eight to fifteen minutes, and the element loops, so
that clip goes round a dozen times or more. Choose a track that still sounds
right after a dozen repeats, or accept the opening sting instead. Carrying a
whole track would mean chunking audio across several rows, which nothing here
does yet. A **preflight row** covers the first failure: *play three seconds and
ask somebody in the room whether they heard it.* Nothing else confirms it, and
the check takes ten seconds at 1:50pm, where the alternative is discovering the
problem at 3:41.

Autoplay policy is the other constraint: a browser will not start audio without
a user gesture, and the gesture has to happen in the Desktop tab. The host
starting the segment from the console is not a gesture *in that tab*. So the
Desktop arms audio on the first click or key it receives, which the host makes
anyway when they open it, and the preflight row also proves it armed.

---

## What the participants see

Participants see their own screen rather than a shrunken copy of the Desktop.
The phone shows the same kudo's text without the photo, so somebody whose
screen-share has frozen is still reading along, and the person being celebrated
is not watching the room watch a second copy of themselves.

There is nothing to tap. The points strip stays, because the competition has
not been settled yet at this point in most run of shows, and taking the
scoreboard away mid-send-off makes it look as if the session has ended.

---

## Accessibility and the things that will be got wrong

- **Every photo needs alternative text.** A montage of images with no
  description is nothing at all to a screen reader, at the one moment in the
  session that is entirely about a person.
- **`prefers-reduced-motion` turns the animation into a cut.** The transitions
  only decorate the messages, so cutting them loses nothing.
- **The messages are other people's words.** They are rendered as text, never
  as markup, and never through anything that would let a `<script>` in a kudos
  file reach the Desktop.
- **A message set large must stay readable at length.** Kudos are not a fixed
  size: one will be six words and one will be a paragraph, and the type has to
  step down rather than overflow or shrink to nothing.

---

## Not in scope

The service does not collect the kudos. A form, a channel thread, and a nudge
to fifteen people a week ahead is what fills this file, and organising that is
a facilitation problem the run of show already covers. The service reads a file
somebody else assembled.
