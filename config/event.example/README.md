# Example event

A complete event directory, invented from end to end. Copy it to start a real
one:

```bash
cp -r config/event.example config/events/2026-03-12-example-offsite
make stage EVENT=2026-03-12-example-offsite
```

`config/events/` is gitignored; this directory is not. That is the whole
reason it exists. Everything here is made up — the offsite, Alex Rivera, the
three people who wrote the send-off messages — so that the format has a worked
example in the repository without any real person's words being in it. See
[../README.md](../README.md) for why events are not committed.

## What each file shows

| File | What it demonstrates |
| --- | --- |
| `session.json` | The title and subtitle, a third `manual` activity for something scored off-platform, and the console's runbook and arcade plan |
| `trivia-questions.json` | Twenty-four scored HashiCorp and IBM questions plus four flagged `tiebreak`, and what the test suite loads. The optional keys are documented in [SPEC.md](../../SPEC.md#question-file); this set uses `round`, `note` and `tiebreak`, and deliberately not `basePoints`, so every question is worth the same before speed weighting |
| `sendoff.json` | A send-off with messages and no photos, which is legal and is still the thing. One message is long enough to be split across slides |
| `promo-card.html` | A self-contained poster, no scripts and no webfonts |

## What is not here

**`photos/`.** The send-off names no photos, so staging this directory works
without any. A real event puts them in `photos/`, downscaled to about 1200px
wide, and lists them by filename in `sendoff.json`. The ceiling is 300,000
bytes per photo, because each one is a DynamoDB row and an item stops at 400KB.

**`roster.md` and a per-person round.** Both are content about real people and
neither belongs in a public repository, which is the point of the gitignore.
