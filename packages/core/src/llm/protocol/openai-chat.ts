/**
 * Chat Completions wire — shared by `cf-ai-binding` and
 * `openai-chat-compatible` adapters. Cloudflare Workers AI's binding
 * (`env.AI.run`) accepts Chat Completions request shape directly; external
 * providers using the openai-chat-compatible kind also exchange the same
 * envelope. Both adapters share encode/decode/classify; only the kind
 * discriminator differs.
 *
 * spec-27 §4 strictness applies to `decodeStructured`: exactly one tool
 * call with the synthesized `_submit_structured` name. Anything else
 * returns `BehaviorFailed` so admission.ts does not write false
 * Supported evidence rows.
 */

import type {
  ChatCompletionsBody,
  LlmRoute,
  LlmToolCall,
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
  type Outcome,
  unwrapErrorMessage,
} from "./shared";
import { validateAgainstSchema } from "../../admission/json-schema";

/** Encode a free-text turn into Chat Completions body. dispatchProvider
 *  injects `model` (cf-ai-binding via env.AI.run argument, openai-chat-
 *  compatible via body merge). */
const encodeChatCompletionsTurn = (
  _route: LlmRoute,
  request: TurnRequest,
): ChatCompletionsBody => ({
  messages: request.messages,
  tools: request.tools,
  tool_choice: request.tool_choice,
});

const decodeChatCompletionsTurn = (raw: unknown): TurnResponse => {
  const r = raw as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: ReadonlyArray<LlmToolCall>;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  const first = r.choices?.[0];
  if (first === undefined) {
    throw new Error("empty choices array in upstream response");
  }
  const text = first.message?.content ?? "";
  const toolCalls = first.message?.tool_calls ?? [];
  return {
    text,
    toolCalls,
    usage: {
      promptTokens: r.usage?.prompt_tokens ?? 0,
      completionTokens: r.usage?.completion_tokens ?? 0,
      totalTokens: r.usage?.total_tokens ?? 0,
    },
  };
};

/** Encode a structured-output request into Chat Completions body using
 *  forced-tool-call: synthesize a single `_submit_structured` tool whose
 *  `parameters` is the schema, then force `tool_choice` to that name.
 *  Spike-03 verdict: `response_format: json_schema` is not contractually
 *  honored by Workers AI; forced-tool-call is the only working strategy
 *  on Chat Completions wires.
 */
const encodeChatCompletionsStructured = (
  _route: LlmRoute,
  schema: SchemaContract,
  stimulus: AdapterStimulus,
  _strategy: Strategy,
): ChatCompletionsBody => {
  // `Strategy` is closed at "forced-tool-call" in v0; the type system
  // exhausts the union. Adding a new strategy is a TS-level breaking
  // change that lights up at the tool_choice construction site below.
  const userText =
    stimulus.kind === "live"
      ? stimulus.userInput.userText
      : String(stimulus.synthetic.synthetic);
  return {
    messages: [
      {
        role: "system",
        content:
          "Return strictly structured output by calling the submit tool. Do not respond in free text.",
        tool_calls: undefined,
      },
      { role: "user", content: userText, tool_calls: undefined },
    ],
    max_tokens: 2048,
    tools: [
      {
        type: "function",
        function: {
          name: CHAT_COMPLETIONS_FORCED_TOOL_NAME,
          description: "Submit the structured result. Args ARE the result.",
          parameters: schema.schema,
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: CHAT_COMPLETIONS_FORCED_TOOL_NAME },
    },
  };
};

const decodeChatCompletionsStructured = (
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
  const raw = response.raw as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: { total_tokens?: number };
  };
  const toolCalls = raw.choices?.[0]?.message?.tool_calls ?? [];
  // spec-27 §4 strictness: structured path MUST observe exactly one
  // forced tool call with the synthesized name. Anthropic/Gemini already
  // enforce this; this branch closes the gap on Chat-Completions wires.
  // Without it a provider that emits `_submit_structured` + extra calls
  // would write a false Supported evidence row.
  if (
    toolCalls.length !== 1 ||
    toolCalls[0].function?.name !== CHAT_COMPLETIONS_FORCED_TOOL_NAME
  ) {
    return {
      ok: false,
      outcome: {
        class: "BehaviorFailed",
        sampleDigest:
          toolCalls.length === 0
            ? "no-tool-call"
            : `unexpected-tool-calls:${toolCalls.length}:${toolCalls[0].function?.name ?? "?"}`,
      },
    };
  }
  const tc = toolCalls[0].function;
  if (!tc.arguments) {
    return {
      ok: false,
      outcome: { class: "BehaviorFailed", sampleDigest: "no-tool-call-args" },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(tc.arguments);
  } catch (e) {
    return {
      ok: false,
      outcome: {
        class: "BehaviorFailed",
        sampleDigest: `args-parse-failed:${String(e).slice(0, 40)}`,
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
  return {
    ok: true,
    decoded: parsed as DecodedOutput,
    tokensUsed: raw.usage?.total_tokens ?? 0,
  };
};

const classifyChatCompletionsError = (error: unknown): Outcome => {
  const msg = unwrapErrorMessage(error);
  const lower = msg.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthor"))
    return { class: "AuthError", status: 401 };
  if (lower.includes("429") || lower.includes("rate"))
    return { class: "RateLimited" };
  if (lower.includes("timeout") || lower.includes("network"))
    return { class: "TransientError", cause: msg };
  return { class: "ProviderRejected", status: 0, body: msg };
};

export const cfAiBindingAdapter: LlmProtocolAdapter<"cf-ai-binding"> = {
  kind: "cf-ai-binding",
  version: ADAPTER_VERSION,
  encodeTurn: encodeChatCompletionsTurn,
  decodeTurn: decodeChatCompletionsTurn,
  encodeStructured: encodeChatCompletionsStructured,
  decodeStructured: decodeChatCompletionsStructured,
  classify: classifyChatCompletionsError,
};

export const openaiChatCompatibleAdapter: LlmProtocolAdapter<"openai-chat-compatible"> =
  {
    kind: "openai-chat-compatible",
    version: ADAPTER_VERSION,
    encodeTurn: encodeChatCompletionsTurn,
    decodeTurn: decodeChatCompletionsTurn,
    encodeStructured: encodeChatCompletionsStructured,
    decodeStructured: decodeChatCompletionsStructured,
    classify: classifyChatCompletionsError,
  };
