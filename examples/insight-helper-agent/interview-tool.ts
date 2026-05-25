/**
 * Interview tool — ported from
 *   /Users/yansir/code/52/insight-helper/src/lib/interview-tool.ts
 *
 * Substantive difference: the original used Zod for both the LLM-facing
 * JSON Schema AND for runtime decode on the frontend. Here we keep ONLY
 * the LLM-facing JSON Schema (which is what `ToolDefinition.parameters`
 * needs — a plain JSON Schema object). Runtime decode of the args is
 * implicit: the agent loop calls execute(args) where args is already
 * the parsed object (parseToolCall in packages/core/src/tools.ts does
 * the JSON.parse).
 *
 * Tool semantics: execute is pass-through-ish. The LLM emits
 *
 *   interview({ questions: [...] })
 *
 * The substrate's tool dispatch writes a `tool.executed` ledger event
 * carrying { name: "interview", args, result } per submit-agent.ts:277.
 * The app reads that event to find the questions to render. execute
 * returns a minimal confirmation back to the LLM so it does NOT
 * re-emit questions in free text or call more tools.
 *
 * One submit invocation = one interview turn. The agent loop terminates
 * after the LLM calls interview once and acknowledges, then the deliver
 * event fires. The next turn starts when the user answers (POST /answer
 * → emitEvent("interview.answer") → on() → submit again).
 */

import type { Tool } from "@agent-os/core";

const interviewParametersSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description: "问题列表，1-4 个；相关问题可以同一轮批量发送",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "问题内容" },
          header: {
            type: "string",
            description: "短标签，如「Experience」或「客户类型」",
          },
          multiSelect: {
            type: "boolean",
            description: "是否多选。多个事实可同时成立时必须使用 true",
          },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            description: "选项列表，2-6 个",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "选项标签" },
                description: { type: "string", description: "选项说明" },
                recommended: { type: "boolean", description: "是否为推荐选项" },
              },
              required: ["label", "recommended"],
            },
          },
        },
        required: ["question", "header", "multiSelect", "options"],
      },
    },
  },
  required: ["questions"],
} as const;

export const INTERVIEW_TOOL_NAME = "interview" as const;

export const interviewTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: INTERVIEW_TOOL_NAME,
      description:
        "向用户提问来共创可交给写手的 insight brief。" +
        "每次 1-3 个问题（相关独立问题可同轮发送），每题 2-5 个选项；" +
        "question / header / label / description 必须全部用中文；" +
        "单选用于互斥选择，多选用于可并存事实；" +
        "每个选项必须包含 recommended；禁止生成「其他」选项（前端会自动加自定义答案）。",
      parameters: interviewParametersSchema,
    },
  },
  execute: async () => ({
    ok: true,
    note:
      "Questions have been delivered to the user. The next turn will arrive " +
      "when the user responds. Do not call any tool again in this turn; " +
      "do not generate further text. Just stop.",
  }),
};
