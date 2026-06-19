# Runtime Packages

Public export intent is declared per package by either manual `docs/api/*.md`
or, for migrated packages, exported TSDoc selected by `apiSourceMode`.
Package `PUBLIC_API.md` files are generated projections. These manifests
prevent accidental exports; they are not stability or schema-freeze promises.

<!-- agentos:generated runtime-package-map:start -->

| Package                                  | Published | Status                 | Boundary                                                                                                                                                                       |
| ---------------------------------------- | --------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@agent-os/kernel`                       | yes       | 0.5.x public           | platform-free claim/material/boundary/projection/AgentSchema/tool algebra plus raw JSON Schema dialect for non-LLM boundaries                                                  |
| `@agent-os/runtime`                      | yes       | 0.5.x public           | backend-neutral runtime Tag contracts, service implementations, projections, cross-carrier observability composition, trigger registry contracts, and trigger authoring types  |
| `@agent-os/runtime-protocol`             | yes       | runtime protocol       | runtime protocol vocabulary and pure projections only; runtime Effect services, generated clients, and control flow live outside @agent-os/runtime-protocol                    |
| `@agent-os/telemetry-protocol`           | yes       | telemetry protocol     | telemetry semantic vocabulary and validation only; OTLP and vendor sinks are wire adapters                                                                                     |
| `@agent-os/telemetry-otlp`               | yes       | telemetry wire adapter | OTLP and OpenTelemetry semantic-convention mapping only; telemetry source vocabulary lives in telemetry-protocol                                                               |
| `@agent-os/llm-protocol`                 | yes       | LLM protocol           | LLM protocol vocabulary and provider-neutral wire descriptors; concrete provider protocols are provider implementations                                                        |
| `@agent-os/backend-protocol`             | yes       | backend protocol       | backend protocol algebra shared by runtime services and concrete backend implementations                                                                                       |
| `@agent-os/backend-cloudflare-do`        | yes       | backend                | Cloudflare DO storage, alarm, SSE, dispatch, workspace-job response/profile composition, backend mount interpretation, and binding materialization                             |
| `@agent-os/backend-node-postgres`        | yes       | backend                | Node process plus Postgres storage, due-work claiming, dispatch retry, and backend-neutral ledger persistence                                                                  |
| `@agent-os/backend-in-memory`            | yes       | backend                | in-memory runtime Tag Live implementations                                                                                                                                     |
| `@agent-os/resource-carrier`             | yes       | 0.5.x public           | provider-neutral resource lifecycle facts and symbolic proofs                                                                                                                  |
| `@agent-os/resource-cloudflare`          | yes       | provider               | Cloudflare data and Worker resource API calls to provider-neutral resource carrier payloads                                                                                    |
| `@agent-os/workspace-session`            | yes       | 0.5.x public           | provider-neutral workspace/session lifecycle facts                                                                                                                             |
| `@agent-os/workspace-op`                 | yes       | 0.5.x public           | workspace operation request/completion/rejection fact vocabulary and external-receipt settlement                                                                               |
| `@agent-os/workspace-job`                | yes       | carrier                | workspace job request, finalized terminal artifact metadata, verifier verdict, terminal failure fact, raw debug projection, and carrier vocabulary                             |
| `@agent-os/workspace-op-local`           | yes       | provider               | local WorkspaceEnv execution to provider-neutral workspace operation completion or rejection facts                                                                             |
| `@agent-os/workspace-session-cloudflare` | yes       | backend                | structural Cloudflare Sandbox-compatible provider                                                                                                                              |
| `@agent-os/workspace-env-cloudflare`     | yes       | 0.5.x public           | structural Cloudflare Sandbox-compatible fs+exec actuator adapter                                                                                                              |
| `@agent-os/workspace-env-local`          | yes       | 0.5.x public           | Node fs and shell calls bound to one explicit host workspace root                                                                                                              |
| `@agent-os/tenant-material`              | yes       | 0.5.x experimental     | encrypted credential records to execution-time material                                                                                                                        |
| `@agent-os/llm-transport-http`           | yes       | 0.5.x experimental     | HTTP provider deltas to non-durable turn frames                                                                                                                                |
| `@agent-os/llm-transport-effect-ai`      | yes       | 0.5.x experimental     | agentOS LlmRoute/material/tool/output algebra to Effect AI LanguageModel calls                                                                                                 |
| `@agent-os/agent-authoring`              | yes       | 0.5.x experimental     | pure authoring projection only; no filesystem IO, backend mounting, runtime ledger facts, generated clients, or live material resolution                                       |
| `@agent-os/attached-stream`              | yes       | 0.5.x experimental     | runtime-neutral attached stream frame algebra; no ledger truth ownership                                                                                                       |
| `@agent-os/turn-stream`                  | yes       | 0.5.x public           | token/progress frame algebra                                                                                                                                                   |
| `@agent-os/workspace-env`                | yes       | 0.5.x public           | runtime-neutral WorkspaceEnv actuator; no ledger fact ownership                                                                                                                |
| `@agent-os/ag-ui`                        | yes       | 0.5.x public           | framework-neutral opt-in AG-UI edge protocol projection; client state remains the runtime-protocol Recorded vocabulary                                                         |
| `@agent-os/client`                       | yes       | 0.5.x public           | framework-neutral client state machine surface; consumes runtime-protocol Recorded projections and injected transports, with no React, Svelte, AG-UI, or product UI dependency |
| `@agent-os/client-react`                 | yes       | 0.5.x public           | React reactivity bridge only; no AG-UI mapping, runtime event decoding, transport logic, component source, or local UI read-model vocabulary                                   |
| `@agent-os/client-svelte`                | yes       | 0.5.x public           | Svelte reactivity bridge only; no AG-UI mapping, runtime event decoding, transport logic, component source, or local UI read-model vocabulary                                  |
| `@agent-os/workspace-agent`              | yes       | 0.5.x public           | workspace mechanism only; projection reads are replayable, commands use generic rpcInvoker, Live reconcile policy remains authored                                             |
| `@agent-os/run-stream`                   | yes       | 0.5.x public           | ledger/turn/submit-result composition                                                                                                                                          |
| `@agent-os/workspace-binding`            | yes       | 0.5.x public           | run-scoped submit bindings over workspace-env tools and material refs; no diagnostics, path policy, or effectful executor                                                      |
| `@agent-os/sse-http`                     | yes       | 0.5.x experimental     | HTTP Response and stream lifecycle wrappers over composer-owned frame codecs                                                                                                   |
| `@agent-os/decision-gate`                | yes       | 0.5.x public           | durable decision request/decision/consumption facts                                                                                                                            |
| `@agent-os/deploy`                       | yes       | carrier                | deploy proof/projection vocabulary                                                                                                                                             |
| `@agent-os/deploy-cloudflare`            | yes       | provider               | Cloudflare Worker artifact material, resolver composition, digest validation, and deploy carrier                                                                               |
| `@agent-os/git-carrier`                  | yes       | carrier                | Git proof/projection vocabulary                                                                                                                                                |
| `@agent-os/staging-artifact`             | yes       | carrier                | staging artifact proof/projection vocabulary                                                                                                                                   |
| `@agent-os/verification`                 | yes       | carrier                | verification proof/projection vocabulary                                                                                                                                       |
| `@agent-os/sandbox`                      | yes       | optional algebra       | bounded stateless sandbox tool surface                                                                                                                                         |
| `@agent-os/sandbox-cloudflare`           | yes       | optional backend       | Cloudflare Sandbox-compatible stateless sandbox adapter                                                                                                                        |
| `@agent-os/dynamic-worker`               | yes       | optional backend       | bounded Worker-compatible code execution                                                                                                                                       |
| `@agent-os/image`                        | yes       | optional algebra       | provider-neutral image event namespace and reader algebra                                                                                                                      |
| `@agent-os/image-resource-settlement`    | yes       | provider helper        | provider-side Effect helper for resource consume/release; image carrier owns only vocabulary and projections                                                                   |
| `@agent-os/ops-api`                      | yes       | tooling                | terminal ops API adapter, not substrate truth                                                                                                                                  |
| `@agent-os/ops-htmx`                     | yes       | tooling                | terminal ops UI adapter, not substrate truth                                                                                                                                   |
| `@agent-os/docs-site`                    | no        | tooling                | static documentation site projection, not documentation fact source                                                                                                            |

<!-- agentos:generated runtime-package-map:end -->

<!-- agentos:generated holds:start -->

MCP registry support is not part of the 0.5.x surface; it remains a hold until discovery, install, authority, and material contracts converge across products.

<!-- agentos:generated holds:end -->

## Cloudflare Resource Boundary

The Cloudflare resource carrier records lifecycle and mutation proofs. It does
not store resource data.

```text
D1             carrier: lifecycle + exec proof       outside carrier: rows
KV namespace   carrier: lifecycle + mutation proof   outside carrier: values
R2 bucket      carrier: lifecycle + mutation proof   outside carrier: object bytes
Queue          carrier: lifecycle + mutation proof   outside carrier: message bodies
Workflow       carrier: lifecycle + mutation proof   outside carrier: step payloads
```

Carrier payloads may contain symbolic refs, proof refs, mutation refs, and
fingerprints. They must not contain provider tokens, raw data, raw response
bodies, SQL, object bytes, message bodies, workflow payloads, or live handles.

## Streaming Boundary

`@agent-os/turn-stream` frames are progress only. `@agent-os/run-stream`
combines ledger events, turn frames, and a terminal submit result. Durable truth
remains the ledger plus `SubmitResult`.
