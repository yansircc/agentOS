# AGENTS.md

This is the operating guide for agents changing the agentOS repo.

## Invariant

Write the problem's algebra, not its case analysis.

Before editing, state:

```text
stable axis:
change axis:
invariant:
```

One fact, one location. Derived data is not source of truth.
Implementation-specific behavior in shared substrate logic is a boundary
failure.

## Completion Standard

A change is done only when one of these is true:

- the class of failure is structurally impossible; or
- the report states why the class-level fix is not viable now and names the
  condition that makes it required.

Passing the observed test case is not enough.

## Complexity Gate

Do not add defensive branches, shims, shadow state, compatibility surfaces, or
fallback paths unless the report states:

1. exact failure model;
2. why redesign is not viable now;
3. explicit removal condition.

This repo currently has no real users. Prefer deletion and fast failure over
compatibility.

## Repo Surface

```text
docs/       public 1.0 docs only
packages/   substrate, carriers, backends, composition packages
tooling/    repo-local or ops tooling, not substrate
skills/     repo-shipped Codex skills
spikes/     ignored local pressure tests only
```

Do not add tracked examples, spike apps, or development notes unless explicitly
assigned.

## BoundaryContract Checklist

Claim-bearing packages declare one `BoundaryContract` with five independent
axes:

```text
vocabulary       owned event kind prefixes
authority        authority refs and required materials by authority
material         top-level MaterialRequirement axis
proof            symbolic anchor/proof vocabulary
projection       derived-from-ledger reader contract
```

Cleanup is not a sixth axis yet. Release and destruction semantics remain proof
vocabulary until multiple packages expose cleanup as an independent contract.

Do not put resolved provider material in claims, ledger events, projections,
error payloads, run-stream frames, or docs examples.

## Parallel Worktrees

Do not implement assigned work in the shared checkout. Create an isolated
worktree:

```sh
scripts/parallel-dev/create-agent.sh aNN short-task HEAD
cd .parallel/worktrees/aNN-short-task
source <printed-agent-dir>/env.sh
test "$(pwd)" = "$PARALLEL_WORKTREE" || { echo "wrong worktree: $(pwd)"; exit 1; }
```

Before editing, write the intended write-set and invariant to the printed
agent `task.md`.

Use `$PORT_BASE` through `$((PORT_BASE + 9))`. Prefix scopes, resource names,
R2 keys, queue names, and live fixtures with `$SCOPE_PREFIX`.

## Write-Set Rule

Single-writer unless explicitly assigned:

- `bun.lock`
- root `package.json`
- public barrel files
- `PUBLIC_API.md`
- schema migrations
- docs indexes
- generated source

If a task needs a forbidden shared file, stop and report the required
single-writer change.

## Secrets

Root `.dev.vars` is ignored by git and is the only local source of provider
credentials. Never print or commit secret values. Report only `set/missing` or
provider-safe summaries.

Live provider tests are opt-in unless the task explicitly requests them.

## Verification

Default gates:

```sh
bun run check
bun run typecheck
bun run test
effect-skill-scan /Users/yansir/code/52/agentOS --strict --json --profile
git diff --check
```

For package-scoped work, run the package test first, then full gates before the
commit.

## Review Priority

1. invariant violation
2. duplicated state
3. boundary leakage
4. semantic inconsistency
5. style

Report format:

```text
invariant:
failure:
minimal fix:
verification:
remaining risk:
```
