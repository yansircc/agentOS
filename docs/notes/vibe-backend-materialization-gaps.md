# vibe Backend Materialization Gaps

> Retained planning note, not a substrate contract.
> Verification scope: agentOS package surface only. `vibe-coding-web` and
> `zeroY2` were not modified.

## Invariant

The remaining vibe-class gaps are backend, adapter, or experimental registry
work. They are not new `PreClaim` fields and not new ledger truth.

```text
substrate complete   = effect-boundary types closed
backend complete     = required primitives have live materializations
composition complete = product-facing flow wires primitives without second truth
```

## Verified State

| Area                            | Current agentOS state                                                                                                                                                                 | Gap                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-session-cloudflare`  | Carrier adapter shape exists. It accepts a `CloudflareWorkspaceSessionProvider` and settles workspace-session claims through `@agent-os/workspace-session`. Tests use stub providers. | Live Cloudflare Sandbox SDK provider is not implemented here. Start/restore/backup/preview/destroy remain provider-owned until that backend lands.                                           |
| `cloudflare-resource`           | Proof algebra, extension prefix, authority material requirements, payloads, failure settlement, and projections exist for `cf_resource.*`.                                            | Live D1/KV/R2/Queue/Workflow/Vectorize/Browser Rendering/Schedule API backend is not implemented. Provider calls must be added behind the carrier interface.                                 |
| LLM transport + tenant material | `MaterialRef`, `RefResolver`, and `llmRouteMaterialRefs` exist. Core HTTP transports resolve symbolic endpoint and credential refs at execution time.                                 | Tenant credential storage/rotation and provider-specific streaming adapter packages are not materialized. Apps still own encrypted tenant credential stores and per-provider policy.         |
| Skill / MCP registry            | Tool registry and admitter cover tool identity, authority, and required materials.                                                                                                    | Skill/MCP discovery, zip install policy, and front-door product routing are still experimental/product-owned. Do not graduate them to core without N>=2 pressure on the same registry shape. |

## Placement

Backend gaps:

```text
workspace-session-cloudflare live provider
cloudflare-resource live provider
```

Adapter gaps:

```text
tenant credential resolver
provider token-delta transports
```

Experimental/app-owned:

```text
skill/MCP registry
front-door product routing
Cloudflare product recommendation policy
```

## Removal Conditions

- `workspace-session-cloudflare` becomes backend-complete when a live provider
  implements the existing provider interface with Cloudflare Sandbox SDK calls
  and proves start/restore/backup/preview/destroy against prefixed test scopes.
- `cloudflare-resource` becomes backend-complete when live Cloudflare resource
  providers implement provision/bind/mutate/destroy for the first supported
  resource set and write only symbolic refs plus proof refs.
- LLM tenant material becomes adapter-complete when a package maps tenant-owned
  encrypted credential records into `MaterialRef` resolution without exposing
  resolved secrets to ledger payloads or traces.
- Skill/MCP registry graduates only when two products need the same discovery,
  install, authority, and material contract. Until then, it stays app/cookbook
  code over the existing tool registry.

## Non-Gaps

These do not require substrate changes:

- subagent invocation: use dispatch/submit authority plus child run refs;
- long-running effects: compose scheduler intent, submit/carrier effects, and
  ledger projection;
- cross-DO "global truth": use derived indexes over per-DO ledgers;
- token deltas: non-durable `turn-stream` / `run-stream` composition, not
  ledger facts.
