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
HOST    ?= quorum.tphan.sbx.hashidemos.io
INFRA    = infra

.PHONY: check deploy build push apply up down url plan fmt

## Fail early and clearly rather than three minutes into an apply.
check:
	@aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null \
	  || { echo "No AWS session. Run: awscreds && tfawscreds"; exit 1; }
	@test -n "$(TF_CLOUD_ORGANIZATION)" \
	  || { echo "TF_CLOUD_ORGANIZATION is unset. Run: export TF_CLOUD_ORGANIZATION=tphan"; exit 1; }
	@echo "region   $(REGION)"
	@echo "infra    $(INFRA)  (workspace: quorum)"
	@echo "image    $(REGISTRY)/$(REPO):$(TAG)"

build:
	docker build -t $(REGISTRY)/$(REPO):$(TAG) -t $(REGISTRY)/$(REPO):latest app

push: check
	aws ecr get-login-password --region $(REGION) \
	  | docker login --username AWS --password-stdin $(REGISTRY)
	docker push $(REGISTRY)/$(REPO):$(TAG)
	docker push $(REGISTRY)/$(REPO):latest

## The apply is the deploy: the image tag is a Terraform variable, so the task
## definition has one owner and the plan of a deploy is a reviewable diff.
apply: check
	cd $(INFRA) && terraform init -input=false && \
	  terraform apply -var="image_tag=$(TAG)"

deploy: build push apply

plan: check
	cd $(INFRA) && terraform init -input=false && \
	  terraform plan -var="image_tag=$(TAG)"

## Before an event. Do this a day ahead, not an hour: a certificate or DNS
## problem looks exactly like success from a laptop with the page cached.
up: check
	cd $(INFRA) && terraform apply -var="image_tag=$(TAG)" -var="desired_count=1"
	@echo "Waiting for the service to answer..."
	@for i in $$(seq 1 60); do \
	  if curl -fsS https://$(HOST)/healthz >/dev/null 2>&1; then \
	    echo "up:"; curl -fsS https://$(HOST)/healthz; echo; exit 0; \
	  fi; sleep 5; \
	done; echo "Still not answering after five minutes. Check the ECS service events."; exit 1

## After it. Same day — a service nobody is watching, on a public URL, is what
## turns up in a security review.
down: check
	cd $(INFRA) && terraform apply -var="image_tag=$(TAG)" -var="desired_count=0"
	@echo "Parked. The ALB stays up; that is the ~\$$20/month floor."

url:
	@curl -fsS https://$(HOST)/healthz || echo "not answering (parked?)"

fmt:
	terraform fmt -recursive infra/
	cd app && npm run typecheck && npm test
