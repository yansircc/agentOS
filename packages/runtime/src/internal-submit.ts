import type { ScopeRef } from "@agent-os/kernel/effect-claim";
import type { SubmitSpec } from "@agent-os/runtime-protocol";

declare const internalSubmitSpecBrand: unique symbol;

export interface InternalSubmitSpec extends SubmitSpec {
  readonly scope: string;
  readonly scopeRef: ScopeRef;
  readonly [internalSubmitSpecBrand]: true;
}

const internalSubmitBudget = (
  budget: SubmitSpec["budget"] | undefined,
): SubmitSpec["budget"] | undefined => {
  if (budget === undefined) return undefined;
  const sealed: NonNullable<SubmitSpec["budget"]> = {
    ...(budget.tokens === undefined ? {} : { tokens: budget.tokens }),
    ...(budget.timeMs === undefined ? {} : { timeMs: budget.timeMs }),
    ...(budget.llmCallTimeoutMs === undefined ? {} : { llmCallTimeoutMs: budget.llmCallTimeoutMs }),
    ...(budget.maxTurns === undefined ? {} : { maxTurns: budget.maxTurns }),
    ...(budget.toolRetryPolicy === undefined ? {} : { toolRetryPolicy: budget.toolRetryPolicy }),
  };
  return Object.keys(sealed).length === 0 ? undefined : sealed;
};

export const internalSubmitSpec = (
  spec: SubmitSpec,
  scope: { readonly scope: string; readonly scopeRef: ScopeRef },
): InternalSubmitSpec =>
  ({
    intent: spec.intent,
    context: spec.context,
    system: spec.system,
    route: spec.route,
    tools: spec.tools,
    executionDomains: spec.executionDomains,
    budget: internalSubmitBudget(spec.budget),
    outputSchema: spec.outputSchema,
    traceContext: spec.traceContext,
    effectAuthorityRef: spec.effectAuthorityRef,
    materials: spec.materials,
    toolContext: spec.toolContext,
    toolIntents: spec.toolIntents,
    receiptBackedTools: spec.receiptBackedTools,
    toolPolicy: spec.toolPolicy,
    decisionInterrupts: spec.decisionInterrupts,
    resume: spec.resume,
    scope: scope.scope,
    scopeRef: scope.scopeRef,
  }) as InternalSubmitSpec;
