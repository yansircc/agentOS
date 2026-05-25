# Spike 07 Gaps

This file is the audit report. Confirmed gaps require both a real img-gen
source citation and a spike citation where public agentOS surface forces the
same forge.

## C1 / C2 — Cross-DO Durable Delivery

Verdict: **confirmed gap; C2 collapses into C1 implementation detail**.

Shape:
- §1 #2 hand-rolled compensation / outbox around non-atomic delivery.
- §1 #3 cross-boundary glue.

img-gen evidence:
- `/Users/yansir/code/52/img-gen/src/worker/programs/confirm-request.ts:464` inserts `queue_outbox` rows in the same D1 batch as job creation.
- `/Users/yansir/code/52/img-gen/src/worker/image-jobs.ts:300` scans pending outbox rows, sends Queue messages, then marks rows sent.
- `/Users/yansir/code/52/img-gen/src/worker/index.ts:54` owns the separate Queue consumer entry.
- `/Users/yansir/code/52/img-gen/README.md:522` states D1 is truth, Queue is a delivery hint, and `queue_outbox` bridges D1 commit and Queue delivery.

spike evidence:
- `worker.ts:181` session -> user credit reserve is direct DO RPC, not ledger-owned dispatch.
- `worker.ts:202` session -> consumer job dispatch is direct DO RPC, not durable outbox.
- `worker.ts:269` user -> session credit reservation acknowledgement repeats the same forge.
- `worker.ts:330` consumer -> session completion delivery repeats the same forge.

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

Verdict: **confirmed gap**.

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

spike evidence:
- `worker.ts:257` user scope hand-rolls `credit.reserved`.
- `worker.ts:223` session scope hand-rolls settlement dispatch.

Minimal primitive:

```ts
reserveResource({ key, amount, ref }): Promise<{ reservationId }>
consumeReservation({ reservationId, ref }): Promise<void>
releaseReservation({ reservationId, ref }): Promise<void>
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

Verdict: **confirmed gap**.

Shape:
- §1 #4 capability route is currently app-owned provider config and parser.

img-gen evidence:
- `/Users/yansir/code/52/img-gen/src/worker/core.ts:100` selects image provider route from env.
- `/Users/yansir/code/52/img-gen/src/worker/core.ts:141` resolves provider credentials.
- `/Users/yansir/code/52/img-gen/src/worker/image-jobs.ts:1007` calls `/images/generations`.
- `/Users/yansir/code/52/img-gen/src/worker/image-jobs.ts:1123` decodes provider response into bytes.

spike evidence:
- `worker.ts:306` uses a local image-provider shim because agentOS route
  adapters are chat / structured-output only.

Minimal primitive:

```ts
type AiRoute =
  | LlmChatRoute
  | StructuredOutputRoute
  | { kind: "image-output"; endpointRef: string; credentialRef: string; modelId: string };

generateImage(route, request): Promise<{ artifact: Uint8Array | R2Ref; usage?: Usage }>
```

Naming note: `LlmRoute` may be too narrow once image-output lands. The
generator is route capability evidence, not Tool execution.
