# Spec 31: Text Streaming Capability

> **Status**: v0 implementation contract
> **Relates to**: [spec-24-invariants-and-surface.md](./spec-24-invariants-and-surface.md),
> [spec-27-llm-protocol-adapter.md](./spec-27-llm-protocol-adapter.md),
> [spec-29-ledger-event-stream.md](./spec-29-ledger-event-stream.md)

---

## 0. Boundary

`submitTextStream` exists for one case only:

- text-only LLM turn
- token deltas delivered as ephemeral SSE
- final turn facts written to the ledger

It does **not** support tools or `outputSchema`. Non-streaming `submit` remains
the tools / structured-output surface.

Token deltas are not ledger facts. The ledger SSoT is the final turn:
`chat.ingested`, `llm.response`, and the app deliver event.

---

## 1. Invariants

### I1. Adapter capability, not app compatibility checks

`LlmProtocolAdapter` owns streaming capability:

```ts
textStream:
  | { supported: true; encode(...); decodeFrames(...) }
  | { supported: false; reason: string }
```

Public code never checks `route.kind === "openai-chat-compatible"` to decide
whether streaming works. It asks the adapter. In v0 only the
`openai-chat-compatible` adapter declares `supported: true`; all other
adapters explicitly declare unsupported.

### I2. Separate transport seam

Streaming transport is not a flag on `dispatchProvider`.

```ts
dispatchProvider(route, body): Effect<unknown, ...>
dispatchProviderStream(route, body, signal): Effect<ReadableStream<Uint8Array>, ...>
```

The non-streaming seam returns decoded JSON-ish upstream payloads. The streaming
seam returns bytes. Mixing these into one return type would leak transport
shape into all callers.

### I3. Final fact equivalence

When streaming completes normally, the final `llm.response` payload must have
the same shape as the non-streaming text path:

```ts
{
  turn: { id: number; index: number },
  text: string,
  toolCalls: [],
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
}
```

`turn.id` is the `chat.ingested` ledger id. `turn.index` is `0` for v0
streaming because tools and multi-turn loops are not supported.

The app deliver event payload is likewise:

```ts
{ final: string, turn: { id: number; index: number } }
```

### I4. Client disconnect is not delivery

If the client disconnects before normal completion:

- write `agent.aborted.client_disconnect`
- include `{ turnId }` in the abort payload
- do not write `llm.response`
- do not write the app deliver event

Partial token text is not promoted to a fact.

---

## 2. Public API

```ts
class AgentDOBase {
  submitTextStream(spec: {
    system?: string;
    intent: string;
    context: Record<string, unknown>;
    route: LlmRoute;
    deliver: { event: string };
  }): Response
}
```

The method returns an SSE `Response`.

Unsupported adapter capability returns an SSE abort frame and records an
upstream abort fact for the ingested turn. It does not call the provider.

---

## 3. SSE Wire Contract

`submitTextStream` returns `Content-Type: text/event-stream`.

Frames:

```text
event: token
data: {"delta":"..."}

event: usage
data: {"promptTokens":1,"completionTokens":2,"totalTokens":3}

event: done
data: {"turnId":1,"llmResponseId":2,"deliveredId":3}

event: aborted
data: {"turnId":1,"code":"upstream_failure","reason":"..."}
```

`done.deliveredId` lets a UI deduplicate the stream completion with the ledger
SSE row emitted by `streamEvents`.

For client disconnects the client usually cannot receive the `aborted` frame;
the ledger abort fact is the durable proof.

---

## 4. OpenAI-Compatible v0

The `openai-chat-compatible` adapter implements:

- request body with `stream: true`
- `stream_options: { include_usage: true }`
- SSE frame decoder for Chat Completions chunks

The adapter emits typed frames:

```ts
{ type: "token"; delta: string }
{ type: "usage"; usage: LlmUsage }
{ type: "done" }
```

Malformed stream frames are upstream failures. They must not write deliver.

---

## 5. Out Of Scope

- stream + tools
- stream + `outputSchema`
- token deltas in the ledger
- provider-side stream retry
- EventSource browser reconnection policy
- Anthropic / Gemini streaming adapters

