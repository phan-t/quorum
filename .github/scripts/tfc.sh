#!/usr/bin/env bash
#
# The three HCP Terraform API calls the deploy workflow makes.
#
# `hashicorp/tfc-workflows-github` has an action for creating a run, but not for
# setting a workspace variable, and the image tag *is* a workspace variable —
# that is the deploy decision in ARCHITECTURE.md. Rather than run half the
# interaction through an action and half through the API, both go through the
# API, so there is one mechanism to understand and one place a failure can come
# from.
#
# Auth is TF_API_TOKEN, a team token scoped to the two environment workspaces.
# It is the only stored credential in this repository; see ARCHITECTURE.md,
# "Credentials". AWS access is OIDC and has no stored key at all.

set -euo pipefail

: "${TF_API_TOKEN:?TF_API_TOKEN is required}"
: "${TF_CLOUD_ORGANIZATION:?TF_CLOUD_ORGANIZATION is required}"
TF_HOSTNAME="${TF_HOSTNAME:-app.terraform.io}"

api() {
  local method="$1" path="$2"
  shift 2
  curl --fail-with-body --silent --show-error \
    --header "Authorization: Bearer ${TF_API_TOKEN}" \
    --header "Content-Type: application/vnd.api+json" \
    --request "${method}" \
    "https://${TF_HOSTNAME}/api/v2${path}" "$@"
}

workspace_id() {
  api GET "/organizations/${TF_CLOUD_ORGANIZATION}/workspaces/$1" | jq -r '.data.id'
}

# set-var <workspace> <name> <value>
#
# Terraform variables on a VCS-driven workspace are not versioned with the code,
# by design: the image tag changes far more often than the configuration does,
# and making it a variable is what keeps a code change and an image change
# orthogonal inputs to the same owner.
set_var() {
  local ws_id name value var_id
  ws_id="$(workspace_id "$1")"
  name="$2"
  value="$3"

  var_id="$(api GET "/workspaces/${ws_id}/vars" \
    | jq -r --arg n "$name" '.data[] | select(.attributes.key == $n and .attributes.category == "terraform") | .id' \
    | head -n1)"

  if [ -n "$var_id" ]; then
    api PATCH "/workspaces/${ws_id}/vars/${var_id}" --data @- >/dev/null <<JSON
{"data":{"id":"${var_id}","type":"vars","attributes":{"value":"${value}"}}}
JSON
    echo "set ${name}=${value} on $1 (${var_id})"
  else
    # First deploy into a fresh workspace. Created as a Terraform variable, HCL
    # false, non-sensitive: an image tag is a fact about a build, not a secret,
    # and hiding it would make every plan harder to read.
    api POST "/workspaces/${ws_id}/vars" --data @- >/dev/null <<JSON
{"data":{"type":"vars","attributes":{"key":"${name}","value":"${value}","category":"terraform","hcl":false,"sensitive":false,"description":"Container image tag. Set by the deploy workflow."}}}
JSON
    echo "created ${name}=${value} on $1"
  fi
}

# create-run <workspace> <message>  ->  prints the run id, and writes run_id and
# run_url to $GITHUB_OUTPUT when it is set.
#
# Updating a variable does not queue a run on a VCS-driven workspace, so this is
# required. The run uses the tracked branch's current commit, which is the same
# commit that built the image, because this only ever runs on merge to main.
create_run() {
  local ws_id run_id
  ws_id="$(workspace_id "$1")"

  run_id="$(api POST "/runs" --data @- <<JSON | jq -r '.data.id'
{"data":{"type":"runs","attributes":{"message":$(printf '%s' "$2" | jq -Rs .)},"relationships":{"workspace":{"data":{"type":"workspaces","id":"${ws_id}"}}}}}
JSON
)"

  echo "run ${run_id}: https://${TF_HOSTNAME}/app/${TF_CLOUD_ORGANIZATION}/workspaces/$1/runs/${run_id}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "run_id=${run_id}"
      echo "run_url=https://${TF_HOSTNAME}/app/${TF_CLOUD_ORGANIZATION}/workspaces/$1/runs/${run_id}"
    } >>"${GITHUB_OUTPUT}"
  fi
}

# wait-run <run id> [timeout seconds]
#
# For the auto-apply workspace only. A run that stops at `planned` on a
# manual-confirm workspace is waiting for a human and is not this job's problem.
wait_run() {
  local run_id="$1" timeout="${2:-1800}" deadline status
  deadline=$(( $(date +%s) + timeout ))

  while :; do
    status="$(api GET "/runs/${run_id}" | jq -r '.data.attributes.status')"
    case "$status" in
      applied|planned_and_finished)
        echo "run ${run_id}: ${status}"
        return 0
        ;;
      errored|canceled|force_canceled|discarded)
        echo "run ${run_id}: ${status}" >&2
        return 1
        ;;
      planned|policy_override)
        echo "run ${run_id}: ${status} — waiting for a human. This workspace was expected to auto-apply." >&2
        return 1
        ;;
    esac

    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "run ${run_id}: still ${status} after ${timeout}s" >&2
      return 1
    fi

    echo "run ${run_id}: ${status}"
    sleep 10
  done
}

# outputs <workspace> <output name>
outputs() {
  local ws_id
  ws_id="$(workspace_id "$1")"
  api GET "/workspaces/${ws_id}/current-state-version-outputs" \
    | jq -r --arg n "$2" '.data[] | select(.attributes.name == $n) | .attributes.value'
}

case "${1:-}" in
  set-var)    set_var "$2" "$3" "$4" ;;
  create-run) create_run "$2" "$3" ;;
  wait-run)   wait_run "$2" "${3:-1800}" ;;
  output)     outputs "$2" "$3" ;;
  *)
    echo "usage: tfc.sh {set-var <ws> <name> <value>|create-run <ws> <message>|wait-run <run id> [timeout]|output <ws> <name>}" >&2
    exit 2
    ;;
esac
