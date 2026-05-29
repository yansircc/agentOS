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

import { Effect, JSONSchema, Option, Schema } from "effect";
import { ToolError } from "./errors";
import {
  type AdmitVerdict,
  isAuthorityRef,
  isOriginRef,
  type AuthorityRef,
  type ClaimRole,
  type OriginRef,
  type PreClaim,
} from "./effect-claim";
import type { LlmToolCall, ToolDefinition } from "./llm";
import { isMaterialRequirement, type MaterialRequirement } from "./material-ref";
import type { QuotaSpec } from "./quota";
import {
  toClosedJsonSchemaObject,
  validateAgainstSchema,
  type JsonSchemaObject,
} from "./json-schema";

const TOOL_CONTRACT_BRAND = Symbol("@agent-os/kernel/ToolContract");

interface ToolContractShape {
  readonly toolId: string;
  readonly authorityRef: AuthorityRef;
  readonly requiredMaterials: ReadonlyArray<MaterialRequirement>;
  readonly originRef?: OriginRef;
  readonly roles: ReadonlyArray<Extract<ClaimRole, "generator" | "admitter">>;
}

export interface ToolContract extends ToolContractShape {
  readonly [TOOL_CONTRACT_BRAND]: true;
}

export interface ToolAdmitInput<A = unknown> {
  readonly claim: PreClaim;
  readonly args: A;
  readonly contract: ToolContract;
  readonly toolName: string;
}

export type ToolAdmitter<A = unknown> = (
  input: ToolAdmitInput<A>,
) => AdmitVerdict | Promise<AdmitVerdict>;

export const permissiveToolAdmitter = <A>(_input: ToolAdmitInput<A>): AdmitVerdict => ({
  ok: true,
});

export type ToolDecode<A = unknown> = (args: unknown) => A;

export interface Tool<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  R = any,
> {
  readonly definition: ToolDefinition;
  readonly decode: ToolDecode<A>;
  readonly execute: (args: A) => Promise<R>;
  readonly admit: ToolAdmitter<A>;
  readonly quota?: QuotaSpec;
  readonly contract: ToolContract;
}

export interface RegisteredToolSpec<A, R> {
  readonly definition: ToolDefinition;
  readonly decode?: ToolDecode<A>;
  readonly execute: (args: A) => Promise<R>;
  readonly quota?: QuotaSpec;
  readonly authorityClass: string;
  readonly authorityId?: string;
  readonly authorityVersion?: string;
  readonly requiredMaterials?: ReadonlyArray<MaterialRequirement>;
  readonly originRef?: OriginRef;
  readonly admit: ToolAdmitter<A> | "allow";
}

export interface DefineToolSpec<S extends Schema.Schema.AnyNoContext, R> {
  readonly name: string;
  readonly description: string;
  readonly args: S;
  readonly execute: (args: Schema.Schema.Type<S>) => R | Promise<R>;
  readonly quota?: QuotaSpec;
  readonly authority: string;
  readonly authorityId?: string;
  readonly authorityVersion?: string;
  readonly requiredMaterials?: ReadonlyArray<MaterialRequirement>;
  readonly originRef?: OriginRef;
  readonly admit: ToolAdmitter<Schema.Schema.Type<S>> | "allow";
}

const makeToolContract = (shape: ToolContractShape): ToolContract =>
  Object.defineProperty({ ...shape }, TOOL_CONTRACT_BRAND, {
    value: true,
    enumerable: false,
  }) as ToolContract;

const hasToolContractBrand = (contract: ToolContract): boolean =>
  contract[TOOL_CONTRACT_BRAND] === true;

const failToolDefinition = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const failToolArgs = (toolId: string, violations: ReadonlyArray<string>): never =>
  Option.getOrThrowWith(
    Option.none(),
    () => new TypeError(`tool ${toolId} args violate schema: ${violations.join(",")}`),
  );

const normalizeAdmitter = <A>(admit: ToolAdmitter<A> | "allow"): ToolAdmitter<A> =>
  admit === "allow"
    ? permissiveToolAdmitter
    : typeof admit === "function"
      ? admit
      : failToolDefinition("tool admitter is required");

export const defineToolFromDefinition = <A, R>(spec: RegisteredToolSpec<A, R>): Tool<A, R> => {
  const toolId = spec.definition.function.name;
  const admit = normalizeAdmitter(spec.admit);
  const parameters = toClosedJsonSchemaObject(spec.definition.function.parameters);
  const schemaDecode = (args: unknown): A => {
    const violations = validateAgainstSchema(args, parameters);
    if (violations.length > 0) {
      return failToolArgs(toolId, violations);
    }
    return spec.decode === undefined ? (args as A) : spec.decode(args);
  };
  return {
    definition: {
      ...spec.definition,
      function: {
        ...spec.definition.function,
        parameters,
      },
    },
    decode: schemaDecode,
    execute: spec.execute,
    admit,
    ...(spec.quota === undefined ? {} : { quota: spec.quota }),
    contract: makeToolContract({
      toolId,
      authorityRef: {
        authorityId: spec.authorityId ?? `tool:${toolId}`,
        authorityClass: spec.authorityClass,
        ...(spec.authorityVersion === undefined ? {} : { version: spec.authorityVersion }),
      },
      requiredMaterials: spec.requiredMaterials ?? [],
      ...(spec.originRef === undefined ? {} : { originRef: spec.originRef }),
      roles: ["generator", "admitter"],
    }),
  };
};

const schemaToParameters = (schema: Schema.Schema.AnyNoContext): JsonSchemaObject =>
  toClosedJsonSchemaObject(JSONSchema.make(schema));

export const defineTool = <S extends Schema.Schema.AnyNoContext, R>(
  spec: DefineToolSpec<S, R>,
): Tool<Schema.Schema.Type<S>, Awaited<R>> => {
  const decode = Schema.decodeUnknownSync(spec.args);
  return defineToolFromDefinition<Schema.Schema.Type<S>, Awaited<R>>({
    definition: {
      type: "function",
      function: {
        name: spec.name,
        description: spec.description,
        parameters: schemaToParameters(spec.args),
      },
    },
    decode,
    execute: (args) => Promise.resolve(spec.execute(args)) as Promise<Awaited<R>>,
    quota: spec.quota,
    authorityClass: spec.authority,
    ...(spec.authorityId === undefined ? {} : { authorityId: spec.authorityId }),
    ...(spec.authorityVersion === undefined ? {} : { authorityVersion: spec.authorityVersion }),
    ...(spec.requiredMaterials === undefined ? {} : { requiredMaterials: spec.requiredMaterials }),
    ...(spec.originRef === undefined ? {} : { originRef: spec.originRef }),
    admit: spec.admit,
  });
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
      readonly kind: "invalid_required_material";
      readonly toolId: string;
    }
  | {
      readonly kind: "invalid_origin_ref";
      readonly toolId: string;
    }
  | {
      readonly kind: "unregistered_contract";
      readonly toolId: string;
    }
  | {
      readonly kind: "missing_generator_role";
      readonly toolId: string;
    }
  | {
      readonly kind: "missing_admitter";
      readonly toolId: string;
    }
  | {
      readonly kind: "missing_admitter_role";
      readonly toolId: string;
    };

export type ToolRegistryValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<ToolRegistryIssue>;
    };

export const validateToolRegistry = (tools: Record<string, Tool>): ToolRegistryValidation => {
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
      !Array.isArray(contract.requiredMaterials) ||
      !contract.requiredMaterials.every(isMaterialRequirement)
    ) {
      issues.push({ kind: "invalid_required_material", toolId: contract.toolId });
    }
    if (contract.originRef !== undefined && !isOriginRef(contract.originRef)) {
      issues.push({ kind: "invalid_origin_ref", toolId: contract.toolId });
    }
    if (!hasToolContractBrand(contract)) {
      issues.push({ kind: "unregistered_contract", toolId: contract.toolId });
    }
    if (!contract.roles.includes("generator")) {
      issues.push({ kind: "missing_generator_role", toolId: contract.toolId });
    }
    if (typeof tool.admit !== "function") {
      issues.push({ kind: "missing_admitter", toolId: contract.toolId });
    }
    if (!contract.roles.includes("admitter")) {
      issues.push({ kind: "missing_admitter_role", toolId: contract.toolId });
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
          cause: {
            reason: "invalid_args",
            parseError: cause instanceof Error ? cause.name : typeof cause,
          },
        }),
    });
    return { tool, args };
  });

export const decodeToolArgs = (
  tool: Tool,
  args: unknown,
  toolName: string,
): Effect.Effect<unknown, ToolError> =>
  Effect.try({
    try: () => tool.decode(args),
    catch: (cause) =>
      new ToolError({
        toolName,
        cause: {
          reason: "invalid_args",
          decodeError: cause instanceof Error ? cause.name : typeof cause,
        },
      }),
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
