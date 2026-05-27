# Parallel Dev MVP

> **Pattern**: run multiple coding agents from one base commit without shared
> mutable workspace, port, local runtime, or cleanup state.
> **Uses**: git worktrees, controller-assigned ports, per-agent env roots.
> **Does NOT introduce**: distributed scheduler, remote resource allocator,
> merge bot, or global cleanup daemon.

## Invariant

Every shared mutable surface is either isolated per agent or single-writer.

MVP scope covers the common failure classes:

| Surface             | Rule                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| source writes       | one git worktree and branch per agent                                   |
| ports               | controller assigns a deterministic port range per agent                 |
| local runtime state | per-agent `HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `.wrangler`, scope prefix |
| test data           | every scope/key starts with `TEST_RUN_ID`                               |
| cleanup             | agent records owned PIDs; no global `pkill` / cache cleanup             |

## Start One Agent

```sh
scripts/parallel-dev/create-agent.sh a01 chatbot HEAD
```

This creates:

```text
.parallel/
  runs/<runId>/agents/a01/
    manifest.json
    env.sh
    ports.json
    pids.txt
    startup.md
    task.md
  worktrees/a01-chatbot/
```

Agent instructions:

```sh
cd .parallel/worktrees/a01-chatbot
source ../../runs/<runId>/agents/a01/env.sh
```

Use `$PORT_BASE` for local servers and `$TEST_RUN_ID` / `$SCOPE_PREFIX` for
all scopes, R2 keys, queue names, and test fixtures.

Provider secrets are loaded from the repo root `.dev.vars` by `env.sh`. See
[Parallel Agent Startup](./parallel-agent-startup.md) for the expected
variable names and per-agent startup checklist.

## Write-Set Rule

Before coding, the agent writes the intended files into `task.md`.

Single-writer by default:

- `bun.lock`
- root `package.json`
- docs/spec indexes
- public barrel files
- schema migrations
- generated source

If two agents need the same single-writer surface, stop and split the task or
route both changes through the integration agent.

## Verification Rule

Agent result must include:

```text
agentId:
worktree:
branch:
commit:
commands:
  - <command> -> <exit code>
notes:
```

Integration verifies by merging agent branches one at a time from the original
base commit, then running the full repo gate.

## Common Mistakes

- Reusing a fixed test scope such as `demo` or `session-1`.
- Letting Vite/Wrangler auto-select a random port and then testing the wrong
  server.
- Running live provider tests by default.
- Cleaning shared paths such as repo root `.wrangler`, global cache, or all
  Node processes.
- Treating a clean merge as semantic compatibility. Public API/spec changes
  still need integration review.
