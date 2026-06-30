# Durable External Effect

## Goal

Compose a caller-owned durable external effect without copying private runtime
paths or turning runtime evidence into product truth.

## What You Build

A package-owned operation envelope that uses the public external-effect runner
for idempotent attempt joining, then records package-owned carrier events
through the ledger boundary.

## Prerequisites

- [Runtime API](../api/runtime.md)
- [Durable truth](../concepts/durable-truth.md)
- [Boundary contract](../boundary-contract.md)
- [Projection reader](projection-reader.md)

## Steps

1. Name the product operation outside agentOS.

   ```ts
   type ProductIntent = {
     readonly productRef: string;
     readonly idempotencyKey: string;
   };

   type ProductReceipt = {
     readonly productRef: string;
     readonly receiptRef: string;
   };
   ```

   These names are product facts. agentOS must not derive `productRef`,
   exactly-once meaning, or receipt semantics for you.

2. Define the carrier and settlement contract in the owning package.

   ```ts
   import {
     defineCarrier,
     makeOperationRef,
     type EffectClaim,
     type SettlementContract,
   } from "@yansirplus/core";

   const operationRef = (intent: ProductIntent) =>
     makeOperationRef("product_publish", [intent.productRef]);

   const productCarrier = defineCarrier({
     ownerId: "product.publish",
     prefix: "product_publish.",
     events: {
       requested: {
         kind: "requested",
         payload: ProductRequestedSchema,
         claim: { kind: "pre", key: "claim" },
       },
       completed: {
         kind: "completed",
         payload: ProductCompletedSchema,
         claim: { kind: "lived", key: "claim", anchorKinds: ["carrier_proof"] },
       },
       reconcile_required: {
         kind: "reconcile_required",
         payload: ProductReconcileSchema,
         claim: {
           kind: "indeterminate",
           key: "claim",
           indeterminateKinds: ["reconcile_required"],
         },
       },
     },
   });

   const settlement: SettlementContract = productCarrier.settlementContract;
   ```

   The carrier is where claim slots, event vocabulary, and settlement kinds are
   declared. Do not infer this contract from the external provider response.

3. Use the runner only for the attempt join.

   ```ts
   import { runExternalEffectAttempt } from "@yansirplus/runtime/external-effect";

   const projection = await Effect.runPromise(
     runExternalEffectAttempt({
       spec: intent,
       idempotencyKey: intent.idempotencyKey,
       readEvents: () => ledgerEventsForProduct(intent.productRef),
       projectByIdempotencyKey: projectProductAttempt,
       projectCurrent: projectProductCurrent,
       isRunningProjection: isRunningProductAttempt,
       activeSpecFromRunningProjection: activeIntentFromRunningProjection,
       requestStateFromRunningProjection: requestFromRunningProjection,
       request: recordProductRequested,
       runRequested: executeProviderRequest,
     }),
   );
   ```

   The runner decides only whether to request a new attempt, reuse a terminal
   projection, or continue a running attempt from caller request state. It does
   not create the ledger event, claim, receipt, witness, provider call, or
   reconcile policy.

4. Commit evidence through runtime boundary ports.

   ```ts
   import { BoundaryEvents, Ledger, WitnessPort } from "@yansirplus/runtime";

   const boundaryEvents = yield * BoundaryEvents;
   const ledger = yield * Ledger;

   const committed =
     yield *
     boundaryEvents.commit(productCarrier.boundaryContract, productCarrier.events.completed, {
       productRef: intent.productRef,
       receiptRef: projection.receiptRef,
       claim: completedClaim,
     });

   const events =
     yield *
     ledger.events({
       scopeRef: committed.scopeRef,
       effectAuthorityRef: committed.effectAuthorityRef,
     });
   ```

   `BoundaryEvents` checks the carrier contract before appending the fact.
   `Ledger` reads durable facts after commit. `WitnessPort` may help acquire a
   symbolic indeterminate ref for reconcile, but it does not settle the claim or
   own the product receipt.

5. Test with the conformance report.

   ```ts
   import {
     EXTERNAL_EFFECT_ADAPTER_OBSERVED_SCENARIOS,
     EXTERNAL_EFFECT_RUNNER_JOIN_SCENARIOS,
     externalEffectConformance,
   } from "@yansirplus/runtime/testing";

   const report = await Effect.runPromise(externalEffectConformance(productExternalEffectAdapter));
   ```

   The four runner-join scenarios are executable checks over the existing runner
   surface. The remaining scenarios are adapter observations: your test maps
   product events, receipts, witnesses, provider outcomes, and reconcile results
   to the required observation keys.

## Checkpoint

The durable recipe is valid when these facts all hold:

```text
operation identity       owned by product intent
idempotency key meaning  owned by product contract
attempt join             runExternalEffectAttempt
event vocabulary         defineCarrier in owning package
claim settlement         SettlementContract plus BoundaryEvents
durable read model       Ledger and product projection
witness/reconcile        caller adapter and WitnessPort input
provider evidence        evidence only, never canonical product ref
```

Do not import private agentOS source paths, do not copy a durable runner into
the product repo, and do not treat runtime evidence as Change, Candidate, Grant,
Intent, Receipt, Diagnostic, or Workbench truth.

## Next

Read [Runtime API](../api/runtime.md) for the exact external-effect boundary and
then add product-specific tests for your receipt, witness, and reconcile
semantics.
