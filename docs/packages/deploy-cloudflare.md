# @agent-os/deploy-cloudflare

## Purpose

Cloudflare Worker deploy material and provider helpers for `@agent-os/deploy`.

## Invariant

Worker script/modules and Worker manifest live inside deployable artifact
material resolved from `artifactRef`. Staging facts keep only symbolic
`artifactRef`, `routeRef`, and `digest`; they do not grow Worker-specific
manifest fields. Cloudflare account IDs, route URLs, tokens, and provider
handles stay out of manifest refs and ledger-visible projections.

## Minimal Usage

Resolve a staged `artifactRef` to a `CloudflareWorkerDeployBundle`, validate the
bundle, and compare `cloudflareWorkerDeployBundleDigest(bundle)` with the
staging digest before deploy.

```ts
import { cloudflareWorkerDeployBundleDigest } from "@agent-os/deploy-cloudflare";
```

## Verification

```sh
cd packages/providers/deploy-cloudflare
vp test run
```

Live Cloudflare deploy smoke belongs to the later deploy provider track.
