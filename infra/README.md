# Quorum infrastructure

This directory holds the Terraform for the AWS part of
[ARCHITECTURE.md](../ARCHITECTURE.md). It has one environment and one
workspace, and a person runs each apply.

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

`infra/` **is** the root. There is no `bootstrap/` and no `envs/`. Both appear in
older drafts of ARCHITECTURE.md, and neither was built. The ECR repository, which
a bootstrap workspace would have owned, is `ecr.tf` here.

## Why there is no pipeline

This account permits no non-human credentials. `iam:CreateOpenIDConnectProvider`
and `iam:CreateUser` are both an explicit deny, and the account holds **0 users
and 0 identity providers** against 46 roles. The policy is deliberate: only a human with a current session can act in this
account.

So there is no OIDC, no access key, no machine identity, and no deploy workflow.
CI still runs the typecheck, tests, `fmt`, `validate`, and a container build
that proves the Dockerfile compiles on every push, and it needs no credential
for any of that. A fork's PR runs all of it. The deploy is `make deploy`, run by
a person.

The service runs for two hours a few times a year, so a manual deploy costs
little. There is no release cadence to automate, and somebody has to be present
to raise the service before an event anyway.

## Remote runs and pushed credentials

State, locking, run history, and the applies themselves all live in HCP
Terraform, in the workspace `quorum`. It is **CLI-driven**: `terraform apply`
runs from here and HCP Terraform executes it. `versions.tf` sets out at length
why connecting it to VCS would break several things at once.

```
export TF_CLOUD_ORGANIZATION=tphan     # the config does not name it: this repo is public
```

The HCP Terraform token comes from `terraform login`. Nothing in this repo
holds it.

### The AWS credentials and their eight-hour expiry

Remote runs execute on HCP Terraform's workers, which need an AWS session of
their own. This account has no static credentials and no identity provider,
so the workers get a copy of *your* STS session, pushed into the **AWS
Authentication** variable set by doormat:

```
awscreds        # new AWS session locally (8 hours)
tfawscreds      # push it into the variable set
```

**Run both, in that order, before any apply.** The image push uses your local
session, and the apply uses the copy in the variable set. If either is stale,
the run fails partway through at the AWS provider with what looks like a
permissions error. If a run fails that way, re-run both and try again.

The credentials go in a variable set because one push then covers every
workspace attached to it. Do not set `AWS_ACCESS_KEY_ID` or the other AWS
variables on a workspace directly. Workspace variables take precedence over a
variable set, so stale values there silently override the fresh ones, and the
failure looks identical to an expired session.

### Attaching the variable set to a new workspace

A workspace created by `terraform init` has no variable set attached, so its
first run fails with no credentials at all. Attach **AWS Authentication** to it
once, under *Workspace → Variables → Variable sets → Apply to this workspace*.

`quorum` is already attached. Any new workspace would need it too.

## What a human has to supply

A person supplies the Terraform variables. They live in a gitignored
`terraform.tfvars` because this repo is public. The CLI uploads that file with
the rest of the directory, which is how the variables reach the workers.

| Variable | This account |
| --- | --- |
| `aws_account_id` | in `terraform.tfvars`, not here |
| `aws_region` | `ap-southeast-2` |
| `hosted_zone_id` | the zone that owns `domain_name`. Somebody delegated it at a registrar, and this configuration does not create it |
| `domain_name` | `quorum.tphan.sbx.hashidemos.io`, which is the `HOST` the Makefile curls |
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

Allow about fifteen minutes for the first apply, most of which is ACM waiting
on DNS validation. Later applies take a couple of minutes.

## Routine commands

Every routine operation is a Makefile target, and none has a button in a UI.
`image_tag` and `desired_count` are the two inputs that change, and each change
should come from a command somebody ran, so that it can be repeated and traced.

```
make check     # is my session alive, is the org set, what account am I in
make deploy    # build, push, and apply the new image
make up        # raise the service before an event
make down      # park it at zero afterwards
make url       # the health endpoint, so you can see it answer
make plan      # what would change
make fmt       # terraform fmt, then the app's typecheck and tests
```

`make stage EVENT=…`, `make sessions`, and `make close SID=…` are the commands
for running an event. They need an AWS session but never touch Terraform: they read the
admin key from SSM and talk to the running service over HTTPS.

## Parked at zero between events

Quorum runs for about two hours, a few times a year. Between events it should
be down, because a parked service costs less and exposes nothing.

**`desired_count = 0` is the resting state.** Everything else stays: the VPC,
the ALB, the certificate, the DNS records, and the table and its data. No task
is running, so nothing serves requests and nothing can leak.

### Before an event

```
make up
```

Run it a day ahead of the event. `make up` re-applies with `desired_count = 1` at the
tag already in state. It deliberately does **not** change which image runs,
because `TAG` follows git HEAD and raising the service after a commit would
otherwise try to deploy an image nobody has built. It checks that the tag is
in ECR first, then waits up to five minutes for `/healthz` to answer.

Then create the session, open the host console, and check that the join page
loads on a second machine on a different network. This check looks for a
certificate or DNS problem, which a laptop that has the page cached will not
show.

### After it

```
make down
```

Do it the same day. A service left running with a public URL and nobody
watching it will turn up in a quarterly security review.

### What parking still costs

Parking costs about **$20 a month**, almost all of it for the ALB, which bills
whether or not a task is running. Over a year, that is roughly $240 to keep a
load balancer running for eight hours of use.

**To avoid that cost, destroy instead of park.** `terraform destroy` takes it to
near zero and a fresh apply takes about fifteen minutes, most of it ACM waiting
on DNS validation. Two things go with it that do not come back by themselves:
the DynamoDB table, so export the session first
(`/api/sessions/:sid/export.csv`) if the scores still matter, and the ECR
images, because the repository lives in this same root. So a destroy is always
followed by a `make deploy` instead of a `make up`.

Parking is the default because a problem with ACM validation would otherwise
surface during a fifteen-minute apply on the morning of an event. Destroy
instead if the gap between events is months rather than weeks.

## Rolling back

**A bad image.** `make deploy` with the previous commit checked out, or
`terraform apply -var="image_tag=sha-<short>"` from `infra/` directly. That is
the whole rollback: the plan shows one task definition revision and one service
update, and the apply takes about as long as a deploy. The lifecycle policy
keeps the last twenty images, which is further back than a rollback ever needs
to reach.

Deploying an old tag is better than reverting the commit and rebuilding. It is
faster, and it restores the exact digest that was running instead of a new one
built from the same source.

**A bad infrastructure change.** Revert the commit, then apply it yourself with
`awscreds`, `tfawscreds`, and `make apply`. No VCS run will pick it up, because
the workspace is CLI-driven for the reasons set out in `versions.tf`. Read the
plan before confirming it to check that the revert undoes the change. Nothing
else checks it.

**Something worse.** The state is in HCP Terraform with full run history,
so the run history shows what changed, who applied it, and which plan they saw.
DynamoDB has point-in-time recovery, so restoring the table to a timestamp is
an operation in the AWS console.

**What rollback does to a live session.** A rollback has the same effect as a
deploy. The task stops and starts, every socket drops, and the room reconnects
over about twenty seconds with their rejoin tokens. Nothing checks for a live
session first, as the next section explains.

## Do not deploy during an event

No job enforces this, so check for a live session yourself before deploying:

```
make url        # sessionsLive tells you whether anyone is mid-session
```

A deploy replaces the running task. Because there is one stateful process, every WebSocket
drops and every surface reconnects into a session that has lost its in-memory
state. During the arcade, that is the whole room at once. Deploy during an event
only if the deploy *is* the fix for a problem in that event, and otherwise wait
until it ends.

## Things to know before you change something

**`desired_count` is 0 or 1, and a variable validation enforces it.** The
session state lives in the process's memory. A second task would hold a second
copy of the state that disagrees with the first, and the ALB would send it half
the room. The service sets `minimum_healthy_percent = 0` and `maximum_percent = 100`
for the same reason, so a deploy stops the old task before starting the new one.

**There is no NAT gateway, on purpose.** The task sits in a public subnet with a
public IP and a security group that accepts traffic only from the ALB's security
group. A NAT gateway costs about US$45 a month, which is more than everything else
here except the ALB, and it would only move the security boundary from a
security group to a route table without reducing the exposure. If this service
ever holds anything more sensitive than quiz scores, revisit the decision.

**The AWS permissions are the operator's own.** This repository has no IAM
role for the runner, because there is nothing for one to attach to: the credentials are a copy of a human's STS session, and the
session's permissions are whatever doormat granted that person. Nothing in
`infra/` grants, assumes, or scopes them. The two IAM roles that *are* in here
belong to the task, and they are in `modules/service/iam.tf`. One is an
execution role that pulls the image, reads the one SSM parameter, and writes
logs. The other is a task role scoped to the one DynamoDB table.

**`.terraform.lock.hcl` is committed, deliberately.** The root `.gitignore`
ignores `.terraform/` and `*.tfstate` and states explicitly that the lock
files are not ignored. They pin provider hashes, so a run in HCP Terraform
resolves the versions tested here instead of whatever is newest. `~> 6.0` in every
`versions.tf` stops a major-version upgrade, and the lock file stops a patch
upgrade. Run `terraform init -upgrade` and commit the result when you mean to move.

## Checking the configuration without credentials

CI runs these checks, and you can run them with no session at all:

```
terraform init -backend=false && terraform validate
terraform fmt -check -recursive
```

That catches a syntax or type error without touching AWS. It cannot catch a
permissions problem or a resource that already exists. For those, run
`make plan`, which needs a session.

CI does one more thing. The root carries a `cloud` block,
which `init` resolves against HCP Terraform even with `-backend=false`, and CI
has no token for that. So it validates the root as a throwaway copy with the
block stripped, and every module on its own. See the `terraform` job in
`.github/workflows/quorum-ci.yml`.
