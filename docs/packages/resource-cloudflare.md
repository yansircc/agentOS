# @agent-os/resource-cloudflare

## Purpose

Cloudflare D1, KV namespace, R2 bucket, Queue, Workflow, and Worker resource
materializer for `@agent-os/resource-carrier`.

## Invariant

Provider calls may resolve credentials and raw Cloudflare material at execution
time, but durable payloads returned to the resource carrier remain symbolic and
redacted.

## Minimal Usage

Use a Cloudflare resource factory with a resolver that supplies execution
material.

```ts
import { makeCloudflareD1ResourceCarrier } from "@agent-os/resource-cloudflare";
```

## Verification

```sh
cd packages/providers/resource-cloudflare
vp test run
```

Live smokes are opt-in and must use prefixed `TEST_RUN_ID` / `SCOPE_PREFIX`
resources from a parallel worktree.
