import { Clock, Data, Effect, ManagedRuntime, Schema } from "effect";
import { createInMemoryRuntimeBackend } from "@agent-os/backend-in-memory";
import {
  Ledger,
  MaterializedProjections,
  defineProjection,
  projectionIdentity,
  projectionMalformed,
  projectionPut,
} from "@agent-os/runtime";

export interface RunWorkflowState {
  readonly runId: string;
  readonly status: "requested" | "streaming" | "completed";
  readonly promptDigest: string;
  readonly firstFrameAt: number | null;
  readonly completedAt: number | null;
}

export interface RunWorkflowLoopResult {
  readonly runId: string;
  readonly firstFrameLatencyMs: number;
  readonly projectionLatencyMs: number;
  readonly frame: {
    readonly kind: "output";
    readonly channel: "assistant";
    readonly payload: string;
  };
  readonly state: RunWorkflowState;
}

export class RunWorkflowProjectionMissing extends Data.TaggedError(
  "vibe_like.run_workflow_projection_missing",
)<{
  readonly runId: string;
}> {}

const payload = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const digestPrompt = (prompt: string): string => `prompt:${prompt.length}:${prompt.slice(0, 8)}`;

export const runWorkflowProjection = defineProjection({
  kind: "run.workflow",
  version: 1,
  eventKinds: ["run.requested", "run.first_frame", "run.completed"],
  identity: Schema.Struct({ runId: Schema.String }),
  state: Schema.Struct({
    runId: Schema.String,
    status: Schema.Literal("requested", "streaming", "completed"),
    promptDigest: Schema.String,
    firstFrameAt: Schema.NullOr(Schema.Number),
    completedAt: Schema.NullOr(Schema.Number),
  }),
  identityKey: (identity) => identity.runId,
  identify: (event) => {
    const runId = payload(event.payload).runId;
    return typeof runId === "string"
      ? projectionIdentity({ runId })
      : projectionMalformed("runId is required");
  },
  initial: (identity, event): RunWorkflowState => ({
    runId: identity.runId,
    status: "requested",
    promptDigest:
      typeof payload(event.payload).promptDigest === "string"
        ? (payload(event.payload).promptDigest as string)
        : "prompt:unknown",
    firstFrameAt: null,
    completedAt: null,
  }),
  reduce: (state, event) => {
    if (event.kind === "run.first_frame") {
      return projectionPut({
        ...state,
        status: "streaming" as const,
        firstFrameAt: event.ts,
      });
    }
    if (event.kind === "run.completed") {
      return projectionPut({
        ...state,
        status: "completed" as const,
        completedAt: event.ts,
      });
    }
    return projectionPut(state);
  },
});

export const runFakeLocalLoop = (
  prompt: string,
  scope = "vibe-like-spike",
): Promise<RunWorkflowLoopResult> => {
  const backend = createInMemoryRuntimeBackend({
    scope,
    projections: [runWorkflowProjection],
  });
  const runtime = ManagedRuntime.make(backend.layer);
  const program = Effect.gen(function* () {
    const ledger = yield* Ledger;
    const projections = yield* MaterializedProjections;
    const runId = `run-${crypto.randomUUID()}`;
    const requestedAt = yield* Clock.currentTimeMillis;
    yield* ledger.log(
      "run.requested",
      {
        runId,
        promptDigest: digestPrompt(prompt),
      },
      scope,
    );

    const firstFrameAt = yield* Clock.currentTimeMillis;
    const frame = {
      kind: "output" as const,
      channel: "assistant" as const,
      payload: `thinking about ${prompt.slice(0, 32)}`,
    };
    yield* ledger.log("run.first_frame", { runId }, scope);
    yield* ledger.log("run.completed", { runId }, scope);

    const readStartedAt = yield* Clock.currentTimeMillis;
    const row = yield* projections.get({
      kind: runWorkflowProjection.kind,
      scope,
      identity: { runId },
    });
    const readCompletedAt = yield* Clock.currentTimeMillis;
    if (row === null) {
      return yield* new RunWorkflowProjectionMissing({ runId });
    }
    return {
      runId,
      firstFrameLatencyMs: firstFrameAt - requestedAt,
      projectionLatencyMs: readCompletedAt - readStartedAt,
      frame,
      state: row.state as RunWorkflowState,
    };
  });
  return runtime.runPromise(program).finally(() => runtime.dispose());
};
