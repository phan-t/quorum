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

## What a human has to supply

Terraform cannot invent an account id or a domain, so these are variables with
no default. An apply without them fails at plan time, which is the correct place
to find out.

| | Where | |
| --- | --- | --- |
| `aws_account_id` | all three workspaces | Twelve digits. Also the account half of every role ARN |
| `aws_region` | all three | `ap-southeast-2` in the design |
| `tfc_organization` | bootstrap | Baked verbatim into the `quorum-tfc-run` trust policy |
| `tfc_project` | bootstrap | The project the three workspaces live in |
| `github_repository` | bootstrap | `org/repo`. Only this repo's `main` may push images |
| `hosted_zone_id` | staging, prod | A Route 53 zone that already exists |
| `domain_name` | staging, prod | The hostname for that environment |
| `image_tag` | staging, prod | Set by the deploy workflow; set by hand for the first apply |

`TF_CLOUD_ORGANIZATION` is an environment variable rather than a value in the
`cloud {}` block, because this repository is public and an org name has no
business being hardcoded in it. Export it before `terraform init`.

See the `terraform.tfvars.example` in each directory for the annotated list.

## Bootstrap order

It runs in this order because each step creates the thing the next one
authenticates with. There is no way to shorten it, and it only happens once.

**1. Create the three workspaces in HCP Terraform.** In one project, named
`quorum-bootstrap`, `quorum-staging`, `quorum-prod`.

| Workspace | Working directory | Execution | Apply | Trigger patterns |
| --- | --- | --- | --- | --- |
| `quorum-bootstrap` | `infra/bootstrap` | CLI-driven | manual | — |
| `quorum-staging` | `infra/envs/staging` | VCS-driven | auto | `infra/envs/staging/**`, `infra/modules/**` |
| `quorum-prod` | `infra/envs/prod` | VCS-driven | manual | `infra/envs/prod/**`, `infra/modules/**` |

The trigger patterns are what make a module change plan in both environments and
a staging-only change plan in staging only.

**2. Apply bootstrap, from a laptop, with your own AWS credentials.**

```
export TF_CLOUD_ORGANIZATION=<your org>
cd infra/bootstrap
cp terraform.tfvars.example terraform.tfvars   # fill it in
terraform init
terraform apply
```

This is the one deliberately manual step, and the reason is circular: it creates
the OIDC providers and the `quorum-tfc-run` role that every other workspace uses
to authenticate. Nothing can apply it except a human who already has access.
It is touched again only to change a trust policy.

It also creates the ECR repository. One repository, shared by both
environments, because staging and prod run the same image and promoting a tag
beats rebuilding one and hoping the result is identical — which means it cannot
belong to either environment's workspace, and belongs here with the other things
that exist before an environment can.

Note the outputs; the next two steps are made of them.

**3. Wire the environment workspaces.** On `quorum-staging` and `quorum-prod`,
as **environment** variables:

```
TFC_AWS_PROVIDER_AUTH = true
TFC_AWS_RUN_ROLE_ARN  = <tfc_run_role_arn output>
```

That is the whole AWS credential configuration. Every run now mints a
credential that expires when the run does.

Then the **Terraform** variables from the table above: `aws_account_id`,
`aws_region`, `hosted_zone_id`, `domain_name`, and `image_tag`.

**4. Wire GitHub.** Repository variables:

| | |
| --- | --- |
| `AWS_REGION` | `ap-southeast-2` |
| `AWS_ROLE_ARN` | `gha_ecr_push_role_arn` output |
| `ECR_REPOSITORY` | `quorum` |
| `TFC_ORGANIZATION` | your org |
| `TFC_WORKSPACE_STAGING` | `quorum-staging` |
| `TFC_WORKSPACE_PROD` | `quorum-prod` |
| `QUORUM_DEPLOY_FREEZE` | unset, normally. See below |

And one repository secret, `TFC_TOKEN`: a HCP Terraform **team token** scoped to
the two environment workspaces. It is the only stored credential here. HCP
Terraform does not yet accept GitHub's OIDC tokens for API calls; when it does,
this goes too.

**5. Build and push one image by hand,** so there is something for the first
apply to run. After this, the workflow does it.

```
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker build -t <account>.dkr.ecr.<region>.amazonaws.com/quorum:sha-$(git rev-parse --short=7 HEAD) app
docker push <account>.dkr.ecr.<region>.amazonaws.com/quorum:sha-$(git rev-parse --short=7 HEAD)
```

Set that tag as `image_tag` on `quorum-staging`.

**6. Apply staging.** Queue a run on `quorum-staging`. It will sit for a few
minutes on the ACM certificate, which cannot be issued until its DNS validation
record propagates. Expect roughly fifteen minutes end to end on a first apply.

**7. Set the admin key.** The apply created the SSM parameter with a
placeholder and stopped caring about its value:

```
aws ssm put-parameter --name /quorum/staging/admin_key --type SecureString \
  --value "$(openssl rand -base64 24)" --overwrite --region <region>
```

Terraform never sees the real value. State is encrypted at rest, but plan output
is visible to anyone who can see a run, and a secret in a Terraform variable is
a secret in every plan from then on. The task picks the new value up on its
next start, because ECS resolves `secrets` at task start and not after.

**8. Start it.** Staging's `desired_count` defaults to `0` — parked, so Fargate
costs nothing between rehearsals. Set it to `1`, queue a run, and the URL in the
`url` output answers.

Prod is steps 3 and 6 through 8 again, against `quorum-prod`.

## After that, nobody touches a console

A merge to `main` that changes `app/**` builds an image, pushes it, sets
`image_tag` on the workspace and queues a run. A merge that changes `infra/**`
queues its own run from the VCS connection and picks up whatever `image_tag` is
already set. The two are orthogonal inputs to the same owner, which is the point
of making the image a variable rather than having Actions call `UpdateService`.

A pull request gets `tsc --noEmit`, the tests, a container build that is not
pushed, `terraform fmt -check` and `validate` — and a speculative plan per
environment, posted by HCP Terraform itself.

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

## The deploy freeze

Three things stop a deploy landing in the middle of an event, because "don't
deploy during the huddle" on its own is a Slack message someone missed:

1. `/healthz` reports `sessionsLive`. The prod release job reads it and fails,
   with the count in the message, if it is non-zero.
2. `QUORUM_DEPLOY_FREEZE`, a repository variable. `1` freezes indefinitely; a
   `YYYY-MM-DD` date freezes that UTC day and then stops mattering, so nobody
   has to remember to clear it. Set it the day before — it catches the session
   that is about to start and does not yet count as live.
3. Prod applies wait for a human in HCP Terraform. Even if both checks are
   wrong, someone has to click, and someone clicking at 2:45pm on an event day
   is a person who can be asked to wait.

`workflow_dispatch` with `force: true` overrides 1 and 2, for the case where the
deploy *is* the fix.

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

## Running a plan from a laptop

```
export TF_CLOUD_ORGANIZATION=<your org>
cd infra/envs/staging
terraform init
terraform plan
```

Against a VCS-driven workspace that is a speculative plan: it reads state,
shows a diff, and cannot apply. Which is all a laptop should be able to do.

To check the configuration without any credential at all — which is what CI
does:

```
terraform init -backend=false && terraform validate
```
