# @agent-os/cloudflare-resource

Cloudflare resource carrier facts and live Cloudflare resource providers.

## Resource Core

The package exposes one lifecycle algebra across D1, KV namespace, R2 bucket,
Queue, and Workflow:

- `provision`
- `bind`
- `mutate`
- `destroy`

Resolved Cloudflare account/resource/binding material comes only from
`RefResolver.material(MaterialRef)`. Missing material and unsupported
resource/mutation kinds fail closed; there is no fallback to env, wrangler, or
dashboard state.

Carrier payloads are symbolic only: `MaterialRef`, `proofRef`, `mutationRef`,
and `fingerprint`. Resolved token, provider response body, SQL, object bytes,
queue message body, workflow payload, account id, database id, and live handles
stay outside ledger-visible payloads and claims.

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
provisions D1, records the created database id only in the external material
resolver map, emits a symbolic bind proof, executes one D1 mutation from an
`inputRef`, destroys the database, projects the resulting facts, and scans the
events/projection for resolved token, account id, database id, or SQL leakage.

Missing environment is a fast failure. The script does not fallback to ambient
credentials or unprefixed resource names.

## Mutation Boundary

D1 mutation SQL is execution material. The carrier receives only an `inputRef`
and calls async `resolveMutationInput(inputRef)` at execution time. The resolved
SQL is sent to Cloudflare but never written to claim payloads, ledger events,
projection output, or run-stream frames.

`mutate` does not return query rows. Even when `mutationKind` is `d1.query`,
the carrier records only symbolic mutation/proof refs. Callers that need rows
must read them through their own execution-time D1 binding and keep durable
truth in agentOS ledger facts.
