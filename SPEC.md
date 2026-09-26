# Quorum — product spec

One URL that runs a team-building session end to end. Participants open it,
paste a join code, type a nickname, and never navigate again: the host decides
what the page shows, from the lobby to the winner.

This document is the *what* and the *why*. [ARCHITECTURE.md](ARCHITECTURE.md)
is the how; [DESIGN.md](DESIGN.md) is what it looks like.

**A note on what is built.** Quorum has run a real event, and this document
still describes some things that were designed and never built. Those are
marked **Not built** where they appear, with what actually happens instead.
The design reasoning is kept rather than deleted: it is why the feature was
wanted, and it is the starting point for anyone who builds it. A claim without
that marker is a claim about the running service.

## The problem

The huddle these sessions replace ran on three things that did not know about
each other:
Kahoot for trivia, a host-driven browser board for the arcade, and a
spreadsheet for the scores. They work. What they cost is the seams between
them.

Every seam is a name match done by a person under time pressure. The roster has
to be identical in Kahoot, on the arcade board and in the CSV, and the
facilitation notes said so in bold because it failed every time: someone joins
Kahoot as `asdf`, the scorekeeper
spends the three-minute break doing detective work, and a score goes in the
wrong row. The arcade needs a second person watching chat and typing names. The
seal-and-reveal — the best idea in the scoring design — is a spreadsheet the
scorekeeper remembers to stop sharing.

Quorum removes the seams by making identity one thing (you join once), scoring
one thing (every activity writes to the same board, normalised automatically),
and the host's attention one thing (a console, not four windows).

## What it deliberately does not do

- **No accounts, no SSO.** Nickname plus join code, like Kahoot. The threat
  model is "a colleague joins twice as a joke", and the host has a kick button.
  Designing more identity than that would cost more than every problem it
  solves.
- **No teams.** Everyone scores as an individual, exactly as
  [SCORING.md](SCORING.md) argues. The data
  model does not forbid teams later; the product does not build them now.
- **No content authoring UI.** Trivia comes from a JSON file; arcade rounds
  are files in this repo. A form-based question editor is a second product.
- **No chat, video or audio.** The video call is the room. Quorum is what is on
  the shared screen and in everyone's hand.
- **It does not run the TTX.** The Agentic Security TTX happens off-platform;
  Quorum holds the screen and takes the scores.
- **Not a SaaS.** One team's tool, self-hosted, a handful of sessions a year.
  It will happily run a few sessions at once; it is not designed for a
  thousand.

## The three surfaces

| Surface | Path | Device | Who |
| --- | --- | --- | --- |
| **Participant** | `/` and `/j/<CODE>` | Laptop, a second window beside the call | Everyone playing |
| **Host console** | `/host#<token>` | Laptop, *not* screen-shared | Facilitator, co-host |
| **Desktop** | `/screen#<token>` | The tab that gets screen-shared | Nobody touches it |

**The Desktop was called the "big screen" until 21 Sep 2026.** It was renamed
for the same reason the participant surface stopped being a phone: these events
are virtual, so there is no big screen in a room. It is a window the host
shares from their desktop, and naming it after furniture that does not exist is
the kind of thing that leaves a first-time facilitator looking for a projector.

Its path stays `/screen`, its role on the wire stays `screen`, its token stays
`screenToken`, and its source stays `client/screen/`. That is deliberate:
renaming plumbing would invalidate every link and token already issued, and buy
nothing anyone can see. The rename is vocabulary, not addressing.

**The participant surface is a laptop, not a phone.** This said "phone, one
thumb" until 20 Sep 2026, and the whole participant design was built on it.
The events are virtual: everyone is already at a laptop for the video call, so
joining in a second window beats scanning a QR and typing an `hvs.` token on a
phone keyboard. The page still has to work on a phone — it is a responsive web
page and nothing stops someone using one — but it is not what to optimise for.

Three things follow, and two of them are load-bearing:

- **Everything must be operable from a keyboard.** The arcade's Plan/Apply is a
  race to 120 taps in 75 seconds: natural with a thumb, unpleasant on a
  trackpad, and quietly unfair to anyone without an external mouse.
- **Haptics do not exist.** `navigator.vibrate` is absent on desktop, so the
  light turn's vibration is gone and the word, the glyph and the hatch are the
  only cues rather than belt-and-braces.
- **Two justifications elsewhere in this document weaken.** "A phone that turns
  green is visible to the person next to you" is the stated reason the
  participant surface reveals nothing until the reveal — and in a virtual event
  nobody is next to anyone. Keep the rule: it still protects the reveal, and it
  matters the moment someone screen-shares. And the Desktop's join QR is
  decoration now; the join link goes over chat.

The split between console and Desktop is the important one. In the current
arcade the host shares the board *and* drives it, so the room sees the roster
box, the suggestions, the undo chips. The Desktop is a pure output: it
shows what the room should see and nothing else. The console is a pure input,
dense and private. Share the wrong tab and you have shared the answers, so the
console's title bar says **DO NOT SHARE** in the tab title.

### Participant

Loads, asks for a code (skipped if they came through `/j/<CODE>` or the QR on
the Desktop), asks for a nickname, lands in the lobby. From then on the
page renders whatever segment the host has running. Their own points are
always visible in a strip at the bottom. A reconnect banner appears if the
socket drops and disappears when it is back; nothing else on the page changes.

### Host console

A run-of-show rail on the left, the live panel for the current segment on the
right, a status bar at the bottom with connection counts and the seal state. A
thumbnail of the participant view sits in the corner so the host can see what
the room sees without switching tabs. One primary button, always labelled with
what it will do next ("Open question 7 of 20"). Full detail in
[DESIGN.md](DESIGN.md#host-console).

### Desktop

The participant view, redrawn for a 1080p tile inside a compressed video call:
huge type, few words, answer counts as bars, a timer you can read from the
back of a room. In the lobby it shows the join URL and a QR code. Between
activities it shows the top five (or "sealed"). During the arcade it is the
arena.

## Identity: nickname + join code

A session has a **join code**: `hvs.` followed by 24 base62 characters, shaped
like a Vault root token. It is **case-sensitive**, and nothing may fold it.

It was four letters from a HashiCorp-flavoured wordlist — `RAFT`, `PLAN`,
`SEAL` — for as long as the plan was to read it to a room, because over video
"the code is RAFT" survives a bad microphone and "four-seven-one-three-nine-two"
does not. That is not how the code is handed over now. The events are virtual
(above) and the code is pasted into a chat client, where length costs nothing
and nobody transcribes anything, so it can look like the thing it is standing
in for. The reason is written down beside the generator, in
`app/src/server/tokens.ts`.

The consequences are worth stating, because they run the other way from the
wordlist's:

- **It is not readable aloud, and must not be.** Post the join link; do not
  read out the code and do not retype it.
- **It cannot be guessed**, so the join code is no longer a thing that leaks by
  being overheard. Locking the lobby is still right, but it is about people
  forwarding a link, not about the code being short.
- **Case sensitivity is the sharp edge.** The old codes were folded to upper
  case everywhere they were compared. Anything that upper-cases one of these —
  a chat client, a spreadsheet, a helpful autocorrect — breaks it.

A **nickname** is unique within the session, case-insensitively, with
whitespace collapsed. "Kenji", "kenji" and "Kenji " are the same person.

**Roster pick. Not built.** The design was that the host pastes a roster before
the session, and the join screen then offers the names as chips with "I'm not
listed" underneath — the single biggest fix for the `asdf` problem, because the
path of least resistance produces the right name.

There is no roster anywhere in the service: nothing accepts one, stores one or
renders one. The nickname field is free text with a two-character minimum, and
the `asdf` problem is handled by the host asking twice and putting it in chat.
Worth building; it is the one unbuilt thing here that removes work on the day
rather than adding polish.

**Rejoin.** The browser keeps a session token. Reload the page, switch from
Wi-Fi to 4G, close the tab by accident — you come back as yourself with your
points intact. This is the case that matters most and it needs no user action.

**Same nickname, different device.** If someone joins as "Kenji" while a
"Kenji" is already connected, they are refused with the message *"Kenji is
already in this session. If that's you on another device, ask the host to
release the name."* The host console shows a **release** action next to any
participant; releasing disconnects the old device and the new one can claim
the name. The host makes the call because the host can see the room — the
software cannot tell an impostor from a phone swap.

**Late join.** Allowed at any point until the host locks the lobby, and they
land on whatever is running. Someone who arrives during question 9 plays from
question 10. For the activity they missed, the host marks them **bench** (see
Scoring) — the same treatment as a facilitator, decided in advance as the
virtual playbook already says.

**Kick.** Host-only. Kicked participants can rejoin under a different nickname
unless the lobby is locked.

**Rename. Not built.** There is no rename, for the host or for anyone: no
command on the wire and no event in the engine. What exists is **release**,
above, which frees a nickname so its owner can retake it, and **kick**, which
sends somebody back to the join screen where they type a new one. A name that
is a problem is therefore two host actions and one participant action, not one
host action.

The engine does guard against self-renaming — a rejoin keeps the participant's
stored nickname rather than whatever is in their text box — which is a rule
written for a host rename that does not exist yet. It is the right rule
regardless: without it, anyone could rename themselves by reconnecting.

## Session lifecycle

```
draft ──open──▶ lobby ──start──▶ running ──seal/reveal──▶ closed
                  ▲                 │
                  └────── (lobby is a segment; the host can return to it) ──┘
```

| State | Joins | What participants see |
| --- | --- | --- |
| `draft` | No | Nothing — the code is not live yet |
| `lobby` | Yes | Lobby: who is here, the session title, "waiting for the host" |
| `running` | Yes, unless locked | Whatever segment is current |
| `closed` | No | Final standings, frozen. The page stays up so people can screenshot |

While `running`, the host moves between **segments**. A segment is what the
participant page renders. There are seven:

| Segment | Purpose |
| --- | --- |
| `lobby` | Joining, chat about the prize, the facilitator rule |
| `holding` | A titled card the host talks over — see [Holding page](#holding-page) |
| `trivia` | The Kahoot-like activity |
| `arcade` | Hashi Arcade |
| `standings` | Top five, or "sealed" |
| `sendoff` | Kudos, photographs and one person they are all about |
| `final` | The reveal: 5 → 1, then the winner |

**`sendoff` was added after this document was first written**, which is why the
rest of it barely mentions it. It is a segment rather than an activity on
purpose: it scores nothing, nobody competes at it, and an activity with a zero
bucket would show up on the scoreboard as a column of dashes that somebody came
last in. [docs/sendoff.md](docs/sendoff.md) is the design.

Segments are not a fixed sequence. The host's run of show is a list they can
reorder, but the console will start any segment at any time. Real sessions go
back to the holding page, re-run a question, or reveal standings early because
the TTX overran, and a wizard that insists on step 3 after step 2 is a wizard
someone fights in front of thirty people.

**Manual score entry and Spot Awards are host actions, not segments.** They
happen from the console while any segment is up — typically the holding page
for the TTX, or the standings between activities.

## Scoring

Carried over exactly from [SCORING.md](SCORING.md).
Nothing here changes a rule; it only makes the arithmetic automatic.

**Every activity produces a raw number per person.** Trivia produces its
speed-weighted points; the arcade produces its round points; a manual activity
produces whatever the facilitator typed. Raw numbers are never added across
activities.

**Normalisation.** For each activity, the top raw score becomes 100 and
everyone else gets `round(100 × raw ÷ top)`. Participants on bench credit are
excluded from the `top` calculation. This is computed live, so the standings
after every activity are already in Huddle Points.

**Spot Awards.** 10 points each, granted from the console with a **required
reason**, which the Desktop shows as a toast: *Spot Award — Kenji — best
recovery of the afternoon*. The reason is mandatory because the existing
design says to announce it with one, and a field that may be blank will be
blank. The cap is two per activity and the console shows how many are left.

**Raising the cap is not built.** The cap is set per activity when the session
is created — it is a field on the activity in `session.json` — and a session's
activities cannot be changed afterwards, so there is no command that raises it
mid-session and could not be one without making activities mutable. An event
that wants a bigger budget sets it in the file. The console's counter is
`spotsLeft`, and when it reaches zero it stays there.

**Bench Credit.** Per participant, per activity, the status is `played`,
`bench` or `unset`. A `bench` participant is credited the mean of their
normalised points across activities where they are `played`, recomputed as
activities complete. Before they have played anything it shows "—". The host
marks facilitators as bench for their own activity in the setup, and marks late
joiners on the day. A bench participant for an activity cannot receive that
activity's Spot Awards; the console will not offer them.

**Totals.** Sum of normalised (or bench) points across activities, plus Spot
Awards. Three activities: 300 plus up to 60.

**Tiebreak for first.** The session config lists activities in tiebreak
order (for the first huddle: the tabletop exercise first, as the design says).
If still tied, the
host has a **Sudden death** button in trivia: one question, first correct
answer wins, no points. Never a coin flip; the software does not have one.

### What participants see of the standings

**Top five only, never the full ranking.** On the Desktop and on every
phone. The bottom of an individual leaderboard has someone's name on it in
front of their team, and this is enforced by the software rather than by the
scorekeeper remembering.

Each participant also sees **their own total**, without a rank. A total is a
number to add to; a rank of 23rd is a reason to stop playing.

### Seal and reveal

The seal is a session-level state with three values:

| State | Desktop and phones show |
| --- | --- |
| `live` | Top five, updated as activities complete |
| `sealed` | *Scores are hidden*, and one fixed line — *Revealed at the end.* — on every surface |
| `revealed` | The final reveal, 5 → 1, then the winner |

The host seals before the last activity. From then on no surface shows
cumulative standings — not the Desktop, not a participant's page, not their own
total strip. The console still shows everything, because the host needs to know.

**The strip loses its numbers; it does not freeze them.** It keeps its place,
because a strip that vanishes reads as a bug, and shows a lock and *points
sealed* and nothing else. An earlier draft of this document said it showed the
last value before sealing, frozen — that is exactly wrong, and both the code and
[DESIGN.md](DESIGN.md) say so: a frozen strip leaks what the seal exists to
hide, since the last value plus a known activity is most of the way to a rank.
Nothing is cached, and `own` is omitted from the wire entirely while sealed
rather than nulled, so the numbers are not on the participant's machine to be
recovered. They come back at reveal.

The seal is a real feature and not a display toggle because the single prize
creates the problem the existing design names: by the last activity only a
handful of people can win, and the only thing keeping the rest playing is not
knowing who. Any leak — a total that keeps ticking up, a "you're 4th" — undoes
it.

**Activity podiums still show while sealed.** The trivia's own top five after
each question is the trivia; it says who is winning *this activity*, not the
session.

**Turning that off is not built.** The design had a per-activity toggle for a
host who wants the last activity completely blind, defaulting on. There is no
such toggle: the podium is part of the trivia reveal and shows on every surface
at the reveal, sealed or not. A host who wants the last activity blind does not
reveal the question — which costs the room the answer as well, so it is a worse
trade than the toggle would have been, and that is the argument for building it.

## Trivia

Kahoot, without Kahoot. Twenty questions, four answers, a timer, points for
being right and more for being right fast.

**On the phone: the question and the answers.** Kahoot shows the question only
on the shared screen, which assumes everyone can read the shared screen. Over
a video call the shared screen is a compressed tile next to nine faces. The
phone shows the question text, the four answers with shape and colour, and the
timer. The Desktop shows the same plus the answer count as it climbs.

**Per question:**

1. Host opens the question. Timer starts on the server. Phones show the
   answers; the Desktop shows the question large.
2. Participants tap once. The tap is final. The phone shows "locked in" and
   nothing about the answer — no hint of correctness until the reveal, because a
   phone that turns green is visible to the person next to you. It does show
   "24 of 27 answered" from that moment, which says how many people have
   answered and nothing about what any of them chose: answering in three
   seconds and then watching a still phone for seventeen is the wait this is
   for.
3. Timer expires, or the host closes it early (the console shows "24 of 27
   answered" and a close button, because waiting out a 30-second timer when
   everyone has answered is dead air).
4. Reveal: correct answer, the answer distribution as bars, the note if the
   question file has one, then the activity's top five. Host advances.

**Scoring per question.** Base 1000 (a question can override it).
A correct answer scores `round(base × (1 − (t ÷ T) ÷ 2))` where `t` is the
response time and `T` the time limit, so a correct answer at the buzzer is
worth half of an instant one, never less. Wrong or no answer: 0. A streak bonus
of `100 × min(n − 1, 5)` is added for the n-th consecutive correct answer,
matching Kahoot's shape closely enough that the old facilitator guidance —
"streaks and speed bonuses stay on" — still means what it meant. Response time is measured
on the server and corrected for the connection's measured latency, capped at
250 ms — someone in Bengaluru on hotel Wi-Fi should not lose a speed race to
someone in Sydney on fibre. [ARCHITECTURE.md](ARCHITECTURE.md#clocks-and-fairness)
has the mechanism.

**Multi-answer questions.** `correct` may name several answers
(`["B", "D"]`); any of them is correct. Kahoot semantics.

**Two- and three-answer questions** are allowed by giving two or three answers.

**Sudden death** draws a question from the tiebreak pool rather than from the
twenty: no timer, first correct answer wins, the Desktop shows the winner's
name, no points change. A sudden death that consumed one of the scored
questions would have changed the game it was asked to settle.

### Question file

Questions are JSON. The 20-question set ships in this repo as
`trivia-questions.json`.

```json
{
  "title": "HashiCorp & IBM trivia",
  "questions": [
    {
      "text": "In what year was HashiCorp founded?",
      "answers": ["2008", "2010", "2012", "2015"],
      "correct": "C",
      "timeLimitSec": 20,
      "round": "History"
    },
    {
      "text": "Which product does secrets management, encryption as a service and dynamic credentials?",
      "answers": ["Consul", "Boundary", "Vault", "Nomad"],
      "correct": "C",
      "timeLimitSec": 20,
      "note": "Dynamic credentials are the bit people forget.",
      "round": "Name that product"
    },
    {
      "text": "Which product's brand colour is purple?",
      "answers": ["Vault", "Consul", "Terraform", "Nomad"],
      "correct": "C",
      "timeLimitSec": 10,
      "round": "Brand",
      "basePoints": 500
    }
  ]
}
```

A bare list of questions is accepted as well as the wrapped object. The
wrapper exists to carry a title, not to be ceremony.

| Key | Required | Rules |
| --- | --- | --- |
| `text` | Yes | ≤ 200 characters. Longer will not fit a phone |
| `answers` | Yes | Two to four of them, ≤ 80 characters each |
| `correct` | Yes | The correct answer's letter, or a list of letters |
| `timeLimitSec` | Yes | 5–120 |
| `note` | No | Shown on the reveal. This is the bit people learn from |
| `round` | No | Consecutive questions with the same value get a round card between them |
| `basePoints` | No | Base points, default 1000. 0 makes a question a warm-up |
| `tiebreak` | No | `true` takes the question out of the scored set and into the sudden-death pool |

The answer is named by its letter rather than by its position because a letter
is what the question bank writes and what a participant sees, and it is
neither 0-based nor 1-based, so the off-by-one that a column of answer numbers
invited has nowhere left to happen. A number in `correct` is refused with a
message naming the letter to use instead: it is almost always a half-finished
migration from the old CSV, and it is the one mistake that imports cleanly and
marks the wrong answer.

Unknown keys are errors, at the file level and at the question level. A file
carrying `timelimitSec` is a file whose author believes they set a timer, and
silently defaulting it is how a 20-second question becomes something else in
front of thirty people.

A question flagged `tiebreak` is lifted out of the twenty and into the pool
sudden death draws on. Sudden death scores nothing, and a question that scores
nothing must not also be one of the questions that do, so a file of 23
questions with three flagged is a twenty-question game with three tiebreakers
behind it.

Import validates every question and rejects the file with addressed errors
(`Question 8, correct: …`) rather than loading half of it: a set with question
14 missing is worse than a set that failed to load in the dry run.

Questions load per session. Editing a loaded set means re-uploading; there is
no in-app editor by design. The ⚠️ VERIFY discipline in the question bank stays
a human job.

## Hashi Arcade

This is the part of the product with personality, and where the format changes
most from what exists. The current board is a whole-room race to type in chat;
that worked because it was the opposite of Kahoot's heads-down phone. Moving
answers onto phones risks making the arcade feel like trivia two. The staging
is what stops that.

### The frame

Squid Game, played completely straight about infrastructure tooling. A
faceless announcer (the **Front-End Man**), staff in pink with shapes on their
masks, players in green tracksuits with three-digit numbers, an eerily calm
voice telling you the next game will begin shortly. Every game is a children's
game the show made sinister; every one here is a children's game made sinister
by Terraform.

Tone: **comical, not tense.** The joke is the seriousness. Nobody dies. Nobody
is mocked. The staging says "the stakes are enormous"; the content says "you
tapped during a state lock".

**Player numbers.** On entering the arcade every participant gets a
three-digit number (roster order, zero-padded). It appears on their phone,
on the Desktop grid, and in the announcer's copy. *Player 017 has been
drained.* The number is doing real work: it lets the Desktop show sixty
people as a grid you can read, and it gives the elimination copy something to
say that is not a colleague's name in red.

**The staff.** Three mask shapes, ○ △ □, which in the show are ranks. Here:
○ *reads the plan*, △ *runs the apply*, □ *approves the PR*. They appear on
round cards and never do anything. They are set dressing, and the joke lands
once per session on the card that explains it.

### Nobody sits out: the Floor and the Lounge

This is the arcade's design constraint and its best idea. Every round has a
**Floor** (the game) and a **Lounge** (where you go when you are out).

When you lose a round you are not eliminated. You are **drained** — as in
`nomad node drain`: your allocations are rescheduled and you stay in the
cluster. The phone desaturates for one beat, says *Player 017 drained*, and
then a gold card slides up: **Welcome to the VIP Lounge.** In the show the
VIPs are the masked rich who bet on the players from a sofa. That is now you.

In the Lounge you **back a player** still on the Floor. Tap a name; change it
freely until the Floor locks. If your player survives the round, you score. If
your player wins the round, you score more. The Desktop shows who has
backed whom, so being backed by six people is its own small pressure, and the
Lounge is the loudest part of the room.

**A bet has to be placed before the thing it is betting on.** Change it as
often as you like; what does not pay is watching somebody cross the line on
the Desktop and then naming them. Every Floor is a public surface — the finish
order in Plan / Apply, the tins coming open in Unseal — and without this the
Lounge pays its maximum for reading a screen, which is not a bet and is worth
more than several honest ways off the Floor.

Lounge points are real points that count toward the arcade raw score, capped
so a perfect Lounge round is worth less than surviving the Floor. Someone
drained in the first ten seconds of every round who backs well ends the arcade
with a respectable score, and — more to the point — has been *playing* the
whole time, shouting for someone. The person knocked out at minute six with
fifteen minutes to watch was the failure mode; the Lounge is the answer.

**Draining lasts one round.** Every round starts with everyone back on the
Floor. Cumulative elimination would spend the last five minutes with three
people playing and thirty in the Lounge, which is the show, and the wrong shape
for a work afternoon.

**Banked progress.** Every Floor game banks points at checkpoints before you
are drained. Getting caught at 75% keeps what you banked at 50%. This is
partly kindness and partly a Terraform joke that partial applies leave state
behind.

### The rounds

Six are designed and **five are built**. A standard eighteen-minute run is
round 0 and four of the rest; the host picks in setup and the order is theirs.
Timings include the round card (20 s) and the reveal (20 s).

**Gganbu is not built.** Its scoring and pairing are in the engine, and it is
reachable from nowhere: `arcade.round` has no variant for it, so the wire
refuses one, and the console lists it disabled — visible in the run of show,
impossible to start. That was the right call at the time and remains one: SPEC
already says to drop Gganbu first if the slot is tight, because its joke depends
most on everyone knowing the show. The table below marks it, and the scoring
summary is the design rather than a description of a round anyone has played.

| # | Round | The game | Content | Time | Drains? |
| --- | --- | --- | --- | --- | --- |
| 0 | **Recruitment** | Emoji Decode | 6 existing items | 2.5 min | No |
| 1 | **Plan / Apply** | Red Light, Green Light | — | 3 min | Yes |
| 2 | **Unseal** | Dalgona | 6 existing Scrambled items + 4 | 3 min | Yes |
| 3 | **Tug of Raft** | Tug of War | — | 3 min | No |
| 4 | **Gganbu** *(not built)* | Marbles | 6 new Over/Under items | 3.5 min | Yes |
| 5 | **The Glass Bridge** | Glass Bridge | 6 Real-or-Fake pairs (3 existing) | 3.5 min | Yes |

#### Round 0 — Recruitment (Emoji Decode)

*In the show, a recruiter at a train station plays ddakji with strangers and
slaps the ones who lose. Here the recruiter is very persistent and everyone
gets in.*

Two emoji, one product, type it. Six items, 20 seconds each, the existing
Emoji Decode content (`🔐🏦` → Vault, `📡🐪` → Nomad). Text input, matched
after lowercasing and stripping non-letters, with an accept list (`tf` for
Terraform). Every correct answer within the timer scores **10**; the first
three correct in the room score **+5**. No draining. At the end, the big
screen "recruits" everyone: the grid fills with player numbers and the
Front-End Man welcomes them.

Why it exists: the existing README is right that round one sets whether people
think they can win. Recruitment is the round everyone scores in, and it hands
out the player numbers, which the staging needs.

#### Round 1 — Plan / Apply (Red Light, Green Light)

*The doll is a twelve-foot Terraform logo. When its head is turned, the sign
reads PLAN. When it turns to face you: APPLY IN PROGRESS — STATE LOCKED.*

The phone is one big button. During **PLAN** (green), tap to advance — each
tap is a resource, and the finish line is 120 resources. During **APPLY**
(pink), any tap is `Error: state lock held by another process` and you are
drained. Phases alternate on random durations between 2 and 6 seconds; the
Desktop shows the head beginning to turn 400 ms before the lock, and the
phone vibrates on the turn. There is a 250 ms grace after the lock for
network latency, because a fair game over a video call is one where the last
tap before the light changed is not a loss.

Checkpoints at 30, 60 and 90 resources bank **5** each. Crossing the line
banks **+10**, and the first three across get **+15 / +10 / +5**. Drained
players keep banked points and go to the Lounge to back a runner; backed
runner crosses **+10**, backed runner wins **+15**. 75 seconds of play. The
resource target is a host setting; 120 is tuned so about half the room
crosses.

Lose it by tapping during a lock. The screen shows the error verbatim, mono,
red, the way it looks in a real terminal, and then the gold Lounge card.

#### Round 2 — Unseal (Dalgona)

*Each player is handed a sealed tin. Inside is a word. Pick your shape before
you know the word.*

A shape-pick screen first, exactly as the show: ○ △ ☆ ☂. Then the reveal:
the shapes are word lengths. Circle is a four- or five-letter term (`RAFT`,
`VAULT`), triangle six (`MODULE`, `GOSSIP`, `UNSEAL`), star eight (`SENTINEL`,
`PROVIDER`), umbrella eleven-plus (`DECLARATIVE`, `IDEMPOTENCY`). The letters
appear scrambled on the phone; **tap them in order**. One wrong tap cracks the
tin. Sixty seconds.

Unsealing scores by shape: **10 / 20 / 35 / 50**, with **+10** for the fastest
in each shape. A crack drains you: banked **2 per correct letter** up to the
crack, then the Lounge. The per-letter 2 banks **towards** the shape score, not
on top of it — that is what makes the Floor maximum 60 rather than more.
Backing a player who unseals is **+5**; backing the fastest in any shape
**+8** — the better of the two, never their sum, as everywhere else.

The Lounge is 5 / 8 here rather than Plan / Apply's 10 / 15 because this
round's cheapest completion is a circle tin at **10**, and a perfect Lounge of
15 would beat somebody who actually unsealed one.

There is a button labelled **Read the docs**. It reveals the next letter and
halves your score for the round. In the show, licking the back of the
honeycomb is the cheat that works. This is that, and it is the funniest
button in the product because everyone knows exactly what it means.

The existing six Scrambled items ship as launch content. The umbrella tier
needs three long words added; they are in the round file with the same
`cue / ans / note` shape, and the reveal reads the note aloud — *the thing
everyone means to write and never does* survives intact.

The circle tier needs a second word for the same reason a tier is dealt out by
player number at all: with one word in it, the first person to say `RAFT` on
the call has solved the tier for everybody who picked the cautious shape.
`VAULT` is that second word.

#### Round 3 — Tug of Raft (Tug of War)

*Two clusters. One rope. The rope is leadership.*

The room is split by player-number parity, then reshuffled by seed before each
of three pulls. A **heartbeat** pulses on the Desktop and on every phone at
100 bpm. Tap *on the beat* and your side pulls. Tap off the beat and nothing
happens. Miss three beats in a row and your node **times out and calls an
election**, which in this game as in Raft achieves nothing useful for two
seconds. The rope on the Desktop moves with the net on-beat rate.

Each pull is 25 seconds. Every member of the winning side banks **10**; the
best on-beat rate on each side (the **leader**) banks **+5**, win or lose. Three
pulls, sides reshuffled, so nobody is stuck on a losing side.

**Nobody drains.** This is deliberate: two elimination rounds back-to-back is
a downer, and the arcade needs one round that is pure noise. Lose a pull and
you have lost the pull. Run it between Unseal and Gganbu.

The heartbeat is also the reason this works over video: a raw tap race
rewards whoever's phone registers taps fastest, and the beat means everyone
is capped at the same rate, so the skill is rhythm, not hardware.

#### Round 4 — Gganbu (Marbles) — not built

**Designed, half-built, and unreachable.** The pairing and the scoring are
in the engine; the wire has no way to start it and the console will not
offer it. What follows is the design, kept because finishing it is a
day's work and the argument for the round is still good.

*You are paired with a gganbu. You each hold ten Vault tokens. Tokens have a
TTL — the round ends when they expire. Wager them.*

Random pairs (an odd person out is paired with the house, played by the
Front-End Man; a rival who disconnects is replaced by the house). Six
**Over / Under** prompts, 15 seconds each: *Vagrant's first release —
over or under 2011?* Each player secretly picks over or under and a wager of
1 to 5 tokens. Correct: gain the wager. Wrong: lose it. Your rival's name and
token count sit on your screen the whole round.

At the buzzer, tokens convert to points **1:1** (max 40 for a perfect run).
Whoever of the pair holds more takes **+10**. Reach **zero** and your token is
**revoked**: you are drained to the Lounge, where you back a surviving player
(**+5** if they finish above their rival, **+8** if they finish with the most
tokens in the room — the better of the two, never their sum).

If your gganbu leaves mid-round you **both** play the house, which holds its
opening stake and wagers nothing. One rule for both halves: a one-sided
substitution let both of them collect on an odd roster and neither on an even
one.

The pairing is mostly presentation — everyone answers the same prompts — but a
named rival is what makes a wager feel like a wager, and the *gganbu* card on
the round intro is the one Squid Game reference every single person will get.

Six Over/Under items ship as launch content, each carrying a note, and three
are flagged VERIFY exactly as the trivia bank flags dates.

#### Round 5 — The Glass Bridge

*Twelve panes. Six are tempered. The tempered ones are real.*

Six steps. At each step, two panes: one is a real HashiCorp feature (*Vault
Transit Secrets Engine*), one is invented (*Vault Lease Broker Mesh*). Step on
the real one. Wrong pane and you fall — drained, with everything banked so far.

Players cross in **three waves** by player number. Wave 1 goes blind, 12
seconds per step. Wave 2 goes after, 9 seconds, and can see on the Desktop
which panes broke under wave 1. Wave 3 goes last with 6 seconds and near-total
information. The information asymmetry is the whole point of the game in the
show — going first is worse — and it turns waiting for your wave into
watching intently.

Each step crossed banks **5**; reaching the far side **+15**; wave 1 banks
**+3 per step** for going blind.

**A drained player may only back a *later* wave, and the bet locks when that
wave walks on.** Both halves are load-bearing and neither is optional. Without
the first, every backer simply waits for a wave 1 runner who is already across
— still on the Floor, never drained, therefore backable — and collects as a
certainty; the Lounge stops being a bet. Without the second, a backer watches
their runner fall and switches to the next wave, which is the same certainty
wearing a hat. A consequence worth stating: someone drained during wave 3 has
no later wave to back and scores nothing in the Lounge.

Drained players back someone in a later wave:
crosses **+10**, fastest full crossing **+15** — the better of the two, not
their sum, as in Plan / Apply. A backer is never paid twice for one runner,
and the Lounge rule should not change between rounds: it is hard enough to
explain once.

**A wave that is waiting bets too**, and this is the only round where that is
so. Two of the three waves are on the Floor with nothing to press for up to
two minutes, which is "nobody sits out" failing in the one round that most
needs it: watching intently is what waves 2 and 3 are *for*. So a player who
is on the Floor and cannot act — waiting for their wave, or already across —
backs a runner in the wave that is crossing, placed before anybody in that
wave has stood on a pane and standing from then on, exactly as the drained
side's bet does. Before *anybody* has stepped, not merely before step 2: a
fall is public the moment it happens, so one runner down already tells the
watchers half of what they would be betting on. It pays **+5** for a crossing
and **+8** for the fastest crossing: half the Lounge's pair, because a waiting
wave is being paid for this round twice, once by their own crossing. The
cheapest way across the bridge is 45, so watching is never worth more than
walking.

Launch content: the existing three real and three fake Real-or-Fake items,
re-paired **within a product** and made up to six pairs. That needs six
additions, not three — the existing six are three reals and three fakes across
six *different* products, so each one needs its opposite number written for it.
Pairing across products would give the round away: *Vault Transit Secrets
Engine* beside *Packer Provisioner Mesh* asks which product you have heard of,
not which feature is real.

The reveal note for each pane reads out why the fake was fake, and the notes
travel separately from the labels — a note explaining why a pane is fake is the
answer, so it cannot be attached to the thing being shown.

**"Fastest full crossing" means the lowest total decision time**: the six
reaction times added up, each measured from its step opening. The obvious
readings are both degenerate. First across in wall-clock is always a wave 1
player, and is settled before the Lounge has anyone in it. Elapsed since your
own wave started is always wave 3, because a wave cannot advance until its step
closes. Total decision time is the only measure comparable across three waves
running at three speeds, it stays live until the last wave is off the bridge,
and it lets a decisive wave 1 runner hold the record against a dithering wave 3
one. Ties go to whoever crossed first.

### Arcade scoring summary

| Round | Floor max | Lounge max |
| --- | --- | --- |
| Recruitment | 90 | — |
| Plan / Apply | 40 | 15 |
| Unseal | 60 | 8 |
| Tug of Raft | 45 | — |
| Gganbu *(not built)* | 50 | 8 |
| Glass Bridge | 63 | 15 |

The raw arcade score is the sum. It is normalised like any other activity, so
the absolute numbers only matter relative to each other. The tuning target is
that **crossing the line always beats a perfect Lounge**, and that a perfect
Lounge is always worth having.

That is a deliberate narrowing of what this used to say, which was "surviving a
Floor is always worth more than a perfect Lounge". That cannot be made true by
any choice of constants: a player who is never drained but never reaches a
checkpoint banks nothing, and nothing is less than a perfect Lounge. The Floor
pays for *progress*, not for standing still, so a backer who picked the winner
has out-played someone who neither progressed nor got caught.

It also means the Lounge awards do not stack. Backing a runner who crosses pays
10, backing the winner pays 15, and a perfect Lounge round is the larger of the
two rather than their sum. Adding them made 25, which tied the 25 a player
scores for crossing the line in fourth place, and let a player drained at 90
resources who backed the winner finish on 40 — dead level with the player who
actually won the Floor. Gganbu, the one round not yet built, should be tuned
against the same rule.

The Front-End Man's lines, the round cards and every piece of copy are in
[DESIGN.md](DESIGN.md#the-arcade-register), because how they are said is most
of whether they are funny.

## Manual entry — the TTX and anything off-platform

A session can include a **manual activity**: a name, an accent colour, and no
gameplay. The Agentic Security TTX is one. So is anything a future event runs
on a whiteboard.

From the console, the host opens the activity and sees the roster with a raw
score field per person and a bench toggle. **Type them.** The normalised points
preview updates as you go, so the host can see the top scorer land on 100.

Each field is its own `score.set`, and each one lands immediately. There is no
draft, no Publish and no paste.

**Paste with fuzzy matching is not built.** The design was two columns of name
and number from the facilitator's spreadsheet, fuzzy-matched to nicknames, with
every match under full confidence shown for confirmation — the scorekeeper's
detective work, done once, with the software making the suggestions. Nothing
parses two columns and nothing matches a name to a nickname. The scores are
typed.

**Draft-until-publish is not built either**, and the two are one decision: the
draft existed so a paste could be reviewed before it moved the standings, and
with no paste there is much less to review. A typed score changes the board as
it is typed.

That is a real cost while the session is unsealed, and it is the reason to seal
before manual entry rather than after: a mistyped number is visible on the
Desktop for as long as it takes to notice, and the fix is to type the right one
over it. Sealed, nobody sees either. Worth building if an event ever has a
manual activity with more than a handful of scores.

The facilitator of a manual activity is on bench for it, like any other.

## Holding page

A card the host puts up when the room's attention should be on a person, not
the screen. It carries a **title** and **one line of context**.

**No presets, and no countdown.** The design listed *TTX in progress*, *Break*
and *One more thing* as presets alongside free text, and an optional time that
rendered as a countdown. A card is a title and a line; there is no `until`
field on the command or in the state.

What replaced presets is better suited to the way the day actually runs: the
host writes **every** card they might want during setup, and the console keeps
them in that browser's local storage, where they survive a reload and are still
there next time. Once the session is running a card can be put up, jumped to
from the rail or raised with `SHIFT+H` — but not written. Editing a card
mid-session is editing something thirty people may be looking at in a minute,
and a preset would have been the one card nobody proofread.

The cost is that the deck is per machine: a co-host's console has its own, and
a card nobody wrote shows "Back shortly". See
[docs/running-an-event.md](docs/running-an-event.md).

It is not blank because a blank screen on a phone means "it's broken" and
thirty people refreshing during the TTX is a support call the host cannot
take. The card also shows the participant's own points strip (unless sealed)
and a quiet "connected" indicator, which tells everyone the thing is still
alive without saying anything.

## Failure modes that matter at a live event

**Someone joins late.** Covered above: they land on the current segment and
play from the next question or round; the host marks them bench for what they
missed.

**The console does not flag them.** This said it did, and nothing records when
somebody joined relative to an activity or surfaces it anywhere. The host has to
remember, which is a real thing to get wrong — an unbenched late joiner is a
zero in an activity they were never in, and it drags their normalised score down
without anyone noticing until the export. The scoring grid shows `unset` for
them, which is the signal there is, and it looks identical to a score nobody has
typed yet.

**A connection drops mid-question.** The answer they submitted before the
drop counts (it was on the server). A question that closed while they were
gone scores 0 for that question, with no do-over: asking it again would need
the whole room to wait, and anyone they are sitting with heard the answer. The
page shows a reconnect banner and resumes wherever the session is. In the arcade,
a player who drops mid-round is marked **away** — not drained — and rejoins
the Lounge for the rest of that round, back on the Floor for the next.

**The host's browser crashes.** Nothing is lost: the state is on the server,
and timers run on the server, so the question in progress closes on time
without the host. The host reopens the console link and is exactly where they
were. What *does* stop is progression — the next question does not open
itself — so a co-host holding the same console link is the recommendation for
any session with more than fifteen people, which is what the playbook's
"two people minimum" already says.

**The server restarts mid-game.** Every state transition is persisted, so the
service comes back with the session intact within about twenty seconds and
every surface reconnects by itself. Answers that arrived in the gap are lost.

**There is no re-ask. Not built.** This said the console offered one on the
affected question; there is no such command, no event for it, and nothing that
counts how many answers a gap swallowed. A host left holding a question that
scored some of the room and not the rest has the ordinary scoring tools: a raw
score typed in by hand, or bench for the activity. Details in
[ARCHITECTURE.md](ARCHITECTURE.md#durability-and-restart).

**Two people pick the same nickname.** The second is refused with a message
that explains the release flow, above.

**Someone joins under a name that is a problem.** Rename or kick from the
console. Kicked participants can rejoin under another name unless the lobby
is locked, which it should be once the first activity starts.

**The Desktop tab dies.** Reopen the screen link. It is a pure output and
has no state of its own.

**The join code leaks.** Not by being overheard — it is 24 random characters —
but by being forwarded, which is the same outcome. Lock the lobby once the
first activity starts. Locked means no new nicknames, but rejoin still works
for everyone already in.

**Someone's browser cannot do it.** The participant view is one responsive web
page with no framework and no bundler; a phone works, a laptop works, and an
old browser that fails is failing at plain DOM.

**Everything is down.** The activity content is still plain text in this repo,
and the playbook's fallback stands: read it out, score in chat, keep going.

## Out of scope

Accounts, SSO, any identity beyond the host and screen tokens. Teams. Chat,
reactions, emoji storms. A question editor. Multi-language. Native apps.
Analytics beyond a CSV export. Prize fulfilment. The TTX content. Kahoot
compatibility of any kind, including reading its CSV. Running the session with
no host.

## Open questions

Where the brief is followed but disagreed with, or where something needs a
decision from someone else.

1. **This will not exist for the first huddle.** The brief says build it
   properly with no deadline, and the first event it could serve is a week
   away. The first huddle should run on Kahoot, the existing board and the
   spreadsheet as planned. Quorum's first outing is the next one, and that
   should be said out loud so nobody plans around it.

2. **"Higher TTX score" as the tiebreak is an event decision, not a product
   one.** Built as a per-session tiebreak order so the rule survives, but a
   future event with no TTX needs to choose its own, and the config makes them.

3. **Speed-weighted scoring over a video call is unfair at the margins,
   whatever the latency correction does.** The correction narrows it; it
   cannot close it. The formula's floor (a correct answer at the buzzer is
   still worth half) is the real protection, and it is the reason not to
   "improve" the formula toward Kahoot's steeper curve.

4. **Six arcade rounds is more than the slot.** Designed six so the host has
   a choice and so a longer session has material; a standard run is five.
   If the eighteen-minute slot stays, drop Gganbu first — it is the round
   whose joke depends most on everyone knowing the show.

5. **A single stateful process means a deploy is an outage.** Accepted in the
   brief. It was to be handled by a freeze check in the deploy pipeline; there
   is no pipeline — the account permits no machine identity — so it is handled
   by a person checking `sessionsLive` on `/healthz` before deploying. See
   [infra/README.md](infra/README.md). Worth knowing that "properly"
   here does not mean "highly available" and should not.

6. **The Lounge's "back a player" is one mechanic for every round.** It could
   be richer — per-round side games — but one mechanic that everyone learns
   in round 1 and uses in round 5 is worth more than four clever ones. Revisit
   after a real session, not before.

7. **Should participants see their own total at all?** Argued above for yes,
   without a rank. If the first live run shows people counting themselves out
   from the number, hide it and show only the top five.
