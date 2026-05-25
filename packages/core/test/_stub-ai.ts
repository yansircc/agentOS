/**
 * Test helpers: deterministic Ai binding stub.
 *
 * Production reads `env.AI.run(model, params)` which returns an upstream
 * LlmResponseSchema-shaped object (Chat Completions: `{ choices: [...], usage }`).
 * Contract tests substitute this binding with a stub whose `.run()` shifts
 * canned responses off a queue. Once the queue is drained, the next call
 * throws — loud failure, no silent fallback (per CLAUDE.md "no defensive
 * branches without failure model").
 *
 * Usage:
 *
 *   const ai = stubAi([
 *     toolCallResp("get_current_time", "{}", "c1"),
 *     finalTextResp("done"),
 *   ]);
 *   const aiLayer = Layer.succeed(AiBinding, ai);
 *   // ... compose runtime, run submitAgentEffect ...
 */

import type { LlmResponse } from "../src/llm";

/** Chat Completions shaped raw response, satisfying LlmResponseSchema (see
 *  packages/core/src/llm.ts:40). Production deserializes through that schema
 *  via Schema.decodeUnknown — these stubs must match exactly. */
export interface LlmRawResponse {
  readonly choices: ReadonlyArray<{
    readonly message: {
      readonly content: string | null;
      readonly tool_calls?: ReadonlyArray<{
        readonly id: string;
        readonly type: "function";
        readonly function: {
          readonly name: string;
          readonly arguments: string;
        };
      }>;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

const DEFAULT_USAGE = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
};

/** Build a response that calls one tool. */
export const toolCallResp = (
  toolName: string,
  argsJson: string,
  id = `call-${Math.random().toString(36).slice(2, 10)}`,
): LlmRawResponse => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          { id, type: "function", function: { name: toolName, arguments: argsJson } },
        ],
      },
    },
  ],
  usage: DEFAULT_USAGE,
});

/** Build a response that returns plain text and stops the loop (no tool_calls). */
export const finalTextResp = (text: string): LlmRawResponse => ({
  choices: [
    {
      message: {
        content: text,
      },
    },
  ],
  usage: DEFAULT_USAGE,
});

/** Construct an `Ai`-shaped stub backed by a FIFO queue of raw responses.
 *  Exhausting the queue throws — production callers must pre-load enough
 *  responses for the full test path. The error message names the call index
 *  for debugging. */
export const stubAi = (responses: ReadonlyArray<LlmRawResponse>): Ai => {
  let i = 0;
  return {
    run: ((_model: string, _params: unknown) => {
      const r = responses[i];
      if (r === undefined) {
        throw new Error(
          `stubAi: queue exhausted at call #${i + 1} (queue length = ${responses.length})`,
        );
      }
      i += 1;
      return Promise.resolve(r);
    }) as Ai["run"],
  } as Ai;
};

/** Re-export LlmResponse type so test files can build typed assertions if needed. */
export type { LlmResponse };
