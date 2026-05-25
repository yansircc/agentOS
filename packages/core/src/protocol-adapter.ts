/**
 * @agent-os/core protocol adapter — spec-27 LLM protocol adapter algebra.
 *
 * Holds the per-wire `LlmProtocolAdapter<K>` interface, all adapter
 * implementations, and the registry consumed by:
 *
 *   - `callLlm`               (llm.ts)         — free-text agent turn
 *   - `attemptStructured`     (admission.ts)   — structured-output admission
 *
 * Both code paths share the SAME adapter for a given `route.kind`. A
 * registered adapter is an atomic act covering both halves; partial
 * registration is forbidden by the type (`LlmProtocolAdapter<K>` requires
 * all 5 methods).
 *
 * State ownership: nothing. This module is pure (modulo construction-time
 * adapter object literals). All IO is in `dispatchProvider` (llm.ts).
 *
 * Spec: docs/spec-27-llm-protocol-adapter.md
 */

import type {
  Outcome,
  ProbeInput,
  LiveInput,
  Strategy,
  SchemaContract,
  JsonSchemaNode,
} from "./admission";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesBody,
  AnthropicTool,
  ChatCompletionsBody,
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiGenerateContentBody,
  GeminiPart,
  GeminiToolConfig,
  LlmMessage,
  LlmRoute,
  LlmToolCall,
  ProviderRequestBodyFor,
  ToolDefinition,
} from "./llm";

// ============================================================
// Section A — Adapter version + mode (moved from admission.ts)
// ============================================================

/** Single coherence dial for an adapter's complete behavior. Bumping the
 *  major invalidates structured-output lease evidence (spec-25 §9). Any
 *  observable change to encode/decode/classify on EITHER half (turn or
 *  structured) requires a major bump (spec-27 §5). */
export const ADAPTER_VERSION = "1.0.0";

/** Test-only knob: when set to "test-decode-mismatch", decodeStructured
 *  short-circuits to a BehaviorFailed outcome. Production code never
 *  sets this. Used by admission-contract tests to drive the
 *  short-circuit branch without needing a real flaky upstream. */
export type AdapterMode = "production" | "test-decode-mismatch";

// ============================================================
// Section B — Turn vs Structured ADTs
// ============================================================

/** Input to encodeTurn. Same shape as the free-text portion of LlmRequest
 *  in llm.ts (LlmRequest = TurnRequest & { route }). Caller fills in
 *  messages / optional tools / optional forced tool_choice. */
export interface TurnRequest {
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly tool_choice?: {
    readonly type: "function";
    readonly function: { readonly name: string };
  };
}

/** Output of decodeTurn. Unified across protocols — submit-agent.ts's
 *  tool-loop logic stays protocol-agnostic. Each adapter is responsible
 *  for folding native blocks (Chat Completions `tool_calls[]`,
 *  Anthropic `content[].tool_use`, Gemini `parts[].functionCall`) into
 *  this shape. */
export interface TurnResponse {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<LlmToolCall>;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

/** Stimulus shape passed to encodeStructured. Variant `live` carries the
 *  user text only — the deliver function lives on `attemptStructured`'s
 *  spec, not the adapter (the adapter does not write to the ledger). */
export type AdapterStimulus =
  | { readonly kind: "probe"; readonly synthetic: ProbeInput }
  | { readonly kind: "live"; readonly userInput: LiveInput };

export type DecodedOutput = Record<string, unknown>;

export type DecodeStructuredResult =
  | {
      readonly ok: true;
      readonly decoded: DecodedOutput;
      /** Per-call token usage. Surfaced by the adapter so admission.ts
       *  does NOT parse usage out of the raw upstream response (whose
       *  shape varies per wire — OpenAI: `usage.total_tokens`, Anthropic:
       *  `usage.{input_tokens,output_tokens}`, Gemini:
       *  `usageMetadata.totalTokenCount`). The adapter is the only entity
       *  that knows the protocol's usage shape. */
      readonly tokensUsed: number;
    }
  | { readonly ok: false; readonly outcome: Outcome };

// ============================================================
// Section C — LlmProtocolAdapter<K> interface
// ============================================================

/** The per-wire protocol algebra. One per `LlmRoute["kind"]`. Pure
 *  functions only — no IO, no clock, no secrets. Transport lives in
 *  `dispatchProvider` (llm.ts); secrets are resolved there from
 *  `ProviderRegistry`. The adapter never sees credential values.
 *
 *  Asymmetry (spec-27 §4):
 *    - `decodeTurn` is permissive: zero tool calls in the response is
 *      valid (assistant chose a text-only answer).
 *    - `decodeStructured` is strict: exactly one matching forced tool call
 *      MUST be present; anything else returns `{ok:false, outcome:
 *      BehaviorFailed}`.
 *
 *  Shared:
 *    - `classify` maps transport / HTTP / protocol errors into the closed
 *      `FailureClass` set. **v0 runtime scope (spec-27 §3.0.1):** the
 *      only consumer is `attemptStructured` (structured path). `callLlm`
 *      does NOT invoke classify — dispatch errors propagate as raw
 *      `UpstreamFailure` to submit-agent's abort taxonomy. The function
 *      lives on the adapter so future adapters / a typed-turn-failure
 *      design (§11 OQ 6) can consume it without an interface change.
 *    - `version` governs both halves; any change to wire behavior on
 *      either half requires a major bump.
 */
export interface LlmProtocolAdapter<K extends LlmRoute["kind"]> {
  readonly kind: K;
  readonly version: string;

  // ── Free-text turn ────────────────────────────────────────
  encodeTurn(
    route: Extract<LlmRoute, { kind: K }>,
    request: TurnRequest,
  ): ProviderRequestBodyFor<K>;

  decodeTurn(raw: unknown): TurnResponse;

  // ── Structured-output admission ───────────────────────────
  encodeStructured(
    route: Extract<LlmRoute, { kind: K }>,
    schema: SchemaContract,
    stimulus: AdapterStimulus,
    strategy: Strategy,
  ): ProviderRequestBodyFor<K>;

  decodeStructured(
    response: { readonly raw: unknown },
    schema: SchemaContract,
    strategy: Strategy,
    mode?: AdapterMode,
  ): DecodeStructuredResult;

  // ── Shared error classification ───────────────────────────
  classify(error: unknown): Outcome;
}

// ============================================================
// Section D — Chat Completions wire (shared by cf-ai-binding +
//             openai-chat-compatible)
// ============================================================

const CHAT_COMPLETIONS_FORCED_TOOL_NAME = "_submit_structured";

const validateAgainstSchema = (
  value: unknown,
  schema: JsonSchemaNode,
): string[] => {
  const violations: string[] = [];
  const walk = (v: unknown, s: JsonSchemaNode, path: string): void => {
    if (s.type === "object") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        violations.push(`${path}:not-object`);
        return;
      }
      const obj = v as Record<string, unknown>;
      for (const req of s.required ?? []) {
        if (!(req in obj)) violations.push(`${path}.${req}:missing`);
      }
      if (s.additionalProperties === false) {
        for (const k of Object.keys(obj)) {
          if (!(k in s.properties)) {
            violations.push(`${path}.${k}:unknown-property`);
          }
        }
      }
      for (const [k, sub] of Object.entries(s.properties)) {
        if (k in obj) walk(obj[k], sub, `${path}.${k}`);
      }
    } else if (s.type === "array") {
      if (!Array.isArray(v)) {
        violations.push(`${path}:not-array`);
        return;
      }
      v.forEach((item, i) => walk(item, s.items, `${path}[${i}]`));
    } else if (s.type === "string") {
      if (typeof v !== "string") violations.push(`${path}:not-string`);
      else if (s.enum && !s.enum.includes(v))
        violations.push(`${path}:not-in-enum`);
    } else if (s.type === "number") {
      if (typeof v !== "number") violations.push(`${path}:not-number`);
    } else if (s.type === "boolean") {
      if (typeof v !== "boolean") violations.push(`${path}:not-boolean`);
    }
  };
  walk(value, schema, "$");
  return violations;
};

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

/** Unwrap a tagged-error / wrapped error one level to surface the real
 *  upstream Error message. `dispatchProvider` always wraps fetch failures
 *  as `UpstreamFailure{cause: Error("HTTP N ...")}`; without this unwrap
 *  classify would see only the tag name ("UpstreamFailure") and route
 *  everything to the default ProviderRejected branch. */
const unwrapErrorMessage = (error: unknown): string => {
  if (error !== null && typeof error === "object" && "cause" in error) {
    const inner = (error as { cause: unknown }).cause;
    if (inner instanceof Error) return inner.message;
    if (typeof inner === "string") return inner;
    if (inner !== null && inner !== undefined) return String(inner);
  }
  return error instanceof Error ? error.message : String(error);
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

// ============================================================
// Section E — Adapter implementations
// ============================================================

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

// ============================================================
// Section E.2 — Anthropic Messages wire
//   - system extracted from messages[] into a top-level string
//   - assistant tool_calls fold into content[].tool_use blocks
//   - tool result messages fold into a user message containing
//     content[].tool_result blocks
//   - tools[].input_schema (NOT function.parameters)
//   - tool_choice: { type: "tool", name } (NOT openai's
//     { type: "function", function: { name } })
//   - max_tokens is REQUIRED (default 4096; can be overridden later via
//     a Strategy variant when an app needs it)
// ============================================================

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
        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(tc.function.arguments);
        } catch {
          // If we have a previously-emitted assistant tool_call whose
          // arguments came from an Anthropic decode (already stringified
          // from an object), this should succeed. If it fails, surface
          // the raw string under a single text field — the model will
          // see malformed input and most likely correct on the next turn.
          parsedInput = tc.function.arguments;
        }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: parsedInput,
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
): { text: string; toolCalls: LlmToolCall[] } => {
  const textParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  for (const b of blocks ?? []) {
    if (b.type === "text") {
      textParts.push(b.text);
    } else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: {
          name: b.name,
          // Re-stringify to match the unified LlmToolCall shape (which
          // carries arguments as a JSON string for cross-protocol
          // compatibility with submit-agent's tool-loop logic).
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
    // tool_result blocks should not appear in upstream RESPONSE content;
    // they are request-side. Ignore if present.
  }
  return { text: textParts.join(""), toolCalls };
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
    stimulus.kind === "live"
      ? stimulus.userInput.userText
      : String(stimulus.synthetic.synthetic);
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
    (b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> =>
      b.type === "tool_use",
  );
  if (
    toolUseBlocks.length !== 1 ||
    toolUseBlocks[0].name !== CHAT_COMPLETIONS_FORCED_TOOL_NAME
  ) {
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

const parseHttpStatus = (msg: string): number | undefined => {
  const m = /HTTP\s+(\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : undefined;
};

const classifyAnthropicError = (error: unknown): Outcome => {
  const msg = unwrapErrorMessage(error);
  const status = parseHttpStatus(msg);
  const lower = msg.toLowerCase();

  if (status === 401 || status === 403) {
    return { class: "AuthError", status: status ?? 401 };
  }
  if (status === 429) {
    return { class: "RateLimited" };
  }
  if (status === 400) {
    // Anthropic invalid_request_error with schema-related text →
    // SchemaUnsupported (the wire told us our schema/tool shape is wrong).
    if (
      lower.includes("schema") ||
      lower.includes("input_schema") ||
      lower.includes("tool")
    ) {
      return { class: "SchemaUnsupported", reason: msg.slice(0, 200) };
    }
    return { class: "ProviderRejected", status: 400, body: msg.slice(0, 500) };
  }
  if (status === 529) {
    // Anthropic-specific "overloaded".
    return { class: "TransientError", cause: msg };
  }
  if (status !== undefined && status >= 500) {
    return { class: "TransientError", cause: msg };
  }
  if (lower.includes("timeout") || lower.includes("network")) {
    return { class: "TransientError", cause: msg };
  }
  return {
    class: "ProviderRejected",
    status: status ?? 0,
    body: msg.slice(0, 500),
  };
};

export const anthropicMessagesAdapter: LlmProtocolAdapter<"anthropic-messages"> =
  {
    kind: "anthropic-messages",
    version: ADAPTER_VERSION,
    encodeTurn: encodeAnthropicTurn,
    decodeTurn: decodeAnthropicTurn,
    encodeStructured: encodeAnthropicStructured,
    decodeStructured: decodeAnthropicStructured,
    classify: classifyAnthropicError,
  };

// ============================================================
// Section E.3 — Gemini generateContent wire
//   - role mapping: "assistant" → "model", system → top-level
//     systemInstruction (NOT a content with role "system")
//   - tools wrap into `tools[].functionDeclarations[]`
//   - forced tool: `toolConfig.functionCallingConfig.mode = "ANY"` +
//     `allowedFunctionNames: [<single>]`
//   - tool calls in response are `parts[].functionCall.{name,args}`;
//     `args` is already an object (not a JSON-string like OpenAI)
//   - usage on `usageMetadata.{promptTokenCount, candidatesTokenCount,
//     totalTokenCount}`
// ============================================================

/** Build a stable id when Gemini elides `functionCall.id`. Derived from
 *  candidate + part position so the same response always yields the
 *  same id (no IO, no clock). The interface in §C requires adapters to
 *  be pure — using `Date.now()` here would break that and lose
 *  reproducibility of decoded turn rows in the ledger. */
const positionalGeminiToolCallId = (
  candidateIdx: number,
  partIdx: number,
): string => `gemini-cand${candidateIdx}-part${partIdx}`;

const buildGeminiContents = (
  messages: ReadonlyArray<LlmMessage>,
): {
  systemText: string | undefined;
  contents: GeminiContent[];
} => {
  const systemTexts: string[] = [];
  const out: GeminiContent[] = [];

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "system") {
      if (m.content) systemTexts.push(m.content);
      i++;
      continue;
    }
    if (m.role === "user") {
      out.push({
        role: "user",
        parts: [{ text: m.content ?? "" }],
      });
      i++;
      continue;
    }
    if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content && m.content.length > 0) {
        parts.push({ text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        let args: unknown;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = tc.function.arguments;
        }
        const signature =
          tc.metadata !== undefined &&
          typeof tc.metadata.thoughtSignature === "string"
            ? (tc.metadata.thoughtSignature as string)
            : undefined;
        if (signature !== undefined) {
          parts.push({
            functionCall: { name: tc.function.name, args },
            thoughtSignature: signature,
          });
        } else {
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      if (parts.length === 0) parts.push({ text: "" });
      out.push({ role: "model", parts });
      i++;
      continue;
    }
    if (m.role === "tool") {
      // Collapse consecutive tool messages into a single user content
      // with multiple functionResponse parts. Gemini matches responses
      // to calls by function name (NOT by id like OpenAI/Anthropic), so
      // `name` MUST be the tool function name. submit-agent.ts populates
      // `LlmMessage.name` on tool messages for exactly this reason.
      const parts: GeminiPart[] = [];
      while (i < messages.length && messages[i].role === "tool") {
        const tm = messages[i];
        let response: unknown = tm.content ?? "";
        try {
          response = JSON.parse(tm.content ?? "");
        } catch {
          // keep as string
        }
        parts.push({
          functionResponse: {
            name: tm.name ?? tm.tool_call_id ?? "tool",
            response: { content: response },
          },
        });
        i++;
      }
      out.push({ role: "user", parts });
      continue;
    }
    i++;
  }

  return {
    systemText: systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined,
    contents: out,
  };
};

/** Gemini's `parameters` accepts only a subset of JSON Schema. The
 *  substrate's `JsonSchemaObject` includes `additionalProperties` (and
 *  potentially other future closed-dialect fields) which Gemini rejects
 *  with HTTP 400 INVALID_ARGUMENT "Unknown name". Strip those fields at
 *  the adapter boundary.
 *
 *  This stripping is wire-translation: the original schema (including
 *  `additionalProperties`) remains the SSoT for fingerprint / lease
 *  projection; only the over-the-wire shape is narrowed. After Gemini
 *  responds, `validateAgainstSchema` still enforces the FULL schema
 *  (including closed-object semantics) locally — so apps still get the
 *  contract they declared, just with adapter-mediated wire compatibility.
 *
 *  Discovered during spike-06: schema with `additionalProperties:false`
 *  produced HTTP 400 INVALID_ARGUMENT on the first /structured call.
 *  classify correctly mapped this to SchemaUnsupported; the fix here
 *  closes the gap by construction so the same schema does not trigger
 *  it again.
 */
const GEMINI_STRIPPED_SCHEMA_FIELDS = new Set([
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
]);

const sanitizeSchemaForGemini = (node: unknown): unknown => {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((x) => sanitizeSchemaForGemini(x));
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (GEMINI_STRIPPED_SCHEMA_FIELDS.has(k)) continue;
    out[k] = sanitizeSchemaForGemini(v);
  }
  return out;
};

const toolDefsToGemini = (
  tools: ReadonlyArray<ToolDefinition> | undefined,
): ReadonlyArray<GeminiFunctionDeclaration> | undefined => {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: sanitizeSchemaForGemini(t.function.parameters) as object,
  }));
};

const encodeGeminiTurn = (
  _route: Extract<LlmRoute, { kind: "gemini-generate-content" }>,
  request: TurnRequest,
): GeminiGenerateContentBody => {
  const { systemText, contents } = buildGeminiContents(request.messages);
  const decls = toolDefsToGemini(request.tools);
  const toolConfig: GeminiToolConfig | undefined =
    request.tool_choice !== undefined
      ? {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: [request.tool_choice.function.name],
          },
        }
      : undefined;
  return {
    systemInstruction:
      systemText !== undefined
        ? { parts: [{ text: systemText }] }
        : undefined,
    contents,
    tools: decls !== undefined ? [{ functionDeclarations: decls }] : undefined,
    toolConfig,
  };
};

interface GeminiRawResponse {
  readonly candidates?: ReadonlyArray<{
    readonly content?: {
      readonly role?: string;
      readonly parts?: ReadonlyArray<GeminiPart>;
    };
    readonly finishReason?: string;
  }>;
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly totalTokenCount?: number;
  };
}

const foldGeminiParts = (
  parts: ReadonlyArray<GeminiPart> | undefined,
  candidateIdx: number,
): { text: string; toolCalls: LlmToolCall[] } => {
  const textBits: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  const list = parts ?? [];
  for (let partIdx = 0; partIdx < list.length; partIdx++) {
    const p = list[partIdx];
    if ("text" in p && typeof p.text === "string") {
      textBits.push(p.text);
    } else if ("functionCall" in p) {
      // Gemini returns its own opaque `id` on functionCall. Prefer it
      // when present so the assistant→tool→assistant round-trip matches
      // the wire's identity. Fall back to a positional id when Gemini
      // elides it (older models or non-thinking responses) — positional
      // keeps the adapter pure (no clock, no mutable state).
      const fc = p.functionCall as {
        name: string;
        args: unknown;
        id?: string;
      };
      const metadata: Record<string, unknown> = {};
      if (typeof p.thoughtSignature === "string") {
        // Required to be echoed back unchanged on subsequent turns
        // (gemini-3.1+). Missing → HTTP 400 INVALID_ARGUMENT on the
        // next turn. See https://ai.google.dev/gemini-api/docs/thought-signatures.
        metadata.thoughtSignature = p.thoughtSignature;
      }
      toolCalls.push({
        id:
          typeof fc.id === "string"
            ? fc.id
            : positionalGeminiToolCallId(candidateIdx, partIdx),
        type: "function",
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args ?? {}),
        },
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }
    // functionResponse parts are request-side; skip if echoed back.
  }
  return { text: textBits.join(""), toolCalls };
};

const decodeGeminiTurn = (raw: unknown): TurnResponse => {
  const r = raw as GeminiRawResponse;
  const cand = r.candidates?.[0];
  const { text, toolCalls } = foldGeminiParts(cand?.content?.parts, 0);
  const promptTokens = r.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = r.usageMetadata?.candidatesTokenCount ?? 0;
  const totalTokens =
    r.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;
  return {
    text,
    toolCalls,
    usage: { promptTokens, completionTokens, totalTokens },
  };
};

const encodeGeminiStructured = (
  _route: Extract<LlmRoute, { kind: "gemini-generate-content" }>,
  schema: SchemaContract,
  stimulus: AdapterStimulus,
  _strategy: Strategy,
): GeminiGenerateContentBody => {
  const userText =
    stimulus.kind === "live"
      ? stimulus.userInput.userText
      : String(stimulus.synthetic.synthetic);
  return {
    systemInstruction: {
      parts: [
        {
          text: "Return strictly structured output by calling the submit tool. Do not respond in free text.",
        },
      ],
    },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: CHAT_COMPLETIONS_FORCED_TOOL_NAME,
            description: "Submit the structured result. Args ARE the result.",
            parameters: sanitizeSchemaForGemini(schema.schema) as object,
          },
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [CHAT_COMPLETIONS_FORCED_TOOL_NAME],
      },
    },
  };
};

const decodeGeminiStructured = (
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
  const r = response.raw as GeminiRawResponse;
  const parts = r.candidates?.[0]?.content?.parts ?? [];
  const calls = parts.filter(
    (p): p is Extract<GeminiPart, { functionCall: object }> =>
      "functionCall" in p,
  );
  if (
    calls.length !== 1 ||
    calls[0].functionCall.name !== CHAT_COMPLETIONS_FORCED_TOOL_NAME
  ) {
    return {
      ok: false,
      outcome: {
        class: "BehaviorFailed",
        sampleDigest:
          calls.length === 0
            ? "no-function-call"
            : `unexpected-function-call:${calls.length}:${calls[0]?.functionCall.name ?? "?"}`,
      },
    };
  }
  const parsed = calls[0].functionCall.args;
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      outcome: {
        class: "BehaviorFailed",
        sampleDigest: `function-call-args-not-object:${typeof parsed}`,
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
  const promptTokens = r.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = r.usageMetadata?.candidatesTokenCount ?? 0;
  const tokensUsed =
    r.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;
  return {
    ok: true,
    decoded: parsed as DecodedOutput,
    tokensUsed,
  };
};

const classifyGeminiError = (error: unknown): Outcome => {
  const msg = unwrapErrorMessage(error);
  const status = parseHttpStatus(msg);
  const lower = msg.toLowerCase();

  if (status === 401 || status === 403) {
    return { class: "AuthError", status: status ?? 401 };
  }
  // Gemini quirk: bad API keys return HTTP 400 INVALID_ARGUMENT with
  // body `API_KEY_INVALID` / `PERMISSION_DENIED`, not the conventional
  // 401. Discovered during spike-06 with a deliberately bogus key
  // — without this branch, AuthError would mis-classify as
  // ProviderRejected (TTL≠AuthError; ops dashboard wouldn't flag the
  // credential as the root cause). The match is on the structured
  // `reason` token from Google's error envelope, not the natural-
  // language "api key not valid" — that string varies by locale.
  if (
    status === 400 &&
    (lower.includes("api_key_invalid") ||
      lower.includes("permission_denied") ||
      lower.includes("api key not valid"))
  ) {
    return { class: "AuthError", status: 400 };
  }
  if (status === 429 || lower.includes("resource_exhausted")) {
    return { class: "RateLimited" };
  }
  if (status === 400) {
    if (
      lower.includes("invalid_argument") &&
      (lower.includes("schema") ||
        lower.includes("parameter") ||
        lower.includes("function") ||
        lower.includes("tools["))
    ) {
      return { class: "SchemaUnsupported", reason: msg.slice(0, 200) };
    }
    return { class: "ProviderRejected", status: 400, body: msg.slice(0, 500) };
  }
  if (status === 503 || lower.includes("unavailable")) {
    return { class: "TransientError", cause: msg };
  }
  if (status !== undefined && status >= 500) {
    return { class: "TransientError", cause: msg };
  }
  if (lower.includes("timeout") || lower.includes("network")) {
    return { class: "TransientError", cause: msg };
  }
  return {
    class: "ProviderRejected",
    status: status ?? 0,
    body: msg.slice(0, 500),
  };
};

export const geminiGenerateContentAdapter: LlmProtocolAdapter<"gemini-generate-content"> =
  {
    kind: "gemini-generate-content",
    version: ADAPTER_VERSION,
    encodeTurn: encodeGeminiTurn,
    decodeTurn: decodeGeminiTurn,
    encodeStructured: encodeGeminiStructured,
    decodeStructured: decodeGeminiStructured,
    classify: classifyGeminiError,
  };

// ============================================================
// Section F — Registry
// ============================================================

/** Per-kind adapter map. Mapped type so each entry is statically typed to
 *  the matching `LlmProtocolAdapter<K>`. Use `getProtocolAdapter` for
 *  type-narrowed lookup at runtime. */
export type LlmProtocolAdapterRegistry = {
  readonly [K in LlmRoute["kind"]]: LlmProtocolAdapter<K>;
};

export const llmProtocolAdapters: LlmProtocolAdapterRegistry = {
  "cf-ai-binding": cfAiBindingAdapter,
  "openai-chat-compatible": openaiChatCompatibleAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
  "gemini-generate-content": geminiGenerateContentAdapter,
};

/** Type-narrowed adapter lookup. TS cannot directly narrow
 *  `registry[route.kind]` because the indexed access loses the binding
 *  between `kind` and the adapter's `K`. This helper re-establishes it. */
export const getProtocolAdapter = <K extends LlmRoute["kind"]>(
  kind: K,
): LlmProtocolAdapter<K> => llmProtocolAdapters[kind];
