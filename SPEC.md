# Quorum product spec

One URL that runs a team-building session end to end. Participants open it,
paste a join code, type a nickname, and never navigate again: the host decides
what the page shows, from the lobby to the winner.

This document covers what Quorum does and why. How it is built is in
[ARCHITECTURE.md](ARCHITECTURE.md), and what it looks like is in
[DESIGN.md](DESIGN.md).

**A note on what is built.** Quorum has run a real event, and this document
still describes some things that were designed and never built. Those are
marked **Not built** where they appear, with what actually happens instead.
The design reasoning stays in, because it records why the feature was wanted
and it is the starting point for anyone who builds it. A claim without that
marker is a claim about the running service.

## The problem

The huddle these sessions replace ran on three things that did not know about
each other: Kahoot for trivia, a host-driven browser board for the arcade, and
a spreadsheet for the scores. Each of them works on its own. The cost is in
moving names and scores between them.

Every move between them is a name match done by a person under time pressure.
The roster has to be identical in Kahoot, on the arcade board, and in the CSV,
and the facilitation notes said so in bold because it failed every time:
someone joins Kahoot as `asdf`, the scorekeeper spends the three-minute break
doing detective work, and a score goes in the wrong row. The arcade needs a
second person watching chat and typing names. The seal-and-reveal is the best
idea in the scoring design, and it is a spreadsheet the scorekeeper has to
remember to stop sharing.

Quorum removes those hand-offs by making identity one thing (you join once),
scoring one thing (every activity writes to the same board, normalised
automatically), and the host's attention one thing (one console in place of
four windows).

## What it deliberately does not do

- **No accounts or SSO.** A participant joins with a nickname and a join code,
  as in Kahoot. The threat model is "a colleague joins twice as a joke", and
  the host has a kick button. Designing more identity than that would cost
  more than every problem it solves.
- **No teams.** Everyone scores as an individual, exactly as
  [SCORING.md](SCORING.md) argues. The data model does not forbid teams later,
  but the product does not build them now.
- **No content authoring UI.** Trivia comes from a JSON file, and arcade rounds
  are files in this repo. A form-based question editor would be a second
  product.
- **No chat, video, or audio.** The video call already carries the
  conversation. Quorum is what is on the shared screen and in front of each
  participant.
- **It does not run the TTX.** The Agentic Security TTX happens off-platform,
  and Quorum holds the screen and takes the scores.
- **Not a SaaS.** It is one team's tool, self-hosted, for a handful of sessions
  a year. It can run a few sessions at once, but it is not designed for a
  thousand.

## The three surfaces

| Surface | Path | Device | Who |
| --- | --- | --- | --- |
| **Participant** | `/` and `/j/<CODE>` | Laptop, in a second window beside the call | Everyone playing |
| **Host console** | `/host#<token>` | Laptop, never screen-shared | Facilitator and co-host |
| **Desktop** | `/screen#<token>` | The tab that gets screen-shared | Nobody touches it |

**The Desktop was called the "big screen" until 21 Sep 2026.** It was renamed
for the same reason the participant surface stopped being a phone: these events
are virtual, so there is no big screen in a room. It is a window the host
shares from their desktop, and a name for furniture that does not exist would
leave a first-time facilitator looking for a projector.

Its path stays `/screen`, its role on the wire stays `screen`, its token stays
`screenToken`, and its source stays `client/screen/`. These stay because
renaming them would invalidate every link and token already issued, and nobody
would see the difference. The rename changes the word people use and none of
the addresses.

**The participant surface is designed for a laptop.** This said "phone, one
thumb" until 20 Sep 2026, and the whole participant design was built on it.
The events are virtual, so everyone is already at a laptop for the video call,
and joining in a second window is easier than scanning a QR and typing an
`hvs.` token on a phone keyboard. The page still works on a phone, because it
is a responsive web page and nothing stops someone using one, but the design is
optimised for the laptop.

Three things follow, and the first two change what was built:

- **Everything must be operable from a keyboard.** The arcade's Plan/Apply is a
  race to 120 taps in 75 seconds. That is easy with a thumb and awkward on a
  trackpad, and it is unfair to anyone without an external mouse.
- **Haptics do not exist.** `navigator.vibrate` is absent on desktop, so the
  light turn has no vibration, and the word, the glyph, and the hatch are now
  the only cues, with nothing to back them up.
- **Two justifications elsewhere in this document weaken.** "A phone that turns
  green is visible to the person next to you" is the stated reason the
  participant surface reveals nothing until the reveal, and in a virtual event
  nobody is next to anyone. The rule stays, because it still protects the
  reveal, and it matters as soon as someone screen-shares. The Desktop's join
  QR is also decoration now, because the join link goes over chat.

The split between console and Desktop is the important one. In the current
arcade the host shares the board *and* drives it, so the room sees the roster
box, the suggestions, and the undo chips. The Desktop is output only, and it
shows what the room should see and nothing else. The console is where the host
works, so it is dense and kept private. Sharing the wrong tab would share the
answers, so the console's title bar says **DO NOT SHARE** in the tab title.

### Participant

The page loads, asks for a code (skipped if they came through `/j/<CODE>` or
the QR on the Desktop), asks for a nickname, and puts the participant in the
lobby. From then on the page renders whatever segment the host has running.
Their own points are always visible in a strip at the bottom. A reconnect
banner appears if the socket drops and disappears when it is back, and nothing
else on the page changes.

### Host console

The console has a run-of-show rail on the left, the live panel for the current
segment on the right, and a status bar at the bottom with connection counts and
the seal state. A thumbnail of the participant view sits in the corner so the
host can see what the room sees without switching tabs. There is one primary
button, always labelled with what it will do next ("Open question 7 of 20").
[DESIGN.md](DESIGN.md#host-console) has the full detail.

### Desktop

The Desktop is the participant view, redrawn for a 1080p tile inside a
compressed video call. It has huge type, few words, answer counts as bars, and
a timer large enough to read in a small tile. In the lobby it shows the join
URL and a QR code. Between activities it shows the top five (or "sealed").
During the arcade it is the arena.

## Identity: nickname and join code

A session has a **join code**: `hvs.` followed by 24 base62 characters, shaped
like a Vault root token. It is **case-sensitive**, and nothing may fold it.

It used to be four letters from a HashiCorp-flavoured wordlist, such as `RAFT`,
`PLAN`, or `SEAL`, while the plan was to read it out to a room, because over
video "the code is RAFT" survives a bad microphone and
"four-seven-one-three-nine-two" does not. The code is no longer handed over
that way. The events are virtual (see above) and the code is pasted into a
chat client, where length costs nothing and nobody transcribes anything, so it
can look like the token it stands in for. The reason is written down beside
the generator, in `app/src/server/tokens.ts`.

Its consequences run the other way from the wordlist's:

- **It is not meant to be read aloud.** Post the join link, and do not read out
  or retype the code.
- **It cannot be guessed**, so it can no longer leak by being overheard.
  Locking the lobby still matters, because people can forward the link.
- **Case sensitivity is the risk.** The old codes were folded to upper case
  everywhere they were compared. Anything that upper-cases one of these, such
  as a chat client, a spreadsheet, or an autocorrect, breaks it.

A **nickname** is unique within the session, case-insensitively, with
whitespace collapsed. "Kenji", "kenji", and "Kenji " are the same person.

**Roster pick. Not built.** The design was that the host pastes a roster before
the session, and the join screen then offers the names as chips with "I'm not
listed" underneath. It was the biggest single fix for the `asdf` problem,
because the easiest path for a participant would produce the right name.

There is no roster anywhere in the service: nothing accepts one, stores one,
or renders one. The nickname field is free text with a two-character minimum,
and the host handles the `asdf` problem by asking twice and putting it in
chat. It is worth building, because it is the one unbuilt feature here that
saves the host work during an event. The others are polish.

**Rejoin.** The browser keeps a session token. If you reload the page, switch
from Wi-Fi to 4G, or close the tab by accident, you come back as yourself with
your points intact. This is the case that matters most, and it needs no user
action.

**Same nickname, different device.** If someone joins as "Kenji" while a
"Kenji" is already connected, they are refused with the message *"Kenji is
already in this session. If that's you on another device, ask the host to
release the name."* The host console shows a **release** action next to any
participant. Releasing disconnects the old device, and the new one can claim
the name. The host decides, because the host can see the room and the software
cannot tell an impostor from a phone swap.

**Late join.** Joining is allowed at any point until the host locks the lobby,
and a late joiner lands on whatever is running. Someone who arrives during
question 9 plays from question 10. The activity they missed scores zero for
them and **nothing in the software changes that**.
[SCORING.md](SCORING.md#removed-spot-awards-and-bench-credit) describes the
status that used to, and why it was removed. The host has to say a late join
out loud, because the arithmetic does nothing about it.

**Kick.** Only the host can kick. Kicked participants can rejoin under a
different nickname unless the lobby is locked.

**Rename. Not built.** There is no rename, for the host or for anyone: there is
no command on the wire and no event in the engine. What exists is **release**,
above, which frees a nickname so its owner can retake it, and **kick**, which
sends somebody back to the join screen where they type a new one. A name that
is a problem therefore takes two host actions and one participant action to
fix, where a rename would have taken one host action.

The engine does guard against self-renaming: a rejoin keeps the participant's
stored nickname and ignores whatever is in their text box. That rule was
written for a host rename that does not exist yet, and it is needed anyway,
because without it anyone could rename themselves by reconnecting.

## Session lifecycle

```
draft ──open──▶ lobby ──start──▶ running ──seal/reveal──▶ closed
                  ▲                 │
                  └────── (lobby is a segment; the host can return to it) ──┘
```

| State | Joins | What participants see |
| --- | --- | --- |
| `draft` | No | Nothing, because the code is not live yet |
| `lobby` | Yes | Lobby: who is here, the session title, and "waiting for the host" |
| `running` | Yes, unless locked | Whatever segment is current |
| `closed` | No | Final standings, frozen. The page stays up so people can screenshot |

While `running`, the host moves between **segments**. A segment is what the
participant page renders. There are seven:

| Segment | Purpose |
| --- | --- |
| `lobby` | Joining, chat about the prize, and the facilitator rule |
| `holding` | A titled card the host talks over. See [Holding page](#holding-page) |
| `trivia` | The Kahoot-like activity |
| `arcade` | Hashi Arcade |
| `standings` | Top five, or "sealed" |
| `sendoff` | Kudos, photographs, and one person they are all about |
| `final` | The reveal: 5 → 1, then the winner |

**`sendoff` was added after this document was first written**, which is why the
rest of it barely mentions it. It is a segment on purpose: it scores nothing,
nobody competes at it, and an activity with a zero bucket would show up on the
scoreboard as a column of dashes that somebody came last in.
[docs/sendoff.md](docs/sendoff.md) is the design.

Segments are not a fixed sequence. The host's run of show is a list they can
reorder, but the console can start any segment at any time. Real sessions go
back to the holding page, re-run a question, or reveal standings early because
the TTX overran, and a fixed sequence would have the host fighting the console
in front of thirty people.

**Manual score entry is a host action that works during any segment.** The
host usually does it from the console while the holding page is up for the TTX,
or while the standings are up between activities.

## Scoring

The rules are carried over exactly from [SCORING.md](SCORING.md). Nothing here
changes a rule, and the only difference is that the software does the
arithmetic.

**Every activity produces a raw number per person.** Trivia produces its
speed-weighted points, the arcade produces its round points, and a manual
activity produces whatever the facilitator typed. Raw numbers are never added
across activities.

**Normalisation.** For each activity, the top raw score becomes 100 and
everyone else gets `round(100 × raw ÷ top)`. A kicked participant is excluded
from the `top` calculation. This is computed live, so the standings after every
activity are already in Huddle Points.

**Score status.** Per participant, per activity, the status is `played` or
`unset`. `unset` is a cell nobody has typed into. It contributes nothing and
counts as zero towards a total. There is no third status.
[SCORING.md](SCORING.md#removed-spot-awards-and-bench-credit) describes the
`bench` status there used to be, what it credited, and the evidence for
removing it.

**Totals.** A total is the sum of normalised points across activities, and
nothing else. Three activities give a maximum of 300.

**Spot Awards are gone**, along with Bench Credit. They were 10 points with a
required reason, granted from the console, toasted on the Desktop, and capped
per activity. They were granted twice in twelve sessions, and they were removed
along with the cap, the commands, and the toast kind. SCORING.md records what
they were for.

**Tiebreak for first.** The session config lists activities in tiebreak order
(for the first huddle, the tabletop exercise comes first, as the design says).
If players are still tied, the host has a **Sudden death** button in trivia:
one question, where the first correct answer wins and no points change. There
is never a coin flip, and the software does not have one.

### What participants see of the standings

**Participants see the top five and never the full ranking**, on the Desktop
and on every phone. The bottom of an individual leaderboard has someone's name
on it in front of their team, and the software enforces this so that the
scorekeeper does not have to remember it.

Each participant also sees **their own total**, without a rank. A participant
can keep adding to a total, but a rank of 23rd would give them a reason to stop
playing.

### Seal and reveal

The seal is a session-level state with three values:

| State | Desktop and phones show |
| --- | --- |
| `live` | Top five, updated as activities complete |
| `sealed` | *Scores are hidden* and the fixed line *Revealed at the end.* on every surface |
| `revealed` | The final reveal, 5 → 1, then the winner |

The host seals before the last activity. From then on, no surface shows
cumulative standings, including the Desktop, a participant's page, and their
own total strip. The console still shows everything, because the host needs to
know.

**The strip loses its numbers while sealed.** It keeps its place, because a
strip that vanishes looks like a bug, and it shows a lock and *points sealed*
and nothing else. An earlier draft of this document said it showed the last
value before sealing, frozen. That was wrong, and both the code and
[DESIGN.md](DESIGN.md) say so: a frozen strip leaks what the seal exists to
hide, since the last value plus a known activity is most of the way to a rank.
Nothing is cached, and `own` is omitted from the wire entirely while sealed
instead of being sent as null, so the numbers are not on the participant's
machine to be recovered. They come back at the reveal.

The seal needs this much care because the single prize creates the problem the
existing design names: by the last activity only a handful of people can win,
and the only thing keeping the rest playing is not knowing who. Any leak, such
as a total that keeps rising or a "you're 4th", undoes it.

**Activity podiums still show while sealed.** The trivia's own top five after
each question is part of the trivia. It says who is winning *this activity*,
which does not reveal the session standings.

**Turning that off is not built.** The design had a per-activity toggle, on by
default, for a host who wants the last activity completely blind. There is no
such toggle: the podium is part of the trivia reveal and shows on every surface
at the reveal, whether the session is sealed or not. A host who wants the last
activity blind has to skip revealing the question, which costs the room the
answer as well. That is a worse trade than the toggle would have been, and it
is the argument for building the toggle.

## Trivia

Trivia works like Kahoot without needing Kahoot. A set has twenty questions
with four answers each and a timer, and a correct answer scores more the faster
it comes in.

**The phone shows the question and the answers.** Kahoot shows the question
only on the shared screen, which assumes everyone can read the shared screen.
Over a video call the shared screen is a compressed tile next to nine faces.
The phone shows the question text, the four answers with shape and colour, and
the timer. The Desktop has the same, plus the answer count as it climbs.

**Per question:**

1. The host opens the question, and the timer starts on the server. Phones show
   the answers, and the question appears large on the Desktop.
2. Participants tap once, and the tap is final. The phone shows "locked in" and
   nothing about the answer, with no hint of correctness until the reveal,
   because a phone that turns green is visible to the person next to you. From
   that moment it does show "24 of 27 answered", which says how many people
   have answered and nothing about what any of them chose. It is there for the
   participant who answers in three seconds and then watches a still phone for
   seventeen.
3. The timer expires, or the host closes it early. The console shows "24 of 27
   answered" and a close button, because waiting out a 30-second timer when
   everyone has answered leaves the room with nothing to watch.
4. The reveal shows the correct answer, the answer distribution as bars, the
   note if the question file has one, and then the activity's top five. The
   host advances.

**Scoring per question.** The base is 1000, and a question can override it.
A correct answer scores `round(base × (1 − (t ÷ T) ÷ 2))` where `t` is the
response time and `T` the time limit, so a correct answer at the buzzer is
worth half of an instant one and never less. A wrong answer or no answer scores
0. A streak bonus of `100 × min(n − 1, 5)` is added for the n-th consecutive
correct answer. That matches Kahoot's shape closely enough that the old
facilitator guidance, "streaks and speed bonuses stay on", still means what it
meant. Response time is measured on the server and corrected for the
connection's measured latency, capped at 250 ms, so someone in Bengaluru on
hotel Wi-Fi does not lose a speed race to someone in Sydney on fibre.
[ARCHITECTURE.md](ARCHITECTURE.md#clocks-and-fairness) has the mechanism.

**Multi-answer questions.** `correct` may name several answers
(`["B", "D"]`), and any of them is correct. This is how Kahoot treats them.

**Two- and three-answer questions** are allowed by giving two or three answers.

**Sudden death** draws a question from the tiebreak pool and never from the
twenty. It has no timer, the first correct answer wins, the Desktop names the
winner, and no points change. A sudden death that used one of the scored
questions would change the game it was asked to settle.

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
wrapper exists only to carry a title.

| Key | Required | Rules |
| --- | --- | --- |
| `text` | Yes | ≤ 200 characters, because longer text will not fit a phone |
| `answers` | Yes | Two to four of them, ≤ 80 characters each |
| `correct` | Yes | The correct answer's letter, or a list of letters |
| `timeLimitSec` | Yes | 5–120 |
| `note` | No | Shown on the reveal, and it is the part people learn from |
| `round` | No | Consecutive questions with the same value get a round card between them |
| `basePoints` | No | Base points, default 1000. 0 makes a question a warm-up |
| `tiebreak` | No | `true` takes the question out of the scored set and into the sudden-death pool |

The answer is named by its letter because a letter is what the question bank
writes and what a participant sees. A letter is neither 0-based nor 1-based,
so the off-by-one error that a column of answer numbers invited cannot happen.
A number in `correct` is refused with a message naming the letter to use
instead. It is almost always a half-finished migration from the old CSV, and it
is the one mistake that would import cleanly and mark the wrong answer.

Unknown keys are errors at both the file level and the question level. The
author of a file carrying `timelimitSec` believes they set a timer, and
silently using the default would turn a 20-second question into something else
in front of thirty people.

A question flagged `tiebreak` is lifted out of the twenty and into the pool
sudden death draws on. Sudden death scores nothing, so a question it uses
cannot also be one of the scored questions. A file of 23 questions with three
flagged is a twenty-question game plus three tiebreakers.

Import validates every question, and if any question fails, it rejects the
whole file with errors that name the question and key
(`Question 8, correct: …`). It does not load the questions that passed,
because a set with question 14 missing is worse than a set that failed to load
in the dry run.

Questions load per session. Editing a loaded set means re-uploading, and there
is no in-app editor by design. Checking the ⚠️ VERIFY items in the question
bank stays a human job.

## Hashi Arcade

The arcade has the most personality in the product, and its format changes the
most from what exists. The current board is a whole-room race to type in chat,
which worked because it was so different from Kahoot's heads-down phone. Moving
answers onto phones risks making the arcade feel like a second trivia round,
and the staging is what prevents that.

### The frame

The arcade is themed on Squid Game, played completely straight about
infrastructure tooling. It has a faceless announcer (the **Front-End Man**),
staff in pink with shapes on their masks, players in green tracksuits with
three-digit numbers, and an eerily calm voice telling you the next game will
begin shortly. The show turns children's games sinister, and each game here is
a children's game made sinister by Terraform.

The tone is **comical**. The joke comes from treating it all seriously. Nobody
dies and nobody is mocked. The staging says "the stakes are enormous", while
the content says "you tapped during a state lock".

**Player numbers.** On entering the arcade every participant gets a
three-digit number (roster order, zero-padded). It appears on their phone,
on the Desktop grid, and in the announcer's copy. *Player 017 has been
drained.* The number has two jobs: it lets the Desktop show sixty people as a
grid you can read, and it gives the elimination copy something to say that is
not a colleague's name in red.

**The staff.** There are three mask shapes, ○ △ □, which in the show are ranks.
Here, ○ *reads the plan*, △ *runs the apply*, and □ *approves the PR*. They
appear on round cards and never do anything. They are set dressing, and the
joke is made once per session, on the card that explains it.

### Nobody sits out: the Floor and the Lounge

This is the arcade's main design constraint, and its best idea. Every round
has a **Floor** (the game) and a **Lounge** (where you go when you are out).

When you lose a round you are not eliminated. You are **drained**, as in
`nomad node drain`: your allocations are rescheduled and you stay in the
cluster. The phone desaturates for one beat, says *Player 017 drained*, and
then a gold card slides up: **Welcome to the VIP Lounge.** In the show the
VIPs are the masked rich who bet on the players from a sofa. That is now you.

In the Lounge you **back a player** still on the Floor. Tap a name, and change
it freely until the Floor locks. If your player survives the round, you score.
If your player wins the round, you score more. The Desktop shows who has
backed whom, so being backed by six people is its own small pressure, and the
Lounge is the loudest part of the room.

**A bet has to be placed before the thing it is betting on.** You can change
it as often as you like, but watching somebody cross the line on the Desktop
and then naming them does not pay. Every Floor is a public surface, such as the
finish order in Plan / Apply or the tins coming open in Unseal. Without this
rule the Lounge would pay its maximum for reading a screen, which is not a bet
and is worth more than several honest ways off the Floor.

Lounge points are real points that count toward the arcade raw score, capped
so a perfect Lounge round is worth less than surviving the Floor. Someone
drained in the first ten seconds of every round who backs well ends the arcade
with a respectable score and, more importantly, has been *playing* the whole
time, shouting for someone. The Lounge exists for the person who used to be
knocked out at minute six with fifteen minutes left to watch.

**Draining lasts one round.** Every round starts with everyone back on the
Floor. Cumulative elimination would spend the last five minutes with three
people playing and thirty in the Lounge. That is how the show works, and it
does not suit a work afternoon.

**Banked progress.** Every Floor game banks points at checkpoints before you
are drained. Getting caught at 75% keeps what you banked at 50%. This is
partly kindness and partly a Terraform joke that partial applies leave state
behind.

### The rounds

**Six are designed and six are built.** A standard eighteen-minute run is
round 0 and four of the rest. The host picks them in setup and sets the order.
Timings include the round card (20 s) and the reveal (20 s).

For a long time Gganbu was the sixth round, designed but reachable from
nowhere. Its scoring and pairing were in the engine while `arcade.round` had no
variant for it, so the wire refused one and the console listed it disabled: it
was visible in the run of show and impossible to start. That was right while it
lasted, because the blocker was never the wiring. The launch prompts were three
default port numbers and three release years, and in a room of solutions
architects both halves of every pair would have known all six, wagered the
minimum, and tied. Gganbu has the most social mechanic in the arcade, and it
only works with questions the pair disagree on.

The prompts were rewritten to that standard, each with a threshold set a
plausible distance from the true value so the wager is a judgement and the
answer cannot be recalled. Then the round was finished. It is still the
first round to drop if the slot is tight, because its joke depends most on
everyone knowing the show.

| # | Round | The game | Content | Time | Drains? |
| --- | --- | --- | --- | --- | --- |
| 0 | **Recruitment** | Emoji Decode | 7 existing items | 2.5 min | No |
| 1 | **Plan / Apply** | Red Light, Green Light | — | 3 min | Yes |
| 2 | **Unseal** | Dalgona | 17 Scrambled tins | 3 min | Yes |
| 3 | **Tug of Raft** | Tug of War | — | 3 min | No |
| 4 | **Gganbu** | Marbles | 6 Over/Under items | 3.5 min | Yes |
| 5 | **The Glass Bridge** | Glass Bridge | 6 Real-or-Fake pairs (3 existing) | 3.5 min | Yes |

**The content of the four rounds that have any is staged, like the question
set.** Recruitment's emoji items, Unseal's tins, Gganbu's prompts, and the Glass
Bridge's pairs are each a literal compiled into `app/src/arcade/`, and each can
be replaced for one session by staging an `arcade-content.json` beside
`trivia-questions.json`. A round the file does not carry **plays its compiled
set**, so an event that stages nothing plays exactly what the build shipped, and
a file that carries only Gganbu changes only Gganbu.
[docs/event-config.md](docs/event-config.md#the-arcades-content) describes the
format and what a second upload does.

The content is staged from a terminal, and cannot be set in the console,
because **each of these four rounds' content carries its own answers.** An
`OverUnderItem` holds the answer and the reveal note, a `GlassStep` holds which
pane is real, and an `UnsealItem` holds the word. This is also why the
Gganbu prompts do not travel on the `arcade.round` host command: six prompts
sent from a browser would put the answer key in a browser. The reason applies
to all four sets. Staging goes from the host machine to the server over HTTPS,
authenticated by the host token, and the browser never holds the file.

#### Round 0: Recruitment (Emoji Decode)

*In the show, a recruiter at a train station plays ddakji with strangers and
slaps the ones who lose. Here the recruiter keeps asking until everyone gets
in.*

Each item is two emoji for one product, and the player types the product's
name. There are seven items at 20 seconds each, from the existing Emoji Decode
content (`🔐🏦` → Vault, `🏕️🐪` → Nomad, `🔎🕸️` → Consul). Answers are text
input, matched after lowercasing and stripping non-letters, with an accept list
(`tf` for Terraform). Every correct answer within the timer scores **5**, and
the first three correct in the room score **+5**.

Seven items at 20 seconds is 140 s of Floor, about 20 s past the 2.5 minutes
this table budgets. That is accepted, because the seventh item is what stops
the last two answers being reachable by elimination.

The answer used to score **10**, which made the round's Floor maximum 105. That
was half of everything the Floor can pay across the three rounds the event
actually runs, in the one round nobody can be knocked out of, and it was
settled before any round with a decision in it had started. Halving the answer
score, and deliberately leaving the first-three bonus alone, brings the maximum
to 70, which is 40%. It is still the largest single round, which is the part of
the argument for paying well that survived: it hands out the player numbers and
it sets whether people think they can win.

There is no draining. An item closes two seconds after the last person answers
it instead of running out its twenty seconds. Trivia's close button next to
"24 of 27 answered" exists for this too: once the Desktop says "9 of 9
answered", the rest of the item gives the room nothing to watch. The wait is
longest for whoever answered *wrong*, whose phone says "Locked in." and has
nothing else to show until the item ends. At the end, the Desktop "recruits"
everyone: the grid fills with player numbers and the Front-End Man welcomes
them.

The round exists because, as the existing README says, round one sets whether
people think they can win. Everyone scores in Recruitment, and it hands out the
player numbers that the staging needs.

#### Round 1: Plan / Apply (Red Light, Green Light)

*The doll is a twelve-foot Terraform logo. When its head is turned, the sign
reads PLAN. When it turns to face you: APPLY IN PROGRESS — STATE LOCKED.*

The phone is one big button. During **PLAN** (green), each tap advances you one
resource, and the finish line is 120 resources. During **APPLY** (pink), any tap
is `Error: state lock held by another process` and you are drained. Phases
alternate on random durations between 2 and 6 seconds. The Desktop shows the
head beginning to turn 400 ms before the lock, and the phone vibrates on the
turn. There is a 250 ms grace after the lock for network latency, so over a
video call a tap made just before the light changed does not count as a loss.

**A gentler opening.** The first PLAN of the round lasts 8–10 seconds, so the
room learns the button before it learns the lock, and the round's first two
locks give 600 ms of grace instead of 250. Later locks are unchanged.

**One free strike.** Your first tap on red warns you instead of draining you:
the phone buzzes and reads `Warning: state lock held by another process. That
one was free. The next lock drains you.` The rest of that same lock is
ignored, because a fast tapper has several taps already in flight. A tap in
any later lock drains you. Every round the console starts has the strike, and
the engine's default is off.

**The race track.** Every player in the room has a lane on the Desktop's light,
on the phone under the button, and on the Lounge card, sliding toward the
finish as their count rises. A drained runner explodes where it stood and
stays there as a wreck, a runner across the line wears a ring, and a struck
runner wears a dashed one. On a phone your own runner is green and tagged
`YOU`. Up to 16 players, every runner carries its player number. Past 16, only
the three runners furthest ahead that are still in the race keep theirs (and
`YOU` on a phone), so a big room can still see who is leading, and the strike
rings get thinner with the dots. The phone's track moves only on the frames it
already receives, and the Desktop's is sent each ordinary step.

Checkpoints at 30, 60, and 90 resources bank **5** each. Crossing the line
banks **+10**, and the first three across get **+15**, **+10**, and **+5**.
Drained players keep banked points and go to the Lounge to back a runner,
which pays **+10** if the runner crosses and **+15** if the runner wins. Play
lasts 75 seconds. The resource target is a host setting, and 120 is tuned so
about half the room crosses.

A player loses by tapping during a lock. The screen shows the error verbatim,
in red monospace, the way it looks in a real terminal, and then the gold Lounge
card.

#### Round 2: Unseal (Dalgona)

*Each player is handed a sealed tin. Inside is a word. Pick your shape before
you know the word.*

A shape-pick screen comes first, exactly as in the show: ○ △ ☆ ☂. Then the
reveal shows that the shapes are word lengths. Circle is a four- or five-letter
term (`RAFT`, `VAULT`), triangle six (`MODULE`, `GOSSIP`, `UNSEAL`), star eight
(`SENTINEL`, `PROVIDER`), and umbrella eleven-plus (`DECLARATIVE`,
`IDEMPOTENCY`). The letters appear scrambled on the phone, and the player
**taps them in order**. Players have sixty seconds.

**Two strikes.** The first wrong tap **cracks** the tin: it is damaged, your
score for the round is halved, and you keep tapping, because the word can still
come out. The second wrong tap **shatters** it and drains you to the Lounge. In
the show the honeycomb cracks audibly before it breaks, and the game is played
in the seconds between the two sounds. With one strike the round had no rising
tension, because a circle player was out in five seconds and an umbrella player
lost a word they knew to a fat thumb.

Unsealing scores by shape: **10**, **20**, **35**, and **50**, with **+10** for
the fastest in each shape. A shattered tin drains you, with **2 per correct
letter** banked up to that point, and then you go to the Lounge. The per-letter
2 counts **towards** the shape score and is not added on top of it, which is
what keeps the Floor maximum at 60. Backing a player who unseals is **+5**, and
backing the fastest in any shape is **+8**. As everywhere else, a backer gets
the better of the two and never their sum.

**A crack costs the same halving as Read the docs, and the halving applies
once.** A player who has both read the docs and cracked their tin is halved,
not quartered: there is one damaged tin and it is priced once, however it came
to be damaged. This has two consequences. A player who cracks and then opens
the tin anyway takes half its shape score, and is still eligible for the +10.
A wrong letter costs a second of the sixty and gains nothing, so somebody who
cracked and still finished first did it the hard way. A shattered player's
banked letters are halved too, because a tin can only shatter after it has
cracked: two correct letters and then two wrong taps bank 2, where the
one-strike round paid 4 for two correct letters and the single wrong tap that
ended it. The crack alone banks the same 2, because the halving is charged at
the first wrong tap and the second one only ends the round.
**The Floor maximum is unchanged at 60**, for an undamaged umbrella opened
fastest, and no other constant moved.

The Lounge pays 5 and 8 here, where Plan / Apply pays 10 and 15, because this
round's cheapest completion is a circle tin at **10**, and a perfect Lounge of
15 would beat somebody who actually unsealed one.

There is a button labelled **Read the docs**. It reveals the next letter and
halves your score for the round. In the show, licking the back of the
honeycomb is the cheat that works. This button is that cheat, and it is the
funniest button in the product because everyone knows what it means.

The existing six Scrambled items ship as launch content. The umbrella tier
needs three long words added. They are in the round file with the same
`cue / ans / note` shape, and the reveal reads the note aloud, so *the thing
everyone means to write and never does* is kept.

The circle tier needs a second word for the same reason a tier is dealt out by
player number at all: with one word in it, the first person to say `RAFT` on
the call has solved the tier for everybody who picked the cautious shape.
`VAULT` is that second word.

#### Round 3: Tug of Raft (Tug of War)

*Two clusters. One rope. The rope is leadership.*

The room is split by player-number parity, then reshuffled by seed before each
of three pulls. A **heartbeat** pulses on the Desktop and on every phone at
100 bpm. Tap *on the beat* and your side pulls. Tap off the beat and nothing
happens. Miss three beats in a row and your node **times out and calls an
election**, which in this game, as in Raft, achieves nothing useful for two
seconds. The rope on the Desktop moves with the net on-beat rate.

Each pull is 25 seconds. Every member of the winning side banks **10**, and the
best on-beat rate on each side (the **leader**) banks **+5**, win or lose.
There are three pulls with sides reshuffled each time, so nobody is stuck on a
losing side.

**Nobody drains.** This is deliberate, because two elimination rounds in a row
wear the room down, and the arcade needs one round that is pure noise. Losing a
pull costs only that pull. Run it between Unseal and Gganbu.

The heartbeat is also why this works over video. A raw tap race rewards
whoever's phone registers taps fastest, and the beat caps everyone at the same
rate, so the skill is rhythm and the hardware does not matter.

#### Round 4: Gganbu (Marbles)

*You are paired with a gganbu. You each hold ten Vault tokens. Tokens have a
TTL, and the round ends when they expire. Wager them.*

Pairs are random. An odd person out is paired with the house, played by the
Front-End Man, and a rival who disconnects is replaced by the house. There are
six **Over / Under** prompts, 15 seconds each: *Vault's default max lease TTL —
over or under 720 hours?* Each player secretly picks over or under and a wager
of 1 to 5 tokens. A correct pick gains the wager, and a wrong one loses it.
Your rival's name and token count sit on your screen the whole round.

At the buzzer, tokens convert to points **1:1** (a maximum of 40 for a perfect
run). Whoever of the pair holds more takes **+10**. Reach **zero** and your
token is **revoked**: you are drained to the Lounge, where you back a surviving
player. That pays **+5** if they finish above their rival and **+8** if they
finish with the most tokens in the room, and a backer gets the better of the
two and never their sum.

If your gganbu leaves mid-round you **both** play the house, which holds its
opening stake and wagers nothing. The same rule applies to both players,
because a one-sided substitution let both of them collect on an odd roster and
neither on an even one.

The pairing is mostly presentation, since everyone answers the same prompts,
but a named rival makes a wager feel like a wager, and the *gganbu* card on the
round intro is the one Squid Game reference everyone will get.

Six Over/Under items ship as launch content, each carrying a note, and every
one is flagged VERIFY with the same discipline the trivia bank applies to
dates.

**The flag marks a value that a release can change.** In the trivia bank that
is usually a date. Here every prompt is a product configuration default
(Terraform's parallelism, Vault's max lease TTL and request deadline, Consul's
check interval and KV value ceiling, and Nomad's default task CPU), and a
release can change any of them without announcing it. So all six carry the
flag.

Three carried it when half the bank was release years. Those prompts are gone,
because a year is either known or guessed, and neither produces the hesitation
a wager needs. Flagging three of six now would mean choosing which three to
stop checking, and none of them is safe to stop checking. A flag on a chosen
few would tell the next reader the rest are settled.

**A prompt every player knows is a bug in this round.** It produces the minimum
wager from both halves of the pair and a tie, which is the one outcome the
round has nothing to say about. The thresholds are therefore placed where the
room's intuition splits. For example, 720 hours is thirty days, the round
number people tend to assume, and the answer is thirty-two. Each threshold is
also far enough from its answer that no patch release or disputed month can
flip it.

#### Round 5: The Glass Bridge

*Twelve panes. Six are tempered. The tempered ones are real.*

There are six steps. At each step there are two panes: one is a real HashiCorp
feature (*Vault Transit Secrets Engine*), and one is invented (*Vault Lease
Broker Mesh*). Step on the real one. A player who picks the wrong pane falls
and is drained, keeping everything banked so far.

That pair shows the format and is not on the shipped board, which pairs *Vault
Cubbyhole* against *Vault Lockbox Engine*. Transit is known to anyone who has
used Vault, and the round wants a real feature that *sounds* invented. The
reasoning is at the top of `app/src/arcade/glass-bridge.ts`.

Players cross in **three waves** by player number. Wave 1 goes blind, with 12
seconds per step. Wave 2 goes next, with 9 seconds, and can see on the Desktop
which panes broke under wave 1. Wave 3 goes last with 6 seconds and near-total
information. In the show the information asymmetry is the point of the game,
because going first is worse, and here it makes waiting for your wave worth
watching closely.

Each step crossed banks **5**, reaching the far side banks **+15**, and wave 1
banks **+3 per step** for going blind.

**A drained player may only back a *later* wave, and the bet locks when that
wave walks on.** The round needs both rules. Without the first, every backer
would wait for a wave 1 runner who is already across, and so still on the
Floor, never drained, and backable, and collect on a certainty. The Lounge
would stop being a bet. Without the second, a backer watches their runner fall
and switches to the next wave, which gets the same certainty another way. One
consequence is that someone drained during wave 3 has no later wave to back
and scores nothing in the Lounge.

Drained players back someone in a later wave, and are paid **+10** if the
runner crosses and **+15** for the fastest full crossing. As in Plan / Apply,
a backer gets the better of the two and never their sum. A backer is never
paid twice for one runner, and the Lounge rule stays the same between rounds
because it is hard enough to explain once.

**A wave that is waiting bets too**, and this is the only round where that
happens. Two of the three waves are on the Floor with nothing to press for up
to two minutes, which would break "nobody sits out" in the round that needs it
most, because watching closely is what waves 2 and 3 are *for*. So a player who
is on the Floor and cannot act, whether waiting for their wave or already
across, backs a runner in the wave that is crossing. The bet is placed before
anybody in that wave has stood on a pane and stands from then on, exactly as
the drained side's bet does. It has to be before *anybody* has stepped, and
not merely before step 2, because a fall is public the moment it happens, so
one runner down already tells the watchers half of what they would be betting
on. It pays **+5** for a crossing and **+8** for the fastest crossing, which is
half the Lounge's pair, because a waiting wave is being paid for this round
twice, and one of those payments is their own crossing. The cheapest way
across the bridge is 45, so watching is never worth more than walking.

Launch content is the existing three real and three fake Real-or-Fake items,
re-paired **within a product** and made up to six pairs. That needs six
additions, because the existing six are three reals and three fakes across six
*different* products, so each one needs its opposite number written for it.
Pairing across products would give the round away: *Vault Transit Secrets
Engine* beside *Packer Provisioner Mesh* asks which product you have heard of,
when the round is meant to ask which feature is real.

The reveal note for each pane reads out why the fake was fake, and the notes
travel separately from the labels, because a note explaining why a pane is
fake is the answer and cannot be attached to the thing being shown.

**"Fastest full crossing" means the lowest total decision time**: the six
reaction times added up, each measured from its step opening. The two obvious
measures both fail. Being first across by the wall clock always goes to a
wave 1 player, and it is settled before the Lounge has anyone in it. Elapsed
time since your own wave started always favours wave 3, because a wave cannot
advance until its step closes. Total decision time is the only measure that
compares across three waves running at three speeds. It stays live until the
last wave is off the bridge, and it lets a decisive wave 1 runner hold the
record against a hesitant wave 3 one. Ties go to whoever crossed first.

### Arcade scoring summary

| Round | Floor max | Lounge max |
| --- | --- | --- |
| Recruitment | 70 | — |
| Plan / Apply | 40 | 15 |
| Unseal | 60 | 8 |
| Tug of Raft | 45 | — |
| Gganbu | 50 | 8 |
| Glass Bridge | 63 | 15 |

The raw arcade score is the sum. It is normalised like any other activity, so
the absolute numbers only matter relative to each other. The tuning target is
that **crossing the line always beats a perfect Lounge**, and that a perfect
Lounge is always worth having.

That is a deliberate narrowing of what this used to say, which was "surviving a
Floor is always worth more than a perfect Lounge". No choice of constants can
make that true: a player who is never drained but never reaches a checkpoint
banks nothing, and nothing is less than a perfect Lounge. The Floor pays for
*progress*, so a backer who picked the winner has out-played someone who
neither progressed nor got caught.

It also means the Lounge awards do not stack. Backing a runner who crosses pays
10, backing the winner pays 15, and a perfect Lounge round pays the larger of
the two. Adding them made 25, which tied the 25 a player scores for crossing
the line in fourth place, and let a player drained at 90 resources who backed
the winner finish on 40, level with the player who actually won the Floor.
Gganbu is tuned against the same rule: its perfect Lounge is 8, against a Floor
that pays 50.

The Front-End Man's lines, the round cards, and every piece of copy are in
[DESIGN.md](DESIGN.md#the-arcade-register), because the wording decides most
of whether they are funny.

## Manual entry for the TTX and anything off-platform

A session can include a **manual activity**, which has a name, an accent
colour, and no gameplay. The Agentic Security TTX is one, and so is anything a
future event runs on a whiteboard.

From the console, the host opens the activity and sees the roster with a raw
score field per person, and types the scores in. The normalised points preview
updates as they go, so the host can see the top scorer land on 100.

Each field is its own `score.set`, and each one lands immediately. There is no
draft, no Publish, and no paste.

**Paste with fuzzy matching is not built.** The design was two columns of name
and number from the facilitator's spreadsheet, fuzzy-matched to nicknames, with
every match under full confidence shown for confirmation, so the scorekeeper's
detective work would be done once, with the software making the suggestions.
Nothing parses two columns and nothing matches a name to a nickname. The scores
are typed.

**Draft-until-publish is not built either**, and the two were one decision:
the draft existed so a paste could be reviewed before it moved the standings,
and with no paste there is much less to review. A typed score changes the board
as it is typed.

That is a real cost while the session is unsealed, and it is why the host
should seal before manual entry: a mistyped number is visible on the Desktop
for as long as it takes to notice, and the fix is to type the right one over
it. While the session is sealed, nobody sees either number. Draft-until-publish
is worth building if an event ever has a manual activity with more than a
handful of scores.

The facilitator of a manual activity is not scored for it, which now means the
host leaves their cell `unset` and says so out loud. There is no status that
credits them, as
[SCORING.md](SCORING.md#removed-spot-awards-and-bench-credit) explains.

## Holding page

A card the host puts up when the room should be looking at a person and away
from the screen. It carries a **title** and **one line of context**.

**No presets, and no countdown.** The design listed *TTX in progress*, *Break*,
and *One more thing* as presets alongside free text, and an optional time that
rendered as a countdown. A card is a title and a line, and there is no `until`
field on the command or in the state.

Presets were replaced with something that suits how an event runs: the host
writes **every** card they might want during setup, and the console keeps them
in that browser's local storage, where they survive a reload and are still
there next time. Once the session is running, a card can be put up, jumped to
from the rail, or raised with `SHIFT+H`, but not written. Editing a card
mid-session means editing something thirty people may be looking at in a
minute, and a preset would have been the one card nobody proofread.

The cost is that the deck is per machine: a co-host's console has its own, and
a card nobody wrote shows "Back shortly". See
[docs/running-an-event.md](docs/running-an-event.md).

The card is never blank, because a blank screen on a phone looks broken, and
thirty people refreshing during the TTX would be a support call the host cannot
take. The card also shows the participant's own points strip (unless sealed)
and a quiet "connected" indicator, which tells everyone the session is still
running without saying anything.

## Failure modes that matter at a live event

**Someone joins late.** This is covered above: they land on the current
segment and play from the next question or round. The activity they missed is
a zero.

**The console does not flag them, and there is no longer anything to flag them
*for*.** Nothing records when somebody joined relative to an activity or
surfaces it anywhere, and with Bench Credit removed there is no status that
would have absorbed the gap either. A late joiner takes a zero in an activity
they were never in, which drags their normalised total down and shows up as
`unset` in the scoring grid, exactly like a score nobody has typed yet. The
product now does this by design, and it does not mean the host forgot
something. [SCORING.md](SCORING.md#removed-spot-awards-and-bench-credit)
explains why.

**A connection drops mid-question.** The answer they submitted before the
drop counts, because it was already on the server. A question that closed
while they were gone scores 0 for that question, with no do-over: asking it
again would need the whole room to wait, and anyone they are sitting with heard
the answer. The page shows a reconnect banner and resumes wherever the session
is. In the arcade, a player who drops mid-round is marked **away**, which is
different from drained, and rejoins the Lounge for the rest of that round and
the Floor for the next.

**The host's browser crashes.** Nothing is lost: the state is on the server,
and timers run on the server, so the question in progress closes on time
without the host. The host reopens the console link and is exactly where they
were. Progression *does* stop, because the next question does not open by
itself, so a co-host holding the same console link is recommended for any
session with more than fifteen people. The playbook's "two people minimum"
already says so.

**The server restarts mid-game.** Every state transition is persisted, so the
service comes back with the session intact within about twenty seconds and
every surface reconnects by itself. A trivia question that was open is paused,
and it resumes with the time it had left when the first phone is back. A tap
made during the gap is sent again by the phone once it reconnects. The arcade's
rounds are not paused.

**There is no re-ask. Not built.** This document used to say the console
offered one on the affected question. There is no such command, no event for
it, and nothing that counts how many answers a gap swallowed. A host left
holding a question that scored some of the room and not the rest has one
ordinary scoring tool: a raw score typed in by hand.
[ARCHITECTURE.md](ARCHITECTURE.md#durability-and-restart) has the details.

**Two people pick the same nickname.** The second is refused with a message
that explains the release flow, above.

**Someone joins under a name that is a problem.** Rename or kick from the
console. Kicked participants can rejoin under another name unless the lobby
is locked, which it should be once the first activity starts.

**The Desktop tab dies.** Reopen the screen link. The Desktop only displays
output and has no state of its own.

**The join code leaks.** It cannot leak by being overheard, because it is 24
random characters, but it can be forwarded, which has the same result. Lock
the lobby once the first activity starts. A locked lobby takes no new
nicknames, but rejoin still works for everyone already in.

**Someone's browser cannot run it.** The participant view is one responsive
web page with no framework and no bundler. A phone works, a laptop works, and
an old browser that fails is failing at plain DOM.

**Everything is down.** The activity content is still plain text in this repo,
and the playbook's fallback stands: read it out, score in chat, and keep going.

## Out of scope

Accounts, SSO, and any identity beyond the host and screen tokens. Teams. Chat,
reactions, and emoji storms. A question editor. Multi-language. Native apps.
Analytics beyond a CSV export. Prize fulfilment. The TTX content. Kahoot
compatibility of any kind, including reading its CSV. Running the session with
no host.

## Open questions

These are places where the brief is followed but disagreed with, or where
something needs a decision from someone else.

1. **This will not exist for the first huddle.** The brief says build it
   properly with no deadline, and the first event it could serve is a week
   away. The first huddle should run on Kahoot, the existing board, and the
   spreadsheet as planned. Quorum's first outing is the next one, and that
   should be said out loud so nobody plans around it.

2. **"Higher TTX score" as the tiebreak is a decision for each event.** It is
   built as a per-session tiebreak order so the rule survives, but a future
   event with no TTX needs to choose its own, and the config lets it.

3. **Speed-weighted scoring over a video call is unfair at the margins,
   whatever the latency correction does.** The correction narrows the gap but
   cannot close it. The formula's floor (a correct answer at the buzzer is
   still worth half) is the real protection, and it is the reason not to
   "improve" the formula toward Kahoot's steeper curve.

4. **Six arcade rounds is more than the slot.** Six were designed so the host
   has a choice and a longer session has material, and a standard run is five.
   If the eighteen-minute slot stays, drop Gganbu first, because its joke
   depends most on everyone knowing the show.

5. **A single stateful process means a deploy is an outage.** The brief accepts
   this. It was to be handled by a freeze check in the deploy pipeline, but
   there is no pipeline, because the account permits no machine identity. A
   person checks `sessionsLive` on `/healthz` before deploying instead. See
   [infra/README.md](infra/README.md). "Properly" here does not mean "highly
   available", and it should not.

6. **The Lounge's "back a player" is one mechanic for every round.** It could
   be richer, with per-round side games, but one mechanic that everyone learns
   in round 1 and still uses in round 5 is easier on the room than four clever
   ones. Revisit it after a real session.

7. **Should participants see their own total at all?** This document argues
   for yes, without a rank. If the first live run shows people counting
   themselves out from the number, hide it, and show only the top five.
