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

| Area                            | Current agentOS state                                                                                                                                                                                                                                                                                                         | Gap                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-session-cloudflare`  | Structural Cloudflare Sandbox-compatible provider exists. `start`/`restore`/`backup`/`preview`/`destroy` settle workspace-session claims and fail closed when provider refs are missing.                                                                                                                                      | Default tests use structural namespace/client stubs. A real Cloudflare Sandbox smoke still requires an app-supplied namespace binding and prefixed live test resources.                      |
| `cloudflare-resource`           | Proof algebra, extension prefix, authority material requirements, payloads, failure settlement, projections, and live D1 carrier exist. D1 provision/mutate/destroy call Cloudflare's API through injected `fetch`; bind is a symbolic Worker-binding proof. D1 live smoke passed with `.dev.vars` credentials on 2026-05-28. | KV/R2/Queue/Workflow/Vectorize/Browser Rendering/Schedule live backends are not implemented.                                                                                                 |
| LLM transport + tenant material | `MaterialRef`, `RefResolver`, `llmRouteMaterialRefs`, tenant credential resolver, and provider token-delta adapters exist. Resolved credentials stay execution-time material.                                                                                                                                                 | Provider-specific HTTP streaming transports that combine tenant credentials, model routes, and turn-stream frames remain adapter work.                                                       |
| Skill / MCP registry            | Tool registry and admitter cover tool identity, authority, and required materials.                                                                                                                                                                                                                                            | Skill/MCP discovery, zip install policy, and front-door product routing are still experimental/product-owned. Do not graduate them to core without N>=2 pressure on the same registry shape. |

## Placement

Backend gaps:

```text
workspace-session-cloudflare live smoke evidence
cloudflare-resource non-D1 live providers
```

Adapter gaps:

```text
provider HTTP streaming transports
```

Experimental/app-owned:

```text
skill/MCP registry
front-door product routing
Cloudflare product recommendation policy
```

## Removal Conditions

- `workspace-session-cloudflare` becomes runtime-proven when the structural
  provider is exercised against a real Cloudflare Sandbox namespace with
  `TEST_RUN_ID` / `SCOPE_PREFIX` resources.
- `cloudflare-resource` D1 is runtime-proven by the opt-in live smoke:
  `TEST_RUN_ID=a08-20260527T132608Z-8957`,
  `subjectRef=a08-20260527t132608z-8957--d1-live-smoke-mpoa62u`,
  final projection `destroyed`, `eventCount=4`. Other resource kinds become
  backend-complete in separate slices.
- LLM transport becomes adapter-complete when provider HTTP streams resolve
  tenant credentials through `MaterialRef` and emit only `TurnStreamFrame`
  deltas plus terminal submit/ledger truth.
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
