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
import type { InternalSubmitSpec, SubmitResult, SubmitSpec } from "@agent-os/runtime-protocol";
import type { LedgerTruthIdentity } from "@agent-os/runtime-protocol";
import {
  WORKSPACE_JOB_KIND,
  projectWorkspaceJob,
  projectWorkspaceJobByIdempotencyKey,
  rejectWorkspaceJobByVerifier,
  rejectWorkspaceJobFailed,
  settleWorkspaceJobTerminalFinalized,
  settleWorkspaceJobVerified,
  workspaceJobBoundaryContract,
  workspaceJobFailedPayload,
  workspaceJobFailureCode,
  workspaceJobPreClaim,
  workspaceJobRequestedPayload,
  workspaceJobTerminalFinalizedPayload,
  workspaceJobVerifierRejectedPayload,
  workspaceJobVerifiedPayload,
  type WorkspaceJobFailure,
  type WorkspaceJobProjection,
  type WorkspaceJobTerminalArtifact,
  type WorkspaceJobVerificationCheck,
} from "@agent-os/workspace-job";

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
  readonly cleanup?: (input: { readonly runId: string }) => Promise<void>;
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
  readonly phase: "seed" | "terminal_build" | "terminal_write" | "terminal_read" | "cleanup";
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

const finalizeArtifact = (
  spec: RunWorkspaceJobSpec,
  submitResult: SubmitResult,
): Effect.Effect<WorkspaceJobFinalizedArtifact, WorkspaceJobDataPlaneFailed> =>
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
    const written = yield* Effect.tryPromise({
      try: () =>
        spec.dataPlane.writeTerminalArtifact({
          runId: spec.runId,
          path: spec.terminalArtifactPath,
          schemaId: built.schemaId,
          bytes: builtBytes,
        }),
      catch: (cause) => new WorkspaceJobDataPlaneFailed({ phase: "terminal_write", cause }),
    });
    const readback = yield* Effect.tryPromise({
      try: () =>
        spec.dataPlane.readTerminalArtifact({
          runId: spec.runId,
          path: spec.terminalArtifactPath,
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
        path: spec.terminalArtifactPath,
        schemaId: built.schemaId,
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

const cleanup = (spec: RunWorkspaceJobSpec): Effect.Effect<void> => {
  if (spec.dataPlane.cleanup === undefined) return Effect.void;
  return Effect.promise(() => spec.dataPlane.cleanup!({ runId: spec.runId })).pipe(
    Effect.catchAll(() => Effect.void),
  );
};

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
    if (existing.status === "found") {
      return currentProjection(before, existing.runId);
    }

    const claim = workspaceJobPreClaim({
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      scopeRef: spec.identity.scopeRef,
      effectAuthorityRef: spec.identity.effectAuthorityRef,
    });
    const requested = yield* commitWorkspaceJob(
      boundaryEvents,
      WORKSPACE_JOB_KIND.REQUESTED,
      workspaceJobRequestedPayload({
        runId: spec.runId,
        idempotencyKey: spec.idempotencyKey,
        requestedBy: spec.requestedBy,
        terminalSchemaId: spec.terminalSchemaId,
        claim,
        ...(spec.workspaceRef === undefined ? {} : { workspaceRef: spec.workspaceRef }),
        ...(spec.inputRef === undefined ? {} : { inputRef: spec.inputRef }),
        ...(spec.inputHash === undefined ? {} : { inputHash: spec.inputHash }),
      }),
    );

    const requestedEventId = requested.id;
    const failAndProject = (failure: WorkspaceJobFailure, submitRunId?: number) =>
      Effect.gen(function* () {
        yield* commitFailed(boundaryEvents, spec, requestedEventId, failure, submitRunId);
        yield* cleanup(spec);
        const after = yield* eventsFor(ledger, spec.identity);
        return currentProjection(after, spec.runId);
      });

    const seeded = yield* Effect.either(writeSeedFiles(spec.dataPlane, spec.seedFiles ?? []));
    if (seeded._tag === "Left") {
      return yield* failAndProject(failureFromDataPlane(seeded.left));
    }

    const publicSubmitSpec = spec.buildSubmitSpec({
      runId: spec.runId,
      candidatePath: spec.candidatePath,
    });
    const submitSpec: InternalSubmitSpec = {
      ...publicSubmitSpec,
      scope: spec.scope,
      scopeRef: spec.identity.scopeRef,
    };
    const submitResult = yield* submitAgentEffect(submitSpec);
    if (!submitResult.ok) {
      return yield* failAndProject(submitFailure(submitResult.reason), submitResult.runId);
    }

    const finalized = yield* Effect.either(finalizeArtifact(spec, submitResult));
    if (finalized._tag === "Left") {
      return yield* failAndProject(failureFromDataPlane(finalized.left), submitResult.runId);
    }

    const finalizedClaim = settleWorkspaceJobTerminalFinalized(claim, {
      runId: spec.runId,
      requestedEventId,
      artifactRef: finalized.right.artifact.artifactRef,
    });
    const finalizedEvent = yield* commitWorkspaceJob(
      boundaryEvents,
      WORKSPACE_JOB_KIND.TERMINAL_FINALIZED,
      workspaceJobTerminalFinalizedPayload({
        requestedEventId,
        runId: spec.runId,
        idempotencyKey: spec.idempotencyKey,
        terminalArtifact: finalized.right.artifact,
        claim: finalizedClaim,
      }),
    );

    const verdict = yield* Effect.either(verifyArtifact(spec, finalized.right, submitResult));
    if (verdict._tag === "Left") {
      return yield* failAndProject(verifierInfraFailure(verdict.left.cause), submitResult.runId);
    }

    if (verdict.right.ok) {
      const verifiedClaim = settleWorkspaceJobVerified(claim, {
        runId: spec.runId,
        requestedEventId,
        terminalFinalizedEventId: finalizedEvent.id,
      });
      yield* commitWorkspaceJob(
        boundaryEvents,
        WORKSPACE_JOB_KIND.VERIFIED,
        workspaceJobVerifiedPayload({
          requestedEventId,
          terminalFinalizedEventId: finalizedEvent.id,
          runId: spec.runId,
          idempotencyKey: spec.idempotencyKey,
          checks: verdict.right.checks,
          ...(verdict.right.summary === undefined ? {} : { summary: verdict.right.summary }),
          claim: verifiedClaim,
        }),
      );
    } else {
      const rejectedClaim = rejectWorkspaceJobByVerifier(claim, {
        runId: spec.runId,
        requestedEventId,
        terminalFinalizedEventId: finalizedEvent.id,
      });
      yield* commitWorkspaceJob(
        boundaryEvents,
        WORKSPACE_JOB_KIND.VERIFIER_REJECTED,
        workspaceJobVerifierRejectedPayload({
          requestedEventId,
          terminalFinalizedEventId: finalizedEvent.id,
          runId: spec.runId,
          idempotencyKey: spec.idempotencyKey,
          checks: verdict.right.checks,
          summary: verdict.right.reason,
          claim: rejectedClaim,
        }),
      );
    }

    yield* cleanup(spec);
    const after = yield* eventsFor(ledger, spec.identity);
    return currentProjection(after, spec.runId);
  });
