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
import {
  isAuthorityRef,
  isOriginRef,
  type AuthorityRef,
  type ClaimRole,
  type OriginRef,
} from "./effect-claim";
import type { LlmToolCall, ToolDefinition } from "./llm";
import type { QuotaSpec } from "./quota";

export interface ToolContract {
  readonly toolId: string;
  readonly authorityRef: AuthorityRef;
  readonly originRef?: OriginRef;
  readonly roles: ReadonlyArray<Extract<ClaimRole, "generator">>;
}

export interface Tool<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  R = any,
> {
  readonly definition: ToolDefinition;
  readonly execute: (args: A) => Promise<R>;
  readonly quota?: QuotaSpec;
  readonly contract?: ToolContract;
}

export interface RegisteredToolSpec<A, R> {
  readonly definition: ToolDefinition;
  readonly execute: (args: A) => Promise<R>;
  readonly quota?: QuotaSpec;
  readonly authorityClass: string;
  readonly authorityId?: string;
  readonly authorityVersion?: string;
  readonly originRef?: OriginRef;
}

export const defineRegisteredTool = <A, R>(
  spec: RegisteredToolSpec<A, R>,
): Tool<A, R> => {
  const toolId = spec.definition.function.name;
  return {
    definition: spec.definition,
    execute: spec.execute,
    ...(spec.quota === undefined ? {} : { quota: spec.quota }),
    contract: {
      toolId,
      authorityRef: {
        authorityId: spec.authorityId ?? `tool:${toolId}`,
        authorityClass: spec.authorityClass,
        ...(spec.authorityVersion === undefined
          ? {}
          : { version: spec.authorityVersion }),
      },
      ...(spec.originRef === undefined ? {} : { originRef: spec.originRef }),
      roles: ["generator"],
    },
  };
};

export type ToolRegistryIssue =
  | {
      readonly kind: "missing_contract";
      readonly registryKey: string;
      readonly toolName: string;
    }
  | {
      readonly kind: "registry_key_mismatch";
      readonly registryKey: string;
      readonly toolName: string;
    }
  | {
      readonly kind: "contract_tool_id_mismatch";
      readonly registryKey: string;
      readonly toolName: string;
      readonly toolId: string;
    }
  | {
      readonly kind: "duplicate_tool_id";
      readonly toolId: string;
    }
  | {
      readonly kind: "invalid_authority_ref";
      readonly toolId: string;
    }
  | {
      readonly kind: "invalid_origin_ref";
      readonly toolId: string;
    }
  | {
      readonly kind: "missing_generator_role";
      readonly toolId: string;
    };

export type ToolRegistryValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<ToolRegistryIssue>;
    };

export const validateToolRegistry = (
  tools: Record<string, Tool>,
): ToolRegistryValidation => {
  const issues: ToolRegistryIssue[] = [];
  const toolIds = new Set<string>();

  for (const [registryKey, tool] of Object.entries(tools)) {
    const toolName = tool.definition.function.name;
    if (registryKey !== toolName) {
      issues.push({ kind: "registry_key_mismatch", registryKey, toolName });
    }

    const contract = tool.contract;
    if (contract === undefined) {
      issues.push({ kind: "missing_contract", registryKey, toolName });
      continue;
    }

    if (contract.toolId !== toolName) {
      issues.push({
        kind: "contract_tool_id_mismatch",
        registryKey,
        toolName,
        toolId: contract.toolId,
      });
    }
    if (toolIds.has(contract.toolId)) {
      issues.push({ kind: "duplicate_tool_id", toolId: contract.toolId });
    }
    toolIds.add(contract.toolId);
    if (!isAuthorityRef(contract.authorityRef)) {
      issues.push({ kind: "invalid_authority_ref", toolId: contract.toolId });
    }
    if (
      contract.originRef !== undefined &&
      !isOriginRef(contract.originRef)
    ) {
      issues.push({ kind: "invalid_origin_ref", toolId: contract.toolId });
    }
    if (!contract.roles.includes("generator")) {
      issues.push({ kind: "missing_generator_role", toolId: contract.toolId });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true };
};

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
