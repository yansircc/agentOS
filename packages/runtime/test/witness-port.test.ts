import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { decodeRecordedLedgerEvent, type LedgerEvent } from "@agent-os/kernel/types";
import {
  defineSettlementContract,
  settleIndeterminate,
} from "@agent-os/kernel/settlement-contract";
import { BoundaryEvents } from "../src/boundary-events";
import { commitBoundaryEvent } from "../src/boundary-commit";
import { WitnessPort, makeWitnessPort } from "../src/witness-port";

const settlement = defineSettlementContract({
  settlementId: "@agent-os/witness-test",
  anchorKinds: [],
  rejectionKinds: [],
  indeterminateKinds: ["provider_pending"],
});

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
        indeterminateKinds: ["provider_pending"],
      },
    },
  },
  effectAuthorityContracts: [],
  materialRequirements: [],
  settlement,
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

const claim = makePreClaim({
  operationRef: "witness:op",
  scopeRef: { kind: "conversation", scopeId: "thread:1" },
  effectAuthorityRef: { authorityId: "witness.record", authorityClass: "effect" },
  originRef: { originId: "witness-test", originKind: "test" },
});

const commitPending = (payload: unknown) =>
  Effect.gen(function* () {
    const boundaryEvents = yield* BoundaryEvents;
    return yield* boundaryEvents.commit(contract, "witness.pending", payload);
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
        commit: (targetContract: typeof contract, event: string, payload: unknown) =>
          commitBoundaryEvent(targetContract, event, payload, (identity) =>
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
