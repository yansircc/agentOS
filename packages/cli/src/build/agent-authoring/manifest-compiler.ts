import type { Authored } from "@agent-os/core";
import { isAgentSchema } from "@agent-os/core/agent-schema";
import type { AgentSchemaSpec } from "@agent-os/core/agent-schema";
import { authoredValue } from "@agent-os/core/authored-value";
import { isAuthorityRef, type AuthorityRef } from "@agent-os/core/effect-claim";
import { isMaterialRef, type MaterialRef } from "@agent-os/core/material-ref";
import type {
  AgentCapabilityBindingRef,
  AgentExecutionDomainRef,
  AgentInstructionsRef,
  AgentInteractionRef,
  AgentLlmRouteBindingRef,
  AgentManifest,
  AgentScopeIdentityPolicy,
  AgentToolBindingRef,
} from "@agent-os/core/runtime-protocol";
import { BUILTIN_HANDLER_KINDS, type HandlerKind } from "@agent-os/core/runtime-protocol";
import {
  WORKSPACE_TOOL_DEFAULT_DECLARATIONS,
  type WorkspaceToolDefaultDeclaration,
  type WorkspaceToolInteractionFloor,
  type WorkspaceToolName,
} from "@agent-os/runtime";
import {
  AUTHORING_DEFAULTS_VERSION,
  digestText,
  findFunctionPath,
  GENERATED_LOAD_SKILL_TOOL_NAME,
  GENERATED_READ_SKILL_FILE_TOOL_NAME,
  hasFunction,
  isNonEmptyString,
  isRecord,
  isWorkspaceToolName,
  type JsonRecord,
} from "./shared";

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

export type AuthoredAgentTreeFile =
  | AuthoredMarkdownFile
  | AuthoredTextFile
  | AuthoredJsonFile
  | AuthoredToolFile
  | AuthoredChannelFile
  | AuthoredWorkflowFile;

export type AuthoredFileSourceKind = "regular" | "symlink" | "non_regular";

export interface AuthoredMarkdownFile {
  readonly path: string;
  readonly kind: "markdown";
  readonly text: string;
  readonly sourceKind?: AuthoredFileSourceKind;
}

export interface AuthoredTextFile {
  readonly path: string;
  readonly kind: "text";
  readonly bytes: Uint8Array;
  readonly sourceKind?: AuthoredFileSourceKind;
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

export interface CompiledAgentChannel {
  readonly name: string;
  readonly path: string;
  readonly origin: AgentManifestOrigin;
}

export interface CompiledAgentWorkflow {
  readonly name: string;
  readonly path: string;
  readonly origin: AgentManifestOrigin;
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
  readonly text: string;
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
  readonly capabilities?: Readonly<Record<string, AgentCapabilityBindingRef>>;
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
  readonly channels: ReadonlyArray<CompiledAgentChannel>;
  readonly workflows: ReadonlyArray<CompiledAgentWorkflow>;
  readonly skills: ReadonlyArray<CompiledAgentSkill>;
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
  | { readonly kind: "reserved_tool_name"; readonly path: string; readonly toolId: string }
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
  readonly channels: Map<string, CompiledAgentChannel>;
  readonly workflows: Map<string, CompiledAgentWorkflow>;
  readonly skills: Map<string, CompiledAgentSkill>;
  readonly skillSupportFiles: Map<string, CompiledAgentSkillFile[]>;
  readonly skillSupportByteTotals: Map<string, number>;
  readonly workspaceToolControls: Map<WorkspaceToolName, WorkspaceDefaultToolControl>;
}

const SKILL_DESCRIPTION_MAX_BYTES = 240;
const SKILL_BODY_MAX_BYTES = 131_072;
const SKILL_SUPPORT_FILE_MAX_BYTES = 65_536;
const SKILL_SUPPORT_FILES_MAX_COUNT = 64;
const SKILL_SUPPORT_PACKAGE_MAX_BYTES = 262_144;
const skillNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const channelNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const workflowNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

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

export const workspaceManifestMacroOrigin = (factKey: AgentManifestFactKey): AgentManifestOrigin =>
  `macro(workspace@1)#${factKey}`;

const authoredPath = (path: string): string =>
  path.startsWith("workflows/") ? path : `agent/${path}`;

const authorOrigin = (path: string, pointer: string): AgentManifestOrigin =>
  `author:${authoredPath(path)}#${pointer}`;

const pathOrigin = (path: string): AgentManifestOrigin => `path:${authoredPath(path)}`;

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

const utf8ByteLength = (value: string): number => textEncoder.encode(value).length;

const isSkillName = (value: string): boolean => skillNamePattern.test(value);

const isChannelName = (value: string): boolean => channelNamePattern.test(value);

const isWorkflowName = (value: string): boolean => workflowNamePattern.test(value);

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

const agentGrammarRoots = new Set([
  "agent.json",
  "channels",
  "domains",
  "instructions.md",
  "interactions",
  "materials",
  "skills",
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
  "capabilities",
  "llmRoutes",
  "tools",
  "materials",
  "executionDomains",
  "interactions",
  "outputSchema",
]);

const materialEffectNames = new Set(["material", "provider_call"]);
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
  const capabilities =
    value.capabilities === undefined
      ? undefined
      : parseRecordMap<AgentCapabilityBindingRef>(
          state,
          path,
          "/capabilities",
          value.capabilities,
          (_capability, child) =>
            parseBindingRefObject<AgentCapabilityBindingRef>(state, path, "/capabilities", child),
        );
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
  if (capabilities !== undefined && capabilities !== null) {
    for (const [capabilityId, ref] of Object.entries(capabilities)) {
      putAuthored(
        state,
        `/capabilities/${capabilityId}/bindingRef`,
        ref.bindingRef,
        authorOrigin(path, `/capabilities/${capabilityId}/bindingRef`),
      );
    }
  }
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
  if (parts[0] !== "skills" || parts.length < 4) return null;
  const skillName = parts[1] ?? "";
  if (!isSkillName(skillName)) return null;
  const root = parts[2];
  if (root !== "references" && root !== "scripts") return null;
  return {
    skillName,
    packagePath: [root, ...parts.slice(3)].join("/"),
  };
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
  const text = decodeUtf8Bytes(state, path, "/bytes", bytes);
  if (text === null || !assertNoNulText(state, path, "/bytes", text)) return;
  files.push({
    path: supportPath.packagePath,
    digest: digestText(text),
    bytes: bytes.byteLength,
    text,
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

const recordTextFile = (
  state: CompilerState,
  path: string,
  bytes: Uint8Array,
  sourceKind?: AuthoredFileSourceKind,
): void => {
  const supportPath = skillSupportPathForPath(path);
  if (supportPath === null) {
    state.issues.push({ kind: "unsupported_path", path, reason: "text_path_not_in_grammar" });
    return;
  }
  recordSkillSupportFile(state, path, supportPath, bytes, sourceKind);
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
  if (toolId === GENERATED_LOAD_SKILL_TOOL_NAME || toolId === GENERATED_READ_SKILL_FILE_TOOL_NAME) {
    state.issues.push({ kind: "reserved_tool_name", path, toolId });
    return;
  }
  state.toolFilePaths.set(toolId, path);
  recordToolFacts(state, toolId, path, declaration ?? {}, (field) => authorOrigin(path, field));
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
  const capabilities = collectRecord<AgentCapabilityBindingRef>(state, "/capabilities/", (id) => {
    const bindingRef = factValue<string>(state, `/capabilities/${id}/bindingRef`);
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
    ...(capabilities === undefined ? {} : { capabilities }),
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

const buildChannels = (state: CompilerState): ReadonlyArray<CompiledAgentChannel> =>
  [...state.channels.values()].sort((left, right) => left.name.localeCompare(right.name));

const buildWorkflows = (state: CompilerState): ReadonlyArray<CompiledAgentWorkflow> =>
  [...state.workflows.values()].sort((left, right) => left.name.localeCompare(right.name));

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

const buildSkills = (state: CompilerState): ReadonlyArray<CompiledAgentSkill> =>
  [...state.skills.values()]
    .map((skill) => ({
      ...skill,
      files: [...(state.skillSupportFiles.get(skill.name) ?? [])].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

/**
 * Compile authored `agent/` and `workflows/` roots into one normalized
 * manifest plus authoring facts. This is the app-author entrypoint; runtime
 * facts and provider material are rejected before they can become manifest
 * truth.
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
    channels: new Map(),
    workflows: new Map(),
    skills: new Map(),
    skillSupportFiles: new Map(),
    skillSupportByteTotals: new Map(),
    workspaceToolControls: new Map(),
  };

  for (const file of tree.files) {
    const path = registerPath(state, file.path);
    if (path === null) continue;
    switch (file.kind) {
      case "markdown":
        recordMarkdownFile(state, path, file.text, file.sourceKind);
        break;
      case "text":
        recordTextFile(state, path, file.bytes, file.sourceKind);
        break;
      case "json":
        recordJsonFile(state, path, file.value);
        break;
      case "tool":
        recordToolFile(state, path, file.declaration);
        break;
      case "channel":
        recordChannelFile(state, path, file.sourceKind);
        break;
      case "workflow":
        recordWorkflowFile(state, path, file.sourceKind);
        break;
    }
  }

  validateSkillSupportFiles(state);
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
      channels: buildChannels(state),
      workflows: buildWorkflows(state),
      skills: buildSkills(state),
    },
  };
};
