import type {
  LivedClaim,
  PreClaim,
  RejectedClaim,
  RejectionRef,
} from "@agent-os/core/effect-claim";
import { symbolicSettlementRef } from "@agent-os/core/settlement-contract";
import { workspaceOpCarrier } from "./definition";

export const workspaceOpSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("workspace_op", parts);

export const settleWorkspaceOperationCompleted = (
  claim: PreClaim,
  spec: {
    readonly requestedEventId: number;
    readonly idempotencyKey: string;
  },
): LivedClaim =>
  workspaceOpCarrier.settle.completed(claim, {
    anchorId: workspaceOpSettlementRef("receipt", spec.idempotencyKey, spec.requestedEventId),
    anchorKind: "external_receipt",
    carrierRef: workspaceOpSettlementRef("carrier", "workspace-op"),
  });

export const rejectWorkspaceOperation = (
  claim: PreClaim,
  spec: {
    readonly requestedEventId: number;
    readonly idempotencyKey: string;
    readonly rejectionKind?: RejectionRef["rejectionKind"];
  },
): RejectedClaim =>
  workspaceOpCarrier.reject.rejected(claim, {
    rejectionId: workspaceOpSettlementRef("rejected", spec.idempotencyKey, spec.requestedEventId),
    rejectionKind: spec.rejectionKind ?? "provider_rejected",
    reason: workspaceOpSettlementRef("reason", spec.idempotencyKey, spec.requestedEventId),
  });
