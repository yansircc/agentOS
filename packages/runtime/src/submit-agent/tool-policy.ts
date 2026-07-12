import type { LlmRoute, LlmToolChoice } from "@agent-os/core/llm-protocol";
import type { LedgerEvent } from "@agent-os/core/types";
import type { ToolDefinition } from "@agent-os/core/tools";
import { decodeRuntimeLedgerEvent, RUNTIME_EVENT_KIND } from "@agent-os/core/runtime-protocol";
import type { InternalSubmitSpec } from "../internal-submit";
import type { Tool } from "@agent-os/core/tools";

export const toolDefinitionsOf = (tools: Record<string, Tool>): ReadonlyArray<ToolDefinition> =>
  Object.values(tools).map((t) => t.definition);

export const toolDefinitionsForRuntimePolicy = (
  tools: Record<string, Tool>,
  requiredToolNames: ReadonlyArray<string>,
  executedToolNames: ReadonlySet<string>,
): ReadonlyArray<ToolDefinition> => {
  if (requiredToolNames.length === 0) return toolDefinitionsOf(tools);
  const policyTools = new Set(requiredToolNames);
  return Object.entries(tools)
    .filter(([toolName]) => !policyTools.has(toolName) || !executedToolNames.has(toolName))
    .map(([, tool]) => tool.definition);
};

export const singleRequiredToolPolicyName = (spec: InternalSubmitSpec): string | null => {
  const toolName = spec.toolPolicy?.requiredUntilToolExecuted?.toolName;
  return typeof toolName === "string" && toolName.length > 0 ? toolName : null;
};

export const completeAfterToolPolicyNames = (spec: InternalSubmitSpec): ReadonlyArray<string> => {
  const toolNames = spec.toolPolicy?.completeAfterToolsExecuted?.toolNames ?? [];
  return [...new Set(toolNames.filter((toolName) => toolName.length > 0))];
};

export const completeAfterToolsRequireInvocation = (spec: InternalSubmitSpec): boolean =>
  spec.toolPolicy?.completeAfterToolsExecuted?.invocation === "required";

export const routeModelId = (route: LlmRoute): string | undefined =>
  typeof route.modelId === "string" && route.modelId.length > 0 ? route.modelId : undefined;

export const requiredToolPolicyNames = (spec: InternalSubmitSpec): ReadonlyArray<string> => [
  ...new Set(
    [
      singleRequiredToolPolicyName(spec),
      ...(completeAfterToolsRequireInvocation(spec) ? completeAfterToolPolicyNames(spec) : []),
    ].filter((toolName): toolName is string => toolName !== null),
  ),
];

export const hasExecutedTool = (
  events: ReadonlyArray<LedgerEvent>,
  runId: number,
  toolName: string,
): boolean =>
  events.some((event) => {
    const decoded = decodeRuntimeLedgerEvent(event);
    return (
      decoded._tag === "runtime" &&
      decoded.event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED &&
      decoded.event.payload.runId === runId &&
      decoded.event.payload.name === toolName
    );
  });

export const safeToolChoiceSummary = (
  toolChoice: LlmToolChoice | undefined,
): string | undefined => {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  const functionName = toolChoice.function.name;
  return functionName.length > 0 ? `function:${functionName}` : "function";
};

export const toolChoiceForRuntimePolicy = (input: {
  readonly requiredToolNames: ReadonlyArray<string>;
  readonly executedToolNames: ReadonlySet<string>;
  readonly ordered: boolean;
}): LlmToolChoice | undefined => {
  const missing = input.requiredToolNames.filter(
    (toolName) => !input.executedToolNames.has(toolName),
  );
  if (missing.length === 0) return undefined;
  const hasExecutedPolicyTool = input.requiredToolNames.some((toolName) =>
    input.executedToolNames.has(toolName),
  );
  if (!hasExecutedPolicyTool) return "required";
  if (input.ordered || missing.length === 1) {
    return { type: "function", function: { name: missing[0] as string } };
  }
  return "required";
};

export const remainingRequiredToolNames = (
  requiredToolNames: ReadonlyArray<string>,
  executedToolNames: ReadonlySet<string>,
): ReadonlyArray<string> =>
  requiredToolNames.filter((toolName) => !executedToolNames.has(toolName));

export const allPolicyToolsExecuted = (
  toolNames: ReadonlyArray<string>,
  executedToolNames: ReadonlySet<string>,
): boolean =>
  toolNames.length > 0 && toolNames.every((toolName) => executedToolNames.has(toolName));

export const policyToolViolationReason = (input: {
  readonly toolName: string;
  readonly requiredToolNames: ReadonlyArray<string>;
  readonly executedToolNames: ReadonlySet<string>;
  readonly ordered: boolean;
}): "policy_tool_already_executed" | "policy_tool_out_of_order" | null => {
  if (!input.requiredToolNames.includes(input.toolName)) return null;
  if (input.executedToolNames.has(input.toolName)) return "policy_tool_already_executed";
  if (!input.ordered) return null;
  const expectedToolName = remainingRequiredToolNames(
    input.requiredToolNames,
    input.executedToolNames,
  )[0];
  return expectedToolName !== undefined && input.toolName !== expectedToolName
    ? "policy_tool_out_of_order"
    : null;
};
