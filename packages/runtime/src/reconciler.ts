import type { Effect } from "effect";

export interface ReconcilerRepairContext {
  readonly emit: (event: string, data: unknown) => Effect.Effect<void, unknown, never>;
}

export interface StatelessReconciler<
  Detected,
  DetectError = never,
  RepairError = never,
  R = never,
> {
  readonly id: string;
  readonly detect: () => Effect.Effect<ReadonlyArray<Detected>, DetectError, R>;
  readonly repair: (
    detected: Detected,
    context: ReconcilerRepairContext,
  ) => Effect.Effect<void, RepairError, R>;
}

export const defineStatelessReconciler = <
  Detected,
  DetectError = never,
  RepairError = never,
  R = never,
>(
  spec: StatelessReconciler<Detected, DetectError, RepairError, R>,
): StatelessReconciler<Detected, DetectError, RepairError, R> => spec;
