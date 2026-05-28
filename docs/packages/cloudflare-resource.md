# @agent-os/cloudflare-resource

## Purpose

Cloudflare D1, KV namespace, R2 bucket, Queue, and Workflow resource carrier.

## Invariant

Carrier ledger facts are not the resource data store. Payloads may contain
symbolic `MaterialRef`, `proofRef`, `mutationRef`, and `fingerprint`; they must
not contain tokens, raw provider bodies, SQL, object bytes, queue bodies,
workflow payloads, account ids, database ids, or live handles.

## Minimal Usage

Use a resource carrier for lifecycle and mutation proofs. Provide all execution
material through a resolver; missing material and unsupported resource kinds
fail closed.

```ts
import { makeCloudflareD1ResourceCarrier } from "@agent-os/cloudflare-resource";
```

For query rows, object bytes, values, messages, or workflow state, use the
provider data plane outside the carrier and keep durable truth in agentOS
ledger facts.

## Verification

```sh
cd packages/cloudflare-resource
vp test run
```

Live smokes are opt-in and must use prefixed `TEST_RUN_ID` / `SCOPE_PREFIX`
resources from a parallel worktree.
