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

For the 25 September 2026 huddle the last committed copy is in the private
team-building repository's history, before it was removed on 24 Sep 2026:

```bash
cd ~/Developer/HashiCorp/team-building
git show 3fa324e:config/trivia-questions.json > ~/Developer/HashiCorp/quorum/config/trivia-questions.json
```

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
