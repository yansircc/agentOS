import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { defineBoundaryContract, type BoundaryContract } from "@agent-os/core/boundary-contract";
import { makePreClaim } from "@agent-os/core/effect-claim";
import type { EffectAuthorityBinding } from "@agent-os/core/material-ref";
import { RUNTIME_FACT_OWNER, type RuntimeEventCommitSpec } from "@agent-os/core/runtime-protocol";
import { decodeRecordedLedgerEvent, type LedgerEvent } from "@agent-os/core/types";
import { defineSettlementContract, settleIndeterminate } from "@agent-os/core/settlement-contract";
import { BoundaryEvents } from "../src/boundary-events";
import {
  boundaryCommitIdentity,
  commitBoundaryEvent,
  validateBoundaryEventPayload,
  validateCommittedBoundaryEvent,
} from "../src/boundary-commit";
import { WitnessPort, makeWitnessPort } from "../src/witness-port";

const settlement = defineSettlementContract({
  settlementId: "@agent-os/witness-test",
  anchorKinds: [],
  rejectionKinds: [],
  indeterminateKinds: ["provider_pending"],
});

const authorityContractId = "witness-test.authority";
const witnessAuthorityRef = { authorityId: "witness.record", authorityClass: "effect" } as const;

const contract = defineBoundaryContract({
  ownerId: "@agent-os/witness-test",
  sourcePackageName: "@agent-os/witness-test",
  kindPrefixes: ["witness."],
  roles: ["resolver", "reader"],
  events: {
    "witness.pending": {
      payloadSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      claim: {
        key: "claim",
        phase: "indeterminate",
        authorityContractId,
        indeterminateKinds: ["provider_pending"],
      },
    },
  },
  effectAuthorityContracts: [
    {
      authorityContractId,
      selector: { kind: "exact", authorityRef: witnessAuthorityRef },
      requiredMaterialSlots: [],
    },
  ],
  materialRequirements: [],
  settlement,
});

const claim = makePreClaim({
  operationRef: "witness:op",
  scopeRef: { kind: "conversation", scopeId: "thread:1" },
  effectAuthorityRef: witnessAuthorityRef,
  originRef: { originId: "witness-test", originKind: "test" },
});

const commitPending = (payload: unknown) =>
  Effect.gen(function* () {
    const boundaryEvents = yield* BoundaryEvents;
    return yield* boundaryEvents.commit(contract, "witness.pending", payload, undefined);
  });

describe("WitnessPort", () => {
  it.effect("returns only symbolic indeterminate input; BoundaryEvents records it", () =>
    Effect.gen(function* () {
      const events: LedgerEvent[] = [];
      const witnessPort = makeWitnessPort(() =>
        Effect.succeed({
          indeterminateId: "pending:1",
          indeterminateKind: "provider_pending",
          reason: "provider_pending",
          carrierRef: "provider:openai",
        }),
      );
      const boundaryEvents = {
        commit: (
          targetContract: BoundaryContract,
          event: string,
          payload: unknown,
          authorityBinding: EffectAuthorityBinding | undefined,
        ) =>
          commitBoundaryEvent(targetContract, event, payload, authorityBinding, (identity) =>
            Effect.sync(() => {
              const row = {
                id: events.length + 1,
                ts: (events.length + 1) * 10,
                kind: event,
                scopeRef: identity.scopeRef ?? claim.scopeRef,
                effectAuthorityRef: identity.effectAuthorityRef ?? claim.effectAuthorityRef,
                factOwnerRef: identity.factOwnerRef,
                payload,
              } satisfies LedgerEvent;
              events.push(row);
              return decodeRecordedLedgerEvent(row);
            }),
          ),
        commitWithRuntimeEvents: (
          targetContract: BoundaryContract,
          event: string,
          payload: unknown,
          authorityBinding: EffectAuthorityBinding | undefined,
          runtimeEvents: (
            boundaryEventId: number,
          ) => readonly [RuntimeEventCommitSpec, ...RuntimeEventCommitSpec[]],
        ) =>
          Effect.gen(function* () {
            const rejected = validateBoundaryEventPayload(
              targetContract,
              event,
              payload,
              authorityBinding,
            );
            if (rejected !== null) return yield* Effect.fail(rejected);
            const objectPayload = payload as Readonly<Record<string, unknown>>;
            const identity = boundaryCommitIdentity(targetContract, event, objectPayload);
            const boundaryId = events.length + 1;
            const boundaryEvent = {
              id: boundaryId,
              ts: boundaryId * 10,
              kind: event,
              scopeRef: identity.scopeRef ?? claim.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef ?? claim.effectAuthorityRef,
              factOwnerRef: identity.factOwnerRef,
              payload,
            } satisfies LedgerEvent;
            const committedRejected = validateCommittedBoundaryEvent(
              targetContract,
              event,
              objectPayload,
              boundaryEvent,
              authorityBinding,
            );
            if (committedRejected !== null) return yield* Effect.fail(committedRejected);
            const committedRuntimeEvents = runtimeEvents(boundaryId).map(
              (runtimeEvent, index) =>
                ({
                  id: boundaryId + index + 1,
                  ts: runtimeEvent.ts ?? (boundaryId + index + 1) * 10,
                  kind: runtimeEvent.kind,
                  scopeRef: runtimeEvent.scopeRef,
                  effectAuthorityRef: runtimeEvent.effectAuthorityRef,
                  factOwnerRef: RUNTIME_FACT_OWNER,
                  payload: runtimeEvent.payload,
                }) satisfies LedgerEvent,
            );
            const committed = [boundaryEvent, ...committedRuntimeEvents];
            events.push(...committed);
            const recorded = committed.map(decodeRecordedLedgerEvent);
            return [recorded[0]!, ...recorded.slice(1)] as const;
          }),
      };

      const ref = yield* Effect.gen(function* () {
        const port = yield* WitnessPort;
        return yield* port.witness({ operationRef: claim.operationRef });
      }).pipe(Effect.provideService(WitnessPort, witnessPort));

      expect(events).toHaveLength(0);

      const indeterminateClaim = settleIndeterminate(settlement, claim, ref);
      const recorded = yield* commitPending({ claim: indeterminateClaim }).pipe(
        Effect.provideService(BoundaryEvents, boundaryEvents),
      );

      expect(recorded).toMatchObject({
        kind: "witness.pending",
        factOwnerRef: "@agent-os/witness-test",
        scopeRef: claim.scopeRef,
        effectAuthorityRef: claim.effectAuthorityRef,
      });
      expect(events).toHaveLength(1);
    }),
  );

  it.effect("fails closed without leaking resolver output into the error payload", () =>
    Effect.gen(function* () {
      const witnessPort = makeWitnessPort(() => Effect.succeed({ secret: "sk-test" }));
      const result = yield* Effect.result(witnessPort.witness({ operationRef: "witness:op" }));

      expect(Result.isFailure(result)).toBe(true);
      const failure = Result.isFailure(result) ? result.failure : null;
      expect(failure).toMatchObject({ issue: "indeterminate_ref_invalid" });
      expect(JSON.stringify(failure)).not.toContain("sk-test");
    }),
  );
});
