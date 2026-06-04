# @agent-os/sandbox-cloudflare

## Purpose

Cloudflare Sandbox-compatible backend for `@agent-os/sandbox`.

## Invariant

Backend reuse is an implementation detail. Sandbox clients, namespace bindings,
and provider handles are not application state and must not enter ledger-visible
payloads.

## Minimal Usage

Provide the live sandbox client from the Worker environment and adapt it to the
provider-neutral sandbox algebra.

## Verification

```sh
cd packages/execution-domains/sandbox-cloudflare
vp test run
```
