import { Predicate } from "effect";
import type { SafeLedgerEvent, SafeLedgerPayloadShape } from "@agent-os/kernel";
import { safeLedgerEvent, safeValueFromUnknown } from "@agent-os/kernel";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { validateTerminalClaim } from "@agent-os/kernel/settlement-contract";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  workspaceOpSettlementContract,
} from "./definition";

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const numberField = (payload: Record<string, unknown>, key: string): number | undefined =>
  typeof payload[key] === "number" && Number.isFinite(payload[key])
    ? (payload[key] as number)
    : undefined;

const safeClaimRejection = (claim: unknown): SafeLedgerPayloadShape | undefined => {
  const validation = validateTerminalClaim(workspaceOpSettlementContract, claim);
  if (!validation.ok || validation.claim.phase !== "rejected") return undefined;
  return {
    rejectionKind: validation.claim.rejectionRef.rejectionKind,
    ...(validation.claim.rejectionRef.reason === undefined
      ? {}
      : { reason: validation.claim.rejectionRef.reason }),
  };
};

const safeRequestPayload = (payload: Record<string, unknown>): SafeLedgerPayloadShape => ({
  toolName: stringField(payload, "toolName") ?? "unknown",
  ...(stringField(payload, "toolCallId") === undefined
    ? {}
    : { toolCallId: stringField(payload, "toolCallId")! }),
  ...(stringField(payload, "path") === undefined ? {} : { path: stringField(payload, "path")! }),
  ...(stringField(payload, "cwd") === undefined ? {} : { cwd: stringField(payload, "cwd")! }),
  ...(stringField(payload, "command") === undefined
    ? {}
    : { command: stringField(payload, "command")! }),
  ...(safeValueFromUnknown(payload.envRefs) === undefined
    ? {}
    : { envRefs: safeValueFromUnknown(payload.envRefs)! }),
  ...(safeValueFromUnknown(payload.materialRefs) === undefined
    ? {}
    : { materialRefs: safeValueFromUnknown(payload.materialRefs)! }),
});

const safeCompletedPayload = (payload: Record<string, unknown>): SafeLedgerPayloadShape => ({
  requestedEventId: numberField(payload, "requestedEventId") ?? 0,
  toolName: stringField(payload, "toolName") ?? "unknown",
  ...(stringField(payload, "toolCallId") === undefined
    ? {}
    : { toolCallId: stringField(payload, "toolCallId")! }),
  ...(stringField(payload, "path") === undefined ? {} : { path: stringField(payload, "path")! }),
  ...(numberField(payload, "bytesWritten") === undefined
    ? {}
    : { bytesWritten: numberField(payload, "bytesWritten")! }),
  ...(numberField(payload, "replacementCount") === undefined
    ? {}
    : { replacementCount: numberField(payload, "replacementCount")! }),
  ...(numberField(payload, "exitCode") === undefined
    ? {}
    : { exitCode: numberField(payload, "exitCode")! }),
  ...(numberField(payload, "durationMs") === undefined
    ? {}
    : { durationMs: numberField(payload, "durationMs")! }),
});

const safeRejectedPayload = (payload: Record<string, unknown>): SafeLedgerPayloadShape => ({
  requestedEventId: numberField(payload, "requestedEventId") ?? 0,
  toolName: stringField(payload, "toolName") ?? "unknown",
  reason: stringField(payload, "reason") ?? "rejected",
  ...(stringField(payload, "toolCallId") === undefined
    ? {}
    : { toolCallId: stringField(payload, "toolCallId")! }),
  ...(safeClaimRejection(payload.claim) === undefined
    ? {}
    : { claim: safeClaimRejection(payload.claim)! }),
});

export const projectWorkspaceOperationSafeLedgerEvent = (
  event: LedgerEvent,
): SafeLedgerEvent | undefined => {
  if (event.factOwnerRef !== WORKSPACE_OP_FACT_OWNER || !Predicate.isObject(event.payload)) {
    return undefined;
  }
  switch (event.kind) {
    case WORKSPACE_OP_KIND.REQUESTED:
      return safeLedgerEvent(event, safeRequestPayload(event.payload));
    case WORKSPACE_OP_KIND.COMPLETED:
      return safeLedgerEvent(event, safeCompletedPayload(event.payload));
    case WORKSPACE_OP_KIND.REJECTED:
      return safeLedgerEvent(event, safeRejectedPayload(event.payload));
    default:
      return undefined;
  }
};
