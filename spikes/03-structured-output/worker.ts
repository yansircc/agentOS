/**
 * Spike 03 — structured output modes for withStructuredOutput design.
 *
 * Side-by-side test of:
 *   /test/a — response_format: json_schema mode
 *   /test/b — single-tool-submit mode (synthetic submit_analysis tool)
 *
 * Both endpoints call the same model on the same prompt with the same
 * target schema. Output is returned raw for inspection + assertion.
 */

interface Env {
  AI: Ai;
}

const MODEL = "@cf/openai/gpt-oss-120b";

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    sentiment: {
      type: "string",
      enum: ["positive", "negative", "neutral"],
    },
    keywords: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["summary", "sentiment", "keywords"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT =
  "You analyze text. Return strictly structured analysis. Do not include explanations outside the structure.";

const USER_TEXT =
  "Analyze this text: \"agent-OS is clean and works well. The error vocabulary is great.\"";

// ============================================================
//                MODE A: response_format json_schema
// ============================================================

async function testModeA(env: Env): Promise<unknown> {
  return env.AI.run(
    MODEL as never,
    {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_TEXT },
      ],
      max_tokens: 2048,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "TextAnalysis",
          schema: ANALYSIS_SCHEMA,
          strict: true,
        },
      },
    } as never,
  ) as Promise<unknown>;
}

// ============================================================
//                MODE B: single-tool-submit
// ============================================================

async function testModeB(env: Env): Promise<unknown> {
  return env.AI.run(
    MODEL as never,
    {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            USER_TEXT +
            "\n\nWhen you have the analysis, call the submit_analysis tool with the result. Do not respond with free text.",
        },
      ],
      max_tokens: 2048,
      tools: [
        {
          type: "function",
          function: {
            name: "submit_analysis",
            description:
              "Submit the final text analysis. The args ARE the analysis result.",
            parameters: ANALYSIS_SCHEMA,
          },
        },
      ],
      // Force the model to call submit_analysis specifically (not free text)
      tool_choice: {
        type: "function",
        function: { name: "submit_analysis" },
      },
    } as never,
  ) as Promise<unknown>;
}

// ============================================================
//                  EXTRACTION + VALIDATION
// ============================================================

interface ExtractResult {
  raw_text: string | null;
  raw_tool_call: { name: string; arguments_text: string } | null;
  parsed: unknown;
  parse_error: string | null;
  schema_violations: string[];
  usage: { prompt: number; completion: number; total: number };
}

function validateAgainstSchema(value: unknown): string[] {
  const violations: string[] = [];
  if (typeof value !== "object" || value === null) {
    violations.push("not an object");
    return violations;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== "string") violations.push("summary not a string");
  if (
    v.sentiment !== "positive" &&
    v.sentiment !== "negative" &&
    v.sentiment !== "neutral"
  ) {
    violations.push("sentiment not one of positive|negative|neutral");
  }
  if (!Array.isArray(v.keywords)) {
    violations.push("keywords not an array");
  } else if (v.keywords.some((k) => typeof k !== "string")) {
    violations.push("keywords contains non-string element");
  }
  return violations;
}

function extractA(raw: unknown): ExtractResult {
  const r = raw as {
    choices?: ReadonlyArray<{
      message?: {
        content?: string | null;
        tool_calls?: ReadonlyArray<{
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const content = r.choices?.[0]?.message?.content ?? null;
  let parsed: unknown = null;
  let parse_error: string | null = null;
  if (content !== null) {
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      parse_error = `JSON.parse failed: ${String(e)}`;
    }
  } else {
    parse_error = "content is null";
  }
  const schema_violations =
    parse_error === null ? validateAgainstSchema(parsed) : [];

  return {
    raw_text: content,
    raw_tool_call: null,
    parsed,
    parse_error,
    schema_violations,
    usage: {
      prompt: r.usage?.prompt_tokens ?? 0,
      completion: r.usage?.completion_tokens ?? 0,
      total: r.usage?.total_tokens ?? 0,
    },
  };
}

function extractB(raw: unknown): ExtractResult {
  const r = raw as {
    choices?: ReadonlyArray<{
      message?: {
        content?: string | null;
        tool_calls?: ReadonlyArray<{
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const tc = r.choices?.[0]?.message?.tool_calls?.[0]?.function;
  const argsText = tc?.arguments ?? null;
  let parsed: unknown = null;
  let parse_error: string | null = null;

  if (argsText === null) {
    parse_error = "no tool_call.arguments";
  } else {
    try {
      parsed = JSON.parse(argsText);
    } catch (e) {
      parse_error = `JSON.parse failed: ${String(e)}`;
    }
  }
  const schema_violations =
    parse_error === null ? validateAgainstSchema(parsed) : [];

  return {
    raw_text: r.choices?.[0]?.message?.content ?? null,
    raw_tool_call:
      argsText === null
        ? null
        : { name: tc?.name ?? "", arguments_text: argsText },
    parsed,
    parse_error,
    schema_violations,
    usage: {
      prompt: r.usage?.prompt_tokens ?? 0,
      completion: r.usage?.completion_tokens ?? 0,
      total: r.usage?.total_tokens ?? 0,
    },
  };
}

// ============================================================
//                  ROUTES
// ============================================================

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/test/a") {
      const raw = await testModeA(env);
      const extract = extractA(raw);
      return Response.json({ mode: "A response_format", extract, raw });
    }

    if (req.method === "POST" && url.pathname === "/test/b") {
      const raw = await testModeB(env);
      const extract = extractB(raw);
      return Response.json({ mode: "B single-tool-submit", extract, raw });
    }

    return new Response(
      [
        "agent-os spike-03 (structured output modes)",
        "",
        "POST /test/a   Mode A: response_format json_schema",
        "POST /test/b   Mode B: single-tool-submit pattern",
        "",
        `model: ${MODEL}`,
      ].join("\n"),
      { headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
