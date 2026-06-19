import { Context, Data, Effect, Predicate } from "effect";
import {
  isIndeterminateRef,
  type IndeterminateRef,
  type OperationRef,
} from "@agent-os/kernel/effect-claim";

export interface WitnessRequest {
  readonly operationRef: OperationRef;
  readonly carrierRef?: string;
}

export type WitnessPortIssue = "request_invalid" | "resolver_failed" | "indeterminate_ref_invalid";

export class WitnessPortRejected extends Data.TaggedError("agent_os.witness_port_rejected")<{
  readonly issue: WitnessPortIssue;
}> {}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isWitnessRequest = (value: unknown): value is WitnessRequest =>
  Predicate.isObject(value) &&
  isNonEmptyString(value.operationRef) &&
  (value.carrierRef === undefined || isNonEmptyString(value.carrierRef));

const reject = (issue: WitnessPortIssue): WitnessPortRejected => new WitnessPortRejected({ issue });

export interface WitnessPortService {
  readonly witness: (
    request: WitnessRequest,
  ) => Effect.Effect<IndeterminateRef, WitnessPortRejected>;
}

export const makeWitnessPort = (
  resolve: (request: WitnessRequest) => Effect.Effect<unknown, unknown>,
): WitnessPortService => ({
  witness: (request) =>
    Effect.gen(function* () {
      if (!isWitnessRequest(request)) {
        return yield* Effect.fail(reject("request_invalid"));
      }
      const indeterminateRef = yield* resolve(request).pipe(
        Effect.mapError(() => reject("resolver_failed")),
      );
      if (!isIndeterminateRef(indeterminateRef)) {
        return yield* Effect.fail(reject("indeterminate_ref_invalid"));
      }
      return indeterminateRef;
    }),
});

/**
 * Provider/reconciler witness acquisition port.
 *
 * This service returns only symbolic indeterminate settlement input. It does
 * not mint Recordable claims and does not append ledger facts; callers must
 * pass the returned ref through the package SettlementContract and
 * BoundaryEvents commit path.
 *
 * @public
 */
export class WitnessPort extends Context.Service<WitnessPort, WitnessPortService>()(
  "@agent-os/WitnessPort",
) {}
