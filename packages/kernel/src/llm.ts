import { Schema } from "effect";
import { credentialMaterialRef, endpointMaterialRef, type MaterialRef } from "./material-ref";
import type { AgentSchema } from "./agent-schema";
import type { TraceContext } from "./trace-context";

export interface OpenAIChatCompatibleRoute {
  readonly kind: "openai-chat-compatible";
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
}

export interface AnthropicMessagesRoute {
  readonly kind: "anthropic-messages";
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
  readonly anthropicVersion?: string;
}

export interface GeminiGenerateContentRoute {
  readonly kind: "gemini-generate-content";
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
}

export type LlmRoute =
  | OpenAIChatCompatibleRoute
  | AnthropicMessagesRoute
  | GeminiGenerateContentRoute;

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export const DEFAULTS = {
  anthropicVersion: DEFAULT_ANTHROPIC_VERSION,
} as const;

export const llmRouteMaterialRefs = (route: LlmRoute): ReadonlyArray<MaterialRef> => {
  switch (route.kind) {
    case "openai-chat-compatible":
    case "anthropic-messages":
    case "gemini-generate-content":
      return [endpointMaterialRef(route.endpointRef), credentialMaterialRef(route.credentialRef)];
  }
};

export interface LlmToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<LlmToolCall>;
  readonly tool_call_id?: string;
  readonly name?: string;
}

export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

const nonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));
const unknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const LlmUsageSchema: Schema.Schema<LlmUsage> = Schema.Struct({
  promptTokens: nonNegativeInt,
  completionTokens: nonNegativeInt,
  totalTokens: nonNegativeInt,
});

export const LlmToolCallSchema: Schema.Schema<LlmToolCall> = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
  metadata: Schema.optional(unknownRecord),
});

export const STRUCTURED_OUTPUT_TOOL_NAME = "_submit_structured";

export type LlmOutputItem =
  | { readonly type: "message"; readonly text: string }
  | {
      readonly type: "reasoning";
      readonly summaryRef?: string;
      readonly redacted?: true;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "tool_call"; readonly call: LlmToolCall }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly name?: string;
      readonly content: string;
    }
  | { readonly type: "refusal"; readonly reason: string }
  | { readonly type: "error"; readonly message: string };

export const LlmOutputItemSchema: Schema.Schema<LlmOutputItem> = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("message"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("reasoning"),
    summaryRef: Schema.optional(Schema.String),
    redacted: Schema.optional(Schema.Literal(true)),
    metadata: Schema.optional(unknownRecord),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    call: LlmToolCallSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    callId: Schema.String,
    name: Schema.optional(Schema.String),
    content: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("refusal"),
    reason: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
  }),
);

export interface LlmResponse {
  readonly items: ReadonlyArray<LlmOutputItem>;
  readonly usage: LlmUsage;
}

export const textFromLlmOutputItems = (items: ReadonlyArray<LlmOutputItem>): string =>
  items
    .filter(
      (item): item is Extract<LlmOutputItem, { readonly type: "message" }> =>
        item.type === "message",
    )
    .map((item) => item.text)
    .join("");

export const toolCallsFromLlmOutputItems = (
  items: ReadonlyArray<LlmOutputItem>,
): ReadonlyArray<LlmToolCall> =>
  items
    .filter(
      (item): item is Extract<LlmOutputItem, { readonly type: "tool_call" }> =>
        item.type === "tool_call",
    )
    .map((item) => item.call);

export const llmOutputItemsFromTextAndToolCalls = (
  text: string,
  toolCalls: ReadonlyArray<LlmToolCall>,
): ReadonlyArray<LlmOutputItem> => [
  ...(text.length === 0 ? [] : [{ type: "message" as const, text }]),
  ...toolCalls.map((call) => ({ type: "tool_call" as const, call })),
];

export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: AgentSchema<unknown>;
  };
}

export interface LlmRequest {
  readonly route: LlmRoute;
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly traceContext?: TraceContext;
  readonly tool_choice?: {
    readonly type: "function";
    readonly function: { readonly name: string };
  };
}
