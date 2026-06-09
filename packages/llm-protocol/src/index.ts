import { Schema } from "effect";
import type { AgentSchema } from "@agent-os/kernel/agent-schema";
import {
  credentialMaterialRef,
  endpointMaterialRef,
  type MaterialRef,
} from "@agent-os/kernel/material-ref";
import type { ToolDefinition } from "@agent-os/kernel/tools";

export const LLM_WIRE_DESCRIPTOR_VERSION = "llm-wire-descriptor-v1";

export type LlmJsonSchemaObject = AgentSchema<unknown>["jsonSchema"];

export interface LlmRoute {
  readonly endpointRef?: string;
  readonly credentialRef?: string;
  readonly [key: string]: unknown;
}

export interface LlmWireDescriptor {
  readonly method: "POST";
  readonly url: string;
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
  readonly bodySchema?: LlmJsonSchemaObject;
}

export const llmRouteMaterialRefs = (route: LlmRoute): ReadonlyArray<MaterialRef> => [
  ...(typeof route.endpointRef === "string" ? [endpointMaterialRef(route.endpointRef)] : []),
  ...(typeof route.credentialRef === "string" ? [credentialMaterialRef(route.credentialRef)] : []),
];

const unknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const nonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));

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

export interface LlmRequest {
  readonly route: LlmRoute;
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly traceContext?: unknown;
  readonly tool_choice?: {
    readonly type: "function";
    readonly function: { readonly name: string };
  };
}

export const projectAgentSchemaForLlmTool = (schema: AgentSchema<unknown>): LlmJsonSchemaObject =>
  schema.projections.canonical;

const canonicalizeWireDescriptor = (descriptor: LlmWireDescriptor): LlmWireDescriptor => ({
  ...descriptor,
  headers: [...descriptor.headers].sort(([left], [right]) => left.localeCompare(right)),
});

export const canonicalLlmWireDescriptorJson = (descriptor: LlmWireDescriptor): string =>
  JSON.stringify(canonicalize(canonicalizeWireDescriptor(descriptor)));

const canonicalize = (node: unknown): unknown => {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => canonicalize(item));
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
  return out;
};
