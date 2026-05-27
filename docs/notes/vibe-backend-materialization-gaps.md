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
| `cloudflare-resource`           | Proof algebra, extension prefix, authority material requirements, payloads, failure settlement, projections, and live D1/KV/R2/Queue/Workflow carriers exist. Carrier payloads are symbolic refs/proofs/fingerprints only. D1/KV/R2/Queue live smoke passed with `.dev.vars` credentials on 2026-05-28. | Workflow has provider code and stubbed contract tests, but live smoke needs an app-supplied Worker script/class material. Vectorize/Browser Rendering/Schedule are out of current core5 scope. |
| LLM transport + tenant material | `MaterialRef`, `RefResolver`, `llmRouteMaterialRefs`, tenant credential resolver, provider token-delta adapters, and `@agent-os/llm-transport-http` exist. Resolved credentials stay execution-time material; transport output is non-durable `TurnStreamFrame`.                                        | Live provider smoke for OpenAI-compatible/Anthropic/Gemini HTTP streams is still local opt-in evidence, not default CI.                                                                      |
| Skill / MCP registry            | Tool registry and admitter cover tool identity, authority, and required materials. `@agent-os/skill-registry` registers install-time skill manifests into runtime `ToolContract`s and exports no ledger/event/projection vocabulary.                                                                   | MCP discovery, zip install policy, and front-door product routing remain hold/product-owned. Do not graduate MCP to core without N>=2 pressure on the same registry shape.                    |

## Placement

Backend gaps:

```text
workspace-session-cloudflare live smoke evidence
cloudflare-resource Workflow live smoke evidence
```

Adapter gaps:

```text
provider HTTP streaming live smoke evidence
```

Experimental/app-owned:

```text
MCP registry
front-door product routing
Cloudflare product recommendation policy
```

## Removal Conditions

- `workspace-session-cloudflare` becomes runtime-proven when the structural
  provider is exercised against a real Cloudflare Sandbox namespace with
  `TEST_RUN_ID` / `SCOPE_PREFIX` resources.
- `cloudflare-resource` D1 is runtime-proven by the opt-in live smoke:
  `TEST_RUN_ID=a08-20260527T132608Z-8957`,
  `subjectRef=a08-20260527t132608z-8957--d1-live-smoke-mpoanzv`,
  final projection `destroyed`, `eventCount=4`.
- `cloudflare-resource` core live smoke additionally exercised D1, KV
  namespace, R2 bucket, and Queue on 2026-05-28 with
  `TEST_RUN_ID=a26-20260527T193544Z`; all final projections were `destroyed`.
  R2 produced `eventCount=5` because the smoke records an explicit
  `r2_bucket.delete_object` mutation before bucket destroy.
- `cloudflare-resource` Workflow becomes runtime-proven when an app supplies a
  real Worker script/class material and the provider exercises provision,
  bind, `workflow.create_instance`, and destroy with prefixed live resources.
- LLM transport becomes adapter-complete when provider HTTP streams resolve
  tenant credentials through `MaterialRef` and emit only `TurnStreamFrame`
  deltas plus terminal submit/ledger truth.
- Skill registry stays public-experimental until two products share the same
  install-time manifest shape. MCP graduates only when two products need the
  same discovery, install, authority, and material contract.

## Non-Gaps

These do not require substrate changes:

- subagent invocation: use dispatch/submit authority plus child run refs;
- long-running effects: compose scheduler intent, submit/carrier effects, and
  ledger projection;
- cross-DO "global truth": use derived indexes over per-DO ledgers;
- token deltas: non-durable `turn-stream` / `run-stream` composition, not
  ledger facts.
