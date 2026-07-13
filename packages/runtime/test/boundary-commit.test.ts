import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import {
  defineBoundaryContract,
  type BoundaryEventContract,
} from "@agent-os/core/boundary-contract";
import type { EffectClaim } from "@agent-os/core/effect-claim";
import { makePreClaim } from "@agent-os/core/effect-claim";
import { decodeRecordedLedgerEvent, type LedgerEvent } from "@agent-os/core/types";
import {
  defineSettlementContract,
  settleIndeterminate,
  settleLived,
  settleRejected,
} from "@agent-os/core/settlement-contract";
import { commitBoundaryEvent, validateBoundaryEventPayload } from "../src/boundary-commit";

const emptyPayload = {
  type: "object",
  properties: {},
  additionalProperties: false,
} satisfies BoundaryEventContract["payloadSchema"];

const settlement = defineSettlementContract({
  settlementId: "@agent-os/slot-vocab",
  anchorKinds: ["ledger_event", "carrier_proof"],
  rejectionKinds: ["policy_denied", "provider_rejected"],
  indeterminateKinds: ["provider_pending", "reconcile_required"],
});
const authorityContractId = "slot.runtime";
const expectedAuthorityRef = { authorityId: "slot.record", authorityClass: "effect" } as const;
const authorityBinding = { authorityContractId, expectedAuthorityRef };
const claimAuthority = { authorityContractId } as const;

const contract = defineBoundaryContract({
  ownerId: "@agent-os/slot-vocab",
  sourcePackageName: "@agent-os/slot-vocab",
  kindPrefixes: ["slot."],
  roles: ["generator", "reader"],
  events: {
    "slot.ledgered": {
      payloadSchema: emptyPayload,
      claim: { key: "claim", phase: "lived", ...claimAuthority, anchorKinds: ["ledger_event"] },
    },
    "slot.proved": {
      payloadSchema: emptyPayload,
      claim: { key: "claim", phase: "lived", ...claimAuthority, anchorKinds: ["carrier_proof"] },
    },
    "slot.denied": {
      payloadSchema: emptyPayload,
      claim: {
        key: "claim",
        phase: "rejected",
        ...claimAuthority,
        rejectionKinds: ["policy_denied"],
      },
    },
    "slot.failed": {
      payloadSchema: emptyPayload,
      claim: {
        key: "claim",
        phase: "rejected",
        ...claimAuthority,
        rejectionKinds: ["provider_rejected"],
      },
    },
    "slot.pending": {
      payloadSchema: emptyPayload,
      claim: {
        key: "claim",
        phase: "indeterminate",
        ...claimAuthority,
        indeterminateKinds: ["provider_pending"],
      },
    },
    "slot.reconcile": {
      payloadSchema: emptyPayload,
      claim: {
        key: "claim",
        phase: "indeterminate",
        ...claimAuthority,
        indeterminateKinds: ["reconcile_required"],
      },
    },
  },
  effectAuthorityContracts: [
    {
      authorityContractId,
      selector: { kind: "bound" },
      requiredMaterialSlots: [],
    },
  ],
  materialRequirements: [],
  settlement,
});

const claim = makePreClaim({
  operationRef: "slot:op",
  scopeRef: { kind: "conversation", scopeId: "thread:1" },
  effectAuthorityRef: expectedAuthorityRef,
  originRef: { originId: "slot-test", originKind: "test" },
});

const livedClaim = settleLived(settlement, claim, {
  anchorKind: "ledger_event",
  anchorId: "event:1",
});

const indeterminateClaim = settleIndeterminate(settlement, claim, {
  indeterminateKind: "provider_pending",
  indeterminateId: "pending:1",
  reason: "provider_pending",
});

const eventFor = (spec: {
  readonly kind?: string;
  readonly factOwnerRef?: string;
  readonly claim?: EffectClaim;
  readonly effectAuthorityRef?: EffectClaim["effectAuthorityRef"];
}): LedgerEvent => ({
  id: 1,
  ts: 10,
  kind: spec.kind ?? "slot.ledgered",
  scopeRef: spec.claim?.scopeRef ?? claim.scopeRef,
  factOwnerRef: spec.factOwnerRef ?? "@agent-os/slot-vocab",
  effectAuthorityRef:
    spec.effectAuthorityRef ?? spec.claim?.effectAuthorityRef ?? claim.effectAuthorityRef,
  payload: { claim: spec.claim ?? livedClaim },
});

const recordedEventFor = (spec: Parameters<typeof eventFor>[0]) =>
  decodeRecordedLedgerEvent(eventFor(spec));

const recordedEvent = (event: LedgerEvent) => decodeRecordedLedgerEvent(event);

describe("boundary commit validation", () => {
  it("rejects terminal claims outside the event-local slot vocabulary", () => {
    const carrierProofClaim = settleLived(settlement, claim, {
      anchorKind: "carrier_proof",
      anchorId: "proof:1",
    });
    const providerRejectedClaim = settleRejected(settlement, claim, {
      rejectionKind: "provider_rejected",
      rejectionId: "provider:1",
      reason: "provider_rejected",
    });
    const reconcileRequiredClaim = settleIndeterminate(settlement, claim, {
      indeterminateKind: "reconcile_required",
      indeterminateId: "reconcile:1",
      reason: "reconcile_required",
    });

    expect(
      validateBoundaryEventPayload(
        contract,
        "slot.ledgered",
        {
          claim: carrierProofClaim,
        },
        authorityBinding,
      ),
    ).toMatchObject({ issue: "claim_settlement_invalid" });
    expect(
      validateBoundaryEventPayload(
        contract,
        "slot.denied",
        {
          claim: providerRejectedClaim,
        },
        authorityBinding,
      ),
    ).toMatchObject({ issue: "claim_settlement_invalid" });
    expect(
      validateBoundaryEventPayload(
        contract,
        "slot.pending",
        {
          claim: reconcileRequiredClaim,
        },
        authorityBinding,
      ),
    ).toMatchObject({ issue: "claim_settlement_invalid" });
  });

  it.effect("injects contract-owned identity into the commit callback", () =>
    Effect.gen(function* () {
      const result = yield* commitBoundaryEvent(
        contract,
        "slot.ledgered",
        { claim: livedClaim },
        authorityBinding,
        (identity) => {
          expect(identity).toEqual({
            kind: "slot.ledgered",
            factOwnerRef: "@agent-os/slot-vocab",
            scopeRef: claim.scopeRef,
            effectAuthorityRef: claim.effectAuthorityRef,
          });
          return Effect.succeed(recordedEventFor({ claim: livedClaim }));
        },
      );

      expect(result).toMatchObject({
        kind: "slot.ledgered",
        factOwnerRef: "@agent-os/slot-vocab",
        scopeRef: claim.scopeRef,
        effectAuthorityRef: claim.effectAuthorityRef,
      });
    }),
  );

  it.effect("admits indeterminate claims through the same boundary identity path", () =>
    Effect.gen(function* () {
      const result = yield* commitBoundaryEvent(
        contract,
        "slot.pending",
        { claim: indeterminateClaim },
        authorityBinding,
        (identity) => {
          expect(identity).toEqual({
            kind: "slot.pending",
            factOwnerRef: "@agent-os/slot-vocab",
            scopeRef: claim.scopeRef,
            effectAuthorityRef: claim.effectAuthorityRef,
          });
          return Effect.succeed(
            recordedEventFor({ kind: "slot.pending", claim: indeterminateClaim }),
          );
        },
      );

      expect(result).toMatchObject({
        kind: "slot.pending",
        factOwnerRef: "@agent-os/slot-vocab",
        scopeRef: claim.scopeRef,
        effectAuthorityRef: claim.effectAuthorityRef,
      });
    }),
  );

  it.effect(
    "rejects committed events with caller-controlled owner, kind, scope, or authority",
    () =>
      Effect.gen(function* () {
        const owner = yield* Effect.result(
          commitBoundaryEvent(
            contract,
            "slot.ledgered",
            { claim: livedClaim },
            authorityBinding,
            () =>
              Effect.succeed(
                recordedEventFor({ claim: livedClaim, factOwnerRef: "@other/package" }),
              ),
          ),
        );
        const kind = yield* Effect.result(
          commitBoundaryEvent(
            contract,
            "slot.ledgered",
            { claim: livedClaim },
            authorityBinding,
            () => Effect.succeed(recordedEventFor({ claim: livedClaim, kind: "slot.other" })),
          ),
        );
        const scope = yield* Effect.result(
          commitBoundaryEvent(
            contract,
            "slot.ledgered",
            { claim: livedClaim },
            authorityBinding,
            () =>
              Effect.succeed(
                recordedEvent({
                  ...eventFor({ claim: livedClaim }),
                  scopeRef: { kind: "conversation", scopeId: "thread:2" },
                }),
              ),
          ),
        );
        const authority = yield* Effect.result(
          commitBoundaryEvent(
            contract,
            "slot.ledgered",
            { claim: livedClaim },
            authorityBinding,
            () =>
              Effect.succeed(
                recordedEventFor({
                  claim: livedClaim,
                  effectAuthorityRef: { authorityClass: "effect", authorityId: "other.record" },
                }),
              ),
          ),
        );

        expect(Result.isFailure(owner) ? owner.failure : null).toMatchObject({
          issue: "committed_fact_owner_mismatch",
        });
        expect(Result.isFailure(kind) ? kind.failure : null).toMatchObject({
          issue: "committed_event_kind_mismatch",
        });
        expect(Result.isFailure(scope) ? scope.failure : null).toMatchObject({
          issue: "committed_scope_ref_mismatch",
        });
        expect(Result.isFailure(authority) ? authority.failure : null).toMatchObject({
          issue: "committed_effect_authority_mismatch",
        });
      }),
  );

  it.effect("rejects undeclared claim authority before commit", () =>
    Effect.gen(function* () {
      const undeclaredClaim = settleLived(
        settlement,
        {
          ...claim,
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "undeclared.record",
          },
        },
        {
          anchorKind: "ledger_event",
          anchorId: "event:1",
        },
      );
      let committed = false;
      const result = yield* Effect.result(
        commitBoundaryEvent(
          contract,
          "slot.ledgered",
          { claim: undeclaredClaim },
          authorityBinding,
          () => {
            committed = true;
            return Effect.succeed(recordedEventFor({ claim: undeclaredClaim }));
          },
        ),
      );

      expect(committed).toBe(false);
      expect(Result.isFailure(result) ? result.failure : null).toMatchObject({
        issue: "claim_authority_invalid",
      });
    }),
  );

  it.effect("rejects a bound claim when trusted authority evidence is missing", () =>
    Effect.gen(function* () {
      let committed = false;
      const result = yield* Effect.result(
        commitBoundaryEvent(contract, "slot.ledgered", { claim: livedClaim }, undefined, () => {
          committed = true;
          return Effect.succeed(recordedEventFor({ claim: livedClaim }));
        }),
      );

      expect(committed).toBe(false);
      expect(Result.isFailure(result) ? result.failure : null).toMatchObject({
        issue: "claim_authority_invalid",
      });
    }),
  );
});
