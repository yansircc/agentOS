/**
 * Tool interface — public app-facing type.
 *
 * `Tool<A, R>` is Effect-native: admission is pure validation and execution
 * uses the Effect error/cancellation/runtime channel.
 *
 * `parseToolCall` and `executeTool` are split intentionally so the agent
 * loop can run parsing OUTSIDE the per-attempt retry (parse failure won't
 * recover by retrying the same args) and quota-grant + execute INSIDE the
 * retry (each retry independently grants). Critically, this ensures
 * invalid LLM-emitted args never consume quota.
 */

import { Effect, Option, Schema } from "effect";
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
import { isMaterialRequirement, type MaterialRequirement } from "./material-ref";
import type { ResolvedMaterial } from "./ref-resolver";
import type { QuotaSpec } from "./quota";
import { ensureAgentSchema, type AgentSchema } from "./agent-schema";

const TOOL_CONTRACT_BRAND = Symbol("@agent-os/kernel/ToolContract");
const DETERMINISTIC_TOOL_INVOCATION_BRAND = Symbol("@agent-os/kernel/DeterministicToolInvocation");

/**
 * Per-call execution context passed to a tool implementation.
 *
 * @agentosPrimitive primitive.kernel.ToolExecutionContext
 * @agentosInvariant invariant.algebra.type-or-boot-proof
 * @agentosDocs docs/concepts/tool-execution-domain.md
 * @public
 */
export interface ToolExecutionContext {
  readonly materials: ResolvedToolMaterials;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export type ResolvedToolMaterials = Readonly<Record<string, ResolvedMaterial>>;
export type ToolRequirements = never;
export type ToolEffect<R> = Effect.Effect<R, ToolError, ToolRequirements>;

export type ExecutionDomainKind = "host" | "sandbox" | "workspace" | "remote";

/**
 * Declared execution locus for an effectful tool.
 *
 * @agentosPrimitive primitive.kernel.ExecutionDomain
 * @agentosInvariant invariant.algebra.type-or-boot-proof
 * @agentosDocs docs/concepts/tool-execution-domain.md
 * @public
 */
export interface ExecutionDomain {
  readonly kind: ExecutionDomainKind;
  readonly ref: string;
  readonly envAllowlist?: ReadonlyArray<string>;
}

/**
 * Tool execution declaration: pure tools stay local, effectful tools name a domain.
 *
 * @agentosPrimitive primitive.kernel.ToolExecution
 * @agentosInvariant invariant.algebra.type-or-boot-proof
 * @agentosDocs docs/concepts/tool-execution-domain.md
 * @public
 */
export type ToolExecution =
  | { readonly kind: "pure" }
  | { readonly kind: "effectful"; readonly domain: ExecutionDomain };

/**
 * Boot-time execution-domain declaration consumed by registry validation.
 *
 * @agentosPrimitive primitive.kernel.ExecutionDomainDeclaration
 * @agentosInvariant invariant.algebra.type-or-boot-proof
 * @agentosDocs docs/concepts/tool-execution-domain.md
 * @public
 */
export interface ExecutionDomainDeclaration {
  readonly domain: ExecutionDomain;
}

/**
 * Boot-proof registry for all effectful tool execution domains.
 *
 * @agentosPrimitive primitive.kernel.ExecutionDomainRegistry
 * @agentosInvariant invariant.algebra.type-or-boot-proof
 * @agentosDocs docs/concepts/tool-execution-domain.md
 * @public
 */
export interface ExecutionDomainRegistry {
  readonly domains: ReadonlyArray<ExecutionDomainDeclaration>;
}

interface ToolContractShape {
  readonly toolId: string;
  readonly effectAuthorityRef: AuthorityRef;
  readonly requiredMaterials: ReadonlyArray<MaterialRequirement>;
  readonly originRef?: OriginRef;
  readonly roles: ReadonlyArray<Extract<ClaimRole, "generator" | "admitter">>;
}

/**
 * Admission and authority contract for a tool, excluding execution locus.
 *
 * @agentosPrimitive primitive.kernel.ToolContract
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/tool-execution-domain.md
 * @public
 */
export interface ToolContract extends ToolContractShape {
  readonly [TOOL_CONTRACT_BRAND]: true;
}

export interface DeterministicToolInvocation<A = unknown> {
  readonly name: string;
  readonly args: A;
  readonly [DETERMINISTIC_TOOL_INVOCATION_BRAND]: true;
}

export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: AgentSchema<unknown>;
  };
}

export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Input passed to non-LLM tool admission with claim, args, contract, and execution metadata.
 *
 * @agentosPrimitive primitive.kernel.ToolAdmitInput
 * @agentosInvariant invariant.algebra.type-or-boot-proof
 * @agentosDocs docs/concepts/tool-execution-domain.md
 * @public
 */
export interface ToolAdmitInput<A = unknown> {
  readonly claim: PreClaim;
  readonly args: A;
  readonly contract: ToolContract;
  readonly execution: ToolExecution;
  readonly toolName: string;
}

export type ToolAdmitter<A = unknown> = (
  input: ToolAdmitInput<A>,
) => Effect.Effect<AdmitVerdict, ToolError, never>;

export type ToolDecode<A = unknown> = (args: unknown) => A;
export type ToolExecute<A = unknown, R = unknown> = (
  args: A,
  ctx: ToolExecutionContext,
) => ToolEffect<R>;

/**
 * Public app-facing tool definition consumed by submit loops.
 *
 * @agentosPrimitive primitive.kernel.Tool
 * @agentosInvariant invariant.algebra.type-or-boot-proof
 * @agentosDocs docs/concepts/tool-execution-domain.md
 * @public
 */
export interface Tool<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  R = any,
> {
  readonly definition: ToolDefinition;
  readonly argsSchema: AgentSchema<A>;
  readonly decode: ToolDecode<A>;
  readonly execute: ToolExecute<A, R>;
  readonly admit: ToolAdmitter<A>;
  readonly execution: ToolExecution;
  readonly quota?: QuotaSpec;
  readonly contract: ToolContract;
}

export interface DefineToolSpec<S extends Schema.Schema.AnyNoContext, R> {
  readonly name: string;
  readonly description: string;
  readonly args: S;
  readonly execute: ToolExecute<Schema.Schema.Type<S>, R>;
  readonly quota?: QuotaSpec;
  readonly authority: string;
  readonly authorityId?: string;
  readonly authorityVersion?: string;
  readonly requiredMaterials?: ReadonlyArray<MaterialRequirement>;
  readonly originRef?: OriginRef;
  readonly admit: ToolAdmitter<Schema.Schema.Type<S>>;
  readonly execution: ToolExecution;
}

const makeToolContract = (shape: ToolContractShape): ToolContract =>
  Object.defineProperty({ ...shape }, TOOL_CONTRACT_BRAND, {
    value: true,
    enumerable: false,
  }) as ToolContract;

export const deterministicToolInvocation = <A>(
  name: string,
  args: A,
): DeterministicToolInvocation<A> =>
  Object.defineProperty({ name, args }, DETERMINISTIC_TOOL_INVOCATION_BRAND, {
    value: true,
    enumerable: false,
  }) as DeterministicToolInvocation<A>;

const hasToolContractBrand = (contract: ToolContract): boolean =>
  contract[TOOL_CONTRACT_BRAND] === true;

export const pureToolExecution = (): ToolExecution => ({ kind: "pure" });

export const effectfulToolExecution = (domain: ExecutionDomain): ToolExecution => ({
  kind: "effectful",
  domain,
});

const failToolDefinition = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const normalizeAdmitter = <A>(admit: ToolAdmitter<A>): ToolAdmitter<A> =>
  typeof admit === "function" ? admit : failToolDefinition("tool admitter is required");

const isExecutionDomainKind = (value: unknown): value is ExecutionDomainKind =>
  value === "host" || value === "sandbox" || value === "workspace" || value === "remote";

const isExecutionDomain = (value: unknown): value is ExecutionDomain => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly kind?: unknown;
    readonly ref?: unknown;
    readonly envAllowlist?: unknown;
  };
  if (!isExecutionDomainKind(candidate.kind)) return false;
  if (typeof candidate.ref !== "string" || candidate.ref.length === 0) return false;
  if (candidate.envAllowlist !== undefined) {
    if (!Array.isArray(candidate.envAllowlist)) return false;
    if (!candidate.envAllowlist.every((entry) => typeof entry === "string" && entry.length > 0)) {
      return false;
    }
  }
  return candidate.kind !== "host" || candidate.envAllowlist !== undefined;
};

const isToolExecution = (value: unknown): value is ToolExecution => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly kind?: unknown; readonly domain?: unknown };
  if (candidate.kind === "pure") return true;
  return candidate.kind === "effectful" && isExecutionDomain(candidate.domain);
};

const executionDomainKey = (domain: ExecutionDomain): string => `${domain.kind}:${domain.ref}`;

export type ExecutionDomainRegistryIssue =
  | {
      readonly kind: "invalid_declaration";
      readonly index: number;
    }
  | {
      readonly kind: "duplicate_declaration";
      readonly domain: ExecutionDomain;
    }
  | {
      readonly kind: "missing_declaration";
      readonly toolId: string;
      readonly domain: ExecutionDomain;
    };

export type ExecutionDomainRegistryValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<ExecutionDomainRegistryIssue>;
    };

export const validateExecutionDomainRegistry = (
  tools: Record<string, Tool>,
  registry: ExecutionDomainRegistry,
): ExecutionDomainRegistryValidation => {
  const issues: ExecutionDomainRegistryIssue[] = [];
  const declared = new Map<string, ExecutionDomain>();

  registry.domains.forEach((declaration, index) => {
    if (!isExecutionDomain(declaration.domain)) {
      issues.push({ kind: "invalid_declaration", index });
      return;
    }
    const key = executionDomainKey(declaration.domain);
    if (declared.has(key)) {
      issues.push({ kind: "duplicate_declaration", domain: declaration.domain });
      return;
    }
    declared.set(key, declaration.domain);
  });

  for (const tool of Object.values(tools)) {
    if (tool.execution.kind === "pure") continue;
    const domain = tool.execution.domain;
    if (!declared.has(executionDomainKey(domain))) {
      issues.push({
        kind: "missing_declaration",
        toolId: tool.contract.toolId,
        domain,
      });
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
};

export const defineTool = <S extends Schema.Schema.AnyNoContext, R>(
  spec: DefineToolSpec<S, R>,
): Tool<Schema.Schema.Type<S>, R> => {
  const argsSchema = ensureAgentSchema(spec.args);
  const toolId = spec.name;
  const admit = normalizeAdmitter(spec.admit);
  return {
    definition: {
      type: "function",
      function: {
        name: spec.name,
        description: spec.description,
        parameters: argsSchema as AgentSchema<unknown>,
      },
    },
    argsSchema,
    decode: argsSchema.decode,
    execute: spec.execute,
    admit,
    execution: spec.execution,
    quota: spec.quota,
    contract: makeToolContract({
      toolId,
      effectAuthorityRef: {
        authorityId: spec.authorityId ?? `tool:${toolId}`,
        authorityClass: spec.authority,
        ...(spec.authorityVersion === undefined ? {} : { version: spec.authorityVersion }),
      },
      requiredMaterials: spec.requiredMaterials ?? [],
      ...(spec.originRef === undefined ? {} : { originRef: spec.originRef }),
      roles: ["generator", "admitter"],
    }),
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
    }
  | {
      readonly kind: "missing_execution";
      readonly toolId: string;
    }
  | {
      readonly kind: "invalid_execution";
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
    if (!isAuthorityRef(contract.effectAuthorityRef)) {
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
    if ((tool as { readonly execution?: unknown }).execution === undefined) {
      issues.push({ kind: "missing_execution", toolId: contract.toolId });
    } else if (!isToolExecution(tool.execution)) {
      issues.push({ kind: "invalid_execution", toolId: contract.toolId });
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
  call: ToolCall,
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

/** Run the tool Effect. Failures here are recoverable via retry (network
 *  flake, transient upstream) when the caller wraps this in Effect.retry. */
export const executeTool = (
  tool: Tool,
  args: unknown,
  toolName: string,
  materials: ResolvedToolMaterials = {},
): Effect.Effect<unknown, ToolError> =>
  Effect.gen(function* () {
    const program = yield* Effect.try({
      try: () => tool.execute(args, { materials }),
      catch: (cause) => new ToolError({ toolName, cause }),
    });
    return yield* program;
  });

/**
 * Unsafe deterministic product-side tool execution.
 *
 * This bypasses submit(), admission, quota, retries, and ledger settlement.
 * Use only for explicit product-side actions where those envelope guarantees
 * are intentionally not required. Never use it for LLM-selected tool calls.
 */
export const unsafeRunToolByName = (
  tools: Record<string, Tool>,
  invocation: DeterministicToolInvocation,
): Effect.Effect<unknown, ToolError> =>
  Effect.gen(function* () {
    const tool = tools[invocation.name];
    if (tool === undefined) {
      return yield* new ToolError({
        toolName: invocation.name,
        cause: { reason: "unknown_tool" },
      });
    }
    const decoded = yield* decodeToolArgs(tool, invocation.args, invocation.name);
    return yield* executeTool(tool, decoded, invocation.name);
  });
