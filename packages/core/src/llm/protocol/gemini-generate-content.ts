/**
 * Gemini generateContent wire (`gemini-generate-content` route kind).
 *
 *  - role mapping: "assistant" → "model", system → top-level
 *    systemInstruction (NOT a content with role "system")
 *  - tools wrap into `tools[].functionDeclarations[]`
 *  - forced tool: `toolConfig.functionCallingConfig.mode = "ANY"` +
 *    `allowedFunctionNames: [<single>]`
 *  - tool calls in response are `parts[].functionCall.{name,args}`;
 *    `args` is already an object (not a JSON-string like OpenAI)
 *  - usage on `usageMetadata.{promptTokenCount, candidatesTokenCount,
 *    totalTokenCount}`
 */

import type {
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiGenerateContentBody,
  GeminiPart,
  GeminiToolConfig,
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
  parseHttpStatus,
  type Outcome,
  unwrapErrorMessage,
} from "./shared";
import { validateAgainstSchema } from "../../admission/json-schema";

/** Build a stable id when Gemini elides `functionCall.id`. Derived from
 *  candidate + part position so the same response always yields the
 *  same id (no IO, no clock). The interface in §C requires adapters to
 *  be pure — using `Date.now()` here would break that and lose
 *  reproducibility of decoded turn rows in the ledger. */
const positionalGeminiToolCallId = (candidateIdx: number, partIdx: number): string =>
  `gemini-cand${candidateIdx}-part${partIdx}`;

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
          tc.metadata !== undefined && typeof tc.metadata.thoughtSignature === "string"
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
const GEMINI_STRIPPED_SCHEMA_FIELDS = new Set(["additionalProperties", "$schema", "$id", "$ref"]);

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
    systemInstruction: systemText !== undefined ? { parts: [{ text: systemText }] } : undefined,
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
        id: typeof fc.id === "string" ? fc.id : positionalGeminiToolCallId(candidateIdx, partIdx),
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
  const totalTokens = r.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;
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
    stimulus.kind === "live" ? stimulus.userInput.userText : String(stimulus.synthetic.synthetic);
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
    (p): p is Extract<GeminiPart, { functionCall: object }> => "functionCall" in p,
  );
  if (calls.length !== 1 || calls[0].functionCall.name !== CHAT_COMPLETIONS_FORCED_TOOL_NAME) {
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
  const tokensUsed = r.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;
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

export const geminiGenerateContentAdapter: LlmProtocolAdapter<"gemini-generate-content"> = {
  kind: "gemini-generate-content",
  version: ADAPTER_VERSION,
  encodeTurn: encodeGeminiTurn,
  decodeTurn: decodeGeminiTurn,
  encodeStructured: encodeGeminiStructured,
  decodeStructured: decodeGeminiStructured,
  classify: classifyGeminiError,
};
