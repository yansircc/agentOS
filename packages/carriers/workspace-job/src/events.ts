import { Predicate } from "effect";
import type {
  AuthorityRef,
  LivedClaim,
  PreClaim,
  RejectedClaim,
  ScopeRef,
} from "@agent-os/kernel/effect-claim";
import { makeOperationRef, makePreClaim, validateEffectClaim } from "@agent-os/kernel/effect-claim";
import { validateTerminalClaim } from "@agent-os/kernel/settlement-contract";
import {
  WORKSPACE_JOB_EVENTS,
  WORKSPACE_JOB_FACT_OWNER,
  WORKSPACE_JOB_KIND,
  workspaceJobSettlementContract,
} from "./definition";
export {
  WORKSPACE_JOB_EVENTS,
  WORKSPACE_JOB_EVENT_PREFIX,
  WORKSPACE_JOB_FACT_OWNER,
  WORKSPACE_JOB_KIND,
  WORKSPACE_JOB_PROJECTION_KIND,
} from "./definition";

type WorkspaceJobPayloads = typeof WORKSPACE_JOB_EVENTS;

export type WorkspaceJobRequestedPayload =
  WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["REQUESTED"]];
export type WorkspaceJobTerminalFinalizedPayload =
  WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["TERMINAL_FINALIZED"]];
export type WorkspaceJobVerifiedPayload =
  WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["VERIFIED"]];
export type WorkspaceJobVerifierRejectedPayload =
  WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["VERIFIER_REJECTED"]];
export type WorkspaceJobFailedPayload = WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["FAILED"]];
export type WorkspaceJobSeedWrittenPayload =
  WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["SEED_WRITTEN"]];
export type WorkspaceJobTerminalBuildAttemptedPayload =
  WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["TERMINAL_BUILD_ATTEMPTED"]];
export type WorkspaceJobArtifactWrittenPayload =
  WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["ARTIFACT_WRITTEN"]];
export type WorkspaceJobArtifactReadbackVerifiedPayload =
  WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["ARTIFACT_READBACK_VERIFIED"]];

export type WorkspaceJobTerminalArtifact = WorkspaceJobTerminalFinalizedPayload["terminalArtifact"];
export type WorkspaceJobVerificationCheck = WorkspaceJobVerifiedPayload["checks"][number];
export type WorkspaceJobFailure = WorkspaceJobFailedPayload["failure"];
export type WorkspaceJobAttempt = NonNullable<WorkspaceJobRequestedPayload["attempt"]>;

export const WORKSPACE_JOB_REF_NAMESPACE = "workspace_job";
export const WORKSPACE_JOB_ORIGIN_KIND = WORKSPACE_JOB_REF_NAMESPACE;

export const workspaceJobOperationRef = (runId: string): string =>
  makeOperationRef(WORKSPACE_JOB_REF_NAMESPACE, [runId]);

export const workspaceJobOriginRef = (
  idempotencyKey: string,
): { readonly originId: string; readonly originKind: string } => ({
  originId: idempotencyKey,
  originKind: WORKSPACE_JOB_ORIGIN_KIND,
});

export const workspaceJobPreClaim = (spec: {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
}): PreClaim =>
  makePreClaim({
    operationRef: workspaceJobOperationRef(spec.runId),
    scopeRef: spec.scopeRef,
    effectAuthorityRef: spec.effectAuthorityRef,
    originRef: workspaceJobOriginRef(spec.idempotencyKey),
  });

export const workspaceJobFailureCode = (...parts: ReadonlyArray<string | number>): string =>
  [WORKSPACE_JOB_REF_NAMESPACE, ...parts.map(String)].join(".");

export interface WorkspaceJobLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly factOwnerRef?: string;
}

export type WorkspaceJobProjection =
  | {
      readonly status: "missing";
      readonly runId: string;
    }
  | {
      readonly status: "running";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobRequestedPayload;
    }
  | {
      readonly status: "verified";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobRequestedPayload;
      readonly finalized: WorkspaceJobTerminalFinalizedPayload;
      readonly verified: WorkspaceJobVerifiedPayload;
      readonly terminalArtifact: WorkspaceJobTerminalArtifact;
      readonly checks: ReadonlyArray<WorkspaceJobVerificationCheck>;
    }
  | {
      readonly status: "verifier_rejected";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobRequestedPayload;
      readonly finalized: WorkspaceJobTerminalFinalizedPayload;
      readonly rejected: WorkspaceJobVerifierRejectedPayload;
      readonly terminalArtifact: WorkspaceJobTerminalArtifact;
      readonly checks: ReadonlyArray<WorkspaceJobVerificationCheck>;
    }
  | {
      readonly status: "failed";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobRequestedPayload;
      readonly failed: WorkspaceJobFailedPayload;
    };

export type WorkspaceJobIdempotencyProjection =
  | {
      readonly status: "missing";
      readonly idempotencyKey: string;
    }
  | {
      readonly status: "found";
      readonly idempotencyKey: string;
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobRequestedPayload;
    };

export type WorkspaceJobStepProjection =
  | {
      readonly status: "missing";
      readonly runId: string;
    }
  | {
      readonly status: "found";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobRequestedPayload;
      readonly seedWritten?: WorkspaceJobSeedWrittenPayload;
      readonly terminalBuildAttempted?: WorkspaceJobTerminalBuildAttemptedPayload;
      readonly artifactWritten?: WorkspaceJobArtifactWrittenPayload;
      readonly artifactReadbackVerified?: WorkspaceJobArtifactReadbackVerifiedPayload;
      readonly terminalFinalized?: {
        readonly eventId: number;
        readonly payload: WorkspaceJobTerminalFinalizedPayload;
      };
    };

export const workspaceJobRequestedPayload = (spec: {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly requestedBy: string;
  readonly terminalSchemaId: string;
  readonly claim: PreClaim;
  readonly workspaceRef?: string;
  readonly inputRef?: string;
  readonly inputHash?: string;
  readonly attempt?: WorkspaceJobAttempt;
}): WorkspaceJobRequestedPayload => ({
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  requestedBy: spec.requestedBy,
  terminalSchemaId: spec.terminalSchemaId,
  ...(spec.workspaceRef === undefined ? {} : { workspaceRef: spec.workspaceRef }),
  ...(spec.inputRef === undefined ? {} : { inputRef: spec.inputRef }),
  ...(spec.inputHash === undefined ? {} : { inputHash: spec.inputHash }),
  ...(spec.attempt === undefined ? {} : { attempt: spec.attempt }),
  claim: spec.claim,
});

export const workspaceJobTerminalFinalizedPayload = (spec: {
  readonly requestedEventId: number;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly terminalArtifact: WorkspaceJobTerminalArtifact;
  readonly claim: LivedClaim;
}): WorkspaceJobTerminalFinalizedPayload => ({
  requestedEventId: spec.requestedEventId,
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  terminalArtifact: spec.terminalArtifact,
  claim: spec.claim,
});

const terminalVerdictPayload = (spec: {
  readonly requestedEventId: number;
  readonly terminalFinalizedEventId: number;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly checks: ReadonlyArray<WorkspaceJobVerificationCheck>;
  readonly summary?: string;
}) => ({
  requestedEventId: spec.requestedEventId,
  terminalFinalizedEventId: spec.terminalFinalizedEventId,
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  checks: [...spec.checks],
  ...(spec.summary === undefined ? {} : { summary: spec.summary }),
});

export const workspaceJobVerifiedPayload = (
  spec: Parameters<typeof terminalVerdictPayload>[0] & { readonly claim: LivedClaim },
): WorkspaceJobVerifiedPayload => ({
  ...terminalVerdictPayload(spec),
  claim: spec.claim,
});

export const workspaceJobVerifierRejectedPayload = (
  spec: Parameters<typeof terminalVerdictPayload>[0] & { readonly claim: RejectedClaim },
): WorkspaceJobVerifierRejectedPayload => ({
  ...terminalVerdictPayload(spec),
  claim: spec.claim,
});

export const workspaceJobFailedPayload = (spec: {
  readonly requestedEventId: number;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly failure: WorkspaceJobFailure;
  readonly submitRunId?: number;
  readonly claim: RejectedClaim;
}): WorkspaceJobFailedPayload => ({
  requestedEventId: spec.requestedEventId,
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  failure: spec.failure,
  ...(spec.submitRunId === undefined ? {} : { submitRunId: spec.submitRunId }),
  claim: spec.claim,
});

export const workspaceJobSeedWrittenPayload = (spec: {
  readonly requestedEventId: number;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly seedPaths: ReadonlyArray<string>;
  readonly claim: LivedClaim;
}): WorkspaceJobSeedWrittenPayload => ({
  requestedEventId: spec.requestedEventId,
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  seedPaths: [...spec.seedPaths],
  claim: spec.claim,
});

export const workspaceJobTerminalBuildAttemptedPayload = (spec: {
  readonly requestedEventId: number;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly submitRunId: number;
  readonly schemaId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly claim: LivedClaim;
}): WorkspaceJobTerminalBuildAttemptedPayload => ({
  requestedEventId: spec.requestedEventId,
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  submitRunId: spec.submitRunId,
  schemaId: spec.schemaId,
  bytes: spec.bytes,
  sha256: spec.sha256,
  claim: spec.claim,
});

export const workspaceJobArtifactWrittenPayload = (spec: {
  readonly requestedEventId: number;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly path: string;
  readonly artifactRef: string;
  readonly submitRunId: number;
  readonly schemaId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly claim: LivedClaim;
}): WorkspaceJobArtifactWrittenPayload => ({
  requestedEventId: spec.requestedEventId,
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  path: spec.path,
  artifactRef: spec.artifactRef,
  submitRunId: spec.submitRunId,
  schemaId: spec.schemaId,
  bytes: spec.bytes,
  sha256: spec.sha256,
  claim: spec.claim,
});

export const workspaceJobArtifactReadbackVerifiedPayload = (spec: {
  readonly requestedEventId: number;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly path: string;
  readonly artifactRef: string;
  readonly submitRunId: number;
  readonly schemaId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly claim: LivedClaim;
}): WorkspaceJobArtifactReadbackVerifiedPayload => ({
  requestedEventId: spec.requestedEventId,
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  path: spec.path,
  artifactRef: spec.artifactRef,
  submitRunId: spec.submitRunId,
  schemaId: spec.schemaId,
  bytes: spec.bytes,
  sha256: spec.sha256,
  claim: spec.claim,
});

const preClaimFrom = (value: unknown): PreClaim | undefined => {
  const result = validateEffectClaim(value);
  return result.ok && result.claim.phase === "pre" ? result.claim : undefined;
};

const livedClaimFrom = (value: unknown): LivedClaim | undefined => {
  const result = validateTerminalClaim(workspaceJobSettlementContract, value);
  return result.ok && result.claim.phase === "lived" ? result.claim : undefined;
};

const rejectedClaimFrom = (value: unknown): RejectedClaim | undefined => {
  const result = validateTerminalClaim(workspaceJobSettlementContract, value);
  return result.ok && result.claim.phase === "rejected" ? result.claim : undefined;
};

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const numberField = (payload: Record<string, unknown>, key: string): number | undefined =>
  typeof payload[key] === "number" && Number.isFinite(payload[key])
    ? (payload[key] as number)
    : undefined;

const stringArrayField = (
  payload: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> | undefined => {
  const value = payload[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length === value.length ? out : undefined;
};

const attemptFrom = (value: unknown): WorkspaceJobAttempt | undefined => {
  if (!Predicate.isRecord(value)) return undefined;
  const index = numberField(value, "index");
  const maxAttempts = numberField(value, "maxAttempts");
  const cause = value.cause;
  const repairOfRequestedEventId = numberField(value, "repairOfRequestedEventId");
  if (
    index === undefined ||
    maxAttempts === undefined ||
    (cause !== "initial" && cause !== "verifier_repair")
  ) {
    return undefined;
  }
  return {
    index,
    maxAttempts,
    cause,
    ...(repairOfRequestedEventId === undefined ? {} : { repairOfRequestedEventId }),
  };
};

const terminalArtifactFrom = (value: unknown): WorkspaceJobTerminalArtifact | undefined => {
  if (!Predicate.isRecord(value)) return undefined;
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

const checkFrom = (value: unknown): WorkspaceJobVerificationCheck | undefined => {
  if (!Predicate.isRecord(value)) return undefined;
  const name = stringField(value, "name");
  const status = value.status;
  if (name === undefined || (status !== "passed" && status !== "failed")) return undefined;
  return {
    name,
    status,
    ...(stringField(value, "message") === undefined
      ? {}
      : { message: stringField(value, "message") }),
    ...(stringField(value, "proofRef") === undefined
      ? {}
      : { proofRef: stringField(value, "proofRef") }),
    ...(stringField(value, "fingerprint") === undefined
      ? {}
      : { fingerprint: stringField(value, "fingerprint") }),
  };
};

const checksFrom = (value: unknown): ReadonlyArray<WorkspaceJobVerificationCheck> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const checks = value.map(checkFrom);
  return checks.some((check) => check === undefined)
    ? undefined
    : (checks as ReadonlyArray<WorkspaceJobVerificationCheck>);
};

const requestedFrom = (
  payload: Record<string, unknown>,
): WorkspaceJobRequestedPayload | undefined => {
  const runId = stringField(payload, "runId");
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const requestedBy = stringField(payload, "requestedBy");
  const terminalSchemaId = stringField(payload, "terminalSchemaId");
  const claim = preClaimFrom(payload.claim);
  if (
    runId === undefined ||
    idempotencyKey === undefined ||
    requestedBy === undefined ||
    terminalSchemaId === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    runId,
    idempotencyKey,
    requestedBy,
    terminalSchemaId,
    ...(stringField(payload, "workspaceRef") === undefined
      ? {}
      : { workspaceRef: stringField(payload, "workspaceRef") }),
    ...(stringField(payload, "inputRef") === undefined
      ? {}
      : { inputRef: stringField(payload, "inputRef") }),
    ...(stringField(payload, "inputHash") === undefined
      ? {}
      : { inputHash: stringField(payload, "inputHash") }),
    ...(attemptFrom(payload.attempt) === undefined
      ? {}
      : { attempt: attemptFrom(payload.attempt) }),
    claim,
  };
};

const terminalFinalizedFrom = (
  payload: Record<string, unknown>,
): WorkspaceJobTerminalFinalizedPayload | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const runId = stringField(payload, "runId");
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const terminalArtifact = terminalArtifactFrom(payload.terminalArtifact);
  const claim = livedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    runId === undefined ||
    idempotencyKey === undefined ||
    terminalArtifact === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    requestedEventId,
    runId,
    idempotencyKey,
    terminalArtifact,
    claim,
  };
};

const terminalVerdictFrom = <T extends "lived" | "rejected">(
  payload: Record<string, unknown>,
  claimKind: T,
):
  | (Omit<WorkspaceJobVerifiedPayload, "claim"> & {
      readonly claim: T extends "lived" ? LivedClaim : RejectedClaim;
    })
  | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const terminalFinalizedEventId = numberField(payload, "terminalFinalizedEventId");
  const runId = stringField(payload, "runId");
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const checks = checksFrom(payload.checks);
  const claim =
    claimKind === "lived" ? livedClaimFrom(payload.claim) : rejectedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    terminalFinalizedEventId === undefined ||
    runId === undefined ||
    idempotencyKey === undefined ||
    checks === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    requestedEventId,
    terminalFinalizedEventId,
    runId,
    idempotencyKey,
    checks,
    ...(stringField(payload, "summary") === undefined
      ? {}
      : { summary: stringField(payload, "summary") }),
    claim: claim as T extends "lived" ? LivedClaim : RejectedClaim,
  };
};

const failurePhaseFrom = (value: unknown): WorkspaceJobFailure["phase"] | undefined =>
  value === "request" ||
  value === "seed" ||
  value === "submit" ||
  value === "collect_candidate" ||
  value === "finalize" ||
  value === "data_plane" ||
  value === "verify_infra" ||
  value === "projection"
    ? value
    : undefined;

const failureFrom = (value: unknown): WorkspaceJobFailure | undefined => {
  if (!Predicate.isRecord(value)) return undefined;
  const phase = failurePhaseFrom(value.phase);
  const code = stringField(value, "code");
  const reason = stringField(value, "reason");
  const retryable = value.retryable;
  if (
    phase === undefined ||
    code === undefined ||
    reason === undefined ||
    (retryable !== undefined && typeof retryable !== "boolean")
  ) {
    return undefined;
  }
  return {
    phase,
    code,
    reason,
    ...(retryable === undefined ? {} : { retryable }),
  };
};

const failedFrom = (payload: Record<string, unknown>): WorkspaceJobFailedPayload | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const runId = stringField(payload, "runId");
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const failure = failureFrom(payload.failure);
  const submitRunId = numberField(payload, "submitRunId");
  const claim = rejectedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    runId === undefined ||
    idempotencyKey === undefined ||
    failure === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    requestedEventId,
    runId,
    idempotencyKey,
    failure,
    ...(submitRunId === undefined ? {} : { submitRunId }),
    claim,
  };
};

const seedWrittenFrom = (
  payload: Record<string, unknown>,
): WorkspaceJobSeedWrittenPayload | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const runId = stringField(payload, "runId");
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const seedPaths = stringArrayField(payload, "seedPaths");
  const claim = livedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    runId === undefined ||
    idempotencyKey === undefined ||
    seedPaths === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return { requestedEventId, runId, idempotencyKey, seedPaths, claim };
};

const terminalBuildAttemptedFrom = (
  payload: Record<string, unknown>,
): WorkspaceJobTerminalBuildAttemptedPayload | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const runId = stringField(payload, "runId");
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const submitRunId = numberField(payload, "submitRunId");
  const schemaId = stringField(payload, "schemaId");
  const bytes = numberField(payload, "bytes");
  const sha256 = stringField(payload, "sha256");
  const claim = livedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    runId === undefined ||
    idempotencyKey === undefined ||
    submitRunId === undefined ||
    schemaId === undefined ||
    bytes === undefined ||
    sha256 === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return { requestedEventId, runId, idempotencyKey, submitRunId, schemaId, bytes, sha256, claim };
};

const artifactWrittenFrom = (
  payload: Record<string, unknown>,
): WorkspaceJobArtifactWrittenPayload | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const runId = stringField(payload, "runId");
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const path = stringField(payload, "path");
  const artifactRef = stringField(payload, "artifactRef");
  const submitRunId = numberField(payload, "submitRunId");
  const schemaId = stringField(payload, "schemaId");
  const bytes = numberField(payload, "bytes");
  const sha256 = stringField(payload, "sha256");
  const claim = livedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    runId === undefined ||
    idempotencyKey === undefined ||
    path === undefined ||
    artifactRef === undefined ||
    submitRunId === undefined ||
    schemaId === undefined ||
    bytes === undefined ||
    sha256 === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    requestedEventId,
    runId,
    idempotencyKey,
    path,
    artifactRef,
    submitRunId,
    schemaId,
    bytes,
    sha256,
    claim,
  };
};

const artifactReadbackVerifiedFrom = (
  payload: Record<string, unknown>,
): WorkspaceJobArtifactReadbackVerifiedPayload | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const runId = stringField(payload, "runId");
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const path = stringField(payload, "path");
  const artifactRef = stringField(payload, "artifactRef");
  const submitRunId = numberField(payload, "submitRunId");
  const schemaId = stringField(payload, "schemaId");
  const bytes = numberField(payload, "bytes");
  const sha256 = stringField(payload, "sha256");
  const claim = livedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    runId === undefined ||
    idempotencyKey === undefined ||
    path === undefined ||
    artifactRef === undefined ||
    submitRunId === undefined ||
    schemaId === undefined ||
    bytes === undefined ||
    sha256 === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    requestedEventId,
    runId,
    idempotencyKey,
    path,
    artifactRef,
    submitRunId,
    schemaId,
    bytes,
    sha256,
    claim,
  };
};

const sameOwner = (event: WorkspaceJobLedgerEvent): boolean =>
  event.factOwnerRef === undefined || event.factOwnerRef === WORKSPACE_JOB_FACT_OWNER;

export const projectWorkspaceJobByIdempotencyKey = (
  events: Iterable<WorkspaceJobLedgerEvent>,
  idempotencyKey: string,
): WorkspaceJobIdempotencyProjection => {
  for (const event of events) {
    if (!sameOwner(event) || event.kind !== WORKSPACE_JOB_KIND.REQUESTED) continue;
    if (!Predicate.isRecord(event.payload)) continue;
    const request = requestedFrom(event.payload);
    if (request?.idempotencyKey === idempotencyKey) {
      return {
        status: "found",
        idempotencyKey,
        runId: request.runId,
        requestedEventId: event.id,
        request,
      };
    }
  }
  return { status: "missing", idempotencyKey };
};

export const projectWorkspaceJobSteps = (
  events: Iterable<WorkspaceJobLedgerEvent>,
  runId: string,
): WorkspaceJobStepProjection => {
  let request: WorkspaceJobRequestedPayload | undefined;
  let requestedEventId: number | undefined;
  let seedWritten: WorkspaceJobSeedWrittenPayload | undefined;
  let terminalBuildAttempted: WorkspaceJobTerminalBuildAttemptedPayload | undefined;
  let artifactWritten: WorkspaceJobArtifactWrittenPayload | undefined;
  let artifactReadbackVerified: WorkspaceJobArtifactReadbackVerifiedPayload | undefined;
  let terminalFinalized:
    | { readonly eventId: number; readonly payload: WorkspaceJobTerminalFinalizedPayload }
    | undefined;

  for (const event of events) {
    if (!sameOwner(event) || !Predicate.isRecord(event.payload)) continue;
    if (event.kind === WORKSPACE_JOB_KIND.REQUESTED) {
      const next = requestedFrom(event.payload);
      if (next?.runId === runId) {
        request = next;
        requestedEventId = event.id;
        seedWritten = undefined;
        terminalBuildAttempted = undefined;
        artifactWritten = undefined;
        artifactReadbackVerified = undefined;
        terminalFinalized = undefined;
      }
      continue;
    }
    if (request === undefined || requestedEventId === undefined) continue;

    if (event.kind === WORKSPACE_JOB_KIND.SEED_WRITTEN && seedWritten === undefined) {
      const next = seedWrittenFrom(event.payload);
      if (next?.requestedEventId === requestedEventId && next.runId === runId) {
        seedWritten = next;
      }
      continue;
    }
    if (
      event.kind === WORKSPACE_JOB_KIND.TERMINAL_BUILD_ATTEMPTED &&
      terminalBuildAttempted === undefined
    ) {
      const next = terminalBuildAttemptedFrom(event.payload);
      if (next?.requestedEventId === requestedEventId && next.runId === runId) {
        terminalBuildAttempted = next;
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.ARTIFACT_WRITTEN && artifactWritten === undefined) {
      const next = artifactWrittenFrom(event.payload);
      if (next?.requestedEventId === requestedEventId && next.runId === runId) {
        artifactWritten = next;
      }
      continue;
    }
    if (
      event.kind === WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED &&
      artifactReadbackVerified === undefined
    ) {
      const next = artifactReadbackVerifiedFrom(event.payload);
      if (next?.requestedEventId === requestedEventId && next.runId === runId) {
        artifactReadbackVerified = next;
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.TERMINAL_FINALIZED && terminalFinalized === undefined) {
      const next = terminalFinalizedFrom(event.payload);
      if (next?.requestedEventId === requestedEventId && next.runId === runId) {
        terminalFinalized = { eventId: event.id, payload: next };
      }
    }
  }

  if (request === undefined || requestedEventId === undefined) {
    return { status: "missing", runId };
  }
  return {
    status: "found",
    runId,
    requestedEventId,
    request,
    ...(seedWritten === undefined ? {} : { seedWritten }),
    ...(terminalBuildAttempted === undefined ? {} : { terminalBuildAttempted }),
    ...(artifactWritten === undefined ? {} : { artifactWritten }),
    ...(artifactReadbackVerified === undefined ? {} : { artifactReadbackVerified }),
    ...(terminalFinalized === undefined ? {} : { terminalFinalized }),
  };
};

const terminalArtifactFromReadback = (
  readback: WorkspaceJobArtifactReadbackVerifiedPayload,
): WorkspaceJobTerminalArtifact => ({
  artifactRef: readback.artifactRef,
  path: readback.path,
  schemaId: readback.schemaId,
  bytes: readback.bytes,
  sha256: readback.sha256,
});

const terminalArtifactMatchesReadback = (
  terminalArtifact: WorkspaceJobTerminalArtifact,
  readback: WorkspaceJobArtifactReadbackVerifiedPayload,
): boolean =>
  terminalArtifact.artifactRef === readback.artifactRef &&
  terminalArtifact.path === readback.path &&
  terminalArtifact.schemaId === readback.schemaId &&
  terminalArtifact.bytes === readback.bytes &&
  terminalArtifact.sha256 === readback.sha256;

export const projectWorkspaceJob = (
  events: Iterable<WorkspaceJobLedgerEvent>,
  runId: string,
): WorkspaceJobProjection => {
  let request: WorkspaceJobRequestedPayload | undefined;
  let requestedEventId: number | undefined;
  let finalized:
    | { readonly eventId: number; readonly payload: WorkspaceJobTerminalFinalizedPayload }
    | undefined;
  let artifactReadback: WorkspaceJobArtifactReadbackVerifiedPayload | undefined;
  let terminal: WorkspaceJobProjection | undefined;

  for (const event of events) {
    if (!sameOwner(event) || !Predicate.isRecord(event.payload)) continue;
    if (event.kind === WORKSPACE_JOB_KIND.REQUESTED) {
      const next = requestedFrom(event.payload);
      if (next?.runId === runId) {
        request = next;
        requestedEventId = event.id;
        finalized = undefined;
        artifactReadback = undefined;
        terminal = undefined;
      }
      continue;
    }
    if (request === undefined || requestedEventId === undefined) continue;
    if (
      event.kind === WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED &&
      artifactReadback === undefined
    ) {
      const next = artifactReadbackVerifiedFrom(event.payload);
      if (next?.requestedEventId === requestedEventId && next.runId === runId) {
        artifactReadback = next;
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.TERMINAL_FINALIZED && finalized === undefined) {
      const next = terminalFinalizedFrom(event.payload);
      if (next?.requestedEventId === requestedEventId && next.runId === runId) {
        finalized = { eventId: event.id, payload: next };
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.VERIFIED) {
      const verified = terminalVerdictFrom(event.payload, "lived") as
        | WorkspaceJobVerifiedPayload
        | undefined;
      if (
        verified?.requestedEventId === requestedEventId &&
        verified.runId === runId &&
        finalized !== undefined &&
        artifactReadback !== undefined &&
        terminalArtifactMatchesReadback(finalized.payload.terminalArtifact, artifactReadback) &&
        verified.terminalFinalizedEventId === finalized.eventId
      ) {
        terminal = {
          status: "verified",
          runId,
          requestedEventId,
          request,
          finalized: finalized.payload,
          verified,
          terminalArtifact: terminalArtifactFromReadback(artifactReadback),
          checks: verified.checks,
        };
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.VERIFIER_REJECTED) {
      const rejected = terminalVerdictFrom(event.payload, "rejected") as
        | WorkspaceJobVerifierRejectedPayload
        | undefined;
      if (
        rejected?.requestedEventId === requestedEventId &&
        rejected.runId === runId &&
        finalized !== undefined &&
        artifactReadback !== undefined &&
        terminalArtifactMatchesReadback(finalized.payload.terminalArtifact, artifactReadback) &&
        rejected.terminalFinalizedEventId === finalized.eventId
      ) {
        terminal = {
          status: "verifier_rejected",
          runId,
          requestedEventId,
          request,
          finalized: finalized.payload,
          rejected,
          terminalArtifact: terminalArtifactFromReadback(artifactReadback),
          checks: rejected.checks,
        };
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.FAILED) {
      const failed = failedFrom(event.payload);
      if (failed?.requestedEventId === requestedEventId && failed.runId === runId) {
        terminal = { status: "failed", runId, requestedEventId, request, failed };
      }
    }
  }

  if (terminal !== undefined) return terminal;
  if (request === undefined || requestedEventId === undefined) return { status: "missing", runId };
  return { status: "running", runId, requestedEventId, request };
};

export const projectWorkspaceJobAttempt = (
  events: Iterable<WorkspaceJobLedgerEvent>,
  runId: string,
  targetRequestedEventId: number,
): WorkspaceJobProjection => {
  let request: WorkspaceJobRequestedPayload | undefined;
  let finalized:
    | { readonly eventId: number; readonly payload: WorkspaceJobTerminalFinalizedPayload }
    | undefined;
  let artifactReadback: WorkspaceJobArtifactReadbackVerifiedPayload | undefined;
  let terminal: WorkspaceJobProjection | undefined;

  for (const event of events) {
    if (!sameOwner(event) || !Predicate.isRecord(event.payload)) continue;
    if (event.kind === WORKSPACE_JOB_KIND.REQUESTED && event.id === targetRequestedEventId) {
      const next = requestedFrom(event.payload);
      if (next?.runId === runId) {
        request = next;
      }
      continue;
    }
    if (request === undefined || terminal !== undefined) continue;
    if (
      event.kind === WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED &&
      artifactReadback === undefined
    ) {
      const next = artifactReadbackVerifiedFrom(event.payload);
      if (next?.requestedEventId === targetRequestedEventId && next.runId === runId) {
        artifactReadback = next;
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.TERMINAL_FINALIZED && finalized === undefined) {
      const next = terminalFinalizedFrom(event.payload);
      if (next?.requestedEventId === targetRequestedEventId && next.runId === runId) {
        finalized = { eventId: event.id, payload: next };
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.VERIFIED) {
      const verified = terminalVerdictFrom(event.payload, "lived") as
        | WorkspaceJobVerifiedPayload
        | undefined;
      if (
        verified?.requestedEventId === targetRequestedEventId &&
        verified.runId === runId &&
        finalized !== undefined &&
        artifactReadback !== undefined &&
        terminalArtifactMatchesReadback(finalized.payload.terminalArtifact, artifactReadback) &&
        verified.terminalFinalizedEventId === finalized.eventId
      ) {
        terminal = {
          status: "verified",
          runId,
          requestedEventId: targetRequestedEventId,
          request,
          finalized: finalized.payload,
          verified,
          terminalArtifact: terminalArtifactFromReadback(artifactReadback),
          checks: verified.checks,
        };
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.VERIFIER_REJECTED) {
      const rejected = terminalVerdictFrom(event.payload, "rejected") as
        | WorkspaceJobVerifierRejectedPayload
        | undefined;
      if (
        rejected?.requestedEventId === targetRequestedEventId &&
        rejected.runId === runId &&
        finalized !== undefined &&
        artifactReadback !== undefined &&
        terminalArtifactMatchesReadback(finalized.payload.terminalArtifact, artifactReadback) &&
        rejected.terminalFinalizedEventId === finalized.eventId
      ) {
        terminal = {
          status: "verifier_rejected",
          runId,
          requestedEventId: targetRequestedEventId,
          request,
          finalized: finalized.payload,
          rejected,
          terminalArtifact: terminalArtifactFromReadback(artifactReadback),
          checks: rejected.checks,
        };
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.FAILED) {
      const failed = failedFrom(event.payload);
      if (failed?.requestedEventId === targetRequestedEventId && failed.runId === runId) {
        terminal = {
          status: "failed",
          runId,
          requestedEventId: targetRequestedEventId,
          request,
          failed,
        };
      }
    }
  }

  if (terminal !== undefined) return terminal;
  if (request === undefined) return { status: "missing", runId };
  return { status: "running", runId, requestedEventId: targetRequestedEventId, request };
};
