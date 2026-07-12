import { Effect, Predicate } from "effect";
import { JsonStringifyError, safeStringify } from "@agent-os/core/errors";
import {
  textFromLlmOutputItems,
  toolCallsFromLlmOutputItems,
  type LlmMessage,
  type LlmToolCall,
} from "@agent-os/core/llm-protocol";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  decodeRuntimeLedgerEvent,
  replayToolFromArtifact,
  RUNTIME_EVENT_KIND,
  toolReplayArtifactFromExecutedPayload,
} from "@agent-os/core/runtime-protocol";
import {
  decodeToolArgs,
  resolveToolExecution,
  type ExecutionDomainDeclaration,
  type Tool,
} from "@agent-os/core/tools";
import type { InternalSubmitSpec } from "../internal-submit";
import { runtimeStorageError, type RuntimeStorageError } from "../ledger";

const toolArgumentSummaryEncoder = new TextEncoder();

export const MAX_PROVIDER_HISTORY_STRING_BYTES = 512;

export type ProviderHistoryValueCompaction = {
  readonly value: unknown;
  readonly didRedact: boolean;
};

export const compactProviderHistoryValue = (value: unknown): ProviderHistoryValueCompaction => {
  if (typeof value === "string") {
    const bytes = toolArgumentSummaryEncoder.encode(value).byteLength;
    if (bytes <= MAX_PROVIDER_HISTORY_STRING_BYTES) return { value, didRedact: false };
    return {
      value: `[agentOS redacted provider history string: ${bytes} bytes]`,
      didRedact: true,
    };
  }
  if (Array.isArray(value)) {
    let didRedact = false;
    const compacted = value.map((entry) => {
      const result = compactProviderHistoryValue(entry);
      didRedact = didRedact || result.didRedact;
      return result.value;
    });
    return { value: compacted, didRedact };
  }
  if (Predicate.isObject(value)) {
    let didRedact = false;
    const compacted = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const result = compactProviderHistoryValue(entry);
        didRedact = didRedact || result.didRedact;
        return [key, result.value];
      }),
    );
    return { value: compacted, didRedact };
  }
  return { value, didRedact: false };
};

export const providerHistoryArgumentsJson = (
  tool: Tool,
  toolName: string,
  args: unknown,
  originalArguments: string,
): Effect.Effect<
  { readonly argumentsJson: string; readonly didRedact: boolean },
  JsonStringifyError
> =>
  Effect.gen(function* () {
    const compacted = compactProviderHistoryValue(args);
    if (!compacted.didRedact) return { argumentsJson: originalArguments, didRedact: false };
    const decoded = yield* Effect.result(decodeToolArgs(tool, compacted.value, toolName));
    if (decoded._tag === "Failure") {
      return { argumentsJson: originalArguments, didRedact: false };
    }
    const argumentsJson = yield* safeStringify(compacted.value);
    return { argumentsJson, didRedact: true };
  });

export type ProviderHistoryCompaction = {
  readonly originalBytes: number;
  readonly compactedBytes: number;
};

export const compactProviderHistoryToolCall = (
  messages: LlmMessage[],
  toolCallId: string,
  argumentsJson: string,
  didRedact: boolean,
): ProviderHistoryCompaction | null => {
  if (!didRedact) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.tool_calls === undefined) continue;
    if (!message.tool_calls.some((call) => call.id === toolCallId)) continue;
    const existingCall = message.tool_calls.find((call) => call.id === toolCallId);
    const originalArguments = existingCall?.function.arguments;
    if (originalArguments === undefined) return null;
    const originalBytes = toolArgumentSummaryEncoder.encode(originalArguments).byteLength;
    const compactedBytes = toolArgumentSummaryEncoder.encode(argumentsJson).byteLength;
    messages[index] = {
      ...message,
      tool_calls: message.tool_calls.map((call) =>
        call.id === toolCallId
          ? {
              ...call,
              function: {
                ...call.function,
                arguments: argumentsJson,
              },
            }
          : call,
      ),
    };
    return { originalBytes, compactedBytes };
  }
  return null;
};

export const replayMessagesToInterruptedTool = (
  initialMessages: ReadonlyArray<LlmMessage>,
  events: ReadonlyArray<LedgerEvent>,
  resume: NonNullable<InternalSubmitSpec["resume"]>,
  interruptedToolCallId: string,
  executionDomains: ReadonlyArray<ExecutionDomainDeclaration>,
): Effect.Effect<
  {
    readonly messages: LlmMessage[];
    readonly call: LlmToolCall;
    readonly sourceEventId: number;
  },
  RuntimeStorageError | JsonStringifyError
> =>
  Effect.gen(function* () {
    const messages: LlmMessage[] = [...initialMessages];

    for (let index = 0; index <= resume.turn.index; index++) {
      const llmEvent = events.find((event) => {
        const decoded = decodeRuntimeLedgerEvent(event);
        return (
          decoded._tag === "runtime" &&
          decoded.event.kind === RUNTIME_EVENT_KIND.LLM_RESPONSE &&
          decoded.event.payload.turn.id === resume.runId &&
          decoded.event.payload.turn.index === index
        );
      });
      if (llmEvent === undefined) {
        return yield* Effect.fail(
          runtimeStorageError("submit", {
            reason: "resume_missing_llm_turn",
            runId: resume.runId,
            turnIndex: index,
          }),
        );
      }

      const decoded = decodeRuntimeLedgerEvent(llmEvent);
      if (decoded._tag !== "runtime" || decoded.event.kind !== RUNTIME_EVENT_KIND.LLM_RESPONSE) {
        return yield* Effect.fail(runtimeStorageError("submit", { reason: "resume_bad_llm_turn" }));
      }
      const responseText = textFromLlmOutputItems(decoded.event.payload.items);
      const responseToolCalls = toolCallsFromLlmOutputItems(decoded.event.payload.items);
      const continuationMarker = decoded.event.payload.continuation;
      if (continuationMarker !== undefined && continuationMarker.sealedRef === undefined) {
        return yield* Effect.fail(
          runtimeStorageError("submit", {
            reason: "provider_continuation_resume_unsupported",
            runId: resume.runId,
            turnIndex: index,
          }),
        );
      }
      messages.push({
        role: "assistant",
        content: responseText,
        tool_calls: responseToolCalls.length > 0 ? responseToolCalls : undefined,
        ...(continuationMarker === undefined
          ? {}
          : {
              continuation: {
                kind: "sealed" as const,
                binding: continuationMarker.binding,
                ref: continuationMarker.sealedRef as string,
              },
            }),
      });

      for (const call of responseToolCalls) {
        if (index === resume.turn.index && call.id === interruptedToolCallId) {
          return { messages, call, sourceEventId: llmEvent.id };
        }

        const toolEvent = events.find((event) => {
          const decodedTool = decodeRuntimeLedgerEvent(event);
          return (
            decodedTool._tag === "runtime" &&
            decodedTool.event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED &&
            decodedTool.event.payload.runId === resume.runId &&
            decodedTool.event.payload.toolCallId === call.id
          );
        });
        if (toolEvent === undefined) continue;
        const decodedTool = decodeRuntimeLedgerEvent(toolEvent);
        if (
          decodedTool._tag === "runtime" &&
          decodedTool.event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED
        ) {
          const resolvedExecution = resolveToolExecution(decodedTool.event.payload.execution, {
            domains: executionDomains,
          });
          if (!resolvedExecution.ok) {
            return yield* Effect.fail(
              runtimeStorageError("submit", {
                reason: "tool_execution_witness_resolution_failed",
                issues: resolvedExecution.issues,
                runId: resume.runId,
                toolCallId: call.id,
                toolName: call.function.name,
              }),
            );
          }
          const artifact = toolReplayArtifactFromExecutedPayload(
            decodedTool.event.payload,
            resolvedExecution.resolved,
          );
          if (!artifact.ok) {
            return yield* Effect.fail(
              runtimeStorageError("submit", {
                reason: artifact.reason,
                runId: resume.runId,
                toolCallId: call.id,
                toolName: call.function.name,
              }),
            );
          }
          const replayed = replayToolFromArtifact(artifact.artifact);
          const resultStr = yield* safeStringify(replayed.result);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: resultStr,
          });
        }
      }
    }

    return yield* Effect.fail(
      runtimeStorageError("submit", {
        reason: "resume_missing_interrupted_tool_call",
        runId: resume.runId,
        interruptId: resume.interruptId,
      }),
    );
  });

/** The single termination funnel. All recoverable aborts route through here.
 *  Logs an agent.aborted.* ledger event then constructs SubmitResult.fail. */
