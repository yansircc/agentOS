import { Schema } from "effect";
import { defineCarrier, event, lived, pre, rejected } from "@agent-os/kernel/carrier";

export const WORKSPACE_JOB_EVENT_PREFIX = "workspace_job.";
export const WORKSPACE_JOB_FACT_OWNER = "@agent-os/workspace-job";
export const WORKSPACE_JOB_PROJECTION_KIND = "workspace_job.result";

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

const TerminalArtifactSchema = Schema.Struct({
  artifactRef: NonEmptyString,
  path: NonEmptyString,
  schemaId: NonEmptyString,
  sha256: NonEmptyString,
  bytes: Schema.Number,
});

const VerificationCheckSchema = Schema.Struct({
  name: NonEmptyString,
  status: Schema.Literals(["passed", "failed"]),
  message: Schema.optional(Schema.String),
  proofRef: Schema.optional(NonEmptyString),
  fingerprint: Schema.optional(NonEmptyString),
});

const AttemptSchema = Schema.Struct({
  index: Schema.Number,
  maxAttempts: Schema.Number,
  cause: Schema.Literals(["initial", "verifier_repair"]),
  repairOfRequestedEventId: Schema.optional(Schema.Number),
});

const RequestedSchema = Schema.Struct({
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  requestedBy: NonEmptyString,
  workspaceRef: Schema.optional(NonEmptyString),
  inputRef: Schema.optional(NonEmptyString),
  inputHash: Schema.optional(NonEmptyString),
  terminalSchemaId: NonEmptyString,
  attempt: Schema.optional(AttemptSchema),
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
  phase: Schema.Literals([
    "request",
    "seed",
    "submit",
    "collect_candidate",
    "finalize",
    "data_plane",
    "verify_infra",
    "projection",
  ]),
  code: NonEmptyString,
  reason: NonEmptyString,
  retryable: Schema.optional(Schema.Boolean),
});

const FailedSchema = Schema.Struct({
  requestedEventId: Schema.Number,
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  failure: FailureSchema,
  submitRunId: Schema.optional(Schema.Number),
});

const SeedWrittenSchema = Schema.Struct({
  requestedEventId: Schema.Number,
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  seedPaths: Schema.Array(Schema.String),
});

const TerminalBuildAttemptedSchema = Schema.Struct({
  requestedEventId: Schema.Number,
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  submitRunId: Schema.Number,
  schemaId: NonEmptyString,
  bytes: Schema.Number,
  sha256: NonEmptyString,
});

const ArtifactWrittenSchema = Schema.Struct({
  requestedEventId: Schema.Number,
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  path: NonEmptyString,
  artifactRef: NonEmptyString,
  submitRunId: Schema.Number,
  schemaId: NonEmptyString,
  bytes: Schema.Number,
  sha256: NonEmptyString,
});

const ArtifactReadbackVerifiedSchema = Schema.Struct({
  requestedEventId: Schema.Number,
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  path: NonEmptyString,
  artifactRef: NonEmptyString,
  submitRunId: Schema.Number,
  schemaId: NonEmptyString,
  bytes: Schema.Number,
  sha256: NonEmptyString,
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
    seed_written: event({
      kind: "seed_written",
      payload: SeedWrittenSchema,
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    terminal_build_attempted: event({
      kind: "terminal_build_attempted",
      payload: TerminalBuildAttemptedSchema,
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    artifact_written: event({
      kind: "artifact_written",
      payload: ArtifactWrittenSchema,
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
    artifact_readback_verified: event({
      kind: "artifact_readback_verified",
      payload: ArtifactReadbackVerifiedSchema,
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
    }),
  },
});

export const WORKSPACE_JOB_KIND = workspaceJobCarrier.kind;
export const WORKSPACE_JOB_EVENTS = workspaceJobCarrier.events;
export const workspaceJobBoundaryContract = workspaceJobCarrier.boundaryContract;
export const workspaceJobSettlementContract = workspaceJobCarrier.settlementContract;
export const workspaceJobBoundaryPackage = workspaceJobCarrier.boundaryPackage;
