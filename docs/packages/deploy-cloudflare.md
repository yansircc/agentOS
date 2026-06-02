# @agent-os/deploy-cloudflare

## Purpose

Cloudflare Worker deploy material and provider implementation for
`@agent-os/deploy`.

## Invariant

Worker script/modules and Worker manifest live inside deployable artifact
material resolved from `artifactRef`. Staging facts keep only symbolic
`artifactRef`, `routeRef`, and `digest`; they do not grow Worker-specific
manifest fields. Cloudflare account IDs, route URLs, tokens, and provider
handles stay out of manifest refs and ledger-visible projections.

## Minimal Usage

Resolve a staged `artifactRef` to a `CloudflareWorkerDeployBundle`, validate
the bundle digest, and use `makeCloudflareWorkerDeployCarrier` to emit symbolic
deploy refs while raw Cloudflare material stays resolver-side.

```ts
import { cloudflareWorkerDeployBundleDigest } from "@agent-os/deploy-cloudflare";
```

## Verification

```sh
cd packages/providers/deploy-cloudflare
vp test run
```

Live Cloudflare deploy smoke is opt-in and must not commit provider material or
raw URLs.
