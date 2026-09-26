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
  trivia-questions.json   the question set
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
  "questions": "trivia-questions.json",
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

`title`, `subtitle`, `questions`, `arcadeContent`, `promo`, `sendoff` and
`activities` are the server's. Everything under `console` is the console's, and
the server never looks inside it.

`subtitle` is the second line under the name — a date, a time, a place. Optional
and null by default; a session without one shows nothing in its place.

`promo` can be left out — it defaults to `promo-card.html`, and an event with
no such file stages exactly as it did before promo cards existed. Set it to
`false` to skip the upload for an event that has the file but does not want it.

`sendoff` works the same way, defaulting to `sendoff.json`.

`arcadeContent` works the same way too, defaulting to `arcade-content.json`.
It is spelled out rather than called `arcade` because `console.arcade` is
already the console's running order for the rounds, and two keys called
`arcade` in one file is a file that gets edited in the wrong half at five to
two.

---

## What the session scores

`activities` is the list of things this event scores: a leaderboard column
each, a Spot Award budget each, and a term each in the tiebreak.

```json
"activities": [
  { "id": "trivia",  "title": "Trivia",       "kind": "trivia" },
  { "id": "arcade",  "title": "Hashi Arcade", "kind": "arcade" },
  { "id": "ttx",     "title": "Security TTX", "kind": "manual", "spotCap": 2 }
]
```

**Leave it out and the session gets the default set** — trivia and the arcade,
with two Spot Awards each. That is what every session created before this key
existed got, and it is what most events want; the key is for the event that
wants something else.

| | |
| --- | --- |
| `id` | Required. Lowercase letters, digits, `-` and `_`, starting with a letter or a digit, ≤ 32 characters. Unique within the list. |
| `title` | Required, ≤ 40 characters. What the room, the console and the CSV call it. |
| `kind` | Required. `trivia`, `arcade` or `manual`. |
| `spotCap` | Optional, default 2, 0–10. Spot Awards this activity's facilitator may grant. |

**At most one `trivia` and at most one `arcade`.** The engine holds one of each
— `state.trivia` and `state.arcade` are single slots, not maps keyed by
activity — so a second trivia activity's question set would silently replace
the first's, and a second arcade activity could never be opened at all. Both
are discovered in the room, so both are refused when the session is created.
Any number of `manual` activities is fine: a manual activity is scores typed in
against an id, and there is no slot to shadow.

**`manual` is for an activity judged off-platform.** A tabletop exercise run
and scored by somebody else, a paper quiz, a bake-off. The host types the
results into the console's scoring grid and they normalise like any other raw
score. Worth knowing before adding one: a column that only fills in if the host
remembers to ask for the numbers is a column that is usually empty and always
slightly wrong, which is exactly why the September 2026 huddle stopped scoring
its TTX.

**The order is the tiebreak order.** A tie for first is settled by comparing
normalised points in each activity in turn, in the order they are written here,
before sudden death. Put the activity that should settle a tie first. There is
no separate `tiebreakOrder` key: two orders in one file is two things to keep
in step, and the one that gets forgotten is the one nobody looks at until there
is a tie on the screen.

**A question set is loaded into the `trivia` activity.** Staging uploads
`trivia-questions.json` to whichever activity has `"kind": "trivia"`, so an
`activities` list with no trivia activity is one that cannot take a question
file — leave `questions` pointing at a file that exists and include a trivia
activity, or expect staging to stop at step 2.

### It is validated when the session is created, all or nothing

The whole list is rejected or none of it is, with an error per problem,
addressed by position — `Activity 3, kind: "trvia" is not an activity kind.` —
and staging prints those lines rather than the JSON. **Unknown keys are
errors**: a `"spotcap"` is somebody who believes they set a cap, and silently
defaulting it to 2 is how a facilitator runs out of awards in front of the
room. The rules are in `app/src/activities/import.ts`, written to the same
three rules as the question and send-off importers.

**A session's activities cannot be changed after it is created.** They are
engine state, fixed at `POST /api/sessions`, and there is no endpoint that
edits them — changing them means creating another session, which means another
join code and another set of tokens. That is the reason the validation is this
strict at the one moment it can be.

---

## The arcade's content

Four of the arcade's six rounds have content: Recruitment's emoji items,
Unseal's tins, Gganbu's Over/Under prompts and the Glass Bridge's pairs. Plan /
Apply and Tug of Raft have none — a light and a heartbeat are rules, not
questions. Each of the four sets is a literal compiled into `app/src/arcade/`,
and `arcade-content.json` replaces any of them for one session, so correcting a
Vault default or swapping an emoji cue is a staged file rather than a deploy.

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
release shipped — which is what every session did before this existed.

**A second upload merges key by key.** Uploading a file that carries only
`unseal` leaves a `gganbu` staged by an earlier upload where it is rather than
clearing it, so a correction to one round does not require re-sending the
others. What does *not* merge is the inside of a round: a staged `unseal` is the
whole of that round's tins. Half a staged set beside half a compiled one is a
set nobody has read end to end, and Unseal's tiers are dealt from the whole.

Two uploads are refused rather than merged. **A file that stages no rounds at
all** is somebody who meant something by it, and **an upload once the arcade has
begun** is content changing under a round that has already banked points for the
old one. Correcting content is a thing to do before the first round card goes
up — which, since the ordinary path is `make stage` the day before, it is.

### What goes in each round

**Recruitment** — two emoji, one product, typed.

| | |
| --- | --- |
| `cue` | The two emoji. |
| `answer` | The product. Matched after lowercasing and stripping non-letters. |
| `accept` | Optional. Aliases that also count: `["tf"]` for Terraform. Leave it out, or write `[]`, for an item with no aliases; the answer itself is always matched and does not belong in the list. |
| `note` | Read out at the reveal. |

**Unseal** — a scrambled word in a tin, picked by shape.

| | |
| --- | --- |
| `shape` | `circle`, `triangle`, `star` or `umbrella`. The shape **is** the length: 4–5 letters, 6, 8, and 11 or more. |
| `cue` | The letters of `answer`, permuted and spaced — `"S I P G O S"` for GOSSIP. The only half a player ever sees. |
| `answer` | The word. The compiled set writes it in capitals, and the cue has to be its letters and not spell it out in order. |
| `note` | Read out at the reveal. |

A tier holding more than one word deals them out by arcade player number, so
two people sitting together are not unscrambling the same word. Put the most
words in the tiers the room actually picks: the circle is the cautious shape,
and in a room of thirty most of the room is in it. One word in a tier is one
person saying it out loud and solving the tier for everybody in it, which is
why **a shape that appears at all needs at least three tins**. A shape left out
of the file *entirely* is fine and is a choice — the picker greys it out and the
round runs on three tiers — but a shape with one or two tins is refused, because
the picker offers it.

**The Glass Bridge** — two panes for one product, one of them a real feature.

| | |
| --- | --- |
| `product` | Shown with the step, and identical for both panes. Both panes being the same product is the point: the step is won by knowing the feature, not by recognising the product line. |
| `panes` | Exactly two, in display order. Each has a `label` and a reveal `note`, and a fake's note says why it is fake. |
| `real` | `0` or `1`: which pane is the real feature. |

Do not make the invented pane always the odd-sounding one, or the board is one
rule an engineer has by step two. The shipped board pairs an obscure-but-real
feature against a plausible invention four times out of six and the other way
round twice, so there is no rule to find.

**Gganbu** — an Over/Under wager against a threshold.

| | |
| --- | --- |
| `cue` | The question, shown with the threshold. |
| `threshold` | The number wagered against, as a string. |
| `answer` | `over` or `under`. |
| `note` | Read out at the reveal, with the real figure in it. |
| `verify` | Whether the answer was checked before the session. It travels with the answer and never with the prompt — a flag beside a question is a nudge. |

**A certainty is a bug in this round.** A prompt both halves of a pair know cold
produces two minimum wagers and a tie, which is the one outcome a betting round
has nothing to say about. Set each threshold a plausible distance from its
answer — close enough that a well-informed player is not sure enough to stake
five tokens, far enough that no patch release or disputed month can move the
answer across the line. Whether a threshold really sits at that distance is not
something an importer can check; what it does refuse is **a bank that answers
the same way every time**, because the first reveal would hand over the rest of
the round, and this is the round where certainty is worth five tokens.

### It is validated on upload, all or nothing

The rules are the question file's, applied to a file with four rounds in it, and
they live in `app/src/arcade/import.ts`:

- **Unknown keys are errors.** A `"verify_"` is a prompt whose author believes
  they flagged it, and defaulting it to `false` is how the room finds out.
- **The whole file is rejected or none of it is**, and every problem comes back
  at once. A bank with prompt 5 missing is otherwise discovered live.
- **Errors are addressed by round and index** — `gganbu[2]`,
  `glassBridge[4], panes[1].label` — and the index is **0-based**, because it is
  the path into the array the file itself is writing. Staging prints those lines
  rather than the JSON.

A rejected upload changes nothing: the session keeps whatever was staged before
it, and any round that has never been staged keeps playing its compiled set.

### Every note is read out to the room

A reveal note is a claim about a HashiCorp product, made by the House in front
of people who use these products for a living, so a note that is confidently
wrong costs more than no note at all. Check each fact against the product's
current documentation rather than recalling it, and keep version numbers out —
a release number is a second fact to be wrong about. The headers of
`app/src/arcade/recruitment.ts`, `unseal.ts`, `gganbu.ts` and `glass-bridge.ts`
record what that discipline has already caught, including two notes that read
perfectly well aloud and described an archived product.

### It is staged from a terminal, and that is the safe part

**Each of these four sets carries its own answers.** A Gganbu prompt holds the
answer, the reveal note and the VERIFY flag; a Glass Bridge step holds which
pane is real; an Unseal tin holds the word. That is exactly why the prompts do
not travel on the `arcade.round` host command — six prompts from a browser
would be the answer key from a browser — and it is true of all four rounds.

So this is an upload from the host's machine to the server over HTTPS,
authenticated by the host token, and the browser never holds the file. There is
no console control that loads arcade content and there should not be one.
Somebody who wants to change a cue, a tin or a threshold edits this file and
runs `make stage`.

### It is session state

Unlike the promo card and the send-off's photos, the staged content lives *in*
the session, next to the question set and for the same reason: one snapshot and
one event log have to restore the whole session, and a crash between two rounds
must come back with the same answers in it. It is a few kilobytes of text, which
is what makes that affordable.

### What staging does

After the session and its questions, and before the promo card and the photos,
staging uploads the file to `POST /api/sessions/:sid/content/arcade` with the
host token and `application/json`.

Like the promo card it is **optional and non-fatal**. An event with no
`arcade-content.json` stages exactly as it did before this existed, and a
failure prints the importer's errors and the `curl` that retries it rather than
exiting — by then the session exists, and re-running staging would create a
second one with a different join code and different tokens. **A failure is never
a round that cannot run:** every round the upload did not reach plays its
compiled set, so the cost of a failed upload is a room playing the content the
build shipped.

```bash
curl -X POST "$QUORUM_URL/api/sessions/$SID/content/arcade" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: application/json' \
  --data-binary @config/events/<event>/arcade-content.json
```

That is the command to reach for when staging warns that the arcade content did
not go up. Re-running `make stage` is not.

---

## The promo card

A self-contained HTML page: the event's poster, shown in the Desktop's lobby
beside the join link and the QR while the room arrives. One file, everything
inline, no more than 300,000 characters.

It goes up **last**, after the session and its questions, and it is the one
step of staging that is allowed to fail. If it does, staging says so, prints
the `curl` that retries it, and finishes — because by then the session exists
and re-running staging would create a *second* one, with a different join code
and different tokens. A poster is not worth that.

It is not session state. It never enters `SessionState`, the snapshot or the
event log — all three are replayed on restart and broadcast to every socket,
and none of them should be carrying a quarter of a megabyte of markup. It is a
store row of its own, beside `META`, read by one endpoint and nothing else.

### It is served without a token

`GET /api/sessions/:sid/promo` takes no Authorization header, alone among the
session's endpoints. The Desktop embeds it in an `<iframe>`, and an iframe
cannot carry one.

That is acceptable because of what a promo card *is*: a poster the room is
about to look at on a shared screen. Whoever fetches it learns something that
is seconds from being projected, and nothing else — no scores, no roster, no
names. Asking still takes the session id, which is not guessable, and a session
with no card answers exactly as an unknown session does, so it is not a way to
find out which ids are real.

Do not put anything in a promo card that the session's tokens are protecting.

### What the card can do, which is nothing

It is framed with a bare `sandbox` attribute — the empty allow-list: no
scripts, no same-origin, no forms, no popups — and served under a
Content-Security-Policy with `connect-src 'none'` and `frame-ancestors 'self'`.
The Desktop is the surface being screen-shared, and an embedded poster has no
business being able to tell anyone which room is looking at it.

Two consequences worth knowing before you write a card:

- **Webfonts do not load.** Name local fallbacks in every font stack.
- **Scripts do not run.** A card that needs them can be framed with
  `sandbox="allow-scripts"` and nothing else, but that is a change to the
  Desktop, not to the card, and `allow-scripts` must never be paired with
  `allow-same-origin` — together they hand the page the Desktop's own origin
  and the sandbox stops meaning anything.

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

`for` and `kudos` are required — a send-off is about somebody, and the messages
are the thing. `opening` and `closing` are optional, and a send-off with no
photos and no music is a list of messages, which is still the thing.

| | |
| --- | --- |
| `for.name` | ≤ 80 characters. |
| `for.subtitle` | Optional, ≤ 120 characters. |
| `opening.photos` | Filenames relative to the event directory, ≤ 200 of them, no repeats within one montage. Must end in `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif` or `.avif`. |
| `opening.music` | Optional. `.mp3`, `.m4a`, `.aac`, `.ogg`, `.oga`, `.wav` or `.flac`. Only plays under the opening montage, so a track with no opening photos is an error. |
| `opening.seconds` | 5–300, default 40. How long the montage runs before the host advances. |
| `kudos[].from`, `kudos[].message` | Both required. ≤ 80 and ≤ 2,000 characters. |
| `closing.photos`, `closing.line` | Both optional. The line is ≤ 280 characters. |

**Unknown keys are errors**, exactly as in the question file. A `"music"` at
the top level instead of inside `opening` is somebody who believes they set a
track, and a montage that runs in silence is discovered in front of the room.

**The whole file is rejected or none of it is.** Errors come back addressed —
`Kudo 4, message: …`, `opening.photos: Photo 19: …` — so what gets fixed is the
line rather than the guess.

### The photos

Every photo must be **300,000 bytes or less**, because it is stored as one
DynamoDB row and an item stops at 400KB. That is a ceiling, not a target:
downscale to about 1200px wide as JPEG, which lands nearer 150KB and is more
resolution than a shared video call carries anyway.

Downscale **before staging**, on your own machine. The service never sees the
original, and a 12MB photo straight off a phone becomes a failed upload rather
than a montage frame.

```bash
mkdir -p photos
for f in originals/*.jpg; do
  sips -Z 1200 -s format jpeg -s formatOptions 70 "$f" --out "photos/$(basename "$f")"
done
```

### What staging does

After the session, the questions and the promo card, staging uploads
`sendoff.json` and then every file it names — the photos and the music — one
request each. It reports progress, because forty-three photos is the slowest
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
promo card's reason twice over: these are `<img>` and `<audio>` sources and
neither element can carry one, and what they carry is a montage the room is
about to watch on a shared screen. No scores, no roster, no names. It still
takes the session id, which is not guessable, and a key that was never uploaded
answers exactly as an unknown session does.

They are served with `nosniff` and a year-long immutable `cache-control`. The
bytes under a key never change — a new staging run is a new session id — and a
montage that re-fetches forty photos on every frame is a montage that stutters
over the conference wifi rather than on the laptop it was tested on.

**Do not put a photo in here that the session's tokens are protecting.**

### None of it is session state

The messages and the photo *keys* are engine state, and they are small. The
photo *bytes* are not: they live in store rows of their own, in their own
partition, read by one endpoint and nothing else. A snapshot is replayed on
restart and broadcast to every socket, and seven megabytes of JPEG has no
business in either.

---

## Why a file and a command, and not a screen

**A browser upload cannot be prestaged.** It needs a person clicking at nine in
the morning. A file and a command can be run from a script, or twice, or by
somebody who is not the person who wrote them, and the whole point of staging is
that the work happens the day before.

**The console is a driving surface.** Every control it has is one the host
presses while talking to thirty people, and configuration and driving want
opposite designs — one wants to be reviewable and slow, the other wants to be
one key and impossible to mis-hit. That is the same reasoning that removed the
question-set file picker, and it applies to everything else that would be added
beside it.

**The setup should belong to the session, not to a browser.** Holding cards,
the runbook order and the arcade running order used to live only in one
browser's `localStorage`. Clear your site data, or open the console in a second
profile, and they were gone — which is a poor way to find out at 1:55pm.

**One place to load content.** Two paths mean two things to keep in step, and
"did I upload the file or set it in the console?" is a question with no good
answer at five to two.

---

## How the console's half gets there

Staging sends `console` to `POST /api/sessions`, which keeps it **verbatim and
unparsed** in the session's META row beside the token hashes. The server has no
opinion about its contents and never acts on them: it is the console's own
vocabulary, versioned by the console, and a server that understood it would be
a second place to change every time the console's storage format moved.

The console asks for it once, on the first state that carries a session id, and
applies it **once per session id**:

- **First time this console opens that session, the staged setup wins.** Not
  "fill in what is empty", which is what this did first and which did not work:
  the console writes its own default runbook at startup, so by the time the
  staged copy arrived the key was occupied by a default nobody had chosen.
- **After that, the host's edits win, for good.** Every reload keeps them. A
  host who staged one session and hand-built another does not get the two
  bleeding into each other.
- **It cannot fail loudly.** No network, no storage, a 401, malformed JSON, an
  older server with no such endpoint: each one leaves the console exactly as it
  behaves without any of this.

It writes the staged text into the storage keys and re-runs the loaders the
console already has, rather than parsing the staged shape itself. One parser
per format, and a staged file the loader would reject is ignored the same way a
corrupt stored value is.

---

## What is not in here yet

`session.json` covers the title and subtitle, the questions, the arcade's
content, the promo card, the send-off, what the session scores and the console's
setup. It does not yet carry the practice flag, per-question timer overrides, or
the arcade's timings as anything but the console's own `timings` object. Those are all
server-side or engine-side state and each needs its own decision about whether
staging should set it or the host should. Add them one at a time, and keep the
rule that the server does not parse the console's half.
