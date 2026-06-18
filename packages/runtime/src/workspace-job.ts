import { Data, Duration, Effect, Schedule } from "effect";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import { RefResolverService } from "@agent-os/kernel/ref-resolver";
import { LlmTransport } from "@agent-os/llm-protocol";
import type { BoundaryCommitRejected } from "./boundary-commit";
import type { BoundaryEvents } from "./boundary-events";
import { BoundaryEvents as BoundaryEventsTag } from "./boundary-events";
import { Admission } from "./admission";
import { Ledger } from "./ledger";
import { MaterializedProjections } from "./projection";
import { Quota } from "./quota-service";
import { submitAgentEffect } from "./submit-agent";
import type { SubmitResult, SubmitSpec } from "@agent-os/runtime-protocol";
import type { LedgerTruthIdentity } from "@agent-os/runtime-protocol";
import { internalSubmitSpec } from "./internal-submit";
import {
  WORKSPACE_JOB_KIND,
  projectWorkspaceJob,
  projectWorkspaceJobAttempt,
  projectWorkspaceJobByIdempotencyKey,
  projectWorkspaceJobSteps,
  rejectWorkspaceJobByVerifier,
  rejectWorkspaceJobFailed,
  settleWorkspaceJobArtifactReadbackVerified,
  settleWorkspaceJobArtifactWritten,
  settleWorkspaceJobSeedWritten,
  settleWorkspaceJobTerminalFinalized,
  settleWorkspaceJobTerminalBuildAttempted,
  settleWorkspaceJobVerified,
  workspaceJobArtifactReadbackVerifiedPayload,
  workspaceJobArtifactWrittenPayload,
  workspaceJobBoundaryContract,
  workspaceJobFailedPayload,
  workspaceJobFailureCode,
  workspaceJobPreClaim,
  workspaceJobRequestedPayload,
  workspaceJobSeedWrittenPayload,
  workspaceJobTerminalFinalizedPayload,
  workspaceJobTerminalBuildAttemptedPayload,
  workspaceJobVerifierRejectedPayload,
  workspaceJobVerifiedPayload,
  type WorkspaceJobAttempt,
  type WorkspaceJobFailure,
  type WorkspaceJobProjection,
  type WorkspaceJobRequestedPayload,
  type WorkspaceJobStepProjection,
  type WorkspaceJobTerminalArtifact,
  type WorkspaceJobVerificationCheck,
} from "@agent-os/workspace-job";
import { projectSubmitResult } from "./run-projector";

export interface WorkspaceJobSeedFile {
  readonly path: string;
  readonly content: string;
}

export interface WorkspaceJobTerminalArtifactBuild {
  readonly schemaId: string;
  readonly bytes: string | Uint8Array;
}

export interface WorkspaceJobTerminalArtifactWriteResult {
  readonly artifactRef: string;
}

export interface WorkspaceJobFinalizedArtifact {
  readonly artifact: WorkspaceJobTerminalArtifact;
  readonly bytes: Uint8Array;
}

interface WorkspaceJobBuiltArtifact {
  readonly schemaId: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

interface WorkspaceJobWrittenArtifact {
  readonly path: string;
  readonly artifactRef: string;
  readonly schemaId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly submitRunId: number;
}

export interface WorkspaceJobDataPlane {
  readonly writeSeedFile: (file: WorkspaceJobSeedFile) => Promise<void>;
  readonly buildTerminalArtifact: (input: {
    readonly runId: string;
    readonly candidatePath: string;
    readonly terminalSchemaId: string;
    readonly submitResult: SubmitResult;
  }) => Promise<WorkspaceJobTerminalArtifactBuild>;
  readonly writeTerminalArtifact: (input: {
    readonly runId: string;
    readonly path: string;
    readonly schemaId: string;
    readonly bytes: Uint8Array;
  }) => Promise<WorkspaceJobTerminalArtifactWriteResult>;
  readonly readTerminalArtifact: (input: {
    readonly runId: string;
    readonly path: string;
    readonly artifactRef: string;
  }) => Promise<string | Uint8Array>;
}

export type WorkspaceJobVerifierResult =
  | {
      readonly ok: true;
      readonly checks: ReadonlyArray<WorkspaceJobVerificationCheck>;
      readonly summary?: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly checks: ReadonlyArray<WorkspaceJobVerificationCheck>;
      readonly summary?: string;
    };

export interface WorkspaceJobVerifier {
  readonly verify: (input: {
    readonly runId: string;
    readonly artifact: WorkspaceJobTerminalArtifact;
    readonly bytes: Uint8Array;
    readonly submitResult: SubmitResult;
  }) => Promise<WorkspaceJobVerifierResult>;
}

export interface WorkspaceJobAttemptContext {
  readonly runId: string;
  readonly candidatePath: string;
  readonly attempt: WorkspaceJobAttempt;
}

export interface WorkspaceJobRepairDecisionInput extends WorkspaceJobAttemptContext {
  readonly previousAttempt: {
    readonly requestedEventId: number;
    readonly attempt: WorkspaceJobAttempt;
    readonly terminalArtifact: WorkspaceJobTerminalArtifact;
    readonly checks: ReadonlyArray<WorkspaceJobVerificationCheck>;
    readonly reason: string;
  };
}

export interface WorkspaceJobRecovery {
  readonly maxAttempts: number;
  readonly shouldRepair?: (input: WorkspaceJobRepairDecisionInput) => boolean | Promise<boolean>;
  readonly buildRepairSubmitSpec: (input: WorkspaceJobRepairDecisionInput) => SubmitSpec;
}

export interface RunWorkspaceJobSpec {
  readonly scope: string;
  readonly identity: LedgerTruthIdentity;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly requestedBy: string;
  readonly terminalSchemaId: string;
  readonly candidatePath: string;
  readonly dataPlane: WorkspaceJobDataPlane;
  readonly verifier: WorkspaceJobVerifier;
  readonly buildSubmitSpec: (input: WorkspaceJobAttemptContext) => SubmitSpec;
  readonly recovery?: WorkspaceJobRecovery;
  readonly terminalArtifactPath: string;
  readonly seedFiles?: ReadonlyArray<WorkspaceJobSeedFile>;
  readonly workspaceRef?: string;
  readonly inputRef?: string;
  readonly inputHash?: string;
}

type ActiveRunWorkspaceJobSpec = Omit<RunWorkspaceJobSpec, "recovery"> & {
  readonly attempt: WorkspaceJobAttempt;
};

export class WorkspaceJobDataPlaneFailed extends Data.TaggedError(
  "agent_os.workspace_job_data_plane_failed",
)<{
  readonly phase: "seed" | "terminal_build" | "terminal_write" | "terminal_read";
  readonly cause: unknown;
}> {}

export class WorkspaceJobCandidateMissing extends Data.TaggedError(
  "agent_os.workspace_job_candidate_missing",
)<{
  readonly candidatePath: string;
}> {}

export class WorkspaceJobRunIdMismatch extends Data.TaggedError(
  "agent_os.workspace_job_run_id_mismatch",
)<{
  readonly expectedRunId: string;
  readonly actualRunId: string;
}> {}

export class WorkspaceJobVerifierFailed extends Data.TaggedError(
  "agent_os.workspace_job_verifier_failed",
)<{
  readonly cause: unknown;
}> {}

const textEncoder = new TextEncoder();

const bytesOf = (bytes: string | Uint8Array): Uint8Array =>
  typeof bytes === "string" ? textEncoder.encode(bytes) : bytes;

const sha256Hex = (bytes: Uint8Array): Effect.Effect<string> => {
  const copy = new Uint8Array(bytes);
  return Effect.promise(() => crypto.subtle.digest("SHA-256", copy)).pipe(
    Effect.map((buffer) =>
      Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    ),
  );
};

const submitFailure = (reason: string): WorkspaceJobFailure => ({
  phase: "submit",
  code: workspaceJobFailureCode("submit", reason),
  reason,
  retryable: reason !== "interrupted",
});

const requestFailure = (reason: string): WorkspaceJobFailure => ({
  phase: "request",
  code: workspaceJobFailureCode("request", reason),
  reason,
});

const failureFromDataPlane = (failure: WorkspaceJobDataPlaneFailed): WorkspaceJobFailure => {
  const cause = failure.cause;
  if (cause instanceof WorkspaceJobCandidateMissing) {
    return {
      phase: "collect_candidate",
      code: workspaceJobFailureCode("candidate_missing"),
      reason: "candidate_missing",
    };
  }
  if (cause instanceof WorkspaceJobRunIdMismatch) {
    return {
      phase: "finalize",
      code: workspaceJobFailureCode("run_id_mismatch"),
      reason: "run_id_mismatch",
    };
  }
  if (failure.phase === "seed") {
    return {
      phase: "seed",
      code: workspaceJobFailureCode("seed_write_failed"),
      reason: "seed_write_failed",
      retryable: true,
    };
  }
  if (failure.phase === "terminal_build") {
    return {
      phase: "finalize",
      code: workspaceJobFailureCode("terminal_build_failed"),
      reason: "terminal_build_failed",
    };
  }
  if (failure.phase === "terminal_write") {
    return {
      phase: "data_plane",
      code: workspaceJobFailureCode("terminal_write_failed"),
      reason: "terminal_write_failed",
      retryable: true,
    };
  }
  if (failure.phase === "terminal_read") {
    return {
      phase: "data_plane",
      code: workspaceJobFailureCode("terminal_read_failed"),
      reason: "terminal_read_failed",
      retryable: true,
    };
  }
  return {
    phase: "data_plane",
    code: workspaceJobFailureCode("data_plane_failed"),
    reason: "data_plane_failed",
    retryable: true,
  };
};

const verifierInfraFailure = (_cause: unknown): WorkspaceJobFailure => ({
  phase: "verify_infra",
  code: workspaceJobFailureCode("verifier_failed"),
  reason: "verifier_failed",
  retryable: true,
});

const eventsFor = (
  ledger: ContextualLedger,
  identity: LedgerTruthIdentity,
): Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError> => ledger.events(identity);

type ContextualLedger = {
  readonly events: (
    identity: LedgerTruthIdentity,
  ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError>;
};
type ContextualBoundaryEvents = {
  readonly commit: (
    contract: typeof workspaceJobBoundaryContract,
    event: string,
    payload: unknown,
  ) => Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError>;
};

const commitWorkspaceJob = (
  boundaryEvents: ContextualBoundaryEvents,
  event: (typeof WORKSPACE_JOB_KIND)[keyof typeof WORKSPACE_JOB_KIND],
  payload: unknown,
): Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError> =>
  boundaryEvents.commit(workspaceJobBoundaryContract, event, payload);

const commitFailed = (
  boundaryEvents: ContextualBoundaryEvents,
  spec: RunWorkspaceJobSpec,
  requestedEventId: number,
  failure: WorkspaceJobFailure,
  submitRunId?: number,
): Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError> => {
  const requestClaim = workspaceJobPreClaim({
    runId: spec.runId,
    idempotencyKey: spec.idempotencyKey,
    scopeRef: spec.identity.scopeRef,
    effectAuthorityRef: spec.identity.effectAuthorityRef,
  });
  const claim = rejectWorkspaceJobFailed(requestClaim, {
    runId: spec.runId,
    requestedEventId,
  });
  return commitWorkspaceJob(
    boundaryEvents,
    WORKSPACE_JOB_KIND.FAILED,
    workspaceJobFailedPayload({
      requestedEventId,
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      failure,
      ...(submitRunId === undefined ? {} : { submitRunId }),
      claim,
    }),
  );
};

const commitSeedWritten = (
  boundaryEvents: ContextualBoundaryEvents,
  spec: RunWorkspaceJobSpec,
  requestedEventId: number,
): Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError> => {
  const claim = settleWorkspaceJobSeedWritten(
    workspaceJobPreClaim({
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      scopeRef: spec.identity.scopeRef,
      effectAuthorityRef: spec.identity.effectAuthorityRef,
    }),
    { runId: spec.runId, requestedEventId },
  );
  return commitWorkspaceJob(
    boundaryEvents,
    WORKSPACE_JOB_KIND.SEED_WRITTEN,
    workspaceJobSeedWrittenPayload({
      requestedEventId,
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      seedPaths: (spec.seedFiles ?? []).map((file) => file.path),
      claim,
    }),
  );
};

const commitTerminalBuildAttempted = (
  boundaryEvents: ContextualBoundaryEvents,
  spec: RunWorkspaceJobSpec,
  requestedEventId: number,
  submitRunId: number,
  built: WorkspaceJobBuiltArtifact,
): Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError> => {
  const claim = settleWorkspaceJobTerminalBuildAttempted(
    workspaceJobPreClaim({
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      scopeRef: spec.identity.scopeRef,
      effectAuthorityRef: spec.identity.effectAuthorityRef,
    }),
    { runId: spec.runId, requestedEventId, sha256: built.sha256 },
  );
  return commitWorkspaceJob(
    boundaryEvents,
    WORKSPACE_JOB_KIND.TERMINAL_BUILD_ATTEMPTED,
    workspaceJobTerminalBuildAttemptedPayload({
      requestedEventId,
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      submitRunId,
      schemaId: built.schemaId,
      bytes: built.bytes.byteLength,
      sha256: built.sha256,
      claim,
    }),
  );
};

const commitArtifactWritten = (
  boundaryEvents: ContextualBoundaryEvents,
  spec: RunWorkspaceJobSpec,
  requestedEventId: number,
  written: WorkspaceJobWrittenArtifact,
): Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError> => {
  const claim = settleWorkspaceJobArtifactWritten(
    workspaceJobPreClaim({
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      scopeRef: spec.identity.scopeRef,
      effectAuthorityRef: spec.identity.effectAuthorityRef,
    }),
    { runId: spec.runId, requestedEventId, artifactRef: written.artifactRef },
  );
  return commitWorkspaceJob(
    boundaryEvents,
    WORKSPACE_JOB_KIND.ARTIFACT_WRITTEN,
    workspaceJobArtifactWrittenPayload({
      requestedEventId,
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      path: written.path,
      artifactRef: written.artifactRef,
      submitRunId: written.submitRunId,
      schemaId: written.schemaId,
      bytes: written.bytes,
      sha256: written.sha256,
      claim,
    }),
  );
};

const commitArtifactReadbackVerified = (
  boundaryEvents: ContextualBoundaryEvents,
  spec: RunWorkspaceJobSpec,
  requestedEventId: number,
  artifact: WorkspaceJobFinalizedArtifact,
  submitRunId: number,
): Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError> => {
  const claim = settleWorkspaceJobArtifactReadbackVerified(
    workspaceJobPreClaim({
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      scopeRef: spec.identity.scopeRef,
      effectAuthorityRef: spec.identity.effectAuthorityRef,
    }),
    {
      runId: spec.runId,
      requestedEventId,
      artifactRef: artifact.artifact.artifactRef,
      sha256: artifact.artifact.sha256,
    },
  );
  return commitWorkspaceJob(
    boundaryEvents,
    WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
    workspaceJobArtifactReadbackVerifiedPayload({
      requestedEventId,
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      path: artifact.artifact.path,
      artifactRef: artifact.artifact.artifactRef,
      submitRunId,
      schemaId: artifact.artifact.schemaId,
      bytes: artifact.artifact.bytes,
      sha256: artifact.artifact.sha256,
      claim,
    }),
  );
};

const currentProjection = (
  events: ReadonlyArray<LedgerEvent>,
  runId: string,
): WorkspaceJobProjection => projectWorkspaceJob(events, runId);

const workspaceJobSeedWriteRetrySchedule = Schedule.exponential(Duration.millis(100)).pipe(
  Schedule.both(Schedule.recurs(2)),
  Schedule.jittered,
);

const writeSeedFiles = (
  dataPlane: WorkspaceJobDataPlane,
  files: ReadonlyArray<WorkspaceJobSeedFile>,
): Effect.Effect<void, WorkspaceJobDataPlaneFailed> =>
  Effect.forEach(
    files,
    (file) =>
      Effect.tryPromise({
        try: () => dataPlane.writeSeedFile(file),
        catch: (cause) => new WorkspaceJobDataPlaneFailed({ phase: "seed", cause }),
      }).pipe(Effect.retry(workspaceJobSeedWriteRetrySchedule)),
    { discard: true },
  );

const buildTerminalArtifact = (
  spec: RunWorkspaceJobSpec,
  submitResult: SubmitResult,
): Effect.Effect<WorkspaceJobBuiltArtifact, WorkspaceJobDataPlaneFailed> =>
  Effect.gen(function* () {
    const built = yield* Effect.tryPromise({
      try: () =>
        spec.dataPlane.buildTerminalArtifact({
          runId: spec.runId,
          candidatePath: spec.candidatePath,
          terminalSchemaId: spec.terminalSchemaId,
          submitResult,
        }),
      catch: (cause) => new WorkspaceJobDataPlaneFailed({ phase: "terminal_build", cause }),
    });
    const builtBytes = bytesOf(built.bytes);
    const builtHash = yield* sha256Hex(builtBytes);
    return {
      schemaId: built.schemaId,
      bytes: builtBytes,
      sha256: `sha256:${builtHash}`,
    };
  });

const writeBuiltArtifact = (
  spec: RunWorkspaceJobSpec,
  submitResult: SubmitResult,
  built: WorkspaceJobBuiltArtifact,
): Effect.Effect<WorkspaceJobWrittenArtifact, WorkspaceJobDataPlaneFailed> =>
  Effect.gen(function* () {
    const written = yield* Effect.tryPromise({
      try: () =>
        spec.dataPlane.writeTerminalArtifact({
          runId: spec.runId,
          path: spec.terminalArtifactPath,
          schemaId: built.schemaId,
          bytes: built.bytes,
        }),
      catch: (cause) => new WorkspaceJobDataPlaneFailed({ phase: "terminal_write", cause }),
    });
    return {
      path: spec.terminalArtifactPath,
      artifactRef: written.artifactRef,
      schemaId: built.schemaId,
      bytes: built.bytes.byteLength,
      sha256: built.sha256,
      submitRunId: submitResult.runId,
    };
  });

const readFinalizedArtifact = (
  spec: RunWorkspaceJobSpec,
  written: WorkspaceJobWrittenArtifact,
): Effect.Effect<WorkspaceJobFinalizedArtifact, WorkspaceJobDataPlaneFailed> =>
  Effect.gen(function* () {
    const readback = yield* Effect.tryPromise({
      try: () =>
        spec.dataPlane.readTerminalArtifact({
          runId: spec.runId,
          path: written.path,
          artifactRef: written.artifactRef,
        }),
      catch: (cause) => new WorkspaceJobDataPlaneFailed({ phase: "terminal_read", cause }),
    });
    const readbackBytes = bytesOf(readback);
    const hash = yield* sha256Hex(readbackBytes);
    return {
      bytes: readbackBytes,
      artifact: {
        artifactRef: written.artifactRef,
        path: written.path,
        schemaId: written.schemaId,
        sha256: `sha256:${hash}`,
        bytes: readbackBytes.byteLength,
      },
    };
  });

const verifyArtifact = (
  spec: RunWorkspaceJobSpec,
  artifact: WorkspaceJobFinalizedArtifact,
  submitResult: SubmitResult,
): Effect.Effect<WorkspaceJobVerifierResult, WorkspaceJobVerifierFailed> =>
  Effect.tryPromise({
    try: () =>
      spec.verifier.verify({
        runId: spec.runId,
        artifact: artifact.artifact,
        bytes: artifact.bytes,
        submitResult,
      }),
    catch: (cause) => new WorkspaceJobVerifierFailed({ cause }),
  });

const initialAttempt = (maxAttempts: number): WorkspaceJobAttempt => ({
  index: 1,
  maxAttempts,
  cause: "initial",
});

const attemptFromRequest = (request: WorkspaceJobRequestedPayload): WorkspaceJobAttempt =>
  request.attempt ?? initialAttempt(1);

const repairAttempt = (
  previous: WorkspaceJobProjection & { readonly status: "verifier_rejected" },
  maxAttempts: number,
): WorkspaceJobAttempt => ({
  index: attemptFromRequest(previous.request).index + 1,
  maxAttempts,
  cause: "verifier_repair",
  repairOfRequestedEventId: previous.requestedEventId,
});

const recoveryMaxAttempts = (recovery: WorkspaceJobRecovery | undefined): number =>
  recovery === undefined ? 1 : Math.max(1, Math.trunc(recovery.maxAttempts));

const repairIdempotencyKey = (baseIdempotencyKey: string, attempt: WorkspaceJobAttempt): string =>
  `${baseIdempotencyKey}:repair:${attempt.index}`;

const repairReason = (
  projection: WorkspaceJobProjection & { readonly status: "verifier_rejected" },
): string => projection.rejected.summary ?? "verifier_rejected";

const repairDecisionInput = (
  projection: WorkspaceJobProjection & { readonly status: "verifier_rejected" },
  candidatePath: string,
  attempt: WorkspaceJobAttempt,
): WorkspaceJobRepairDecisionInput => ({
  runId: projection.runId,
  candidatePath,
  attempt,
  previousAttempt: {
    requestedEventId: projection.requestedEventId,
    attempt: attemptFromRequest(projection.request),
    terminalArtifact: projection.terminalArtifact,
    checks: projection.checks,
    reason: repairReason(projection),
  },
});

const shouldRepair = (
  recovery: WorkspaceJobRecovery,
  input: WorkspaceJobRepairDecisionInput,
): Effect.Effect<boolean, WorkspaceJobFailure> =>
  Effect.tryPromise({
    try: async () => recovery.shouldRepair?.(input) ?? true,
    catch: () => requestFailure("repair_decision_failed"),
  });

const activeSpecForCurrentAttempt = (
  spec: RunWorkspaceJobSpec,
  events: ReadonlyArray<LedgerEvent>,
): ActiveRunWorkspaceJobSpec => {
  const existing = projectWorkspaceJobByIdempotencyKey(events, spec.idempotencyKey);
  const current = projectWorkspaceJob(
    events,
    existing.status === "found" ? existing.runId : spec.runId,
  );
  if (current.status !== "running") {
    return {
      ...spec,
      attempt: initialAttempt(recoveryMaxAttempts(spec.recovery)),
    };
  }
  const attempt = attemptFromRequest(current.request);
  if (
    attempt.cause !== "verifier_repair" ||
    attempt.repairOfRequestedEventId === undefined ||
    spec.recovery === undefined
  ) {
    return {
      ...spec,
      runId: current.runId,
      idempotencyKey: current.request.idempotencyKey,
      terminalSchemaId: current.request.terminalSchemaId,
      attempt,
    };
  }
  const previous = projectWorkspaceJobAttempt(
    events,
    current.runId,
    attempt.repairOfRequestedEventId,
  );
  if (previous.status !== "verifier_rejected") {
    return {
      ...spec,
      runId: current.runId,
      idempotencyKey: current.request.idempotencyKey,
      terminalSchemaId: current.request.terminalSchemaId,
      attempt,
    };
  }
  const input = repairDecisionInput(previous, spec.candidatePath, attempt);
  return {
    ...spec,
    runId: current.runId,
    idempotencyKey: current.request.idempotencyKey,
    terminalSchemaId: current.request.terminalSchemaId,
    attempt,
    buildSubmitSpec: () => spec.recovery!.buildRepairSubmitSpec(input),
  };
};

/**
 * Runs one attempt of the protected workspace-job pipeline.
 */
const runWorkspaceJobAttemptEffect = (
  spec: ActiveRunWorkspaceJobSpec,
): Effect.Effect<
  WorkspaceJobProjection,
  unknown,
  | Ledger
  | BoundaryEvents
  | MaterializedProjections
  | LlmTransport
  | Quota
  | Admission
  | RefResolverService
> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const boundaryEvents = yield* BoundaryEventsTag;
    const before = yield* eventsFor(ledger, spec.identity);
    const existing = projectWorkspaceJobByIdempotencyKey(before, spec.idempotencyKey);
    let activeSpec = spec;
    let requestedEventId: number;
    let claim;

    if (existing.status === "found") {
      const projection = currentProjection(before, existing.runId);
      if (projection.status !== "running") {
        return projection;
      }
      activeSpec = {
        ...spec,
        runId: projection.runId,
        idempotencyKey: projection.request.idempotencyKey,
        terminalSchemaId: projection.request.terminalSchemaId,
        ...(projection.request.workspaceRef === undefined
          ? {}
          : { workspaceRef: projection.request.workspaceRef }),
        ...(projection.request.inputRef === undefined
          ? {}
          : { inputRef: projection.request.inputRef }),
        ...(projection.request.inputHash === undefined
          ? {}
          : { inputHash: projection.request.inputHash }),
        attempt: attemptFromRequest(projection.request),
      };
      requestedEventId = projection.requestedEventId;
      claim = projection.request.claim;
    } else {
      claim = workspaceJobPreClaim({
        runId: activeSpec.runId,
        idempotencyKey: activeSpec.idempotencyKey,
        scopeRef: activeSpec.identity.scopeRef,
        effectAuthorityRef: activeSpec.identity.effectAuthorityRef,
      });
      const requested = yield* commitWorkspaceJob(
        boundaryEvents,
        WORKSPACE_JOB_KIND.REQUESTED,
        workspaceJobRequestedPayload({
          runId: activeSpec.runId,
          idempotencyKey: activeSpec.idempotencyKey,
          requestedBy: activeSpec.requestedBy,
          terminalSchemaId: activeSpec.terminalSchemaId,
          claim,
          ...(activeSpec.workspaceRef === undefined
            ? {}
            : { workspaceRef: activeSpec.workspaceRef }),
          ...(activeSpec.inputRef === undefined ? {} : { inputRef: activeSpec.inputRef }),
          ...(activeSpec.inputHash === undefined ? {} : { inputHash: activeSpec.inputHash }),
          attempt: activeSpec.attempt,
        }),
      );
      requestedEventId = requested.id;
    }

    const failAndProject = (failure: WorkspaceJobFailure, submitRunId?: number) =>
      Effect.gen(function* () {
        yield* commitFailed(boundaryEvents, activeSpec, requestedEventId, failure, submitRunId);
        const after = yield* eventsFor(ledger, activeSpec.identity);
        return currentProjection(after, activeSpec.runId);
      });

    let events = yield* eventsFor(ledger, activeSpec.identity);
    let steps: WorkspaceJobStepProjection = projectWorkspaceJobSteps(events, activeSpec.runId);
    if (steps.status === "missing") {
      return currentProjection(events, activeSpec.runId);
    }

    if (steps.seedWritten === undefined) {
      const seeded = yield* Effect.result(
        writeSeedFiles(activeSpec.dataPlane, activeSpec.seedFiles ?? []),
      );
      if (seeded._tag === "Failure") {
        return yield* failAndProject(failureFromDataPlane(seeded.failure));
      }
      yield* commitSeedWritten(boundaryEvents, activeSpec, requestedEventId);
      events = yield* eventsFor(ledger, activeSpec.identity);
      steps = projectWorkspaceJobSteps(events, activeSpec.runId);
      if (steps.status === "missing") {
        return currentProjection(events, activeSpec.runId);
      }
    }

    const submitResultFromStep = (
      submitRunId: number | undefined,
    ): Effect.Effect<SubmitResult | undefined, WorkspaceJobDataPlaneFailed> => {
      if (submitRunId === undefined) return Effect.succeed(undefined);
      const projected = projectSubmitResult(events, submitRunId);
      return projected === null
        ? Effect.fail(
            new WorkspaceJobDataPlaneFailed({
              phase: "terminal_read",
              cause: new Error("workspace job submit result is not reconstructable"),
            }),
          )
        : Effect.succeed(projected);
    };

    let submitResult = yield* submitResultFromStep(
      steps.artifactReadbackVerified?.submitRunId ??
        steps.artifactWritten?.submitRunId ??
        steps.terminalBuildAttempted?.submitRunId,
    );
    let finalized: WorkspaceJobFinalizedArtifact;

    if (steps.artifactReadbackVerified !== undefined) {
      const read = yield* Effect.result(
        readFinalizedArtifact(activeSpec, {
          path: steps.artifactReadbackVerified.path,
          artifactRef: steps.artifactReadbackVerified.artifactRef,
          schemaId: steps.artifactReadbackVerified.schemaId,
          bytes: steps.artifactReadbackVerified.bytes,
          sha256: steps.artifactReadbackVerified.sha256,
          submitRunId: steps.artifactReadbackVerified.submitRunId,
        }),
      );
      if (read._tag === "Failure") {
        return yield* failAndProject(
          failureFromDataPlane(read.failure),
          steps.artifactReadbackVerified.submitRunId,
        );
      }
      finalized = read.success;
    } else if (steps.artifactWritten !== undefined) {
      const read = yield* Effect.result(
        readFinalizedArtifact(activeSpec, {
          path: steps.artifactWritten.path,
          artifactRef: steps.artifactWritten.artifactRef,
          schemaId: steps.artifactWritten.schemaId,
          bytes: steps.artifactWritten.bytes,
          sha256: steps.artifactWritten.sha256,
          submitRunId: steps.artifactWritten.submitRunId,
        }),
      );
      if (read._tag === "Failure") {
        return yield* failAndProject(
          failureFromDataPlane(read.failure),
          steps.artifactWritten.submitRunId,
        );
      }
      finalized = read.success;
      yield* commitArtifactReadbackVerified(
        boundaryEvents,
        activeSpec,
        requestedEventId,
        finalized,
        steps.artifactWritten.submitRunId,
      );
      events = yield* eventsFor(ledger, activeSpec.identity);
      steps = projectWorkspaceJobSteps(events, activeSpec.runId);
    } else {
      if (submitResult === undefined) {
        const submitSpecResult = yield* Effect.result(
          Effect.try({
            try: () => {
              const publicSubmitSpec = activeSpec.buildSubmitSpec({
                runId: activeSpec.runId,
                candidatePath: activeSpec.candidatePath,
                attempt: activeSpec.attempt,
              });
              return internalSubmitSpec(publicSubmitSpec, {
                scope: activeSpec.scope,
                scopeRef: activeSpec.identity.scopeRef,
              });
            },
            catch: () => requestFailure("submit_spec_builder_failed"),
          }),
        );
        if (submitSpecResult._tag === "Failure") {
          return yield* failAndProject(submitSpecResult.failure);
        }
        const submitSpec = submitSpecResult.success;
        submitResult = yield* submitAgentEffect(submitSpec);
      }
      if (!submitResult.ok) {
        return yield* failAndProject(submitFailure(submitResult.reason), submitResult.runId);
      }

      const built = yield* Effect.result(buildTerminalArtifact(activeSpec, submitResult));
      if (built._tag === "Failure") {
        return yield* failAndProject(failureFromDataPlane(built.failure), submitResult.runId);
      }
      yield* commitTerminalBuildAttempted(
        boundaryEvents,
        activeSpec,
        requestedEventId,
        submitResult.runId,
        built.success,
      );
      const written = yield* Effect.result(
        writeBuiltArtifact(activeSpec, submitResult, built.success),
      );
      if (written._tag === "Failure") {
        return yield* failAndProject(failureFromDataPlane(written.failure), submitResult.runId);
      }
      yield* commitArtifactWritten(boundaryEvents, activeSpec, requestedEventId, written.success);
      const read = yield* Effect.result(readFinalizedArtifact(activeSpec, written.success));
      if (read._tag === "Failure") {
        return yield* failAndProject(failureFromDataPlane(read.failure), submitResult.runId);
      }
      finalized = read.success;
      yield* commitArtifactReadbackVerified(
        boundaryEvents,
        activeSpec,
        requestedEventId,
        finalized,
        submitResult.runId,
      );
      events = yield* eventsFor(ledger, activeSpec.identity);
      steps = projectWorkspaceJobSteps(events, activeSpec.runId);
    }

    if (steps.status === "missing") {
      return currentProjection(events, activeSpec.runId);
    }

    if (submitResult === undefined) {
      const submitRunId =
        steps.artifactReadbackVerified?.submitRunId ?? steps.artifactWritten?.submitRunId;
      submitResult = yield* submitResultFromStep(submitRunId);
    }
    if (submitResult === undefined || !submitResult.ok) {
      return yield* failAndProject(
        submitFailure(submitResult?.reason ?? "runtime_projection_missing"),
        submitResult?.runId,
      );
    }

    const finalizedEvent =
      steps.terminalFinalized === undefined
        ? yield* commitWorkspaceJob(
            boundaryEvents,
            WORKSPACE_JOB_KIND.TERMINAL_FINALIZED,
            workspaceJobTerminalFinalizedPayload({
              requestedEventId,
              runId: activeSpec.runId,
              idempotencyKey: activeSpec.idempotencyKey,
              terminalArtifact: finalized.artifact,
              claim: settleWorkspaceJobTerminalFinalized(claim, {
                runId: activeSpec.runId,
                requestedEventId,
                artifactRef: finalized.artifact.artifactRef,
              }),
            }),
          )
        : ({ id: steps.terminalFinalized.eventId } as LedgerEvent);

    const verdict = yield* Effect.result(verifyArtifact(activeSpec, finalized, submitResult));
    if (verdict._tag === "Failure") {
      return yield* failAndProject(verifierInfraFailure(verdict.failure.cause), submitResult.runId);
    }

    if (verdict.success.ok) {
      const verifiedClaim = settleWorkspaceJobVerified(claim, {
        runId: activeSpec.runId,
        requestedEventId,
        terminalFinalizedEventId: finalizedEvent.id,
      });
      yield* commitWorkspaceJob(
        boundaryEvents,
        WORKSPACE_JOB_KIND.VERIFIED,
        workspaceJobVerifiedPayload({
          requestedEventId,
          terminalFinalizedEventId: finalizedEvent.id,
          runId: activeSpec.runId,
          idempotencyKey: activeSpec.idempotencyKey,
          checks: verdict.success.checks,
          ...(verdict.success.summary === undefined ? {} : { summary: verdict.success.summary }),
          claim: verifiedClaim,
        }),
      );
    } else {
      const rejectedClaim = rejectWorkspaceJobByVerifier(claim, {
        runId: activeSpec.runId,
        requestedEventId,
        terminalFinalizedEventId: finalizedEvent.id,
      });
      yield* commitWorkspaceJob(
        boundaryEvents,
        WORKSPACE_JOB_KIND.VERIFIER_REJECTED,
        workspaceJobVerifierRejectedPayload({
          requestedEventId,
          terminalFinalizedEventId: finalizedEvent.id,
          runId: activeSpec.runId,
          idempotencyKey: activeSpec.idempotencyKey,
          checks: verdict.success.checks,
          summary: verdict.success.reason,
          claim: rejectedClaim,
        }),
      );
    }

    const after = yield* eventsFor(ledger, activeSpec.identity);
    return currentProjection(after, activeSpec.runId);
  });

/**
 * Runs a protected workspace job from product declarations to a carrier-owned
 * terminal projection. The verifier receives finalized artifact bytes; candidate
 * bytes are never the verification subject. When recovery is declared,
 * verifier_rejected is an attempt terminal state until the repair budget is
 * exhausted; the job projection is derived from the latest attempt.
 *
 * @agentosPrimitive primitive.runtime.runWorkspaceJobEffect
 * @agentosInvariant invariant.workspace-job.verified-terminal
 * @agentosDocs docs/packages/workspace-job.md
 * @public
 */
export const runWorkspaceJobEffect = (
  spec: RunWorkspaceJobSpec,
): Effect.Effect<
  WorkspaceJobProjection,
  unknown,
  | Ledger
  | BoundaryEvents
  | MaterializedProjections
  | LlmTransport
  | Quota
  | Admission
  | RefResolverService
> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const boundaryEvents = yield* BoundaryEventsTag;
    const maxAttempts = recoveryMaxAttempts(spec.recovery);
    const before = yield* eventsFor(ledger, spec.identity);
    let activeSpec: ActiveRunWorkspaceJobSpec = activeSpecForCurrentAttempt(spec, before);

    for (;;) {
      const projection = yield* runWorkspaceJobAttemptEffect(activeSpec);
      if (projection.status !== "verifier_rejected" || spec.recovery === undefined) {
        return projection;
      }

      const nextAttempt = repairAttempt(projection, maxAttempts);
      if (nextAttempt.index > maxAttempts) {
        return projection;
      }

      const input = repairDecisionInput(projection, spec.candidatePath, nextAttempt);
      const repairDecision = yield* Effect.result(shouldRepair(spec.recovery, input));
      if (repairDecision._tag === "Failure") {
        yield* commitFailed(
          boundaryEvents,
          {
            ...spec,
            runId: projection.runId,
            idempotencyKey: projection.request.idempotencyKey,
            terminalSchemaId: projection.request.terminalSchemaId,
          },
          projection.requestedEventId,
          repairDecision.failure,
        );
        const after = yield* eventsFor(ledger, spec.identity);
        return projectWorkspaceJob(after, projection.runId);
      }
      if (!repairDecision.success) {
        return projection;
      }

      activeSpec = {
        ...spec,
        runId: projection.runId,
        idempotencyKey: repairIdempotencyKey(spec.idempotencyKey, nextAttempt),
        attempt: nextAttempt,
        buildSubmitSpec: () => spec.recovery!.buildRepairSubmitSpec(input),
      };
    }
  });
