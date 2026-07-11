import { Context, Schema } from "effect";
import type { Effect as EffectType } from "effect";
import type { AgentSchema } from "@agent-os/core/agent-schema";
import type { UpstreamFailure } from "@agent-os/core/errors";
import type { MaterialRef } from "@agent-os/core/material-ref";
import type {
  MaterialResolutionReceipt,
  MaterialResolutionRequest,
  RefResolutionFailed,
} from "@agent-os/core/ref-resolver";
import type { ToolDefinition } from "@agent-os/core/tools";

export const LLM_WIRE_DESCRIPTOR_VERSION = "llm-wire-descriptor-v1";
export const LLM_CALL_SNAPSHOT_VERSION = "llm-call-snapshot-v1";

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

export interface LlmCallOptions {
  readonly signal?: AbortSignal;
}

export interface LlmTransportRouteDescriptor {
  readonly wireDescriptor: LlmWireDescriptor;
  readonly providerOutputAdapterId: string;
  readonly providerOutputAdapterVersion: string;
  readonly transportAdapterId: string;
  readonly transportAdapterVersion: string;
}

/**
 * Provider-neutral port for resolving and calling an LLM route.
 *
 * @agentosPrimitive primitive.llm_protocol.LlmTransport
 * @agentosInvariant invariant.boundary.runtime-validation-external-only
 * @agentosDocs docs/packages/core.md
 * @public
 */
export class LlmTransport extends Context.Service<
  LlmTransport,
  {
    readonly resolveRoute: (
      route: LlmRoute,
    ) => EffectType.Effect<LlmTransportRouteDescriptor, UpstreamFailure>;
    readonly call: (
      request: LlmRequest,
      options?: LlmCallOptions,
    ) => EffectType.Effect<LlmResponse, UpstreamFailure>;
  }
>()("@agent-os/LlmTransport") {}

export const llmRouteMaterialRefs = (route: LlmRoute): ReadonlyArray<MaterialRef> => [
  ...(typeof route.endpointRef === "string"
    ? [{ kind: "endpoint" as const, ref: route.endpointRef }]
    : []),
  ...(typeof route.credentialRef === "string"
    ? [{ kind: "credential" as const, ref: route.credentialRef }]
    : []),
];

const unknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const nonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

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

export const LlmUsageSchema: Schema.Decoder<LlmUsage> = Schema.Struct({
  promptTokens: nonNegativeInt,
  completionTokens: nonNegativeInt,
  totalTokens: nonNegativeInt,
});

export const LlmToolCallSchema: Schema.Decoder<LlmToolCall> = Schema.Struct({
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

export const LlmOutputItemSchema: Schema.Decoder<LlmOutputItem> = Schema.Union([
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
]);

export interface LlmResponse {
  readonly items: ReadonlyArray<LlmOutputItem>;
  readonly usage: LlmUsage;
}

export interface LlmSnapshotToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: LlmJsonSchemaObject;
  };
}

export interface LlmSnapshotRequest {
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<LlmSnapshotToolDefinition>;
  readonly traceContext?: unknown;
  readonly tool_choice?: LlmToolChoice;
}

export interface LlmCallSnapshot {
  readonly kind: "llm.call";
  readonly wireDescriptor: LlmWireDescriptor;
  readonly wireDescriptorFingerprint: string;
  readonly request: LlmSnapshotRequest;
  readonly requestFingerprint: string;
  readonly response: LlmResponse;
}

export const llmSnapshotToolDefinitionFromToolDefinition = (
  tool: ToolDefinition,
): LlmSnapshotToolDefinition => ({
  type: "function",
  function: {
    name: tool.function.name,
    description: tool.function.description,
    parameters: projectAgentSchemaForLlmTool(tool.function.parameters),
  },
});

export const llmSnapshotRequestFromRequest = (request: LlmRequest): LlmSnapshotRequest => ({
  messages: request.messages,
  ...(request.tools === undefined
    ? {}
    : { tools: request.tools.map(llmSnapshotToolDefinitionFromToolDefinition) }),
  ...(request.traceContext === undefined ? {} : { traceContext: request.traceContext }),
  ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
});

export const canonicalLlmSnapshotRequestJson = (request: LlmSnapshotRequest): string =>
  JSON.stringify(canonicalize(request));

export const llmSnapshotRequestFingerprint = (request: LlmSnapshotRequest): string =>
  `${LLM_CALL_SNAPSHOT_VERSION}:request:${canonicalLlmSnapshotRequestJson(request)}`;

export const llmCallSnapshotFromResponse = (spec: {
  readonly wireDescriptor: LlmWireDescriptor;
  readonly request: LlmRequest;
  readonly response: LlmResponse;
}): LlmCallSnapshot => {
  const snapshotRequest = llmSnapshotRequestFromRequest(spec.request);
  return {
    kind: "llm.call",
    wireDescriptor: canonicalizeWireDescriptor(spec.wireDescriptor),
    wireDescriptorFingerprint: llmWireDescriptorFingerprint(spec.wireDescriptor),
    request: snapshotRequest,
    requestFingerprint: llmSnapshotRequestFingerprint(snapshotRequest),
    response: spec.response,
  };
};

export const replayLlmResponseFromSnapshot = (snapshot: LlmCallSnapshot): LlmResponse =>
  snapshot.response;

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
  readonly tool_choice?: LlmToolChoice;
  /** Runtime-only resolution context; excluded from provider and snapshot projections. */
  readonly materialResolution?: Omit<MaterialResolutionRequest, "materialRef"> & {
    readonly expectedVersions?: Readonly<Record<string, string>>;
    readonly onResolved?: (
      receipt: MaterialResolutionReceipt,
    ) => EffectType.Effect<void, RefResolutionFailed>;
  };
}

export type LlmToolChoice =
  | "required"
  | {
      readonly type: "function";
      readonly function: { readonly name: string };
    };

export const projectAgentSchemaForLlmTool = (schema: AgentSchema<unknown>): LlmJsonSchemaObject =>
  schema.projections.canonical;

const canonicalizeWireDescriptor = (descriptor: LlmWireDescriptor): LlmWireDescriptor => ({
  ...descriptor,
  headers: [...descriptor.headers]
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(
      ([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue),
    ),
});

export const canonicalLlmWireDescriptorJson = (descriptor: LlmWireDescriptor): string =>
  JSON.stringify(canonicalize(canonicalizeWireDescriptor(descriptor)));

export const llmWireDescriptorFingerprint = (descriptor: LlmWireDescriptor): string =>
  `${LLM_WIRE_DESCRIPTOR_VERSION}:${canonicalLlmWireDescriptorJson(descriptor)}`;

const canonicalize = (node: unknown): unknown => {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => canonicalize(item));
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
  return out;
};
