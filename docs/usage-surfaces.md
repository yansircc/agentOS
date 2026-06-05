# Usage Surfaces

agentOS is a Cloudflare-first, ledgered, capability-gated agent substrate. The
app facade makes the substrate approachable, but it does not hide the core
vocabulary: durable facts, symbolic material, explicit tool authority, and
claim settlement remain part of the model.

## Calling Surfaces

| Surface            | Package                                  | Audience                    | First symbols                                                                             |
| ------------------ | ---------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| App facade         | `@agent-os/backend-cloudflare-do`        | Cloudflare app authors      | `defineAgentDO`, `endpoint`, `credential`, `binding`, `durableObjectTarget`, `openAIChat` |
| Tool algebra       | `@agent-os/kernel/tools`                 | App and skill authors       | `defineTool`, AgentSchema arguments                                                       |
| Kernel algebra     | `@agent-os/kernel` subpaths              | Carrier and backend authors | `material-ref`, `effect-claim`, `extensions`, `boundary-contract`                         |
| Runtime substrate  | `@agent-os/runtime`                      | Backend authors             | Effect Tags, `SubmitSpec`, projections                                                    |
| Backend protocol   | `@agent-os/backend-protocol`             | Backend authors             | shared dispatch/scheduler/resource/quota semantics                                        |
| Carriers/providers | `@agent-os/*` carrier/provider packages  | Domain package authors      | `BoundaryPackage`, provider materializers                                                 |
| Composers/tooling  | `@agent-os/run-stream`, tooling packages | Ops and UI authors          | projections, manifests, install-time registries                                           |

## Minimal App Concepts

The app path has one material declaration surface and two imports:

- `defineTool` from `@agent-os/kernel/tools`;
- `defineAgentDO` and Cloudflare builders from `@agent-os/backend-cloudflare-do`.

The minimum concept set is intentional: Tool, Effect Schema args, authority,
admission, MaterialRef bindings, LLM route, submit/deliver, ledger facts, and
emit/on handlers. Dispatch, scheduling, quota, carriers, providers, resource
reservation, run streams, and advanced scope refs are opt-in.

## Facade Boundary

`defineAgentDO` lowers `bindings` into the internal `RefResolver` and
`DispatchTargetRegistry`. App code does not author resolver switches or target
maps. Behavior derives from `MaterialRef`: a Cloudflare durable-object binding
enters dispatch whether it was built with `durableObjectTarget(...)` or
`binding("cloudflare", "durable_object", ...)`.

Facade `submit` is conditional: it exists only when `llms.default` is
configured, and it accepts `AgentSubmitSpec` with `input`. Full `SubmitSpec`
stays on `createAgentDurableObject`.

Dispatch target closure is dynamic because targets are addressed by the
request's `bindingRef`; undeclared target bindings fail at call time. If a
static agent graph is added later, dispatch closure must move to construction
time.
