# Questions

Two files, and only one of them is in git.

| | |
| --- | --- |
| `trivia-questions.example.json` | Committed. The twenty HashiCorp and IBM questions. The format's worked example, and what the test suite loads — so if it stops being valid, the build says so. |
| `trivia-questions.json` | **Gitignored.** The set actually uploaded at an event. Treated like `.env`. |

## Why the real one is not in git

This repository is public. An event's question set is content about the people
in the room: the huddle it was built for closes on five questions about a
colleague who is leaving, naming his previous employer, a role he used to hold
and what he spent on a home lab. Those are his details, and he agreed to five
quiz questions read to his own team — not to a public repository that is
indexed, forkable, and keeps the file in its history after a delete.

So the example is the one that ships, and the real set stays private.

## It is not backed up

`trivia-questions.json` is an ordinary file here, ignored by git. That means it
is in no repository, on no remote, and in no backup — it exists in this working
directory and nowhere else. Losing the laptop loses the set.

That is the accepted trade for keeping real people out of a public repository,
but it is worth knowing before the morning of an event rather than during one.
Copy the file somewhere before you rely on it.

The set that ran the 25 September 2026 huddle is recoverable from the archive
of the activity library, taken before that repository was deleted:

```bash
git clone ../private/team-building-archive.bundle /tmp/tb
git -C /tmp/tb show 3fa324e:config/trivia-questions.json > config/trivia-questions.json
```

That bundle is itself in `private/`, so it is not backed up either. It is one
1.5 MB file and the point of it is to be copied somewhere else. `private/`
carries its own README saying so; if you are reading this from a clone and
there is no `private/` directory, that is working as intended — it holds
material about real people and never leaves the machine it was made on.

## Using it

```bash
curl -s -X POST "$URL/api/sessions/$SID/content/trivia" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: application/json' \
  --data-binary @config/trivia-questions.json
```

The format is in [SPEC.md](../SPEC.md#question-file). The short version: name
the correct answer by its **letter**, and every key is either one the importer
knows or an error — a misspelled `timelimitSec` is refused rather than
silently defaulted.
