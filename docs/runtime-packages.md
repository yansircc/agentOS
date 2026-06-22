# Runtime Packages

Public export intent is declared per package by either manual `docs/api/*.md`
or, for migrated packages, exported TSDoc selected by `apiSourceMode`.
Package `PUBLIC_API.md` files are generated projections. These manifests
prevent accidental exports; they are not stability or schema-freeze promises.

<!-- agentos:generated runtime-package-map:start -->

| Package               | Published | Status       | Boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | --------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-os/core`      | yes       | 0.5.x public | neutral core algebra only: no runtime service loop, backend interpreter, framework adapter, provider SDK, target ambient implementation, or disputed event-projection fold                                                                                                                                                                                                                                                                                            |
| `@agent-os/runtime`   | yes       | 0.5.x public | runtime root exports only backend-neutral ledger/projection/service algebra. Platform/provider and wire-projection integrations live behind explicit subpath exports: ./ag-ui, ./cloudflare, ./cloudflare/do-rpc, ./in-memory, ./node, ./llm-effect-ai, and ./telemetry-otlp; root JS and root declarations must not leak subpath-only peers. The ./ag-ui subpath is a browser-safe projection over runtime-protocol Recorded vocabulary, not the client state model. |
| `@agent-os/client`    | yes       | 0.5.x public | framework-neutral root client state machine surface plus React/Svelte subpath adapters; root consumes runtime-protocol Recorded projections and injected transports with no React, Svelte, AG-UI, or product UI dependency                                                                                                                                                                                                                                            |
| `@agent-os/cli`       | yes       | 0.5.x public | host-side Node command runner only; it may read repo source files and package metadata, but it does not own ledger identity, runtime facts, target linking semantics, or generated projection truth                                                                                                                                                                                                                                                                   |
| `@agent-os/docs-site` | no        | tooling      | static documentation site projection, not documentation fact source                                                                                                                                                                                                                                                                                                                                                                                                   |

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

Runtime progress frames and run projections live under `@agent-os/runtime`.
Client-facing stream consumption uses `@agent-os/client` or the
`@agent-os/runtime/ag-ui` wire-projection subpath. Durable truth remains the
ledger plus `SubmitResult`.
