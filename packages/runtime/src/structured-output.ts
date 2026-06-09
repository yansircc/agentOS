import { Effect } from "effect";
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  toolCallsFromLlmOutputItems,
  type LlmOutputItem,
  type LlmRequest,
  type LlmRoute,
  type LlmUsage,
} from "@agent-os/llm-protocol";
import type { AgentSchemaSpec } from "@agent-os/kernel/agent-schema";
import type { TraceContext } from "@agent-os/telemetry-protocol";
import {
  ProviderHttpFailure,
  ProviderOutputDecodeError,
  UpstreamFailure,
} from "@agent-os/kernel/errors";
import type { RefResolutionFailed } from "@agent-os/kernel/ref-resolver";
import type { Outcome } from "./admission-lease";
import type { Stimulus } from "./admission";

export type StructuredDecodeResult<O = Record<string, unknown>> =
  | {
      readonly ok: true;
      readonly decoded: O;
      readonly tokensUsed: number;
    }
  | {
      readonly ok: false;
      readonly outcome: Outcome;
    };

const behaviorFailed = (sampleDigest: string): StructuredDecodeResult<never> => ({
  ok: false,
  outcome: { class: "BehaviorFailed", sampleDigest },
});

const STRUCTURED_OUTPUT_SYSTEM_PROMPT =
  "Return strictly structured output by calling the submit tool. Do not respond in free text.";

export const structuredOutputRequest = (spec: {
  readonly route: LlmRoute;
  readonly schemaSpec: AgentSchemaSpec;
  readonly stimulus: Stimulus;
  readonly traceContext?: TraceContext;
}): LlmRequest => {
  const userText =
    spec.stimulus.kind === "live"
      ? spec.stimulus.userInput.userText
      : String(spec.stimulus.synthetic.synthetic);
  return {
    route: spec.route,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
    messages: [
      { role: "system", content: STRUCTURED_OUTPUT_SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: STRUCTURED_OUTPUT_TOOL_NAME,
          description: "Submit the structured result. Args ARE the result.",
          parameters: spec.schemaSpec.agentSchema,
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: STRUCTURED_OUTPUT_TOOL_NAME },
    },
  };
};

const decodeToolArguments = (args: string): Effect.Effect<StructuredDecodeResult<unknown>> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.either(
      Effect.try({
        try: () => JSON.parse(args) as unknown,
        catch: (error) => String(error).slice(0, 40),
      }),
    );
    return parsed._tag === "Right"
      ? { ok: true, decoded: parsed.right, tokensUsed: 0 }
      : behaviorFailed(`args-parse-failed:${parsed.left}`);
  });

export const decodeStructuredOutputFromItems = <O = Record<string, unknown>>(spec: {
  readonly items: ReadonlyArray<LlmOutputItem>;
  readonly usage: LlmUsage;
  readonly schemaSpec: AgentSchemaSpec;
  readonly toolName?: string;
}): Effect.Effect<StructuredDecodeResult<O>> =>
  Effect.gen(function* () {
    const toolName = spec.toolName ?? STRUCTURED_OUTPUT_TOOL_NAME;
    const toolCalls = toolCallsFromLlmOutputItems(spec.items);

    if (toolCalls.length !== 1 || toolCalls[0]?.function.name !== toolName) {
      return behaviorFailed(
        toolCalls.length === 0
          ? "no-tool-call"
          : `unexpected-tool-calls:${toolCalls.length}:${toolCalls[0]?.function.name ?? "?"}`,
      );
    }

    const parsed = yield* decodeToolArguments(toolCalls[0].function.arguments);
    if (!parsed.ok) return parsed;

    const decoded = yield* Effect.either(
      Effect.try({
        try: () => spec.schemaSpec.agentSchema.decode(parsed.decoded) as O,
        catch: (error) => (error instanceof Error ? error.name : typeof error),
      }),
    );
    if (decoded._tag === "Left") {
      return behaviorFailed(`decode-failed:${decoded.left}`);
    }

    return {
      ok: true,
      decoded: decoded.right,
      tokensUsed: spec.usage.totalTokens,
    };
  });

export type StructuredCallFailureClassification =
  | { readonly kind: "record_evidence"; readonly outcome: Outcome }
  | { readonly kind: "fail_before_evidence"; readonly failure: UpstreamFailure };

const publicReason = (cause: unknown): string => {
  if (cause instanceof Error && typeof cause.message === "string" && cause.message.length > 0) {
    return cause.message.slice(0, 200);
  }
  if (typeof cause === "string") return cause.slice(0, 200);
  const tagged = cause as { readonly _tag?: unknown; readonly cause?: unknown };
  if (typeof tagged._tag === "string") return tagged._tag.slice(0, 200);
  return String(cause).slice(0, 200);
};

const effectAiAdapterTag = (cause: unknown): string | undefined => {
  const tag = (cause as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" && tag.startsWith("agent_os.effect_ai_") ? tag : undefined;
};

const classifyProviderHttpFailure = (failure: ProviderHttpFailure): Outcome => {
  const flags = new Set(failure.flags);
  if (flags.has("auth") || failure.status === 401 || failure.status === 403) {
    return { class: "AuthError", status: failure.status === 0 ? 401 : failure.status };
  }
  if (flags.has("rate_limited") || failure.status === 429) {
    return { class: "RateLimited" };
  }
  if (flags.has("schema")) {
    return {
      class: "SchemaUnsupported",
      reason: `${failure.provider}:${failure.status}:${failure.code ?? failure.type ?? "schema"}`,
    };
  }
  if (
    flags.has("overloaded") ||
    flags.has("unavailable") ||
    failure.status === 0 ||
    failure.status >= 500
  ) {
    return {
      class: "TransientError",
      cause: `${failure.provider}:${failure.status}:${failure.code ?? failure.type ?? "provider"}`,
    };
  }
  return {
    class: "ProviderRejected",
    status: failure.status,
    body: `${failure.provider}:${failure.code ?? failure.type ?? "provider_rejected"}`,
  };
};

export const classifyStructuredCallFailure = (
  failure: UpstreamFailure | RefResolutionFailed,
): StructuredCallFailureClassification => {
  if (!(failure instanceof UpstreamFailure)) {
    return {
      kind: "record_evidence",
      outcome: { class: "ConfigError", reason: `${failure.kind}:${failure.ref}` },
    };
  }

  const cause = failure.cause;
  if (cause instanceof ProviderOutputDecodeError) {
    return { kind: "fail_before_evidence", failure };
  }
  if (cause instanceof ProviderHttpFailure) {
    return { kind: "record_evidence", outcome: classifyProviderHttpFailure(cause) };
  }

  const effectAiTag = effectAiAdapterTag(cause);
  if (effectAiTag !== undefined) {
    if (effectAiTag === "agent_os.effect_ai_unsupported_route") {
      return {
        kind: "record_evidence",
        outcome: { class: "ConfigError", reason: effectAiTag },
      };
    }
    return { kind: "fail_before_evidence", failure };
  }

  return {
    kind: "record_evidence",
    outcome: { class: "TransientError", cause: publicReason(cause) },
  };
};
