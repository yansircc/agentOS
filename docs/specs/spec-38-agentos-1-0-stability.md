# Spec 38: agentOS 1.0 Stability Gates

> **Status**: Draft v0.1
> **Date**: 2026-05-27
> **Trigger**: spec-36 and spec-37 closed the effect/material substrate
> algebra, but 1.0 needs an explicit boundary between stable public API,
> runtime materialization, and cookbook pressure.

---

## 0. Invariant

1.0 freezes named algebra and named public contracts. It does not promote every
implementation file, cookbook, or product strategy into substrate.

```text
substrate-stable    = effect-boundary algebra is closed
api-stable          = public exports are named and protected
schema-frozen       = durable payload/wire shapes cannot break silently
runtime-proven      = at least one real provider path exercises the algebra
composition-honest  = product-facing flows do not create second truth
```

No compatibility fallback is part of 1.0. A missing required field, material,
scope ref, provider method, or authority contract fails fast.

---

## 1. Stability Levels

| Level              | Meaning                                                                                            | Change rule                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| substrate-stable   | The concept and generator are named in specs and code                                              | New claim phases, new truth sources, or new intent refs require a new spec                 |
| api-stable         | The export is listed in the package `PUBLIC_API.md`                                                | Removing or changing it requires an explicit breaking-change note before 1.0 finalization  |
| schema-frozen      | Ledger payloads, claim payloads, extension event payloads, and material wire refs are stable       | Breaking changes require a migration plan and a reader story                               |
| runtime-proven     | A real provider path has exercised the algebra without adding a second source of truth             | Provider implementation may evolve behind the same public contract                         |
| composition-honest | A package/cookbook composes primitives while preserving ledger/projection ownership and durability | Realtime/progress data must stay non-durable unless promoted by a separate schema decision |

---

## 2. Public API Manifests

Every 1.0-target package owns a `PUBLIC_API.md` manifest. The manifest lists:

- frozen exports;
- experimental exports;
- internal-only exports.

The root check runs `scripts/check-public-api.mjs`. Any export reachable from a
package `exports` entry must be listed as frozen or experimental. An export
listed as internal must not be reachable from a package `exports` entry.

Unlisted exports are not public API. Before 1.0, they must be removed from
public barrels, listed as experimental, or listed as frozen.

1.0 target packages:

- `@agent-os/core`;
- `@agent-os/workspace-session`;
- `@agent-os/cloudflare-resource`;
- `@agent-os/context-pack`;
- `@agent-os/decision-gate`;
- `@agent-os/turn-stream`;
- `@agent-os/run-stream`.

---

## 3. N=1 Runtime Work

`N>=2` remains the default package graduation rule. `N=1` work is allowed for
1.0 only when it materializes an already-named primitive.

Allowed:

- live backend behind an existing carrier contract;
- material resolver behind `MaterialRef` / `RefResolver`;
- realtime composition over existing ledger, submit, and turn-stream frames.

Forbidden:

- adding a fifth `PreClaim` field;
- adding a new claim phase;
- writing a second truth table for trace, run, workflow, or resource state;
- baking product approval, routing, or recommendation policy into core;
- falling back to ambient credentials, inferred scopes, or compatibility
  payloads.

Each N=1 materialization must name:

- invariant;
- owner package;
- evidence source;
- condition that graduates or removes the N=1 boundary.

---

## 4. Pre-1.0 Transition Sweep

Before a package is marked api-stable:

- legacy parsers are removed rather than frozen;
- optional fields that are required by runtime invariants become required;
- default provider/admission/material fallbacks become explicit failures;
- compatibility shims are deleted unless their failure model and removal
  condition are recorded in the manifest.

Current 1.0 decision:

- dispatch target `scopeRef` is required; string scope inference is removed;
- dispatch claim envelopes are required on requested and accepted facts;
- `Tool.contract` remains required and branded;
- `permissiveToolAdmitter` is explicit opt-in, never the default.

---

## 5. Reader Boundary

Reader/dashboard/cross-DO index contracts are not schema-frozen in 1.0. Current
reader APIs are projection-level. A future product-facing audit/dashboard
contract must stay derived from ledger facts or return to spec review.
