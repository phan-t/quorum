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
  run-of-show.md            timings, who does what, what to say
  quorum-setup.md           the commands, run on the morning
  round-s.md                the round about one person, and where each fact came from
  roster.md
```

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

One command: creates the session, loads the questions, stages the console's
holding cards and running order, prints the tokens. See
[docs/event-config.md](../docs/event-config.md).

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
