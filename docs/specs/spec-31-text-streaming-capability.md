# Spec 31: Text Streaming Capability

> **Status**: superseded by [spec-34-authorized-commit-calculus.md](./spec-34-authorized-commit-calculus.md)

---

## 0. Revision

v0.3 removes text streaming from `@agent-os/core`.

The previous `AgentDOBase.submitTextStream` surface and the LLM adapter
`textStream` / `dispatchProviderStream` transport seam are deleted from core.
There is no fallback token streaming API in v0.3.

## 1. Boundary

Core retains only durable ledger streaming:

```ts
streamEvents(opts): Response
```

Token deltas are not ledger facts and are not a core vocabulary. A future
`@agent-os/streaming` package may reintroduce token transport through the
extension capability protocol in spec-34 §7, but that package must own its
transport and any package-specific event namespace. It must not write
`agent.*`, `llm.*`, `dispatch.*`, `resource.*`, or any other core-owned facts.

## 2. Historical Note

The deleted v0.2 design treated token streaming as `submit + token transport`.
That made `submitTextStream` look kernel-rank because it lived beside
`submit` on `AgentDOBase`. Spec-34 corrects the boundary:

- `submit` is the durable closed-loop composite.
- `streamEvents` is the durable ledger wire.
- token streaming is an optional carrier/package concern outside core.
