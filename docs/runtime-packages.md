# Runtime Packages

Public export intent is declared per package in `docs/api/*.md`; package
`PUBLIC_API.md` files are generated projections. These manifests prevent
accidental exports; they are not stability or schema-freeze promises.

<!-- agentos:generated runtime-package-map:start -->

| Package                                  | Status             | Boundary                                                                 |
| ---------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `@agent-os/kernel`                       | 0.2.x public       | platform-free claim/material/boundary/tool algebra                       |
| `@agent-os/runtime`                      | 0.2.x public       | backend-neutral runtime contracts and projections                        |
| `@agent-os/backend-cloudflare-do`        | backend            | Cloudflare DO storage, alarm, SSE, dispatch, and binding materialization |
| `@agent-os/backend-in-memory`            | backend            | in-memory CommitJournal implementation                                   |
| `@agent-os/cloudflare-resource`          | 0.2.x public       | Cloudflare D1/KV/R2/Queue/Workflow carrier facts and provider calls      |
| `@agent-os/workspace-session`            | 0.2.x public       | provider-neutral workspace/session lifecycle facts                       |
| `@agent-os/workspace-session-cloudflare` | backend            | structural Cloudflare Sandbox-compatible provider                        |
| `@agent-os/tenant-material`              | 0.2.x experimental | encrypted credential records to execution-time material                  |
| `@agent-os/llm-transport-http`           | 0.2.x experimental | HTTP provider deltas to non-durable turn frames                          |
| `@agent-os/turn-stream`                  | 0.2.x public       | token/progress frame algebra                                             |
| `@agent-os/run-stream`                   | 0.2.x public       | ledger/turn/submit-result composition                                    |
| `@agent-os/decision-gate`                | 0.2.x public       | durable decision request/decision/consumption facts                      |
| `@agent-os/skill-registry`               | 0.2.x experimental | install-time skill manifests to core tools                               |
| `@agent-os/deploy`                       | carrier            | deploy proof/projection vocabulary                                       |
| `@agent-os/git-carrier`                  | carrier            | Git proof/projection vocabulary                                          |
| `@agent-os/staging-artifact`             | carrier            | staging artifact proof/projection vocabulary                             |
| `@agent-os/verification`                 | carrier            | verification proof/projection vocabulary                                 |
| `@agent-os/sandbox`                      | optional algebra   | bounded stateless sandbox tool surface                                   |
| `@agent-os/sandbox-cloudflare`           | optional backend   | Cloudflare Sandbox-compatible stateless sandbox adapter                  |
| `@agent-os/dynamic-worker`               | optional backend   | bounded Worker-compatible code execution                                 |
| `@agent-os/image`                        | optional algebra   | image generation claim/projection helpers                                |

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
