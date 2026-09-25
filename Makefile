# Quorum — local operations.
#
# There is no machine identity: the account forbids IAM users and identity
# providers, so nothing acts here except a human with a current session.
#
#   awscreds     a new AWS session locally          (8 hours)
#   tfawscreds   push that session to HCP Terraform (for the remote apply)
#
# Both, in that order, before an apply. The image push uses your local session;
# the apply uses the copy in the variable set. Either being stale fails the same
# way, partway in, looking like a permissions problem.
#
#   make check     is my session alive, is the org set, what account am I in
#   make deploy    build, push, and apply the new image
#   make up        raise the service before an event
#   make down      park it at zero afterwards
#   make url       the health endpoint, so you can see it answer

REGION  ?= ap-southeast-2
REPO    ?= quorum
# Derived from the live session rather than written down: this repo is public,
# and an account id in it would be gratuitous. It also cannot drift.
ACCOUNT  = $(shell aws sts get-caller-identity --query Account --output text 2>/dev/null)
TAG     ?= sha-$(shell git rev-parse --short=7 HEAD)
REGISTRY = $(ACCOUNT).dkr.ecr.$(REGION).amazonaws.com
# Docker or Podman, whichever is here. Docker Desktop needs a paid licence at
# company size and is not always permitted; Podman is a drop-in for the three
# commands this file uses (`build --platform`, `login`, `push`). Override with
# `make ENGINE=... ` if you have something else.
ENGINE  ?= $(shell command -v docker 2>/dev/null || command -v podman 2>/dev/null)
HOST    ?= quorum.tphan.sbx.hashidemos.io
INFRA    = infra

.PHONY: check deploy build push apply up down url plan fmt

## Fail early and clearly rather than three minutes into an apply.
## Just an AWS session. Staging reads the admin key from SSM and talks to the
## running service over HTTPS; it never touches Terraform, and requiring the
## HCP organisation for it turned "load tomorrow's questions" into "configure
## your infrastructure tooling first".
aws-check:
	@aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null \
	  || { echo "No AWS session. Run: awscreds"; exit 1; }

check: aws-check
	@test -n "$(TF_CLOUD_ORGANIZATION)" \
	  || { echo "TF_CLOUD_ORGANIZATION is unset. Run: export TF_CLOUD_ORGANIZATION=tphan"; exit 1; }
	@echo "region   $(REGION)"
	@echo "infra    $(INFRA)  (workspace: quorum)"
	@echo "image    $(REGISTRY)/$(REPO):$(TAG)"

## --platform is not optional. This is built on whatever laptop or runner is to
## hand — an Apple Silicon Mac produces arm64, a GitHub runner amd64 — while
## the Fargate task definition asks for linux/amd64. Without pinning it, the
## image builds, pushes and passes every local test, then fails in Fargate with
## "Manifest does not contain descriptor matching platform", which names the
## problem but not the cause. Pinning makes the artifact identical wherever it
## is built.
build:
	$(ENGINE) build --platform linux/amd64 \
	  -t $(REGISTRY)/$(REPO):$(TAG) -t $(REGISTRY)/$(REPO):latest app

push: check
	aws ecr get-login-password --region $(REGION) \
	  | $(ENGINE) login --username AWS --password-stdin $(REGISTRY)
	$(ENGINE) push $(REGISTRY)/$(REPO):$(TAG)
	$(ENGINE) push $(REGISTRY)/$(REPO):latest

## The apply is the deploy: the image tag is a Terraform variable, so the task
## definition has one owner and the plan of a deploy is a reviewable diff.
apply: check
	cd $(INFRA) && terraform init -input=false && \
	  terraform apply -var="image_tag=$(TAG)"

deploy: build push apply

plan: check
	cd $(INFRA) && terraform init -input=false && \
	  terraform plan -var="image_tag=$(TAG)"

## The tag currently deployed, read from state. `up` and `down` must not change
## which image runs — TAG follows git HEAD, so raising the service after a
## commit would otherwise try to deploy an image nobody has built, and the task
## would fail to pull. Changing the image is what `deploy` is for.
DEPLOYED = $(shell cd $(INFRA) && terraform output -raw image 2>/dev/null | sed 's/.*://')

## Before an event. Do this a day ahead, not an hour: a certificate or DNS
## problem looks exactly like success from a laptop with the page cached.
up: check
	@test -n "$(DEPLOYED)" || { echo "Nothing deployed yet. Run: make deploy"; exit 1; }
	@# Fail here rather than in Fargate. A tag in state that is not in ECR
	@# surfaces as CannotPullContainerError in the service events, minutes
	@# later, while /healthz just never answers — a slow way to learn it.
	@aws ecr describe-images --repository-name $(REPO) --image-ids imageTag=$(DEPLOYED) 	  --region $(REGION) >/dev/null 2>&1 	  || { echo "$(DEPLOYED) is not in ECR. Run: make deploy"; exit 1; }
	@echo "raising $(DEPLOYED)"
	cd $(INFRA) && terraform apply -auto-approve -var="image_tag=$(DEPLOYED)" -var="desired_count=1"
	@echo "Waiting for the service to answer..."
	@for i in $$(seq 1 60); do \
	  if curl -fsS https://$(HOST)/healthz >/dev/null 2>&1; then \
	    echo "up:"; curl -fsS https://$(HOST)/healthz; echo; exit 0; \
	  fi; sleep 5; \
	done; echo "Still not answering after five minutes. Check the ECS service events."; exit 1

## After it. Same day — a service nobody is watching, on a public URL, is what
## turns up in a security review.
down: check
	@test -n "$(DEPLOYED)" || { echo "Nothing deployed."; exit 1; }
	cd $(INFRA) && terraform apply -auto-approve -var="image_tag=$(DEPLOYED)" -var="desired_count=0"
	@echo "Parked. The ALB stays up; that is the ~\$$20/month floor."

## Stage an event: create the session, load its questions, stage the console's
## setup, and print the tokens. Run it the morning of, from a terminal, with
## AWS credentials — the admin key is read from SSM and never stored here.
stage: aws-check
	@test -n "$(EVENT)" || { echo "Set EVENT, e.g. make stage EVENT=2026-03-12-example-offsite"; exit 1; }
	@test -d config/events/$(EVENT) || { echo "No config/events/$(EVENT)"; exit 1; }
	@cd app && QUORUM_URL="https://$(HOST)" \
	  QUORUM_ADMIN_KEY="$$(aws ssm get-parameter --name /quorum/prod/admin_key \
	    --with-decryption --region $(REGION) --query Parameter.Value --output text)" \
	  EVENT="$(EVENT)" node scripts/stage-event.mjs

## Every session this task knows about. Needs the admin key, which is the only
## credential that outlives a session: a host token is printed once and stored
## hashed, so a session whose tokens are lost cannot be closed from its console.
sessions: aws-check
	@QUORUM_ADMIN_KEY="$$(aws ssm get-parameter --name /quorum/prod/admin_key \
	    --with-decryption --region $(REGION) --query Parameter.Value --output text)"; \
	  curl -fsS "https://$(HOST)/api/sessions" -H "Authorization: Bearer $$QUORUM_ADMIN_KEY" \
	  | python3 -c 'import json,sys; \
rows=json.load(sys.stdin)["sessions"]; \
print("  no sessions") if not rows else None; \
[print("  %-24s %-8s %-9s %3dp %2ds %5dm  %s" % (r["sid"], r["phase"], r["segment"], r["participants"], r["sockets"], r["ageMinutes"], r["title"][:34])) for r in rows]'

## Retire one. Refuses a session with anyone connected unless FORCE=1.
close: aws-check
	@test -n "$(SID)" || { echo "Set SID, e.g. make close SID=ses_abc123"; exit 1; }
	@QUORUM_ADMIN_KEY="$$(aws ssm get-parameter --name /quorum/prod/admin_key \
	    --with-decryption --region $(REGION) --query Parameter.Value --output text)"; \
	  curl -fsS -X POST "https://$(HOST)/api/sessions/$(SID)/close$(if $(FORCE),?force=1,)" \
	    -H "Authorization: Bearer $$QUORUM_ADMIN_KEY" \
	  && echo "  closed $(SID)" \
	  || echo "  refused. Somebody may be connected; add FORCE=1 to close it anyway."

url:
	@curl -fsS https://$(HOST)/healthz || echo "not answering (parked?)"

fmt:
	terraform fmt -recursive infra/
	cd app && npm run typecheck && npm test
