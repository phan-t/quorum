# Staging an event

An event is a directory. Staging it is one command, run from a terminal before
the room arrives.

```bash
awscreds
make stage EVENT=2026-03-12-example-offsite
```

That creates the session, loads its questions, stages the arcade's content if
the event has any, puts up the promo card if the event has one, uploads the
send-off and its photos if the event has those, stages the console's setup onto
it, and prints the four things there is no endpoint to return. Nothing else has
to happen before 2:00pm.

---

## The directory

```
config/events/2026-03-12-example-offsite/
  session.json            title, what the session scores, the console's setup
  additional-trivia-questions.json   optional: extra questions for this event, shuffled in
  arcade-content.json     optional: the arcade rounds' content for this event
  promo-card.html         optional: the poster shown in the Desktop's lobby
  sendoff.json            optional: the send-off's messages and photo names
  photos/                 the photos sendoff.json names
  send-off.mp3            optional: the track for the opening montage
  run-of-show.md          for the host to read; nothing parses it
  roster.md
```

The whole of `config/events/` is gitignored, because an event's material is
content about the people in the room and this repository is public. See
[`config/README.md`](../config/README.md).

### `session.json`

```json
{
  "title": "Example Team Offsite",
  "subtitle": "Thursday 12 March 2026",
  "arcadeContent": "arcade-content.json",
  "promo": "promo-card.html",
  "sendoff": "sendoff.json",
  "activities": [
    { "id": "trivia", "title": "Trivia", "kind": "trivia" },
    { "id": "arcade", "title": "Hashi Arcade", "kind": "arcade" }
  ],
  "console": {
    "cards": { "cards": [{ "id": "card-1", "title": "…", "line": "…" }] },
    "runbook": [{ "kind": "holding", "included": true, "id": "holding", "card": "card-1" }],
    "arcade": { "plan": ["recruitment", "plan_apply", "glass_bridge"], "timings": {} }
  }
}
```

`title`, `subtitle`, `questionCount`, `additionalQuestions`, `arcadeContent`,
`promo`, `sendoff`, and `activities` are the server's. Everything under `console` is the console's, and
the server never looks inside it.

**Trivia is drawn from the shared bank, fresh each time an event is staged.**
Every event plays 20 questions drawn at random from
[`config/event.example/trivia-questions.json`](../config/event.example/trivia-questions.json),
the set that is verified and kept up to date, so two events staged from it do
not ask the same 20. `questionCount` changes the 20.

An event's own questions are extras. Put them, such as a
few about the team or a farewell, in `additional-trivia-questions.json` in the
event's directory. Every one of them plays on top of the 20, shuffled in with
them rather than added at the end. Name a different file with
`additionalQuestions`. An event with no such file plays the 20 alone.

Three things follow from the shuffle:

- **Round labels are dropped.** A `round` puts a round card on the Desktop
  where the label changes, and a shuffled set would change it before nearly
  every question. Questions play without round cards.
- **Tiebreakers are kept out of the draw.** Questions flagged `"tiebreak": true`,
  from the bank or the extras, only feed sudden death, so they are always
  included and are never drawn or counted in the 20.
- **An upload error numbers the questions in the order they were drawn**, which
  matches neither file. Staging names both files when it reports one.

`session.json`'s old `questions` key is refused with a message saying where the
questions went, and a leftover `trivia-questions.json` in an event's directory
is not read; staging says so if it finds one.

`subtitle` is the second line under the name, such as a date, a time, or a
place. It is optional and null by default, and a session without one shows
nothing in its place.

`promo` can be left out. It defaults to `promo-card.html`, and an event with
no such file stages exactly as it did before promo cards existed. Set it to
`false` to skip the upload for an event that has the file but does not want it.

`sendoff` works the same way, defaulting to `sendoff.json`.

`arcadeContent` works the same way too, defaulting to `arcade-content.json`.
It is spelled out rather than called `arcade` because `console.arcade` is
already the console's running order for the rounds. With two keys called
`arcade` in one file, somebody editing it at 1:55pm will change the wrong one.

---

## What the session scores

`activities` is the list of things this event scores: a leaderboard column each,
and a term each in the tiebreak.

```json
"activities": [
  { "id": "trivia",  "title": "Trivia",       "kind": "trivia" },
  { "id": "arcade",  "title": "Hashi Arcade", "kind": "arcade" },
  { "id": "ttx",     "title": "Security TTX", "kind": "manual" }
]
```

**Leave it out and the session gets the default set** of trivia and the arcade.
Every session created before this key existed got that set, and most events
want it. The key is for an event that wants something else.

| | |
| --- | --- |
| `id` | Required. Lowercase letters, digits, `-`, and `_`, starting with a letter or a digit, ≤ 32 characters. Unique within the list. |
| `title` | Required, ≤ 40 characters. What the room, the console, and the CSV call it. |
| `kind` | Required. `trivia`, `arcade`, or `manual`. |
| `spotCap` | **Retired.** Spot Awards are gone, so this sets nothing. Accepted and ignored so that a file written for an earlier version still creates a session, as explained below. |

**At most one `trivia` and at most one `arcade`.** The engine holds one of each,
because `state.trivia` and `state.arcade` are single slots rather than maps
keyed by activity. A second trivia activity's question set would silently
replace the first's, and a second arcade activity could never be opened at all.
Both problems would only show up in the room, so both are refused when the
session is created.
Any number of `manual` activities is fine: a manual activity is scores typed in
against an id, and there is no slot to shadow.

**`manual` is for an activity judged off-platform.** A tabletop exercise run
and scored by somebody else, a paper quiz, a bake-off. The host types the
results into the console's scoring grid and they normalise like any other raw
score. Before adding one, consider that its column only fills in if the host
remembers to ask for the numbers, so in practice it is usually empty and always
slightly wrong. That is why the September 2026 huddle stopped scoring its TTX.

**The order is the tiebreak order.** A tie for first is settled by comparing
normalised points in each activity in turn, in the order they are written here,
before sudden death. Put the activity that should settle a tie first. There is
no separate `tiebreakOrder` key, because a second order would have to be kept
in step with this one, and nobody would look at it until there was a tie on the
screen.

**A question set is loaded into the `trivia` activity.** Staging uploads
the drawn questions to whichever activity has `"kind": "trivia"`, so an
`activities` list with no trivia activity cannot take a question file. Include
a trivia activity, or staging will stop at step 2.

### It is validated when the session is created, all or nothing

The whole list is rejected or none of it is. Each problem gets its own error,
addressed by position, for example `Activity 3, kind: "trvia" is not an activity kind.`
Staging prints those lines rather than the JSON. **Unknown keys are errors.**
Whoever wrote `"titel"` believes they named the activity, and silently
defaulting it would put a column called `trivia` on the screen. The rules
are in `app/src/activities/import.ts`, written to the same three rules as the
question and send-off importers.

**`spotCap` is the one exception.** It configured the Spot Award budget, Spot
Awards were removed, and it is now accepted and ignored rather than rejected.
Every `session.json` written before that change carries it, including the
example in this repository, and a deploy does not migrate files on disk.
Rejecting it would mean that removing a feature stops sessions from being
created, and whoever is staging the event would be the one to find out. The value is not read and nothing warns, because
there is nothing the operator can do about it except delete a key that no longer
means anything. Once no file anybody stages still has it, retire it by
rejecting it again.

**A session's activities cannot be changed after it is created.** They are
engine state, fixed at `POST /api/sessions`, and there is no endpoint that
edits them. Changing them means creating another session, which means another
join code and another set of tokens. The validation is this strict because
creation is the one moment it can run.

---

## The arcade's content

Four of the arcade's six rounds have content: Recruitment's emoji items,
Unseal's tins, Gganbu's Over/Under prompts, and the Glass Bridge's pairs. Plan /
Apply and Tug of Raft have none, because those rounds are played to a light and
a heartbeat and ask no questions. Each of the four sets is a literal compiled into `app/src/arcade/`,
and `arcade-content.json` replaces any of them for one session, so correcting a
Vault default or swapping an emoji cue needs a staged file and no deploy.

```json
{
  "title": "Example Team Offsite — arcade content",
  "recruitment": [
    { "cue": "🏦⏳", "answer": "Vault", "accept": [], "note": "…" }
  ],
  "unseal": [
    { "shape": "circle", "cue": "N P A L", "answer": "PLAN", "note": "…" }
  ],
  "glassBridge": [
    {
      "product": "Packer",
      "panes": [
        { "label": "Packer Pre-Processors", "note": "…" },
        { "label": "Packer Post-Processors", "note": "…" }
      ],
      "real": 1
    }
  ],
  "gganbu": [
    {
      "cue": "Consul's default raft_multiplier",
      "threshold": "3",
      "answer": "over",
      "note": "…",
      "verify": true
    }
  ]
}
```

[`config/event.example/arcade-content.json`](../config/event.example/arcade-content.json)
is a complete one: all four rounds, invented end to end for the example
directory. `title` is for whoever opens the file; nothing reads it, exactly as
nothing reads a question file's title.

**Every key is optional, and an absent key means that round plays the set
compiled into the build.** A file carrying only `gganbu` changes Gganbu and
nothing else, and an event that stages no file at all plays exactly what the
release shipped, as every session did before this existed.

**A second upload merges key by key.** Uploading a file that carries only
`unseal` leaves a `gganbu` staged by an earlier upload where it is rather than
clearing it, so a correction to one round does not require re-sending the
others. The inside of a round does *not* merge: a staged `unseal` is the whole
of that round's tins. Mixing half a staged set with half a compiled one would
produce a set nobody has read end to end, and Unseal's tiers are dealt from the
whole set.

Two uploads are refused rather than merged. **A file that stages no rounds at
all** is refused because whoever sent it meant something by it, and **an upload
once the arcade has begun** is refused because it would change the content under
a round that has already banked points for the old content. Correct content
before the first round card goes up. The ordinary path is `make stage` the day
before, so that is when it happens.

### What goes in each round

**Recruitment**: players type the product that two emoji describe.

| | |
| --- | --- |
| `cue` | The two emoji. |
| `answer` | The product. Matched after lowercasing and stripping non-letters. |
| `accept` | Optional. Aliases that also count: `["tf"]` for Terraform. Leave it out, or write `[]`, for an item with no aliases; the answer itself is always matched and does not belong in the list. |
| `note` | Read out at the reveal. |

**Unseal**: players pick a tin by shape and unscramble the word in it.

| | |
| --- | --- |
| `shape` | `circle`, `triangle`, `star`, or `umbrella`. The shape **is** the length: 4–5 letters, 6, 8, and 11 or more. |
| `cue` | The letters of `answer`, permuted and spaced, such as `"S I P G O S"` for GOSSIP. It is the only half a player ever sees. |
| `answer` | The word. The compiled set writes it in capitals, and the cue has to be its letters and not spell it out in order. |
| `note` | Read out at the reveal. |

A tier holding more than one word deals them out by arcade player number, so
two people sitting together are not unscrambling the same word. Put the most
words in the tiers the room actually picks: the circle is the cautious shape,
and in a room of thirty most of the room is in it. With one word in a tier, one
person can say it out loud and solve the tier for everybody in it, so **a shape
that appears at all needs at least three tins**. Leaving a shape out of the file
*entirely* is a valid choice, because the picker greys it out and the round runs
on three tiers. A shape with one or two tins is refused, because the picker
offers it.

**The Glass Bridge**: two panes for one product, and one of them is a real feature.

| | |
| --- | --- |
| `product` | Shown with the step, and identical for both panes. Both panes are the same product so that the step is won by knowing the feature, and recognising the product line does not help. |
| `panes` | Exactly two, in display order. Each has a `label` and a reveal `note`, and a fake's note says why it is fake. |
| `real` | `0` or `1`: which pane is the real feature. |

Do not always make the invented pane the odd-sounding one, or an engineer will
have worked out the rule by step two. The shipped board pairs an obscure-but-real
feature against a plausible invention four times out of six and the other way
round twice, so there is no rule to find.

**Gganbu**: an Over/Under wager against a threshold.

| | |
| --- | --- |
| `cue` | The question, shown with the threshold. |
| `threshold` | The number wagered against, as a string. |
| `answer` | `over` or `under`. |
| `note` | Read out at the reveal, with the real figure in it. |
| `verify` | Whether the answer was checked before the session. It travels with the answer and never with the prompt, because a flag shown beside a question nudges the player. |

**A prompt with a certain answer does not work in this round.** If both halves
of a pair know the answer cold, they make two minimum wagers and tie, and a tie
is the one outcome a betting round cannot separate. Set each threshold a
plausible distance from its answer: close enough that a well-informed player is
not sure enough to stake five tokens, and far enough that no patch release or
disputed month can move the answer across the line. The importer cannot check
whether a threshold sits at that distance. It does refuse **a bank that answers
the same way every time**, because the first reveal would give away the rest of
the round, and in this round certainty is worth five tokens.

### It is validated on upload, all or nothing

The rules are the question file's, applied to a file with four rounds in it, and
they live in `app/src/arcade/import.ts`:

- **Unknown keys are errors.** The author of a `"verify_"` believes they
  flagged the prompt, and defaulting it to `false` would leave the room to find
  out.
- **The whole file is rejected or none of it is**, and every problem comes back
  at once. A bank with prompt 5 missing is otherwise discovered live.
- **Errors are addressed by round and index**, such as `gganbu[2]` or
  `glassBridge[4], panes[1].label`. The index is **0-based**, because it is the
  path into the array the file itself is writing. Staging prints those lines
  rather than the JSON.

A rejected upload changes nothing: the session keeps whatever was staged before
it, and any round that has never been staged keeps playing its compiled set.

### Every note is read out to the room

A reveal note is a claim about a HashiCorp product, made by the House in front
of people who use these products for a living, so a note that is confidently
wrong costs more than no note at all. Check each fact against the product's
current documentation rather than recalling it, and keep version numbers out,
because a release number is a second fact that can be wrong. The headers of
`app/src/arcade/recruitment.ts`, `unseal.ts`, `gganbu.ts`, and `glass-bridge.ts`
record what that discipline has already caught, including two notes that read
well aloud and described an archived product.

### It is staged from a terminal because it carries the answers

**Each of these four sets carries its own answers.** A Gganbu prompt holds the
answer, the reveal note and the VERIFY flag; a Glass Bridge step holds which
pane is real; an Unseal tin holds the word. The prompts do not travel on the
`arcade.round` host command for that reason, because six prompts sent from a
browser would put the answer key in a browser. The same holds for all four
rounds.

So this is an upload from the host's machine to the server over HTTPS,
authenticated by the host token, and the browser never holds the file. There is
no console control that loads arcade content and there should not be one.
Somebody who wants to change a cue, a tin, or a threshold edits this file and
runs `make stage`.

### It is session state

Unlike the promo card and the send-off's photos, the staged content lives *in*
the session, next to the question set and for the same reason: one snapshot and
one event log have to restore the whole session, and a crash between two rounds
must come back with the same answers in it. It is a few kilobytes of text, so
keeping it in the session is affordable.

### What staging does

After the session and its questions, and before the promo card and the photos,
staging uploads the file to `POST /api/sessions/:sid/content/arcade` with the
host token and `application/json`.

Like the promo card it is **optional and non-fatal**. An event with no
`arcade-content.json` stages exactly as it did before this existed, and a
failure prints the importer's errors and the `curl` that retries it rather than
exiting. By then the session exists, and re-running staging would create a
second one with a different join code and different tokens. **A failure never
leaves a round unable to run.** Every round the upload did not reach plays its
compiled set, so the cost of a failed upload is a room playing the content the
build shipped.

```bash
curl -X POST "$QUORUM_URL/api/sessions/$SID/content/arcade" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: application/json' \
  --data-binary @config/events/<event>/arcade-content.json
```

Run that command when staging warns that the arcade content did not go up. Do
not re-run `make stage`.

---

## The promo card

The promo card is a self-contained HTML page holding the event's poster, shown
in the Desktop's lobby beside the join link and the QR while the room arrives.
It is one file with everything inline, and no more than 300,000 characters.

It goes up **last**, after the session and its questions, and it is the one
step of staging that is allowed to fail. If it does, staging says so, prints
the `curl` that retries it, and finishes, because by then the session exists
and re-running staging would create a *second* one, with a different join code
and different tokens. A poster is not worth that.

It is not session state. It never enters `SessionState`, the snapshot, or the
event log. All three are replayed on restart and broadcast to every socket, and
none of them should be carrying a quarter of a megabyte of markup. It is a
store row of its own, beside `META`, read by one endpoint and nothing else.

### It is served without a token

`GET /api/sessions/:sid/promo` takes no Authorization header, alone among the
session's endpoints. The Desktop embeds it in an `<iframe>`, and an iframe
cannot carry one.

That is acceptable because of what a promo card *is*: a poster the room is
about to look at on a shared screen. Whoever fetches it learns only something
that is seconds from being projected, and it holds no scores, no roster, and no
names. Asking still takes the session id, which is not guessable, and a session
with no card answers exactly as an unknown session does, so it is not a way to
find out which ids are real.

Do not put anything in a promo card that the session's tokens are protecting.

### The card is sandboxed

It is framed with a bare `sandbox` attribute, which is the empty allow-list and
so permits no scripts, same-origin access, forms, or popups. It is served under
a Content-Security-Policy with `connect-src 'none'` and `frame-ancestors 'self'`.
The Desktop is the surface being screen-shared, and an embedded poster must not
be able to tell anyone which room is looking at it.

This has two consequences for anyone writing a card:

- **Webfonts do not load.** Name local fallbacks in every font stack.
- **Scripts do not run.** A card that needs them can be framed with
  `sandbox="allow-scripts"` and nothing else, but that is a change to the
  Desktop and cannot be made in the card. `allow-scripts` must never be paired
  with `allow-same-origin`, because together they give the page the Desktop's
  own origin and the sandbox no longer restricts anything.

---

## The send-off

`sendoff.json` names the person, carries the messages, and lists the photos by
**filename**. The photos themselves are separate files in the event directory,
and staging uploads each one after the JSON. See
[`docs/sendoff.md`](sendoff.md) for what the segment is and why it is shaped
this way; this section is about the files and what staging does with them.

```json
{
  "for": {
    "name": "Alex Rivera",
    "subtitle": "Last day 20 March 2026"
  },
  "opening": {
    "photos": ["photos/p01.jpg", "photos/p02.jpg"],
    "music": "send-off.mp3",
    "seconds": 40
  },
  "kudos": [
    { "from": "Sam", "message": "Thank you for every review you left on my terrible first PRs." }
  ],
  "closing": {
    "photos": ["photos/p43.jpg"],
    "line": "See you around."
  }
}
```

`for` and `kudos` are required, because a send-off is about somebody and the
messages are its content. `opening` and `closing` are optional, and a send-off
with no photos and no music is a list of messages, which is still a complete
send-off.

| | |
| --- | --- |
| `for.name` | ≤ 80 characters. |
| `for.subtitle` | Optional, ≤ 120 characters. |
| `opening.photos` | Filenames relative to the event directory, ≤ 200 of them, no repeats within one montage. Must end in `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, or `.avif`. |
| `opening.music` | Optional. `.mp3`, `.m4a`, `.aac`, `.ogg`, `.oga`, `.wav`, or `.flac`. Only plays under the opening montage, so a track with no opening photos is an error. |
| `opening.seconds` | 5–300, default 40. How long the montage runs before the host advances. |
| `kudos[].from`, `kudos[].message` | Both required. ≤ 80 and ≤ 2,000 characters. |
| `closing.photos`, `closing.line` | Both optional. The line is ≤ 280 characters. |

**Unknown keys are errors**, exactly as in the question file. Whoever puts
`"music"` at the top level instead of inside `opening` believes they set a
track, and without the error the montage would run in silence in front of the
room.

**The whole file is rejected or none of it is.** Errors come back addressed,
such as `Kudo 4, message: …` and `opening.photos: Photo 19: …`, so whoever fixes
the file knows which line to change and does not have to guess.

### The photos

Every photo must be **300,000 bytes or less**, because it is stored as one
DynamoDB row and an item stops at 400KB. Treat that as the ceiling and aim
lower: downscale to about 1200px wide as JPEG, which lands nearer 150KB and is more
resolution than a shared video call carries anyway.

Downscale **before staging**, on your own machine. The service never sees the
original, and a 12MB photo straight off a phone fails to upload and never
reaches the montage.

```bash
mkdir -p photos
for f in originals/*.jpg; do
  sips -Z 1200 -s format jpeg -s formatOptions 70 "$f" --out "photos/$(basename "$f")"
done
```

### What staging does

After the session, the questions, and the promo card, staging uploads
`sendoff.json` and then each photo and music file it names, with one request
per file. It reports progress, because forty-three photos is the slowest
part of staging by a wide margin.

Like the promo card, it is **optional and non-fatal**: an event with no
`sendoff.json` stages exactly as it did before, and a failure here prints what
went wrong and the `curl` that fixes it rather than exiting. By that point the
session exists, and re-running staging would create a second one.

A photo that failed can be re-uploaded on its own:

```bash
curl -X POST "$QUORUM_URL/api/sessions/$SID/assets/photos%2Fp19.jpg" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: image/jpeg' \
  --data-binary @config/events/<event>/photos/p19.jpg
```

### The photos are served without a token

`GET /api/sessions/:sid/assets/<key>` takes no Authorization header, for the
same two reasons as the promo card: these are `<img>` and `<audio>` sources and
neither element can carry one, and they hold a montage the room is about to
watch on a shared screen. They hold no scores, no roster, and no names. It still
takes the session id, which is not guessable, and a key that was never uploaded
answers exactly as an unknown session does.

They are served with `nosniff` and a year-long immutable `cache-control`. The
bytes under a key never change, because a new staging run creates a new session
id. Without that header, a montage would re-fetch forty photos on every frame
and stutter over the conference wifi, even though it played smoothly on the
laptop it was tested on.

**Do not put a photo in here that the session's tokens are protecting.**

### None of it is session state

The messages and the photo *keys* are engine state, and they are small. The
photo *bytes* are not: they live in store rows of their own, in their own
partition, read by one endpoint and nothing else. A snapshot is replayed on
restart and broadcast to every socket, and seven megabytes of JPEG should not
be in either.

---

## Why staging uses a file and a command instead of a screen

**A browser upload cannot be prestaged.** It needs a person clicking at nine in
the morning. A file and a command can be run from a script, or twice, or by
somebody who is not the person who wrote them, and staging exists so that the
work happens the day before.

**The console is a driving surface.** Every control it has is one the host
presses while talking to thirty people. Configuration needs to be reviewable
and slow, while driving needs one key per action and controls that are hard to
hit by mistake, so the two need opposite designs. The same reasoning removed the
question-set file picker, and it applies to everything else that would be added
beside it.

**The setup should belong to the session rather than to a browser.** Holding
cards, the runbook order, and the arcade running order used to live only in one
browser's `localStorage`. Clearing your site data, or opening the console in a
second profile, lost them, and the host would find that out at 1:55pm.

**Content is loaded in one place.** Two paths would have to be kept in step,
and at 1:55pm nobody could reliably answer "did I upload the file or set it in
the console?"

---

## How the console's half gets there

Staging sends `console` to `POST /api/sessions`, which keeps it **verbatim and
unparsed** in the session's META row beside the token hashes. The server does not
interpret its contents and never acts on them: it is the console's own
vocabulary, versioned by the console, and a server that understood it would be
a second place to change every time the console's storage format moved.

The console asks for it once, on the first state that carries a session id, and
applies it **once per session id**:

- **The first time this console opens that session, the staged setup wins.**
  The first version only filled in what was empty, and that did not work: the
  console writes its own default runbook at startup, so by the time the
  staged copy arrived the key was occupied by a default nobody had chosen.
- **After that, the host's edits always win.** Every reload keeps them. A
  host who staged one session and hand-built another does not get the two
  bleeding into each other.
- **It cannot fail loudly.** No network, no storage, a 401, malformed JSON, an
  older server with no such endpoint: each one leaves the console exactly as it
  behaves without any of this.

It writes the staged text into the storage keys and re-runs the loaders the
console already has, rather than parsing the staged shape itself. That keeps one
parser per format, and a staged file the loader would reject is ignored the same way a
corrupt stored value is.

---

## What is not in here yet

`session.json` covers the title and subtitle, the questions, the arcade's
content, the promo card, the send-off, what the session scores, and the
console's setup. It does not yet carry the practice flag, per-question timer overrides, or
the arcade's timings as anything but the console's own `timings` object. Those are all
server-side or engine-side state and each needs its own decision about whether
staging should set it or the host should. Add them one at a time, and keep the
rule that the server does not parse the console's half.
