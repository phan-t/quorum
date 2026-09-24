# Questions and events

| | |
| --- | --- |
| `trivia-questions.example.json` | **Committed.** The twenty HashiCorp and IBM questions: the format's worked example, and what the test suite loads — so if it stops being valid, the build says so. |
| `events/<date>-<name>/` | **Gitignored.** One directory per event: its question set, its run of show, its roster, whatever else that event needs. |

## Why the events are not in git

This repository is public, and an event's material is content about the people
in the room. The September 2026 huddle closes on five questions about a
colleague who was leaving, naming his previous employer, a role he used to hold
and what he spent on a home lab. He agreed to five quiz questions read to his
own team. He did not agree to a public repository that is indexed, forkable,
and keeps the file in its history after a delete.

So the example is the thing that ships, and the events stay on the machine.

## An event directory

```
config/events/2026-09-25-sa-apj-huddle/
  trivia-questions.json     the set uploaded to the session
  promo-card.html           the poster the Desktop shows in the lobby, if there is one
  run-of-show.md            timings, who does what, what to say
  quorum-setup.md           the commands, run on the morning
  round-s.md                the round about one person, and where each fact came from
  roster.md
```

`promo-card.html` is the one file in here the service *does* read, by being
uploaded to it — one self-contained page, everything inline, at most 300,000
characters. The Desktop frames it beside the join link while the room arrives.
It is optional: an event without one stages exactly as it did before. See
[docs/event-config.md](../docs/event-config.md#the-promo-card), which is also
where the two things worth knowing before writing one are written down — the
frame runs no scripts and loads no webfonts, on purpose.

Nothing reads this directory. The service takes its questions over HTTP, not
from disk — these files are what a *host* opens, kept next to the service they
are about rather than in a second repository that then has to be kept in step.
Starting an event is `mkdir` and a copy of the example.

## It is not backed up

`config/events/` is ignored by git, which means it is in no repository, on no
remote, and in no backup. It exists in this working directory and nowhere else.
Losing the laptop loses it.

That is the accepted trade for keeping real people out of a public repository,
but it is worth knowing before the morning of an event rather than during one.
Copy an event directory somewhere before you rely on it.

The 25 September 2026 set is also recoverable from the archive of the activity
library it came from, which sits outside this repository:

```bash
git clone ~/Developer/HashiCorp/team-building-archive.bundle /tmp/tb
git -C /tmp/tb show 3fa324e:config/trivia-questions.json
```

## Staging

```bash
make stage EVENT=2026-09-25-sa-apj-huddle
```

One command: creates the session, loads the questions, uploads the promo card
if there is one, stages the console's holding cards and running order, prints
the tokens. See [docs/event-config.md](../docs/event-config.md).

## Uploading one thing by hand

```bash
curl -s -X POST "$QUORUM_URL/api/sessions/$SID/content/trivia" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: application/json' \
  --data-binary @config/events/<event>/trivia-questions.json
```

The format is in [SPEC.md](../SPEC.md#question-file) and the question bank is
in [docs/question-bank.md](../docs/question-bank.md). The short version: name
the correct answer by its **letter**, and every key is either one the importer
knows or an error — a misspelled `timelimitSec` is refused rather than silently
defaulted.

The promo card goes up the same way, as `text/html`:

```bash
curl -s -X POST "$QUORUM_URL/api/sessions/$SID/content/promo" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: text/html' \
  --data-binary @config/events/<event>/promo-card.html
```

This is the command to reach for when staging warns that the card did not go
up. Re-running `make stage` is not — that creates a second session.
