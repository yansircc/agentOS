#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: scripts/parallel-dev/create-cst-agent.sh <task-id> <agent-id> <slug> [base-ref]

Creates one CST-claimed parallel worker:
  1. takes <task-id> in the source checkout
  2. creates an isolated git worktree through create-agent.sh
  3. writes CST claim metadata and a central-store cst() wrapper into env.sh

The worker must source the generated env.sh before running any cst command.
USAGE
}

if [[ $# -lt 3 || $# -gt 4 ]]; then
  usage
  exit 2
fi

task_id="$1"
agent_id="$2"
slug="$3"
base_ref="${4:-HEAD}"

if [[ ! "$task_id" =~ ^[0-9]+$ ]]; then
  echo "invalid task-id: $task_id" >&2
  exit 2
fi

if [[ ! "$agent_id" =~ ^[a-z0-9-]+$ ]]; then
  echo "invalid agent-id: $agent_id" >&2
  exit 2
fi

if [[ ! "$slug" =~ ^[a-z0-9-]+$ ]]; then
  echo "invalid slug: $slug" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! command -v cst >/dev/null 2>&1; then
  echo "cst command not found" >&2
  exit 1
fi

if [[ ! -f "$repo_root/.cst/events.jsonl" ]]; then
  echo "CST store not found: $repo_root/.cst/events.jsonl" >&2
  exit 1
fi

claim_taken=0
setup_complete=0

cleanup_on_error() {
  status=$?
  if [[ "$setup_complete" -ne 1 && "$claim_taken" -eq 1 ]]; then
    echo "setup failed; releasing CST task $task_id" >&2
    (cd "$repo_root" && cst release "$task_id" >/dev/null) || true
  fi
  exit "$status"
}
trap cleanup_on_error ERR

claim_json="$(cst take "$task_id")"
claim_taken=1

claim_node_id="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.node_id));' <<<"$claim_json")"
attempt_id="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(j.attempt_id);' <<<"$claim_json")"
claim_event_id="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(j.event_id);' <<<"$claim_json")"
lease_id="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(j.lease_id);' <<<"$claim_json")"
lease_expires_at="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(j.lease_expires_at);' <<<"$claim_json")"

if [[ "$claim_node_id" != "$task_id" ]]; then
  echo "cst take returned task $claim_node_id, expected $task_id" >&2
  exit 1
fi

create_output="$(scripts/parallel-dev/create-agent.sh "$agent_id" "$slug" "$base_ref")"
printf '%s\n' "$create_output"

agent_dir="$(printf '%s\n' "$create_output" | sed -n 's/^agent dir:[[:space:]]*//p')"
worktree="$(printf '%s\n' "$create_output" | sed -n 's/^worktree:[[:space:]]*//p')"
branch="$(printf '%s\n' "$create_output" | sed -n 's/^branch:[[:space:]]*//p')"

if [[ -z "$agent_dir" || -z "$worktree" || -z "$branch" ]]; then
  echo "failed to parse create-agent.sh output" >&2
  exit 1
fi

cat > "$agent_dir/cst.json" <<JSON
{
  "taskId": $task_id,
  "attemptId": "$attempt_id",
  "claimEventId": "$claim_event_id",
  "leaseId": "$lease_id",
  "leaseExpiresAt": "$lease_expires_at",
  "sourceRoot": "$repo_root",
  "workerCstMode": "central-source-root"
}
JSON

cat >> "$agent_dir/env.sh" <<EOF

# CST central-store assignment. This worker already owns task $task_id.
export PARALLEL_CST_SOURCE_ROOT="$repo_root"
export PARALLEL_CST_TASK_ID="$task_id"
export PARALLEL_CST_ATTEMPT_ID="$attempt_id"
export PARALLEL_CST_CLAIM_EVENT_ID="$claim_event_id"
export PARALLEL_CST_LEASE_ID="$lease_id"
export PARALLEL_CST_LEASE_EXPIRES_AT="$lease_expires_at"

parallel_cst() {
  (cd "\$PARALLEL_CST_SOURCE_ROOT" && command cst "\$@")
}

cst() {
  case "\${1:-}" in
    take)
      echo "this worker already owns CST task \$PARALLEL_CST_TASK_ID; do not run cst take" >&2
      return 2
      ;;
    run)
      echo "cst run executes in the central source checkout; run gates directly in \$PARALLEL_WORKTREE and record evidence instead" >&2
      return 2
      ;;
  esac
  parallel_cst "\$@"
}

parallel_cst_show() {
  parallel_cst show "\$PARALLEL_CST_TASK_ID"
}

parallel_cst_done() {
  parallel_cst done "\$PARALLEL_CST_TASK_ID" "\$@"
}

parallel_cst_release() {
  parallel_cst release "\$PARALLEL_CST_TASK_ID"
}
EOF

cat >> "$agent_dir/task.md" <<EOF

## CST assignment

- task id: $task_id
- attempt id: $attempt_id
- claim event id: $claim_event_id
- lease id: $lease_id
- lease expires at: $lease_expires_at
- central CST source: $repo_root/.cst/events.jsonl

Do not run \`cst take\` for this assignment. Source \`$agent_dir/env.sh\` and
use the injected \`cst()\` wrapper, which operates on the central source
checkout instead of the worker branch-local CST snapshot.
EOF

cat >> "$agent_dir/startup.md" <<EOF

## CST assignment

This worker already owns CST task $task_id.

After sourcing \`env.sh\`, \`cst\` is a shell function that runs against the
central source checkout:

\`\`\`sh
source "$agent_dir/env.sh"
type cst
cst show "\$PARALLEL_CST_TASK_ID"
\`\`\`

Rules:

- Do not run \`cst take\` in this worker.
- Do not run \`cst run\` for worktree verification. It would execute in the
  central source checkout. Run verification commands directly in
  \`$worktree\`, then record evidence through the central wrapper.
- Do not trust a branch-local \`.cst/events.jsonl\` snapshot.
- Record evidence and completion through the central wrapper:

  \`\`\`sh
  cst evidence "\$PARALLEL_CST_TASK_ID" --kind note --summary "..."
  parallel_cst_done --note "..."
  \`\`\`

- If you stop without finishing, release the central claim:

  \`\`\`sh
  parallel_cst_release
  \`\`\`
EOF

setup_complete=1
trap - ERR

cat <<EOF

CST assignment:
  task:       $task_id
  attempt:    $attempt_id
  claim:      $claim_event_id
  lease:      $lease_id
  expires:    $lease_expires_at
  cst source: $repo_root/.cst/events.jsonl

next:
  cd "$worktree"
  source "$agent_dir/env.sh"
  cst show "\$PARALLEL_CST_TASK_ID"
EOF
