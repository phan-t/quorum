# Questions and events

| | |
| --- | --- |
| `event.example/` | **Committed.** A whole event directory, invented end to end, including the twenty-four HashiCorp and IBM questions the test suite loads, and the four tiebreakers that follow them, so the build fails if that set stops being valid. Copy it to start a real one. See [its README](event.example/README.md). |
| `events/<date>-<name>/` | **Gitignored.** One directory per event: its question set, its run of show, its roster, and whatever else that event needs. |

## Why the events are not in git

This repository is public, and an event's material is content about the people
in the room. A Round S is a handful of questions about one colleague, drawn
from things that colleague told their team. Somebody agreeing to be the
subject of a quiz in a room of people they know is not the same as agreeing to
a public repository that is indexed, forkable, and keeps the file in its
history after a delete. The send-off carries other people's words about them,
which is not the author's to publish either.

So the repository ships the invented example, and real events stay on the host's machine.

## An event directory

```
config/events/2026-03-12-example-offsite/
  session.json              the title, what the event scores, the console's setup
  additional-trivia-questions.json   extra questions, shuffled in with 20 drawn from the shared bank
  arcade-content.json       the arcade rounds' content, if this event stages any
  promo-card.html           the poster the Desktop shows in the lobby, if there is one
  sendoff.json              the send-off's messages, and the photos it names
  photos/                   the photos, downscaled to about 1200px wide by you —
                            staging uploads them as it finds them
  run-of-show.md            timings, who does what, what to say
  quorum-setup.md           the commands, run on the morning
  round-s.md                the round about one person, and where each fact came from
  roster.md
```

`session.json`, `additional-trivia-questions.json`, `arcade-content.json`,
`promo-card.html`, `sendoff.json`, and the photos are the files in here that
the service *does* read, once they are staged or uploaded to it.

`session.json` is what `make stage` reads. Besides the title and the console's
setup, it carries `activities`, the list of things this event scores. Each one
gets a leaderboard column and a term in the tiebreak. Leave it out and the
session gets the default set of trivia and the arcade. Write it to score
something else, including a `manual` activity for one judged off-platform. The
server validates the list when the session is created and refuses the whole
thing with an error per entry, because a session's activities cannot be changed
afterwards. See
[docs/event-config.md](../docs/event-config.md#what-the-session-scores).

`promo-card.html` is one self-contained page, everything inline, at most
300,000 characters. The Desktop frames it beside the join link while the room
arrives. It is optional: an event without one stages exactly as it did before.
See [docs/event-config.md](../docs/event-config.md#the-promo-card), which also
explains the two limits to know before writing one: the frame deliberately runs
no scripts and loads no webfonts.

`arcade-content.json` carries the arcade rounds' content for this event:
Recruitment's emoji items, Unseal's tins, Gganbu's Over/Under prompts, and the
Glass Bridge's pairs, under one optional key each. **A round whose key is left
out plays the set compiled into the build**, so an event with no such
file plays exactly what the release shipped, and a file carrying only `gganbu`
changes only Gganbu. A second upload merges key by key instead of replacing the
file. The file is optional. See
[docs/event-config.md](../docs/event-config.md#the-arcades-content) for the
format, and for why this is a staged file instead of a console screen. Each of
those four sets carries its own answers, so the file goes from the host's
machine to the server over HTTPS under the host token and never enters a
browser.

`sendoff.json` names the person, carries the messages, and lists the photos by
**filename**; staging uploads the JSON and then every photo it names, one
request each. Downscale them to about 1200px wide first, because the ceiling is
300,000 bytes a photo: each is one DynamoDB row, and an item stops at
400KB. The file is optional. See
[docs/event-config.md](../docs/event-config.md#the-send-off) for the format and
[docs/sendoff.md](../docs/sendoff.md) for what the segment is.

**The photos and the messages are the most personal thing in an event
directory.** They are other people's words about a colleague, and pictures of a
team. They are the main reason `config/events/` is gitignored, and the
reason nothing in this repository's tests or fixtures quotes any of it.

**The running service never reads this directory; `make stage` does.** Staging
runs on the host's machine, reads the files above, and pushes them to the
service over HTTPS. The service takes its content over the network and does not
know `config/` exists, and the files still live next to the service they are
about instead of in a second repository that has to be kept in step.

So a file changed here changes nothing
until somebody stages it, and a session already running is unaffected by an edit
to the file it was staged from.

Starting an event is a copy of the example:

```bash
cp -r config/event.example config/events/2026-03-12-example-offsite
make stage EVENT=2026-03-12-example-offsite
```

`event.example/` is committed and `events/` is not, which is why the example
is a separate directory instead of one event among the real ones. Re-including
a path inside an ignored directory means ignoring the directory's *contents*
instead of the directory itself, and that change would later leak any event
whose name somebody forgot to exclude.

## It is not backed up

`config/events/` is ignored by git, which means it is in no repository, on no
remote, and in no backup. It exists in this working directory and nowhere else.
If the laptop is lost, the event directory is lost with it.

That risk is accepted to keep real people out of a public repository. Copy an
event directory somewhere else before the morning of the event.

An event whose questions came from the activity library that preceded this
service may also be recoverable from that library's own archive, which lives
outside this repository. Where that archive is, and which commit holds a
given set, is not written down here, because a public file that tells anyone how to
reconstruct an event's real questions would defeat the gitignore.

## Staging

```bash
make stage EVENT=2026-03-12-example-offsite
```

This one command creates the session, loads the questions, stages the arcade's
content if there is any, uploads the promo card if there is one, uploads the
send-off and its photos if there are those, stages the console's holding cards
and running order, and prints the tokens. See [docs/event-config.md](../docs/event-config.md).

## Uploading one thing by hand

```bash
curl -s -X POST "$QUORUM_URL/api/sessions/$SID/content/trivia" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: application/json' \
  --data-binary @config/event.example/trivia-questions.json
```

By hand, the file goes up exactly as it is: the whole bank, in its own order,
with no draw and no extras. Only staging draws questions from the bank.

The format is in [SPEC.md](../SPEC.md#question-file) and the question bank is
in [docs/question-bank.md](../docs/question-bank.md). Two rules catch most
mistakes: name the correct answer by its **letter**, and use only keys the importer knows,
because any other key is an error. A misspelled `timelimitSec` is refused
instead of silently defaulted.

The arcade's content goes up the same way, and its importer answers with a line
per problem too:

```bash
curl -s -X POST "$QUORUM_URL/api/sessions/$SID/content/arcade" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: application/json' \
  --data-binary @config/events/<event>/arcade-content.json
```

The file has four optional keys, `recruitment`, `unseal`, `glassBridge`, and
`gganbu`, and a round whose key is absent plays the content compiled into the build. A second
upload merges key by key, so this is also the command for correcting one round
without re-sending the others. The format is in
[docs/event-config.md](../docs/event-config.md#the-arcades-content).

The promo card goes up the same way, as `text/html`:

```bash
curl -s -X POST "$QUORUM_URL/api/sessions/$SID/content/promo" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: text/html' \
  --data-binary @config/events/<event>/promo-card.html
```

This is the command to reach for when staging warns that the card did not go
up. Do not re-run `make stage`, because that creates a second session.

The send-off is two steps: the file, then one request per photo. The key in the
URL is the filename `sendoff.json` uses, percent-encoded, because the `/` in
`photos/p19.jpg` is part of the key and must not be read as part of the path.

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
