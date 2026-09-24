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

## Where the real one actually lives

`trivia-questions.json` here is a **symlink** into the private `team-building`
repository, which is where an event's set is written and versioned:

```
config/trivia-questions.json -> ../../team-building/config/trivia-questions.json
```

That repo sits next to this one. A copy would have been simpler and worse: it
would be a second truth that nothing versions and nothing backs up, and the one
question you cannot answer at 1:55pm is which of two files is the current one.

If the symlink dangles — team-building not cloned, or cloned somewhere else —
the upload fails with a missing file, which is the right way to find out. Fix
it by cloning team-building alongside this repo, or by pointing the link at
wherever the set lives.

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
