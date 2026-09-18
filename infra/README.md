# Quorum — infrastructure

Terraform for the AWS side of [ARCHITECTURE.md](../ARCHITECTURE.md). Three
workspaces, one of which a human applies by hand exactly once.

```
infra/
├── bootstrap/        OIDC providers, the two IAM roles, the ECR repository.
│                     CLI-driven. Applied by a human with their own credentials.
├── modules/
│   ├── network/      VPC, two public subnets, the two security groups
│   ├── service/      ALB, ACM, Route 53, ECS cluster/task/service, logs, alarm
│   └── data/         DynamoDB table, SSM parameter for the admin key
└── envs/
    ├── staging/      workspace quorum-staging, auto-apply
    └── prod/         workspace quorum-prod, manual confirm
```

Nothing here holds a long-lived AWS credential. HCP Terraform runs and GitHub
Actions both authenticate with OIDC against roles the bootstrap workspace
creates. The only stored credential in the whole system is a HCP Terraform team
token in a GitHub secret, and it can set a variable and queue a run — nothing
else.

## Why there is no pipeline

This account permits no non-human credentials. `iam:CreateOpenIDConnectProvider`
and `iam:CreateUser` are both an explicit deny, and the account holds **0 users
and 0 identity providers** against 46 roles. That is a deliberate policy, not a
gap: only a human with a current session acts here.

So there is no OIDC, no access key, no machine identity and no deploy workflow.
CI still runs on every push — typecheck, tests, `fmt`, `validate`, and a
container build to prove the Dockerfile compiles — and it needs no credential to
do any of that. The deploy is `make deploy`, run by a person.

For a service that runs two hours a few times a year this is the right shape.
There is no release cadence to automate, and somebody has to be present to
raise the service before an event regardless.

**Sessions last eight hours.** Run `awscreds` first. If an apply dies partway
with `ExpiredToken`, re-run `awscreds` and apply again — Terraform picks up
where it stopped.

## State is remote, execution is local

State, locking and run history live in HCP Terraform. The apply runs on your
machine, with your session.

```
export TF_CLOUD_ORGANIZATION=tphan     # the config does not name it: this repo is public
```

The token comes from `terraform login`, which writes
`~/.terraform.d/credentials.tfrc.json`. Nothing in this repo holds it.

**Each workspace must be set to Local execution mode.** Remote is the default
and it will not work here: HCP Terraform would run the apply on its own workers,
which have no AWS credentials — which is the entire reason this project deploys
from a laptop. The failure is a provider authentication error partway into a
run, which reads like an AWS problem and is not one.

In the workspace: *Settings → General → Execution Mode → Local*. Both
`quorum-bootstrap` and `quorum-prod`.

State lives there rather than on the laptop deliberately. A state file for real
infrastructure existing in exactly one place, on one machine, is how you end up
with resources nobody can delete.

## What a human has to supply

Terraform variables, per environment. They live in a gitignored
`terraform.tfvars` because this repo is public.

| Variable | This account |
| --- | --- |
| `aws_account_id` | in `terraform.tfvars`, not here |
| `aws_region` | `ap-southeast-2` |
| `hosted_zone_id` | the zone owning `tphan.aws.hashidemos.io` |
| `domain_name` | `quorum.tphan.aws.hashidemos.io` |
| `image_tag` | set by `make deploy`; any existing tag for the first apply |
| `desired_count` | `0` at rest |

## First run, from nothing

```
awscreds                                  # eight hours
export TF_CLOUD_ORGANIZATION=tphan
make check                                # confirms the session and the account
cd infra/bootstrap && terraform init && terraform apply    # the ECR registry
make deploy                               # build, push, apply
make up                                   # raise it and wait for /healthz
```

Budget about fifteen minutes for the first apply; most of it is ACM waiting on
DNS validation. After that an apply is a couple of minutes.

## Day to day

```
make up        # before an event
make url       # is it answering
make down      # after
make plan      # what would change
```

## Parked at zero between events

Quorum runs for about two hours, a few times a year. It is not a service that
should be up in between, and it is cheaper and safer parked.

**`desired_count = 0` is the resting state.** Everything else stays: the VPC,
the ALB, the certificate, the DNS records, the table and its data. There is
simply no task running, so nothing serves and nothing can leak.

### Before an event

```
# a day ahead, not an hour: an image build and an apply both take minutes
set desired_count = 1 on the workspace, queue a run
curl https://quorum.tphan.aws.hashidemos.io/healthz     # {"ok":true,...}
```

Then create the session, open the host console, and check the join page loads
on an actual phone on actual mobile data. The failure you are looking for is a
certificate or DNS problem, and it looks identical to "it works" from a laptop
that has the page cached.

### After it

```
set desired_count = 0, queue a run
```

Do it the same day. A service nobody is watching, left running with a public
URL, is the thing that turns up in a quarterly security review.

### What parking still costs

About **$20 a month**, almost all of it the ALB, which bills whether or not a
task is behind it. Over a year that is roughly $240 to keep a load balancer
warm for eight hours of actual use.

**If that annoys you, destroy instead of park.** `terraform destroy` on the
env workspace takes it to near zero — the Route 53 zone and the ECR images are
outside the env and survive — and a fresh apply takes about fifteen minutes,
most of it ACM waiting on DNS validation. The table goes with it, so export
the session first (`/api/sessions/:sid/export.csv`) if the scores still matter.

Parking is the default because fifteen minutes of ACM validation on the morning
of an event is a bad place to discover a problem. Destroying is the right call
if the gap between events is months rather than weeks.

## Rolling back

**A bad image.** Set `image_tag` on the workspace to the previous
`sha-<short>` and queue a run. That is the entire rollback: the plan will show
one task definition revision and one service update, and the apply takes about
as long as a deploy. The lifecycle policy keeps the last twenty images, which is
further back than a rollback ever needs to reach.

It is also worth doing from the HCP Terraform UI rather than from git. Reverting
the commit works too, but it rebuilds — a slower path to an image you already
have, and a different digest.

**A bad infrastructure change.** Revert the commit and let the VCS run apply it.
For prod, a human confirms the plan, which is the moment to check that the
revert is actually a revert.

**Something worse.** The state is in HCP Terraform with full run history;
"what changed, who applied it, what plan did they see" is answerable without
archaeology. DynamoDB has point-in-time recovery, so a table restored to a
timestamp is a console operation, not a rebuild.

**What rollback does to a live session.** The same thing a deploy does — the
task stops and starts, every socket drops, and the room reconnects over about
twenty seconds with their rejoin tokens. The freeze checks in the deploy
workflow exist so that this is never a surprise; a rollback done by hand in the
HCP Terraform UI bypasses them, so check `/healthz` first.

## Do not deploy during an event

There is no job to enforce this any more, so it is a rule you keep rather than
one the pipeline keeps for you. `make check` before you deploy, and:

```
make url        # sessionsLive tells you whether anyone is mid-session
```

A deploy replaces the running task. One stateful process means every WebSocket
drops and every phone reconnects into a session that has lost its in-memory
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

**`quorum-tfc-run` has `PowerUserAccess`, not a hand-rolled allow-list.** It
manages a VPC, an ALB, ECS, DynamoDB, ACM, Route 53, SSM and CloudWatch, and an
allow-list of exactly those calls is a policy that needs editing every time a
resource gains an argument, with a half-applied environment as the failure mode.
The IAM permissions it genuinely needs are granted separately and scoped to
`quorum-*` role names, plus an explicit deny on the bootstrap roles and OIDC
providers — so the role cannot grant itself more privilege or rewrite the trust
policy that governs it. The tighter version, when it is wanted, is the
plan/apply role split ARCHITECTURE.md describes; the mechanism does not change.

**`.terraform.lock.hcl` is gitignored** by the repository root `.gitignore`.
Provider versions are pinned with `~> 6.0` in every `versions.tf`, so a run
cannot cross a major version, but patch versions will drift between runs.
Committing the lock files would remove that drift and is worth doing if a
provider release ever surprises anyone.

## Checking the configuration without credentials

What CI does, and what you can do with no session at all:

```
terraform init -backend=false && terraform validate
terraform fmt -check -recursive
```

That catches a syntax or type error without touching AWS. It cannot catch a
permissions problem or a resource that already exists — for those you need
`make plan`, which needs a session.
