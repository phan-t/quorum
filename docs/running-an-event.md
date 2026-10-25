# Running an event

> **Staging is one command.** `make stage EVENT=<event>` creates the session,
> loads its questions and stages the console's setup, then prints the tokens.
> See [event-config.md](event-config.md). The steps below describe what that
> command does, and how to do any of them by hand.

This is the operator's guide to taking a deployed Quorum from parked to a CSV
of scores, for any session and whatever its activities are. Deploying and
changing the infrastructure is covered in [`infra/README.md`](../infra/README.md),
and what the surfaces do and why is in [SPEC.md](../SPEC.md).

Nothing here is hard, but almost all of it is easier at 9am than at 1:58.

## Two values to fill in first

Every command below uses two placeholders. Both come out of the deployment
rather than out of this document, because this repository is public and the
real ones belong in neither.

| | Where the real value is |
| --- | --- |
| `$QUORUM_URL` | The `url` output from Terraform, scheme included. The bare hostname is also the `HOST` variable at the top of the [Makefile](../Makefile), and `make url` calls `/healthz` on it, which is the quickest way to see whether it is answering at all |
| `$ADMIN_KEY_PARAM` | The `admin_key_parameter_name` output from Terraform, which names an SSM `SecureString`. Terraform created the parameter with a placeholder and has ignored its value ever since, so the real key was set once with the CLI |

```bash
QUORUM_URL=$(terraform -chdir=infra output -raw url)
ADMIN_KEY_PARAM=$(terraform -chdir=infra output -raw admin_key_parameter_name)
```

Reading the admin key needs a current AWS session. A local session lasts eight
hours, so one taken first thing will have expired by mid-afternoon. That
matters for this, for `make up`, and for `make down`, but not at all for the
running service or for the score export.

## Raise the service the day before

The service is parked at `desired_count = 0` between events. `make up` raises
it and waits for `/healthz`; `make down` parks it again. Sessions survive being
parked, because the state is in DynamoDB rather than in the process, so a
session created in the morning is still there in the afternoon.

Raise it the day before and open the join page from a device that has never
seen it. The failure you are looking for is a certificate or DNS problem, and
from the laptop that built the deployment it looks exactly like success.

## Create the session and load the questions

Run this as one paste on the morning of the event.

```bash
K=$(aws ssm get-parameter --name "$ADMIN_KEY_PARAM" --with-decryption \
      --query Parameter.Value --output text)

R=$(curl -s -X POST "$QUORUM_URL/api/sessions" \
      -H "Authorization: Bearer $K" -H 'content-type: application/json' \
      -d '{"title":"Team Huddle"}')
echo "$R"

SID=$(echo "$R" | sed 's/.*"sid":"\([^"]*\)".*/\1/')
HT=$(echo  "$R" | sed 's/.*"hostToken":"\([^"]*\)".*/\1/')

curl -s -X POST "$QUORUM_URL/api/sessions/$SID/content/trivia" \
  -H "Authorization: Bearer $HT" -H 'content-type: application/json' \
  --data-binary @config/event.example/trivia-questions.json
```

That first `echo` is the only time you will ever see the four things it prints.

| | What it is for |
| --- | --- |
| `sid` | Identifies the session. You need it again for the export at the end |
| `joinCode` | Starts `hvs.`, and is what goes in the meeting chat |
| `hostToken` | Your console. **Never share it or screen-share it** |
| `screenToken` | The Desktop, which is the tab you *do* screen-share |

**There is no endpoint that hands the tokens back.** They are minted, shown
once and stored only as hashes, so losing the host token loses the session,
and you would have to create a new one and get everybody to rejoin. Put them somewhere
you can find in a hurry before you do anything else.

The upload answers `{"activityId":"trivia","questions":20}`. If instead it
answers `invalid_questions`, every error is addressed by question number and
**nothing was loaded**. The import is all or nothing, because a set with
question 14 missing is worse than a set that failed in the dry run.
Fix the JSON and run it again; each upload replaces the whole set.

Re-uploading works until the first question opens. After that the
service refuses with `trivia_already_started`, which is deliberate: swapping
the set mid-quiz would rewrite questions people have already been scored on.

By hand, that uploads the whole shared bank in its own order. `make stage`
draws 20 at random and shuffles in the event's
`config/events/<event>/additional-trivia-questions.json`.

That extras file is the private one. Everything under `config/events/` is
gitignored, so it is in no repository and no backup. Only that directory is
ignored, so a question file left at `config/additional-trivia-questions.json`
would be **committed**, and this repository is public. See
[`config/README.md`](../config/README.md), which is also where the format is,
and [`docs/question-bank.md`](question-bank.md) for the questions to draw on.

## Open the three surfaces

```
Console    $QUORUM_URL/host#<hostToken>
Desktop    $QUORUM_URL/screen#<screenToken>
Join link  $QUORUM_URL/j/<joinCode>
```

The token sits after the `#` because a URL fragment never leaves the browser,
so it never appears in the request line, an access log, or a referrer header.
Because the token is in the fragment, a link with the `#` part trimmed off will
not work. For the same reason, the export below puts the token in a header. The
service refuses a token in the query string outright, because the load balancer
logs URLs.

## In the console, before the room arrives

The console opens on the **Preflight Checklist**, which reports on four things:
holding cards, questions loaded, arcade rounds chosen, and who has joined. It
is visible while the session is in draft or lobby and disappears once you
start.

**Build every holding card you might want, now.** A holding card is what the
room looks at while something is happening that Quorum is not running, such
as an off-platform activity, a coffee break, or the gap while you set the next
thing up. The editor is setup-only. Once the session is running you can put a
card up, jump to one from the rail, or hit `SHIFT+H`, but you cannot type a new
one. So
if there is any chance you will want "Back at 3:25", write it before you start;
at 3:05 it is too late and the room keeps whatever the card already says. The
editor hides itself during the session because a card edited then may be on
thirty people's screens a minute later.

Cards are kept in the console browser's local storage, and the server never
sees them. They survive a reload and they are still there tomorrow, but only on
that machine, so a co-host's console has its own deck, and a card nobody wrote
shows "Back shortly".

**Set the runbook**, which is the run of show, and drop a holding step wherever
a card should appear. Each step points at one card, and the card's title is what the
runbook and the rail call that step, so name them as something you would
recognise in a hurry. If you delete a card two steps were using, preflight says
so rather than quietly repointing them.

**Set the arcade running order** in the same pass. Like the runbook, it is
chosen in setup because it is knowable in the morning, and fixing it then stops
anyone rewriting it by accident mid-session. Once the session is live you can
still deviate from it with the rail.

Then leave it in the lobby until the start time.

## The room

**Run it with at least two people.** One facilitator talks and runs the
activity, and one co-host is on the same console link. Quorum does the scoring
the scorekeeper used to do by hand, but the second person still watches chat,
catches the person whose page will not load, and can drive the run of show if
the facilitator's browser crashes, which is the main reason to have them.
Nothing is lost when a console crashes, because the state and the timers are on
the server, but the session stops progressing because the next question does
not open itself.

**Everyone joins under their real name**, as it appears on the call. Say it
twice, and put it in chat. The export is a list of the names people typed, and
working out who `xXx_terraform_xXx` at the bottom of it is takes five minutes
during a three-minute break. The nickname field is free text and there is no
roster to pick from, so asking is the only control you have. Ask before the join
link goes out.

**The join code is case-sensitive.** It is `hvs.` and twenty-four base62
characters, shaped like a Vault token on purpose. Paste it into chat; do not
read it out, do not retype it, and do not let anything upper-case it. Post the
join link in the calendar invite as well as in chat, because someone always
joins without the chat history.

**Keep chat to one message per person**, and have answers sent to *everyone*
rather than privately to the host. A private-message answer is invisible to the co-host and
you will lose it. Say that twice, because chat clients remember the last
recipient somebody used. If your platform lets you turn private chat off for
the session, do it, because that removes the problem entirely and also stops
answer-sharing.

**Announce time out loud** as well as showing it on screen: the halfway mark,
two minutes, and thirty seconds. People concentrating on an answer are not
watching your timer.

**Talk through the quiet stretches.** A room of twenty-five people all
answering alone is silent, and over video silence looks like the session has
stalled. Saying "Twelve of you are in, keep them coming" costs nothing, and the
console has the count. Call on people **by
name** rather than asking the room; "anyone want to add anything?" gets silence
over video every time.

**Check the timezone spread before you schedule**, say it out loud at the top,
and put the worst-hit region in the first activity while they are still sharp.

## Pace

Read only the hard questions aloud. Reading a question aloud gives the room
about eight seconds of extra thinking time, so choose which questions get it. Twenty questions in fifteen minutes is about
forty-five seconds each including the reveal, and that is the right pace. Pick
four questions to talk about and move through the rest without comment. If
people answer the first five quickly, stop reading and let them read.

Leave streaks and speed bonuses on. They are most of the fun, and normalising
against the top scorer ([SCORING.md](../SCORING.md)) absorbs the inflated
numbers.

**If you are running an activity you do not play it**, and nothing credits you
for it, so the activity is a zero on your row. Say that out loud before the
first activity. It takes thirty seconds and stops the zero looking like a
stitch-up when the scores are read out at the prize-giving. There used to be
arithmetic for this and it has been removed, but
[SCORING.md](../SCORING.md#removed-spot-awards-and-bench-credit) has it written
down if a session ever needs it back. Do not play anyway "for fun, unscored",
because your row still ends up in the export.

## When something breaks

Something usually does, and none of these is a reason to stop the session.

- **Somebody cannot get the page to work.** Have them answer in chat and enter
  the score from the console by hand. Manual entry is a host action and works
  while any segment is up. Do not stop thirty people to debug one laptop.
- **Somebody joins twenty minutes late.** They play what is left, and the
  activity they missed is a zero. **There is nothing to mark and nothing flags
  them for you**, so the only handling is what you say: tell the room they came
  in late and are not in contention for that column. Decide this before it
  happens rather than in front of them.
- **The server restarts.** It comes back with the session intact in about
  twenty seconds and everyone reconnects by themselves. Answers that arrived in
  the gap are lost, and there is no way to ask the question again: score the
  people it cost by hand. Say "we'll sort it" and keep moving, because
  stopping the room to reconstruct one question costs more than the question is
  worth.
- **Everything is down.** The activity content is plain text in this
  repository. Read it out, score it in chat, and keep going.

Say "we'll sort it, keep going" and move on. The room will react the way you do.

## At the end

```bash
curl -s "$QUORUM_URL/api/sessions/$SID/export.csv" \
  -H "Authorization: Bearer $HT" -o scores.csv
```

The CSV has each person's name, every activity's raw score and points, and
their total, which is the sheet somebody used to keep by hand. The token goes in
the header and never in the URL. The
export still works after the session has closed and after a restart, because it
falls back to the store, but it needs the host token, so pull it while you
still have it.

Post only the top three to the team channel. On an individual leaderboard, the
bottom of the full ranking has someone's name on it.

Then run `make down` the same day. Otherwise the service stays up on a public
URL with nobody watching it, which a security review will flag.

## Problems seen at past events

- **Keep the console tab in front.** The console's countdown is redrawn by a
  timer in the page, and browsers clamp those in a background tab. The question
  still closes on time, because the server keeps that clock, but the number
  you are reading stops moving, which looks exactly like a hung session.
- **Share the Desktop tab itself**, and never the whole screen or the
  console. The console shows the answers, which is why its tab title says
  **DO NOT SHARE**.
- **Paste the join code.** It is case-sensitive.
- **Do not deploy on event day.** A deploy replaces the running task, and with
  one stateful process every socket drops at once. `make url` reports
  `sessionsLive`, so you can check whether a session is live before you
  deploy. If the deploy *is* the fix, do it anyway; otherwise it waits.
- **After a deploy that changes a frame's shape, reload any Desktop or console
  that was already open.** They reconnect on their own and they do not reload,
  so an open tab keeps running the *old* JavaScript against the new server's
  frames. When a frame has narrowed, the old code reads a field that is no
  longer sent and throws while rendering. The surface then stops updating with
  nothing on it to say so. A phone does this for itself now, and the console and
  the Desktop will say **this build is older than the server** when they can
  tell (`PROTOCOL_VERSION` in `app/src/protocol.ts`). That check runs in the
  client that is already open, though, so it cannot help across the deploy that
  introduces it, or any deploy where the shape changed without the version
  moving. Reloading the two long-lived tabs takes seconds and covers every case.
- **Write the holding cards before you start.** After that you can only show
  them.
- **The tokens are printed once.** There is no way to ask for them again.
