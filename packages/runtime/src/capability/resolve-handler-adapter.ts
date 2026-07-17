import { Result } from "effect";
import { CapabilityRejected } from "@agent-os/core/errors";
import type { EventHandler } from "@agent-os/core/types";
import {
  RUNTIME_DIAGNOSTIC_FACT_OWNER,
  RUNTIME_DIAGNOSTIC_KIND,
} from "../runtime-diagnostic-carrier";
import type { CapabilityEventHandlerContext, CapabilityInstallation } from "./contract";

export interface ResolvedHandlerFactory {
  readonly capabilityId: string;
  readonly register: NonNullable<CapabilityInstallation["eventHandlers"]>;
}

const promiseResult = <Value>(
  evaluate: () => Value | Promise<Value>,
): Promise<Result.Result<Value, unknown>> =>
  new Promise<Value>((resolve) => resolve(evaluate())).then(
    (value) => Result.succeed(value),
    (cause) => Result.fail(cause),
  );

export const createResolvedCapabilityEventHandlers = (
  factories: ReadonlyArray<ResolvedHandlerFactory>,
  context: CapabilityEventHandlerContext,
  describeCause: (cause: unknown) => string,
): ReadonlyArray<{ readonly kind: string; readonly handler: EventHandler }> =>
  factories.flatMap(({ capabilityId, register }) =>
    Array.from(register(context)).map((registration) => ({
      kind: registration.kind,
      handler: async (event) => {
        const handlerResult = await promiseResult(() => registration.handler(event));
        if (Result.isSuccess(handlerResult)) return;
        const runtimeDiagnostic = context.capabilities.get(RUNTIME_DIAGNOSTIC_FACT_OWNER);
        if (runtimeDiagnostic === undefined) {
          throw new CapabilityRejected({
            event: RUNTIME_DIAGNOSTIC_KIND.HANDLER_FAILED,
            capability: `extension:${RUNTIME_DIAGNOSTIC_FACT_OWNER}`,
          });
        }
        await runtimeDiagnostic.commit({
          event: RUNTIME_DIAGNOSTIC_KIND.HANDLER_FAILED,
          data: {
            capabilityId,
            handler: registration.kind,
            reason: describeCause(handlerResult.failure),
            requestedEventId: event.id,
          },
        });
      },
    })),
  );
