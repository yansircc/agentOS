# @agent-os/workspace-env-cloudflare

## Purpose

Cloudflare Sandbox-compatible adapter for `@agent-os/workspace-env`.

## Invariant

The adapter normalizes a structural Cloudflare Sandbox client into a
WorkspaceEnv. It does not import the Cloudflare SDK, does not write ledger facts,
and does not change `@agent-os/workspace-session-cloudflare` lifecycle carrier
semantics. Tools generated from this env declare an explicit `sandbox`
execution domain.

## Minimal Usage

Supply the live Cloudflare Sandbox client from Worker code and call
`makeCloudflareWorkspaceEnv`. The returned env can be passed to
`createWorkspaceTools`.

The adapter forwards provider timeouts to Sandbox `exec`. In-flight `exec`
cancellation is non-cooperative: caller `AbortSignal`s are checked before the
provider call and again after it settles, but they are not passed through
Sandbox RPC options because those options must stay structured-clone safe.

## Verification

```sh
cd packages/execution-domains/workspace-env-cloudflare
vp test run
```
