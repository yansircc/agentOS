/**
 * Tool interface — public app-facing type.
 *
 * `Tool<A, R>` has plain Promise execute; apps never touch Effect.
 * Optional `quota?: QuotaSpec` (added via withQuota helper) lets the
 * agent loop pre-check + consume against ledger before/after execute.
 *
 * `parseToolCall` and `executeTool` are split intentionally so the agent
 * loop can run parsing OUTSIDE the per-attempt retry (parse failure won't
 * recover by retrying the same args) and quota-grant + execute INSIDE the
 * retry (each retry independently grants). Critically, this ensures
 * invalid LLM-emitted args never consume quota.
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

/** Resolve the tool definition + parse its JSON args. Failures here are
 *  non-recoverable (unknown_tool / invalid_args) — the caller MUST run this
 *  outside any retry block. */
export const parseToolCall = (
  tools: Record<string, Tool>,
  call: LlmToolCall,
): Effect.Effect<{ readonly tool: Tool; readonly args: unknown }, ToolError> =>
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
        new ToolError({
          toolName: call.function.name,
          cause: { reason: "invalid_args", parseError: String(cause) },
        }),
    });
    return { tool, args };
  });

/** Run the tool's Promise. Failures here are recoverable via retry (network
 *  flake, transient upstream). Caller wraps this in Effect.retry. */
export const executeTool = (
  tool: Tool,
  args: unknown,
  toolName: string,
): Effect.Effect<unknown, ToolError> =>
  Effect.tryPromise({
    try: () => tool.execute(args),
    catch: (cause) => new ToolError({ toolName, cause }),
  });

export type { ToolDefinition } from "./llm";
