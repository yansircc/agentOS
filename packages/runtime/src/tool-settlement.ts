import {
  invalidAdmitterRejectionRef,
  type LivedClaim,
  type PreClaim,
  type RejectedClaim,
  type RejectionRef,
} from "@agent-os/core/effect-claim";
import type { ToolError } from "@agent-os/core/errors";
import type { ToolContract } from "@agent-os/core/tools";
import {
  defineSettlementContract,
  isSymbolicSettlementValue,
  settleLived,
  settleRejected,
  symbolicSettlementRef,
  validateTerminalClaim,
} from "@agent-os/core/settlement-contract";
import { publicRuntimeCauseReason } from "./failure-classification";

export const toolSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/runtime.tool",
  anchorKinds: ["carrier_proof"],
  rejectionKinds: ["policy_denied", "provider_rejected", "resource_denied", "validation_failed"],
  indeterminateKinds: [],
});

const symbolicReasonOr = (value: string, fallback: string): string =>
  isSymbolicSettlementValue(value) ? value : fallback;

const toolTerminalId = (namespace: string, claim: PreClaim): string =>
  symbolicSettlementRef(namespace, [claim.operationRef]);

export const toolExecutionRejectionKind = (reason: string): RejectionRef["rejectionKind"] =>
  reason === "budget_time" || reason === "rate_limited" || reason.startsWith("invalid_quota_")
    ? "resource_denied"
    : "provider_rejected";

export const toolErrorReason = (error: ToolError): string => {
  const cause = error.cause;
  if (typeof cause === "object" && cause !== null) {
    const reason = (cause as { readonly reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) {
      return symbolicReasonOr(reason, "tool_error");
    }
  }
  return publicRuntimeCauseReason(cause);
};

export const toolAdmissionFailureCause = (
  rejectionRef: RejectionRef,
): { readonly reason: string; readonly rejectionKind: RejectionRef["rejectionKind"] } => ({
  reason: rejectionRef.reason ?? rejectionRef.rejectionKind,
  rejectionKind: rejectionRef.rejectionKind,
});

const terminalAdmissionRejectionRef = (
  claim: PreClaim,
  rejectionRef: RejectionRef,
): RejectionRef => {
  const terminal: RejectionRef = {
    rejectionId: isSymbolicSettlementValue(rejectionRef.rejectionId)
      ? rejectionRef.rejectionId
      : toolTerminalId("tool.rejected", claim),
    rejectionKind: rejectionRef.rejectionKind,
    ...(rejectionRef.reason === undefined
      ? {}
      : { reason: symbolicReasonOr(rejectionRef.reason, "invalid_admitter_rejection_ref") }),
  };
  const validation = validateTerminalClaim(toolSettlementContract, {
    phase: "rejected",
    operationRef: claim.operationRef,
    scopeRef: claim.scopeRef,
    effectAuthorityRef: claim.effectAuthorityRef,
    originRef: claim.originRef,
    rejectionRef: terminal,
  });
  if (validation.ok) return terminal;

  const invalid = invalidAdmitterRejectionRef(claim);
  return {
    rejectionId: toolTerminalId("tool.rejected", claim),
    rejectionKind: invalid.rejectionKind,
    reason: invalid.reason,
  };
};

export const settleToolAdmissionRejected = (
  claim: PreClaim,
  rejectionRef: RejectionRef,
): RejectedClaim =>
  settleRejected(toolSettlementContract, claim, terminalAdmissionRejectionRef(claim, rejectionRef));

export const settleToolPolicyRejected = (claim: PreClaim, reason: string): RejectedClaim =>
  settleRejected(toolSettlementContract, claim, {
    rejectionId: toolTerminalId("tool.rejected", claim),
    rejectionKind: "policy_denied",
    reason,
  });

export const settleToolExecutionRejected = (claim: PreClaim, reason: string): RejectedClaim =>
  settleRejected(toolSettlementContract, claim, {
    rejectionId: toolTerminalId("tool.rejected", claim),
    rejectionKind: toolExecutionRejectionKind(reason),
    reason,
  });

export const settleToolValidationRejected = (claim: PreClaim, reason: string): RejectedClaim =>
  settleRejected(toolSettlementContract, claim, {
    rejectionId: toolTerminalId("tool.rejected", claim),
    rejectionKind: "validation_failed",
    reason,
  });

export const settleToolExecuted = (claim: PreClaim, contract: ToolContract): LivedClaim =>
  settleLived(toolSettlementContract, claim, {
    anchorId: symbolicSettlementRef("tool.executed", [claim.operationRef]),
    anchorKind: "carrier_proof",
    carrierRef: symbolicSettlementRef("tool", [contract.toolId]),
  });
