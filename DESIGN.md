# Quorum — design direction

What the three surfaces look like, how they move, and how the arcade gets to
be its own thing without leaving the family. The rules here are the ones the
existing artifacts already follow; the additions are the phone, the console,
and the Squid Game register.

## The family

Everything in this repo already shares a look: IBM Plex on near-black,
HashiCorp product hues as accents, mono for anything that is a label or a
number. Quorum keeps it, because the big screen, the console and the phone
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

  /* activity accents — fixed per activity across every surface */
  --ttx: var(--terraform);  --trivia: var(--consul);  --arcade: var(--nomad);  --spot: var(--vault);
}
```

The activity accents are the same assignment the live scoreboard already
uses. Once a participant learns that pink is trivia, pink is trivia on the
phone, on the screen and in the console.

**Dark only.** The existing pages declare `color-scheme: dark` and Quorum
does the same, deliberately. A light phone next to a dark big screen in a
video call looks like two products; and the big screen is dark because
compressed video makes dark backgrounds with light type legible and the
reverse muddy.

### Type

| Role | Face | Where |
| --- | --- | --- |
| Display | IBM Plex Sans Condensed 700, tight leading (0.94), `-0.02em` | Questions on the big screen, round names, the winner |
| Body | IBM Plex Sans 400/600 | Answers, copy, the holding line |
| Label | IBM Plex Mono 400/600, `0.16–0.22em` tracking, uppercase | Eyebrows, kickers, player numbers, timers, counts, everything tabular |

Numbers are always Plex Mono with `font-variant-numeric: tabular-nums` so a
timer does not jitter and a points column lines up.

### Motion

One easing for reveals, `cubic-bezier(.2,.9,.3,1.2)` at 300 ms — the `pop`
the arcade board already has. Timers do not animate; they tick. Anything
that moves respects `prefers-reduced-motion` by not moving.

The big screen has a stricter rule: no motion that depends on frame rate.
Video compression turns a smooth 60 fps slide into a smear at 15 fps. Things
appear, hold, and change; they do not glide.

### Accessibility, once

Text contrast ≥ 4.5:1 against its background (the muted grey `#8B8A9C` on
`#0A0A0F` clears it; `--dim` does not and is only for decoration). Every
answer has a shape as well as a colour. Touch targets ≥ 56 px on the phone.
Focus is visible on the console. Nothing is conveyed by colour alone,
including "drained".

## Participant — phone first

The participant page is designed at 360 × 740 and grows from there. It is
used with one thumb, on a video call, often with the video app taking half
the screen. That sets the rules:

**No scrolling during play.** Every segment fits the viewport. If a trivia
question and its four answers cannot fit, the question shrinks first, the
answers never. Answer buttons are a 2 × 2 grid taking the bottom 55% of the
screen, each ≥ 56 px tall, each with a shape glyph (▲ ◆ ● ■) in the corner
and one of the four product hues as a *fill*. Kahoot's shape-plus-colour
pattern is the right one and there is no reason to be different from it.

The ink on those fills is **not** uniformly white. This document earlier sets a
floor of 4.5:1 for text contrast, and white fails it on three of the four
product hues — white on `--nomad` measures 1.96:1. So the tile takes light ink
only on `--terraform` and dark ink on the other three,
via `--on-fill-light` / `--on-fill-dark`. Those two tokens deliberately do not
swap between light and dark themes: the hue underneath them does not move, so
ink that followed `--ink`/`--ground` would become unreadable in one theme. A
readable tile beats a consistent-looking rule, and the shape glyph carries the
identity anyway — nothing here is distinguished by colour alone.

Measured from computed styles in the browser, not from the stylesheet:
terraform with light ink 5.76:1, consul 4.93:1, nomad 9.25:1, vault 13.36:1.
Consul's margin is thin; anything that darkens that hue needs re-measuring.

**The primary action is at the bottom.** Thumb reach. Tap targets in the top
third of a phone screen are for things you do once (the join button), not
things you do under a timer.

**A points strip sits at the bottom edge**, mono, small: `YOU 143 · TRIVIA 80
· ARCADE 63`. It is the only persistent chrome. While sealed it keeps its
place — a strip that vanishes reads as a bug — but it loses every number and
shows only the lock and *points sealed*. It must not freeze and keep showing
the last figures: SCORING.md seals a participant's own total too, and a
frozen strip leaks precisely what the seal exists to hide. Nothing is
cached; the numbers come back at reveal.

**Reconnect is a banner, not a modal.** A thin amber strip under the top
edge: *reconnecting…*. It goes away by itself. The page beneath it keeps
showing the last state so the person is never looking at a blank screen.

**Segments on the phone:**

| Segment | What it shows |
| --- | --- |
| Join | Code field (skipped via link), then nickname — or the roster chips, big, one tap |
| Lobby | Session title in display type, "you're in" with the nickname, a live count of who is here, and the prize line the host typed |
| Holding | Title, one line, optional countdown, points strip. Nothing to tap. The connected dot pulses slowly |
| Trivia — open | Question at the top (body, ≤ 3 lines), timer as a bar and a number, four answer tiles |
| Trivia — locked | The tile you chose, outlined, the other three dimmed. "Locked in." No colour change, no tick, until the reveal |
| Trivia — reveal | Correct tile fills in `--hit`; yours if wrong outlines in `--miss`; your points for the question count up in mono; the note; then the trivia top five |
| Standings | Top five, ranks 1–5 in mono, names in condensed display, totals right-aligned. Or the sealed card |
| Final | The reveal, mirrored from the big screen at phone scale |

The phone shows the question text because the participant may not be able
to read the big screen; see the spec. It does not show the answer
distribution, which is a big-screen thing — the phone is for *your* answer.

## Host console

Laptop, landscape, one person driving under time pressure with thirty people
waiting. The design goal is **glanceable**: the host looks at it for two
seconds between sentences and knows what is happening and what to press.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ⚠ DO NOT SHARE   SA APJ Quorum · RAFT · 27 on · 2 away   ● LIVE     │  status bar (top)
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
│ ● Priya   6420│  SPOT AWARDS  trivia 2 left   [ + award ]           │
│ ● Kenji   5910│  BENCH  Ade (TTX) · Grace (joined late, trivia)│
│ ◐ Sam     4200│                                                     │
│ …             │  ┌──────────┐  phone preview                        │
└───────────────┴──┴──────────┴───────────────────────────────────────┘
```

**Rules for the console:**

- **One primary button, always labelled with what it will do**, always in
  the same place (bottom right of the live panel), always bound to `space`.
  "Open question 7 of 20". "Reveal". "Start round 2: Unseal". The host should
  be able to run the whole session with the space bar and their eyes on the
  video call, like the existing board's `enter`.
- **Destructive or irreversible actions are two-step and never on space.**
  Seal, reveal, publish manual scores, kick, end activity. The confirm is
  inline — the button turns into "Really seal? [Yes] [No]" — never a modal,
  because a modal that steals focus during a live question is how a host
  presses the wrong thing.
- **Refusals are inline, in the button.** If the server refuses a command the
  button shows why for three seconds ("can't reveal — question still open")
  and returns.
- **Dense and mono.** The console is the one surface that may look like a
  terminal. Counts, timers and points in Plex Mono, 13–14 px, tabular.
  Sixty participants fit in the left rail without scrolling at 1440 px.
- **Connection state is a dot per person**, green / amber (away) / grey
  (gone), and a total in the status bar. Nothing else about the network is
  shown unless it is wrong.
- **Sealed is loud.** The status bar chip goes `--sealed` yellow with a lock
  and stays there. The host must never wonder whether the room can see the
  standings.
- **The tab title is `DO NOT SHARE · Quorum host`** and the top bar repeats
  it. The host's screen-share picker shows tab titles; this is the cheapest
  possible protection against sharing the answers.
- **Phone preview** in the corner, live, 180 px wide. It answers "what does
  the room see right now" without the host switching tabs, which is the
  question the host asks most.

**Manual entry** is a grid: nickname, raw score field, bench toggle, computed
points in the next column updating as you type, and the top scorer's row
highlighted so the host sees it land on 100. Paste-mode shows a match list:
`"A. Okafor" → Ade Okafor (92%) [✓] [pick…]`. Publish is two-step.

**Spot Award** is a small form: pick a person (typeahead, mono, like the
existing award box), a required reason, grant. Participants on bench for
that activity are not in the list.

## Big screen

A 1920 × 1080 tab, shared into a video call, seen as a tile of maybe
800 px on someone's laptop after two rounds of compression. The whole design
is about surviving that.

- **Minimum type size 32 px at 1080p; display type 120–200 px.** The
  existing board's `clamp()` sizes are already about right; the floor is
  raised because the screen is never seen at native resolution.
- **Light type on dark, always.** Video codecs subsample chroma: colour
  edges blur, luminance edges survive. So *text* is `--ink` or `--muted`, and
  colour is used for **fills and blocks** — answer bars, the arcade light,
  the seal card — never for small coloured text on black.
- **Few words.** The question, the answers, a count, a timer. Notes appear on
  the reveal in ≥ 36 px and the host reads them aloud anyway.
- **5% safe margin** all round. Screen shares crop and video tiles letterbox.
- **A 4-second dwell minimum** on anything that appears. Video latency is
  one to two seconds; a thing that shows for two seconds was never seen.
- **Bars, not numbers, for distributions.** The reveal shows four horizontal
  bars in the four hues with the count at the end; the bar is readable at
  any resolution, the number is a bonus.
- **The timer is a number and a shrinking bar**, both. The number for people
  who can read it, the bar for people who cannot.

**Segments on the big screen:**

| Segment | What it shows |
| --- | --- |
| Lobby | Title, join URL in mono at 48 px, QR code (≥ 360 px — QR codes survive compression surprisingly well if large), "27 joined" ticking up, a grid of nicknames as they arrive |
| Holding | The card, centred, huge. Countdown if set. The connected dot |
| Trivia | Question in display type; answers as four tiles with shapes; timer; answer count as a bar filling toward "27 of 27" |
| Trivia reveal | Correct tile stays lit, others dim; distribution bars; the note; then the trivia top five |
| Standings | Top five, ranks and totals, activity contributions as a stacked bar under each name in the activity hues — the live scoreboard already does this well; keep it |
| Sealed | The lock card: *Standings are sealed*, and a line the host can set ("Revealed at 3:33") |
| Final | See below |
| Arcade | The arena — see the register below |

**The final reveal** is the one place the big screen gets to be theatrical.
Five slots, bottom to top, each held for four seconds: 5th, 4th, 3rd, 2nd —
then a hold on an empty first slot for longer than is comfortable — then the
winner in display type at 200 px with their total and the activity bar.
Spot Award toasts that landed during the sealed period replay as a scroll
above it. Nothing else animates; the arrival of each name is a hard cut with
the `pop` easing. The host controls the pace with the space bar so they can
talk over it.

## The arcade register

Hashi Arcade gets to leave the house style further than anything else, and
it should. The brief is Squid Game staging with the humour coming from
taking infrastructure tooling far too seriously. Design-wise that means: the
same tokens, recast; a small set of very recognisable motifs; and copy that
is deadpan about absurd things.

### Palette, recast

The four product hues become the show's cast. No new colours are added; the
family holds.

| Motif | Colour | Used for |
| --- | --- | --- |
| **Players** | `--nomad` green | Tracksuits: player number badges, "on the Floor" state, the PLAN light |
| **Staff** | `--consul` pink | The guards: round cards, the APPLY / STATE LOCKED light, the drained flash, elimination copy |
| **VIP Lounge** | `--vault` gold | Everything Lounge: the welcome card, backing chips, VIP points |
| **The House** | `--terraform` purple | The Front-End Man: announcer lines, the house as a Gganbu rival, the arcade's own top five |

Green for players and pink for staff is close enough to the show to read
instantly and exactly the two hues the family already owns, which is the
lucky part of this whole exercise.

### Motifs

- **Shapes.** ○ △ □ in 2 px `--ink` strokes, Plex-weight, used as the staff
  mask on round cards, as the section marker on the big screen, and as the
  shape picker in Unseal (with ☆ ☂ added). The card that explains them —
  *○ reads the plan · △ runs the apply · □ approves the PR* — appears once,
  before round 1.
- **Player numbers.** Three digits, Plex Mono 600, on a green badge with a
  1 px darker border, like a tracksuit patch. On the phone it is in the top
  left at all times during the arcade; on the big screen it is how the grid
  is labelled.
- **The grid.** The dormitory: the big screen's arcade default is a grid of
  every player number, green when on the Floor, gold when in the Lounge,
  grey when away, with a thin pink strike when drained *this round*. Sixty
  people fit at 1080p at 96 px per cell. It is the arcade's scoreboard,
  roster and mood in one, and the host leaves it up between rounds.
- **The stairwell.** The show's pastel Escher staircase is the one
  indulgence: a low-alpha (6%) geometric stair pattern in pink, mint and
  gold, tiled behind the round cards only. Never behind gameplay, never on the
  phone — it would eat contrast.
- **The light.** In Plan / Apply the big screen *is* the light: full-bleed
  green with `PLAN` in display type, cutting to full-bleed pink with
  `APPLY IN PROGRESS — STATE LOCKED` in mono. The "doll turning" is a 400 ms
  wipe from green to pink across the screen, left to right, which is the one
  animation in the product that must not be a fade, because the wipe is the
  warning.
- **The Front-End Man.** All announcer copy is set in Plex Mono, purple,
  with a `>` prompt, on the big screen and the phone, like a terminal
  speaking. No face, no figure. The prompt is the character.

### Copy, and how it is said

The tone is a calm system message announcing something enormous. Short
sentences. No exclamation marks, ever. Operational vocabulary used
completely straight. The joke is never explained.

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
> Eighteen panes. Nine are tempered. The tempered ones are real.
> Wave 1 goes first. Wave 1 has our sympathy.
```

The drained sequence on the phone, which is the emotional core and has to
land in under two seconds:

```
[beat 1, 400 ms]  screen desaturates; pink strike across the player badge;
                  mono, pink:   Error: state lock held by another process
                                Player 017 drained.
[beat 2, 300 ms]  gold card slides up from the bottom, covering two thirds:
                  ▣  VIP LOUNGE
                  Your allocations have been rescheduled.
                  Back a player.                       [ list of the Floor ]
```

The whole point is that the second beat is bigger, brighter and warmer than
the first. Elimination is 400 ms of pink; promotion is the rest of the
round in gold. Nobody's phone stays on the error.

Other lines the system needs, so they are written once and consistently:

| Moment | Line |
| --- | --- |
| Entering the arcade | `> Welcome. You have been recruited. You are Player 017.` |
| Recruitment, correct | `> Recruited.` |
| Plan / Apply, checkpoint | `> 30 resources applied. Progress banked.` |
| Plan / Apply, crossed | `> Apply complete. Resources: 120 added, 0 changed, 0 destroyed.` |
| Unseal, crack | `> The tin has cracked. Player 017 drained.` |
| Unseal, hint | `> Reading the docs. Score halved. Nobody will know.` |
| Tug of Raft, election | `> Heartbeat timeout. Node 017 called an election. Nothing happened.` |
| Gganbu, revoked | `> Token revoked. TTL exceeded. Player 017 drained.` |
| Glass Bridge, fall | `> Pane 4 was not tempered. Player 017 drained.` |
| Glass Bridge, crossed | `> Player 017 has reached the far side. It is not very interesting there.` |
| Backed player survives | `> Your player survived. The Lounge is pleased.` |
| Round end, everyone back | `> All nodes rescheduled. The next game will begin shortly.` |
| Arcade end | `> The games have concluded. Please return your tracksuit.` |

Lines refer to player numbers, never nicknames, when the news is bad. The
big screen shows *Player 017 drained* over the grid; the nickname is on the
phone only, where the person it belongs to is the only reader.

### What the arcade does not do

No red. The show's red is blood; ours is `--miss` coral, used only in the
400 ms error beat and the trivia reveal. No figures, silhouettes, guns,
coffins, gift boxes. No countdown of "players remaining" as a headline — the
grid shows it, quietly, and the headline is always the next game. No sound
by default: the room is on a video call and a second audio source fights
every microphone; the host has an optional local heartbeat click for Tug of
Raft and nothing else.

And no line, anywhere, about a specific person that is not either their
number or something they did well. The Front-End Man narrates the system.
The host narrates the people.

## Phone-first arcade screens

Every round has a single interaction and the phone shows only that:

| Round | The phone is… |
| --- | --- |
| Recruitment | Emoji at 96 px, one text field, one button. Keyboard up by default |
| Plan / Apply | One full-screen button. Green with `APPLY` and your count; pink with `LOCKED` and nothing to tap. Haptic on the turn. A thin progress bar with three checkpoint ticks at the top |
| Unseal | Shape picker (four large tiles), then a grid of scrambled letters as ≥ 56 px tiles, the solved letters filling in a row above. **Read the docs** is a small mono link, deliberately un-button-like, at the bottom |
| Tug of Raft | A pulsing ring at 100 bpm, the whole lower half is the tap target, a strip showing your side's colour and the rope position |
| Gganbu | Prompt in body type, `OVER` / `UNDER` as two tall tiles, a 1–5 wager stepper under them, your rival's name and tokens as a mono line at the top |
| Glass Bridge | Two tall panes with the two names, `LEFT` / `RIGHT`; a six-step track at the top showing where you are and which panes broke for earlier waves |
| Lounge | Gold. The list of the Floor as tappable chips with player number and nickname, your backed player pinned at the top, and the big screen's grid mirrored small underneath so you can watch without looking up |

The Lounge screen is designed with more care than any Floor screen, because
by the end of the arcade more people will have spent time in it than in any
single game.
