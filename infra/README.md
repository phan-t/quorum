# Quorum — infrastructure

Terraform for the AWS side of [ARCHITECTURE.md](../ARCHITECTURE.md). One
environment, one workspace, one apply, run by a person.

```
infra/
├── main.tf           the three module calls
├── ecr.tf            the one repository and its lifecycle policy
├── variables.tf      what a human supplies; see the table below
├── outputs.tf        url, image, table name, log group
├── versions.tf       required versions, the `cloud` block, the AWS provider
└── modules/
    ├── network/      VPC, two public subnets, the two security groups
    ├── service/      ALB, ACM, Route 53, ECS cluster/task/service, logs, alarm
    └── data/         DynamoDB table, SSM parameter for the admin key
```

`infra/` **is** the root. There is no `bootstrap/` and no `envs/`; both appear in
older drafts of ARCHITECTURE.md and neither was built. The ECR repository, which
a bootstrap workspace would have owned, is `ecr.tf` here.

## Why there is no pipeline

This account permits no non-human credentials. `iam:CreateOpenIDConnectProvider`
and `iam:CreateUser` are both an explicit deny, and the account holds **0 users
and 0 identity providers** against 46 roles. That is a deliberate policy, not a
gap: only a human with a current session acts here.

So there is no OIDC, no access key, no machine identity and no deploy workflow.
CI still runs on every push — typecheck, tests, `fmt`, `validate`, and a
container build to prove the Dockerfile compiles — and it needs no credential to
do any of that. A fork's PR runs all of it. The deploy is `make deploy`, run by
a person.

For a service that runs two hours a few times a year this is the right shape.
There is no release cadence to automate, and somebody has to be present to
raise the service before an event regardless.

## Runs are remote; credentials are pushed, not federated

State, locking, run history and the applies themselves all live in HCP
Terraform, in the workspace `quorum`. It is **CLI-driven**: `terraform apply`
runs from here and HCP Terraform executes it. `versions.tf` sets out at length
why connecting it to VCS would break several things at once.

```
export TF_CLOUD_ORGANIZATION=tphan     # the config does not name it: this repo is public
```

The HCP Terraform token comes from `terraform login`. Nothing in this repo
holds it.

### The AWS credentials, and the eight-hour clock

Remote runs execute on HCP Terraform's workers, which need an AWS session of
their own. This account issues no static credentials and no identity provider,
so what the workers get is a copy of *your* STS session, pushed into the **AWS
Authentication** variable set by doormat:

```
awscreds        # new AWS session locally (8 hours)
tfawscreds      # push it into the variable set
```

**Both, in that order, before any apply.** The image push uses your local
session; the apply uses the copy in the variable set. Either being stale fails
the same way — partway in, at the AWS provider, looking like a permissions
problem when it is not one. If a run fails that way, re-run both and try again.

A variable set rather than workspace variables matters: one push covers every
workspace attached to it. Do not set `AWS_ACCESS_KEY_ID` and friends on a
workspace directly — workspace variables take precedence over a variable set,
so stale values there silently shadow the fresh ones and the failure looks
identical to an expired session.

### Attaching the variable set to a new workspace

A workspace created by `terraform init` has no variable set attached, so its
first run fails with no credentials at all. Attach **AWS Authentication** to it
once, in *Workspace → Variables → Variable sets → Apply to this workspace*.

`quorum` is already attached. Any new workspace would need it too.

## What a human has to supply

Terraform variables. They live in a gitignored `terraform.tfvars` because this
repo is public, and the CLI uploads that file with the rest of the directory,
which is how they reach the workers.

| Variable | This account |
| --- | --- |
| `aws_account_id` | in `terraform.tfvars`, not here |
| `aws_region` | `ap-southeast-2` |
| `hosted_zone_id` | the zone that owns `domain_name`; a delegation somebody made at a registrar, not created here |
| `domain_name` | `quorum.tphan.sbx.hashidemos.io` — the `HOST` the Makefile curls |
| `image_tag` | set by `make deploy`; any existing tag for the first apply |
| `desired_count` | `0` at rest |

## First run, from nothing

```
awscreds                                  # eight hours
tfawscreds                                # push the session to the variable set
export TF_CLOUD_ORGANIZATION=tphan
make check                                # session alive, org set, which account
make deploy                               # build, push, apply — creates everything
make up                                   # raise it and wait for /healthz
```

Budget about fifteen minutes for the first apply; most of it is ACM waiting on
DNS validation. After that an apply is a couple of minutes.

## Day to day

Everything is the Makefile. There is no button in a UI for any of it, and that
is on purpose: `image_tag` and `desired_count` are the two inputs that change,
and both belong to a command somebody ran rather than to a field somebody
edited.

```
make check     # is my session alive, is the org set, what account am I in
make deploy    # build, push, and apply the new image
make up        # raise the service before an event
make down      # park it at zero afterwards
make url       # the health endpoint, so you can see it answer
make plan      # what would change
make fmt       # terraform fmt, then the app's typecheck and tests
```

`make stage EVENT=…`, `make sessions` and `make close SID=…` are the event-day
commands. They need an AWS session but never touch Terraform: they read the
admin key from SSM and talk to the running service over HTTPS.

## Parked at zero between events

Quorum runs for about two hours, a few times a year. It is not a service that
should be up in between, and it is cheaper and safer parked.

**`desired_count = 0` is the resting state.** Everything else stays: the VPC,
the ALB, the certificate, the DNS records, the table and its data. There is
simply no task running, so nothing serves and nothing can leak.

### Before an event

```
make up
```

A day ahead, not an hour. `make up` re-applies with `desired_count = 1` at the
tag already in state — it deliberately does **not** change which image runs,
because `TAG` follows git HEAD and raising the service after a commit would
otherwise try to deploy an image nobody has built. It checks the tag is really
in ECR first, then waits up to five minutes for `/healthz` to answer.

Then create the session, open the host console, and check the join page loads
on an actual second machine on an actual network. The failure you are looking
for is a certificate or DNS problem, and it looks identical to "it works" from
a laptop that has the page cached.

### After it

```
make down
```

Do it the same day. A service nobody is watching, left running with a public
URL, is the thing that turns up in a quarterly security review.

### What parking still costs

About **$20 a month**, almost all of it the ALB, which bills whether or not a
task is behind it. Over a year that is roughly $240 to keep a load balancer
warm for eight hours of actual use.

**If that annoys you, destroy instead of park.** `terraform destroy` takes it to
near zero and a fresh apply takes about fifteen minutes, most of it ACM waiting
on DNS validation. Two things go with it that do not come back by themselves:
the DynamoDB table, so export the session first
(`/api/sessions/:sid/export.csv`) if the scores still matter, and the ECR
images, since the repository lives in this same root — so a destroy is always
followed by a `make deploy` rather than a `make up`.

Parking is the default because fifteen minutes of ACM validation on the morning
of an event is a bad place to discover a problem. Destroying is the right call
if the gap between events is months rather than weeks.

## Rolling back

**A bad image.** `make deploy` with the previous commit checked out, or
`terraform apply -var="image_tag=sha-<short>"` from `infra/` directly. That is
the entire rollback: the plan shows one task definition revision and one service
update, and the apply takes about as long as a deploy. The lifecycle policy
keeps the last twenty images, which is further back than a rollback ever needs
to reach.

Reaching for an old tag beats reverting the commit and rebuilding: it is faster,
and it puts back the exact digest that was running rather than a new one built
from the same source.

**A bad infrastructure change.** Revert the commit, then apply it yourself —
`awscreds`, `tfawscreds`, `make apply`. There is no VCS run to pick it up: the
workspace is CLI-driven, for the reasons set out in `versions.tf`. Read the
plan before confirming; that is the moment to check the revert is actually a
revert, and it is the only gate there is.

**Something worse.** The state is in HCP Terraform with full run history;
"what changed, who applied it, what plan did they see" is answerable without
archaeology. DynamoDB has point-in-time recovery, so a table restored to a
timestamp is a console operation, not a rebuild.

**What rollback does to a live session.** The same thing a deploy does — the
task stops and starts, every socket drops, and the room reconnects over about
twenty seconds with their rejoin tokens. Nothing checks for you, which is the
next section.

## Do not deploy during an event

There is no job to enforce this, so it is a rule you keep rather than one the
pipeline keeps for you:

```
make url        # sessionsLive tells you whether anyone is mid-session
```

A deploy replaces the running task. One stateful process means every WebSocket
drops and every surface reconnects into a session that has lost its in-memory
state — during the arcade that is the whole room, at once. If the deploy *is*
the fix, do it anyway; otherwise it waits.

## Things to know before you change something

**`desired_count` is 0 or 1, and a variable validation enforces it.** The
session state lives in the process's memory. A second task is a second,
disagreeing truth, and the ALB would hand it half the room. The service is set
to `minimum_healthy_percent = 0` / `maximum_percent = 100` for the same reason:
a deploy stops the old task before starting the new one.

**There is no NAT gateway, on purpose.** The task sits in a public subnet with a
public IP and a security group that accepts traffic only from the ALB's security
group. A NAT gateway is about US$45 a month — more than everything else here
except the ALB — to move a security boundary from a security group to a route
table. The exposure is the same. If this ever holds something more interesting
than quiz scores, revisit it.

**The AWS permissions are the operator's own, not a role in this repository.**
There is no IAM role for the runner here to read, because there is nothing for
one to attach to: the credentials are a copy of a human's STS session, and the
session's permissions are whatever doormat granted that person. Nothing in
`infra/` grants, assumes or scopes them. The two IAM roles that *are* in here
belong to the task — an execution role that pulls the image, reads the one SSM
parameter and writes logs, and a task role scoped to the one DynamoDB table —
and they are in `modules/service/iam.tf`.

**`.terraform.lock.hcl` is committed, deliberately.** The root `.gitignore`
ignores `.terraform/` and `*.tfstate` and says in as many words that the lock
files are not ignored: they pin provider hashes so a run in HCP Terraform
resolves what was tested here rather than whatever is newest. `~> 6.0` in every
`versions.tf` stops a major-version jump; the lock file is what stops a patch
one. Run `terraform init -upgrade` and commit the result when you mean to move.

## Checking the configuration without credentials

What CI does, and what you can do with no session at all:

```
terraform init -backend=false && terraform validate
terraform fmt -check -recursive
```

That catches a syntax or type error without touching AWS. It cannot catch a
permissions problem or a resource that already exists — for those you need
`make plan`, which needs a session.

CI does one extra thing worth knowing about: the root carries a `cloud` block,
which `init` resolves against HCP Terraform even with `-backend=false`, and CI
has no token for that. So it validates the root as a throwaway copy with the
block stripped, and every module on its own. See the `terraform` job in
`.github/workflows/quorum-ci.yml`.
