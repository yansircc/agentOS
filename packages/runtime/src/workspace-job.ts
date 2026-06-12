import { Data, Effect } from "effect";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
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
import type { InternalSubmitSpec, SubmitResult } from "@agent-os/runtime-protocol";
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

export interface WorkspaceJobFinalizedArtifactBytes {
  readonly artifactRef: string;
  readonly path: string;
  readonly schemaId: string;
  readonly bytes: string | Uint8Array;
}

export interface WorkspaceJobFinalizedArtifact {
  readonly artifact: WorkspaceJobTerminalArtifact;
  readonly bytes: Uint8Array;
}

export interface WorkspaceJobDataPlane {
  readonly writeSeedFile: (file: WorkspaceJobSeedFile) => Promise<void>;
  readonly finalize: (input: {
    readonly runId: string;
    readonly candidatePath: string;
    readonly terminalSchemaId: string;
    readonly submitResult: SubmitResult;
  }) => Promise<WorkspaceJobFinalizedArtifactBytes>;
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
  }) => InternalSubmitSpec;
  readonly seedFiles?: ReadonlyArray<WorkspaceJobSeedFile>;
  readonly workspaceRef?: string;
  readonly inputRef?: string;
  readonly inputHash?: string;
}

export class WorkspaceJobDataPlaneFailed extends Data.TaggedError(
  "agent_os.workspace_job_data_plane_failed",
)<{
  readonly phase: "seed" | "finalize" | "cleanup";
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

const effectMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const submitFailure = (reason: string): WorkspaceJobFailure => ({
  phase: "submit",
  class:
    reason === "budget_time"
      ? "timeout"
      : reason === "interrupted"
        ? "cancelled"
        : "provider",
  code: `workspace_job.submit.${reason}`,
  message: reason,
  retryable: reason !== "interrupted",
});

const failureFromDataPlane = (
  failure: WorkspaceJobDataPlaneFailed,
): WorkspaceJobFailure => {
  const cause = failure.cause;
  if (cause instanceof WorkspaceJobCandidateMissing) {
    return {
      phase: "collect_candidate",
      class: "consumer_contract",
      code: "workspace_job.candidate_missing",
      message: `missing candidate: ${cause.candidatePath}`,
    };
  }
  if (cause instanceof WorkspaceJobRunIdMismatch) {
    return {
      phase: "finalize",
      class: "consumer_contract",
      code: "workspace_job.run_id_mismatch",
      message: `runId mismatch: expected ${cause.expectedRunId}, got ${cause.actualRunId}`,
    };
  }
  if (failure.phase === "seed") {
    return {
      phase: "seed",
      class: "provider",
      code: "workspace_job.seed_write_failed",
      message: effectMessage(cause),
      retryable: true,
    };
  }
  return {
    phase: "data_plane",
    class: "provider",
    code: "workspace_job.data_plane_finalize_failed",
    message: effectMessage(cause),
    retryable: true,
  };
};

const verifierInfraFailure = (cause: unknown): WorkspaceJobFailure => ({
  phase: "verify_infra",
  class: "provider",
  code: "workspace_job.verifier_failed",
  message: effectMessage(cause),
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
): Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError> => {
  const requestClaim = makePreClaim({
    operationRef: `workspace_job:${spec.runId}`,
    scopeRef: spec.identity.scopeRef,
    effectAuthorityRef: spec.identity.effectAuthorityRef,
    originRef: { originId: spec.idempotencyKey, originKind: "workspace_job" },
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
    const finalized = yield* Effect.tryPromise({
      try: () =>
        spec.dataPlane.finalize({
          runId: spec.runId,
          candidatePath: spec.candidatePath,
          terminalSchemaId: spec.terminalSchemaId,
          submitResult,
        }),
      catch: (cause) => new WorkspaceJobDataPlaneFailed({ phase: "finalize", cause }),
    });
    const bytes = bytesOf(finalized.bytes);
    const hash = yield* sha256Hex(bytes);
    return {
      bytes,
      artifact: {
        artifactRef: finalized.artifactRef,
        path: finalized.path,
        schemaId: finalized.schemaId,
        sha256: `sha256:${hash}`,
        bytes: bytes.byteLength,
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

    const claim = makePreClaim({
      operationRef: `workspace_job:${spec.runId}`,
      scopeRef: spec.identity.scopeRef,
      effectAuthorityRef: spec.identity.effectAuthorityRef,
      originRef: { originId: spec.idempotencyKey, originKind: "workspace_job" },
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
    const failAndProject = (failure: WorkspaceJobFailure) =>
      Effect.gen(function* () {
        yield* commitFailed(boundaryEvents, spec, requestedEventId, failure);
        yield* cleanup(spec);
        const after = yield* eventsFor(ledger, spec.identity);
        return currentProjection(after, spec.runId);
      });

    const seeded = yield* Effect.either(writeSeedFiles(spec.dataPlane, spec.seedFiles ?? []));
    if (seeded._tag === "Left") {
      return yield* failAndProject(failureFromDataPlane(seeded.left));
    }

    const submitResult = yield* submitAgentEffect(
      spec.buildSubmitSpec({
        runId: spec.runId,
        candidatePath: spec.candidatePath,
      }),
    );
    if (!submitResult.ok) {
      return yield* failAndProject(submitFailure(submitResult.reason));
    }

    const finalized = yield* Effect.either(finalizeArtifact(spec, submitResult));
    if (finalized._tag === "Left") {
      return yield* failAndProject(failureFromDataPlane(finalized.left));
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
      return yield* failAndProject(verifierInfraFailure(verdict.left.cause));
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
