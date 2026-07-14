import { isAgentSchema } from "@agent-os/core/agent-schema";
import type { AgentSchemaSpec } from "@agent-os/core/agent-schema";
import { WORKSPACE_TOOL_DEFAULT_DECLARATIONS } from "@agent-os/runtime/workspace-env";
import { cronMinuteExpression } from "@agent-os/runtime/schedule";
import {
  digestBytes,
  digestText,
  encodeBase64,
  GENERATED_LOAD_SKILL_TOOL_NAME,
  GENERATED_READ_SKILL_FILE_TOOL_NAME,
  isNonEmptyString,
  isRecord,
  type JsonRecord,
} from "./shared";

export const PRODUCT_AGENT_KIND = {
  CHAT: "chat",
  WORKSPACE: "workspace",
} as const;

export type ProductAgentKind = (typeof PRODUCT_AGENT_KIND)[keyof typeof PRODUCT_AGENT_KIND];

export type ProductFactKey = `/${string}`;

export type ProductOrigin = `path:${string}` | `author:${string}#${string}`;

export type ProductProvenance = Readonly<Record<ProductFactKey, ProductOrigin>>;

export interface AuthoredAgentTree {
  readonly files: ReadonlyArray<AuthoredAgentTreeFile>;
}

export type AuthoredAgentTreeFile =
  | AuthoredMarkdownFile
  | AuthoredResourceFile
  | AuthoredJsonFile
  | AuthoredMaterialResolverFile
  | AuthoredToolFile
  | AuthoredDynamicResolverFile
  | AuthoredChannelFile
  | AuthoredWorkflowFile
  | AuthoredScheduleFile;

export type AuthoredFileSourceKind = "regular" | "symlink" | "non_regular";

export interface AuthoredMarkdownFile {
  readonly path: string;
  readonly kind: "markdown";
  readonly text: string;
  readonly sourceKind?: AuthoredFileSourceKind;
}

export interface AuthoredResourceFile {
  readonly path: string;
  readonly kind: "resource";
  readonly bytes: Uint8Array;
  readonly sourceKind?: AuthoredFileSourceKind;
}

export interface AuthoredJsonFile {
  readonly path: string;
  readonly kind: "json";
  readonly value: unknown;
}

export interface AuthoredMaterialResolverFile {
  readonly path: string;
  readonly kind: "material-resolver";
  readonly sourceKind?: AuthoredFileSourceKind;
}

export type AuthoredToolEffect =
  | "material"
  | "workspace_mutation"
  | "network"
  | "dispatch"
  | "provider_call"
  | (string & {});

export interface AuthoredToolDeclaration {
  readonly executionDomain?: string;
  readonly interaction?: string;
  readonly materialRefs?: ReadonlyArray<string>;
  readonly effects?: ReadonlyArray<AuthoredToolEffect>;
  readonly receiptPolicy?: string;
}

export interface AuthoredToolFile {
  readonly path: string;
  readonly kind: "tool";
  readonly declaration?: AuthoredToolDeclaration;
}

export type DynamicCapabilitySlot = "tools" | "skills" | "instructions";

export interface AuthoredDynamicResolverDeclaration {
  readonly outputs?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
}

export interface AuthoredDynamicResolverFile {
  readonly path: string;
  readonly kind: "dynamic";
  readonly declaration?: AuthoredDynamicResolverDeclaration;
  readonly sourceKind?: AuthoredFileSourceKind;
}

export interface AuthoredChannelFile {
  readonly path: string;
  readonly kind: "channel";
  readonly sourceKind?: AuthoredFileSourceKind;
}

export interface AuthoredWorkflowFile {
  readonly path: string;
  readonly kind: "workflow";
  readonly sourceKind?: AuthoredFileSourceKind;
}

export interface AuthoredScheduleDeclaration {
  readonly cron?: unknown;
  readonly handler?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly kind?: unknown;
}

export interface AuthoredScheduleFile {
  readonly path: string;
  readonly kind: "schedule";
  readonly declaration?: AuthoredScheduleDeclaration;
  readonly sourceKind?: AuthoredFileSourceKind;
}

export interface CompiledAgentChannel {
  readonly name: string;
  readonly path: string;
  readonly origin: ProductOrigin;
}

export interface CompiledAgentWorkflow {
  readonly name: string;
  readonly path: string;
  readonly origin: ProductOrigin;
}

export interface CompiledAgentSchedule {
  readonly scheduleId: string;
  readonly cron: string;
  readonly path: string;
  readonly origin: ProductOrigin;
}

export interface CompiledAgentSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly digest: string;
  readonly text: string;
  readonly files: ReadonlyArray<CompiledAgentSkillFile>;
}

export interface CompiledAgentSkillFile {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly contentBase64: string;
}

export interface CompiledAgentInstructionFragment {
  readonly fragmentId: string;
  readonly path: string;
  readonly digest: string;
  readonly text: string;
  readonly origin: ProductOrigin;
}

export interface CompiledAgentDynamicResolver {
  readonly resolverId: string;
  readonly slot: DynamicCapabilitySlot;
  readonly path: string;
  readonly outputs: ReadonlyArray<string>;
  readonly origin: ProductOrigin;
}

export interface AuthoredAgentJson {
  readonly agentId: string;
  readonly kind: ProductAgentKind;
  readonly model?: string;
  readonly tools?: ReadonlyArray<string>;
  readonly outputSchema?: AgentSchemaSpec;
}

export interface ProductPlanAgent {
  readonly id: string;
  readonly kind: ProductAgentKind;
}

export interface ProductIntentInstructions {
  readonly path: "agent/instructions.md";
  readonly text: string;
}

export interface ProductPlanInstructions extends ProductIntentInstructions {
  readonly digest: string;
}

export interface ProductPlanToolAsset {
  readonly name: string;
  readonly path: string;
  readonly origin: ProductOrigin;
  readonly effects: ReadonlyArray<AuthoredToolEffect>;
  readonly materialRefs: ReadonlyArray<string>;
  readonly executionDomain?: string;
  readonly interaction?: string;
  readonly receiptPolicy?: string;
}

export interface ProductPlanAssets {
  readonly tools: ReadonlyArray<ProductPlanToolAsset>;
  readonly channels: ReadonlyArray<CompiledAgentChannel>;
  readonly workflows: ReadonlyArray<CompiledAgentWorkflow>;
  readonly schedules: ReadonlyArray<CompiledAgentSchedule>;
  readonly skills: ReadonlyArray<CompiledAgentSkill>;
  readonly instructionFragments: ReadonlyArray<CompiledAgentInstructionFragment>;
  readonly dynamicResolvers: ReadonlyArray<CompiledAgentDynamicResolver>;
}

export type ProductSymbolicRequirement =
  | { readonly kind: "model" }
  | { readonly kind: "workspace" }
  | { readonly kind: "material"; readonly ref: string; readonly tool: string }
  | { readonly kind: "execution-domain"; readonly ref: string; readonly tool: string }
  | { readonly kind: "interaction"; readonly ref: string; readonly tool: string };

export interface ProductIntent {
  readonly agent: ProductPlanAgent;
  readonly instructions: ProductIntentInstructions;
  readonly modelPreference?: string;
  readonly toolSelection?: ReadonlyArray<string>;
  readonly outputSchema?: AgentSchemaSpec;
  readonly assets: ProductPlanAssets;
  readonly provenance: ProductProvenance;
}

export interface ProductPlan {
  readonly agent: ProductPlanAgent;
  readonly instructions: ProductPlanInstructions;
  readonly modelPreference?: string;
  readonly toolSelection?: ReadonlyArray<string>;
  readonly outputSchema?: AgentSchemaSpec;
  readonly symbolicRequirements: ReadonlyArray<ProductSymbolicRequirement>;
  readonly assets: ProductPlanAssets;
  readonly provenance: ProductProvenance;
  readonly productDigest: string;
}

export type CompileProductPlanIssue =
  | { readonly kind: "unsupported_path"; readonly path: string; readonly reason: string }
  | { readonly kind: "duplicate_path"; readonly path: string; readonly existingPath: string }
  | {
      readonly kind: "duplicate_fact";
      readonly factKey: ProductFactKey;
      readonly origins: readonly [ProductOrigin, ProductOrigin];
    }
  | {
      readonly kind: "missing_required_file";
      readonly path: "agent/agent.json" | "agent/instructions.md";
    }
  | { readonly kind: "empty_instructions"; readonly path: string }
  | { readonly kind: "invalid_json_file"; readonly path: string; readonly reason: string }
  | {
      readonly kind: "invalid_authored_value";
      readonly path: string;
      readonly field: string;
      readonly reason: string;
    }
  | { readonly kind: "unknown_field"; readonly path: string; readonly field: string }
  | {
      readonly kind: "identity_field_forbidden";
      readonly path: string;
      readonly field: "id" | "name" | "kind";
    }
  | { readonly kind: "effectful_tool_missing_material"; readonly toolId: string }
  | { readonly kind: "effectful_tool_missing_execution_domain"; readonly toolId: string }
  | { readonly kind: "effectful_tool_missing_interaction"; readonly toolId: string }
  | { readonly kind: "effectful_tool_missing_receipt_policy"; readonly toolId: string }
  | {
      readonly kind: "unknown_product_tool";
      readonly path: string;
      readonly field: string;
      readonly toolId: string;
      readonly reason: "tool_not_found";
    }
  | {
      readonly kind: "skill_identity_mismatch";
      readonly path: string;
      readonly expectedName: string;
      readonly actualName: string;
    }
  | {
      readonly kind: "duplicate_skill";
      readonly name: string;
      readonly path: string;
      readonly existingPath: string;
    }
  | {
      readonly kind: "duplicate_instruction_fragment";
      readonly fragmentId: string;
      readonly path: string;
      readonly existingPath: string;
    }
  | {
      readonly kind: "duplicate_dynamic_resolver";
      readonly slot: DynamicCapabilitySlot;
      readonly resolverId: string;
      readonly path: string;
      readonly existingPath: string;
    }
  | {
      readonly kind: "dynamic_resolver_cross_slot_output";
      readonly path: string;
      readonly slot: DynamicCapabilitySlot;
      readonly outputSlot: DynamicCapabilitySlot;
    }
  | {
      readonly kind: "dynamic_resolver_unknown_target";
      readonly path: string;
      readonly slot: DynamicCapabilitySlot;
      readonly targetId: string;
    }
  | { readonly kind: "reserved_tool_name"; readonly path: string; readonly toolId: string }
  | { readonly kind: "runtime_fact_forbidden"; readonly path: string; readonly field: string };

export type CompileProductPlanResult =
  | { readonly ok: true; readonly value: ProductPlan }
  | { readonly ok: false; readonly issues: ReadonlyArray<CompileProductPlanIssue> };

interface Fact {
  readonly value: unknown;
  readonly origin: ProductOrigin;
}

interface CompilerState {
  readonly facts: Map<ProductFactKey, Fact>;
  readonly issues: CompileProductPlanIssue[];
  readonly pathKeys: Map<string, string>;
  readonly requiredFiles: Set<"agent/agent.json" | "agent/instructions.md">;
  readonly tools: Map<string, ProductPlanToolAsset>;
  readonly channels: Map<string, CompiledAgentChannel>;
  readonly workflows: Map<string, CompiledAgentWorkflow>;
  readonly schedules: Map<string, CompiledAgentSchedule>;
  readonly skills: Map<string, CompiledAgentSkill>;
  readonly skillSupportFiles: Map<string, CompiledAgentSkillFile[]>;
  readonly skillSupportByteTotals: Map<string, number>;
  readonly instructionFragments: Map<string, CompiledAgentInstructionFragment>;
  readonly dynamicResolvers: Map<string, CompiledAgentDynamicResolver>;
}

const SKILL_DESCRIPTION_MAX_BYTES = 240;
const SKILL_BODY_MAX_BYTES = 131_072;
const SKILL_SUPPORT_FILE_MAX_BYTES = 65_536;
const SKILL_SUPPORT_FILES_MAX_COUNT = 64;
const SKILL_SUPPORT_PACKAGE_MAX_BYTES = 262_144;
const skillNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const channelNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const workflowNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const scheduleSlugPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const instructionFragmentIdPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const dynamicResolverIdPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const authoredPath = (path: string): string =>
  path.startsWith("workflows/") ? path : `agent/${path}`;

const authorOrigin = (path: string, pointer: string): ProductOrigin =>
  `author:${authoredPath(path)}#${pointer}`;

const pathOrigin = (path: string): ProductOrigin => `path:${authoredPath(path)}`;

const invalidAuthoredValue = (
  state: CompilerState,
  path: string,
  field: string,
  reason: string,
): void => {
  state.issues.push({ kind: "invalid_authored_value", path, field, reason });
};

const parseStringField = (
  state: CompilerState,
  path: string,
  field: string,
  value: unknown,
): string | null => {
  if (!isNonEmptyString(value)) {
    invalidAuthoredValue(state, path, field, "non_empty_string_required");
    return null;
  }
  return value;
};

const utf8ByteLength = (value: string): number => textEncoder.encode(value).length;

const isSkillName = (value: string): boolean => skillNamePattern.test(value);

const isChannelName = (value: string): boolean => channelNamePattern.test(value);

const isWorkflowName = (value: string): boolean => workflowNamePattern.test(value);

const isScheduleSlug = (value: string): boolean => scheduleSlugPattern.test(value);

const isInstructionFragmentId = (value: string): boolean =>
  instructionFragmentIdPattern.test(value);

const isDynamicResolverId = (value: string): boolean => dynamicResolverIdPattern.test(value);

const decodeUtf8Bytes = (
  state: CompilerState,
  path: string,
  field: string,
  bytes: Uint8Array,
): string | null => {
  try {
    return textDecoder.decode(bytes);
  } catch {
    invalidAuthoredValue(state, path, field, "utf8_required");
    return null;
  }
};

const assertNoNulText = (
  state: CompilerState,
  path: string,
  field: string,
  text: string,
): boolean => {
  if (!text.includes("\0")) return true;
  invalidAuthoredValue(state, path, field, "nul_byte_forbidden");
  return false;
};

const assertRegularAuthoredSource = (
  state: CompilerState,
  path: string,
  sourceKind: AuthoredFileSourceKind | undefined,
): boolean => {
  const kind = sourceKind ?? "regular";
  if (kind === "regular") return true;
  state.issues.push({
    kind: "unsupported_path",
    path,
    reason: kind === "symlink" ? "symlink_forbidden" : "regular_file_required",
  });
  return false;
};

const parseSkillFrontmatterStringField = (
  state: CompilerState,
  path: string,
  field: string,
  value: unknown,
): string | null => {
  const parsed = parseStringField(state, path, field, value);
  if (parsed === null) return null;
  const trimmed = parsed.trim();
  if (trimmed.length === 0) {
    invalidAuthoredValue(state, path, field, "non_empty_string_required");
    return null;
  }
  return trimmed;
};

const parseSkillDescriptionField = (
  state: CompilerState,
  path: string,
  value: unknown,
): string | null => {
  const description = parseSkillFrontmatterStringField(
    state,
    path,
    "/frontmatter/description",
    value,
  );
  if (description === null) return null;
  if (utf8ByteLength(description) > SKILL_DESCRIPTION_MAX_BYTES) {
    invalidAuthoredValue(state, path, "/frontmatter/description", "skill_description_too_large");
    return null;
  }
  return description;
};

const parseOptionalStringField = (
  state: CompilerState,
  path: string,
  field: string,
  value: unknown,
): string | undefined => {
  if (value === undefined) return undefined;
  return parseStringField(state, path, field, value) ?? undefined;
};

const parseStringArrayField = (
  state: CompilerState,
  path: string,
  field: string,
  value: unknown,
): ReadonlyArray<string> | null => {
  if (!Array.isArray(value)) {
    invalidAuthoredValue(state, path, field, "array_required");
    return null;
  }
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = parseStringField(state, path, `${field}[${index}]`, value[index]);
    if (item !== null) out.push(item);
  }
  return out;
};

const parseExactStringArrayField = (
  state: CompilerState,
  path: string,
  field: string,
  value: unknown,
): ReadonlyArray<string> | null => {
  if (!Array.isArray(value)) {
    invalidAuthoredValue(state, path, field, "string_array_required");
    return null;
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = parseStringField(state, path, `${field}/${index}`, value[index]);
    if (item === null) continue;
    if (seen.has(item)) {
      invalidAuthoredValue(state, path, `${field}/${index}`, "duplicate_value");
      continue;
    }
    seen.add(item);
    values.push(item);
  }
  return values.sort((left, right) => left.localeCompare(right));
};

const parseOutputSchema = (
  state: CompilerState,
  path: string,
  value: unknown,
): AgentSchemaSpec | null => {
  if (!isRecord(value)) {
    invalidAuthoredValue(state, path, "/outputSchema", "object_required");
    return null;
  }
  assertAllowedFields(state, path, value, new Set(["agentSchema", "fingerprint"]));
  if (!isAgentSchema(value.agentSchema) || !isNonEmptyString(value.fingerprint)) {
    invalidAuthoredValue(state, path, "/outputSchema", "agent_schema_spec_invalid");
    return null;
  }
  return {
    agentSchema: value.agentSchema,
    fingerprint: value.fingerprint,
  };
};

const agentGrammarRoots = new Set([
  "agent.json",
  "channels",
  "domains",
  "instructions",
  "instructions.md",
  "interactions",
  "material-resolver.ts",
  "materials",
  "skills",
  "schedules",
  "tools",
]);

const stripAgentPrefix = (path: string): string => {
  if (!path.startsWith("agent/")) return path;
  const rest = path.slice("agent/".length);
  const root = rest.split("/")[0] ?? "";
  return agentGrammarRoots.has(root) ? rest : path;
};

const normalizePath = (path: string): string | null => {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return null;
  const parts = stripAgentPrefix(path).split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return parts.join("/");
};

const registerPath = (state: CompilerState, path: string): string | null => {
  const normalized = normalizePath(path);
  if (normalized === null) {
    state.issues.push({ kind: "unsupported_path", path, reason: "path_not_normalized" });
    return null;
  }
  const lower = normalized.toLocaleLowerCase();
  const existing = state.pathKeys.get(lower);
  if (existing !== undefined) {
    state.issues.push({ kind: "duplicate_path", path: normalized, existingPath: existing });
    return null;
  }
  state.pathKeys.set(lower, normalized);
  return normalized;
};

const putFact = (
  state: CompilerState,
  factKey: ProductFactKey,
  value: unknown,
  origin: ProductOrigin,
): void => {
  const existing = state.facts.get(factKey);
  if (existing === undefined) {
    state.facts.set(factKey, { value, origin });
    return;
  }
  state.issues.push({ kind: "duplicate_fact", factKey, origins: [existing.origin, origin] });
};

const putAuthored = (
  state: CompilerState,
  factKey: ProductFactKey,
  value: unknown,
  origin: ProductOrigin,
): void => putFact(state, factKey, value, origin);

const assertAllowedFields = (
  state: CompilerState,
  path: string,
  value: JsonRecord,
  allowed: ReadonlySet<string>,
): void => {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) state.issues.push({ kind: "unknown_field", path, field });
  }
};

const assertNoRuntimeFactFields = (state: CompilerState, path: string, value: JsonRecord): void => {
  const forbidden = new Set([
    "continuation",
    "continuationRef",
    "inputRequestRef",
    "snapshot",
    "actualTriggerTime",
    "resumePayload",
    "resolvedMaterial",
    "secret",
    "credential",
  ]);
  const visit = (record: JsonRecord, fieldPrefix: string): void => {
    for (const [field, child] of Object.entries(record)) {
      const fieldPath = fieldPrefix.length === 0 ? field : `${fieldPrefix}.${field}`;
      if (forbidden.has(field)) {
        state.issues.push({ kind: "runtime_fact_forbidden", path, field: fieldPath });
      }
      if (isRecord(child)) visit(child, fieldPath);
      if (Array.isArray(child)) {
        for (let index = 0; index < child.length; index += 1) {
          const item = child[index];
          if (isRecord(item)) visit(item, `${fieldPath}[${index}]`);
        }
      }
    }
  };
  visit(value, "");
};

const assertNoPathIdentityFields = (
  state: CompilerState,
  path: string,
  value: JsonRecord,
): void => {
  for (const field of ["id", "name"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      state.issues.push({ kind: "identity_field_forbidden", path, field });
    }
  }
};

const toolAllowedFields = new Set([
  "executionDomain",
  "interaction",
  "materialRefs",
  "effects",
  "receiptPolicy",
]);

const dynamicResolverAllowedFields = new Set(["outputs", "id", "name"]);
const dynamicOutputSlots: ReadonlyArray<DynamicCapabilitySlot> = [
  "tools",
  "skills",
  "instructions",
];

const agentAllowedFields = new Set(["agentId", "kind", "model", "tools", "outputSchema"]);

const materialEffectNames = new Set(["material", "provider_call"]);
const workspaceDefaultToolNames = new Set<string>(
  WORKSPACE_TOOL_DEFAULT_DECLARATIONS.map((tool) => tool.name),
);

const isEffectfulTool = (tool: Pick<ProductPlanToolAsset, "effects" | "materialRefs">): boolean =>
  (tool.effects?.length ?? 0) > 0 || (tool.materialRefs?.length ?? 0) > 0;

const requiresMaterial = (tool: Pick<ProductPlanToolAsset, "effects" | "materialRefs">): boolean =>
  tool.materialRefs.length > 0 ||
  (tool.effects?.some((effect) => materialEffectNames.has(effect)) ?? false);

const recordToolFacts = (
  state: CompilerState,
  toolId: string,
  path: string,
  declaration: AuthoredToolDeclaration,
  originFor: (field: string) => ProductOrigin,
): void => {
  const localIssueCount = state.issues.length;
  const declarationRecord = declaration as JsonRecord;
  assertNoPathIdentityFields(state, path, declarationRecord);
  if (Object.prototype.hasOwnProperty.call(declarationRecord, "kind")) {
    state.issues.push({ kind: "identity_field_forbidden", path, field: "kind" });
  }
  assertAllowedFields(state, path, declarationRecord, toolAllowedFields);
  assertNoRuntimeFactFields(state, path, declarationRecord);
  const executionDomain = parseOptionalStringField(
    state,
    path,
    "/executionDomain",
    declaration.executionDomain,
  );
  const interaction = parseOptionalStringField(
    state,
    path,
    "/interaction",
    declaration.interaction,
  );
  const materialRefs =
    declaration.materialRefs === undefined
      ? []
      : parseExactStringArrayField(state, path, "/materialRefs", declaration.materialRefs);
  const effects =
    declaration.effects === undefined
      ? []
      : parseExactStringArrayField(state, path, "/effects", declaration.effects);
  const receiptPolicy = parseOptionalStringField(
    state,
    path,
    "/receiptPolicy",
    declaration.receiptPolicy,
  );
  if (materialRefs === null || effects === null || state.issues.length > localIssueCount) return;
  const asset: ProductPlanToolAsset = {
    name: toolId,
    path: authoredPath(path),
    origin: pathOrigin(path),
    effects: effects as ReadonlyArray<AuthoredToolEffect>,
    materialRefs,
    ...(executionDomain === undefined ? {} : { executionDomain }),
    ...(interaction === undefined ? {} : { interaction }),
    ...(receiptPolicy === undefined ? {} : { receiptPolicy }),
  };
  state.tools.set(toolId, asset);
  putAuthored(state, `/assets/tools/${toolId}`, authoredPath(path), pathOrigin(path));
  if (executionDomain !== undefined) {
    putAuthored(
      state,
      `/assets/tools/${toolId}/executionDomain`,
      executionDomain,
      originFor("executionDomain"),
    );
  }
  if (interaction !== undefined) {
    putAuthored(
      state,
      `/assets/tools/${toolId}/interaction`,
      interaction,
      originFor("interaction"),
    );
  }
  if (materialRefs.length > 0) {
    putAuthored(
      state,
      `/assets/tools/${toolId}/materialRefs`,
      materialRefs,
      originFor("materialRefs"),
    );
  }
  if (effects.length > 0) {
    putAuthored(state, `/assets/tools/${toolId}/effects`, effects, originFor("effects"));
  }
  if (receiptPolicy !== undefined) {
    putAuthored(
      state,
      `/assets/tools/${toolId}/receiptPolicy`,
      receiptPolicy,
      originFor("receiptPolicy"),
    );
  }
};

const recordAgentJson = (state: CompilerState, path: string, value: unknown): void => {
  if (!isRecord(value)) {
    state.issues.push({ kind: "invalid_json_file", path, reason: "agent_json_not_object" });
    return;
  }
  assertAllowedFields(state, path, value, agentAllowedFields);
  assertNoRuntimeFactFields(state, path, value);
  const agentId =
    value.agentId === undefined
      ? (invalidAuthoredValue(state, path, "/agentId", "required"), null)
      : parseStringField(state, path, "/agentId", value.agentId);
  const kind =
    value.kind === undefined
      ? (invalidAuthoredValue(state, path, "/kind", "required"), null)
      : value.kind === PRODUCT_AGENT_KIND.CHAT || value.kind === PRODUCT_AGENT_KIND.WORKSPACE
        ? value.kind
        : (invalidAuthoredValue(state, path, "/kind", "product_kind_invalid"), null);
  const model = parseOptionalStringField(state, path, "/model", value.model);
  const tools =
    value.tools === undefined
      ? undefined
      : parseExactStringArrayField(state, path, "/tools", value.tools);
  const outputSchema =
    value.outputSchema === undefined
      ? undefined
      : parseOutputSchema(state, path, value.outputSchema);
  if (agentId !== null) putAuthored(state, "/agent/id", agentId, authorOrigin(path, "/agentId"));
  if (kind !== null) putAuthored(state, "/agent/kind", kind, authorOrigin(path, "/kind"));
  if (model !== undefined) {
    putAuthored(state, "/modelPreference", model, authorOrigin(path, "/model"));
  }
  if (tools !== undefined && tools !== null) {
    putAuthored(state, "/toolSelection", tools, authorOrigin(path, "/tools"));
  }
  if (outputSchema !== undefined && outputSchema !== null) {
    putAuthored(state, "/outputSchema", outputSchema, authorOrigin(path, "/outputSchema"));
  }
};

const recordJsonFile = (state: CompilerState, path: string, value: unknown): void => {
  if (path === "agent.json") {
    state.requiredFiles.add("agent/agent.json");
    recordAgentJson(state, path, value);
    return;
  }
  state.issues.push({ kind: "unsupported_path", path, reason: "json_path_not_in_grammar" });
};

const skillIdentityForPath = (path: string): string | null => {
  const parts = path.split("/");
  if (parts[0] !== "skills") return null;
  if (parts.length === 2 && parts[1]?.endsWith(".md")) {
    const name = parts[1].slice(0, -".md".length);
    return isSkillName(name) ? name : null;
  }
  if (parts.length === 3 && parts[2] === "SKILL.md") {
    const name = parts[1] ?? "";
    return isSkillName(name) ? name : null;
  }
  return null;
};

const isPackagedSkillPath = (skill: CompiledAgentSkill): boolean =>
  skill.path === `agent/skills/${skill.name}/SKILL.md`;

const skillSupportPathForPath = (
  path: string,
): { readonly skillName: string; readonly packagePath: string } | null => {
  const parts = path.split("/");
  if (parts[0] !== "skills" || parts.length < 3) return null;
  const skillName = parts[1] ?? "";
  if (!isSkillName(skillName)) return null;
  return {
    skillName,
    packagePath: parts.slice(2).join("/"),
  };
};

const instructionFragmentIdForPath = (path: string): string | null => {
  const parts = path.split("/");
  if (parts.length !== 2 || parts[0] !== "instructions" || !parts[1]?.endsWith(".md")) {
    return null;
  }
  const fragmentId = parts[1].slice(0, -".md".length);
  return isInstructionFragmentId(fragmentId) ? fragmentId : null;
};

const dynamicResolverIdentityForPath = (
  path: string,
): { readonly slot: DynamicCapabilitySlot; readonly resolverId: string } | null => {
  const parts = path.split("/");
  if (parts.length !== 2 || !parts[1]?.endsWith(".dynamic.ts")) return null;
  const slot = parts[0];
  if (slot !== "tools" && slot !== "skills" && slot !== "instructions") return null;
  const resolverId = parts[1].slice(0, -".dynamic.ts".length);
  if (!isDynamicResolverId(resolverId)) return null;
  return { slot, resolverId };
};

const stripYamlQuotes = (value: string): string => {
  if (
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) &&
    value.length >= 2
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const parseSkillFrontmatter = (
  state: CompilerState,
  path: string,
  text: string,
): { readonly name: string; readonly description: string; readonly body: string } | null => {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    invalidAuthoredValue(state, path, "/frontmatter", "frontmatter_required");
    return null;
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    invalidAuthoredValue(state, path, "/frontmatter", "frontmatter_not_closed");
    return null;
  }
  const issueCount = state.issues.length;
  const fields: Record<string, string> = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (match === null) {
      invalidAuthoredValue(state, path, `/frontmatter/${index}`, "frontmatter_line_invalid");
      continue;
    }
    const [, key, rawValue] = match;
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      invalidAuthoredValue(state, path, `/frontmatter/${key}`, "frontmatter_field_duplicate");
      continue;
    }
    fields[key] = stripYamlQuotes(rawValue.trim());
  }
  assertAllowedFields(state, path, fields, new Set(["name", "description"]));
  const name = parseSkillFrontmatterStringField(state, path, "/frontmatter/name", fields.name);
  const description = parseSkillDescriptionField(state, path, fields.description);
  if (name === null || description === null || state.issues.length > issueCount) return null;
  return {
    name,
    description,
    body: lines
      .slice(end + 1)
      .join("\n")
      .replace(/^\n/u, "")
      .replace(/\s+$/u, ""),
  };
};

const recordInstructionFragmentFile = (
  state: CompilerState,
  path: string,
  fragmentId: string,
  text: string,
  sourceKind: AuthoredFileSourceKind | undefined,
): void => {
  if (!assertRegularAuthoredSource(state, path, sourceKind)) return;
  if (text.trim().length === 0) {
    invalidAuthoredValue(state, path, "/body", "instruction_fragment_empty");
    return;
  }
  if (!assertNoNulText(state, path, "/body", text)) return;
  const existing = state.instructionFragments.get(fragmentId);
  if (existing !== undefined) {
    state.issues.push({
      kind: "duplicate_instruction_fragment",
      fragmentId,
      path,
      existingPath: existing.path,
    });
    return;
  }
  state.instructionFragments.set(fragmentId, {
    fragmentId,
    path: authoredPath(path),
    digest: digestText(text),
    text,
    origin: pathOrigin(path),
  });
};

const recordSkillFile = (
  state: CompilerState,
  path: string,
  expectedName: string,
  text: string,
  sourceKind: AuthoredFileSourceKind | undefined,
): void => {
  if (!isSkillName(expectedName)) {
    state.issues.push({ kind: "unsupported_path", path, reason: "skill_name_invalid" });
    return;
  }
  if (!assertRegularAuthoredSource(state, path, sourceKind)) return;
  const parsed = parseSkillFrontmatter(state, path, text);
  if (parsed === null) return;
  if (!isSkillName(parsed.name)) {
    invalidAuthoredValue(state, path, "/frontmatter/name", "skill_name_invalid");
    return;
  }
  if (parsed.name !== expectedName) {
    state.issues.push({
      kind: "skill_identity_mismatch",
      path,
      expectedName,
      actualName: parsed.name,
    });
    return;
  }
  if (utf8ByteLength(parsed.body) > SKILL_BODY_MAX_BYTES) {
    invalidAuthoredValue(state, path, "/body", "skill_body_too_large");
    return;
  }
  if (!assertNoNulText(state, path, "/body", parsed.body)) return;
  const existing = state.skills.get(expectedName);
  if (existing !== undefined) {
    state.issues.push({
      kind: "duplicate_skill",
      name: expectedName,
      path,
      existingPath: existing.path,
    });
    return;
  }
  state.skills.set(expectedName, {
    name: expectedName,
    description: parsed.description,
    path: authoredPath(path),
    digest: digestText(parsed.body),
    text: parsed.body,
    files: [],
  });
};

const recordSkillSupportFile = (
  state: CompilerState,
  path: string,
  supportPath: { readonly skillName: string; readonly packagePath: string },
  bytes: Uint8Array,
  sourceKind: AuthoredFileSourceKind | undefined,
): void => {
  if (!assertRegularAuthoredSource(state, path, sourceKind)) return;
  if (bytes.byteLength > SKILL_SUPPORT_FILE_MAX_BYTES) {
    invalidAuthoredValue(state, path, "/bytes", "skill_file_too_large");
    return;
  }
  const files = state.skillSupportFiles.get(supportPath.skillName) ?? [];
  if (files.length >= SKILL_SUPPORT_FILES_MAX_COUNT) {
    invalidAuthoredValue(state, path, "/bytes", "skill_package_too_many_files");
    return;
  }
  const currentBytes = state.skillSupportByteTotals.get(supportPath.skillName) ?? 0;
  if (currentBytes + bytes.byteLength > SKILL_SUPPORT_PACKAGE_MAX_BYTES) {
    invalidAuthoredValue(state, path, "/bytes", "skill_package_too_large");
    return;
  }
  files.push({
    path: supportPath.packagePath,
    digest: digestBytes(bytes),
    bytes: bytes.byteLength,
    contentBase64: encodeBase64(bytes),
  });
  state.skillSupportFiles.set(supportPath.skillName, files);
  state.skillSupportByteTotals.set(supportPath.skillName, currentBytes + bytes.byteLength);
};

const recordMarkdownFile = (
  state: CompilerState,
  path: string,
  text: string,
  sourceKind?: AuthoredFileSourceKind,
): void => {
  const skillName = skillIdentityForPath(path);
  if (path.startsWith("skills/")) {
    if (skillName === null) {
      state.issues.push({ kind: "unsupported_path", path, reason: "skill_path_not_in_grammar" });
      return;
    }
    recordSkillFile(state, path, skillName, text, sourceKind);
    return;
  }
  if (path.startsWith("instructions/")) {
    const fragmentId = instructionFragmentIdForPath(path);
    if (fragmentId === null) {
      state.issues.push({
        kind: "unsupported_path",
        path,
        reason: "instruction_fragment_path_not_in_grammar",
      });
      return;
    }
    recordInstructionFragmentFile(state, path, fragmentId, text, sourceKind);
    return;
  }
  if (path !== "instructions.md") {
    state.issues.push({ kind: "unsupported_path", path, reason: "markdown_path_not_in_grammar" });
    return;
  }
  state.requiredFiles.add("agent/instructions.md");
  if (!assertRegularAuthoredSource(state, path, sourceKind)) return;
  if (text.trim().length === 0) state.issues.push({ kind: "empty_instructions", path });
  if (!assertNoNulText(state, path, "/body", text)) return;
  const instructions: ProductPlanInstructions = {
    path: "agent/instructions.md",
    digest: digestText(text),
    text,
  };
  putAuthored(state, "/instructions", instructions, pathOrigin(path));
};

const recordResourceFile = (
  state: CompilerState,
  path: string,
  bytes: Uint8Array,
  sourceKind?: AuthoredFileSourceKind,
): void => {
  const supportPath = skillSupportPathForPath(path);
  if (supportPath === null) {
    state.issues.push({ kind: "unsupported_path", path, reason: "resource_path_not_in_grammar" });
    return;
  }
  recordSkillSupportFile(state, path, supportPath, bytes, sourceKind);
};

const recordMaterialResolverFile = (
  state: CompilerState,
  path: string,
  _sourceKind?: AuthoredFileSourceKind,
): void => {
  state.issues.push({
    kind: "unsupported_path",
    path,
    reason: "material_resolver_is_deployment_owned",
  });
};

const recordToolFile = (
  state: CompilerState,
  path: string,
  declaration: AuthoredToolDeclaration | undefined,
): void => {
  const parts = path.split("/");
  if (parts.length !== 2 || parts[0] !== "tools" || !parts[1]?.endsWith(".ts")) {
    state.issues.push({ kind: "unsupported_path", path, reason: "tool_path_not_in_grammar" });
    return;
  }
  if (parts[1].endsWith(".dynamic.ts")) {
    state.issues.push({ kind: "unsupported_path", path, reason: "dynamic_path_not_in_grammar" });
    return;
  }
  const toolId = parts[1].slice(0, -".ts".length);
  if (toolId.length === 0) {
    state.issues.push({ kind: "unsupported_path", path, reason: "empty_path_identity" });
    return;
  }
  if (toolId === GENERATED_LOAD_SKILL_TOOL_NAME || toolId === GENERATED_READ_SKILL_FILE_TOOL_NAME) {
    state.issues.push({ kind: "reserved_tool_name", path, toolId });
    return;
  }
  recordToolFacts(state, toolId, path, declaration ?? {}, (field) => authorOrigin(path, field));
};

const parseDynamicOutputs = (
  state: CompilerState,
  path: string,
  slot: DynamicCapabilitySlot,
  value: unknown,
): ReadonlyArray<string> | null => {
  if (!isRecord(value)) {
    invalidAuthoredValue(state, path, "/outputs", "object_required");
    return null;
  }
  for (const outputSlot of Object.keys(value)) {
    if (!dynamicOutputSlots.includes(outputSlot as DynamicCapabilitySlot)) {
      state.issues.push({ kind: "unknown_field", path, field: `/outputs/${outputSlot}` });
      continue;
    }
    if (outputSlot !== slot) {
      state.issues.push({
        kind: "dynamic_resolver_cross_slot_output",
        path,
        slot,
        outputSlot: outputSlot as DynamicCapabilitySlot,
      });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, slot)) {
    invalidAuthoredValue(state, path, `/outputs/${slot}`, "dynamic_resolver_output_required");
    return null;
  }
  return parseStringArrayField(state, path, `/outputs/${slot}`, value[slot]);
};

const recordDynamicResolverFile = (
  state: CompilerState,
  path: string,
  declaration: AuthoredDynamicResolverDeclaration | undefined,
  sourceKind: AuthoredFileSourceKind | undefined,
): void => {
  const identity = dynamicResolverIdentityForPath(path);
  if (identity === null) {
    state.issues.push({ kind: "unsupported_path", path, reason: "dynamic_path_not_in_grammar" });
    return;
  }
  if (!assertRegularAuthoredSource(state, path, sourceKind)) return;
  if (!isRecord(declaration)) {
    invalidAuthoredValue(state, path, "/", "dynamic_resolver_declaration_object_required");
    return;
  }
  const localIssueCount = state.issues.length;
  assertNoPathIdentityFields(state, path, declaration);
  assertAllowedFields(state, path, declaration, dynamicResolverAllowedFields);
  assertNoRuntimeFactFields(state, path, declaration);
  const outputs = parseDynamicOutputs(state, path, identity.slot, declaration.outputs);
  if (outputs === null || state.issues.length > localIssueCount) return;
  const key = `${identity.slot}/${identity.resolverId}`;
  const existing = state.dynamicResolvers.get(key);
  if (existing !== undefined) {
    state.issues.push({
      kind: "duplicate_dynamic_resolver",
      slot: identity.slot,
      resolverId: identity.resolverId,
      path,
      existingPath: existing.path,
    });
    return;
  }
  state.dynamicResolvers.set(key, {
    resolverId: identity.resolverId,
    slot: identity.slot,
    path: authoredPath(path),
    outputs,
    origin: pathOrigin(path),
  });
};

const recordChannelFile = (
  state: CompilerState,
  path: string,
  sourceKind: AuthoredFileSourceKind | undefined,
): void => {
  const parts = path.split("/");
  if (parts.length !== 2 || parts[0] !== "channels" || !parts[1]?.endsWith(".ts")) {
    state.issues.push({ kind: "unsupported_path", path, reason: "channel_path_not_in_grammar" });
    return;
  }
  const name = parts[1].slice(0, -".ts".length);
  if (name.length === 0) {
    state.issues.push({ kind: "unsupported_path", path, reason: "empty_path_identity" });
    return;
  }
  if (!isChannelName(name)) {
    state.issues.push({ kind: "unsupported_path", path, reason: "channel_name_invalid" });
    return;
  }
  if (!assertRegularAuthoredSource(state, path, sourceKind)) return;
  state.channels.set(name, {
    name,
    path: authoredPath(path),
    origin: pathOrigin(path),
  });
};

const recordWorkflowFile = (
  state: CompilerState,
  path: string,
  sourceKind: AuthoredFileSourceKind | undefined,
): void => {
  const parts = path.split("/");
  if (parts.length !== 2 || parts[0] !== "workflows" || !parts[1]?.endsWith(".ts")) {
    state.issues.push({ kind: "unsupported_path", path, reason: "workflow_path_not_in_grammar" });
    return;
  }
  const name = parts[1].slice(0, -".ts".length);
  if (name.length === 0) {
    state.issues.push({ kind: "unsupported_path", path, reason: "empty_path_identity" });
    return;
  }
  if (!isWorkflowName(name)) {
    state.issues.push({ kind: "unsupported_path", path, reason: "workflow_name_invalid" });
    return;
  }
  if (!assertRegularAuthoredSource(state, path, sourceKind)) return;
  state.workflows.set(name, {
    name,
    path: authoredPath(path),
    origin: pathOrigin(path),
  });
};

const scheduleAllowedFields = new Set(["cron", "handler", "id", "name", "kind"]);

const scheduleIdFromPath = (state: CompilerState, path: string): string | null => {
  const parts = path.split("/");
  if (parts.length < 2 || parts[0] !== "schedules" || !parts[parts.length - 1]?.endsWith(".ts")) {
    state.issues.push({ kind: "unsupported_path", path, reason: "schedule_path_not_in_grammar" });
    return null;
  }
  const slugs = [...parts.slice(1, -1), parts[parts.length - 1].slice(0, -".ts".length)];
  if (slugs.some((slug) => slug.length === 0)) {
    state.issues.push({ kind: "unsupported_path", path, reason: "empty_path_identity" });
    return null;
  }
  if (slugs.includes("subagents")) {
    state.issues.push({
      kind: "unsupported_path",
      path,
      reason: "subagent_schedule_directory_forbidden",
    });
    return null;
  }
  const invalid = slugs.find((slug) => !isScheduleSlug(slug));
  if (invalid !== undefined) {
    state.issues.push({ kind: "unsupported_path", path, reason: "schedule_slug_invalid" });
    return null;
  }
  return slugs.join("/");
};

const recordScheduleFile = (
  state: CompilerState,
  path: string,
  declaration: AuthoredScheduleDeclaration | undefined,
  sourceKind: AuthoredFileSourceKind | undefined,
): void => {
  const scheduleId = scheduleIdFromPath(state, path);
  if (scheduleId === null) return;
  if (!assertRegularAuthoredSource(state, path, sourceKind)) return;
  if (!isRecord(declaration)) {
    invalidAuthoredValue(state, path, "/", "schedule_declaration_object_required");
    return;
  }
  const declarationRecord = declaration as JsonRecord;
  const localIssueCount = state.issues.length;
  assertNoPathIdentityFields(state, path, declarationRecord);
  if (Object.prototype.hasOwnProperty.call(declarationRecord, "kind")) {
    state.issues.push({ kind: "identity_field_forbidden", path, field: "kind" });
  }
  assertAllowedFields(state, path, declarationRecord, scheduleAllowedFields);
  assertNoRuntimeFactFields(state, path, declarationRecord);
  if (state.issues.length > localIssueCount) return;
  if (typeof declaration.cron !== "string") {
    invalidAuthoredValue(state, path, "/cron", "cron_string_required");
    return;
  }
  if (typeof declaration.handler !== "function") {
    invalidAuthoredValue(state, path, "/handler", "schedule_handler_function_required");
    return;
  }
  let cron: string;
  try {
    cron = cronMinuteExpression(declaration.cron);
  } catch {
    invalidAuthoredValue(state, path, "/cron", "cron_minute_expression_invalid");
    return;
  }
  if (state.schedules.has(scheduleId)) {
    const existing = state.schedules.get(scheduleId);
    state.issues.push({
      kind: "duplicate_path",
      path: authoredPath(path),
      existingPath: existing?.path ?? authoredPath(path),
    });
    return;
  }
  state.schedules.set(scheduleId, {
    scheduleId,
    cron,
    path: authoredPath(path),
    origin: pathOrigin(path),
  });
};

const factValue = <A>(state: CompilerState, factKey: ProductFactKey): A | undefined =>
  state.facts.get(factKey)?.value as A | undefined;

const validateRequiredFiles = (state: CompilerState): void => {
  for (const path of ["agent/agent.json", "agent/instructions.md"] as const) {
    if (!state.requiredFiles.has(path)) state.issues.push({ kind: "missing_required_file", path });
  }
};

const validateTools = (state: CompilerState): void => {
  for (const tool of [...state.tools.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!isEffectfulTool(tool)) continue;
    if (requiresMaterial(tool) && tool.materialRefs.length === 0) {
      state.issues.push({ kind: "effectful_tool_missing_material", toolId: tool.name });
    }
    if (tool.executionDomain === undefined) {
      state.issues.push({ kind: "effectful_tool_missing_execution_domain", toolId: tool.name });
    }
    if (tool.interaction === undefined) {
      state.issues.push({ kind: "effectful_tool_missing_interaction", toolId: tool.name });
    }
    if (tool.receiptPolicy === undefined) {
      state.issues.push({ kind: "effectful_tool_missing_receipt_policy", toolId: tool.name });
    }
  }
};

const availableProductToolIds = (
  kind: ProductAgentKind | undefined,
  authoredToolIds: Iterable<string>,
): ReadonlySet<string> => {
  const available = new Set(authoredToolIds);
  if (kind === PRODUCT_AGENT_KIND.WORKSPACE) {
    for (const toolId of workspaceDefaultToolNames) available.add(toolId);
  }
  return available;
};

const effectiveProductToolIds = (
  kind: ProductAgentKind | undefined,
  toolSelection: ReadonlyArray<string> | undefined,
  authoredToolIds: Iterable<string>,
): ReadonlySet<string> =>
  toolSelection === undefined
    ? availableProductToolIds(kind, authoredToolIds)
    : new Set(toolSelection);

const validateToolNamespace = (state: CompilerState): void => {
  if (factValue<ProductAgentKind>(state, "/agent/kind") !== PRODUCT_AGENT_KIND.WORKSPACE) return;
  for (const tool of state.tools.values()) {
    if (!workspaceDefaultToolNames.has(tool.name)) continue;
    state.issues.push({ kind: "reserved_tool_name", path: tool.path, toolId: tool.name });
  }
};

const validateToolSelection = (state: CompilerState): void => {
  const selection = factValue<ReadonlyArray<string>>(state, "/toolSelection");
  const kind = factValue<ProductAgentKind>(state, "/agent/kind");
  if (selection === undefined || kind === undefined) return;
  const allowed = availableProductToolIds(kind, state.tools.keys());
  selection.forEach((toolId, index) => {
    if (allowed.has(toolId)) return;
    state.issues.push({
      kind: "unknown_product_tool",
      path: "agent/agent.json",
      field: `/tools/${index}`,
      toolId,
      reason: "tool_not_found",
    });
  });
};

const validateProductState = (state: CompilerState): void => {
  validateRequiredFiles(state);
  validateSkillSupportFiles(state);
  validateTools(state);
  validateToolNamespace(state);
  validateToolSelection(state);
  validateDynamicResolvers(state);
};

const buildProvenance = (state: CompilerState): ProductProvenance => {
  const provenance: Record<ProductFactKey, ProductOrigin> = {};
  for (const [key, fact] of [...state.facts.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    provenance[key] = fact.origin;
  }
  return provenance;
};

const buildTools = (state: CompilerState): ReadonlyArray<ProductPlanToolAsset> =>
  [...state.tools.values()].sort((left, right) => left.name.localeCompare(right.name));

const buildChannels = (state: CompilerState): ReadonlyArray<CompiledAgentChannel> =>
  [...state.channels.values()].sort((left, right) => left.name.localeCompare(right.name));

const buildWorkflows = (state: CompilerState): ReadonlyArray<CompiledAgentWorkflow> =>
  [...state.workflows.values()].sort((left, right) => left.name.localeCompare(right.name));

const buildSchedules = (state: CompilerState): ReadonlyArray<CompiledAgentSchedule> =>
  [...state.schedules.values()].sort((left, right) =>
    left.scheduleId.localeCompare(right.scheduleId),
  );

const buildInstructionFragments = (
  state: CompilerState,
): ReadonlyArray<CompiledAgentInstructionFragment> =>
  [...state.instructionFragments.values()].sort((left, right) =>
    left.fragmentId.localeCompare(right.fragmentId),
  );

const buildDynamicResolvers = (state: CompilerState): ReadonlyArray<CompiledAgentDynamicResolver> =>
  [...state.dynamicResolvers.values()].sort(
    (left, right) =>
      left.slot.localeCompare(right.slot) || left.resolverId.localeCompare(right.resolverId),
  );

const validateSkillSupportFiles = (state: CompilerState): void => {
  for (const [skillName, files] of state.skillSupportFiles.entries()) {
    const skill = state.skills.get(skillName);
    if (skill !== undefined && isPackagedSkillPath(skill)) continue;
    for (const file of files) {
      state.issues.push({
        kind: "unsupported_path",
        path: `skills/${skillName}/${file.path}`,
        reason: "skill_support_requires_packaged_skill",
      });
    }
  }
};

const dynamicResolverTargets = (
  state: CompilerState,
  slot: DynamicCapabilitySlot,
): ReadonlySet<string> => {
  switch (slot) {
    case "tools":
      return effectiveProductToolIds(
        factValue<ProductAgentKind>(state, "/agent/kind"),
        factValue<ReadonlyArray<string>>(state, "/toolSelection"),
        state.tools.keys(),
      );
    case "skills":
      return new Set(state.skills.keys());
    case "instructions":
      return new Set(state.instructionFragments.keys());
  }
};

const validateDynamicResolvers = (state: CompilerState): void => {
  for (const resolver of state.dynamicResolvers.values()) {
    const targetIds = dynamicResolverTargets(state, resolver.slot);
    for (const targetId of resolver.outputs) {
      if (targetIds.has(targetId)) continue;
      state.issues.push({
        kind: "dynamic_resolver_unknown_target",
        path: resolver.path,
        slot: resolver.slot,
        targetId,
      });
    }
  }
};

const buildSkills = (state: CompilerState): ReadonlyArray<CompiledAgentSkill> =>
  [...state.skills.values()]
    .map((skill) => ({
      ...skill,
      files: [...(state.skillSupportFiles.get(skill.name) ?? [])].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

const buildAssets = (state: CompilerState): ProductPlanAssets => ({
  tools: buildTools(state),
  channels: buildChannels(state),
  workflows: buildWorkflows(state),
  schedules: buildSchedules(state),
  skills: buildSkills(state),
  instructionFragments: buildInstructionFragments(state),
  dynamicResolvers: buildDynamicResolvers(state),
});

const buildProductIntent = (state: CompilerState): ProductIntent => {
  const instructions = factValue<ProductPlanInstructions>(state, "/instructions");
  const modelPreference = factValue<string>(state, "/modelPreference");
  const toolSelection = factValue<ReadonlyArray<string>>(state, "/toolSelection");
  const outputSchema = factValue<AgentSchemaSpec>(state, "/outputSchema");
  return {
    agent: {
      id: factValue<string>(state, "/agent/id") as string,
      kind: factValue<ProductAgentKind>(state, "/agent/kind") as ProductAgentKind,
    },
    instructions: {
      path: "agent/instructions.md",
      text: (instructions as ProductPlanInstructions).text,
    },
    ...(modelPreference === undefined ? {} : { modelPreference }),
    ...(toolSelection === undefined ? {} : { toolSelection }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    assets: buildAssets(state),
    provenance: buildProvenance(state),
  };
};

const requirementKey = (requirement: ProductSymbolicRequirement): string =>
  `${requirement.kind}\0${"tool" in requirement ? requirement.tool : ""}\0${
    "ref" in requirement ? requirement.ref : ""
  }`;

const buildSymbolicRequirements = (
  intent: ProductIntent,
): ReadonlyArray<ProductSymbolicRequirement> => {
  const selected = effectiveProductToolIds(
    intent.agent.kind,
    intent.toolSelection,
    intent.assets.tools.map((tool) => tool.name),
  );
  const requirements: ProductSymbolicRequirement[] = [{ kind: "model" }];
  if (intent.agent.kind === PRODUCT_AGENT_KIND.WORKSPACE) requirements.push({ kind: "workspace" });
  for (const tool of intent.assets.tools) {
    if (!selected.has(tool.name)) continue;
    if (tool.executionDomain !== undefined) {
      requirements.push({ kind: "execution-domain", ref: tool.executionDomain, tool: tool.name });
    }
    if (tool.interaction !== undefined) {
      requirements.push({ kind: "interaction", ref: tool.interaction, tool: tool.name });
    }
    for (const ref of tool.materialRefs) {
      requirements.push({ kind: "material", ref, tool: tool.name });
    }
  }
  return requirements.sort((left, right) =>
    requirementKey(left).localeCompare(requirementKey(right)),
  );
};

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalJsonValue(value[key]);
  return sorted;
};

const productDigestPayload = (plan: Omit<ProductPlan, "productDigest"> | ProductPlan): unknown => ({
  agent: plan.agent,
  instructions: plan.instructions,
  ...(plan.modelPreference === undefined ? {} : { modelPreference: plan.modelPreference }),
  ...(plan.toolSelection === undefined ? {} : { toolSelection: plan.toolSelection }),
  ...(plan.outputSchema === undefined
    ? {}
    : { outputSchemaFingerprint: plan.outputSchema.fingerprint }),
  symbolicRequirements: plan.symbolicRequirements,
  assets: {
    tools: plan.assets.tools.map(({ origin: _origin, ...tool }) => tool),
    channels: plan.assets.channels.map(({ origin: _origin, ...channel }) => channel),
    workflows: plan.assets.workflows.map(({ origin: _origin, ...workflow }) => workflow),
    schedules: plan.assets.schedules.map(({ origin: _origin, ...schedule }) => schedule),
    skills: plan.assets.skills,
    instructionFragments: plan.assets.instructionFragments.map(
      ({ origin: _origin, ...fragment }) => fragment,
    ),
    dynamicResolvers: plan.assets.dynamicResolvers.map(
      ({ origin: _origin, ...resolver }) => resolver,
    ),
  },
});

const productDigestFor = (plan: Omit<ProductPlan, "productDigest"> | ProductPlan): string =>
  digestText(JSON.stringify(canonicalJsonValue(productDigestPayload(plan))));

/** Verify the product semantic digest without binding host or deployment facts. */
export const verifyProductPlanDigest = (plan: ProductPlan): boolean =>
  plan.instructions.digest === digestText(plan.instructions.text) &&
  plan.productDigest === productDigestFor(plan);

/**
 * Compile authored product facts into one backend-neutral product plan.
 *
 * @agentosPrimitive primitive.agent-authoring.compileProductPlan
 * @agentosInvariant invariant.docs.agent-projection
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/guides/quickstart-node.md
 */
export const compileProductPlan = (tree: AuthoredAgentTree): CompileProductPlanResult => {
  const state: CompilerState = {
    facts: new Map(),
    issues: [],
    pathKeys: new Map(),
    requiredFiles: new Set(),
    tools: new Map(),
    channels: new Map(),
    workflows: new Map(),
    schedules: new Map(),
    skills: new Map(),
    skillSupportFiles: new Map(),
    skillSupportByteTotals: new Map(),
    instructionFragments: new Map(),
    dynamicResolvers: new Map(),
  };

  for (const file of tree.files) {
    const path = registerPath(state, file.path);
    if (path === null) continue;
    switch (file.kind) {
      case "markdown":
        recordMarkdownFile(state, path, file.text, file.sourceKind);
        break;
      case "resource":
        recordResourceFile(state, path, file.bytes, file.sourceKind);
        break;
      case "json":
        recordJsonFile(state, path, file.value);
        break;
      case "material-resolver":
        recordMaterialResolverFile(state, path, file.sourceKind);
        break;
      case "tool":
        recordToolFile(state, path, file.declaration);
        break;
      case "dynamic":
        recordDynamicResolverFile(state, path, file.declaration, file.sourceKind);
        break;
      case "channel":
        recordChannelFile(state, path, file.sourceKind);
        break;
      case "workflow":
        recordWorkflowFile(state, path, file.sourceKind);
        break;
      case "schedule":
        recordScheduleFile(state, path, file.declaration, file.sourceKind);
        break;
    }
  }

  validateProductState(state);
  if (state.issues.length > 0) return { ok: false, issues: state.issues };

  const intent = buildProductIntent(state);
  const instructions = factValue<ProductPlanInstructions>(
    state,
    "/instructions",
  ) as ProductPlanInstructions;
  const semanticPlan: Omit<ProductPlan, "productDigest"> = {
    ...intent,
    instructions,
    symbolicRequirements: buildSymbolicRequirements(intent),
  };
  return { ok: true, value: { ...semanticPlan, productDigest: productDigestFor(semanticPlan) } };
};
