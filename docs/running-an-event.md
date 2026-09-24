# Running an event

> **Staging is one command.** `make stage EVENT=<event>` creates the session,
> loads its questions and stages the console's setup, then prints the tokens.
> See [event-config.md](event-config.md). The steps below are what that command
> does, and what to do when you need to do one of them by hand.

The operator's guide: how to take a deployed Quorum from parked to a CSV of
scores. It covers any session, whatever the activities are. Deploying and
changing the infrastructure is [`infra/README.md`](../infra/README.md); what
the surfaces do and why is [SPEC.md](../SPEC.md).

Nothing here is hard, but almost all of it is easier at 9am than at 1:58.

## Two values to fill in first

Every command below uses two placeholders. Both come out of the deployment
rather than out of this document, because this repository is public and the
real ones belong in neither.

| | Where the real value is |
| --- | --- |
| `$QUORUM_URL` | The `url` output from Terraform, scheme included. The bare hostname is also the `HOST` variable at the top of the [Makefile](../Makefile), and `make url` calls `/healthz` on it, which is the quickest way to see whether it is answering at all |
| `$ADMIN_KEY_PARAM` | The `admin_key_parameter_name` output from Terraform — an SSM `SecureString`. Terraform created the parameter with a placeholder and has ignored its value ever since, so the real key was set once with the CLI |

```bash
QUORUM_URL=$(terraform -chdir=infra output -raw url)
ADMIN_KEY_PARAM=$(terraform -chdir=infra output -raw admin_key_parameter_name)
```

Reading the admin key needs a current AWS session. A local session lasts eight
hours, so one taken first thing will have expired by mid-afternoon — which
matters for this, for `make up` and for `make down`, and not at all for the
running service or for the score export.

## A day ahead, not an hour

The service is parked at `desired_count = 0` between events. `make up` raises
it and waits for `/healthz`; `make down` parks it again. Sessions survive being
parked, because the state is in DynamoDB rather than in the process, so a
session created in the morning is still there in the afternoon.

Raise it the day before and open the join page from a device that has never
seen it. The failure you are looking for is a certificate or DNS problem, and
from the laptop that built the thing it looks exactly like success.

## Create the session and load the questions

One paste. Run it the morning of the event.

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
  --data-binary @config/trivia-questions.json
```

That first `echo` is the only time you will ever see the four things it prints.

| | What it is for |
| --- | --- |
| `sid` | Identifies the session. You need it again for the export at the end |
| `joinCode` | Starts `hvs.` — this is what goes in the meeting chat |
| `hostToken` | Your console. **Never share it, never screen-share it** |
| `screenToken` | The Desktop: the tab you *do* screen-share |

**There is no endpoint that hands the tokens back.** They are minted, shown
once and stored only as hashes, so a lost host token is a lost session — you
would have to create a new one and get everybody to rejoin. Put them somewhere
you can find in a hurry before you do anything else.

The upload answers `{"activityId":"trivia","questions":20}`. If instead it
answers `invalid_questions`, every error is addressed by question number and
**nothing was loaded** — the import is all or nothing, on the grounds that a
set with question 14 missing is worse than a set that failed in the dry run.
Fix the JSON and run it again; each upload replaces the whole set.

Re-uploading works right up until the first question opens. After that the
service refuses with `trivia_already_started`, which is deliberate: swapping
the set mid-quiz would rewrite questions people have already been scored on.

The file itself is the private one, `config/trivia-questions.json`. It is
gitignored and therefore in no repository and no backup — see
[`config/README.md`](../config/README.md), which is also where the format is,
and [`docs/question-bank.md`](question-bank.md) for the questions to draw on.

## Open the three surfaces

```
Console    $QUORUM_URL/host#<hostToken>
Desktop    $QUORUM_URL/screen#<screenToken>
Join link  $QUORUM_URL/j/<joinCode>
```

The token sits after the `#` because a URL fragment never leaves the browser:
it is not in the request line, not in an access log, not in a referrer header.
That is also why a link with the `#` part trimmed off will not work. The same
rule is why the export below puts the token in a header — a token in the query
string is refused outright, because the load balancer logs URLs.

## In the console, before the room arrives

The console opens on the **Preflight Checklist**, which reports on four things:
holding cards, questions loaded, arcade rounds chosen, and who has joined. It
is visible while the session is in draft or lobby and disappears once you
start.

**Build every holding card you might want, now.** A holding card is what the
room looks at while something is happening that Quorum is not running — an
off-platform activity, a coffee break, the gap while you set the next thing up.
The editor is setup-only. Once the session is running you can put a card up,
jump to one from the rail or hit `SHIFT+H`, but you cannot type a new one. So
if there is any chance you will want "Back at 3:25", write it before you start;
at 3:05 it is too late and the room keeps whatever the card already says. The
reason the editor hides itself is that editing a card mid-session is editing
something thirty people may be looking at in a minute.

Cards are kept in the console browser's local storage, not on the server. They
survive a reload and they are still there tomorrow, but they are on that
machine only — a co-host's console has its own deck, and a card nobody wrote
shows "Back shortly".

**Set the runbook** — the run of show — and drop a holding step wherever a card
should appear. Each step points at one card, and the card's title is what the
runbook and the rail call that step, so name them as something you would
recognise in a hurry. If you delete a card two steps were using, preflight says
so rather than quietly repointing them.

**Set the arcade running order** in the same pass. Like the runbook, it is
chosen in setup because it is knowable in the morning, and a running order that
can be rewritten mid-session is one that gets rewritten by accident. The rail
is still how you deviate once the session is live.

Then leave it in the lobby until the start time.

## The room

**Two people, minimum.** One facilitator who talks and runs the activity, and
one co-host on the same console link. Quorum does the scoring the scorekeeper
used to do by hand, but the second person still watches chat, catches the
person whose page will not load, and — the reason it matters most — can drive
the run of show if the facilitator's browser dies. Nothing is lost when a
console crashes, because the state and the timers are on the server; what stops
is progression, since the next question does not open itself.

**Everyone joins under their real name**, as it appears on the call. Say it
twice, and put it in chat. The export is a list of the names people typed, and
`xXx_terraform_xXx` at the bottom of it is five minutes of detective work
during a three-minute break. If you have a roster, paste it into the console
before the session: the join screen then offers the names as chips, and the
path of least resistance produces the right name.

**The join code is case-sensitive.** It is `hvs.` and twenty-four base62
characters, shaped like a Vault token on purpose. Paste it into chat; do not
read it out, do not retype it, and do not let anything upper-case it. Post the
join link in the calendar invite as well as in chat — someone always joins
without the chat history.

**Chat discipline**: one message per person, and answers go to *everyone*, not
privately to the host. A private-message answer is invisible to the co-host and
you will lose it. Say that twice, because chat clients remember the last
recipient somebody used. If your platform lets you turn private chat off for
the session, do it — it removes the whole class of problem and it stops
answer-sharing.

**Announce time out loud**, not just on screen: the halfway mark, two minutes,
thirty seconds. People heads-down on an answer are not watching your timer.

**Narrate the quiet.** A room of twenty-five people all answering alone is very
quiet, and quiet reads as dead. "Twelve of you are in, keep them coming" is the
cheapest energy there is, and the console has the count. Call on people **by
name** rather than asking the room; "anyone want to add anything?" gets silence
over video every time.

**Check the timezone spread before you schedule**, say it out loud at the top,
and put the worst-hit region in the first activity while they are still sharp.

## Pace

Do not read every question aloud — read the hard ones. Reading a question aloud
buys the room about eight seconds of thinking time, which is exactly why you
should spend it deliberately. Twenty questions in fifteen minutes is about
forty-five seconds each including the reveal, and that is the right pace. Pick
four questions to talk about and let the rest fly past. If the first five land
fast, stop reading and let people read.

Leave streaks and speed bonuses on. They are most of the fun, and normalising
against the top scorer ([SCORING.md](../SCORING.md)) absorbs the inflated
numbers.

**If you are running an activity you do not play it**, and you are credited
your own average for it. Say the Bench Credit rule out loud before the first
activity — thirty seconds, and it reads as fair up front where it reads as a
stitch-up at the prize-giving. Do not play anyway "for fun, unscored": the row
pollutes the export.

## When something breaks

It will. None of these is a reason to stop the session.

- **Somebody cannot get the page to work.** Have them answer in chat and enter
  the score from the console by hand — manual entry is a host action and works
  while any segment is up. Do not stop thirty people to debug one laptop.
- **Somebody joins twenty minutes late.** They play what is left and are marked
  bench for the activity they missed, exactly like a facilitator. The console
  flags anyone who joined after an activity started. Decide this before it
  happens rather than in front of them.
- **The server restarts.** It comes back with the session intact in about
  twenty seconds and everyone reconnects by themselves. Answers that arrived in
  the gap are lost, and the console offers a re-ask on the affected question.
- **Everything is down.** The activity content is plain text in this
  repository. Read it out, score it in chat, keep going.

Say "we'll sort it, keep going" and move. The room takes its cue from you.

## At the end

```bash
curl -s "$QUORUM_URL/api/sessions/$SID/export.csv" \
  -H "Authorization: Bearer $HT" -o scores.csv
```

Name, every activity's raw score and points, Spot Awards, total — the sheet
somebody used to keep by hand. The token goes in the header, never the URL. The
export still works after the session has closed and after a restart, because it
falls back to the store, but it needs the host token, so pull it while you
still have it.

Post the top three to the team channel, not the full ranking: on an individual
leaderboard the bottom of the list has someone's name on it.

Then `make down`, the same day. A service nobody is watching, on a public URL,
is the thing that turns up in a security review.

## The things that have bitten before

- **Keep the console tab in front.** The console's countdown is redrawn by a
  timer in the page, and browsers clamp those in a background tab. The question
  still closes on time — that clock is the server's — but the number you are
  reading stops moving, which looks exactly like a hung session.
- **Share the Desktop tab specifically**, never the whole screen and never the
  console. The console shows the answers, which is why its tab title says
  **DO NOT SHARE**.
- **Paste the join code.** It is case-sensitive.
- **Do not deploy on the day.** A deploy replaces the running task, and one
  stateful process means every socket drops at once. `make url` reports
  `sessionsLive`, so there is a way to check before you find out. If the deploy
  *is* the fix, do it anyway; otherwise it waits.
- **Write the holding cards before you start.** After that you can only show
  them.
- **The tokens are printed once.** There is no way to ask for them again.
