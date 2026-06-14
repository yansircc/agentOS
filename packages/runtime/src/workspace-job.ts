import { Data, Effect } from "effect";
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
  type WorkspaceJobFailure,
  type WorkspaceJobProjection,
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
  readonly buildSubmitSpec: (input: {
    readonly runId: string;
    readonly candidatePath: string;
  }) => SubmitSpec;
  readonly terminalArtifactPath: string;
  readonly seedFiles?: ReadonlyArray<WorkspaceJobSeedFile>;
  readonly workspaceRef?: string;
  readonly inputRef?: string;
  readonly inputHash?: string;
}

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
      }),
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

/**
 * Runs a protected workspace job from product declarations to a carrier-owned
 * terminal projection. The verifier receives finalized artifact bytes; candidate
 * bytes are never the verification subject.
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
    const before = yield* eventsFor(ledger, spec.identity);
    const existing = projectWorkspaceJobByIdempotencyKey(before, spec.idempotencyKey);
    let activeSpec = spec;
    let requestedEventId: number;
    let claim;

    if (existing.status === "found") {
      activeSpec = {
        ...spec,
        runId: existing.runId,
        idempotencyKey: existing.idempotencyKey,
        terminalSchemaId: existing.request.terminalSchemaId,
      };
      const projection = currentProjection(before, existing.runId);
      if (projection.status !== "running") {
        return projection;
      }
      requestedEventId = existing.requestedEventId;
      claim = existing.request.claim;
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
      const seeded = yield* Effect.either(
        writeSeedFiles(activeSpec.dataPlane, activeSpec.seedFiles ?? []),
      );
      if (seeded._tag === "Left") {
        return yield* failAndProject(failureFromDataPlane(seeded.left));
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
      const read = yield* Effect.either(
        readFinalizedArtifact(activeSpec, {
          path: steps.artifactReadbackVerified.path,
          artifactRef: steps.artifactReadbackVerified.artifactRef,
          schemaId: steps.artifactReadbackVerified.schemaId,
          bytes: steps.artifactReadbackVerified.bytes,
          sha256: steps.artifactReadbackVerified.sha256,
          submitRunId: steps.artifactReadbackVerified.submitRunId,
        }),
      );
      if (read._tag === "Left") {
        return yield* failAndProject(
          failureFromDataPlane(read.left),
          steps.artifactReadbackVerified.submitRunId,
        );
      }
      finalized = read.right;
    } else if (steps.artifactWritten !== undefined) {
      const read = yield* Effect.either(
        readFinalizedArtifact(activeSpec, {
          path: steps.artifactWritten.path,
          artifactRef: steps.artifactWritten.artifactRef,
          schemaId: steps.artifactWritten.schemaId,
          bytes: steps.artifactWritten.bytes,
          sha256: steps.artifactWritten.sha256,
          submitRunId: steps.artifactWritten.submitRunId,
        }),
      );
      if (read._tag === "Left") {
        return yield* failAndProject(
          failureFromDataPlane(read.left),
          steps.artifactWritten.submitRunId,
        );
      }
      finalized = read.right;
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
        const publicSubmitSpec = activeSpec.buildSubmitSpec({
          runId: activeSpec.runId,
          candidatePath: activeSpec.candidatePath,
        });
        const submitSpec = internalSubmitSpec(publicSubmitSpec, {
          scope: activeSpec.scope,
          scopeRef: activeSpec.identity.scopeRef,
        });
        submitResult = yield* submitAgentEffect(submitSpec);
      }
      if (!submitResult.ok) {
        return yield* failAndProject(submitFailure(submitResult.reason), submitResult.runId);
      }

      const built = yield* Effect.either(buildTerminalArtifact(activeSpec, submitResult));
      if (built._tag === "Left") {
        return yield* failAndProject(failureFromDataPlane(built.left), submitResult.runId);
      }
      yield* commitTerminalBuildAttempted(
        boundaryEvents,
        activeSpec,
        requestedEventId,
        submitResult.runId,
        built.right,
      );
      const written = yield* Effect.either(
        writeBuiltArtifact(activeSpec, submitResult, built.right),
      );
      if (written._tag === "Left") {
        return yield* failAndProject(failureFromDataPlane(written.left), submitResult.runId);
      }
      yield* commitArtifactWritten(boundaryEvents, activeSpec, requestedEventId, written.right);
      const read = yield* Effect.either(readFinalizedArtifact(activeSpec, written.right));
      if (read._tag === "Left") {
        return yield* failAndProject(failureFromDataPlane(read.left), submitResult.runId);
      }
      finalized = read.right;
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

    const verdict = yield* Effect.either(verifyArtifact(activeSpec, finalized, submitResult));
    if (verdict._tag === "Left") {
      return yield* failAndProject(verifierInfraFailure(verdict.left.cause), submitResult.runId);
    }

    if (verdict.right.ok) {
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
          checks: verdict.right.checks,
          ...(verdict.right.summary === undefined ? {} : { summary: verdict.right.summary }),
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
          checks: verdict.right.checks,
          summary: verdict.right.reason,
          claim: rejectedClaim,
        }),
      );
    }

    const after = yield* eventsFor(ledger, activeSpec.identity);
    return currentProjection(after, activeSpec.runId);
  });
