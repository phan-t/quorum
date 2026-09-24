# Staging an event

An event is a directory. Staging it is one command, run from a terminal before
the room arrives.

```bash
awscreds
make stage EVENT=2026-09-25-sa-apj-huddle
```

That creates the session, loads its questions, puts up the promo card if the
event has one, stages the console's setup onto it, and prints the four things
there is no endpoint to return. Nothing else has to happen before 2:00pm.

---

## The directory

```
config/events/2026-09-25-sa-apj-huddle/
  session.json            title, and the console's setup
  trivia-questions.json   the question set
  promo-card.html         optional: the poster shown in the Desktop's lobby
  run-of-show.md          for the host to read; nothing parses it
  roster.md
```

The whole of `config/events/` is gitignored, because an event's material is
content about the people in the room and this repository is public. See
[`config/README.md`](../config/README.md).

### `session.json`

```json
{
  "title": "SA APJ Team Huddle",
  "questions": "trivia-questions.json",
  "promo": "promo-card.html",
  "console": {
    "cards": { "cards": [{ "id": "card-1", "title": "…", "line": "…" }] },
    "runbook": [{ "kind": "holding", "included": true, "id": "holding", "card": "card-1" }],
    "arcade": { "plan": ["recruitment", "plan_apply", "glass_bridge"], "timings": {} }
  }
}
```

`title`, `questions` and `promo` are the server's. Everything under `console`
is the console's, and the server never looks inside it.

`promo` can be left out — it defaults to `promo-card.html`, and an event with
no such file stages exactly as it did before promo cards existed. Set it to
`false` to skip the upload for an event that has the file but does not want it.

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

`session.json` covers the title, the questions, the promo card and the
console's setup. It does
not yet carry the practice flag, per-question timer overrides, or the arcade's
timings as anything but the console's own `timings` object. Those are all
server-side or engine-side state and each needs its own decision about whether
staging should set it or the host should. Add them one at a time, and keep the
rule that the server does not parse the console's half.
