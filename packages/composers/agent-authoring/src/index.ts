import type { Authored } from "@agent-os/core";
import { isAgentSchema } from "@agent-os/core/agent-schema";
import { authoredValue } from "@agent-os/core/authored-value";
import { isAuthorityRef, type AuthorityRef } from "@agent-os/core/effect-claim";
import { isMaterialRef, type MaterialRef } from "@agent-os/core/material-ref";
import type { AgentSchemaSpec } from "@agent-os/core/agent-schema";
import type {
  AgentExecutionDomainRef,
  AgentInstructionsRef,
  AgentInteractionRef,
  AgentLlmRouteBindingRef,
  AgentManifest,
  AgentScopeIdentityPolicy,
  AgentToolBindingRef,
  ProviderResourceId,
  WorkspaceBindingRef,
  WorkspaceTopology,
} from "@agent-os/core/runtime-protocol";
import {
  BUILTIN_HANDLER_KINDS,
  WORKSPACE_TOPOLOGY,
  manifestScopeRefResult,
  workspaceBindingRef,
  workspaceProviderResourceId,
  type DeploymentSpec,
  type HandlerKind,
} from "@agent-os/core/runtime-protocol";
import {
  WORKSPACE_TOOL_DEFAULT_DECLARATIONS,
  WORKSPACE_TOOL_EXPOSURE_PROFILES,
  WORKSPACE_TOOL_NAMES,
  type WorkspaceToolDefaultDeclaration,
  type WorkspaceToolInteractionFloor,
  type WorkspaceToolName,
} from "@agent-os/workspace-env";

export const AUTHORING_DEFAULTS_VERSION = "framework-defaults@agentos/v1" as const;

export { WORKSPACE_TOPOLOGY } from "@agent-os/core/runtime-protocol";
export type { WorkspaceTopologyKind } from "@agent-os/core/runtime-protocol";

type JsonRecord = Readonly<Record<string, unknown>>;

export type AgentManifestFactKey = `/${string}`;

export type AgentManifestOrigin =
  | `path:${string}`
  | `author:${string}#${string}`
  | `scaffold:${string}@${string}#${string}`
  | `default:${typeof AUTHORING_DEFAULTS_VERSION}#${string}`
  | `macro(workspace@1)#${string}`;

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

export interface AuthoredWorkspaceDefaultToolOverride {
  readonly interaction?: WorkspaceToolInteractionFloor;
}

export type AuthoredWorkspaceDefaultToolControl = false | AuthoredWorkspaceDefaultToolOverride;

export interface AuthoredAgentJson {
  readonly agentId?: string;
  readonly version?: string;
  readonly scope?: AgentScopeIdentityPolicy;
  readonly effectAuthorityRef?: AuthorityRef;
  readonly handlers?: ReadonlyArray<HandlerKind>;
  readonly llmRoutes?: Readonly<Record<string, AgentLlmRouteBindingRef>>;
  readonly tools?: Readonly<Record<string, AuthoredWorkspaceDefaultToolControl>>;
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
  readonly workspaceToolControls: Readonly<
    Partial<Record<WorkspaceToolName, WorkspaceDefaultToolControl>>
  >;
  readonly toolFilePaths: Readonly<Record<string, string>>;
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
      readonly kind: "unknown_workspace_default_tool_control";
      readonly path: string;
      readonly toolId: string;
    }
  | {
      readonly kind: "workspace_default_tool_control_field_forbidden";
      readonly path: string;
      readonly toolId: string;
      readonly field: string;
    }
  | {
      readonly kind: "workspace_default_tool_interaction_weakened";
      readonly path: string;
      readonly toolId: string;
      readonly floor: WorkspaceToolInteractionFloor;
      readonly attempted: WorkspaceToolInteractionFloor;
    }
  | {
      readonly kind: "workspace_default_tool_shadowed";
      readonly path: string;
      readonly toolId: string;
    }
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
  readonly toolFilePaths: Map<string, string>;
  readonly workspaceToolControls: Map<WorkspaceToolName, WorkspaceDefaultToolControl>;
}

export type WorkspaceDefaultToolControl =
  | { readonly kind: "disabled"; readonly origin: AgentManifestOrigin }
  | {
      readonly kind: "override";
      readonly interaction?: {
        readonly value: WorkspaceToolInteractionFloor;
        readonly origin: AgentManifestOrigin;
      };
    };

const defaultOrigin = (factKey: AgentManifestFactKey): AgentManifestOrigin =>
  `default:${AUTHORING_DEFAULTS_VERSION}#${factKey}`;

const workspaceManifestMacroOrigin = (factKey: AgentManifestFactKey): AgentManifestOrigin =>
  `macro(workspace@1)#${factKey}`;

const authoredPath = (path: string): string => (path.startsWith("agent/") ? path : `agent/${path}`);

const authorOrigin = (path: string, pointer: string): AgentManifestOrigin =>
  `author:${authoredPath(path)}#${pointer}`;

const pathOrigin = (path: string): AgentManifestOrigin => `path:${authoredPath(path)}`;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isManifestMapId = (value: string): boolean =>
  value.length > 0 && !value.includes("/") && value !== "." && value !== "..";

const isExtensionHandlerKind = (value: string): boolean => {
  const separator = value.indexOf(".");
  return separator > 0 && separator < value.length - 1;
};

const isHandlerKind = (value: unknown): value is HandlerKind =>
  typeof value === "string" &&
  ((BUILTIN_HANDLER_KINDS as ReadonlyArray<string>).includes(value) ||
    isExtensionHandlerKind(value));

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

const parseHandlers = (
  state: CompilerState,
  path: string,
  value: unknown,
): ReadonlyArray<HandlerKind> | null => {
  if (!Array.isArray(value)) {
    invalidAuthoredValue(state, path, "/handlers", "array_required");
    return null;
  }
  const handlers: HandlerKind[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isHandlerKind(item)) {
      invalidAuthoredValue(state, path, `/handlers/${index}`, "handler_kind_invalid");
      continue;
    }
    handlers.push(item);
  }
  return handlers;
};

const parseScope = (
  state: CompilerState,
  path: string,
  value: unknown,
): AgentScopeIdentityPolicy | null => {
  if (!isRecord(value)) {
    invalidAuthoredValue(state, path, "/scope", "object_required");
    return null;
  }
  assertAllowedFields(state, path, value, new Set(["kind", "idSource", "stableScopeId"]));
  const kind = value.kind;
  if (kind !== "realm" && kind !== "conversation" && kind !== "session" && kind !== "artifact") {
    invalidAuthoredValue(state, path, "/scope/kind", "scope_kind_invalid");
    return null;
  }
  const idSource = value.idSource;
  if (idSource !== "submit_scope" && idSource !== "manifest" && idSource !== "extension") {
    invalidAuthoredValue(state, path, "/scope/idSource", "scope_id_source_invalid");
    return null;
  }
  const stableScopeId = parseOptionalStringField(
    state,
    path,
    "/scope/stableScopeId",
    value.stableScopeId,
  );
  return {
    kind,
    idSource,
    ...(stableScopeId === undefined ? {} : { stableScopeId }),
  };
};

const parseBindingRefObject = <A extends { readonly bindingRef: string }>(
  state: CompilerState,
  path: string,
  field: string,
  value: unknown,
): A | null => {
  if (!isRecord(value)) {
    invalidAuthoredValue(state, path, field, "object_required");
    return null;
  }
  assertAllowedFields(state, path, value, new Set(["bindingRef"]));
  const bindingRef = parseStringField(state, path, `${field}/bindingRef`, value.bindingRef);
  return bindingRef === null ? null : ({ bindingRef } as A);
};

const parseRecordMap = <A>(
  state: CompilerState,
  path: string,
  field: string,
  value: unknown,
  parse: (id: string, child: unknown) => A | null,
): Readonly<Record<string, A>> | null => {
  if (!isRecord(value)) {
    invalidAuthoredValue(state, path, field, "object_required");
    return null;
  }
  const out: Record<string, A> = {};
  for (const [id, child] of Object.entries(value)) {
    if (!isManifestMapId(id)) {
      invalidAuthoredValue(state, path, `${field}/${id}`, "id_invalid");
      continue;
    }
    const parsed = parse(id, child);
    if (parsed !== null) out[id] = parsed;
  }
  return out;
};

const parseMaterialRef = (
  state: CompilerState,
  path: string,
  field: string,
  value: unknown,
): MaterialRef | null => {
  if (!isMaterialRef(value)) {
    invalidAuthoredValue(state, path, field, "material_ref_invalid");
    return null;
  }
  return value;
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

const digestHex64 = (text: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
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
const workspaceToolNames = new Set<WorkspaceToolName>(WORKSPACE_TOOL_NAMES);
const workspaceDefaultToolByName = new Map<WorkspaceToolName, WorkspaceToolDefaultDeclaration>(
  WORKSPACE_TOOL_DEFAULT_DECLARATIONS.map((tool) => [tool.name, tool]),
);
const workspaceInteractionRank: Readonly<Record<WorkspaceToolInteractionFloor, number>> = {
  never: 0,
  approval: 1,
};

const isEffectfulTool = (tool: Pick<AgentToolBindingRef, "effects" | "materialRefs">): boolean =>
  (tool.effects?.length ?? 0) > 0 || (tool.materialRefs?.length ?? 0) > 0;

const requiresMaterial = (tool: Pick<AgentToolBindingRef, "effects" | "materialRefs">): boolean =>
  tool.materialRefs !== undefined ||
  (tool.effects?.some((effect) => materialEffectNames.has(effect)) ?? false);

const isWorkspaceToolName = (name: string): name is WorkspaceToolName =>
  workspaceToolNames.has(name as WorkspaceToolName);

const parseWorkspaceDefaultToolInteraction = (
  state: CompilerState,
  path: string,
  toolId: WorkspaceToolName,
  value: unknown,
): WorkspaceToolInteractionFloor | null => {
  if (value !== "never" && value !== "approval") {
    invalidAuthoredValue(state, path, `/tools/${toolId}/interaction`, "interaction_invalid");
    return null;
  }
  return value;
};

const recordWorkspaceDefaultToolControl = (
  state: CompilerState,
  path: string,
  toolId: string,
  control: AuthoredWorkspaceDefaultToolControl,
): void => {
  if (!isWorkspaceToolName(toolId)) {
    state.issues.push({ kind: "unknown_workspace_default_tool_control", path, toolId });
    return;
  }
  if (control === false) {
    state.workspaceToolControls.set(toolId, {
      kind: "disabled",
      origin: authorOrigin(path, `/tools/${toolId}`),
    });
    return;
  }
  if (!isRecord(control)) {
    invalidAuthoredValue(state, path, `/tools/${toolId}`, "object_or_false_required");
    return;
  }
  for (const field of Object.keys(control)) {
    if (field !== "interaction") {
      state.issues.push({
        kind: "workspace_default_tool_control_field_forbidden",
        path,
        toolId,
        field,
      });
    }
  }
  const defaultTool = workspaceDefaultToolByName.get(toolId);
  if (defaultTool === undefined) {
    state.issues.push({ kind: "unknown_workspace_default_tool_control", path, toolId });
    return;
  }
  const next: Extract<WorkspaceDefaultToolControl, { readonly kind: "override" }> = {
    kind: "override",
  };
  if (Object.prototype.hasOwnProperty.call(control, "interaction")) {
    const attempted = parseWorkspaceDefaultToolInteraction(
      state,
      path,
      toolId,
      control.interaction,
    );
    if (attempted !== null) {
      if (workspaceInteractionRank[attempted] < workspaceInteractionRank[defaultTool.interaction]) {
        state.issues.push({
          kind: "workspace_default_tool_interaction_weakened",
          path,
          toolId,
          floor: defaultTool.interaction,
          attempted,
        });
      } else {
        state.workspaceToolControls.set(toolId, {
          ...next,
          interaction: {
            value: attempted,
            origin: authorOrigin(path, `/tools/${toolId}/interaction`),
          },
        });
      }
    }
  } else {
    state.workspaceToolControls.set(toolId, next);
  }
};

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
  const bindingRef = parseOptionalStringField(state, path, "/bindingRef", declaration.bindingRef);
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
      ? undefined
      : parseStringArrayField(state, path, "/materialRefs", declaration.materialRefs);
  const effects =
    declaration.effects === undefined
      ? undefined
      : parseStringArrayField(state, path, "/effects", declaration.effects);
  const receiptPolicy = parseOptionalStringField(
    state,
    path,
    "/receiptPolicy",
    declaration.receiptPolicy,
  );
  putAuthored(
    state,
    `/tools/${toolId}/bindingRef`,
    bindingRef ?? `tool.${toolId}`,
    bindingRef === undefined ? pathOrigin(path) : originFor("bindingRef"),
  );
  if (executionDomain !== undefined) {
    putAuthored(
      state,
      `/tools/${toolId}/executionDomain`,
      executionDomain,
      originFor("executionDomain"),
    );
  }
  if (interaction !== undefined) {
    putAuthored(state, `/tools/${toolId}/interaction`, interaction, originFor("interaction"));
  }
  if (materialRefs !== undefined) {
    putAuthored(state, `/tools/${toolId}/materialRefs`, materialRefs, originFor("materialRefs"));
  }
  if (effects !== undefined) {
    putAuthored(state, `/tools/${toolId}/effects`, effects, originFor("effects"));
  }
  if (receiptPolicy !== undefined) {
    putAuthored(state, `/tools/${toolId}/receiptPolicy`, receiptPolicy, originFor("receiptPolicy"));
  }
};

const recordAgentJson = (state: CompilerState, path: string, value: unknown): void => {
  if (!isRecord(value)) {
    state.issues.push({ kind: "invalid_json_file", path, reason: "agent_json_not_object" });
    return;
  }
  assertAllowedFields(state, path, value, agentAllowedFields);
  assertNoRuntimeFactFields(state, path, value);
  const agentId = parseOptionalStringField(state, path, "/agentId", value.agentId);
  const version = parseOptionalStringField(state, path, "/version", value.version);
  const scope = value.scope === undefined ? undefined : parseScope(state, path, value.scope);
  const effectAuthorityRef =
    value.effectAuthorityRef === undefined
      ? undefined
      : isAuthorityRef(value.effectAuthorityRef)
        ? value.effectAuthorityRef
        : null;
  if (value.effectAuthorityRef !== undefined && effectAuthorityRef === null) {
    invalidAuthoredValue(state, path, "/effectAuthorityRef", "authority_ref_invalid");
  }
  const handlers =
    value.handlers === undefined ? undefined : parseHandlers(state, path, value.handlers);
  const llmRoutes =
    value.llmRoutes === undefined
      ? undefined
      : parseRecordMap<AgentLlmRouteBindingRef>(
          state,
          path,
          "/llmRoutes",
          value.llmRoutes,
          (_route, child) =>
            parseBindingRefObject<AgentLlmRouteBindingRef>(state, path, "/llmRoutes", child),
        );
  const outputSchema =
    value.outputSchema === undefined
      ? undefined
      : parseOutputSchema(state, path, value.outputSchema);
  const materials =
    value.materials === undefined
      ? undefined
      : parseRecordMap<MaterialRef>(state, path, "/materials", value.materials, (_id, child) =>
          parseMaterialRef(state, path, "/materials", child),
        );
  const executionDomains =
    value.executionDomains === undefined
      ? undefined
      : parseRecordMap<AgentExecutionDomainRef>(
          state,
          path,
          "/executionDomains",
          value.executionDomains,
          (_domainId, child) =>
            parseBindingRefObject<AgentExecutionDomainRef>(state, path, "/executionDomains", child),
        );
  const interactions =
    value.interactions === undefined
      ? undefined
      : parseRecordMap<AgentInteractionRef>(
          state,
          path,
          "/interactions",
          value.interactions,
          (_interactionId, child) =>
            parseBindingRefObject<AgentInteractionRef>(state, path, "/interactions", child),
        );
  if (value.tools !== undefined) {
    if (!isRecord(value.tools)) {
      invalidAuthoredValue(state, path, "/tools", "object_required");
    } else {
      for (const [toolId, child] of Object.entries(value.tools)) {
        if (!isManifestMapId(toolId)) {
          invalidAuthoredValue(state, path, `/tools/${toolId}`, "id_invalid");
          continue;
        }
        recordWorkspaceDefaultToolControl(
          state,
          path,
          toolId,
          child as AuthoredWorkspaceDefaultToolControl,
        );
      }
    }
  }
  if (agentId !== undefined)
    putAuthored(state, "/agentId", agentId, authorOrigin(path, "/agentId"));
  if (version !== undefined)
    putAuthored(state, "/version", version, authorOrigin(path, "/version"));
  if (scope !== undefined && scope !== null) {
    putAuthored(state, "/scope", scope, authorOrigin(path, "/scope"));
  }
  if (effectAuthorityRef !== undefined && effectAuthorityRef !== null) {
    putAuthored(
      state,
      "/effectAuthorityRef",
      effectAuthorityRef,
      authorOrigin(path, "/effectAuthorityRef"),
    );
  }
  if (handlers !== undefined && handlers !== null)
    putAuthored(state, "/handlers", handlers, authorOrigin(path, "/handlers"));
  if (llmRoutes !== undefined && llmRoutes !== null) {
    for (const [route, ref] of Object.entries(llmRoutes)) {
      putAuthored(
        state,
        `/llmRoutes/${route}/bindingRef`,
        ref.bindingRef,
        authorOrigin(path, `/llmRoutes/${route}/bindingRef`),
      );
    }
  }
  if (outputSchema !== undefined && outputSchema !== null) {
    putAuthored(state, "/outputSchema", outputSchema, authorOrigin(path, "/outputSchema"));
  }
  if (materials !== undefined && materials !== null) {
    for (const [materialId, materialRef] of Object.entries(materials)) {
      putAuthored(
        state,
        `/materials/${materialId}`,
        materialRef,
        authorOrigin(path, `/materials/${materialId}`),
      );
    }
  }
  if (executionDomains !== undefined && executionDomains !== null) {
    for (const [domainId, domainRef] of Object.entries(executionDomains)) {
      putAuthored(
        state,
        `/executionDomains/${domainId}/bindingRef`,
        domainRef.bindingRef,
        authorOrigin(path, `/executionDomains/${domainId}/bindingRef`),
      );
    }
  }
  if (interactions !== undefined && interactions !== null) {
    for (const [interactionId, interactionRef] of Object.entries(interactions)) {
      putAuthored(
        state,
        `/interactions/${interactionId}/bindingRef`,
        interactionRef.bindingRef,
        authorOrigin(path, `/interactions/${interactionId}/bindingRef`),
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
      const domainBindingRef = Object.prototype.hasOwnProperty.call(value, "bindingRef")
        ? parseStringField(state, path, "/bindingRef", value.bindingRef)
        : id;
      putAuthored(
        state,
        `/executionDomains/${id}/bindingRef`,
        domainBindingRef ?? id,
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
      const interactionBindingRef = Object.prototype.hasOwnProperty.call(value, "bindingRef")
        ? parseStringField(state, path, "/bindingRef", value.bindingRef)
        : id;
      putAuthored(
        state,
        `/interactions/${id}/bindingRef`,
        interactionBindingRef ?? id,
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
  state.toolFilePaths.set(toolId, path);
  recordToolFacts(state, toolId, path, declaration ?? {}, (field) => authorOrigin(path, field));
};

const applyDefaults = (state: CompilerState): void => {
  putDefault(state, "/agentId", "agent");
  const agentId = state.facts.get("/agentId")?.value;
  putDefault(state, "/scope", { kind: "conversation", idSource: "submit_scope" });
  putDefault(state, "/llmRoutes/default/bindingRef", "llm.default");
  putDefault(state, "/handlers", []);
  putDefault(state, "/executionDomains/app-runtime/bindingRef", "app-runtime");
  putDefault(state, "/interactions/never/bindingRef", "never");
  putDefault(state, "/interactions/approval/bindingRef", "approval");
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

const buildWorkspaceToolControls = (
  state: CompilerState,
): Readonly<Partial<Record<WorkspaceToolName, WorkspaceDefaultToolControl>>> => {
  const controls: Partial<Record<WorkspaceToolName, WorkspaceDefaultToolControl>> = {};
  for (const [toolId, control] of [...state.workspaceToolControls.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    controls[toolId] = control;
  }
  return controls;
};

const buildToolFilePaths = (state: CompilerState): Readonly<Record<string, string>> => {
  const paths: Record<string, string> = {};
  for (const [toolId, path] of [...state.toolFilePaths.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    paths[toolId] = path;
  }
  return paths;
};

/**
 * Compile an authored `agent/` tree into one normalized manifest plus
 * provenance. This is the app-author entrypoint; runtime facts and provider
 * material are rejected before they can become manifest truth.
 *
 * @agentosPrimitive primitive.agent-authoring.compileAgentTree
 * @agentosInvariant invariant.docs.agent-projection
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/guides/build-natural-language-workspace-agent.md
 */
export const compileAgentTree = <K extends HandlerKind = HandlerKind>(
  tree: AuthoredAgentTree,
): CompileAgentTreeResult<K> => {
  const state: CompilerState = {
    facts: new Map(),
    issues: [],
    pathKeys: new Map(),
    toolIds: new Set(),
    toolFilePaths: new Map(),
    workspaceToolControls: new Map(),
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
      workspaceToolControls: buildWorkspaceToolControls(state),
      toolFilePaths: buildToolFilePaths(state),
    },
  };
};

export const AGENTOS_CONFIG_PROFILE = {
  WORKSPACE_V1: "workspace@1",
} as const;

export type AgentOsConfigProfile =
  (typeof AGENTOS_CONFIG_PROFILE)[keyof typeof AGENTOS_CONFIG_PROFILE];

export const AGENTOS_CONFIG_TARGET = {
  CLOUDFLARE_DO_V1: "cloudflare-do@1",
} as const;

export type AgentOsConfigTargetKind =
  (typeof AGENTOS_CONFIG_TARGET)[keyof typeof AGENTOS_CONFIG_TARGET];

export const AGENTOS_CONFIG_CLIENT = {
  SVELTE_KIT_REMOTE_V1: "svelte-kit-remote@1",
  BROWSER_DIRECT_V1: "browser-direct@1",
} as const;

export type AgentOsConfigClientKind =
  (typeof AGENTOS_CONFIG_CLIENT)[keyof typeof AGENTOS_CONFIG_CLIENT];

export const AGENTOS_CONFIG_LLM_ROUTE = {
  OPENAI_CHAT_COMPATIBLE: "openai-chat-compatible",
} as const;

export type AgentOsConfigLlmRoute =
  (typeof AGENTOS_CONFIG_LLM_ROUTE)[keyof typeof AGENTOS_CONFIG_LLM_ROUTE];

export interface AgentOsConfigDeployment {
  readonly id: string;
  readonly version?: string;
}

export interface AgentOsConfigCloudflareDoTarget {
  readonly kind: typeof AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1;
  readonly durableObject: {
    readonly className: string;
    readonly binding: string;
  };
}

export type AgentOsConfigTarget = AgentOsConfigCloudflareDoTarget;

export interface AgentOsConfigClient {
  readonly kind: AgentOsConfigClientKind;
}

export interface AgentOsConfigLlm {
  readonly route: AgentOsConfigLlmRoute;
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelRef: string;
}

export type AgentOsConfigWorkspaceTopology = WorkspaceTopology;

export interface AgentOsConfigWorkspace {
  readonly binding: string;
  readonly root: string;
  readonly topology?: AgentOsConfigWorkspaceTopology;
}

export interface AgentOsConfigV1 {
  readonly $schema?: string;
  readonly profile: AgentOsConfigProfile;
  readonly agent: string;
  readonly deployment: AgentOsConfigDeployment;
  readonly target: AgentOsConfigTarget;
  readonly client: AgentOsConfigClient;
  readonly llm: AgentOsConfigLlm;
  readonly workspace: AgentOsConfigWorkspace;
}

export type AgentOsConfigFactKey = `/${string}`;

export type AgentOsConfigOrigin =
  | `author:agentos.config.jsonc#${AgentOsConfigFactKey}`
  | `macro(${typeof AGENTOS_CONFIG_PROFILE.WORKSPACE_V1})#${AgentOsConfigFactKey}`
  | `derived:${string}`;

export type AgentOsConfigIssue =
  | { readonly kind: "config_not_object"; readonly path: "agentos.config.jsonc" }
  | { readonly kind: "unknown_field"; readonly path: string; readonly field: string }
  | {
      readonly kind: "invalid_config_value";
      readonly path: string;
      readonly field: string;
      readonly reason: string;
    }
  | { readonly kind: "runtime_fact_forbidden"; readonly path: string; readonly field: string }
  | { readonly kind: "function_in_config"; readonly path: string }
  | {
      readonly kind: "workspace_scope_not_manifest_owned";
      readonly path: "agent/agent.json#/scope";
      readonly reason: "scope_not_manifest_owned" | "stable_scope_id_missing";
    }
  | {
      readonly kind: "workspace_default_tool_shadowed";
      readonly path: string;
      readonly toolId: WorkspaceToolName;
    }
  | {
      readonly kind: "tool_material_ref_unresolved";
      readonly toolId: string;
      readonly materialRef: string;
    }
  | {
      readonly kind: "tool_execution_domain_ref_unresolved";
      readonly toolId: string;
      readonly executionDomain: string;
    }
  | {
      readonly kind: "tool_interaction_ref_unresolved";
      readonly toolId: string;
      readonly interaction: string;
    };

export interface StaticTargetProvenance {
  readonly manifest: Readonly<Record<AgentManifestFactKey, AgentManifestOrigin>>;
  readonly deployment: Readonly<Record<AgentOsConfigFactKey, AgentOsConfigOrigin>>;
  readonly exclusions: Readonly<Record<string, AgentManifestOrigin>>;
}

export type DecodeAgentOsConfigResult =
  | { readonly ok: true; readonly value: AgentOsConfigV1 }
  | { readonly ok: false; readonly issues: ReadonlyArray<AgentOsConfigIssue> };

export interface NormalizedAgentOsConfig<M extends AgentManifest = AgentManifest> {
  readonly config: AgentOsConfigV1;
  readonly deployment: DeploymentSpec<M>;
  readonly deploymentVersion?: string;
  readonly authoredToolNames: ReadonlyArray<string>;
  readonly target: AgentOsConfigTarget;
  readonly client: AgentOsConfigClient;
  readonly llm: AgentOsConfigLlm;
  readonly workspace: AgentOsConfigWorkspace & {
    readonly topology: AgentOsConfigWorkspaceTopology;
    readonly bindingRef: WorkspaceBindingRef;
    readonly providerResourceId: ProviderResourceId;
    readonly cloudflareSandboxId: string;
  };
  readonly origins: Readonly<Record<AgentOsConfigFactKey, AgentOsConfigOrigin>>;
  readonly provenance: StaticTargetProvenance;
}

export type NormalizeAgentOsConfigResult<M extends AgentManifest = AgentManifest> =
  | { readonly ok: true; readonly value: NormalizedAgentOsConfig<M> }
  | { readonly ok: false; readonly issues: ReadonlyArray<AgentOsConfigIssue> };

export type StaticTargetGeneratedFilePath =
  | ".agentos/generated/manifest.json"
  | ".agentos/generated/deployment.json"
  | ".agentos/generated/provenance.json"
  | ".agentos/generated/fingerprints.json"
  | ".agentos/generated/target.ts"
  | ".agentos/generated/sveltekit.remote.ts"
  | ".agentos/generated/client.ts"
  | ".agentos/generated/client.d.ts";

export interface StaticTargetGeneratedFile {
  readonly path: StaticTargetGeneratedFilePath;
  readonly text: string;
}

export type StaticTargetModuleImportKind =
  | "target-runtime"
  | "provider-runtime"
  | "execution-domain-runtime"
  | "workspace-host"
  | "workspace-binding"
  | "platform-runtime"
  | "workspace-client"
  | "client-core"
  | "client-framework"
  | "client-transport"
  | "effect-runtime"
  | "semantic-json"
  | "authored-tool";

export interface StaticTargetModuleImport {
  readonly kind: StaticTargetModuleImportKind;
  readonly source: string;
  readonly imports: ReadonlyArray<string>;
}

export interface CanonicalDeploymentIR {
  readonly target: typeof AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1;
  readonly llmRoute: typeof AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE;
  readonly client: AgentOsConfigClientKind;
  readonly workspaceTopology: AgentOsConfigWorkspaceTopology;
  readonly toolNames: ReadonlyArray<string>;
}

export interface MountIR {
  readonly driver: {
    readonly kind: "cloudflare-do";
    readonly className: string;
    readonly binding: string;
  };
  readonly projectionSinks: ReadonlyArray<
    | "agent.info"
    | "workspace.state"
    | "workspace.files"
    | "runtime.events"
    | "runtime.input_requests"
  >;
  readonly providerResourceId: ProviderResourceId;
}

export interface StaticTargetLink {
  readonly files: ReadonlyArray<StaticTargetGeneratedFile>;
  readonly moduleGraph: ReadonlyArray<StaticTargetModuleImport>;
  readonly canonicalDeployment: CanonicalDeploymentIR;
  readonly mount: MountIR;
}

export type StaticTargetLinkIssue =
  | {
      readonly kind: "unsupported_static_target";
      readonly target: AgentOsConfigTargetKind;
    }
  | {
      readonly kind: "unsupported_static_llm_route";
      readonly route: AgentOsConfigLlmRoute;
    }
  | {
      readonly kind: "invalid_static_package_scope";
      readonly scope: string;
    };

export interface StaticTargetLinkOptions {
  readonly packageScope?: string;
}

export type StaticTargetLinkResult =
  | { readonly ok: true; readonly value: StaticTargetLink }
  | { readonly ok: false; readonly issues: ReadonlyArray<StaticTargetLinkIssue> };

const configAuthorOrigin = (factKey: AgentOsConfigFactKey): AgentOsConfigOrigin =>
  `author:agentos.config.jsonc#${factKey}`;

const workspaceMacroOrigin = (factKey: AgentOsConfigFactKey): AgentOsConfigOrigin =>
  `macro(${AGENTOS_CONFIG_PROFILE.WORKSPACE_V1})#${factKey}`;

const configAllowedFields = new Set([
  "$schema",
  "profile",
  "agent",
  "deployment",
  "target",
  "client",
  "llm",
  "workspace",
]);

const deploymentAllowedFields = new Set(["id", "version"]);
const targetAllowedFields = new Set(["kind", "durableObject"]);
const durableObjectAllowedFields = new Set(["className", "binding"]);
const clientAllowedFields = new Set(["kind"]);
const llmAllowedFields = new Set(["route", "endpointRef", "credentialRef", "modelRef"]);
const workspaceAllowedFields = new Set(["binding", "root", "topology"]);
const topologyAllowedFields = new Set(["kind", "allocator"]);

const configRuntimeFactFields = new Set([
  "continuation",
  "continuationRef",
  "inputRequestRef",
  "snapshot",
  "actualTriggerTime",
  "resumePayload",
  "resolvedMaterial",
  "secret",
  "credential",
  "triggerTime",
]);

const issueInvalidConfigValue = (
  issues: AgentOsConfigIssue[],
  path: string,
  field: string,
  reason: string,
): void => {
  issues.push({ kind: "invalid_config_value", path, field, reason });
};

const assertConfigAllowedFields = (
  issues: AgentOsConfigIssue[],
  path: string,
  value: JsonRecord,
  allowed: ReadonlySet<string>,
): void => {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) issues.push({ kind: "unknown_field", path, field });
  }
};

const assertNoConfigRuntimeFacts = (
  issues: AgentOsConfigIssue[],
  path: string,
  value: JsonRecord,
): void => {
  const visit = (record: JsonRecord, fieldPrefix: string): void => {
    for (const [field, child] of Object.entries(record)) {
      const fieldPath = fieldPrefix.length === 0 ? field : `${fieldPrefix}.${field}`;
      if (configRuntimeFactFields.has(field)) {
        issues.push({ kind: "runtime_fact_forbidden", path, field: fieldPath });
      }
      if (typeof child === "function") {
        issues.push({ kind: "function_in_config", path: `${path}.${fieldPath}` });
      }
      if (isRecord(child)) visit(child, fieldPath);
      if (Array.isArray(child)) {
        for (let index = 0; index < child.length; index += 1) {
          const item = child[index];
          if (isRecord(item)) visit(item, `${fieldPath}[${index}]`);
          if (typeof item === "function") {
            issues.push({ kind: "function_in_config", path: `${path}.${fieldPath}[${index}]` });
          }
        }
      }
    }
  };
  visit(value, "");
};

const configStringField = (
  issues: AgentOsConfigIssue[],
  path: string,
  field: string,
  value: unknown,
): string | null => {
  if (isNonEmptyString(value)) return value;
  issueInvalidConfigValue(issues, path, field, "non_empty_string_required");
  return null;
};

const configOptionalStringField = (
  issues: AgentOsConfigIssue[],
  path: string,
  field: string,
  value: unknown,
): string | undefined => {
  if (value === undefined) return undefined;
  return configStringField(issues, path, field, value) ?? undefined;
};

const configRequiredRecord = (
  issues: AgentOsConfigIssue[],
  path: string,
  field: string,
  value: unknown,
): JsonRecord | null => {
  if (isRecord(value)) return value;
  issueInvalidConfigValue(issues, path, field, "object_required");
  return null;
};

const decodeDeploymentConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): AgentOsConfigDeployment | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", "/deployment", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/deployment", record, deploymentAllowedFields);
  const id = configStringField(issues, "/deployment", "/deployment/id", record.id);
  const version = configOptionalStringField(
    issues,
    "/deployment",
    "/deployment/version",
    record.version,
  );
  return id === null ? null : { id, ...(version === undefined ? {} : { version }) };
};

const decodeTargetConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): AgentOsConfigTarget | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", "/target", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/target", record, targetAllowedFields);
  if (record.kind !== AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1) {
    issueInvalidConfigValue(issues, "/target", "/target/kind", "target_kind_invalid");
    return null;
  }
  const durableObject = configRequiredRecord(
    issues,
    "/target",
    "/target/durableObject",
    record.durableObject,
  );
  if (durableObject === null) return null;
  assertConfigAllowedFields(
    issues,
    "/target/durableObject",
    durableObject,
    durableObjectAllowedFields,
  );
  const className = configStringField(
    issues,
    "/target/durableObject",
    "/target/durableObject/className",
    durableObject.className,
  );
  const binding = configStringField(
    issues,
    "/target/durableObject",
    "/target/durableObject/binding",
    durableObject.binding,
  );
  return className === null || binding === null
    ? null
    : {
        kind: AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1,
        durableObject: { className, binding },
      };
};

const decodeClientConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): AgentOsConfigClient | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", "/client", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/client", record, clientAllowedFields);
  if (
    record.kind !== AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1 &&
    record.kind !== AGENTOS_CONFIG_CLIENT.BROWSER_DIRECT_V1
  ) {
    issueInvalidConfigValue(issues, "/client", "/client/kind", "client_kind_invalid");
    return null;
  }
  return { kind: record.kind };
};

const decodeLlmConfig = (issues: AgentOsConfigIssue[], value: unknown): AgentOsConfigLlm | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", "/llm", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/llm", record, llmAllowedFields);
  if (record.route !== AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE) {
    issueInvalidConfigValue(issues, "/llm", "/llm/route", "llm_route_invalid");
    return null;
  }
  const endpointRef = configStringField(issues, "/llm", "/llm/endpointRef", record.endpointRef);
  const credentialRef = configStringField(
    issues,
    "/llm",
    "/llm/credentialRef",
    record.credentialRef,
  );
  const modelRef = configStringField(issues, "/llm", "/llm/modelRef", record.modelRef);
  return endpointRef === null || credentialRef === null || modelRef === null
    ? null
    : {
        route: AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE,
        endpointRef,
        credentialRef,
        modelRef,
      };
};

const decodeWorkspaceTopologyConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): AgentOsConfigWorkspaceTopology | null => {
  const record = configRequiredRecord(issues, "/workspace", "/workspace/topology", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/workspace/topology", record, topologyAllowedFields);
  if (record.kind !== WORKSPACE_TOPOLOGY.PER_SCOPE) {
    issueInvalidConfigValue(
      issues,
      "/workspace/topology",
      "/workspace/topology/kind",
      "workspace_topology_kind_invalid",
    );
    return null;
  }
  const allocator = configStringField(
    issues,
    "/workspace/topology",
    "/workspace/topology/allocator",
    record.allocator,
  );
  return allocator === null ? null : { kind: WORKSPACE_TOPOLOGY.PER_SCOPE, allocator };
};

const decodeWorkspaceConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): AgentOsConfigWorkspace | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", "/workspace", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/workspace", record, workspaceAllowedFields);
  const binding = configStringField(issues, "/workspace", "/workspace/binding", record.binding);
  const root = configStringField(issues, "/workspace", "/workspace/root", record.root);
  const topology =
    record.topology === undefined
      ? undefined
      : decodeWorkspaceTopologyConfig(issues, record.topology);
  return binding === null || root === null || topology === null
    ? null
    : { binding, root, ...(topology === undefined ? {} : { topology }) };
};

export const decodeAgentOsConfig = (value: unknown): DecodeAgentOsConfigResult => {
  const issues: AgentOsConfigIssue[] = [];
  if (!isRecord(value))
    return { ok: false, issues: [{ kind: "config_not_object", path: "agentos.config.jsonc" }] };
  assertConfigAllowedFields(issues, "agentos.config.jsonc", value, configAllowedFields);
  assertNoConfigRuntimeFacts(issues, "agentos.config.jsonc", value);

  const schema = configOptionalStringField(
    issues,
    "agentos.config.jsonc",
    "/$schema",
    value.$schema,
  );
  if (value.profile !== AGENTOS_CONFIG_PROFILE.WORKSPACE_V1) {
    issueInvalidConfigValue(issues, "agentos.config.jsonc", "/profile", "profile_invalid");
  }
  const agent = configStringField(issues, "agentos.config.jsonc", "/agent", value.agent);
  const deployment = decodeDeploymentConfig(issues, value.deployment);
  const target = decodeTargetConfig(issues, value.target);
  const client = decodeClientConfig(issues, value.client);
  const llm = decodeLlmConfig(issues, value.llm);
  const workspace = decodeWorkspaceConfig(issues, value.workspace);
  if (
    issues.length > 0 ||
    agent === null ||
    deployment === null ||
    target === null ||
    client === null ||
    llm === null ||
    workspace === null
  ) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      ...(schema === undefined ? {} : { $schema: schema }),
      profile: AGENTOS_CONFIG_PROFILE.WORKSPACE_V1,
      agent,
      deployment,
      target,
      client,
      llm,
      workspace,
    },
  };
};

const defaultWorkspaceTopology = (): AgentOsConfigWorkspaceTopology => ({
  kind: WORKSPACE_TOPOLOGY.PER_SCOPE,
  allocator: "workspace-per-scope-v1",
});

const workspaceMaterialRef = (providerResourceId: ProviderResourceId): MaterialRef => ({
  kind: "external_resource",
  provider: "agent-os",
  resourceKind: "workspace-env",
  ref: providerResourceId,
});

const workspaceDefaultToolFactKey = (
  toolId: WorkspaceToolName,
  field: keyof AgentToolBindingRef,
): AgentManifestFactKey => `/tools/${toolId}/${field}`;

const workspaceExecutionDomainFactKey = "/executionDomains/workspace/bindingRef" as const;
const workspaceMaterialFactKey = "/materials/workspace" as const;

const defaultWorkspaceToolEntry = (
  tool: WorkspaceToolDefaultDeclaration,
  control: WorkspaceDefaultToolControl | undefined,
): AgentToolBindingRef => ({
  bindingRef: tool.name,
  executionDomain: tool.executionDomain,
  interaction:
    control?.kind === "override" && control.interaction !== undefined
      ? control.interaction.value
      : tool.interaction,
  materialRefs: tool.materialRefs,
  effects: tool.effects,
  receiptPolicy: tool.receiptPolicy,
});

const addDefaultWorkspaceToolProvenance = (
  provenance: Record<AgentManifestFactKey, AgentManifestOrigin>,
  tool: WorkspaceToolDefaultDeclaration,
  control: WorkspaceDefaultToolControl | undefined,
): void => {
  provenance[workspaceDefaultToolFactKey(tool.name, "bindingRef")] = workspaceManifestMacroOrigin(
    workspaceDefaultToolFactKey(tool.name, "bindingRef"),
  );
  provenance[workspaceDefaultToolFactKey(tool.name, "executionDomain")] =
    workspaceManifestMacroOrigin(workspaceDefaultToolFactKey(tool.name, "executionDomain"));
  provenance[workspaceDefaultToolFactKey(tool.name, "interaction")] =
    control?.kind === "override" && control.interaction !== undefined
      ? control.interaction.origin
      : workspaceManifestMacroOrigin(workspaceDefaultToolFactKey(tool.name, "interaction"));
  provenance[workspaceDefaultToolFactKey(tool.name, "materialRefs")] = workspaceManifestMacroOrigin(
    workspaceDefaultToolFactKey(tool.name, "materialRefs"),
  );
  provenance[workspaceDefaultToolFactKey(tool.name, "effects")] = workspaceManifestMacroOrigin(
    workspaceDefaultToolFactKey(tool.name, "effects"),
  );
  provenance[workspaceDefaultToolFactKey(tool.name, "receiptPolicy")] =
    workspaceManifestMacroOrigin(workspaceDefaultToolFactKey(tool.name, "receiptPolicy"));
};

const applyWorkspaceDefaultTools = <K extends HandlerKind>(
  compiled: CompiledAgentManifest<K>,
): {
  readonly manifest: AuthoredAgentManifest<K>;
  readonly provenance: StaticTargetProvenance["manifest"];
  readonly exclusions: StaticTargetProvenance["exclusions"];
  readonly issues: ReadonlyArray<AgentOsConfigIssue>;
} => {
  const issues: AgentOsConfigIssue[] = [];
  const tools: Record<string, AgentToolBindingRef> = { ...compiled.manifest.tools };
  const executionDomains: Record<string, AgentExecutionDomainRef> = {
    ...compiled.manifest.executionDomains,
  };
  const provenance: Record<AgentManifestFactKey, AgentManifestOrigin> = {
    ...compiled.provenance,
  };
  const exclusions: Record<string, AgentManifestOrigin> = {};

  if (executionDomains.workspace === undefined) {
    executionDomains.workspace = { bindingRef: "workspace" };
    provenance[workspaceExecutionDomainFactKey] = workspaceManifestMacroOrigin(
      workspaceExecutionDomainFactKey,
    );
  }

  for (const defaultTool of WORKSPACE_TOOL_DEFAULT_DECLARATIONS) {
    const control = compiled.workspaceToolControls[defaultTool.name];
    const existing = compiled.manifest.tools?.[defaultTool.name];
    if (control?.kind === "disabled") {
      exclusions[`/tools/${defaultTool.name}`] = control.origin;
      continue;
    }
    if (existing !== undefined) {
      issues.push({
        kind: "workspace_default_tool_shadowed",
        path: compiled.toolFilePaths[defaultTool.name] ?? `agent/tools/${defaultTool.name}.ts`,
        toolId: defaultTool.name,
      });
      continue;
    }
    tools[defaultTool.name] = defaultWorkspaceToolEntry(defaultTool, control);
    addDefaultWorkspaceToolProvenance(provenance, defaultTool, control);
  }
  const manifestWithoutTools = { ...compiled.manifest } as AgentManifest<K>;
  delete (manifestWithoutTools as { tools?: unknown }).tools;
  delete (manifestWithoutTools as { executionDomains?: unknown }).executionDomains;
  const sortedTools = Object.fromEntries(
    Object.entries(tools).sort(([left], [right]) => left.localeCompare(right)),
  );
  const sortedExecutionDomains = Object.fromEntries(
    Object.entries(executionDomains).sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    manifest: authoredValue({
      ...manifestWithoutTools,
      ...(Object.keys(sortedTools).length === 0 ? {} : { tools: sortedTools }),
      ...(Object.keys(sortedExecutionDomains).length === 0
        ? {}
        : { executionDomains: sortedExecutionDomains }),
    }) as AuthoredAgentManifest<K>,
    provenance,
    exclusions,
    issues,
  };
};

const addWorkspaceMaterial = <K extends HandlerKind>(
  manifest: AuthoredAgentManifest<K>,
  provenance: StaticTargetProvenance["manifest"],
  providerResourceId: ProviderResourceId,
): {
  readonly manifest: AuthoredAgentManifest<K>;
  readonly provenance: StaticTargetProvenance["manifest"];
} => {
  if (manifest.materials?.workspace !== undefined) {
    return { manifest, provenance };
  }
  const materials = {
    ...manifest.materials,
    workspace: workspaceMaterialRef(providerResourceId),
  };
  const sortedMaterials = Object.fromEntries(
    Object.entries(materials).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    manifest: authoredValue({
      ...manifest,
      materials: sortedMaterials,
    }) as AuthoredAgentManifest<K>,
    provenance: {
      ...provenance,
      [workspaceMaterialFactKey]: workspaceManifestMacroOrigin(workspaceMaterialFactKey),
    },
  };
};

const validateManifestToolReferences = <K extends HandlerKind>(
  manifest: AuthoredAgentManifest<K>,
): ReadonlyArray<AgentOsConfigIssue> => {
  const issues: AgentOsConfigIssue[] = [];
  for (const [toolId, tool] of Object.entries(manifest.tools ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const materialRef of tool.materialRefs ?? []) {
      if (manifest.materials?.[materialRef] === undefined) {
        issues.push({ kind: "tool_material_ref_unresolved", toolId, materialRef });
      }
    }
    if (
      tool.executionDomain !== undefined &&
      manifest.executionDomains?.[tool.executionDomain] === undefined
    ) {
      issues.push({
        kind: "tool_execution_domain_ref_unresolved",
        toolId,
        executionDomain: tool.executionDomain,
      });
    }
    if (tool.interaction !== undefined && manifest.interactions?.[tool.interaction] === undefined) {
      issues.push({
        kind: "tool_interaction_ref_unresolved",
        toolId,
        interaction: tool.interaction,
      });
    }
  }
  return issues;
};

const cloudflareSandboxIdPrefix = (
  deploymentNamespace: string,
  workspaceBindingRef: WorkspaceBindingRef,
  scopeRef: { readonly kind: string; readonly scopeId: string },
): string =>
  `${deploymentNamespace}-${workspaceBindingRef}-${scopeRef.kind}-${scopeRef.scopeId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const cloudflareWorkspaceSandboxId = (input: {
  readonly deploymentNamespace: string;
  readonly workspaceBindingRef: WorkspaceBindingRef;
  readonly scopeRef: { readonly kind: string; readonly scopeId: string };
  readonly providerResourceId: ProviderResourceId;
}): string => {
  const digest = digestHex64(input.providerResourceId);
  const suffix = `-${digest}`;
  const rawPrefix = cloudflareSandboxIdPrefix(
    input.deploymentNamespace,
    input.workspaceBindingRef,
    input.scopeRef,
  );
  const prefix = rawPrefix.length === 0 ? "agentos-sandbox" : rawPrefix;
  const prefixBudget = 63 - suffix.length;
  const shortenedPrefix = prefix.slice(0, prefixBudget).replace(/-+$/g, "") || "agentos-sandbox";
  return `${shortenedPrefix}${suffix}`;
};

export const normalizeAgentOsConfig = <K extends HandlerKind = HandlerKind>(
  config: AgentOsConfigV1,
  compiled: CompiledAgentManifest<K>,
): NormalizeAgentOsConfigResult<AuthoredAgentManifest<K>> => {
  const decoded = decodeAgentOsConfig(config);
  if (!decoded.ok) return decoded;
  const value = decoded.value;
  const workspaceDefaults = applyWorkspaceDefaultTools(compiled);
  if (workspaceDefaults.issues.length > 0) {
    return { ok: false, issues: workspaceDefaults.issues };
  }
  const topology = value.workspace.topology ?? defaultWorkspaceTopology();
  const scopeRef = manifestScopeRefResult(workspaceDefaults.manifest);
  if (!scopeRef.ok) {
    return {
      ok: false,
      issues: [
        {
          kind: "workspace_scope_not_manifest_owned",
          path: "agent/agent.json#/scope",
          reason: scopeRef.reason,
        },
      ],
    };
  }
  const bindingRef = workspaceBindingRef(value.workspace.binding);
  const providerResourceId = workspaceProviderResourceId({
    deploymentNamespace: value.deployment.id,
    workspaceBindingRef: bindingRef,
    topology,
    scopeRef: scopeRef.value,
  });
  const cloudflareSandboxId = cloudflareWorkspaceSandboxId({
    deploymentNamespace: value.deployment.id,
    workspaceBindingRef: bindingRef,
    scopeRef: scopeRef.value,
    providerResourceId,
  });
  const manifestWithWorkspaceMaterial = addWorkspaceMaterial(
    workspaceDefaults.manifest,
    workspaceDefaults.provenance,
    providerResourceId,
  );
  const referenceIssues = validateManifestToolReferences(manifestWithWorkspaceMaterial.manifest);
  if (referenceIssues.length > 0) {
    return { ok: false, issues: referenceIssues };
  }
  const origins: Record<AgentOsConfigFactKey, AgentOsConfigOrigin> = {
    "/profile": configAuthorOrigin("/profile"),
    "/agent": configAuthorOrigin("/agent"),
    "/deployment/id": configAuthorOrigin("/deployment/id"),
    ...(value.deployment.version === undefined
      ? {}
      : { "/deployment/version": configAuthorOrigin("/deployment/version") }),
    "/target/kind": configAuthorOrigin("/target/kind"),
    "/target/durableObject/className": configAuthorOrigin("/target/durableObject/className"),
    "/target/durableObject/binding": configAuthorOrigin("/target/durableObject/binding"),
    "/client/kind": configAuthorOrigin("/client/kind"),
    "/llm/route": configAuthorOrigin("/llm/route"),
    "/llm/endpointRef": configAuthorOrigin("/llm/endpointRef"),
    "/llm/credentialRef": configAuthorOrigin("/llm/credentialRef"),
    "/llm/modelRef": configAuthorOrigin("/llm/modelRef"),
    "/workspace/binding": configAuthorOrigin("/workspace/binding"),
    "/workspace/bindingRef": `derived:/workspace/binding`,
    "/workspace/root": configAuthorOrigin("/workspace/root"),
    "/workspace/topology/kind":
      value.workspace.topology === undefined
        ? workspaceMacroOrigin("/workspace/topology/kind")
        : configAuthorOrigin("/workspace/topology/kind"),
    "/workspace/topology/allocator":
      value.workspace.topology === undefined
        ? workspaceMacroOrigin("/workspace/topology/allocator")
        : configAuthorOrigin("/workspace/topology/allocator"),
    "/deployment/backend": `derived:/target/kind`,
    "/deployment/adapter": `derived:/target/kind`,
    "/deployment/codec": workspaceMacroOrigin("/deployment/codec"),
    "/deployment/providerStrategy": `derived:/llm/route`,
    "/workspace/providerResourceId": `derived:/deployment/id+/workspace/binding+/workspace/topology+/agent/scope`,
    "/workspace/cloudflareSandboxId": `derived:/workspace/providerResourceId`,
  };
  return {
    ok: true,
    value: {
      config: value,
      deployment: {
        deploymentId: value.deployment.id,
        manifest: manifestWithWorkspaceMaterial.manifest,
        backend: "cloudflare-do",
        adapter: AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1,
        codec: "agentos-json@1",
        providerStrategy: value.llm.route,
      },
      ...(value.deployment.version === undefined
        ? {}
        : { deploymentVersion: value.deployment.version }),
      authoredToolNames: Object.keys(compiled.toolFilePaths).sort(),
      target: value.target,
      client: value.client,
      llm: value.llm,
      workspace: {
        binding: value.workspace.binding,
        bindingRef,
        root: value.workspace.root,
        topology,
        providerResourceId,
        cloudflareSandboxId,
      },
      origins,
      provenance: {
        manifest: manifestWithWorkspaceMaterial.provenance,
        deployment: origins,
        exclusions: workspaceDefaults.exclusions,
      },
    },
  };
};

const generatedPath = <Path extends StaticTargetGeneratedFilePath>(path: Path, text: string) => ({
  path,
  text,
});

const stableJsonValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableJsonValue);
  const record = value as Readonly<Record<string, unknown>>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = stableJsonValue(record[key]);
  return sorted;
};

const stableJson = (value: unknown): string =>
  `${JSON.stringify(stableJsonValue(value), null, 2)}\n`;

const jsString = (value: string): string => JSON.stringify(value);

const importToolPath = (toolName: string): string => `../../agent/tools/${toolName}`;

const workspaceMutationToolNames = new Set<WorkspaceToolName>(
  WORKSPACE_TOOL_EXPOSURE_PROFILES.mutation,
);
const workspaceShellToolNames = new Set<WorkspaceToolName>(WORKSPACE_TOOL_EXPOSURE_PROFILES.shell);

const SOURCE_PACKAGE_SCOPE = "@agent-os";
const INJECTED_PUBLIC_PACKAGE_SCOPE = "__AGENTOS_PUBLIC_PACKAGE_SCOPE__";
const packageScopePattern = /^@[a-z0-9][a-z0-9._-]*$/u;
const DEFAULT_STATIC_TARGET_PACKAGE_SCOPE = packageScopePattern.test(INJECTED_PUBLIC_PACKAGE_SCOPE)
  ? INJECTED_PUBLIC_PACKAGE_SCOPE
  : SOURCE_PACKAGE_SCOPE;

const publicPackageSpecifier = (scope: string, name: string): string => `${scope}/${name}`;

const staticTargetModules = (scope: string) => ({
  cloudflareDoRuntime: publicPackageSpecifier(scope, "runtime/cloudflare"),
  openAiCompatibleTransport: publicPackageSpecifier(scope, "runtime/llm-effect-ai"),
  workspaceAgentHost: publicPackageSpecifier(scope, "workspace-agent"),
  workspaceBinding: publicPackageSpecifier(scope, "workspace-binding"),
  workspaceEnvCloudflare: publicPackageSpecifier(scope, "workspace-env-cloudflare"),
  clientCore: publicPackageSpecifier(scope, "client"),
  clientSvelte: publicPackageSpecifier(scope, "client/svelte"),
  runtimeProtocol: publicPackageSpecifier(scope, "core/runtime-protocol"),
  sseHttp: publicPackageSpecifier(scope, "sse-http"),
  cloudflareSandbox: "@cloudflare/sandbox",
  svelteKitServer: "$app/server",
  svelteKitKit: "@sveltejs/kit",
  effect: "effect",
  svelteStore: "svelte/store",
});

const renderNamedImport = (names: ReadonlyArray<string>, source: string): string =>
  `import { ${names.join(", ")} } ${"from"} ${jsString(source)};`;

const renderTypeImport = (names: ReadonlyArray<string>, source: string): string =>
  `import type { ${names.join(", ")} } ${"from"} ${jsString(source)};`;

const generatedToolImports = (
  toolNames: ReadonlyArray<string>,
): ReadonlyArray<StaticTargetModuleImport> =>
  toolNames.map((toolName, index) => ({
    kind: "authored-tool",
    source: importToolPath(toolName),
    imports: [`default as tool_${index}`],
  }));

const renderStaticTarget = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
  toolNames: ReadonlyArray<string>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const authoredToolNames = new Set(normalized.authoredToolNames);
  const workspaceToolList = toolNames.filter(
    (toolName): toolName is WorkspaceToolName =>
      isWorkspaceToolName(toolName) && !authoredToolNames.has(toolName),
  );
  const customToolNames = toolNames.filter((toolName) => authoredToolNames.has(toolName));
  const toolImports = customToolNames
    .map((toolName, index) => `import tool_${index} from ${jsString(importToolPath(toolName))};`)
    .join("\n");
  const customToolRecord =
    customToolNames.length === 0
      ? "{}"
      : `{\n${customToolNames
          .map((toolName, index) => `  ${jsString(toolName)}: tool_${index},`)
          .join("\n")}\n}`;
  const workspaceToolArray = `[${workspaceToolList.map(jsString).join(", ")}] as const`;
  const usesMutationTools = workspaceToolList.some((toolName) =>
    workspaceMutationToolNames.has(toolName),
  );
  const usesShellTools = workspaceToolList.some((toolName) =>
    workspaceShellToolNames.has(toolName),
  );
  const handlerRecord = `{\n${normalized.deployment.manifest.handlers
    .map((handler) => `  ${jsString(handler)}: generatedHandler,`)
    .join("\n")}\n}`;
  const imports = [
    `import semanticDeclarations from "./manifest.json";`,
    `import deploymentProvenance from "./deployment.json";`,
    renderNamedImport(
      ["createAgentDurableObject", "installCloudflareWorkspaceOperationProvider"],
      modules.cloudflareDoRuntime,
    ),
    renderNamedImport(["OpenAiCompatibleLlmTransportLive"], modules.openAiCompatibleTransport),
    renderNamedImport(
      ["defineWorkspaceAgentMount", "WORKSPACE_AGENT_PROJECTION"],
      modules.workspaceAgentHost,
    ),
    renderNamedImport(["bindWorkspaceToolsForRuntime"], modules.workspaceBinding),
    renderNamedImport(["makeCloudflareWorkspaceEnv"], modules.workspaceEnvCloudflare),
    renderNamedImport(["getSandbox"], modules.cloudflareSandbox),
    renderNamedImport(["Effect"], modules.effect),
    renderTypeImport(
      ["AgentManifest", "AgentSubmitBindings", "SubmitResult", "SubmitRunInput"],
      modules.runtimeProtocol,
    ),
    renderTypeImport(["AgentSubmitSpec"], modules.cloudflareDoRuntime),
    renderTypeImport(
      [
        "WorkspaceAgentFileEntry",
        "WorkspaceAgentMutationCommandOutput",
        "WorkspaceAgentReadStateCommandInput",
        "WorkspaceAgentReadStateCommandOutput",
        "WorkspaceAgentReadFileCommandInput",
        "WorkspaceAgentReadFileCommandOutput",
      ],
      modules.workspaceAgentHost,
    ),
    renderTypeImport(["Sandbox", "SandboxTransport"], modules.cloudflareSandbox),
    ...(toolImports.length === 0 ? [] : [toolImports]),
  ].join("\n");
  return `${imports}

export const targetDeclarations = semanticDeclarations;
export const targetDeployment = deploymentProvenance;

const semanticManifest = semanticDeclarations as AgentManifest;
const generatedHandler = () => undefined;

type AgentOSTargetEnv = {
  readonly [binding: string]: unknown;
  readonly SANDBOX_TRANSPORT?: SandboxTransport;
  readonly OPENROUTER_KEY?: string;
  readonly OPENROUTER_ENDPOINT?: string;
  readonly OPENROUTER_DEFAULT_TEXT_MODEL?: string;
};

type GeneratedTargetFailure = {
  readonly ok: false;
  readonly message: string;
};

type GeneratedTargetResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | GeneratedTargetFailure;

const targetFailure = (message: string): GeneratedTargetFailure => ({ ok: false, message });

const rejectTargetFailure = (failure: GeneratedTargetFailure): Promise<never> =>
  Promise.reject(Error(failure.message));

const generatedWorkspaceToolNames = ${workspaceToolArray};
const generatedCustomTools = ${customToolRecord};
const generatedWorkspaceSandboxId = ${jsString(normalized.workspace.cloudflareSandboxId)};

const workspaceNamespaceFor = (env: AgentOSTargetEnv): DurableObjectNamespace<Sandbox> =>
  env[${jsString(normalized.workspace.binding)}] as DurableObjectNamespace<Sandbox>;

const workspaceSandboxFor = (env: AgentOSTargetEnv): Sandbox =>
  getSandbox(workspaceNamespaceFor(env), generatedWorkspaceSandboxId, {
    normalizeId: true,
    sleepAfter: "10m",
    transport: env.SANDBOX_TRANSPORT ?? "rpc",
  });

type WorkspacePathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

const workspacePathFor = (path: string): WorkspacePathResult => {
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === "..")) {
    return { ok: false, message: "path escapes workspace" };
  }
  return {
    ok: true,
    path: parts.length === 0 ? ${jsString(normalized.workspace.root)} : ${jsString(
      `${normalized.workspace.root}/`,
    )} + parts.join("/"),
  };
};

const relativeWorkspacePath = (path: string): string =>
  path.startsWith(${jsString(`${normalized.workspace.root}/`)})
    ? path.slice(${normalized.workspace.root.length + 1})
    : path;

type WorkspaceListFile = {
  readonly type?: string;
  readonly relativePath?: string;
  readonly absolutePath?: string;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly sha256?: string;
};

const workspaceFileKind = (type: string | undefined): WorkspaceAgentFileEntry["kind"] =>
  type === "file" || type === "directory" ? type : "other";

const workspaceFileEntryFor = (value: unknown): WorkspaceAgentFileEntry | null => {
  if (typeof value === "string") {
    return { path: relativeWorkspacePath(value), kind: "file" };
  }
  if (value === null || typeof value !== "object") return null;
  const file = value as WorkspaceListFile;
  const path =
    typeof file.relativePath === "string" && file.relativePath.length > 0
      ? file.relativePath
      : typeof file.absolutePath === "string" && file.absolutePath.length > 0
        ? relativeWorkspacePath(file.absolutePath)
        : "";
  if (path.length === 0) return null;
  return {
    path,
    kind: workspaceFileKind(file.type),
    ...(typeof file.size === "number" ? { size: file.size } : {}),
    ...(typeof file.mtimeMs === "number" ? { mtimeMs: file.mtimeMs } : {}),
    ...(typeof file.sha256 === "string" ? { sha256: file.sha256 } : {}),
  };
};

const workspaceEnvFor = (env: AgentOSTargetEnv) =>
  makeCloudflareWorkspaceEnv({
    client: workspaceSandboxFor(env),
    cwd: ${jsString(normalized.workspace.root)},
    workspaceRef: ${jsString(normalized.workspace.providerResourceId)},
  });

const allowWorkspaceTool = () =>
  Effect.succeed({ ok: true as const }).pipe(
    Effect.withSpan("agentos.generated.workspace.allow_tool"),
  );

const workspaceOperationInstallFor = (env: AgentOSTargetEnv) =>
  installCloudflareWorkspaceOperationProvider({
    env: workspaceEnvFor(env),
  });

const openRouterEndpoint = (env: AgentOSTargetEnv): string =>
  env.OPENROUTER_ENDPOINT ?? "https://openrouter.ai/api/v1";

const openRouterDefaultTextModel = (env: AgentOSTargetEnv): string | null =>
  env.OPENROUTER_DEFAULT_TEXT_MODEL === undefined || env.OPENROUTER_DEFAULT_TEXT_MODEL.length === 0
    ? null
    : env.OPENROUTER_DEFAULT_TEXT_MODEL;

const materialValue = (
  env: AgentOSTargetEnv,
  ref: { readonly kind: string; readonly ref: string },
): NonNullable<unknown> | null => {
  if (ref.kind === "endpoint" && ref.ref === ${jsString(normalized.llm.endpointRef)}) {
    return openRouterEndpoint(env);
  }
  if (ref.kind === "credential" && ref.ref === ${jsString(normalized.llm.credentialRef)}) {
    return env.OPENROUTER_KEY === undefined || env.OPENROUTER_KEY.length === 0
      ? null
      : env.OPENROUTER_KEY;
  }
  if (ref.kind === "model" && ref.ref === ${jsString(normalized.llm.modelRef)}) {
    return openRouterDefaultTextModel(env);
  }
  return null;
};

const requiredStringMaterial = (
  kind: string,
  ref: string,
  value: NonNullable<unknown> | null,
): GeneratedTargetResult<string> => {
  if (typeof value === "string" && value.length > 0) return { ok: true, value };
  return targetFailure(\`missing \${kind} material: \${ref}\`);
};

const generatedLlmRouteFor = (env: AgentOSTargetEnv): GeneratedTargetResult<NonNullable<AgentSubmitBindings["llmRoutes"]>["default"]> => {
  const modelId = requiredStringMaterial(
    "model",
    ${jsString(normalized.llm.modelRef)},
    materialValue(env, { kind: "model", ref: ${jsString(normalized.llm.modelRef)} }),
  );
  if (!modelId.ok) return modelId;
  return {
    ok: true,
    value: {
      kind: "openai-chat-compatible",
      endpointRef: ${jsString(normalized.llm.endpointRef)},
      credentialRef: ${jsString(normalized.llm.credentialRef)},
      modelId: modelId.value,
    },
  };
};

const generatedWorkspaceBindingsFor = (env: AgentOSTargetEnv): AgentSubmitBindings =>
  generatedWorkspaceToolNames.length === 0
    ? {}
    : bindWorkspaceToolsForRuntime({
        env: workspaceEnvFor(env),
        authority: "agentos.workspace.static-target",
        admit: allowWorkspaceTool,
        toolNames: generatedWorkspaceToolNames,
        mutationPolicy: ${usesMutationTools ? '"receipt-backed"' : '"disabled"'},
        shellPolicy: ${usesShellTools ? '"receipt-backed"' : '"disabled"'},
      });

const generatedSubmitBindingsFor = (env: AgentOSTargetEnv): GeneratedTargetResult<AgentSubmitBindings> => {
  const workspaceBindings = generatedWorkspaceBindingsFor(env);
  const route = generatedLlmRouteFor(env);
  if (!route.ok) return route;
  return {
    ok: true,
    value: {
      ...workspaceBindings,
      llmRoutes: {
        default: route.value,
      },
      tools: {
        ...(workspaceBindings.tools ?? {}),
        ...generatedCustomTools,
      },
    },
  };
};

const submitSpecFromRunInput = (input: SubmitRunInput): AgentSubmitSpec => ({
  input,
  intent: input.intent,
  context: input.context,
  ...(input.system === undefined ? {} : { system: input.system }),
  ...(input.budget === undefined ? {} : { budget: input.budget }),
  ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
  ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
  ...(input.materials === undefined ? {} : { materials: input.materials }),
  ...(input.toolContext === undefined ? {} : { toolContext: input.toolContext }),
  ...(input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy }),
  ...(input.decisionInterrupts === undefined ? {} : { decisionInterrupts: input.decisionInterrupts }),
  ...(input.resume === undefined ? {} : { resume: input.resume }),
});

export const workspaceMount = defineWorkspaceAgentMount({
  driver: { kind: "driver_mount", client: undefined as never },
  projectionSinks: [
    { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.AGENT_INFO },
    { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.STATE },
    { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.FILES },
    { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.RUN_EVENTS },
    { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.INPUT_REQUESTS },
  ],
});

const Base${normalized.target.durableObject.className} = createAgentDurableObject<AgentOSTargetEnv>({
  manifest: semanticManifest,
  agentBindings: {
    handlers: ${handlerRecord},
  },
  refResolver: (env) => ({
    material: (ref) => materialValue(env, ref),
  }),
  llmTransport: () => OpenAiCompatibleLlmTransportLive,
  extensions: (env) => workspaceOperationInstallFor(env).extensions,
  declaredIntents: (env) => workspaceOperationInstallFor(env).declaredIntents,
  projections: (env) => workspaceOperationInstallFor(env).projections,
  eventHandlers: (context, env) => workspaceOperationInstallFor(env).eventHandlers(context),
});

export class ${normalized.target.durableObject.className} extends Base${normalized.target.durableObject.className} {
  private readonly targetEnv: AgentOSTargetEnv;

  constructor(ctx: DurableObjectState, env: AgentOSTargetEnv) {
    super(ctx, env);
    this.targetEnv = env;
  }

  override submit(spec: AgentSubmitSpec): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.submitWithBindings(spec, bindings.value)
      : rejectTargetFailure(bindings);
  }

  submitRunInput(input: SubmitRunInput): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.submitWithBindings(submitSpecFromRunInput(input), bindings.value)
      : rejectTargetFailure(bindings);
  }

  readWorkspaceState(
    input: WorkspaceAgentReadStateCommandInput = {},
  ): Promise<WorkspaceAgentReadStateCommandOutput> {
    const sandbox = workspaceSandboxFor(this.targetEnv);
    return sandbox
      .mkdir(${jsString(normalized.workspace.root)}, { recursive: true })
      .then(() =>
        sandbox.listFiles(${jsString(normalized.workspace.root)}, {
          recursive: true,
          includeHidden: input.includeHidden ?? true,
        }),
      )
      .then((listed) => ({
        workspaceRef: ${jsString(normalized.workspace.providerResourceId)},
        files: listed.files
          .map(workspaceFileEntryFor)
          .filter((file): file is WorkspaceAgentFileEntry => file !== null)
          .sort((left, right) => left.path.localeCompare(right.path)),
      }));
  }

  readWorkspaceFile(
    input: WorkspaceAgentReadFileCommandInput,
  ): Promise<WorkspaceAgentReadFileCommandOutput> {
    const path = workspacePathFor(input.path);
    if (!path.ok) return Promise.reject(new TypeError(path.message));
    return workspaceSandboxFor(this.targetEnv)
      .readFile(path.path, {
        encoding: input.encoding ?? "utf-8",
      })
      .then((file) => ({
        path: relativeWorkspacePath(path.path),
        content: file.content,
      }));
  }

  resetWorkspace(): Promise<WorkspaceAgentMutationCommandOutput> {
    const sandbox = workspaceSandboxFor(this.targetEnv);
    return sandbox
      .destroy()
      .then(() => sandbox.mkdir(${jsString(normalized.workspace.root)}, { recursive: true }))
      .then(() => ({ ok: true as const }));
  }

  destroyWorkspace(): Promise<WorkspaceAgentMutationCommandOutput> {
    return workspaceSandboxFor(this.targetEnv)
      .destroy()
      .then(() => ({ ok: true as const }));
  }
}
`;
};

const generatedClientModuleImports = (
  client: AgentOsConfigClient,
  modules: ReturnType<typeof staticTargetModules>,
): ReadonlyArray<StaticTargetModuleImport> => [
  {
    kind: "workspace-client",
    source: modules.workspaceAgentHost,
    imports: [
      "createWorkspaceAgentClientBridge",
      "CreateWorkspaceAgentClientOptions",
      "WorkspaceAgentClientBridge",
    ],
  },
  ...(client.kind === AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1
    ? [
        {
          kind: "client-transport" as const,
          source: "./sveltekit.remote",
          imports: ["invokeAgentCommand", "runEventStream"],
        },
        {
          kind: "client-transport" as const,
          source: modules.svelteKitServer,
          imports: ["command", "getRequestEvent", "query"],
        },
        {
          kind: "client-transport" as const,
          source: modules.sseHttp,
          imports: ["decodeSseHttpEvents", "responseToSseHttpChunks"],
        },
        {
          kind: "client-core" as const,
          source: modules.clientCore,
          imports: ["AgentClientSnapshot"],
        },
        {
          kind: "client-framework" as const,
          source: modules.clientSvelte,
          imports: ["clientReadable", "selectClientReadable"],
        },
        {
          kind: "client-framework" as const,
          source: modules.svelteStore,
          imports: ["Readable"],
        },
      ]
    : []),
];

const renderSvelteKitRemote = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string => `${renderNamedImport(["command", "getRequestEvent", "query"], modules.svelteKitServer)}
${renderNamedImport(["durableObjectRpcClient"], `${modules.cloudflareDoRuntime}/do-rpc`)}
${renderNamedImport(["decodeSseHttpEvents", "responseToSseHttpChunks"], modules.sseHttp)}
${renderNamedImport(["Result", "Schema"], modules.effect)}
${renderNamedImport(["WORKSPACE_AGENT_COMMAND"], modules.workspaceAgentHost)}
${renderNamedImport(["decodeRuntimeLedgerEvent", "manifestTruthIdentity"], modules.runtimeProtocol)}
${renderTypeImport(["AgentRuntimeClient"], modules.cloudflareDoRuntime)}
${renderTypeImport(["SseHttpEvent"], modules.sseHttp)}
${renderTypeImport(
  ["AgentManifest", "RuntimeLedgerEvent", "SubmitResult", "SubmitRunInput"],
  modules.runtimeProtocol,
)}
${renderTypeImport(
  [
    "WorkspaceAgentCommandMap",
    "WorkspaceAgentDestroyCommandInput",
    "WorkspaceAgentReadFileCommandInput",
    "WorkspaceAgentReadStateCommandInput",
    "WorkspaceAgentResetCommandInput",
  ],
  modules.workspaceAgentHost,
)}
import manifest from "./manifest.json";

type AgentOSTargetEnv = {
  readonly [binding: string]: unknown;
};

type AgentOSRpc = Pick<AgentRuntimeClient, "events" | "streamEvents"> & {
  readonly submitRunInput: (input: SubmitRunInput) => Promise<SubmitResult>;
  readonly readWorkspaceFile: (
    input: WorkspaceAgentReadFileCommandInput,
  ) => Promise<WorkspaceAgentCommandMap[typeof WORKSPACE_AGENT_COMMAND.READ_FILE]["output"]>;
  readonly readWorkspaceState: (
    input?: WorkspaceAgentReadStateCommandInput,
  ) => Promise<WorkspaceAgentCommandMap[typeof WORKSPACE_AGENT_COMMAND.READ_STATE]["output"]>;
  readonly resetWorkspace: (
    input?: WorkspaceAgentResetCommandInput,
  ) => Promise<WorkspaceAgentCommandMap[typeof WORKSPACE_AGENT_COMMAND.RESET]["output"]>;
  readonly destroyWorkspace: (
    input?: WorkspaceAgentDestroyCommandInput,
  ) => Promise<WorkspaceAgentCommandMap[typeof WORKSPACE_AGENT_COMMAND.DESTROY]["output"]>;
};

const optionalAfterIdInput = Schema.toStandardSchemaV1(
  Schema.Struct({ afterId: Schema.optional(Schema.Number) }),
);
const commandInput = Schema.toStandardSchemaV1(
  Schema.Struct({
    name: Schema.String,
    input: Schema.Unknown,
  }),
);
const agentTruthIdentity = manifestTruthIdentity(manifest as AgentManifest);

type GeneratedFailure = {
  readonly ok: false;
  readonly status: number;
  readonly message: string;
};

type GeneratedResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | GeneratedFailure;

const fail = (status: number, message: string): GeneratedFailure => ({
  ok: false,
  status,
  message,
});

const rejectFailure = (failure: GeneratedFailure): Promise<never> =>
  Promise.reject(
    Object.assign(Error(failure.message), {
      status: failure.status,
      body: { message: failure.message },
    }),
  );

const env = (): GeneratedResult<AgentOSTargetEnv> => {
  const platformEnv = getRequestEvent().platform?.env;
  if (platformEnv === undefined) return fail(500, "Cloudflare platform env missing");
  return { ok: true, value: platformEnv as AgentOSTargetEnv };
};

const agentOS = (platformEnv: AgentOSTargetEnv) =>
  durableObjectRpcClient<AgentOSRpc>(
    platformEnv[${jsString(normalized.target.durableObject.binding)}] as DurableObjectNamespace,
    agentTruthIdentity.scopeRef.scopeId,
  );

type AgentOSRemote = ReturnType<typeof agentOS>;
type AgentOSSubmitRunInput = Parameters<AgentOSRemote["submitRunInput"]>[0];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const submitInputFromUnknown = (
  value: unknown,
): GeneratedResult<{ readonly input: AgentOSSubmitRunInput }> => {
  if (!isRecord(value) || !isRecord(value.input)) return fail(400, "invalid submit command input");
  if (typeof value.input.intent !== "string" || !isRecord(value.input.context)) {
    return fail(400, "invalid submit run input");
  }
  return { ok: true, value: { input: value.input as unknown as AgentOSSubmitRunInput } };
};

const readStateInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentReadStateCommandInput> => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail(400, "invalid readState command input");
  if (value.includeHidden !== undefined && typeof value.includeHidden !== "boolean") {
    return fail(400, "invalid readState includeHidden");
  }
  return {
    ok: true,
    value:
      value.includeHidden === undefined
        ? {}
        : { includeHidden: value.includeHidden },
  };
};

const readFileInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentReadFileCommandInput> => {
  if (!isRecord(value) || typeof value.path !== "string") {
    return fail(400, "invalid readFile command input");
  }
  if (value.encoding !== undefined && value.encoding !== "utf-8") {
    return fail(400, "unsupported readFile encoding");
  }
  return {
    ok: true,
    value: {
      path: value.path,
      ...(value.encoding === undefined ? {} : { encoding: value.encoding }),
    },
  };
};

const resetInputFromUnknown = (value: unknown): GeneratedResult<WorkspaceAgentResetCommandInput> => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail(400, "invalid reset command input");
  return { ok: true, value: typeof value.reason === "string" ? { reason: value.reason } : {} };
};

const destroyInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentDestroyCommandInput> => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail(400, "invalid destroy command input");
  return { ok: true, value: typeof value.reason === "string" ? { reason: value.reason } : {} };
};

const runtimeEventFromLedger = (
  event: Parameters<typeof decodeRuntimeLedgerEvent>[0],
): RuntimeLedgerEvent | null => {
  const decoded = decodeRuntimeLedgerEvent(event);
  return decoded._tag === "runtime" ? decoded.event : null;
};

const jsonValueFromString = (data: string): GeneratedResult<unknown> =>
  Result.match(
    Result.try({
      try: () => JSON.parse(data) as unknown,
      catch: () => "invalid ledger stream event: malformed JSON",
    }),
    {
      onFailure: (message) => fail(502, message),
      onSuccess: (value) => ({ ok: true, value }),
    },
  );

const ledgerEventFromSse = (
  event: SseHttpEvent,
): GeneratedResult<Parameters<typeof decodeRuntimeLedgerEvent>[0] | null> => {
  if (event.event !== "ledger") return { ok: true, value: null };
  if (event.data.trim().length === 0) {
    return fail(502, "invalid ledger stream event: empty data");
  }
  const parsed = jsonValueFromString(event.data);
  return parsed.ok
    ? { ok: true, value: parsed.value as Parameters<typeof decodeRuntimeLedgerEvent>[0] }
    : parsed;
};

const emptyRuntimeEvents = (): AsyncIterable<RuntimeLedgerEvent> => ({
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    };
  },
});

const runtimeEventsFromSse = (response: Response): AsyncIterable<RuntimeLedgerEvent> => {
  if (response.body === null) return emptyRuntimeEvents();
  const source = decodeSseHttpEvents(responseToSseHttpChunks(response));
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      const next = (): Promise<IteratorResult<RuntimeLedgerEvent>> =>
        iterator.next().then((result) => {
          if (result.done === true) return { done: true, value: undefined };
          const ledgerEvent = ledgerEventFromSse(result.value);
          if (!ledgerEvent.ok) return rejectFailure(ledgerEvent);
          if (ledgerEvent.value === null) return next();
          const runtimeEvent = runtimeEventFromLedger(ledgerEvent.value);
          return runtimeEvent === null ? next() : { done: false, value: runtimeEvent };
        });
      return {
        next,
        return: () =>
          iterator.return === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : iterator.return(undefined).then(() => ({ done: true, value: undefined })),
      };
    },
  };
};

export const invokeAgentCommand = command(commandInput, ({ name, input }): Promise<unknown> => {
  const platformEnv = env();
  if (!platformEnv.ok) return rejectFailure(platformEnv);
  const runtime = agentOS(platformEnv.value);
  if (name === WORKSPACE_AGENT_COMMAND.SUBMIT) {
    const submitInput = submitInputFromUnknown(input);
    return submitInput.ok
      ? runtime.submitRunInput(submitInput.value.input)
      : rejectFailure(submitInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.READ_STATE) {
    const readStateInput = readStateInputFromUnknown(input);
    return readStateInput.ok
      ? runtime.readWorkspaceState(readStateInput.value)
      : rejectFailure(readStateInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.READ_FILE) {
    const readFileInput = readFileInputFromUnknown(input);
    return readFileInput.ok
      ? runtime.readWorkspaceFile(readFileInput.value)
      : rejectFailure(readFileInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.RESET) {
    const resetInput = resetInputFromUnknown(input);
    return resetInput.ok ? runtime.resetWorkspace(resetInput.value) : rejectFailure(resetInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.DESTROY) {
    const destroyInput = destroyInputFromUnknown(input);
    return destroyInput.ok
      ? runtime.destroyWorkspace(destroyInput.value)
      : rejectFailure(destroyInput);
  }
  return rejectFailure(fail(501, \`unsupported generated workspace command \${name}\`));
});

export const runEventStream = query.live(optionalAfterIdInput, (input) => {
  const afterId = input.afterId ?? 0;
  const platformEnv = env();
  if (!platformEnv.ok) return rejectFailure(platformEnv);
  return agentOS(platformEnv.value)
    .streamEvents(agentTruthIdentity, afterId > 0 ? { afterId } : {})
    .then(runtimeEventsFromSse);
});
`;

const renderStaticClient = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  if (normalized.client.kind === AGENTOS_CONFIG_CLIENT.BROWSER_DIRECT_V1) {
    return `${renderNamedImport(["createWorkspaceAgentClientBridge"], modules.workspaceAgentHost)}
${renderTypeImport(
  ["CreateWorkspaceAgentClientOptions", "WorkspaceAgentClientBridge"],
  modules.workspaceAgentHost,
)}

export type GeneratedAgentClientOptions = CreateWorkspaceAgentClientOptions;
export type GeneratedAgentClient = WorkspaceAgentClientBridge;

export const createAgentOSClient = (
  options: GeneratedAgentClientOptions = {},
): GeneratedAgentClient => createWorkspaceAgentClientBridge(options);
`;
  }

  return `${renderNamedImport(["createWorkspaceAgentClientBridge"], modules.workspaceAgentHost)}
import { invokeAgentCommand, runEventStream } from "./sveltekit.remote";
${renderNamedImport(["clientReadable", "selectClientReadable"], modules.clientSvelte)}
${renderTypeImport(["AgentClientSnapshot"], modules.clientCore)}
${renderTypeImport(
  ["CreateWorkspaceAgentClientOptions", "WorkspaceAgentClient", "WorkspaceAgentClientBridge"],
  modules.workspaceAgentHost,
)}
${renderTypeImport(["Readable"], modules.svelteStore)}

export type GeneratedAgentClientOptions = CreateWorkspaceAgentClientOptions;

export interface GeneratedAgentClient extends WorkspaceAgentClientBridge {
  readonly snapshot: Readable<AgentClientSnapshot>;
  readonly events: Readable<AgentClientSnapshot["events"]>;
  readonly connection: Readable<AgentClientSnapshot["connection"]>;
  readonly run: Readable<AgentClientSnapshot["run"]>;
  readonly inputRequests: Readable<AgentClientSnapshot["run"]["inputRequests"]>;
}

const generatedStreamSource: NonNullable<GeneratedAgentClientOptions["streamSource"]> = {
  open: (cursor) =>
    runEventStream({
      ...(cursor.afterEventId === undefined ? {} : { afterId: cursor.afterEventId }),
    }),
};

const generatedRpcInvoker: WorkspaceAgentClient["invoke"] = (name, input) =>
  invokeAgentCommand({ name, input }) as ReturnType<WorkspaceAgentClient["invoke"]>;

export const createAgentOSClient = (
  options: GeneratedAgentClientOptions = {},
): GeneratedAgentClient => {
  const bridge = createWorkspaceAgentClientBridge({
    ...options,
    streamSource: options.streamSource ?? generatedStreamSource,
    rpcInvoker: options.rpcInvoker ?? generatedRpcInvoker,
  });
  return {
    ...bridge,
    snapshot: clientReadable(bridge.client),
    events: selectClientReadable(bridge.client, (snapshot) => snapshot.events),
    connection: selectClientReadable(bridge.client, (snapshot) => snapshot.connection),
    run: selectClientReadable(bridge.client, (snapshot) => snapshot.run),
    inputRequests: selectClientReadable(bridge.client, (snapshot) => snapshot.run.inputRequests),
  };
};
`;
};

const renderStaticClientTypes = (): string => `export type {
  GeneratedAgentClient,
  GeneratedAgentClientOptions,
} from "./client";

export { createAgentOSClient } from "./client";
`;

/**
 * Link normalized workspace authoring intent to a closed-target residual
 * program. Implementation wiring is static imports and factory composition;
 * manifest and deployment JSON remain semantic/provenance data only.
 *
 * @agentosPrimitive primitive.agent-authoring.linkWorkspaceStaticTarget
 * @agentosInvariant invariant.docs.agent-projection
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/guides/build-natural-language-workspace-agent.md
 */
export const linkWorkspaceStaticTarget = <K extends HandlerKind = HandlerKind>(
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest<K>>,
  options: StaticTargetLinkOptions = {},
): StaticTargetLinkResult => {
  const packageScope = options.packageScope ?? DEFAULT_STATIC_TARGET_PACKAGE_SCOPE;
  if (!packageScopePattern.test(packageScope)) {
    return {
      ok: false,
      issues: [{ kind: "invalid_static_package_scope", scope: packageScope }],
    };
  }
  const modules = staticTargetModules(packageScope);
  if (normalized.target.kind !== AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1) {
    return {
      ok: false,
      issues: [{ kind: "unsupported_static_target", target: normalized.target.kind }],
    };
  }
  if (normalized.llm.route !== AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE) {
    return {
      ok: false,
      issues: [{ kind: "unsupported_static_llm_route", route: normalized.llm.route }],
    };
  }
  const toolNames = Object.keys(normalized.deployment.manifest.tools ?? {}).sort();
  const authoredToolNames = new Set(normalized.authoredToolNames);
  const authoredManifestToolNames = toolNames.filter((toolName) => authoredToolNames.has(toolName));
  const deploymentJson = {
    deploymentId: normalized.deployment.deploymentId,
    backend: normalized.deployment.backend,
    adapter: normalized.deployment.adapter,
    codec: normalized.deployment.codec,
    ...(normalized.deployment.providerStrategy === undefined
      ? {}
      : { providerStrategy: normalized.deployment.providerStrategy }),
    workspace: {
      binding: normalized.workspace.binding,
      bindingRef: normalized.workspace.bindingRef,
      root: normalized.workspace.root,
      topology: normalized.workspace.topology,
      providerResourceId: normalized.workspace.providerResourceId,
      cloudflareSandboxId: normalized.workspace.cloudflareSandboxId,
    },
  };
  const moduleGraph: ReadonlyArray<StaticTargetModuleImport> = [
    { kind: "semantic-json", source: "./manifest.json", imports: ["default as declarations"] },
    { kind: "semantic-json", source: "./deployment.json", imports: ["default as deployment"] },
    {
      kind: "target-runtime",
      source: modules.cloudflareDoRuntime,
      imports: ["createAgentDurableObject", "installCloudflareWorkspaceOperationProvider"],
    },
    {
      kind: "provider-runtime",
      source: modules.openAiCompatibleTransport,
      imports: ["OpenAiCompatibleLlmTransportLive"],
    },
    {
      kind: "workspace-host",
      source: modules.workspaceAgentHost,
      imports: ["defineWorkspaceAgentMount", "WORKSPACE_AGENT_PROJECTION"],
    },
    ...generatedToolImports(authoredManifestToolNames),
    {
      kind: "workspace-binding",
      source: modules.workspaceBinding,
      imports: ["bindWorkspaceToolsForRuntime"],
    },
    {
      kind: "execution-domain-runtime",
      source: modules.workspaceEnvCloudflare,
      imports: ["makeCloudflareWorkspaceEnv"],
    },
    {
      kind: "platform-runtime",
      source: modules.cloudflareSandbox,
      imports: ["getSandbox", "Sandbox", "SandboxTransport"],
    },
    {
      kind: "effect-runtime",
      source: modules.effect,
      imports: ["Effect"],
    },
    ...generatedClientModuleImports(normalized.client, modules),
  ];
  return {
    ok: true,
    value: {
      files: [
        generatedPath(
          ".agentos/generated/manifest.json",
          stableJson(normalized.deployment.manifest),
        ),
        generatedPath(".agentos/generated/deployment.json", stableJson(deploymentJson)),
        generatedPath(".agentos/generated/provenance.json", stableJson(normalized.provenance)),
        generatedPath(
          ".agentos/generated/fingerprints.json",
          stableJson({
            deployment: digestText(stableJson(deploymentJson)),
            manifest: digestText(stableJson(normalized.deployment.manifest)),
            targetModuleGraph: digestText(stableJson(moduleGraph)),
          }),
        ),
        generatedPath(
          ".agentos/generated/target.ts",
          renderStaticTarget(
            normalized as NormalizedAgentOsConfig<AuthoredAgentManifest>,
            toolNames,
            modules,
          ),
        ),
        ...(normalized.client.kind === AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1
          ? [
              generatedPath(
                ".agentos/generated/sveltekit.remote.ts",
                renderSvelteKitRemote(
                  normalized as NormalizedAgentOsConfig<AuthoredAgentManifest>,
                  modules,
                ),
              ),
            ]
          : []),
        generatedPath(
          ".agentos/generated/client.ts",
          renderStaticClient(normalized as NormalizedAgentOsConfig<AuthoredAgentManifest>, modules),
        ),
        generatedPath(".agentos/generated/client.d.ts", renderStaticClientTypes()),
      ],
      moduleGraph,
      canonicalDeployment: {
        target: normalized.target.kind,
        llmRoute: normalized.llm.route,
        client: normalized.client.kind,
        workspaceTopology: normalized.workspace.topology,
        toolNames,
      },
      mount: {
        driver: {
          kind: "cloudflare-do",
          className: normalized.target.durableObject.className,
          binding: normalized.target.durableObject.binding,
        },
        projectionSinks: [
          "agent.info",
          "workspace.state",
          "workspace.files",
          "runtime.events",
          "runtime.input_requests",
        ],
        providerResourceId: normalized.workspace.providerResourceId,
      },
    },
  };
};
