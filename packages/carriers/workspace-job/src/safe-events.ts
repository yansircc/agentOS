import { Predicate } from "effect";
import type { SafeLedgerEvent, SafeLedgerPayloadShape, SafeLedgerValue } from "@agent-os/kernel";
import { safeLedgerEvent, safeValueFromUnknown } from "@agent-os/kernel";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { WORKSPACE_JOB_FACT_OWNER, WORKSPACE_JOB_KIND } from "./definition";

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const numberField = (payload: Record<string, unknown>, key: string): number | undefined =>
  typeof payload[key] === "number" && Number.isFinite(payload[key])
    ? (payload[key] as number)
    : undefined;

const booleanField = (payload: Record<string, unknown>, key: string): boolean | undefined =>
  typeof payload[key] === "boolean" ? payload[key] : undefined;

const safeArtifact = (value: unknown): SafeLedgerValue | undefined => {
  if (!Predicate.isObject(value)) return undefined;
  const artifactRef = stringField(value, "artifactRef");
  const path = stringField(value, "path");
  const schemaId = stringField(value, "schemaId");
  const sha256 = stringField(value, "sha256");
  const bytes = numberField(value, "bytes");
  if (
    artifactRef === undefined ||
    path === undefined ||
    schemaId === undefined ||
    sha256 === undefined ||
    bytes === undefined
  ) {
    return undefined;
  }
  return { artifactRef, path, schemaId, sha256, bytes };
};

const safeChecksSummary = (value: unknown): SafeLedgerValue | undefined => {
  if (!Array.isArray(value)) return undefined;
  const checks: SafeLedgerValue[] = [];
  let passed = 0;
  let failed = 0;
  for (const item of value) {
    if (!Predicate.isObject(item)) return undefined;
    const name = stringField(item, "name");
    const status = stringField(item, "status");
    if (name === undefined || (status !== "passed" && status !== "failed")) return undefined;
    if (status === "passed") passed += 1;
    if (status === "failed") failed += 1;
    checks.push({
      name,
      status,
      ...(stringField(item, "message") === undefined
        ? {}
        : { message: stringField(item, "message")! }),
      ...(stringField(item, "proofRef") === undefined
        ? {}
        : { proofRef: stringField(item, "proofRef")! }),
      ...(stringField(item, "fingerprint") === undefined
        ? {}
        : { fingerprint: stringField(item, "fingerprint")! }),
    });
  }
  return { total: checks.length, passed, failed, checks };
};

const safeRequestedPayload = (payload: Record<string, unknown>): SafeLedgerPayloadShape => ({
  runId: stringField(payload, "runId") ?? "unknown",
  idempotencyKey: stringField(payload, "idempotencyKey") ?? "unknown",
  requestedBy: stringField(payload, "requestedBy") ?? "unknown",
  terminalSchemaId: stringField(payload, "terminalSchemaId") ?? "unknown",
  ...(stringField(payload, "workspaceRef") === undefined
    ? {}
    : { workspaceRef: stringField(payload, "workspaceRef")! }),
  ...(stringField(payload, "inputRef") === undefined
    ? {}
    : { inputRef: stringField(payload, "inputRef")! }),
  ...(stringField(payload, "inputHash") === undefined
    ? {}
    : { inputHash: stringField(payload, "inputHash")! }),
  ...(safeValueFromUnknown(payload.attempt) === undefined
    ? {}
    : { attempt: safeValueFromUnknown(payload.attempt)! }),
});

const safeTerminalFinalizedPayload = (
  payload: Record<string, unknown>,
): SafeLedgerPayloadShape => ({
  requestedEventId: numberField(payload, "requestedEventId") ?? 0,
  runId: stringField(payload, "runId") ?? "unknown",
  idempotencyKey: stringField(payload, "idempotencyKey") ?? "unknown",
  ...(safeArtifact(payload.terminalArtifact) === undefined
    ? {}
    : { artifact: safeArtifact(payload.terminalArtifact)! }),
});

const safeVerdictPayload = (payload: Record<string, unknown>): SafeLedgerPayloadShape => ({
  requestedEventId: numberField(payload, "requestedEventId") ?? 0,
  terminalFinalizedEventId: numberField(payload, "terminalFinalizedEventId") ?? 0,
  runId: stringField(payload, "runId") ?? "unknown",
  idempotencyKey: stringField(payload, "idempotencyKey") ?? "unknown",
  ...(safeChecksSummary(payload.checks) === undefined
    ? {}
    : { checks: safeChecksSummary(payload.checks)! }),
  ...(stringField(payload, "summary") === undefined
    ? {}
    : { summary: stringField(payload, "summary")! }),
});

const safeFailedPayload = (payload: Record<string, unknown>): SafeLedgerPayloadShape => {
  const failure = Predicate.isObject(payload.failure) ? payload.failure : {};
  return {
    requestedEventId: numberField(payload, "requestedEventId") ?? 0,
    runId: stringField(payload, "runId") ?? "unknown",
    idempotencyKey: stringField(payload, "idempotencyKey") ?? "unknown",
    phase: stringField(failure, "phase") ?? "projection",
    code: stringField(failure, "code") ?? "workspace_job.failed",
    reason: stringField(failure, "reason") ?? "failed",
    ...(booleanField(failure, "retryable") === undefined
      ? {}
      : { retryable: booleanField(failure, "retryable")! }),
  };
};

const safeStepPayload = (payload: Record<string, unknown>): SafeLedgerPayloadShape => ({
  requestedEventId: numberField(payload, "requestedEventId") ?? 0,
  runId: stringField(payload, "runId") ?? "unknown",
  idempotencyKey: stringField(payload, "idempotencyKey") ?? "unknown",
  ...(stringField(payload, "path") === undefined ? {} : { path: stringField(payload, "path")! }),
  ...(stringField(payload, "schemaId") === undefined
    ? {}
    : { schemaId: stringField(payload, "schemaId")! }),
  ...(numberField(payload, "bytes") === undefined ? {} : { bytes: numberField(payload, "bytes")! }),
  ...(stringField(payload, "sha256") === undefined
    ? {}
    : { sha256: stringField(payload, "sha256")! }),
  ...(stringField(payload, "artifactRef") === undefined
    ? {}
    : { artifactRef: stringField(payload, "artifactRef")! }),
  ...(safeValueFromUnknown(payload.seedPaths) === undefined
    ? {}
    : { seedPaths: safeValueFromUnknown(payload.seedPaths)! }),
});

export const projectWorkspaceJobSafeLedgerEvent = (
  event: LedgerEvent,
): SafeLedgerEvent | undefined => {
  if (event.factOwnerRef !== WORKSPACE_JOB_FACT_OWNER || !Predicate.isObject(event.payload)) {
    return undefined;
  }
  switch (event.kind) {
    case WORKSPACE_JOB_KIND.REQUESTED:
      return safeLedgerEvent(event, safeRequestedPayload(event.payload));
    case WORKSPACE_JOB_KIND.TERMINAL_FINALIZED:
      return safeLedgerEvent(event, safeTerminalFinalizedPayload(event.payload));
    case WORKSPACE_JOB_KIND.VERIFIED:
    case WORKSPACE_JOB_KIND.VERIFIER_REJECTED:
      return safeLedgerEvent(event, safeVerdictPayload(event.payload));
    case WORKSPACE_JOB_KIND.FAILED:
    case WORKSPACE_JOB_KIND.RECONCILE_REQUIRED:
      return safeLedgerEvent(event, safeFailedPayload(event.payload));
    case WORKSPACE_JOB_KIND.SEED_WRITTEN:
    case WORKSPACE_JOB_KIND.TERMINAL_BUILD_ATTEMPTED:
    case WORKSPACE_JOB_KIND.ARTIFACT_WRITTEN:
    case WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED:
      return safeLedgerEvent(event, safeStepPayload(event.payload));
    default:
      return undefined;
  }
};
