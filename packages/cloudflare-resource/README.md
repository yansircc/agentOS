# @agent-os/cloudflare-resource

Cloudflare resource carrier facts and live D1 provider.

## D1 Live Smoke

Default tests use stubbed `fetch`. The live D1 smoke is opt-in because it
creates and destroys a real Cloudflare D1 database.

Required environment:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `TEST_RUN_ID`
- `SCOPE_PREFIX`

Run from a parallel worktree:

```sh
source "$PARALLEL_AGENT_DIR/env.sh"
set -a
. /Users/yansir/code/52/agentOS/.dev.vars
set +a
bun packages/cloudflare-resource/test/d1-live-smoke.mjs
```

The smoke uses `makeCloudflareD1ResourceCarrier`, not direct provider calls. It
provisions D1, emits a symbolic bind proof, executes one D1 mutation from an
`inputRef`, destroys the database, projects the resulting facts, and scans the
events/projection for resolved token or SQL leakage.

Missing environment is a fast failure. The script does not fallback to ambient
credentials or unprefixed resource names.
