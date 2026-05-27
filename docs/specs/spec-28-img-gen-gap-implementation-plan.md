# Spec 28: img-gen gap implementation plan

> **Status**: Implementation roadmap (drafted 2026-05-26)
> **v0.3 note**: superseded where it places image carrier API on
> `AgentDOBase`; spec-34 moves modality carriers out of core and keeps only
> dispatch/resource/extension authority in core.
> **Depends on**: [spec-26-img-gen-substrate-survey.md](./spec-26-img-gen-substrate-survey.md)
> **Does not implement**: img-gen product behavior. This document only orders
> confirmed substrate gaps and defines the minimal acceptance surface for each.

---

## 0. Planning invariant

> **Every shipped primitive must remove one confirmed forge from spec-26 by
> construction. A primitive is rejected if it only shortens app code, hides
> direct RPC, or creates a second source of truth next to `events`.**

Stable axis:

- `events` remains the ledger SSoT.
- pending buffers may exist only as delivery/scheduling mechanics, same class
  as `scheduled_events`: not business truth, always linked to ledger events.
- cross-scope recipients are `AgentDOBase` scopes only. Non-DO receivers are
  carriers under INV-9 and are out of scope.

Change axis:

- add the minimum substrate primitives needed by C1/C2, C3, and C5.
- keep C4 as an explicit no-op unless a future app falsifies it.

---

## 1. Dependency order

| Phase | Gap                             | Ship? | Why this order                                                                                                                      |
| ----- | ------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------- |
| P1    | C1/C2 cross-DO durable delivery |   yes | It is the control-flow generator. C3 settlement and image job fanout both become cleaner once cross-ledger delivery exists.         |
| P2    | C3 resource reservation/release |   yes | It depends on ledger projection discipline but not on image route. Can dogfood C1 by moving reservation across user/session scopes. |
| P3    | C5 image-output route           |   yes | It extends protocol capability algebra after route/admission work is stable. It should not be blocked by resource ledger design.    |
| P4    | C4 R2 blob carrier              |    no | spec-26 proved it fits INV-9: bytes in R2, refs in ledger. No substrate primitive now.                                              |

Do not start P2 or P3 by patching the retired img-gen audit workaround. Each
phase first defines the algebra, then implements core, then updates the
retained cookbook verdict for the corresponding `GAP-Cn`.

---

## 2. P1 — C1/C2 cross-DO durable delivery

### 2.1 Generator

Current app forge:

- sender scope writes a fact, then directly calls another DO via namespace RPC.
- if the call fails after the sender fact commits, delivery truth is outside
  the ledger.
- img-gen solves this with `queue_outbox`; the img-gen audit exposed the same
  forge via direct `emitEvent` RPC.

Substrate primitive:

```ts
class AgentDOBase {
  dispatchToScope(spec: {
    target: { bindingRef: string; scope: string };
    event: string;
    data: unknown;
    idempotencyKey: string;
    /** Optional W3C trace-context propagation across the DO RPC boundary.
     *  See §2.5 — substrate carries the strings unchanged; OTEL export
     *  (if any) is an app concern. Omitted when the caller has no
     *  active span. */
    traceContext?: {
      traceparent?: string;
      tracestate?: string;
    };
  }): Promise<{ outboundEventId: number }>;
}
```

App hook:

```ts
protected provideDispatchTargets(): Record<string, DurableObjectNamespace>;
```

`bindingRef` is symbolic, like `endpointRef` / `credentialRef`. All three are
execution material refs under spec-37. The ledger stores symbolic refs, not a
runtime namespace object, secret, or provider handle.

`provideDispatchTargets()` predates spec-37 and is intentionally a dispatch
target registry, not a general material resolver. Provider endpoints,
credentials, bindings, and external resources resolve through
`provideRefResolver().material`; dispatch targets resolve to
runtime `DurableObjectNamespace` objects and must not be stored or merged into
provider route config.

Deduplication SSoT:

- receiver dedupe is `(sourceScope, idempotencyKey)`.
- `idempotencyKey` is supplied by the app because only the app knows whether
  two calls represent the same business intent.
- `outboundEventId` is trace metadata only. It must never participate in
  receiver dedupe decisions.

### 2.2 SSoT placement

Sender ledger events:

- `dispatch.outbound.requested`
- `dispatch.outbound.delivered`
- `dispatch.outbound.failed`

Receiver ledger events, written in one transaction:

- `dispatch.inbound.accepted` with dispatch metadata:
  `{ sourceScope, outboundEventId, idempotencyKey, deliveredEventId, traceContext? }`
- the requested app event with payload unchanged.

The app event's payload must not be wrapped or augmented. Dispatch metadata is
substrate bookkeeping, not app fact shape.

`dispatch.inbound.*` kinds are reserved substrate bookkeeping. App handlers
must not subscribe to them. Receiver `on()` fires only for the requested app
event, exactly once, after the transaction commits. The inbound metadata row is
inserted before the app event for audit ordering, but it is not an application
reaction trigger.

Pending buffer:

- internal `dispatch_outbox` table, keyed by `outboundEventId`.
- it is not SSoT; it is a delivery buffer derived from
  `dispatch.outbound.requested`, same category as `scheduled_events`.
- any delivered marker in the outbox points to the sender-local
  `dispatch.outbound.delivered` row. Receiver ledger ids are remote metadata
  and live only in the sender `dispatch.outbound.delivered` payload.

Receiver idempotency:

- receiver must ignore duplicate `(sourceScope, idempotencyKey)` attempts by
  reading `dispatch.inbound.accepted`.
- duplicate delivery returns the existing `deliveredEventId` and does not fire
  handlers twice.

### 2.3 Minimal implementation boundary

Core files expected:

- `packages/core/src/dispatch.ts` for service/algebra.
- `packages/core/src/agent-do.ts` for public method and receiver RPC.
- `packages/core/src/event-bus.ts` untouched except normal fire path.
- `packages/core/test/dispatch-contract.test.ts`.

No dependency on Cloudflare Queues in v0. The first implementation can drain
the sender outbox synchronously after commit and via alarm retry. Queue-backed
delivery can be an implementation replacement later without changing the
public primitive.

### 2.4 Acceptance

Contract tests:

- sender `dispatch.outbound.requested` event row and `dispatch_outbox` row are
  inserted in one DO SQLite `transactionSync`.
- receiver writes exactly one app event for repeated delivery attempts.
- receiver preserves app payload exactly; dispatch metadata lives only in
  `dispatch.inbound.accepted`.
- receiver `on()` fires after commit.
- missing `bindingRef` is a config error, not silent fallback.
- reserved event kinds cannot be dispatched.
- failed first delivery leaves retryable sender state.

Cookbook update:

- record that session -> user, user -> session, session -> consumer, and
  consumer -> session use `dispatchToScope`.
- mark C1/C2 resolved by P1.

Done means direct cross-ledger RPC is no longer required by any app to express
durable delivery between `AgentDOBase` scopes.

### 2.5 Trace context propagation (W3C)

`dispatchToScope` is a substrate boundary between two independent
ledgers. Without an explicit propagation field, every cross-DO causal
chain breaks at the dispatch seam — UI / ops would see two disconnected
spans and have to correlate by `(sourceScope, outboundEventId)` after
the fact.

Carrying trace context is a substrate concern, not an OTEL one:

- core only **carries** the W3C trace-context strings
  (`traceparent`, `tracestate`) verbatim through three places:
  1. the `dispatchToScope` envelope on the wire,
  2. `dispatch.outbound.requested.payload.traceContext` on the sender ledger,
  3. `dispatch.inbound.accepted.payload.traceContext` on the receiver ledger.
- core never parses, generates, signs, or exports them.
- OTEL bridges, span emission, and exporter configuration remain app
  concerns. Apps that already run an OTEL layer (e.g. via
  `@effect/opentelemetry`) read the strings from the inbound event and
  continue their span chain.

DO RPC is **not** HTTP, so this is NOT a header — it is an explicit
structured field on the typed envelope. The W3C strings are the
serialization format, the field name is the carrier.

Apps with no tracing leave the field undefined; when absent, the field
is omitted from the dispatch envelope and from both ledger payloads, and
the propagation is a no-op. Adding tracing later is additive: app
populates the field, ledger payload schema accepts it, no version bump.

Why on P1 and not later: dispatch envelope schema is a versioned wire.
Adding `traceContext` after P1 ships requires a payload schema migration
on `dispatch.outbound.requested` / `dispatch.inbound.accepted`. Cost is
non-linear vs adding the field at design time.

---

## 3. P2 — C3 resource reservation/release

### 3.1 Generator

Current app forge:

- `withQuota` grants consumption for a carrier/tool dispatch.
- img-gen needs business resource state: grant credits, reserve credits, later
  consume or release the reservation.
- mutable account/reservation tables become a second SSoT unless the substrate
  owns the projection.

Do not overload `Quota`. Quota is dispatch consumption/rate limiting.
Resource reservation is a different state machine over ledger facts.

Resource namespace:

- `key` is a resource-kind label inside the reserving DO scope. It is not a
  global name and not a user/session namespace by itself.
- `reservationId` is an opaque reference issued by the reserving DO scope.
  Only that same scope may consume or release it.
- cross-scope callers must route follow-up consume/release back to the
  reserving scope through `dispatchToScope`; they must not interpret the
  reservation event stream locally.

Substrate service:

```ts
class Resources {
  grant(spec: {
    key: string;
    amount: number;
    ref: string;
  }): Effect.Effect<{ eventId: number }, ResourceError, Ledger>;

  reserve(spec: {
    key: string;
    amount: number;
    ref: string;
    idempotencyKey: string;
  }): Effect.Effect<{ reservationId: string }, ResourceError, Ledger>;

  consume(spec: { reservationId: string; ref: string }): Effect.Effect<void, ResourceError, Ledger>;

  release(spec: { reservationId: string; ref: string }): Effect.Effect<void, ResourceError, Ledger>;
}
```

Public `AgentDOBase` methods may wrap this service after the algebra is stable.
P2 makes that wrap explicit:

```ts
class AgentDOBase {
  grantResource(spec: { key: string; amount: number; ref: string }): Promise<{ eventId: number }>;
  reserveResource(spec: {
    key: string;
    amount: number;
    ref: string;
    idempotencyKey: string;
  }): Promise<{ reservationId: string }>;
  consumeResource(spec: { reservationId: string; ref: string }): Promise<void>;
  releaseResource(spec: { reservationId: string; ref: string }): Promise<void>;
}
```

Scope is implicit: all four methods mutate only the current DO scope.
`resource.*` event kinds are core-reserved. Apps request resource changes via
methods, not `emitEvent`.

Failure semantics:

- non-positive / non-finite `amount` rejects before writing.
- insufficient reserve writes `resource.reserve_rejected` for audit, then
  rejects with `ResourceInsufficient`.
- missing reservation rejects with `ResourceReservationNotFound`.
- consume-after-release and release-after-consume reject with
  `ResourceReservationClosed`.
- duplicate consume and duplicate release for the same terminal state are
  idempotent no-ops and write no second terminal event.

### 3.2 SSoT placement

Ledger events:

- `resource.granted`
- `resource.reserved`
- `resource.consumed`
- `resource.released`
- `resource.reserve_rejected`

Projection:

- available = grants - active reservations - consumed
- reserved = active reservations
- consumed = consumed reservations

No `resource_accounts` table in core. Any read helper is a projection over
events.

### 3.3 Minimal implementation boundary

Core files expected:

- `packages/core/src/resources.ts`.
- `packages/core/src/agent-do.ts` only if public Promise methods are added.
- `packages/core/test/resource-contract.test.ts`.

P1 dependency:

- if resource reservation lives in a user scope and request lives in a session
  scope, the app uses `dispatchToScope` to ask the user scope to reserve.

Cross-scope sequence:

```text
SessionDO
  dispatchToScope(UserDO, "credit.reserve.requested",
    { key: "credit", amount, ref, idempotencyKey })

UserDO
  on("credit.reserve.requested")
    Resources.reserve({ key, amount, ref, idempotencyKey })
    emit/dispatch "credit.reserved" or "credit.reserve_rejected"

SessionDO
  stores no resource balance.
  Later consume/release is another dispatchToScope(UserDO, ...)
  carrying the opaque reservationId issued by UserDO.
```

The extra round trip is the cost of preserving a single resource ledger owner.
If an app wants same-scope resources, it may call `Resources` directly inside
that DO; cross-scope resource mutation always returns to the owning scope.
The request/ack channel is app-owned (`credit.*` here). The core-reserved
`resource.*` namespace is only for resource ledger facts written by the
resource service.

### 3.4 Acceptance

Contract tests:

- reserve succeeds when projected available balance is sufficient.
- reserve rejects without writing `resource.reserved` when insufficient.
- same `idempotencyKey` returns same reservation.
- consume and release are mutually exclusive.
- duplicate consume/release for the same terminal state is idempotent.
- projection reconstructs balance from events only.

Cookbook update:

- record that the hand-rolled `credit.reserved` / `credit.consumed` protocol is
  replaced by `Resources`.
- mark C3 resolved by P2.

Done means apps no longer need mutable account/reservation tables to express
reserve-now, consume-or-release-later resources.

---

## 4. P3 — C5 image-output route

### 4.1 Generator

Current app forge:

- provider route selection and credential resolution live in app code.
- response decoding from provider envelope to bytes is app-owned.
- model capability is a table/config decision, not evidence/protocol algebra.

This is the same generator as spec-27, but not the same interface:
`LlmProtocolAdapter` owns text turns and structured tool-call admission.
Image generation has no turn loop. Do not force it into `decodeTurn`.

Route taxonomy:

```ts
type ImageRoute =
  | {
      kind: "openai-chat-compatible-image";
      endpointRef: string;
      credentialRef: string;
      modelId: string;
    }
  | { kind: "cf-ai-binding-image"; modelId: string; gatewayRef?: string };
```

`AiRoute` is not a public API in v0. It may become useful later, but P3 does
not rename `LlmRoute` repo-wide and does not route image generation through
`submitAgent`.

Adapter algebra:

```ts
interface ImageProtocolAdapter<K extends ImageRoute["kind"]> {
  readonly kind: K;
  readonly version: string;
  encodeImage(
    route: Extract<ImageRoute, { kind: K }>,
    request: ImageRequest,
  ): ProviderRequestBodyFor<K>;
  decodeImage(raw: unknown): ImageResult;
  classify(error: unknown): Outcome;
}

type ImageArtifact =
  | { kind: "data-url"; dataUrl: string; contentType?: string }
  | { kind: "url"; url: string; contentType?: string }
  | { kind: "bytes"; bytes: Uint8Array; contentType: string };

type ImageResult = {
  artifacts: ReadonlyArray<ImageArtifact>;
  usage?: unknown;
};
```

Core returns provider artifacts and metadata. It must not force every provider
response into bytes: OpenRouter may return `data:image/...;base64,...`, while
Cloudflare `google/nano-banana` returns an image URI. Materialization into R2
remains app/carrier-owned unless a future spike proves otherwise.

Wire shapes in scope for P3:

- `openai-chat-compatible-image`: POST `/chat/completions` with
  `modalities: ["text", "image"]`; decode
  `choices[0].message.images[].image_url.url` into `data-url` or `url`.
- `cf-ai-binding-image`: call
  `env.AI.run(route.modelId, { prompt, aspect_ratio }, { gateway })`; decode
  the provider image URI into `url`. `gatewayRef` is symbolic; the adapter maps
  it to `{ gateway: { id: gatewayRef } }`.

Out of scope for P3 v0:

- `/images/generations` OpenAI-compatible route. It is a future adapter unless
  a new app proves the two in-scope routes are insufficient.

Historical P3 public surface, superseded by spec-34:

```ts
class AgentDOBase {
  generateImage(spec: {
    route: ImageRoute;
    prompt: string;
    aspectRatio?: string;
  }): Promise<ImageResult>;
}
```

`generateImage` is no longer a core method in v0.3. Image generation has no
turn loop, no tool call loop, and no structured-output lease in core.

### 4.2 Evidence boundary

v0 does not need a lease table. It needs route/protocol ownership:

- finite image protocol adapters.
- symbolic endpoint/credential refs via `MaterialRef` and `RefResolver.material`.
- no model whitelist in app code.

If image providers show schema/capability flake similar to structured output,
add `image.generate.evidence` as a later admission-style subsystem. Trigger:
when any image adapter's `classify(error)` returns `BehaviorFailed` for the
same route/protocol in real provider runs at least three times, open a
dedicated image-admission spec (slot reserved at spec-31; spec-29 is the
ledger event stream and spec-30 is the long-running / handoff cookbook). Do
not pre-build admission without that falsifying signal.

### 4.3 Minimal implementation boundary

Package files expected:

- `packages/image/src/index.ts` public barrel plus image-owned source modules.
- `packages/image/test/adapter-contract.test.ts`.
- v0.3: `packages/core/src/agent-do.ts` does not expose image methods.

Do not rename `LlmRoute` repo-wide. A narrow additive `ImageRoute` belongs in
the image package, not the core base class.

### 4.4 Acceptance

Contract tests:

- openai-chat-compatible-image transport uses endpoint + credential refs.
- openai-chat-compatible-image decodes `message.images[].image_url.url`.
- cf-ai-binding-image uses `env.AI.run`, not fetch.
- cf-ai-binding-image passes `gatewayRef` as Workers AI gateway option.
- cf-ai-binding-image decodes provider image URI.
- invalid credentials classify as `AuthError`.
- provider data URL / URL / binary response decodes to `ImageResult`.
- no route stores raw credential in ledger or result.

Cookbook update:

- record that the local image-provider shim is replaced by `generateImage`.
- keep R2 put in the app.
- mark C5 resolved by P3.

Done means apps no longer need provider-specific image route selection and
response parsing just to call an image model.

---

## 5. P4 — C4 R2 blob carrier

No substrate implementation.

Reason:

- spec-26 and the img-gen audit show the clean ownership shape: R2 stores bytes;
  ledger stores refs.
- key containment, retention, deletion policy, and public URL policy are app
  concerns unless repeated apps show the same invariant failure.

Allowed follow-up:

- add an optional docs note under spec-24 §11.1 showing R2 as an example
  carrier implementing state-root + cleanup discipline.

Rejected follow-up:

- `R2Carrier` in core now. That would add abstraction without removing a
  confirmed forge.

---

## 6. Commit sequence

Recommended commits:

1. `spec-28: dispatchToScope design`
   - spec update only.
   - resolves open questions: outbox table shape, receiver idempotency key,
     bindingRef registry, W3C trace context propagation (§2.5).

2. `core: cross-scope dispatch primitive`
   - P1 implementation + contract tests.
   - includes `traceContext` envelope field carried verbatim on
     `dispatch.outbound.requested` / `dispatch.inbound.accepted`. Core
     does not parse, generate, or export trace context.
   - cookbook verdict update for C1/C2.

3. `spec-28: resource ledger design`
   - finalize Resource vs Quota separation.

4. `core: resource reservation ledger`
   - P2 implementation + contract tests.
   - cookbook verdict update for C3.

5. `spec-28: image route adapter design`
   - finalize route names and first image protocols.

6. `core: image-output route adapter`
   - P3 implementation + contract tests.
   - cookbook verdict update for C5.

7. `docs: record C4 no-op carrier boundary`
   - optional spec-24 note only, if useful.

---

## 7. Global verification gate

Every implementation phase must pass:

```bash
bun run typecheck
cd packages/core && bun run test
git diff --check
```

Each phase also needs a contract test proving the primitive removes the
corresponding forge. If a follow-up live smoke uses a real provider credential,
the credential must live in `.dev.vars` and never enter the ledger, docs, or
test output.

---

## 8. Stop conditions

Stop and redesign if any implementation requires:

- a second durable truth table that is not a pending buffer derived from a
  ledger event,
- non-DO cross-scope recipients in `dispatchToScope`,
- route fallbacks between protocol kinds,
- app-owned capability tables for supported models,
- R2 byte storage inside the core ledger.

Those are invariant violations, not implementation details.
