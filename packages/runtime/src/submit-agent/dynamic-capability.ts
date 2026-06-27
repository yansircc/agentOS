import type {
  DynamicCapabilityPhasePolicyDeniedDiagnostic,
  DynamicCapabilityProjection,
  SubmitInstructionFragment,
} from "@agent-os/core/runtime-protocol";
import { DYNAMIC_CAPABILITY_PHASE_POLICY_DENIED_REASON } from "@agent-os/core/runtime-protocol";
import type { Tool } from "@agent-os/core/tools";

export const DYNAMIC_TOOL_VISIBILITY_DENIED_REASON = "tool_visibility_denied";

const visibleIds = (
  entries: ReadonlyArray<{ readonly id: string; readonly visible: boolean }>,
): ReadonlySet<string> =>
  new Set(entries.filter((entry) => entry.visible).map((entry) => entry.id));

export const visibleToolIdsForDynamicCapabilityProjection = (
  projection: DynamicCapabilityProjection | undefined,
  tools: Readonly<Record<string, Tool>>,
): ReadonlySet<string> =>
  projection === undefined ? new Set(Object.keys(tools)) : visibleIds(projection.tools);

export const toolsForDynamicCapabilityProjection = (
  tools: Readonly<Record<string, Tool>>,
  projection: DynamicCapabilityProjection | undefined,
): Record<string, Tool> => {
  const visible = visibleToolIdsForDynamicCapabilityProjection(projection, tools);
  return Object.fromEntries(
    Object.entries(tools).filter(([toolName]) => visible.has(toolName)),
  ) as Record<string, Tool>;
};

export const dynamicCapabilityToolVisibilityDenied = (
  toolName: string,
  tools: Readonly<Record<string, Tool>>,
  projection: DynamicCapabilityProjection | undefined,
): boolean =>
  projection !== undefined &&
  Object.prototype.hasOwnProperty.call(tools, toolName) &&
  !visibleToolIdsForDynamicCapabilityProjection(projection, tools).has(toolName);

export const dynamicCapabilityPhasePolicyDeniedDiagnostic = (
  toolName: string,
  projection: DynamicCapabilityProjection | undefined,
): DynamicCapabilityPhasePolicyDeniedDiagnostic | undefined =>
  projection?.tools
    .find((entry) => entry.id === toolName)
    ?.diagnostics?.find(
      (diagnostic): diagnostic is DynamicCapabilityPhasePolicyDeniedDiagnostic =>
        diagnostic.reason === DYNAMIC_CAPABILITY_PHASE_POLICY_DENIED_REASON,
    );

export const visibleSkillIdsForDynamicCapabilityProjection = (
  projection: DynamicCapabilityProjection | undefined,
  skillIds: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (projection === undefined) {
    return [...skillIds].sort((left, right) => left.localeCompare(right));
  }
  const visible = visibleIds(projection.skills);
  return [...skillIds]
    .filter((skillId) => visible.has(skillId))
    .sort((left, right) => left.localeCompare(right));
};

export const instructionFragmentsForDynamicCapabilityProjection = (
  fragments: ReadonlyArray<SubmitInstructionFragment> | undefined,
  projection: DynamicCapabilityProjection | undefined,
): ReadonlyArray<SubmitInstructionFragment> => {
  const sorted = [...(fragments ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  if (projection === undefined) return sorted;
  const visible = new Map(
    projection.instructions
      .filter((entry) => entry.visible)
      .map((entry) => [entry.id, entry.digest] as const),
  );
  return sorted.filter((fragment) => visible.get(fragment.id) === fragment.digest);
};

export const systemWithDynamicInstructionFragments = (
  system: string | undefined,
  fragments: ReadonlyArray<SubmitInstructionFragment>,
): string | undefined => {
  if (fragments.length === 0) return system;
  const fragmentText = fragments.map((fragment) => fragment.text).join("\n\n");
  return system === undefined ? fragmentText : `${system}\n\n${fragmentText}`;
};
