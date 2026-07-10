import { Schema } from "effect";
import { defineCarrier, event, lived, pre, rejected } from "@agent-os/core/carrier";

export const WORKSPACE_OP_EVENT_PREFIX = "workspace_op.";
export const WORKSPACE_OP_FACT_OWNER = "@agent-os/workspace-op";
export const WORKSPACE_OP_PROJECTION_KIND = "workspace_op.status";

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

const WorkspaceOperationNameSchema = Schema.Literals(["write_file", "bash"]);

const WorkspaceOperationLimitsSchema = Schema.Struct({
  maxFileBytes: Schema.optional(Schema.Number),
  maxCommandChars: Schema.optional(Schema.Number),
  execTimeoutMs: Schema.optional(Schema.Number),
  maxOutputBytes: Schema.optional(Schema.Number),
});

const WorkspaceOperationRequestSchema = Schema.Struct({
  requestedBy: NonEmptyString,
  workspaceRef: NonEmptyString,
  toolCallId: Schema.optional(NonEmptyString),
  toolName: WorkspaceOperationNameSchema,
  path: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
  envRefs: Schema.optional(
    Schema.Array(Schema.Struct({ name: NonEmptyString, ref: NonEmptyString })),
  ),
  materialRefs: Schema.optional(Schema.Array(NonEmptyString)),
  limits: Schema.optional(WorkspaceOperationLimitsSchema),
});

const WorkspaceOperationResultSchema = Schema.Struct({
  requestedEventId: Schema.Number,
  operationRef: NonEmptyString,
  workspaceRef: NonEmptyString,
  toolCallId: Schema.optional(NonEmptyString),
  toolName: WorkspaceOperationNameSchema,
  idempotencyKey: NonEmptyString,
  resultHash: NonEmptyString,
  path: Schema.optional(Schema.String),
  bytesWritten: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  command: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  stdoutPreview: Schema.optional(Schema.String),
  stderrPreview: Schema.optional(Schema.String),
  stdoutBytes: Schema.optional(Schema.Number),
  stderrBytes: Schema.optional(Schema.Number),
  stdoutTruncated: Schema.optional(Schema.Boolean),
  stderrTruncated: Schema.optional(Schema.Boolean),
  stdoutHash: Schema.optional(NonEmptyString),
  stderrHash: Schema.optional(NonEmptyString),
  durationMs: Schema.optional(Schema.Number),
});

const WorkspaceOperationRejectedSchema = Schema.Struct({
  requestedEventId: Schema.Number,
  operationRef: NonEmptyString,
  workspaceRef: NonEmptyString,
  toolCallId: Schema.optional(NonEmptyString),
  toolName: WorkspaceOperationNameSchema,
  idempotencyKey: NonEmptyString,
  reason: NonEmptyString,
});

export const workspaceOpCarrier = defineCarrier({
  ownerId: WORKSPACE_OP_FACT_OWNER,
  sourcePackageName: "@agent-os/runtime",
  prefix: WORKSPACE_OP_EVENT_PREFIX,
  roles: ["generator", "resolver", "reader"],
  events: {
    requested: event({
      kind: "requested",
      payload: WorkspaceOperationRequestSchema,
      claim: pre({ key: "claim" }),
    }),
    completed: event({
      kind: "completed",
      payload: WorkspaceOperationResultSchema,
      claim: lived({ key: "claim", anchorKinds: ["external_receipt"] }),
    }),
    rejected: event({
      kind: "rejected",
      payload: WorkspaceOperationRejectedSchema,
      claim: rejected({
        key: "claim",
        rejectionKinds: ["provider_rejected", "validation_failed", "resource_denied"],
      }),
    }),
  },
});

export const WORKSPACE_OP_KIND = workspaceOpCarrier.kind;
export const WORKSPACE_OP_EVENTS = workspaceOpCarrier.events;
export const workspaceOpBoundaryContract = workspaceOpCarrier.boundaryContract;
export const workspaceOpSettlementContract = workspaceOpCarrier.settlementContract;
export const workspaceOpBoundaryModule = workspaceOpCarrier.boundaryModule;
