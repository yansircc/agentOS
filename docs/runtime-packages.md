# Runtime Packages

Public export intent is declared per package in `docs/api/*.md`; package
`PUBLIC_API.md` files are generated projections. These manifests prevent
accidental exports; they are not stability or schema-freeze promises.

<!-- agentos:generated runtime-package-map:start -->

| Package                                  | Published | Status             | Boundary                                                                                                    |
| ---------------------------------------- | --------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `@agent-os/kernel`                       | yes       | 0.2.x public       | platform-free claim/material/boundary/schema/tool algebra                                                   |
| `@agent-os/runtime`                      | yes       | 0.2.x public       | backend-neutral runtime Tag contracts, projections, trigger registry contracts, and trigger authoring types |
| `@agent-os/backend-protocol`             | yes       | backend protocol   | backend-only protocol algebra shared by concrete backend implementations                                    |
| `@agent-os/backend-cloudflare-do`        | yes       | backend            | Cloudflare DO app facade, storage, alarm, SSE, dispatch, and binding materialization                        |
| `@agent-os/backend-in-memory`            | yes       | backend            | in-memory runtime Tag Live implementations                                                                  |
| `@agent-os/resource-carrier`             | yes       | 0.2.x public       | provider-neutral resource lifecycle facts and symbolic proofs                                               |
| `@agent-os/resource-cloudflare`          | yes       | provider           | Cloudflare data and Worker resource API calls to provider-neutral resource carrier payloads                 |
| `@agent-os/workspace-session`            | yes       | 0.2.x public       | provider-neutral workspace/session lifecycle facts                                                          |
| `@agent-os/workspace-session-cloudflare` | yes       | backend            | structural Cloudflare Sandbox-compatible provider                                                           |
| `@agent-os/tenant-material`              | yes       | 0.2.x experimental | encrypted credential records to execution-time material                                                     |
| `@agent-os/llm-transport-http`           | yes       | 0.2.x experimental | HTTP provider deltas to non-durable turn frames                                                             |
| `@agent-os/attached-stream`              | yes       | 0.2.x experimental | runtime-neutral attached stream frame algebra; no ledger truth ownership                                    |
| `@agent-os/turn-stream`                  | yes       | 0.2.x public       | token/progress frame algebra                                                                                |
| `@agent-os/run-stream`                   | yes       | 0.2.x public       | ledger/turn/submit-result composition                                                                       |
| `@agent-os/decision-gate`                | yes       | 0.2.x public       | durable decision request/decision/consumption facts                                                         |
| `@agent-os/skill-registry`               | no        | 0.2.x experimental | install-time skill manifests to core tools                                                                  |
| `@agent-os/deploy`                       | yes       | carrier            | deploy proof/projection vocabulary                                                                          |
| `@agent-os/deploy-cloudflare`            | yes       | provider           | Cloudflare Worker artifact material, resolver composition, digest validation, and deploy carrier            |
| `@agent-os/git-carrier`                  | yes       | carrier            | Git proof/projection vocabulary                                                                             |
| `@agent-os/staging-artifact`             | yes       | carrier            | staging artifact proof/projection vocabulary                                                                |
| `@agent-os/verification`                 | yes       | carrier            | verification proof/projection vocabulary                                                                    |
| `@agent-os/sandbox`                      | yes       | optional algebra   | bounded stateless sandbox tool surface                                                                      |
| `@agent-os/sandbox-cloudflare`           | yes       | optional backend   | Cloudflare Sandbox-compatible stateless sandbox adapter                                                     |
| `@agent-os/dynamic-worker`               | yes       | optional backend   | bounded Worker-compatible code execution                                                                    |
| `@agent-os/image`                        | yes       | optional algebra   | provider-neutral image event namespace and reader algebra                                                   |
| `@agent-os/ops-api`                      | yes       | tooling            | terminal ops API adapter, not substrate truth                                                               |
| `@agent-os/ops-htmx`                     | yes       | tooling            | terminal ops UI adapter, not substrate truth                                                                |
| `@agent-os/docs-site`                    | no        | tooling            | static documentation site projection, not documentation fact source                                         |

<!-- agentos:generated runtime-package-map:end -->

<!-- agentos:generated holds:start -->

MCP registry support is not part of the 0.2.x surface; it remains a hold until discovery, install, authority, and material contracts converge across products.

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
