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
  sendoff.json              the send-off's messages, and the photos it names
  photos/                   the photos, downscaled to about 1200px wide
  run-of-show.md            timings, who does what, what to say
  quorum-setup.md           the commands, run on the morning
  round-s.md                the round about one person, and where each fact came from
  roster.md
```

`promo-card.html`, `sendoff.json` and the photos are the files in here the
service *does* read, by being uploaded to it.

`promo-card.html` is one self-contained page, everything inline, at most
300,000 characters. The Desktop frames it beside the join link while the room
arrives. It is optional: an event without one stages exactly as it did before.
See [docs/event-config.md](../docs/event-config.md#the-promo-card), which is
also where the two things worth knowing before writing one are written down —
the frame runs no scripts and loads no webfonts, on purpose.

`sendoff.json` names the person, carries the messages, and lists the photos by
**filename**; staging uploads the JSON and then every photo it names, one
request each. Downscale them to about 1200px wide first — the ceiling is
300,000 bytes a photo, because each is one DynamoDB row and an item stops at
400KB. Also optional. See
[docs/event-config.md](../docs/event-config.md#the-send-off) for the format and
[docs/sendoff.md](../docs/sendoff.md) for what the segment is.

**The photos and the messages are the most personal thing in an event
directory.** They are other people's words about a colleague, and pictures of a
team. That is the sharpest case for why `config/events/` is gitignored, and the
reason nothing in this repository's tests or fixtures quotes any of it.

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
if there is one, uploads the send-off and its photos if there are those, stages
the console's holding cards and running order, prints the tokens. See [docs/event-config.md](../docs/event-config.md).

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

The send-off is two steps: the file, then one request per photo. The key in the
URL is the filename `sendoff.json` uses, percent-encoded — the `/` in
`photos/p19.jpg` is part of the key, not part of the path.

```bash
curl -s -X POST "$QUORUM_URL/api/sessions/$SID/content/sendoff" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: application/json' \
  --data-binary @config/events/<event>/sendoff.json

curl -s -X POST "$QUORUM_URL/api/sessions/$SID/assets/photos%2Fp19.jpg" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: image/jpeg' \
  --data-binary @config/events/<event>/photos/p19.jpg
```

Same rule: when staging warns that three photos did not upload, re-upload those
three. Do not re-run `make stage`.
