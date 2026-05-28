import { credentialMaterialRef, endpointMaterialRef, type MaterialRef } from "./material-ref";

export interface CfAiBindingRoute {
  readonly kind: "cf-ai-binding";
  readonly modelId: string;
  readonly gatewayRef?: string;
}

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
  | CfAiBindingRoute
  | OpenAIChatCompatibleRoute
  | AnthropicMessagesRoute
  | GeminiGenerateContentRoute;

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export const DEFAULTS = {
  anthropicVersion: DEFAULT_ANTHROPIC_VERSION,
} as const;

export const llmRouteMaterialRefs = (route: LlmRoute): ReadonlyArray<MaterialRef> => {
  switch (route.kind) {
    case "cf-ai-binding":
      return [];
    case "openai-chat-compatible":
    case "anthropic-messages":
    case "gemini-generate-content":
      return [
        endpointMaterialRef(route.endpointRef, { protocol: route.kind }),
        credentialMaterialRef(route.credentialRef, {
          provider: route.kind,
          purpose: "llm_transport",
        }),
      ];
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

export interface LlmResponse {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<LlmToolCall>;
  readonly usage: LlmUsage;
}

export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: object;
  };
}

export interface LlmRequest {
  readonly route: LlmRoute;
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly tool_choice?: {
    readonly type: "function";
    readonly function: { readonly name: string };
  };
}
