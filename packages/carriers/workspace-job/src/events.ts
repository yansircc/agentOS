import { Predicate } from "effect";
import type { LivedClaim, PreClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";
import { validateEffectClaim } from "@agent-os/kernel/effect-claim";
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
export type WorkspaceJobVerifiedPayload =
  WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["VERIFIED"]];
export type WorkspaceJobVerifierRejectedPayload =
  WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["VERIFIER_REJECTED"]];
export type WorkspaceJobFailedPayload = WorkspaceJobPayloads[(typeof WORKSPACE_JOB_KIND)["FAILED"]];

export type WorkspaceJobTerminalArtifact = WorkspaceJobVerifiedPayload["terminalArtifact"];
export type WorkspaceJobVerificationCheck = WorkspaceJobVerifiedPayload["checks"][number];

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
      readonly verified: WorkspaceJobVerifiedPayload;
      readonly terminalArtifact: WorkspaceJobTerminalArtifact;
      readonly checks: ReadonlyArray<WorkspaceJobVerificationCheck>;
    }
  | {
      readonly status: "verifier_rejected";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobRequestedPayload;
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

export const workspaceJobRequestedPayload = (spec: {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly requestedBy: string;
  readonly terminalSchemaId: string;
  readonly claim: PreClaim;
  readonly workspaceRef?: string;
  readonly inputRef?: string;
  readonly inputHash?: string;
}): WorkspaceJobRequestedPayload => ({
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  requestedBy: spec.requestedBy,
  terminalSchemaId: spec.terminalSchemaId,
  ...(spec.workspaceRef === undefined ? {} : { workspaceRef: spec.workspaceRef }),
  ...(spec.inputRef === undefined ? {} : { inputRef: spec.inputRef }),
  ...(spec.inputHash === undefined ? {} : { inputHash: spec.inputHash }),
  claim: spec.claim,
});

const terminalPayload = (spec: {
  readonly requestedEventId: number;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly terminalArtifact: WorkspaceJobTerminalArtifact;
  readonly checks: ReadonlyArray<WorkspaceJobVerificationCheck>;
  readonly summary?: string;
}) => ({
  requestedEventId: spec.requestedEventId,
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  terminalArtifact: spec.terminalArtifact,
  checks: [...spec.checks],
  ...(spec.summary === undefined ? {} : { summary: spec.summary }),
});

export const workspaceJobVerifiedPayload = (
  spec: Parameters<typeof terminalPayload>[0] & { readonly claim: LivedClaim },
): WorkspaceJobVerifiedPayload => ({
  ...terminalPayload(spec),
  claim: spec.claim,
});

export const workspaceJobVerifierRejectedPayload = (
  spec: Parameters<typeof terminalPayload>[0] & { readonly claim: RejectedClaim },
): WorkspaceJobVerifierRejectedPayload => ({
  ...terminalPayload(spec),
  claim: spec.claim,
});

export const workspaceJobFailedPayload = (spec: {
  readonly requestedEventId: number;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly failureKind: WorkspaceJobFailedPayload["failureKind"];
  readonly reason: string;
  readonly claim: RejectedClaim;
}): WorkspaceJobFailedPayload => ({
  requestedEventId: spec.requestedEventId,
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  failureKind: spec.failureKind,
  reason: spec.reason,
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
    claim,
  };
};

const terminalFrom = <T extends "lived" | "rejected">(
  payload: Record<string, unknown>,
  claimKind: T,
):
  | (Omit<WorkspaceJobVerifiedPayload, "claim"> & {
      readonly claim: T extends "lived" ? LivedClaim : RejectedClaim;
    })
  | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const runId = stringField(payload, "runId");
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const terminalArtifact = terminalArtifactFrom(payload.terminalArtifact);
  const checks = checksFrom(payload.checks);
  const claim =
    claimKind === "lived" ? livedClaimFrom(payload.claim) : rejectedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    runId === undefined ||
    idempotencyKey === undefined ||
    terminalArtifact === undefined ||
    checks === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    requestedEventId,
    runId,
    idempotencyKey,
    terminalArtifact,
    checks,
    ...(stringField(payload, "summary") === undefined
      ? {}
      : { summary: stringField(payload, "summary") }),
    claim: claim as T extends "lived" ? LivedClaim : RejectedClaim,
  };
};

const failureKindFrom = (value: unknown): WorkspaceJobFailedPayload["failureKind"] | undefined =>
  value === "submit_failed" ||
  value === "missing_candidate" ||
  value === "run_id_mismatch" ||
  value === "finalize_failed" ||
  value === "verification_failed" ||
  value === "data_plane_failed" ||
  value === "unknown"
    ? value
    : undefined;

const failedFrom = (payload: Record<string, unknown>): WorkspaceJobFailedPayload | undefined => {
  const requestedEventId = numberField(payload, "requestedEventId");
  const runId = stringField(payload, "runId");
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const failureKind = failureKindFrom(payload.failureKind);
  const reason = stringField(payload, "reason");
  const claim = rejectedClaimFrom(payload.claim);
  if (
    requestedEventId === undefined ||
    runId === undefined ||
    idempotencyKey === undefined ||
    failureKind === undefined ||
    reason === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return { requestedEventId, runId, idempotencyKey, failureKind, reason, claim };
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

export const projectWorkspaceJob = (
  events: Iterable<WorkspaceJobLedgerEvent>,
  runId: string,
): WorkspaceJobProjection => {
  let request: WorkspaceJobRequestedPayload | undefined;
  let requestedEventId: number | undefined;
  let terminal: WorkspaceJobProjection | undefined;

  for (const event of events) {
    if (!sameOwner(event) || !Predicate.isRecord(event.payload)) continue;
    if (event.kind === WORKSPACE_JOB_KIND.REQUESTED && request === undefined) {
      const next = requestedFrom(event.payload);
      if (next?.runId === runId) {
        request = next;
        requestedEventId = event.id;
      }
      continue;
    }
    if (request === undefined || requestedEventId === undefined || terminal !== undefined) continue;
    if (event.kind === WORKSPACE_JOB_KIND.VERIFIED) {
      const verified = terminalFrom(event.payload, "lived") as
        | WorkspaceJobVerifiedPayload
        | undefined;
      if (verified?.requestedEventId === requestedEventId && verified.runId === runId) {
        terminal = {
          status: "verified",
          runId,
          requestedEventId,
          request,
          verified,
          terminalArtifact: verified.terminalArtifact,
          checks: verified.checks,
        };
      }
      continue;
    }
    if (event.kind === WORKSPACE_JOB_KIND.VERIFIER_REJECTED) {
      const rejected = terminalFrom(event.payload, "rejected") as
        | WorkspaceJobVerifierRejectedPayload
        | undefined;
      if (rejected?.requestedEventId === requestedEventId && rejected.runId === runId) {
        terminal = {
          status: "verifier_rejected",
          runId,
          requestedEventId,
          request,
          rejected,
          terminalArtifact: rejected.terminalArtifact,
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
