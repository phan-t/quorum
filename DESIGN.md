# Quorum design direction

This document sets out what the three surfaces look like, how they move, and
how the arcade gets its own look while keeping the shared one. Most of the
rules here are ones the existing artefacts already follow. The additions are
the phone, the console, and the Squid Game register.

## The family

Everything in this repo already shares a look: IBM Plex on near-black,
HashiCorp product hues as accents, and mono for anything that is a label or a
number. Quorum keeps it, because the Desktop, the console, and the phone
will be screenshotted side by side and need to read as one product.

### Tokens

```css
:root {
  /* ground */
  --ground: #0A0A0F;  --panel: #14141D;  --panel-2: #1D1D28;  --line: #2C2C3A;
  --ink: #F6F5F3;     --muted: #8B8A9C;  --dim: #5E5D6E;

  /* product hues — the only saturated colours in the system */
  --terraform: #7B42BC;  --vault: #FFCF25;  --consul: #DC477D;  --nomad: #00CA8E;
  --ibm-blue: #0f62fe;

  /* semantic */
  --hit: var(--nomad);   --miss: #FF6B5A;
  --live: var(--nomad);  --sealed: var(--vault);  --danger: #FF6B5A;
  --streak: var(--vault);

  /* activity accents — fixed per activity across every surface */
  --ttx: var(--terraform);  --trivia: var(--consul);  --arcade: var(--nomad);
}
```

The activity accents are the same assignment the live scoreboard already
uses. Once a participant learns that pink is trivia, pink is trivia on the
phone, on the screen, and in the console.

**Quorum uses a dark theme only.** The existing pages declare
`color-scheme: dark`, and Quorum does the same on purpose. A light phone next to
a dark Desktop in a video call looks like two products. The Desktop is dark
because light type on a dark background stays legible in compressed video, and
dark type on a light background turns muddy.

### Type

| Role | Face | Where |
| --- | --- | --- |
| Display | IBM Plex Sans Condensed 700, tight leading (0.94), `-0.02em` | Questions on the Desktop, round names, the winner |
| Body | IBM Plex Sans 400/600 | Answers, copy, the holding line |
| Label | IBM Plex Mono 400/600, `0.16–0.22em` tracking, uppercase | Eyebrows, kickers, player numbers, timers, counts, everything tabular |

Numbers are always Plex Mono with `font-variant-numeric: tabular-nums` so a
timer does not jitter and a points column lines up.

### Motion

Reveals use one easing, `cubic-bezier(.2,.9,.3,1.2)` at 300 ms, which is the
`pop` the arcade board already has. Timers step from one value to the next and
do not animate. Anything that moves respects `prefers-reduced-motion`
by not moving.

The Desktop has a stricter rule, which is that no motion may depend on frame
rate. Video compression turns a smooth 60 fps slide into a smear at 15 fps, so
things on the Desktop appear, hold, and change without sliding.

### Accessibility, once

Text has a contrast of at least 4.5:1 against its background. The muted grey
`#8B8A9C` on `#0A0A0F` meets it, and `--dim` does not, so it is used only for
decoration. Every answer has a shape as well as a colour. Touch targets on the
phone are at least 56 px. Focus is visible on the console. Nothing is conveyed
by colour alone, including "drained".

## Participant — laptop first

The participant page is used in a second window beside a video call, on a
laptop, with a keyboard and a trackpad. It is still designed from 360 × 740
upward, because a responsive page that works at phone width works anywhere, and
some people will use a phone. The laptop is still the case to get right. See
SPEC.md "The three surfaces". This section said "phone first" until 20 Sep 2026,
and the rules below were written for a thumb.

What that changes:

- **Every control has a keyboard route**, and the page says so, because nobody
  guesses "press space" unless told. The arcade's tap button needs it most:
  120 taps in 75 seconds is easy with a thumb and hard on a trackpad.
- **No haptics.** `navigator.vibrate` does not exist on desktop, so a state
  change has to be carried entirely by what is on screen.
- **Hover exists**, which it does not on a phone, but nothing may depend on it.
  A control that appears only on hover is invisible to a touch user and to a
  keyboard user.

The rules below still hold, and most of their reasoning does too, because large
targets and no scrolling under a timer help on any device.

**Nothing scrolls during play.** Every segment fits the viewport. If a trivia
question and its four answers cannot fit, the question shrinks and the answers
keep their size. Answer buttons are a 2 × 2 grid taking the bottom 55% of the
screen. Each is at least 56 px tall, with a shape glyph (▲ ◆ ● ■) in the corner
and one of the four product hues as a *fill*. Quorum copies Kahoot's
shape-and-colour pattern, because it already works.

The ink on those fills is **not** uniformly white. This document earlier sets a
floor of 4.5:1 for text contrast, and white fails it on three of the four
product hues, and white on `--nomad` measures 1.96:1. So the tile takes light
ink only on `--terraform` and dark ink on the other three,
using `--on-fill-light` and `--on-fill-dark`. Those two tokens do not swap
between light and dark themes, because the hue underneath them stays the same,
and ink that followed `--ink` and `--ground` would become unreadable in one
theme. The tiles end up with different ink colours, which is acceptable because
the shape glyph identifies each answer and nothing here is distinguished by
colour alone.

These ratios were measured from computed styles in the browser, because the
stylesheet alone does not show the colours the browser renders: terraform with
light ink 5.76:1, consul 4.93:1, nomad 9.25:1, and vault 13.36:1. Consul's
margin is thin, so any change that darkens that hue needs measuring again.

**The primary action is at the bottom**, where a thumb reaches it. Tap targets
in the top third of a phone screen are for things you do once, such as the join
button. Anything you do under a timer goes lower.

**A points strip sits at the bottom edge**, small and in mono: `YOU 143 · TRIVIA 80
· ARCADE 63`. It is the only element that stays on screen in every segment.
While the standings are sealed, the strip keeps its place, because a strip that
vanishes looks like a bug. It loses every number and shows only the lock and
*points sealed*. It must not freeze on the last figures, because SCORING.md
seals a participant's own total too, and a frozen strip would show exactly what
the seal hides. Nothing is cached, and the numbers come back at the reveal.

**A reconnect shows as a banner.** A thin amber strip under the top edge reads
*reconnecting…* and goes away by itself. It is not a modal, so the page beneath
it keeps showing the last state and the person never looks at a blank screen.

Before the first welcome there is no page beneath it, and that is the one
case where a phone could sit on nothing at all: opening the join link while
the server restarts. So the page paints a *Joining…* card the moment it
starts connecting, and after two seconds of silence the card says the server
may be restarting and that it keeps trying. Somebody who does not know a page
is retrying will reload it, and reloading during a deploy does nothing. On a
fresh join that card covers the form the person just submitted, so it also
offers *Use a different code*, because a mistyped code sent to a server that is
not answering would wait for a refusal that never arrives. A card that ends the
session, such as *You were removed* or a dead link, carries a button back to
the join screen, because a screen with no control on it looks like a broken
page.

**Segments on the phone:**

| Segment | What it shows |
| --- | --- |
| Join | Code field (skipped via link), then nickname. The roster chips SPEC describes are **not built**, so this is free text with a two-character minimum |
| Lobby | Session title in display type, "you're in" with the nickname, and a live count of who is here. A prize line used to be here too, read from the holding card's second line. That broke when there could be more than one holding card, because the line belongs to the card and followed it back into the lobby. Restoring it needs a field of its own |
| Holding | Title, one line, and the points strip. Nothing to tap. The connected dot pulses slowly. The countdown described here is **not built**, because a card is a title and a line, and there is no `until` field on the command or in the state |
| Trivia, open | Question at the top (body, ≤ 3 lines), timer as a bar and a number, and four answer tiles |
| Trivia, locked | The tile you chose, outlined, and the other three dimmed. "Locked in." No colour change and no tick until the reveal |
| Trivia, reveal | The correct tile fills in `--hit`, and yours outlines in `--miss` if it was wrong. Your points for the question count up in mono, then the note, then the trivia top five |
| Standings | Top five, ranks 1–5 in mono, names in condensed display, and totals right-aligned. Or the sealed card |
| Final | A card saying the standings are on the shared screen, held until the Desktop's climb has finished, and then the top five at phone scale. The phone does not show the rows straight away. The wire carries the whole result the moment the segment opens, and the Desktop spends twenty-three seconds revealing it, so a phone that showed it at once would tell its owner and their neighbour who won |

The phone shows the question text because the participant may not be able
to read the Desktop (see the spec). It does not show the answer distribution,
which belongs on the Desktop, so the phone shows only the participant's own
answer.

## Host console

Laptop, landscape, one person driving under time pressure with thirty people
waiting. The design goal is **glanceable**: the host looks at it for two
seconds between sentences and knows what is happening and what to press.

**The screen it is designed for** is a MacBook Pro 14" running Chrome
maximised, but not in full screen, with the tabs, the address bar, and the
bookmarks bar showing. That gives a **1512 × 828** viewport. It is the primary
target, and every layout change is measured there. **1280 × 800** is the
smallest size that must still work. Both sizes are short of height and have
width to spare.

**The layout** is Carbon's UI Shell, with the real components: a 48px
`cds-header` (the session title, the glance line "Trivia · Running · 15 on ·
1 away", the scoreboard tag, the theme toggle), a 256px `cds-side-nav` on the
left (the run of show, a one-column roster that scrolls, the key line), a
256px `cds-header-panel` on the right (the phone preview, the session and
scoreboard controls, the shortcuts, and Close and Restart folded behind a
disclosure), and the live panel between them. Two-column and three-column
alternatives were measured against it at both sizes; see issue #28 and the
layout review for the numbers. The sketch below is the original shape and is
kept for the rules under it.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ⚠ DO NOT SHARE   Team Offsite · RAFT · 27 on · 2 away    ● LIVE     │  status bar (top)
├───────────────┬─────────────────────────────────────────────────────┤
│ RUN OF SHOW   │  TRIVIA · Q7 of 20 · OPEN · 00:14                   │
│               │                                                     │
│ ○ Lobby       │  Which product does secrets management, …?          │
│ ○ Holding TTX │                                                     │
│ ● Trivia   ▶  │   1 Consul     ▍ 2       3 Vault     ▍▍▍▍▍▍▍▍ 21   │
│ ○ Standings   │   2 Boundary   ▍ 1       4 Nomad     ▍▍ 3          │
│ ○ Arcade      │                                                     │
│ ○ Seal        │  24 of 27 answered                                  │
│ ○ Final       │                                                     │
│               │  [ Close early ]                  [ Reveal (space) ]│
│ ─────────     │                                                     │
│ PARTICIPANTS  ├─────────────────────────────────────────────────────┤
│ ● Priya   6420│  SCORES  Priya 100 · 92 · 88 = 280                  │
│ ● Kenji   5910│  G jumps to the grid · Tab along the row            │
│ ◐ Sam     4200│                                                     │
│ …             │  ┌──────────┐  phone preview                        │
└───────────────┴──┴──────────┴───────────────────────────────────────┘
```

**Rules for the console:**

- **There is one primary button.** It is always labelled with what it will do,
  always in the same place (bottom right of the live panel), and always bound
  to `space`.
  "Open question 7 of 20". "Reveal". "Start round 2: Unseal". The host should
  be able to run the whole session with the space bar and their eyes on the
  video call, like the existing board's `enter`.
- **Destructive or irreversible actions take two steps and are never on
  space.** These are seal, reveal, kick, and end activity. Publishing manual
  scores belonged on this list and is not on it, because Publish was never
  built (see below). The confirmation is inline, where the button turns into
  "Really seal? [Yes] [No]". It is never a modal, because a modal that takes
  focus during a live question makes the host press the wrong thing.
- **Refusals show inline, in the button.** If the server refuses a command, the
  button shows why for three seconds ("can't reveal — question still open")
  and then returns.
- **The console is dense and uses mono.** It is the one surface that may look
  like a terminal. Counts, timers, and points are in Plex Mono at 13–14 px,
  with tabular figures. The roster is one column in the 256px side nav and
  scrolls, and sixteen people fit at 1512 × 828 under the default runbook.
- **Connection state is a dot per person**, green, amber (away), or grey
  (gone), and a total in the status bar. Nothing else about the network is
  shown unless something is wrong.
- **The sealed state is hard to miss.** The status bar chip turns `--sealed`
  yellow with a lock and stays that way, so the host always knows whether the
  room can see the standings.
- **The tab title is `DO NOT SHARE · Quorum host`**, and the top bar repeats
  it. The host's screen-share picker shows tab titles, so this is a cheap
  protection against sharing the answers.
- **Phone preview** in the corner, live, 180 px wide. It answers "what does
  the room see right now" without the host switching tabs, which is the
  question the host asks most.

**Manual entry** is a grid: nickname, raw score field, computed points in the
next column updating as you type, and the top scorer's row highlighted so the
host sees it land on 100. A cell can be cleared back to `unset`; there is no
third state, and no per-cell toggle beyond that.

**Paste-mode and Publish are not built.** The design had a match list,
`"A. Okafor" → Ade Okafor (92%) [✓] [pick…]`, in front of a two-step Publish, so
a fuzzy-matched paste could be reviewed before it moved the standings. Neither
exists. Each field is its own command and takes effect as it is typed. See
[SPEC.md](SPEC.md#manual-entry-for-the-ttx-and-anything-off-platform) for what
that costs and why sealing first is the answer for now.

**Spot Awards have been removed.** This section described a small form as a
permanent row on the scoring panel, where the host picked a person, gave a
required reason, and granted the award, with a bench line beside it. Both are
removed, along with the `--spot` accent above.
[SCORING.md](SCORING.md#removed-spot-awards-and-bench-credit) records what they
were and the twelve sessions that decided it. The scoring panel is now the grid
and nothing else, which was the aim of the change.

## Desktop

A 1920 × 1080 tab, shared into a video call, seen as a tile of maybe
800 px on someone's laptop after two rounds of compression. Every rule below
is there so the Desktop stays readable after that.

- **Minimum type size 32 px at 1080p; display type 120–200 px.** The
  existing board's `clamp()` sizes are already about right; the floor is
  raised because the screen is never seen at native resolution.
- **Type is always light on dark.** Video codecs subsample chroma, so colour
  edges blur and luminance edges stay sharp. *Text* is therefore `--ink` or
  `--muted`, and colour is used for **fills and blocks**, such as answer bars,
  the arcade light, and the seal card. It is never used for small coloured text
  on black.
- **The Desktop shows few words**: the question, the answers, a count, and a
  timer. Notes appear on the reveal at 36 px or more, and the host reads them
  aloud as well.
- **A 5% safe margin** runs all round, because screen shares crop and video
  tiles letterbox.
- **Anything that appears stays for at least 4 seconds.** Video latency is
  one to two seconds, so something shown for two seconds may never reach the
  room.
- **Distributions are shown as bars.** The reveal shows four horizontal bars in
  the four hues with the count at the end. The bar is readable at any
  resolution, and the count helps anyone who can read it.
- **The timer is both a number and a shrinking bar.** The number is for people
  who can read it, and the bar is for people who cannot.

**Segments on the Desktop:**

| Segment | What it shows |
| --- | --- |
| Lobby | Title, join URL in mono at 48 px, QR code (at least 360 px, because a QR code that large still scans after compression), "27 joined" counting up, and a grid of nicknames as they arrive |
| Holding | The card, centred and large, and the connected dot. There is no countdown, because it is **not built**, for the reason under the phone's table |
| Trivia | Question in display type, answers as four tiles with shapes, the timer, and the answer count as a bar filling toward "27 of 27" |
| Trivia reveal | The correct tile stays lit and the others dim, then the distribution bars, the note, and the trivia top five |
| Standings | Top five, ranks, and totals, with each person's activity contributions as a stacked bar under their name in the activity hues. The live scoreboard already does this well, so keep its version |
| Sealed | The lock card, *Scores are hidden*, and one fixed line, *Revealed at the end.* The host-settable line described here was implemented by reading the holding card's second line, which belongs to that card and followed it onto this screen. A line the host can set needs a field of its own |
| Final | See below |
| Arcade | The arena (see the register below) |

**The final reveal** is the one place where the Desktop builds suspense. It
fills five slots from bottom to top, holding each for four seconds: 5th, 4th,
3rd, and 2nd. It then holds on an empty first slot for longer than is
comfortable, and then shows the winner in display type at 200 px with their
total and the activity bar. Nothing else animates, and each name arrives as a
hard cut with the `pop` easing. The host controls the pace with the space bar so they can
talk over it.

The phones count the same time. `finalRevealMs` in `client/shared/view.ts`
sets how long the reveal takes, and both surfaces read it from there. The phone
shows a card pointing at the shared screen until the Desktop would have reached
the winner. Each surface keeps its own pace, so they can drift apart slightly,
and that will stay true until the protocol carries each step.

## The arcade register

Hashi Arcade departs further from the house style than anything else, on
purpose. The brief is Squid Game staging, with the humour coming from taking
infrastructure tooling far too seriously. For the design, that means the same
tokens given new roles, a small set of motifs that people recognise from the
show, and copy that is deadpan about absurd things.

### Palette, recast

The four product hues take the roles of the show's cast. No new colours are
added, so the arcade still matches the other surfaces.

| Motif | Colour | Used for |
| --- | --- | --- |
| **Players** | `--nomad` green | Tracksuits: player number badges, "on the Floor" state, the PLAN light |
| **Staff** | `--consul` pink | The guards: round cards, the APPLY / STATE LOCKED light, the drained flash, elimination copy |
| **VIP Lounge** | `--vault` gold | Everything Lounge: the welcome card, backing chips, VIP points |
| **The House** | `--terraform` purple | The Front-End Man: announcer lines, the house as a Gganbu rival, the arcade's own top five |

Green for players and pink for staff is close enough to the show to be
recognised at once, and they are two of the hues the family already uses.

### Motifs

- **Shapes.** ○ △ □ in 2 px `--ink` strokes, Plex-weight, used as the staff
  mask on round cards, as the section marker on the Desktop, and as the
  shape picker in Unseal (with ☆ ☂ added). The card that explains them,
  *○ reads the plan · △ runs the apply · □ approves the PR*, appears once,
  before round 1.
- **Player numbers.** Three digits, Plex Mono 600, on a green badge with a
  1 px darker border, like a tracksuit patch. On the phone it is in the top
  left at all times during the arcade; on the Desktop it is how the grid
  is labelled.
- **The grid.** The Desktop's default arcade screen is the dormitory, a grid of
  every player number. A number is green when the player is on the Floor, gold
  when in the Lounge, and grey when away, with a thin pink strike when drained
  *this round*. Sixty people fit at 1080p at 96 px per cell. The grid is the
  arcade's scoreboard and roster, and shows how the round is going, so the host
  leaves it up between rounds.
- **The stairwell.** The show's pastel Escher staircase is the one decoration
  with no other job. It is a low-alpha (6%) geometric stair pattern in pink,
  mint, and gold, tiled behind the round cards only. It never appears behind
  gameplay or on the phone, because it would reduce contrast.
- **The light.** In Plan / Apply the Desktop *is* the light. It shows
  full-bleed green with `PLAN` in display type, then cuts to full-bleed pink
  with `APPLY IN PROGRESS — STATE LOCKED` in mono. The "doll turning" is a 400 ms
  wipe from green to pink across the screen, left to right, which is the one
  animation in the product that must not be a fade, because the wipe is the
  warning.
- **The runner ticker**, top right of the light: the five leading runners on
  the Floor as a player number, a small bar against the target, and the count,
  in mono at 34 px. It replaces the dormitory grid for the room during those 75
  seconds. The light covers the grid, and without the ticker the room would see
  only `PLAN`, `LOCKED`, and *N of M across* during the longest Floor round,
  none of which says who is on 90 and who is on 30. The ticker has no background
  of its own and sits clear of the centred sign and of the drain log at the
  bottom, because the wipe and the word tell players when to stop, and nothing
  may be laid over them. The ticker also drops a runner the moment they are
  drained. Their count froze when they were caught, and a frozen 90 at the top of
  a live list would wrongly suggest they are about to cross. The phone's Lounge
  card follows the same rule from the other side by using the past tense,
  *Drained at pane 3 of 3*, because it is drawn under a chip that stays. SPEC.md
  already treats the finish order here as public, and progress is the same
  information a few seconds earlier, since a runner on 119 has not crossed.
- **The Front-End Man.** All announcer copy is set in Plex Mono, purple,
  with a `>` prompt, on the Desktop and the phone, like a terminal
  speaking. The character has no face or figure, and the prompt stands in for
  both.

### Copy, and how it is said

The copy reads like a calm system message announcing something enormous. It
uses short sentences, never uses exclamation marks, and uses operational
vocabulary with a straight face. It never explains the joke.

Round cards, in order:

```
> The next game will begin shortly.
> Please remain seated. Please do not run terraform destroy.

> Game 1 — Plan / Apply
> Advance during PLAN. Do not touch your device during APPLY.
> The state lock is held by the doll.

> Game 2 — Unseal
> Choose a shape. You will be given a sealed tin.
> Reading the docs is permitted. It will cost you.

> Game 3 — Tug of Raft
> Two clusters. One rope. Tap on the heartbeat.
> Followers who miss three heartbeats will call an election.
> Elections achieve nothing.

> Game 4 — Gganbu
> You have been paired. You each hold ten tokens.
> Tokens expire at the end of the round. Wager accordingly.

> Game 5 — The Glass Bridge
> Twelve panes. Six are tempered. The tempered ones are real.
> Wave 1 goes first. Wave 1 has our sympathy.
```

The drained sequence on the phone is the moment players feel most, and it has
to finish in under two seconds:

```
[beat 1, 400 ms]  screen desaturates; pink strike across the player badge;
                  mono, pink:   Error: state lock held by another process
                                Player 017 drained.
[beat 2, 300 ms]  gold card slides up from the bottom, covering two thirds:
                  ▣  VIP LOUNGE
                  Your allocations have been rescheduled.
                  Back a player.                       [ list of the Floor ]
```

The second beat is bigger, brighter, and warmer than the first, on purpose.
Elimination shows 400 ms of pink, and the player then spends the rest of the
round in gold in the Lounge, so nobody's phone stays on the error.

These are the other lines the system needs, written once here so they stay
consistent:

| Moment | Line |
| --- | --- |
| Entering the arcade | `> Welcome. You have been recruited. You are Player 017.` |
| Recruitment, correct | `> Recruited.` |
| Plan / Apply, checkpoint | `> 30 resources applied. Progress banked.` |
| Plan / Apply, crossed | `> Apply complete. Resources: 120 added, 0 changed, 0 destroyed.` |
| Unseal, crack | `> The tin has cracked. Score halved. One more wrong letter shatters it.` |
| Unseal, shatter | `> The tin has shattered. Player 017 drained.` |
| Unseal, hint | `> Reading the docs. Score halved. Nobody will know.` |
| Tug of Raft, election | `> Heartbeat timeout. Node 017 called an election. Nothing happened.` |
| Gganbu, revoked | `> Token revoked. TTL exceeded. Player 017 drained.` |
| Glass Bridge, fall | `> Pane 4 was not tempered. Player 017 drained.` |
| Glass Bridge, crossed | `> Player 017 has reached the far side. It is not very interesting there.` |
| Backed player survives | `> Your player survived. The Lounge is pleased.` |
| Round end, everyone back | `> All nodes rescheduled. The next game will begin shortly.` |
| Arcade end | `> The games have concluded. Please return your tracksuit.` |

Lines refer to player numbers, never nicknames, when the news is bad. The
Desktop shows *Player 017 drained* over the grid; the nickname is on the
phone only, where the person it belongs to is the only reader.

### What the arcade does not do

The arcade uses no red, because the show's red is blood. Quorum uses `--miss`
coral instead, only in the 400 ms error beat and the trivia reveal. There are
no figures, silhouettes, guns, coffins, or gift boxes. There is no headline
count of "players remaining", because the grid already shows it and the
headline is always the next game. There is no sound by default, because the
room is on a video call and a second audio source competes with every
microphone. The host has an optional local heartbeat click for Tug of Raft and
nothing else.

No line anywhere names a specific person unless it gives their number or
something they did well. The Front-End Man describes what the system does, and
the host talks about the people.

## Phone-first arcade screens

Every round has a single interaction, and the phone shows only that:

| Round | The phone is… |
| --- | --- |
| Recruitment | Emoji at 96 px, one text field, and one button. The keyboard is up by default |
| Plan / Apply | One full-screen button, green with `+1 RESOURCE` and your count, or pink with `LOCKED` and nothing to tap. Haptic on the turn. A thin progress bar with three checkpoint ticks at the top. **The green button does not say `APPLY`**, because the pink sign reads APPLY IN PROGRESS, and one word cannot mean both "press me" and "do not press me" on a phone at arm's length under a timer |
| Unseal | Shape picker (four large tiles), then a grid of scrambled letters as tiles of at least 56 px, with the solved letters filling in a row above. **Read the docs** is a small mono link at the bottom, styled so it does not look like a button |
| Tug of Raft | A pulsing ring at 100 bpm, the whole lower half as the tap target, and a strip showing your side's colour and the rope position |
| Gganbu | Prompt in body type, `OVER` and `UNDER` as two tall tiles, a 1–5 wager stepper under them, and your rival's name and tokens as a mono line at the top |
| Glass Bridge | Two tall panes with the two names, `LEFT` and `RIGHT`, and a six-step track at the top showing where you are and which panes broke for earlier waves |
| Lounge | Gold. The list of the Floor as tappable chips with player number and nickname, and your backed player pinned at the top **with their progress under it**. Progress is resources against the target in Plan / Apply, or the pane they are standing on in the Bridge, and it changes to the past tense once they are drained, because the bet and the chip both stay. The Desktop's grid is mirrored small underneath so you can watch without looking up |

The Lounge screen is designed with more care than any Floor screen, because
by the end of the arcade more people will have spent time in it than in any
single game.
