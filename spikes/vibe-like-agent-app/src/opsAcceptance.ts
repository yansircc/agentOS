import { Effect, ManagedRuntime } from "effect";
import { createInMemoryRuntimeBackend } from "@agent-os/backend-in-memory";
import { Ledger, MaterializedProjections } from "@agent-os/runtime";
import { deployAppProjection } from "./deployPath";
import { productTools } from "./productTools";
import { runWorkflowProjection } from "./runWorkflow";
import { tenantConfigProjections } from "./tenantConfig";
import { workspaceProjections } from "./workspaceState";

export const allSpikeProjections = [
  runWorkflowProjection,
  ...workspaceProjections,
  ...tenantConfigProjections,
  deployAppProjection,
];

export interface AcceptanceMetrics {
  readonly firstStreamFrameP95Ms: number;
  readonly workspaceMutationToProjectionP95Ms: number;
  readonly cancelToAbortP95Ms: number;
  readonly projectionRebuild1kEventsMs: number;
  readonly attachedStreamDetachDoReleaseMs: number;
}

export const acceptanceThresholds: AcceptanceMetrics = {
  firstStreamFrameP95Ms: 2_000,
  workspaceMutationToProjectionP95Ms: 500,
  cancelToAbortP95Ms: 1_000,
  projectionRebuild1kEventsMs: 2_000,
  attachedStreamDetachDoReleaseMs: 30_000,
};

export const evaluateAcceptanceMetrics = (
  metrics: AcceptanceMetrics,
): { readonly ok: true } | { readonly ok: false; readonly failures: ReadonlyArray<string> } => {
  const failures = Object.entries(metrics)
    .filter(([key, value]) => value > acceptanceThresholds[key as keyof AcceptanceMetrics])
    .map(([key]) => key);
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
};

export const runOpsLoop = (scope = "vibe-like-ops") => {
  const backend = createInMemoryRuntimeBackend({ scope, projections: allSpikeProjections });
  const runtime = ManagedRuntime.make(backend.layer);

  const program = Effect.gen(function* () {
    const ledger = yield* Ledger;
    const projections = yield* MaterializedProjections;
    yield* ledger.log("run.requested", { runId: "ops-run", promptDigest: "prompt:ops" }, scope);
    const status = yield* projections.status({ kind: "run.workflow", scope });
    const rebuilt = yield* projections.rebuild({ kind: "run.workflow", scope });
    return {
      projectionKinds: allSpikeProjections.map((projection) => projection.kind),
      runStatus: status,
      rebuilt,
      stuckTriggers: 0,
      activeStreams: 0,
      toolCount: productTools.length,
    };
  });

  return runtime.runPromise(program).finally(() => runtime.dispose());
};
