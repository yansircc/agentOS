# Spike 07 Gaps

This file is the audit report. Confirmed gaps require both a real img-gen
source citation and a spike citation where public agentOS surface forces the
same forge.

## C1 / C2 — Cross-DO Durable Delivery

Verdict: **resolved by P1 `dispatchToScope`; C2 collapsed into C1
implementation detail**.

Shape:
- §1 #2 hand-rolled compensation / outbox around non-atomic delivery.
- §1 #3 cross-boundary glue.

img-gen evidence:
- `/Users/yansir/code/52/img-gen/src/worker/programs/confirm-request.ts:464` inserts `queue_outbox` rows in the same D1 batch as job creation.
- `/Users/yansir/code/52/img-gen/src/worker/image-jobs.ts:300` scans pending outbox rows, sends Queue messages, then marks rows sent.
- `/Users/yansir/code/52/img-gen/src/worker/index.ts:54` owns the separate Queue consumer entry.
- `/Users/yansir/code/52/img-gen/README.md:522` states D1 is truth, Queue is a delivery hint, and `queue_outbox` bridges D1 commit and Queue delivery.

original spike evidence:
- session -> user credit reserve was direct DO RPC, not ledger-owned dispatch.
- session -> consumer job dispatch was direct DO RPC, not durable outbox.
- user -> session credit reservation acknowledgement repeated the same forge.
- consumer -> session completion delivery repeated the same forge.

current spike state:
- `worker.ts:188` session -> user uses `dispatchToScope`.
- `worker.ts:207` session -> consumer uses `dispatchToScope`.
- `worker.ts:280` user -> session uses `dispatchToScope`.
- `worker.ts:345` consumer -> session uses `dispatchToScope`.
- `worker.ts` has no `GAP-C1` / `GAP-C2` markers.

Minimal primitive:

```ts
dispatchToScope({
  target: { bindingRef: string, scope: string },
  event: string,
  data: unknown,
  idempotencyKey: string
}): Promise<{ outboundEventId: number }>
```

Semantics: sender ledger atomically records outbound intent; substrate drains
intent; receiver `AgentDOBase` idempotently ingests into its ledger and fires
`on()`. Non-DO recipients stay INV-9 carriers and are out of scope.

## C3 — Resource Reservation / Release

Verdict: **resolved by P2 `Resources`**.

Shape:
- §1 #2 resource transition needs reserve now, consume later, release on failure.
- Current `withQuota` is pre-consume for tool dispatch, not business resource
  reservation.

img-gen evidence:
- `/Users/yansir/code/52/img-gen/migrations/0001_multi_user_harness.sql:133` defines mutable `credit_accounts`.
- `/Users/yansir/code/52/img-gen/migrations/0001_multi_user_harness.sql:144` defines `credit_ledger`.
- `/Users/yansir/code/52/img-gen/migrations/0001_multi_user_harness.sql:162` defines `credit_reservations`.
- `/Users/yansir/code/52/img-gen/src/worker/programs/confirm-request.ts:348` updates available/reserved credits and writes a reserve ledger row.
- `/Users/yansir/code/52/img-gen/src/worker/image-jobs.ts:865` constructs consume statements.
- `/Users/yansir/code/52/img-gen/src/worker/image-jobs.ts:904` constructs release statements.

original spike evidence:
- user scope hand-rolled `credit.reserved`.
- session scope hand-rolled settlement dispatch.

current spike state:
- `worker.ts:266` seeds a user-scope `resource.granted` fact through
  `grantResource`.
- `worker.ts:274` reserves credits through `reserveResource`.
- `worker.ts:298` consumes the reservation through `consumeResource`.
- `worker.ts` has no `GAP-C3` marker.

Minimal primitive:

```ts
grantResource({ key, amount, ref }): Promise<{ eventId }>
reserveResource({ key, amount, ref, idempotencyKey }): Promise<{ reservationId }>
consumeResource({ reservationId, ref }): Promise<void>
releaseResource({ reservationId, ref }): Promise<void>
```

Open design question: this may belong in generalized quota, or in a separate
`ResourceLedger` primitive to avoid conflating carrier rate limits with
business credits.

## C4 — R2 Blob Carrier

Verdict: **not a gap**.

img-gen evidence:
- `/Users/yansir/code/52/img-gen/README.md:522` says R2 stores bytes only.
- `/Users/yansir/code/52/img-gen/src/worker/io.ts:50` wraps R2 put.
- `/Users/yansir/code/52/img-gen/migrations/0001_multi_user_harness.sql:350` stores artifact metadata rows.

spike evidence:
- `worker.ts:312` writes bytes to R2 and records only `artifactRef` in the
  consumer/session ledgers.

Reason: this matches INV-9 carrier shape. The app owns key containment and
cleanup policy; ledger stores refs, not bytes. No second SSoT is required.

## C5 — Image-Output Route

Verdict: **resolved by P3 `generateImage`**.

Shape:
- §1 #4 capability route is currently app-owned provider config and parser.

img-gen evidence:
- `/Users/yansir/code/52/img-gen/src/worker/core.ts:100` selects image provider route from env.
- `/Users/yansir/code/52/img-gen/src/worker/core.ts:141` resolves provider credentials.
- `/Users/yansir/code/52/img-gen/src/worker/image-jobs.ts:1007` calls `/images/generations`.
- `/Users/yansir/code/52/img-gen/src/worker/image-jobs.ts:1123` decodes provider response into bytes.

original spike evidence:
- `worker.ts` used a local image-provider shim because agentOS route adapters
  were chat / structured-output only.

current spike state:
- `worker.ts:36` declares an `openai-chat-compatible-image` route.
- `worker.ts:336` calls `generateImage`.
- `worker.ts:411` materializes the returned `ImageArtifact` into bytes before
  writing R2; this remains app/carrier-owned.
- `worker.ts` has no `GAP-C5` marker.

Minimal primitive:

```ts
type ImageRoute =
  | { kind: "openai-chat-compatible-image"; endpointRef: string; credentialRef: string; modelId: string }
  | { kind: "cf-ai-binding-image"; modelId: string; gatewayRef?: string };

generateImage({ route, prompt, aspectRatio? }): Promise<ImageResult>
```

Naming note: P3 did not rename `LlmRoute`; image generation is a parallel
route family with its own public `generateImage` method.
