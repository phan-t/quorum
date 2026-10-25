# Question bank: HashiCorp trivia, with a little IBM

The bank has 32 questions, weighted heavily towards **HashiCorp history and
products**. Run **20 to 24** of them. A suggested set is at the bottom.

Questions are drafted in this file, but the service does not read it. Quorum loads
JSON: every event draws 20 questions at random from the shared bank,
`config/event.example/trivia-questions.json`, and shuffles in any extras from
`config/events/<event>/additional-trivia-questions.json`. The format is
documented in
[`config/README.md`](../config/README.md) and
[SPEC.md](../SPEC.md#question-file). To swap a question in, edit the JSON.

The correct answer is in **bold**, and `T` is the suggested time limit in seconds.

> Questions that turn on dates, names, or branding were checked against
> sources on **19 September 2026** and are marked **✅ Verified** with what
> confirmed them. Re-check if this bank is reused for a later event.

> **Two of the three verified questions are in the shipped set, and the
> check caught an error in one of them.** D4 and E4 are both in
> `config/event.example/trivia-questions.json`. D4 went into that file dated
> "in 2023", and the note under D4 below caught it. A8 is still bank-only, so
> its verification matters for a *future* swap and not for the next game. If
> you swap it in, edit the JSON, because that is what the service reads.

---

## Round A: HashiCorp history (8)

**A1.** In what year was HashiCorp founded? `T20`
A) 2008 B) 2010 C) **2012** D) 2015

**A2.** Which was HashiCorp's first product? `T20`
A) Terraform B) **Vagrant** C) Vault D) Consul

**A3.** Who co-founded HashiCorp with Armon Dadgar? `T20`
A) **Mitchell Hashimoto** B) Solomon Hykes C) Kelsey Hightower D) Adam Jacob

**A4.** The company name comes from where? `T20`
A) A hash function B) **A founder's surname** C) The `#` symbol D) Hashi = bridge

**A5.** Which product came first? `T30`
A) Vault B) **Consul** C) Nomad D) Boundary

**A6.** Which two products were announced together at HashiConf Digital 2020? `T30`
A) Vault & Consul B) **Boundary & Waypoint** C) Nomad & Packer
D) Terraform & Sentinel

**A7.** What is HashiCorp's published product design philosophy called? `T20`
A) The HashiCorp Way B) **The Tao of HashiCorp** C) The Blue Book
D) Infrastructure Manifesto

**A8. ✅ Verified** — HashiCorp listed on the Nasdaq in December 2021 under
which ticker? `T20`
A) HASH B) **HCP** C) HSHC D) TFRM

> *Confirmed 19 Sep 2026: trading opened 9 Dec 2021 and the IPO closed
> 13 Dec 2021, ticker `HCP` on the Nasdaq Global Select Market. The listing
> ended when IBM completed the acquisition. `HCP` makes a good answer because
> it is also the abbreviation for HashiCorp Cloud Platform.*

---

## Round B: Name that product (8)

**B1.** Secrets management, encryption as a service, dynamic credentials? `T20`
A) Consul B) Boundary C) **Vault** D) Nomad

**B2.** Secure remote access to hosts and services without distributing SSH keys
or VPN credentials? `T20`
A) Consul B) **Boundary** C) Vault D) Packer

**B3.** Workload orchestrator and scheduler — containers, but also raw
executables, Java and VMs? `T20`
A) **Nomad** B) Consul C) Waypoint D) Terraform

**B4.** Service discovery, health checking and service mesh? `T20`
A) Nomad B) Boundary C) **Consul** D) Terraform

**B5.** Builds identical machine images for multiple platforms from one source
configuration? `T20`
A) Vagrant B) **Packer** C) Waypoint D) Terraform

**B6.** Reproducible local development environments, driven by a `Vagrantfile`? `T20`
A) Packer B) Waypoint C) **Vagrant** D) Nomad

**B7.** What is HashiCorp's policy-as-code framework called? `T20`
A) Rego B) Gatekeeper C) **Sentinel** D) Guardrail

**B8.** Which product scans code and systems for leaked secrets? `T30`
A) Vault Sentinel B) **Vault Radar** C) Consul Watch D) Vault Scout

---

## Round C: Product deep cuts (8)

**C1.** Which Terraform command previews changes without applying them? `T20`
A) terraform preview B) **terraform plan** C) terraform dry-run D) terraform diff

**C2.** Which Terraform command downloads providers and prepares the working
directory? `T20`
A) terraform setup B) **terraform init** C) terraform fetch D) terraform prepare

**C3.** By default, what is Terraform's state file called? `T20`
A) state.json B) **terraform.tfstate** C) tfstate.lock D) main.tfstate

**C4.** What does HCL stand for? `T20`
A) HashiCorp Cloud Language B) **HashiCorp Configuration Language**
C) Hybrid Cloud Layer D) HashiCorp Command Line

**C5.** A Vault *dynamic secret* is best described as? `T30`
A) A secret that rotates yearly B) **A credential generated on demand, with a lease**
C) An encrypted static value D) A secret shared between two apps

**C6.** Which Vault feature provides encryption as a service, so apps never
handle keys? `T30`
A) **The transit secrets engine** B) The KV engine C) Auto-unseal D) Vault Agent

**C7.** Which consensus protocol backs integrated storage in Vault, Consul and
Nomad? `T20`
A) Paxos B) **Raft** C) Zab D) Two-phase commit

**C8.** Vault's traditional unseal process splits the root key using which
scheme? `T30`
A) RSA key splitting B) **Shamir's Secret Sharing** C) Diffie-Hellman
D) Merkle partitioning

---

## Round D: Licensing and brand (4)

**D1.** In 2023 HashiCorp changed its source licence from MPL 2.0 to which
licence? `T20`
A) Apache 2.0 B) AGPL C) **Business Source Licence (BUSL)** D) SSPL

**D2.** That licence change triggered a community fork of Terraform, named? `T20`
A) FreeForm B) **OpenTofu** C) OpenTerra D) Terrafork

**D3.** Which product's brand colour is purple? `T10`
A) Vault B) Consul C) **Terraform** D) Nomad

**D4. ✅ Verified** — Terraform Cloud was rebranded to what? `T20`
A) Terraform Enterprise B) **HCP Terraform** C) Terraform One D) HashiCorp Terraform

> *Confirmed 19 Sep 2026: renamed to HCP Terraform on 22 Apr 2024; the
> product itself did not change. Terraform Enterprise is still a separate
> product, so A is a fair distractor.*

---

## Round E: IBM (4, deliberately light)

**E1.** IBM's long-standing nickname? `T10`
A) Big Iron B) **Big Blue** C) The Blue Giant D) Blue Sky

**E2.** IBM's Deep Blue defeated which world chess champion in 1997? `T20`
A) Anatoly Karpov B) Magnus Carlsen C) **Garry Kasparov** D) Vladimir Kramnik

**E3.** IBM acquired Red Hat in 2019 for approximately how much? `T20`
A) $12 billion B) $19 billion C) **$34 billion** D) $67 billion

**E4. ✅ Verified** — In which year did IBM complete its acquisition of
HashiCorp? `T20`
A) 2023 B) 2024 C) **2025** D) 2026

> *Confirmed 19 Sep 2026: announced 24 Apr 2024, closed 27 Feb 2025 at
> $6.4bn. The question tests the gap between those two dates. Most of the
> room will pick B, because they remember the announcement.*

---

## Round F: APJ spares and sudden death (not in the main 20)

**F1.** Which is the world's southernmost capital city? `T20`
A) Canberra B) **Wellington** C) Hobart D) Christchurch

**F2.** The Merlion is the landmark of which city? `T10`
A) Kuala Lumpur B) Hong Kong C) **Singapore** D) Manila

**F3.** Which is the largest of these APJ countries by land area? `T20`
A) India B) Indonesia C) **Australia** D) Japan

**F4.** In Japan, "Golden Week" falls across which two months? `T20`
A) March–April B) **April–May** C) July–August D) December–January

**F5.** Which of these countries drives on the left? `T10`
A) Japan B) Australia C) India D) **All of these**

---

## The 20 to run

This set is weighted to HashiCorp history and products, with two IBM questions:

| Round | Take | Why |
| --- | --- | --- |
| **A**: history | A1, A2, A3, A5, A6, A7 (6) | Warm-up; everyone scores on A1–A3 |
| **B**: name that product | all 8 | Most of the set's product questions |
| **C**: deep cuts | C1, C3, C5, C7 (4) | Spreads out the scores |
| **E**: IBM | E1, E2 (2) | Two light questions to keep it fun |

That is **20**, and it is no longer what
`config/event.example/trivia-questions.json` contains. The committed example is
**24 scored questions plus four tiebreakers**. The most important difference
is that it drops six of Round B's eight questions and five of Round C's,
because a room of solutions architects answers "which product does secrets
management" before the timer has finished drawing itself. A free mark early is
worse than a free mark late, because speed weighting and the streak bonus both
compound, so the opening questions decide the game. The questions kept from
those two rounds are the ones the room can't answer on sight: B7 and B8 for
Sentinel and Vault Radar, and C5, C7, and C8 for dynamic secrets, Raft, and
Shamir. D1 and D2 are in, because this audience enjoys the licence argument.
Use this table for the shape of the set, and read the JSON for the questions
that will be asked.

Order the example, and anything built from it, like this: open with easy
questions, **announce** a short block of questions the room can answer on sight
so the streaks build, put the hard ones in the middle to spread out the scores,
and close on something the whole mixed room can answer. Don't open or close on
a deep cut.

**Round F is in the JSON** as F1 to F4, four questions flagged
`"tiebreak": true`. A flagged question is lifted out of the scored set and into
the pool sudden death draws on, so those four don't make the game any longer.
Without them the engine falls back to a built-in pool. That pool used to ask
C7's Raft question again, which settled a tie by two people racing to retype an
answer they had heard twenty minutes earlier, so it now asks general knowledge
questions. Round F is still the better choice, because a tiebreaker written by
whoever wrote the set is verified in the same pass as the set. Their
`timeLimitSec` is only this bank's suggestion. Sudden death has no clock,
because it ends when someone answers correctly, so the reducer never reads the
field on a flagged question.

---

## Round S: the "someone we're celebrating" round *(template)*

This is a reusable pattern for farewells, work anniversaries, and milestones.
It is five questions about one person, dropped in as the **second-to-last**
block of the quiz. By then everyone has warmed up, and a question everyone can
answer is still left to close on.

It works because the person being celebrated plays too, and the room enjoys
watching the team guess wrong about them.

### How to fill it

Ask the person a week ahead. Copy the message below and send it as a DM, which
takes about ten minutes of their time.
Ask early in their day so they have the evening to think, and tell them they
will see every question before anyone else does.

> Hey, we're doing five quiz questions about you at Friday's huddle, right
> before the send-off. It's meant as a gift rather than a roast, and you get to
> approve all five before anyone sees them. You're playing too, and if you win the round we'll
> make a thing of it.
>
> Could you answer any six or seven of these? Short answers are perfect.
>
> 1. Which city were you living in before you joined HashiCorp?
> 2. What was your first-ever job, before the career started?
> 3. What do you order every single time, whether it's coffee, lunch, or
>    something else?
> 4. Go-to karaoke song, or the one you'd refuse to sing?
> 5. Which airport have you passed through most, and roughly how many times?
> 6. Tell me about something that went sideways on a customer visit or a demo,
>    and what happened next.
> 7. Give me three true things about you most of the team wouldn't know, and one
>    believable thing that is completely false.
> 8. Roughly how many [customer workshops, flights, certifications, or demos]
>    have you done since joining?
> 9. Anything that is off-limits? I'd rather ask now.
>
> Also, is there anything you *want* the team to know before you go? I'll find a
> place for it.

If they are slow to reply, ask two people who have worked with them longest and
have the person approve the result. Do not skip the approval step.

Good questions are specific and slightly absurd. Avoid anything guessable from
their LinkedIn, or so obscure that nobody scores.

Aim for two questions everyone will get, two that split the room, and one nobody
gets.

### Writing the wrong answers

The wrong answers decide whether the round works, and they are harder to write
than the questions.

- **Make every option survivable if read aloud as true.** Someone will pick
  each one, and the person hears all four.
- **No joke option.** A silly fourth answer is eliminated instantly and turns a
  four-way question into a three-way one.
- **Same shape and length across all four.** People know that the long one is
  always the real one.
- **For a "how many" question, bracket the truth.** If the real number is 40,
  offer 15, 40, 75, and 120 rather than 5, 40, 45, and 50, because nobody should
  be able to reason their way to the answer.
- **For the "NOT true" question, write three true options and one false**, and
  the false one must be the sort of thing that *could* be true of them.

```
S1. Which city did ______ live in before joining HashiCorp?
    A) ________  B) ________  C) ________  D) ________

S2. ______ once ________________________. What happened next?
    A) ________  B) ________  C) ________  D) ________

S3. Which of these is NOT true about ______?
    A) ________  B) ________  C) ________  D) ________

S4. What is ______'s go-to ________________ (order / karaoke song / airport)?
    A) ________  B) ________  C) ________  D) ________

S5. How many ______________ has ______ done since joining?
    A) ________  B) ________  C) ________  D) ________
```

### Rules

- **Clear every question with the person first.** Show them all five so that
  nothing surprises them. A farewell round should feel like a gift, and over
  video you will not be able to tell whether a question has upset someone.
- **Nothing about performance, pay, or why they are leaving.** Leave out
  anything they flagged as off-limits too. If a question needs a caveat before
  you read it, cut it.
- Give S3 a 30-second timer, because a "which is NOT true" question always takes
  longer to answer than you expect.
- The person being celebrated plays along. If they win the round, let it happen
  and celebrate it, because that is the best outcome the round can have.

### Scoring

Round S counts toward the trivia total like any other question. It is five
questions about someone the whole room knows, so it narrows the gaps between
scores slightly. That is fine, because it keeps more people in contention going
into the last activity.

### Into the question file

Add the five to `config/events/<event>/additional-trivia-questions.json`. Staging
shuffles them in with the 20 drawn from the shared bank, so they turn up through
the game rather than as a block, and with no round card: round labels are
dropped from a shuffled set. Introduce the round out loud before trivia starts
instead.

Each question looks like any other:

```json
{
  "text": "Which city did Sam live in before joining HashiCorp?",
  "answers": ["Melbourne", "Singapore", "Taipei", "Auckland"],
  "correct": "B",
  "timeLimitSec": 20
}
```

`correct` is the answer's **letter** rather than a 0-based or 1-based
position, so there is no off-by-one to get wrong. Unknown keys are refused
rather than ignored, so a misspelled `timelimitSec` fails the upload instead of
being dropped and leaving the question on a different timer in front of the
room.

A round built this way names a real person, which is why the file it goes in is
gitignored and why only the example set is committed. The reasoning is in
[`config/README.md`](../config/README.md), and it comes down to this: the
repository is public, and a question set is content about the people in the
room.

Place the five so that **at least one easy question still follows them**. The
quiz should then close on something everyone can answer instead of the hardest
question about one person.
