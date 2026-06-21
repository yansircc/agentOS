#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: scripts/parallel-dev/create-agent.sh <agent-id> <slug> [base-ref]

Creates one isolated git worktree plus per-agent env files:
  .parallel/worktrees/<agent-id>-<slug>
  .parallel/runs/<run-id>/agents/<agent-id>/

agent-id: lowercase letters/numbers/dash, e.g. a01
slug:     lowercase letters/numbers/dash, e.g. chatbot
base-ref: git ref to branch from, defaults to HEAD
USAGE
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

agent_id="$1"
slug="$2"
base_ref="${3:-HEAD}"

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

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
name="${agent_id}-${slug}"
branch="parallel/${name}"
worktree="${repo_root}/.parallel/worktrees/${name}"
agent_dir="${repo_root}/.parallel/runs/${run_id}/agents/${agent_id}"
secrets_file="${repo_root}/.dev.vars"

if [[ -e "$worktree" ]]; then
  echo "worktree already exists: $worktree" >&2
  exit 1
fi

if git rev-parse --verify --quiet "refs/heads/${branch}" >/dev/null; then
  echo "branch already exists: $branch" >&2
  exit 1
fi

digits="$(printf '%s' "$agent_id" | tr -cd '0-9')"
if [[ -z "$digits" ]]; then
  digits="0"
fi
agent_num=$((10#$digits))
port_base=$((8800 + agent_num * 10))
test_run_id="${agent_id}-${run_id}"
scope_prefix="${test_run_id}/"

mkdir -p "$agent_dir/home" "$agent_dir/cache" "$agent_dir/tmp"
git worktree add -b "$branch" "$worktree" "$base_ref" >/dev/null
mkdir -p "$worktree/.wrangler"

if [[ -d "$repo_root/node_modules" && ! -e "$worktree/node_modules" ]]; then
  ln -s "$repo_root/node_modules" "$worktree/node_modules"
fi

if [[ -d "$repo_root/packages/backends/cloudflare-do/node_modules" && ! -e "$worktree/packages/backends/cloudflare-do/node_modules" ]]; then
  ln -s "$repo_root/packages/backends/cloudflare-do/node_modules" "$worktree/packages/backends/cloudflare-do/node_modules"
fi

cat > "$agent_dir/ports.json" <<JSON
{
  "agentId": "$agent_id",
  "portBase": $port_base,
  "ports": {
    "dev": $port_base,
    "test": $((port_base + 1)),
    "preview": $((port_base + 2))
  }
}
JSON

cat > "$agent_dir/env.sh" <<EOF
export AGENT_ID="$agent_id"
export PARALLEL_RUN_ID="$run_id"
export TEST_RUN_ID="$test_run_id"
export SCOPE_PREFIX="$scope_prefix"
export PORT_BASE="$port_base"
export HOME="$agent_dir/home"
export XDG_CACHE_HOME="$agent_dir/cache"
export TMPDIR="$agent_dir/tmp"
export PARALLEL_AGENT_DIR="$agent_dir"
export PARALLEL_WORKTREE="$worktree"
export PARALLEL_SOURCE_ROOT="$repo_root"
export PARALLEL_SECRETS_FILE="$secrets_file"

if [ -f "\$PARALLEL_SECRETS_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "\$PARALLEL_SECRETS_FILE"
  set +a
else
  echo "warning: \$PARALLEL_SECRETS_FILE not found; provider live tests should stay disabled" >&2
fi
EOF

cat > "$agent_dir/manifest.json" <<JSON
{
  "agentId": "$agent_id",
  "runId": "$run_id",
  "baseRef": "$base_ref",
  "branch": "$branch",
  "worktree": "$worktree",
  "sourceRoot": "$repo_root",
  "agentDir": "$agent_dir",
  "testRunId": "$test_run_id",
  "scopePrefix": "$scope_prefix",
  "portBase": $port_base,
  "secretsFile": "$secrets_file"
}
JSON

cat > "$agent_dir/task.md" <<EOF
# Task: $name

## Invariant

## Allowed write-set

- TBD

## Forbidden shared surfaces

- bun.lock unless explicitly assigned
- root package.json unless explicitly assigned
- public barrel files unless explicitly assigned
- schema migrations unless explicitly assigned
- generated source unless explicitly assigned

## Commands run

## Result

EOF

cat > "$agent_dir/startup.md" <<EOF
# Startup: $name

1. Enter your isolated worktree.

   \`\`\`sh
   cd "$worktree"
   source "$agent_dir/env.sh"
   \`\`\`

2. Confirm isolation.

   \`\`\`sh
   echo "\$AGENT_ID \$TEST_RUN_ID \$PORT_BASE"
   test "\$(pwd)" = "\$PARALLEL_WORKTREE" || { echo "wrong worktree: \$(pwd)"; exit 1; }
   git branch --show-current
   \`\`\`

3. Before editing, fill \`$agent_dir/task.md\`:
   - invariant
   - allowed write-set
   - expected verification commands

4. Before writing files, keep this check green:

   \`\`\`sh
   test "\$(pwd)" = "\$PARALLEL_WORKTREE" || { echo "wrong worktree: \$(pwd)"; exit 1; }
   \`\`\`

5. Use only your assigned mutable surfaces:
   - worktree: \`$worktree\`
   - ports: \`$port_base\` through \`$((port_base + 9))\`
   - local home/cache/tmp from \`env.sh\`
   - scopes and keys prefixed with \`$scope_prefix\`

6. Provider secrets come from \`$secrets_file\`.
   Do not copy secrets into commits, task files, logs, or ledger payloads.

7. Live provider tests stay disabled unless the task explicitly says otherwise:

   \`\`\`sh
   test "\${LIVE_LLM:-0}" = "1" || echo "live LLM tests disabled"
   \`\`\`

8. Ignored spike tests should use the core-owned Vitest binary:

   \`\`\`sh
   scripts/parallel-dev/run-spike-vitest.sh spikes/<agent-id>-<case>/vitest.config.ts
   \`\`\`

   Dependency directories may be symlinked from \`$repo_root\`; treat them as
   shared read-only inputs. Do not run \`bun install\` unless the task assigns
   dependency ownership.

9. Record owned background process ids in:

   \`\`\`text
   $agent_dir/pids.txt
   \`\`\`

   Only stop PIDs listed there.
EOF

: > "$agent_dir/pids.txt"

cat <<EOF
created parallel agent workspace

agent:     $agent_id
branch:    $branch
worktree:  $worktree
agent dir: $agent_dir
port base: $port_base
secrets:   $secrets_file

next:
  cd "$worktree"
  source "$agent_dir/env.sh"
  open "$agent_dir/startup.md"
EOF
