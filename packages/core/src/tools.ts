/**
 * Tool interface — public app-facing type.
 *
 * `Tool<A, R>` has plain Promise execute; apps never touch Effect.
 * Optional `quota?: QuotaSpec` (added via withQuota helper) lets the
 * agent loop pre-check + consume against ledger before/after execute.
 * dispatchTool wraps the Promise into Effect with ToolError taxonomy.
 */

import { Effect } from "effect";
import { ToolError } from "./errors";
import type { LlmToolCall, ToolDefinition } from "./llm";
import type { QuotaSpec } from "./quota";

export interface Tool<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  R = any,
> {
  readonly definition: ToolDefinition;
  readonly execute: (args: A) => Promise<R>;
  readonly quota?: QuotaSpec;
}

export const dispatchTool = (
  tools: Record<string, Tool>,
  call: LlmToolCall,
): Effect.Effect<unknown, ToolError> =>
  Effect.gen(function* () {
    const tool = tools[call.function.name];
    if (tool === undefined) {
      return yield* new ToolError({
        toolName: call.function.name,
        cause: { reason: "unknown_tool" },
      });
    }
    const args = yield* Effect.try({
      try: () => JSON.parse(call.function.arguments) as unknown,
      catch: (cause) =>
        new ToolError({ toolName: call.function.name, cause }),
    });
    return yield* Effect.tryPromise({
      try: () => tool.execute(args),
      catch: (cause) =>
        new ToolError({ toolName: call.function.name, cause }),
    });
  });

export type { ToolDefinition } from "./llm";
