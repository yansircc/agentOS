# Usage Surfaces

agentOS is a Cloudflare-first, ledgered, capability-gated agent substrate. App
authors start from an authored `agent/` tree. The framework compiles that tree
into a manifest, mounts it through a backend adapter, and generates clients and
views from projections.

## Calling Surfaces

| Surface            | Package                                  | Audience               | First facts                                        |
| ------------------ | ---------------------------------------- | ---------------------- | -------------------------------------------------- |
| App authoring      | `@agent-os/agent-authoring`              | App authors            | `agent/instructions.md`, `agent/tools/*.ts`        |
| Generated client   | app framework output                     | App authors            | typed submit, stream, and info calls               |
| Backend mount      | `@agent-os/backend-cloudflare-do`        | Backend authors        | Durable Object factory, manifest mount             |
| Runtime substrate  | `@agent-os/runtime`                      | Backend authors        | Effect Tags, submit protocol, projections          |
| Backend protocol   | `@agent-os/backend-protocol`             | Backend authors        | shared dispatch/scheduler/resource/quota semantics |
| Carriers/providers | `@agent-os/*` carrier/provider packages  | Domain package authors | boundary packages, provider materializers          |
| Composers/tooling  | `@agent-os/run-stream`, tooling packages | Ops and UI authors     | projections, manifests, install-time registries    |

## Minimal App Concepts

The app path has one authored source location and one generated output surface:

- author intent lives under `agent/`;
- `instructions.md` is required;
- path segments are identities for tools, materials, domains, and interactions;
- framework defaults are versioned and visible through provenance;
- generated clients call the mounted backend.

The minimum concept set is intentional: instructions, tool declarations,
symbolic material refs, LLM route refs, interaction policy, manifest
provenance, ledger facts, and projections. Dispatch, scheduling, quota,
carriers, providers, resource reservation, run streams, and advanced scope refs
are opt-in.

## Authoring Boundary

The authoring compiler lowers the authored tree into one normalized manifest
and a provenance map. App code does not author resolver switches, backend
registries, Durable Object classes, stream registrations, or submit DTOs.

Runtime facts do not belong in authored files. Continuation refs, snapshots,
actual trigger fire times, resolved provider material, and live callback tokens
are ledger/backend facts or live material, not authoring values.

Effectful tools must explicitly declare material, execution domain,
interaction, and receipt/replay policy. The compiler may supply versioned
defaults for pure tools, but it must fail closed instead of backfilling missing
effectful authority.
