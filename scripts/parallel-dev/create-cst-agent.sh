#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: scripts/parallel-dev/create-cst-agent.sh <task-id> <agent-id> <slug> [base-ref]

Creates one CST-claimed parallel worker:
  1. creates an isolated git worktree through create-agent.sh
  2. binds <task-id> to that worktree as a private CST execution surface
  3. takes <task-id> in the source checkout
  4. writes CST claim metadata and a central-store cst() wrapper into env.sh

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
agent_dir=""
worktree=""
branch=""

cleanup_on_error() {
  status=$?
  if [[ "$setup_complete" -ne 1 && "$claim_taken" -eq 1 ]]; then
    echo "setup failed; releasing CST task $task_id" >&2
    (cd "$repo_root" && cst --store "$repo_root" release "$task_id" >/dev/null) || true
  fi
  if [[ "$setup_complete" -ne 1 && -n "$worktree" && -d "$worktree" ]]; then
    echo "setup failed; removing worker worktree $worktree" >&2
    git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  fi
  if [[ "$setup_complete" -ne 1 && -n "$branch" ]] && git rev-parse --verify --quiet "refs/heads/${branch}" >/dev/null; then
    echo "setup failed; deleting worker branch $branch" >&2
    git branch -D "$branch" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_on_error ERR

create_output="$(scripts/parallel-dev/create-agent.sh "$agent_id" "$slug" "$base_ref")"
printf '%s\n' "$create_output"

agent_dir="$(printf '%s\n' "$create_output" | sed -n 's/^agent dir:[[:space:]]*//p')"
worktree="$(printf '%s\n' "$create_output" | sed -n 's/^worktree:[[:space:]]*//p')"
branch="$(printf '%s\n' "$create_output" | sed -n 's/^branch:[[:space:]]*//p')"

if [[ -z "$agent_dir" || -z "$worktree" || -z "$branch" ]]; then
  echo "failed to parse create-agent.sh output" >&2
  exit 1
fi

claim_json="$(cst --store "$repo_root" take "$task_id" --exec-cwd "$worktree" --private-exec-cwd)"
claim_taken=1

claim_fields="$(
  node -e '
const fs = require("fs");
const view = JSON.parse(fs.readFileSync(0, "utf8"));
const claim = view.claim ?? view;
const requiredString = (name) => {
  const value = claim[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`cst take output missing claim.${name}`);
  }
  return value;
};
if (!Number.isInteger(claim.node_id)) {
  throw new Error("cst take output missing claim.node_id");
}
process.stdout.write([
  String(claim.node_id),
  requiredString("attempt_id"),
  requiredString("event_id"),
  requiredString("lease_id"),
  requiredString("lease_expires_at"),
].join("\t"));
' <<<"$claim_json"
)"
IFS=$'\t' read -r claim_node_id attempt_id claim_event_id lease_id lease_expires_at <<<"$claim_fields"

if [[ "$claim_node_id" != "$task_id" ]]; then
  echo "cst take returned task $claim_node_id, expected $task_id" >&2
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
  "execCwd": "$worktree",
  "execSurface": "private",
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
export PARALLEL_CST_EXEC_CWD="$worktree"

parallel_cst() {
  command cst --store "\$PARALLEL_CST_SOURCE_ROOT" "\$@"
}

cst() {
  case "\${1:-}" in
    take)
      echo "this worker already owns CST task \$PARALLEL_CST_TASK_ID; do not run cst take" >&2
      return 2
      ;;
    run)
      echo "low-level cst run is not the worker handoff; use cst worker-status and cst worker-run --action <action-id>" >&2
      return 2
      ;;
  esac
  parallel_cst "\$@"
}

parallel_cst_show() {
  parallel_cst show "\$PARALLEL_CST_TASK_ID"
}

parallel_cst_status() {
  parallel_cst worker-status "\$PARALLEL_CST_TASK_ID" "\$@"
}

parallel_cst_run_action() {
  parallel_cst worker-run "\$PARALLEL_CST_TASK_ID" "\$@"
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
- worker exec cwd: $worktree

Do not run \`cst take\` for this assignment. Source \`$agent_dir/env.sh\` and
use the injected \`cst()\` wrapper, which passes an explicit central
\`--store\` instead of trusting the worker branch-local CST snapshot.

Start from the ledger-derived worker frontier:

\`\`\`sh
cst worker-status "\$PARALLEL_CST_TASK_ID" --human
cst worker-run "\$PARALLEL_CST_TASK_ID" --action <action-id>
\`\`\`
EOF

cat >> "$agent_dir/startup.md" <<EOF

## CST assignment

This worker already owns CST task $task_id.

After sourcing \`env.sh\`, \`cst\` is a shell function that runs against the
central source checkout:

\`\`\`sh
source "$agent_dir/env.sh"
type cst
cst worker-status "\$PARALLEL_CST_TASK_ID" --human
\`\`\`

Rules:

- Do not run \`cst take\` in this worker.
- Do not run low-level \`cst run\` for worktree verification. Read
  \`cst worker-status\`, then execute a current bound action with
  \`cst worker-run --action <action-id>\`.
- Do not trust a branch-local \`.cst/events.jsonl\` snapshot.
- When no frontier action exists, record review evidence or external notes
  through the central wrapper:

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
  cst worker-status "\$PARALLEL_CST_TASK_ID" --human
EOF
