/**
 * Anthropic Messages wire (`anthropic-messages` route kind).
 *
 *  - system extracted from messages[] into a top-level string
 *  - assistant tool_calls fold into content[].tool_use blocks
 *  - tool result messages fold into a user message containing
 *    content[].tool_result blocks
 *  - tools[].input_schema (NOT function.parameters)
 *  - tool_choice: { type: "tool", name } (NOT openai's
 *    { type: "function", function: { name } })
 *  - max_tokens is REQUIRED (default 4096; can be overridden later via
 *    a Strategy variant when an app needs it)
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesBody,
  AnthropicTool,
  LlmMessage,
  LlmRoute,
  LlmToolCall,
  ToolDefinition,
} from "../llm";
import type { SchemaContract, Strategy } from "../../admission";
import type {
  AdapterMode,
  AdapterStimulus,
  DecodeStructuredResult,
  DecodedOutput,
  LlmProtocolAdapter,
  TurnRequest,
  TurnResponse,
} from "./protocol-adapter";
import {
  ADAPTER_VERSION,
  CHAT_COMPLETIONS_FORCED_TOOL_NAME,
  providerFailureSignal,
  type Outcome,
} from "./shared";
import { validateAgainstSchema } from "../../admission/json-schema";

const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/** Translate unified LlmMessage[] into Anthropic shape:
 *  - "system" messages concat into top-level `system` field
 *  - "user" messages stay as user (string content)
 *  - "assistant" messages with tool_calls fold text + tool_use blocks
 *  - consecutive "tool" messages collapse into one user message holding
 *    tool_result blocks (Anthropic requires tool results inside a user
 *    turn, never as a separate role).
 */
const buildAnthropicMessages = (
  messages: ReadonlyArray<LlmMessage>,
): { system: string | undefined; anthropic: AnthropicMessage[] } => {
  const systemTexts: string[] = [];
  const out: AnthropicMessage[] = [];

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "system") {
      if (m.content) systemTexts.push(m.content);
      i++;
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "" });
      i++;
      continue;
    }
    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content && m.content.length > 0) {
        blocks.push({ type: "text", text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments) as unknown,
        });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      out.push({ role: "assistant", content: blocks });
      i++;
      continue;
    }
    if (m.role === "tool") {
      const toolBlocks: AnthropicContentBlock[] = [];
      while (i < messages.length && messages[i].role === "tool") {
        const tm = messages[i];
        toolBlocks.push({
          type: "tool_result",
          tool_use_id: tm.tool_call_id ?? "",
          content: tm.content ?? "",
        });
        i++;
      }
      out.push({ role: "user", content: toolBlocks });
      continue;
    }
    // Unknown role — skip defensively. The role union is closed at the
    // TS level so this path is unreachable under typed callers; included
    // only to make the iterator well-founded under casts.
    i++;
  }

  return {
    system: systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined,
    anthropic: out,
  };
};

const toolDefsToAnthropic = (
  tools: ReadonlyArray<ToolDefinition> | undefined,
): ReadonlyArray<AnthropicTool> | undefined => {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
};

const encodeAnthropicTurn = (
  _route: Extract<LlmRoute, { kind: "anthropic-messages" }>,
  request: TurnRequest,
): AnthropicMessagesBody => {
  const { system, anthropic } = buildAnthropicMessages(request.messages);
  return {
    system,
    messages: anthropic,
    tools: toolDefsToAnthropic(request.tools),
    tool_choice:
      request.tool_choice !== undefined
        ? {
            type: "tool" as const,
            name: request.tool_choice.function.name,
          }
        : undefined,
    max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
  };
};

interface AnthropicRawResponse {
  readonly content?: ReadonlyArray<AnthropicContentBlock>;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly stop_reason?: string;
}

const foldAnthropicBlocks = (
  blocks: ReadonlyArray<AnthropicContentBlock> | undefined,
): { readonly text: string; readonly toolCalls: ReadonlyArray<LlmToolCall> } => {
  const textBits: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  for (const block of blocks ?? []) {
    if (block.type === "text") {
      textBits.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }
  return { text: textBits.join(""), toolCalls };
};

const decodeAnthropicTurn = (raw: unknown): TurnResponse => {
  const r = raw as AnthropicRawResponse;
  const { text, toolCalls } = foldAnthropicBlocks(r.content);
  const promptTokens = r.usage?.input_tokens ?? 0;
  const completionTokens = r.usage?.output_tokens ?? 0;
  return {
    text,
    toolCalls,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
};

const encodeAnthropicStructured = (
  _route: Extract<LlmRoute, { kind: "anthropic-messages" }>,
  schema: SchemaContract,
  stimulus: AdapterStimulus,
  _strategy: Strategy,
): AnthropicMessagesBody => {
  const userText =
    stimulus.kind === "live" ? stimulus.userInput.userText : String(stimulus.synthetic.synthetic);
  return {
    system:
      "Return strictly structured output by calling the submit tool. Do not respond in free text.",
    messages: [{ role: "user", content: userText }],
    tools: [
      {
        name: CHAT_COMPLETIONS_FORCED_TOOL_NAME,
        description: "Submit the structured result. Args ARE the result.",
        input_schema: schema.schema,
      },
    ],
    tool_choice: {
      type: "tool" as const,
      name: CHAT_COMPLETIONS_FORCED_TOOL_NAME,
    },
    max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
  };
};

const decodeAnthropicStructured = (
  response: { readonly raw: unknown },
  schema: SchemaContract,
  _strategy: Strategy,
  mode: AdapterMode = "production",
): DecodeStructuredResult => {
  if (mode === "test-decode-mismatch") {
    return {
      ok: false,
      outcome: {
        class: "BehaviorFailed",
        sampleDigest: "synthetic-test-decode-mismatch",
      },
    };
  }
  const r = response.raw as AnthropicRawResponse;
  const blocks = r.content ?? [];
  const toolUseBlocks = blocks.filter(
    (b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> => b.type === "tool_use",
  );
  if (toolUseBlocks.length !== 1 || toolUseBlocks[0].name !== CHAT_COMPLETIONS_FORCED_TOOL_NAME) {
    return {
      ok: false,
      outcome: {
        class: "BehaviorFailed",
        sampleDigest:
          toolUseBlocks.length === 0
            ? "no-tool-use"
            : `unexpected-tool-use:${toolUseBlocks.length}:${toolUseBlocks[0]?.name ?? "?"}`,
      },
    };
  }
  const parsed = toolUseBlocks[0].input;
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      outcome: {
        class: "BehaviorFailed",
        sampleDigest: `tool-use-input-not-object:${typeof parsed}`,
      },
    };
  }
  const violations = validateAgainstSchema(parsed, schema.schema);
  if (violations.length > 0) {
    return {
      ok: false,
      outcome: {
        class: "BehaviorFailed",
        sampleDigest: `violations:${violations.join(",")}`.slice(0, 120),
      },
    };
  }
  const promptTokens = r.usage?.input_tokens ?? 0;
  const completionTokens = r.usage?.output_tokens ?? 0;
  return {
    ok: true,
    decoded: parsed as DecodedOutput,
    tokensUsed: promptTokens + completionTokens,
  };
};

const classifyAnthropicError = (error: unknown): Outcome => {
  const signal = providerFailureSignal(error);
  const msg = signal.message;
  const status = signal.status;
  const lower = msg.toLowerCase();

  if (signal.flags.has("auth") || status === 401 || status === 403) {
    return { class: "AuthError", status: status ?? 401 };
  }
  if (signal.flags.has("rate_limited") || status === 429) {
    return { class: "RateLimited" };
  }
  if (status === 400) {
    // Anthropic invalid_request_error with schema-related text →
    // SchemaUnsupported (the wire told us our schema/tool shape is wrong).
    if (signal.flags.has("schema") || lower.includes("schema") || lower.includes("tool")) {
      return { class: "SchemaUnsupported", reason: signal.publicMessage.slice(0, 200) };
    }
    return { class: "ProviderRejected", status: 400, body: signal.publicMessage.slice(0, 500) };
  }
  if (signal.flags.has("overloaded") || status === 529) {
    // Anthropic-specific "overloaded".
    return { class: "TransientError", cause: signal.publicMessage };
  }
  if (status !== undefined && status >= 500) {
    return { class: "TransientError", cause: signal.publicMessage };
  }
  if (lower.includes("timeout") || lower.includes("network")) {
    return { class: "TransientError", cause: signal.publicMessage };
  }
  return {
    class: "ProviderRejected",
    status: status ?? 0,
    body: signal.publicMessage.slice(0, 500),
  };
};

export const anthropicMessagesAdapter: LlmProtocolAdapter<"anthropic-messages"> = {
  kind: "anthropic-messages",
  version: ADAPTER_VERSION,
  encodeTurn: encodeAnthropicTurn,
  decodeTurn: decodeAnthropicTurn,
  encodeStructured: encodeAnthropicStructured,
  decodeStructured: decodeAnthropicStructured,
  classify: classifyAnthropicError,
};
