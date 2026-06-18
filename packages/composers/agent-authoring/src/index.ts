import type { Authored } from "@agent-os/kernel";
import { authoredValue } from "@agent-os/kernel/authored-value";
import type { AuthorityRef } from "@agent-os/kernel/effect-claim";
import { isMaterialRef, type MaterialRef } from "@agent-os/kernel/material-ref";
import type { AgentSchemaSpec } from "@agent-os/kernel/agent-schema";
import type {
  AgentExecutionDomainRef,
  AgentInstructionsRef,
  AgentInteractionRef,
  AgentLlmRouteBindingRef,
  AgentManifest,
  AgentScopeIdentityPolicy,
  AgentToolBindingRef,
  HandlerKind,
} from "@agent-os/runtime-protocol";

export const AUTHORING_DEFAULTS_VERSION = "framework-defaults@agentos/v1" as const;

type JsonRecord = Readonly<Record<string, unknown>>;

export type AgentManifestFactKey = `/${string}`;

export type AgentManifestOrigin =
  | `path:${string}`
  | `author:${string}#${string}`
  | `scaffold:${string}@${string}#${string}`
  | `default:${typeof AUTHORING_DEFAULTS_VERSION}#${string}`;

export interface AuthoredAgentTree {
  readonly files: ReadonlyArray<AuthoredAgentTreeFile>;
}

export type AuthoredAgentTreeFile = AuthoredMarkdownFile | AuthoredJsonFile | AuthoredToolFile;

export interface AuthoredMarkdownFile {
  readonly path: string;
  readonly kind: "markdown";
  readonly text: string;
}

export interface AuthoredJsonFile {
  readonly path: string;
  readonly kind: "json";
  readonly value: unknown;
}

export type AuthoredToolEffect =
  | "material"
  | "workspace_mutation"
  | "network"
  | "dispatch"
  | "provider_call"
  | (string & {});

export interface AuthoredToolDeclaration {
  readonly bindingRef?: string;
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

export interface AuthoredAgentJson {
  readonly agentId?: string;
  readonly version?: string;
  readonly scope?: AgentScopeIdentityPolicy;
  readonly effectAuthorityRef?: AuthorityRef;
  readonly handlers?: ReadonlyArray<HandlerKind>;
  readonly llmRoutes?: Readonly<Record<string, AgentLlmRouteBindingRef>>;
  readonly tools?: Readonly<Record<string, AuthoredToolDeclaration>>;
  readonly materials?: Readonly<Record<string, MaterialRef>>;
  readonly executionDomains?: Readonly<Record<string, AgentExecutionDomainRef>>;
  readonly interactions?: Readonly<Record<string, AgentInteractionRef>>;
  readonly outputSchema?: AgentSchemaSpec;
}

export type AuthoredAgentManifest<K extends HandlerKind = HandlerKind> = AgentManifest<K> &
  Authored<AgentManifest<K>>;

export interface CompiledAgentManifest<K extends HandlerKind = HandlerKind> {
  readonly manifest: AuthoredAgentManifest<K>;
  readonly provenance: Readonly<Record<AgentManifestFactKey, AgentManifestOrigin>>;
}

export type CompileAgentTreeIssue =
  | { readonly kind: "unsupported_path"; readonly path: string; readonly reason: string }
  | { readonly kind: "duplicate_path"; readonly path: string; readonly existingPath: string }
  | {
      readonly kind: "duplicate_fact";
      readonly factKey: AgentManifestFactKey;
      readonly origins: readonly [AgentManifestOrigin, AgentManifestOrigin];
    }
  | {
      readonly kind: "non_overrideable_fact";
      readonly factKey: AgentManifestFactKey;
      readonly origins: readonly [AgentManifestOrigin, AgentManifestOrigin];
    }
  | { readonly kind: "missing_required_file"; readonly path: "agent/instructions.md" }
  | { readonly kind: "empty_instructions"; readonly path: string }
  | { readonly kind: "invalid_json_file"; readonly path: string; readonly reason: string }
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
  | { readonly kind: "runtime_fact_forbidden"; readonly path: string; readonly field: string }
  | { readonly kind: "function_in_manifest"; readonly path: string };

export type CompileAgentTreeResult<K extends HandlerKind = HandlerKind> =
  | { readonly ok: true; readonly value: CompiledAgentManifest<K> }
  | { readonly ok: false; readonly issues: ReadonlyArray<CompileAgentTreeIssue> };

type Layer = 1 | 2 | 3;

interface Fact {
  readonly value: unknown;
  readonly origin: AgentManifestOrigin;
  readonly layer: Layer;
  readonly overrideable: boolean;
}

interface CompilerState {
  readonly facts: Map<AgentManifestFactKey, Fact>;
  readonly issues: CompileAgentTreeIssue[];
  readonly pathKeys: Map<string, string>;
  readonly toolIds: Set<string>;
}

const defaultOrigin = (factKey: AgentManifestFactKey): AgentManifestOrigin =>
  `default:${AUTHORING_DEFAULTS_VERSION}#${factKey}`;

const authoredPath = (path: string): string => (path.startsWith("agent/") ? path : `agent/${path}`);

const authorOrigin = (path: string, pointer: string): AgentManifestOrigin =>
  `author:${authoredPath(path)}#${pointer}`;

const pathOrigin = (path: string): AgentManifestOrigin => `path:${authoredPath(path)}`;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasFunction = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasFunction(item, seen));
  return Object.values(value as JsonRecord).some((item) => hasFunction(item, seen));
};

const findFunctionPath = (
  value: unknown,
  path: string,
  seen = new Set<object>(),
): string | null => {
  if (typeof value === "function") return path;
  if (typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findFunctionPath(value[index], `${path}[${index}]`, seen);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    const found = findFunctionPath(child, `${path}.${key}`, seen);
    if (found !== null) return found;
  }
  return null;
};

const digestText = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${text.length}`;
};

const stripAgentPrefix = (path: string): string =>
  path.startsWith("agent/") ? path.slice("agent/".length) : path;

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
  factKey: AgentManifestFactKey,
  value: unknown,
  origin: AgentManifestOrigin,
  layer: Layer,
  overrideable: boolean,
): void => {
  const existing = state.facts.get(factKey);
  if (existing === undefined) {
    state.facts.set(factKey, { value, origin, layer, overrideable });
    return;
  }
  if (existing.layer === layer) {
    state.issues.push({ kind: "duplicate_fact", factKey, origins: [existing.origin, origin] });
    return;
  }
  if (existing.layer > layer) return;
  if (!existing.overrideable) {
    state.issues.push({
      kind: "non_overrideable_fact",
      factKey,
      origins: [existing.origin, origin],
    });
    return;
  }
  state.facts.set(factKey, { value, origin, layer, overrideable });
};

const putDefault = (state: CompilerState, factKey: AgentManifestFactKey, value: unknown): void =>
  putFact(state, factKey, value, defaultOrigin(factKey), 1, true);

const putAuthored = (
  state: CompilerState,
  factKey: AgentManifestFactKey,
  value: unknown,
  origin: AgentManifestOrigin,
  overrideable = false,
): void => putFact(state, factKey, value, origin, 3, overrideable);

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
  "bindingRef",
  "executionDomain",
  "interaction",
  "materialRefs",
  "effects",
  "receiptPolicy",
]);

const domainAllowedFields = new Set(["bindingRef"]);
const interactionAllowedFields = new Set(["bindingRef"]);

const agentAllowedFields = new Set([
  "agentId",
  "version",
  "scope",
  "effectAuthorityRef",
  "handlers",
  "llmRoutes",
  "tools",
  "materials",
  "executionDomains",
  "interactions",
  "outputSchema",
]);

const materialEffectNames = new Set(["material", "provider_call"]);

const isEffectfulTool = (tool: Pick<AgentToolBindingRef, "effects" | "materialRefs">): boolean =>
  (tool.effects?.length ?? 0) > 0 || (tool.materialRefs?.length ?? 0) > 0;

const requiresMaterial = (tool: Pick<AgentToolBindingRef, "effects" | "materialRefs">): boolean =>
  tool.materialRefs !== undefined ||
  (tool.effects?.some((effect) => materialEffectNames.has(effect)) ?? false);

const recordToolFacts = (
  state: CompilerState,
  toolId: string,
  path: string,
  declaration: AuthoredToolDeclaration,
  originFor: (field: string) => AgentManifestOrigin,
): void => {
  state.toolIds.add(toolId);
  const declarationRecord = declaration as JsonRecord;
  assertNoPathIdentityFields(state, path, declarationRecord);
  if (Object.prototype.hasOwnProperty.call(declarationRecord, "kind")) {
    state.issues.push({ kind: "identity_field_forbidden", path, field: "kind" });
  }
  assertAllowedFields(state, path, declarationRecord, toolAllowedFields);
  assertNoRuntimeFactFields(state, path, declarationRecord);
  putAuthored(
    state,
    `/tools/${toolId}/bindingRef`,
    declaration.bindingRef ?? `tool.${toolId}`,
    declaration.bindingRef === undefined ? pathOrigin(path) : originFor("bindingRef"),
  );
  if (declaration.executionDomain !== undefined) {
    putAuthored(
      state,
      `/tools/${toolId}/executionDomain`,
      declaration.executionDomain,
      originFor("executionDomain"),
    );
  }
  if (declaration.interaction !== undefined) {
    putAuthored(
      state,
      `/tools/${toolId}/interaction`,
      declaration.interaction,
      originFor("interaction"),
    );
  }
  if (declaration.materialRefs !== undefined) {
    putAuthored(
      state,
      `/tools/${toolId}/materialRefs`,
      declaration.materialRefs,
      originFor("materialRefs"),
    );
  }
  if (declaration.effects !== undefined) {
    putAuthored(state, `/tools/${toolId}/effects`, declaration.effects, originFor("effects"));
  }
  if (declaration.receiptPolicy !== undefined) {
    putAuthored(
      state,
      `/tools/${toolId}/receiptPolicy`,
      declaration.receiptPolicy,
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
  const agent = value as AuthoredAgentJson;
  if (agent.agentId !== undefined)
    putAuthored(state, "/agentId", agent.agentId, authorOrigin(path, "/agentId"));
  if (agent.version !== undefined)
    putAuthored(state, "/version", agent.version, authorOrigin(path, "/version"));
  if (agent.scope !== undefined)
    putAuthored(state, "/scope", agent.scope, authorOrigin(path, "/scope"));
  if (agent.effectAuthorityRef !== undefined) {
    putAuthored(
      state,
      "/effectAuthorityRef",
      agent.effectAuthorityRef,
      authorOrigin(path, "/effectAuthorityRef"),
    );
  }
  if (agent.handlers !== undefined)
    putAuthored(state, "/handlers", agent.handlers, authorOrigin(path, "/handlers"));
  if (agent.llmRoutes !== undefined) {
    for (const [route, ref] of Object.entries(agent.llmRoutes)) {
      putAuthored(
        state,
        `/llmRoutes/${route}/bindingRef`,
        ref.bindingRef,
        authorOrigin(path, `/llmRoutes/${route}/bindingRef`),
      );
    }
  }
  if (agent.outputSchema !== undefined) {
    putAuthored(state, "/outputSchema", agent.outputSchema, authorOrigin(path, "/outputSchema"));
  }
  if (agent.materials !== undefined) {
    for (const [materialId, materialRef] of Object.entries(agent.materials)) {
      putAuthored(
        state,
        `/materials/${materialId}`,
        materialRef,
        authorOrigin(path, `/materials/${materialId}`),
      );
    }
  }
  if (agent.executionDomains !== undefined) {
    for (const [domainId, domainRef] of Object.entries(agent.executionDomains)) {
      putAuthored(
        state,
        `/executionDomains/${domainId}/bindingRef`,
        domainRef.bindingRef,
        authorOrigin(path, `/executionDomains/${domainId}/bindingRef`),
      );
    }
  }
  if (agent.interactions !== undefined) {
    for (const [interactionId, interactionRef] of Object.entries(agent.interactions)) {
      putAuthored(
        state,
        `/interactions/${interactionId}/bindingRef`,
        interactionRef.bindingRef,
        authorOrigin(path, `/interactions/${interactionId}/bindingRef`),
      );
    }
  }
  if (agent.tools !== undefined) {
    for (const [toolId, declaration] of Object.entries(agent.tools)) {
      recordToolFacts(state, toolId, path, declaration, (field) =>
        authorOrigin(path, `/tools/${toolId}/${field}`),
      );
    }
  }
};

const recordJsonFile = (state: CompilerState, path: string, value: unknown): void => {
  const parts = path.split("/");
  if (path === "agent.json") {
    recordAgentJson(state, path, value);
    return;
  }
  if (parts.length !== 2 || !parts[1]?.endsWith(".json")) {
    state.issues.push({ kind: "unsupported_path", path, reason: "json_path_not_in_grammar" });
    return;
  }
  const id = parts[1].slice(0, -".json".length);
  if (id.length === 0) {
    state.issues.push({ kind: "unsupported_path", path, reason: "empty_path_identity" });
    return;
  }
  if (!isRecord(value)) {
    state.issues.push({ kind: "invalid_json_file", path, reason: "json_value_not_object" });
    return;
  }
  assertNoPathIdentityFields(state, path, value);
  assertNoRuntimeFactFields(state, path, value);
  switch (parts[0]) {
    case "materials": {
      if (!isMaterialRef(value)) {
        state.issues.push({ kind: "invalid_json_file", path, reason: "material_ref_invalid" });
        return;
      }
      putAuthored(state, `/materials/${id}`, value as MaterialRef, pathOrigin(path));
      return;
    }
    case "domains":
      if (Object.prototype.hasOwnProperty.call(value, "kind")) {
        state.issues.push({ kind: "identity_field_forbidden", path, field: "kind" });
      }
      assertAllowedFields(state, path, value, domainAllowedFields);
      putAuthored(
        state,
        `/executionDomains/${id}/bindingRef`,
        typeof value.bindingRef === "string" ? value.bindingRef : id,
        Object.prototype.hasOwnProperty.call(value, "bindingRef")
          ? authorOrigin(path, "/bindingRef")
          : pathOrigin(path),
      );
      return;
    case "interactions":
      if (Object.prototype.hasOwnProperty.call(value, "kind")) {
        state.issues.push({ kind: "identity_field_forbidden", path, field: "kind" });
      }
      assertAllowedFields(state, path, value, interactionAllowedFields);
      putAuthored(
        state,
        `/interactions/${id}/bindingRef`,
        typeof value.bindingRef === "string" ? value.bindingRef : id,
        Object.prototype.hasOwnProperty.call(value, "bindingRef")
          ? authorOrigin(path, "/bindingRef")
          : pathOrigin(path),
      );
      return;
    default:
      state.issues.push({ kind: "unsupported_path", path, reason: "json_path_not_in_grammar" });
  }
};

const recordMarkdownFile = (state: CompilerState, path: string, text: string): void => {
  if (path !== "instructions.md") {
    state.issues.push({ kind: "unsupported_path", path, reason: "markdown_path_not_in_grammar" });
    return;
  }
  if (text.trim().length === 0) state.issues.push({ kind: "empty_instructions", path });
  const instructions: AgentInstructionsRef = {
    path: "agent/instructions.md",
    digest: digestText(text),
  };
  putAuthored(state, "/instructions", instructions, pathOrigin(path));
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
  const toolId = parts[1].slice(0, -".ts".length);
  if (toolId.length === 0) {
    state.issues.push({ kind: "unsupported_path", path, reason: "empty_path_identity" });
    return;
  }
  recordToolFacts(state, toolId, path, declaration ?? {}, (field) => authorOrigin(path, field));
};

const applyDefaults = (state: CompilerState): void => {
  putDefault(state, "/agentId", "agent");
  const agentId = state.facts.get("/agentId")?.value;
  putDefault(state, "/scope", { kind: "conversation", idSource: "submit_scope" });
  putDefault(state, "/llmRoutes/default/bindingRef", "llm.default");
  putDefault(state, "/handlers", []);
  putDefault(state, "/effectAuthorityRef", {
    authorityClass: "agent",
    authorityId: typeof agentId === "string" ? agentId : "agent",
  });
  for (const toolId of [...state.toolIds].sort()) {
    const tool = collectToolConstraintState(state, toolId);
    if (!tool.effectful) {
      putDefault(state, `/tools/${toolId}/executionDomain`, "app-runtime");
      putDefault(state, `/tools/${toolId}/interaction`, "never");
    }
  }
};

const enforceL0 = (state: CompilerState): void => {
  if (!state.facts.has("/instructions")) {
    state.issues.push({ kind: "missing_required_file", path: "agent/instructions.md" });
  }
  for (const toolId of [...state.toolIds].sort()) {
    const tool = collectToolConstraintState(state, toolId);
    if (!tool.effectful) continue;
    if (tool.needsMaterial && (tool.materialRefs?.length ?? 0) === 0) {
      state.issues.push({ kind: "effectful_tool_missing_material", toolId });
    }
    if (tool.executionDomain === undefined) {
      state.issues.push({ kind: "effectful_tool_missing_execution_domain", toolId });
    }
    if (tool.interaction === undefined) {
      state.issues.push({ kind: "effectful_tool_missing_interaction", toolId });
    }
    if (tool.receiptPolicy === undefined) {
      state.issues.push({ kind: "effectful_tool_missing_receipt_policy", toolId });
    }
  }
};

const factValue = <A>(state: CompilerState, factKey: AgentManifestFactKey): A | undefined =>
  state.facts.get(factKey)?.value as A | undefined;

const collectRecord = <A>(
  state: CompilerState,
  prefix: string,
  make: (id: string) => A | null,
): Readonly<Record<string, A>> | undefined => {
  const ids = new Set<string>();
  for (const key of state.facts.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const id = rest.split("/")[0];
    if (id.length > 0) ids.add(id);
  }
  if (ids.size === 0) return undefined;
  const out: Record<string, A> = {};
  for (const id of [...ids].sort()) {
    const value = make(id);
    if (value !== null) out[id] = value;
  }
  return out;
};

const collectToolConstraintState = (
  state: CompilerState,
  toolId: string,
): {
  readonly effectful: boolean;
  readonly needsMaterial: boolean;
  readonly materialRefs?: ReadonlyArray<string>;
  readonly executionDomain?: string;
  readonly interaction?: string;
  readonly receiptPolicy?: string;
} => {
  const effects =
    factValue<ReadonlyArray<AuthoredToolEffect>>(state, `/tools/${toolId}/effects`) ?? [];
  const materialRefs = factValue<ReadonlyArray<string>>(state, `/tools/${toolId}/materialRefs`);
  const tool = { effects, materialRefs };
  return {
    executionDomain: factValue<string>(state, `/tools/${toolId}/executionDomain`),
    interaction: factValue<string>(state, `/tools/${toolId}/interaction`),
    materialRefs,
    receiptPolicy: factValue<string>(state, `/tools/${toolId}/receiptPolicy`),
    effectful: isEffectfulTool(tool),
    needsMaterial: requiresMaterial(tool),
  };
};

const collectTool = (state: CompilerState, toolId: string): AgentToolBindingRef => {
  const executionDomain = factValue<string>(state, `/tools/${toolId}/executionDomain`);
  const interaction = factValue<string>(state, `/tools/${toolId}/interaction`);
  const materialRefs = factValue<ReadonlyArray<string>>(state, `/tools/${toolId}/materialRefs`);
  const effects = factValue<ReadonlyArray<AuthoredToolEffect>>(state, `/tools/${toolId}/effects`);
  const receiptPolicy = factValue<string>(state, `/tools/${toolId}/receiptPolicy`);
  return {
    bindingRef: factValue<string>(state, `/tools/${toolId}/bindingRef`) ?? `tool.${toolId}`,
    ...(executionDomain === undefined ? {} : { executionDomain }),
    ...(interaction === undefined ? {} : { interaction }),
    ...(materialRefs === undefined ? {} : { materialRefs }),
    ...(effects === undefined ? {} : { effects }),
    ...(receiptPolicy === undefined ? {} : { receiptPolicy }),
  };
};

const buildManifest = <K extends HandlerKind>(state: CompilerState): AgentManifest<K> => {
  const version = factValue<string>(state, "/version");
  const instructions = factValue<AgentInstructionsRef>(state, "/instructions");
  const llmRoutes = collectRecord<AgentLlmRouteBindingRef>(state, "/llmRoutes/", (id) => {
    const bindingRef = factValue<string>(state, `/llmRoutes/${id}/bindingRef`);
    return bindingRef === undefined ? null : { bindingRef };
  });
  const tools = collectRecord<AgentToolBindingRef>(state, "/tools/", (id) =>
    collectTool(state, id),
  );
  const materials = collectRecord<MaterialRef>(
    state,
    "/materials/",
    (id) => factValue<MaterialRef>(state, `/materials/${id}`) ?? null,
  );
  const executionDomains = collectRecord<AgentExecutionDomainRef>(
    state,
    "/executionDomains/",
    (id) => {
      const bindingRef = factValue<string>(state, `/executionDomains/${id}/bindingRef`);
      return bindingRef === undefined ? null : { bindingRef };
    },
  );
  const interactions = collectRecord<AgentInteractionRef>(state, "/interactions/", (id) => {
    const bindingRef = factValue<string>(state, `/interactions/${id}/bindingRef`);
    return bindingRef === undefined ? null : { bindingRef };
  });
  const outputSchema = factValue<AgentSchemaSpec>(state, "/outputSchema");
  return {
    agentId: factValue<string>(state, "/agentId") ?? "agent",
    scope:
      factValue<AgentScopeIdentityPolicy>(state, "/scope") ??
      ({ kind: "conversation", idSource: "submit_scope" } satisfies AgentScopeIdentityPolicy),
    effectAuthorityRef:
      factValue<AuthorityRef>(state, "/effectAuthorityRef") ??
      ({ authorityClass: "agent", authorityId: "agent" } satisfies AuthorityRef),
    handlers: factValue<ReadonlyArray<K>>(state, "/handlers") ?? [],
    ...(version === undefined ? {} : { version }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(llmRoutes === undefined ? {} : { llmRoutes }),
    ...(tools === undefined ? {} : { tools }),
    ...(materials === undefined ? {} : { materials }),
    ...(executionDomains === undefined ? {} : { executionDomains }),
    ...(interactions === undefined ? {} : { interactions }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
};

const buildProvenance = (
  state: CompilerState,
): Readonly<Record<AgentManifestFactKey, AgentManifestOrigin>> => {
  const provenance: Record<AgentManifestFactKey, AgentManifestOrigin> = {};
  for (const [key, fact] of [...state.facts.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    provenance[key] = fact.origin;
  }
  return provenance;
};

export const compileAgentTree = <K extends HandlerKind = HandlerKind>(
  tree: AuthoredAgentTree,
): CompileAgentTreeResult<K> => {
  const state: CompilerState = {
    facts: new Map(),
    issues: [],
    pathKeys: new Map(),
    toolIds: new Set(),
  };

  for (const file of tree.files) {
    const path = registerPath(state, file.path);
    if (path === null) continue;
    switch (file.kind) {
      case "markdown":
        recordMarkdownFile(state, path, file.text);
        break;
      case "json":
        recordJsonFile(state, path, file.value);
        break;
      case "tool":
        recordToolFile(state, path, file.declaration);
        break;
    }
  }

  applyDefaults(state);
  enforceL0(state);
  if (state.issues.length > 0) return { ok: false, issues: state.issues };

  const manifest = buildManifest<K>(state);
  const functionPath = findFunctionPath(manifest, "manifest");
  if (functionPath !== null || hasFunction(manifest)) {
    return {
      ok: false,
      issues: [{ kind: "function_in_manifest", path: functionPath ?? "manifest" }],
    };
  }

  return {
    ok: true,
    value: {
      manifest: authoredValue(manifest) as AuthoredAgentManifest<K>,
      provenance: buildProvenance(state),
    },
  };
};
