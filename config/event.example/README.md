# Example event

A complete event directory, invented from end to end. Copy it to start a real
one:

```bash
cp -r config/event.example config/events/2026-03-12-example-offsite
make stage EVENT=2026-03-12-example-offsite
```

`config/events/` is gitignored and this directory is not, which is why it
exists. Everything here is made up, including the offsite, Alex Rivera, and the
three people who wrote the send-off messages, so that the format has a worked
example in the repository without any real person's words being in it. See
[../README.md](../README.md) for why events are not committed.

The content is invented, but it is still accurate. The arcade content here is
a different set of items from the one the build ships, written for this
directory instead of copied out of `app/src/arcade/`, and **every fact in a
reveal note is checked against the product's current documentation**. A note is
read out to a room of people who use these products, and this repository is
public, so a wrong fact in an example would mislead the room and anyone who
copies the example.

## What each file shows

| File | What it demonstrates |
| --- | --- |
| `session.json` | The title and subtitle, a third `manual` activity for something scored off-platform, and the console's runbook and arcade plan |
| `trivia-questions.json` | Twenty-four scored HashiCorp and IBM questions plus four flagged `tiebreak`, and what the test suite loads. The optional keys are documented in [SPEC.md](../../SPEC.md#question-file); this set uses `round`, `note` and `tiebreak`, and deliberately not `basePoints`, so every question is worth the same before speed weighting |
| `arcade-content.json` | All four arcade rounds staged at once: seven emoji cues, thirteen Unseal tins across the four shapes, six Glass Bridge pairs, and six Gganbu prompts, three of them flagged `verify`. Every key is optional, and a round left out plays the set compiled into the build. The format is in [docs/event-config.md](../../docs/event-config.md#the-arcades-content) |
| `sendoff.json` | A send-off with messages and no photos, which is valid and still makes a send-off. One message is long enough to be split across slides |
| `promo-card.html` | A self-contained poster with no scripts and no webfonts |

## What is not here

**`photos/`.** The send-off names no photos, so staging this directory works
without any. A real event puts them in `photos/`, downscaled to about 1200px
wide, and lists them by filename in `sendoff.json`. The ceiling is 300,000
bytes per photo, because each one is a DynamoDB row and an item stops at 400KB.

**`roster.md` and a per-person round.** Both are content about real people and
neither belongs in a public repository, which is why real events are gitignored.
