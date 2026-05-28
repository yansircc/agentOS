# @agent-os/workspace-session-cloudflare

## Purpose

Cloudflare Sandbox-compatible backend for `@agent-os/workspace-session`.

## Invariant

The workspace-session carrier owns lifecycle facts. This backend supplies
concrete session, workspace root, cleanup, backup, preview, and destroy proof
refs. SDK clients, namespace bindings, preview tokens, backup handle objects,
and sandbox objects never enter ledger-visible payloads.

## Minimal Usage

Adapt a structural Cloudflare Sandbox namespace or client and pass the provider
to the workspace-session carrier. Missing refs fail closed; there is no
resolver-derived or ambient fallback.

```ts
import { makeCloudflareWorkspaceSessionLiveProvider } from "@agent-os/workspace-session-cloudflare";
```

## Verification

```sh
cd packages/providers/workspace-session-cloudflare
vp test run
```

Real Cloudflare Sandbox smoke requires an app-supplied namespace binding.
