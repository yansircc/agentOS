import { Schema } from "effect";
import { defineCarrier, event, lived, pre, rejected } from "@agent-os/kernel/carrier";

export const WORKSPACE_JOB_EVENT_PREFIX = "workspace_job.";
export const WORKSPACE_JOB_FACT_OWNER = "@agent-os/workspace-job";
export const WORKSPACE_JOB_PROJECTION_KIND = "workspace_job.result";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

const TerminalArtifactSchema = Schema.Struct({
  artifactRef: NonEmptyString,
  path: NonEmptyString,
  schemaId: NonEmptyString,
  sha256: NonEmptyString,
  bytes: Schema.Number,
});

const VerificationCheckSchema = Schema.Struct({
  name: NonEmptyString,
  status: Schema.Literal("passed", "failed"),
  message: Schema.optional(Schema.String),
  proofRef: Schema.optional(NonEmptyString),
  fingerprint: Schema.optional(NonEmptyString),
});

const RequestedSchema = Schema.Struct({
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  requestedBy: NonEmptyString,
  workspaceRef: Schema.optional(NonEmptyString),
  inputRef: Schema.optional(NonEmptyString),
  inputHash: Schema.optional(NonEmptyString),
  terminalSchemaId: NonEmptyString,
});

const TerminalSchema = Schema.Struct({
  requestedEventId: Schema.Number,
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  terminalArtifact: TerminalArtifactSchema,
});

const TerminalVerdictSchema = Schema.Struct({
  requestedEventId: Schema.Number,
  terminalFinalizedEventId: Schema.Number,
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  checks: Schema.Array(VerificationCheckSchema),
  summary: Schema.optional(Schema.String),
});

const FailureSchema = Schema.Struct({
  phase: Schema.Literal(
    "request",
    "seed",
    "submit",
    "collect_candidate",
    "finalize",
    "data_plane",
    "verify_infra",
    "projection",
  ),
  class: Schema.Literal(
    "substrate",
    "provider",
    "consumer_contract",
    "timeout",
    "cancelled",
    "unknown",
  ),
  code: NonEmptyString,
  message: NonEmptyString,
  retryable: Schema.optional(Schema.Boolean),
});

const FailedSchema = Schema.Struct({
  requestedEventId: Schema.Number,
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  failure: FailureSchema,
});

export const workspaceJobCarrier = defineCarrier({
  packageId: WORKSPACE_JOB_FACT_OWNER,
  prefix: WORKSPACE_JOB_EVENT_PREFIX,
  roles: ["generator", "reader"],
  events: {
    requested: event({
      kind: "requested",
      payload: RequestedSchema,
      claim: pre({ key: "claim" }),
    }),
    terminal_finalized: event({
      kind: "terminal_finalized",
      payload: TerminalSchema,
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    verified: event({
      kind: "verified",
      payload: TerminalVerdictSchema,
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    verifier_rejected: event({
      kind: "verifier_rejected",
      payload: TerminalVerdictSchema,
      claim: rejected({
        key: "claim",
        rejectionKinds: ["validation_failed", "policy_denied"],
      }),
    }),
    failed: event({
      kind: "failed",
      payload: FailedSchema,
      claim: rejected({
        key: "claim",
        rejectionKinds: ["provider_rejected", "validation_failed", "resource_denied"],
      }),
    }),
  },
});

export const WORKSPACE_JOB_KIND = workspaceJobCarrier.kind;
export const WORKSPACE_JOB_EVENTS = workspaceJobCarrier.events;
export const workspaceJobBoundaryContract = workspaceJobCarrier.boundaryContract;
export const workspaceJobSettlementContract = workspaceJobCarrier.settlementContract;
export const workspaceJobBoundaryPackage = workspaceJobCarrier.boundaryPackage;
