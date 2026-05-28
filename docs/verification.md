# Verification

Run from the repo root or an assigned parallel worktree.

## Standard Gates

```sh
bun run check
bun run check:public-api
bun run typecheck
bun run test
effect-skill-scan /Users/yansir/code/52/agentOS --strict --json --profile
git diff --check
```

`bun run check` includes formatting, public API manifest validation,
typecheck, and package tests. The explicit commands are still useful when
isolating failures.

## Public API Gate

Every package with a public surface has a `PUBLIC_API.md`. In 0.2.x this is an
accidental-export gate, not an API freeze. The checker fails when:

- an exported symbol is missing from the manifest;
- an internal-only symbol is exported;
- a manifest-listed symbol no longer exists.

## Live Provider Tests

Live tests are opt-in. Source root `.dev.vars` only through the parallel agent
environment. Do not print secrets.

Use prefixed resources:

```sh
source "$PARALLEL_AGENT_DIR/env.sh"
set -a
. /Users/yansir/code/52/agentOS/.dev.vars
set +a
```

Live evidence must prove cleanup and redaction. Scan claims, ledger events,
projections, run-stream frames, and error payloads for resolved provider
material.
