# AGENTS.md

This repo is an agentOS substrate repo. Treat it as invariant code, not an app
playground.

## Invariant

Write the problem's algebra, not its case analysis.

Before changing code, name:

1. stable axis
2. change axis
3. invariant

One fact, one location. Derived data is not source of truth. Implementation
details do not belong in shared substrate logic.

## Repo Surface

```text
docs/
  specs/       durable substrate decisions
  cookbooks/   optional app-shape recipes
  notes/       retained exploration notes

packages/
  core/                  substrate package
  image/                 optional image algebra
  sandbox/               optional bounded stateless sandbox algebra
  sandbox-cloudflare/    optional Cloudflare Sandbox backend

spikes/
  _active/     ignored local throwaway only
```

Historical runnable spikes and examples are retired. Do not add tracked
examples or tracked spike apps unless explicitly assigned.

## Required Reading by Task Type

Read the minimum set:

- Public surface / invariant work: `docs/specs/spec-24-invariants-and-surface.md`
- Structured output: `docs/specs/spec-25-llm-admission.md`
- Protocol adapter / routes: `docs/specs/spec-27-llm-protocol-adapter.md`
- Cross-scope dispatch / resources / image route: `docs/specs/spec-28-img-gen-gap-implementation-plan.md`
- Event stream: `docs/specs/spec-29-ledger-event-stream.md`
- Boundary/cookbook decisions: `docs/specs/spec-30-substrate-boundary-cookbook.md`
- Text streaming: `docs/specs/spec-31-text-streaming-capability.md`
- Image package boundary: `docs/specs/spec-32-image-package-boundary.md`
- Sandbox carrier: `docs/specs/spec-33-sandbox-carrier.md`
- Parallel agent startup: `docs/cookbooks/parallel-agent-startup.md`
- Parallel isolation rules: `docs/cookbooks/parallel-dev-mvp.md`

Cookbooks are recipes, not contracts. Specs and core tests are contracts.

## Parallel Dev Rule

Do not work in the shared checkout for assigned implementation tasks. Create an
isolated worktree:

```sh
scripts/parallel-dev/create-agent.sh a01 chatbot HEAD
cd .parallel/worktrees/a01-chatbot
source <printed-agent-dir>/env.sh
test "$(pwd)" = "$PARALLEL_WORKTREE" || { echo "wrong worktree: $(pwd)"; exit 1; }
```

The env gives you:

- `AGENT_ID`
- `TEST_RUN_ID`
- `SCOPE_PREFIX`
- `PORT_BASE`
- isolated `HOME`
- isolated `XDG_CACHE_HOME`
- isolated `TMPDIR`
- root `.dev.vars` sourced as the only secrets file

Use `$PORT_BASE` through `$((PORT_BASE + 9))`. Prefix all scopes, R2 keys,
queue names, and test fixtures with `$SCOPE_PREFIX`.

Before writing files, verify that the current directory is the assigned
worktree:

```sh
test "$(pwd)" = "$PARALLEL_WORKTREE" || { echo "wrong worktree: $(pwd)"; exit 1; }
```

## Secrets

Root `.dev.vars` is ignored by git. It is the single local source of provider
credentials and defaults.

Never print or commit secret values. It is acceptable to report `set/missing`
or provider-safe summaries.

Common defaults:

- `CF_AI_DEFAULT_TEXT_MODEL=openai/gpt-5.4-mini`
- `CF_AI_GATEWAY_ID=default`
- `OPENROUTER_DEFAULT_TEXT_MODEL`
- `OPENROUTER_DEFAULT_IMAGE_MODEL`
- `AIHUBMIX_DEFAULT_MODEL`
- `GEMINI_DEFAULT_MODEL`

Live provider tests are opt-in. Contract tests must use stubs unless the task
explicitly asks for live-wire validation.

## Write-Set Rule

Before editing, write the intended write-set into your run `task.md`.

Single-writer unless explicitly assigned:

- `bun.lock`
- root `package.json`
- public barrel files
- schema migrations
- docs/spec indexes
- generated source

If your task needs a forbidden shared file, stop and report the required
single-writer change.

## Active Spike / Happy Project Rule

Happy project implementations are pressure tests, not repo products.

Put throwaway code under:

```text
spikes/_active/<agent-id>-<case>/
```

That path is ignored. The durable output is your report, not the app code. If
the project exposes a real substrate gap, report the gap first; do not silently
patch core.

## Verification

Normal repo gates:

```sh
bun run typecheck
cd packages/core && bun run test
git diff --check
```

For happy projects, run the narrow local smoke first. Full repo gates are
required only if you touched tracked source.

For ignored spike tests, prefer the repo helper over ad hoc dependency
installation:

```sh
scripts/parallel-dev/run-spike-vitest.sh <path-to-vitest.config.ts>
```

Worktrees may contain `node_modules` symlinks back to the source checkout.
Treat dependency directories as shared read-only inputs. Do not run
`bun install` unless dependency ownership is assigned.

When running a server:

- bind to `$PORT_BASE`
- record owned PIDs in `$PARALLEL_AGENT_DIR/pids.txt`
- only stop PIDs listed there
- do not run global `pkill`, `killall`, cache purge, or repo-wide cleanup

## Report Format

Every assigned agent returns:

```text
agentId:
branch:
worktree:
task:
writeSet:
commit: <sha or none>

result:
  PASS | FAIL | BLOCKED

verification:
  - <command> -> <exit code> | <safe summary>

proof:
  - ledger events / HTTP responses / test assertions, with scopes prefixed by TEST_RUN_ID

friction:
  - DX or docs/API issue encountered

bugs:
  - invariant:
    failure:
    minimal fix:
    verification:
```

If there is no issue, say so explicitly and name the remaining untested risk.

## Review Priority

1. invariant violation
2. duplicated state
3. boundary leakage
4. semantic inconsistency
5. style

Passing one observed test is not done. Done means the class of failure is
structurally impossible, or the report states why eliminating the class is not
viable yet and names the condition that would require the class-level fix.
