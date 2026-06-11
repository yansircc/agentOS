import { Predicate } from "effect";
import {
  invalidAdmitterRejectionRef,
  type LivedClaim,
  type PreClaim,
  type RejectedClaim,
  type RejectionRef,
} from "@agent-os/kernel/effect-claim";
import type { ToolError } from "@agent-os/kernel/errors";
import type { ToolContract } from "@agent-os/kernel/tools";
import {
  defineSettlementContract,
  isSymbolicSettlementValue,
  settleLived,
  settleRejected,
  symbolicSettlementRef,
  validateTerminalClaim,
} from "@agent-os/kernel/settlement-contract";

export const toolSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/runtime.tool",
  anchorKinds: ["carrier_proof"],
  rejectionKinds: ["policy_denied", "provider_rejected", "resource_denied", "validation_failed"],
});

const symbolicReasonOr = (value: string, fallback: string): string =>
  isSymbolicSettlementValue(value) ? value : fallback;

const toolTerminalId = (namespace: string, claim: PreClaim): string =>
  symbolicSettlementRef(namespace, [claim.operationRef]);

export const toolExecutionRejectionKind = (reason: string): RejectionRef["rejectionKind"] =>
  reason === "budget_time" || reason === "rate_limited" || reason.startsWith("invalid_quota_")
    ? "resource_denied"
    : "provider_rejected";

export const publicRuntimeCauseReason = (cause: unknown): string => {
  if (Predicate.isRecord(cause) && cause._tag === "agent_os.provider_http_failure") {
    const provider = symbolicReasonOr(String(cause.provider), "provider");
    const status = typeof cause.status === "number" ? `http_${cause.status}` : "http_error";
    const flags = Array.isArray(cause.flags)
      ? cause.flags
          .filter((flag): flag is string => typeof flag === "string")
          .map((flag) => symbolicReasonOr(flag, "flag"))
          .join(":")
      : "";
    return ["provider_http_failure", provider, status, flags].filter(Boolean).join(":");
  }
  if (Predicate.isRecord(cause) && typeof cause.reason === "string") {
    return symbolicReasonOr(cause.reason, "object");
  }
  if (Predicate.isRecord(cause) && typeof cause._tag === "string") {
    return symbolicReasonOr(cause._tag, "object");
  }
  if (cause instanceof Error) return symbolicReasonOr(cause.name, "Error");
  return symbolicReasonOr(typeof cause, "unknown");
};

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
