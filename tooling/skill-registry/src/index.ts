import { isOriginRef, type OriginRef } from "@agent-os/kernel/effect-claim";
import { isMaterialRequirement, type MaterialRequirement } from "@agent-os/kernel/material-ref";
import {
  defineToolFromDefinition,
  type Tool,
  type ToolAdmitter,
  type ToolDefinition,
} from "@agent-os/kernel/tools";

export interface SkillToolManifest {
  readonly definition: ToolDefinition;
  readonly authorityClass: string;
  readonly authorityId?: string;
  readonly requiredMaterials?: ReadonlyArray<MaterialRequirement>;
  readonly admit: ToolAdmitter;
  readonly execute: (args: unknown) => Promise<unknown>;
}

export interface SkillManifest {
  readonly skillId: string;
  readonly version: string;
  readonly originRef: OriginRef;
  readonly tools: ReadonlyArray<SkillToolManifest>;
}

export type SkillRegistryIssue =
  | { readonly kind: "invalid_skill_id" }
  | { readonly kind: "invalid_version"; readonly skillId?: string }
  | { readonly kind: "invalid_origin_ref"; readonly skillId?: string }
  | { readonly kind: "invalid_tools"; readonly skillId?: string }
  | { readonly kind: "invalid_tool_definition"; readonly skillId?: string; readonly index: number }
  | { readonly kind: "duplicate_tool_id"; readonly skillId?: string; readonly toolId: string }
  | { readonly kind: "invalid_authority_class"; readonly skillId?: string; readonly toolId: string }
  | {
      readonly kind: "invalid_required_material";
      readonly skillId?: string;
      readonly toolId: string;
    }
  | { readonly kind: "invalid_admitter"; readonly skillId?: string; readonly toolId: string }
  | { readonly kind: "invalid_execute"; readonly skillId?: string; readonly toolId: string }
  | { readonly kind: "tool_not_registered"; readonly skillId: string; readonly toolId: string };

export interface RegisteredSkill {
  readonly skillId: string;
  readonly version: string;
  readonly toolIds: ReadonlyArray<string>;
  readonly tools: Readonly<Record<string, Tool>>;
}

export type RegisterSkillResult =
  | { readonly ok: true; readonly registration: RegisteredSkill }
  | { readonly ok: false; readonly issues: ReadonlyArray<SkillRegistryIssue> };

export type UnregisterSkillResult =
  | { readonly ok: true; readonly tools: Readonly<Record<string, Tool>> }
  | { readonly ok: false; readonly issues: ReadonlyArray<SkillRegistryIssue> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const toolNameOf = (tool: SkillToolManifest): string | null =>
  tool.definition.type === "function" &&
  isRecord(tool.definition.function) &&
  isNonEmptyString(tool.definition.function.name)
    ? tool.definition.function.name
    : null;

const isToolDefinition = (value: unknown): value is ToolDefinition =>
  isRecord(value) &&
  value.type === "function" &&
  isRecord(value.function) &&
  isNonEmptyString(value.function.name) &&
  isNonEmptyString(value.function.description) &&
  isRecord(value.function.parameters);

const validateManifest = (manifest: SkillManifest): ReadonlyArray<SkillRegistryIssue> => {
  const issues: SkillRegistryIssue[] = [];
  const skillId = isNonEmptyString(manifest.skillId) ? manifest.skillId : undefined;

  if (skillId === undefined) {
    issues.push({ kind: "invalid_skill_id" });
  }
  if (!isNonEmptyString(manifest.version)) {
    issues.push({ kind: "invalid_version", ...(skillId === undefined ? {} : { skillId }) });
  }
  if (!isOriginRef(manifest.originRef)) {
    issues.push({ kind: "invalid_origin_ref", ...(skillId === undefined ? {} : { skillId }) });
  }
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    issues.push({ kind: "invalid_tools", ...(skillId === undefined ? {} : { skillId }) });
    return issues;
  }

  const seen = new Set<string>();
  manifest.tools.forEach((tool, index) => {
    if (!isToolDefinition(tool.definition)) {
      issues.push({
        kind: "invalid_tool_definition",
        ...(skillId === undefined ? {} : { skillId }),
        index,
      });
      return;
    }

    const toolId = toolNameOf(tool);
    if (toolId === null) {
      issues.push({
        kind: "invalid_tool_definition",
        ...(skillId === undefined ? {} : { skillId }),
        index,
      });
      return;
    }
    if (seen.has(toolId)) {
      issues.push({
        kind: "duplicate_tool_id",
        ...(skillId === undefined ? {} : { skillId }),
        toolId,
      });
    }
    seen.add(toolId);

    if (!isNonEmptyString(tool.authorityClass)) {
      issues.push({
        kind: "invalid_authority_class",
        ...(skillId === undefined ? {} : { skillId }),
        toolId,
      });
    }
    if (
      tool.requiredMaterials !== undefined &&
      (!Array.isArray(tool.requiredMaterials) ||
        !tool.requiredMaterials.every(isMaterialRequirement))
    ) {
      issues.push({
        kind: "invalid_required_material",
        ...(skillId === undefined ? {} : { skillId }),
        toolId,
      });
    }
    if (typeof tool.admit !== "function") {
      issues.push({
        kind: "invalid_admitter",
        ...(skillId === undefined ? {} : { skillId }),
        toolId,
      });
    }
    if (typeof tool.execute !== "function") {
      issues.push({
        kind: "invalid_execute",
        ...(skillId === undefined ? {} : { skillId }),
        toolId,
      });
    }
  });

  return issues;
};

export const registerSkill = (manifest: SkillManifest): RegisterSkillResult => {
  const issues = validateManifest(manifest);
  if (issues.length > 0) return { ok: false, issues };

  const tools: Record<string, Tool> = {};
  const toolIds: string[] = [];

  for (const tool of manifest.tools) {
    const toolId = tool.definition.function.name;
    toolIds.push(toolId);
    tools[toolId] = defineToolFromDefinition({
      definition: tool.definition,
      execute: tool.execute,
      authorityClass: tool.authorityClass,
      ...(tool.authorityId === undefined ? {} : { authorityId: tool.authorityId }),
      ...(tool.requiredMaterials === undefined
        ? {}
        : { requiredMaterials: tool.requiredMaterials }),
      originRef: manifest.originRef,
      admit: tool.admit,
    });
  }

  return {
    ok: true,
    registration: {
      skillId: manifest.skillId,
      version: manifest.version,
      toolIds,
      tools,
    },
  };
};

export const unregisterSkill = (
  registry: Readonly<Record<string, Tool>>,
  registration: Pick<RegisteredSkill, "skillId" | "toolIds">,
): UnregisterSkillResult => {
  const issues = registration.toolIds
    .filter((toolId) => registry[toolId] === undefined)
    .map(
      (toolId): SkillRegistryIssue => ({
        kind: "tool_not_registered",
        skillId: registration.skillId,
        toolId,
      }),
    );
  if (issues.length > 0) return { ok: false, issues };

  const next: Record<string, Tool> = { ...registry };
  for (const toolId of registration.toolIds) {
    delete next[toolId];
  }
  return { ok: true, tools: next };
};
