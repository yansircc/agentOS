# Parallel Agent Startup

This is the short instruction file each parallel agent should read before
coding. `scripts/parallel-dev/create-agent.sh` also writes a run-specific
`startup.md` into the agent directory.

## Invariant

One agent writes one worktree. Shared secrets live in one root `.dev.vars`
file and are sourced into each agent process; they are not copied into source,
logs, task files, or ledger payloads.

## Startup

```sh
scripts/parallel-dev/create-agent.sh a01 chatbot HEAD
cd .parallel/worktrees/a01-chatbot
source ../../runs/<runId>/agents/a01/env.sh
```

Check:

```sh
echo "$AGENT_ID $TEST_RUN_ID $PORT_BASE"
test "$(pwd)" = "$PARALLEL_WORKTREE" || { echo "wrong worktree: $(pwd)"; exit 1; }
git branch --show-current
```

## Required Local Secrets

Root `.dev.vars` is ignored by git and should contain these names:

| Variable | Purpose |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Wrangler / Cloudflare remote operations |
| `CLOUDFLARE_API_TOKEN` | Wrangler / Cloudflare API auth |
| `CF_AI_GATEWAY_ID` | optional `gatewayRef`, usually `default` |
| `CF_AI_DEFAULT_TEXT_MODEL` | default Cloudflare AI text model, usually `openai/gpt-5.4-mini` |
| `OPENROUTER_KEY` | OpenAI-compatible text/image route via OpenRouter |
| `OPENROUTER_ENDPOINT` | usually `https://openrouter.ai/api/v1` |
| `OPENROUTER_DEFAULT_TEXT_MODEL` | default strong text model |
| `OPENROUTER_DEFAULT_IMAGE_MODEL` | default image model |
| `ANTHROPIC_KEY_AIHUBMIX` | Anthropic Messages route via aihubmix |
| `AIHUBMIX_ENDPOINT` | usually `https://aihubmix.com` |
| `AIHUBMIX_DEFAULT_MODEL` | default Claude-class model |
| `GEMINI_KEY` | official Google Gemini API key |
| `GEMINI_ENDPOINT` | usually `https://generativelanguage.googleapis.com` |
| `GEMINI_DEFAULT_MODEL` | default Gemini model |
| `OPENAI_API_KEY` | optional direct OpenAI key; may stay blank |
| `ANTHROPIC_API_KEY` | optional direct Anthropic key; may stay blank |
| `LIVE_LLM` | `0` by default; set `1` only for live model smoke |
| `LIVE_PROVIDER_TESTS` | `0` by default; set `1` only for provider validation |

## Agent Rules

- Write the intended write-set into `task.md` before editing.
- Before writing files, run:

  ```sh
  test "$(pwd)" = "$PARALLEL_WORKTREE" || { echo "wrong worktree: $(pwd)"; exit 1; }
  ```

- Use `$PORT_BASE` through `$((PORT_BASE + 9))`; do not auto-pick random ports.
- Prefix all scopes, R2 keys, queue names, and test fixtures with
  `$SCOPE_PREFIX`.
- Record server PIDs in `$PARALLEL_AGENT_DIR/pids.txt`.
- Do not run global cleanup commands.
- Do not modify single-writer files unless assigned: `bun.lock`, root
  `package.json`, public barrels, migrations, generated source.

## Spike Vitest

Ignored spikes should not grow their own dependency installation just to run a
small test. Use the core-owned Vitest binary:

```sh
scripts/parallel-dev/run-spike-vitest.sh spikes/_active/a04-approval-race/vitest.config.ts
```

The argument is a config path. Extra arguments are forwarded to Vitest.

Fresh worktrees may receive `node_modules` symlinks from the source checkout.
Treat dependency directories as shared read-only inputs; do not run
`bun install` unless the task explicitly assigns dependency ownership.
