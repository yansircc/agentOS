#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: scripts/parallel-dev/run-spike-vitest.sh <vitest-config> [vitest-args...]

Runs an ignored spike's Vitest config with the core-owned Vitest binary, so
throwaway spike directories do not need their own dependency install.
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

config_input="$1"
shift

invocation_root="$(git rev-parse --show-toplevel)"

if [[ "$config_input" = /* ]]; then
  config_abs="$config_input"
else
  config_dir="$(dirname "$config_input")"
  config_base="$(basename "$config_input")"
  config_abs="$(cd "$config_dir" && pwd)/$config_base"
fi

if [[ ! -f "$config_abs" ]]; then
  echo "vitest config not found: $config_abs" >&2
  exit 1
fi

repo_root="$(
  git -C "$(dirname "$config_abs")" rev-parse --show-toplevel 2>/dev/null ||
    printf '%s\n' "$invocation_root"
)"

vitest_root="${PARALLEL_SOURCE_ROOT:-$repo_root}"
vitest_bin="$repo_root/packages/core/node_modules/.bin/vitest"
if [[ ! -x "$vitest_bin" && -x "$vitest_root/packages/core/node_modules/.bin/vitest" ]]; then
  vitest_bin="$vitest_root/packages/core/node_modules/.bin/vitest"
fi

if [[ ! -x "$vitest_bin" ]]; then
  echo "missing core Vitest binary: $vitest_bin" >&2
  echo "run in the assigned worktree only if dependency ownership is assigned: cd $repo_root/packages/core && bun install" >&2
  exit 1
fi

cd "$repo_root"
exec "$vitest_bin" run --config "$config_abs" "$@"
