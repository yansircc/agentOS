import type { BoundaryPackage } from "@agent-os/core/extensions";
import type { AuthorityRef, FactOwnerRef, ScopeRef } from "@agent-os/core/effect-claim";
import type { MaterialRef } from "@agent-os/core/material-ref";

export interface AgentCapabilityIntent<Kind extends string = string, Payload = unknown> {
  readonly kind: Kind;
  readonly boundaryPackage?: BoundaryPackage;
  readonly _payload?: Payload;
}

export interface AgentCapabilityProjection<
  Kind extends string = string,
  Identity = unknown,
  State = unknown,
> {
  readonly kind: Kind;
  readonly scopeRef?: ScopeRef;
  readonly effectAuthorityRef?: AuthorityRef;
  readonly factOwnerRef?: FactOwnerRef;
  readonly _identity?: Identity;
  readonly _state?: State;
}

export interface AgentCapabilityMaterial<Slot extends string = string, Value = unknown> {
  readonly slot: Slot;
  readonly _value?: Value;
}

export type AgentCapabilityIntentMap = Readonly<
  Record<string, AgentCapabilityIntent<string, unknown>>
>;
export type AgentCapabilityProjectionMap = Readonly<
  Record<string, AgentCapabilityProjection<string, unknown, unknown>>
>;
export type AgentCapabilityMaterialMap = Readonly<
  Record<string, AgentCapabilityMaterial<string, unknown>>
>;

export interface AgentCapabilityDefinition<
  Intents extends AgentCapabilityIntentMap = {},
  Projections extends AgentCapabilityProjectionMap = {},
  Materials extends AgentCapabilityMaterialMap = {},
> {
  readonly id: string;
  readonly boundaryPackage?: BoundaryPackage;
  readonly intents: Intents;
  readonly projections: Projections;
  readonly materials: Materials;
}

export type AnyAgentCapabilityDefinition = AgentCapabilityDefinition<
  AgentCapabilityIntentMap,
  AgentCapabilityProjectionMap,
  AgentCapabilityMaterialMap
>;

export type AgentCapabilityIntentsOf<Definition> =
  Definition extends AgentCapabilityDefinition<
    infer Intents,
    AgentCapabilityProjectionMap,
    AgentCapabilityMaterialMap
  >
    ? Intents
    : {};

export type AgentCapabilityProjectionsOf<Definition> =
  Definition extends AgentCapabilityDefinition<
    AgentCapabilityIntentMap,
    infer Projections,
    AgentCapabilityMaterialMap
  >
    ? Projections
    : {};

export type AgentCapabilityMaterialsOf<Definition> =
  Definition extends AgentCapabilityDefinition<
    AgentCapabilityIntentMap,
    AgentCapabilityProjectionMap,
    infer Materials
  >
    ? Materials
    : {};

export type AgentCapabilityIntentPayload<Intent> =
  Intent extends AgentCapabilityIntent<string, infer Payload> ? Payload : never;

export type AgentCapabilityProjectionIdentity<Projection> =
  Projection extends AgentCapabilityProjection<string, infer Identity, unknown> ? Identity : never;

export type AgentCapabilityProjectionState<Projection> =
  Projection extends AgentCapabilityProjection<string, unknown, infer State> ? State : never;

export const capabilityIntent =
  <Payload = unknown>() =>
  <const Kind extends string>(
    kind: Kind,
    options: { readonly boundaryPackage?: BoundaryPackage } = {},
  ): AgentCapabilityIntent<Kind, Payload> => ({
    kind,
    ...options,
  });

export const capabilityProjection =
  <Identity = unknown, State = unknown>() =>
  <const Kind extends string>(
    kind: Kind,
    options: {
      readonly scopeRef?: ScopeRef;
      readonly effectAuthorityRef?: AuthorityRef;
      readonly factOwnerRef?: FactOwnerRef;
    } = {},
  ): AgentCapabilityProjection<Kind, Identity, State> => ({
    kind,
    ...options,
  });

export const capabilityMaterial =
  <Value = unknown>() =>
  <const Slot extends string>(slot: Slot): AgentCapabilityMaterial<Slot, Value> => ({
    slot,
  });

export const DYNAMIC_CAPABILITY_EVENT = {
  SESSION_STARTED: "session.started",
  TURN_STARTED: "turn.started",
  STEP_STARTED: "step.started",
} as const;

export type DynamicCapabilityEventName =
  (typeof DYNAMIC_CAPABILITY_EVENT)[keyof typeof DYNAMIC_CAPABILITY_EVENT];

export const DYNAMIC_CAPABILITY_SLOT = {
  TOOLS: "tools",
  SKILLS: "skills",
  INSTRUCTIONS: "instructions",
} as const;

export type DynamicCapabilitySlot =
  (typeof DYNAMIC_CAPABILITY_SLOT)[keyof typeof DYNAMIC_CAPABILITY_SLOT];

export const DYNAMIC_CAPABILITY_PROJECTION_VERSION = "dynamic-capability-projection-v1";

export type DynamicCapabilityProjectionVersion = typeof DYNAMIC_CAPABILITY_PROJECTION_VERSION;

export const DYNAMIC_CAPABILITY_RESOLVER_STATUS = {
  APPLIED: "applied",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
} as const;

export type DynamicCapabilityResolverStatus =
  (typeof DYNAMIC_CAPABILITY_RESOLVER_STATUS)[keyof typeof DYNAMIC_CAPABILITY_RESOLVER_STATUS];

export const DYNAMIC_CAPABILITY_FAILURE_REASON = {
  RESOLVER_THROW: "resolver_throw",
  RESOLVER_TIMEOUT: "resolver_timeout",
  INVALID_OUTPUT: "invalid_output",
  UNKNOWN_TARGET: "unknown_target",
} as const;

export type DynamicCapabilityFailureReason =
  (typeof DYNAMIC_CAPABILITY_FAILURE_REASON)[keyof typeof DYNAMIC_CAPABILITY_FAILURE_REASON];

export const DYNAMIC_CAPABILITY_VISIBILITY = {
  BASELINE: "baseline",
  ALLOWED: "allowed",
  DENIED: "denied",
} as const;

export type DynamicCapabilityVisibilityDecision =
  (typeof DYNAMIC_CAPABILITY_VISIBILITY)[keyof typeof DYNAMIC_CAPABILITY_VISIBILITY];

export interface DynamicCapabilityEventRef {
  readonly name: DynamicCapabilityEventName;
  readonly sourceEventId?: number;
  readonly sessionRef?: string;
  readonly turnRef?: string;
  readonly stepRef?: string;
}

export interface DynamicCapabilityCompiledToolArtifact {
  readonly id: string;
  readonly bindingRef?: string;
}

export interface DynamicCapabilityCompiledSkillArtifact {
  readonly id: string;
  readonly digest: string;
}

export interface DynamicCapabilityCompiledInstructionArtifact {
  readonly id: string;
  readonly digest: string;
}

export interface DynamicCapabilityCompiledCatalog {
  readonly tools: ReadonlyArray<DynamicCapabilityCompiledToolArtifact>;
  readonly skills: ReadonlyArray<DynamicCapabilityCompiledSkillArtifact>;
  readonly instructions: ReadonlyArray<DynamicCapabilityCompiledInstructionArtifact>;
}

export interface DynamicCapabilityContext {
  readonly event: DynamicCapabilityEventRef;
  readonly catalog: DynamicCapabilityCompiledCatalog;
  readonly auth: Readonly<Record<string, unknown>>;
  readonly projections: Readonly<Record<string, unknown>>;
  readonly materials: Readonly<Record<string, MaterialRef>>;
}

export interface DynamicCapabilitySlotSelection {
  readonly allow?: ReadonlyArray<string>;
  readonly deny?: ReadonlyArray<string>;
}

export interface DynamicCapabilityResolverResult {
  readonly tools?: DynamicCapabilitySlotSelection;
  readonly skills?: DynamicCapabilitySlotSelection;
  readonly instructions?: DynamicCapabilitySlotSelection;
}

export interface DynamicCapabilityResolverResultIssue {
  readonly path: string;
  readonly reason:
    | "object_required"
    | "unknown_field"
    | "slot_object_required"
    | "array_required"
    | "target_id_string_required";
}

export type DynamicCapabilityResolverResultParseResult =
  | { readonly ok: true; readonly value: DynamicCapabilityResolverResult }
  | { readonly ok: false; readonly issues: ReadonlyArray<DynamicCapabilityResolverResultIssue> };

export interface DynamicCapabilityResolverProvenance {
  readonly resolverId: string;
  readonly slot: DynamicCapabilitySlot;
  readonly eventName: DynamicCapabilityEventName;
  readonly status: DynamicCapabilityResolverStatus;
  readonly reason?: DynamicCapabilityFailureReason;
}

export interface DynamicCapabilityResolverMergeInput {
  readonly provenance: DynamicCapabilityResolverProvenance;
  readonly result: DynamicCapabilityResolverResult;
}

export interface DynamicCapabilityProjectionEntry {
  readonly id: string;
  readonly visible: boolean;
  readonly decision: DynamicCapabilityVisibilityDecision;
  readonly provenance: ReadonlyArray<DynamicCapabilityResolverProvenance>;
}

export interface DynamicCapabilityInstructionProjectionEntry extends DynamicCapabilityProjectionEntry {
  readonly digest: string;
}

export interface DynamicCapabilityProjection {
  readonly version: DynamicCapabilityProjectionVersion;
  readonly event: DynamicCapabilityEventRef;
  readonly tools: ReadonlyArray<DynamicCapabilityProjectionEntry>;
  readonly skills: ReadonlyArray<DynamicCapabilityProjectionEntry>;
  readonly instructions: ReadonlyArray<DynamicCapabilityInstructionProjectionEntry>;
  readonly provenance: ReadonlyArray<DynamicCapabilityResolverProvenance>;
}

export type DynamicCapabilityMergeIssue =
  | {
      readonly kind: "cross_slot_output";
      readonly resolverId: string;
      readonly resolverSlot: DynamicCapabilitySlot;
      readonly outputSlot: DynamicCapabilitySlot;
    }
  | {
      readonly kind: "event_slot_forbidden";
      readonly resolverId: string;
      readonly eventName: DynamicCapabilityEventName;
      readonly slot: DynamicCapabilitySlot;
    }
  | {
      readonly kind: "unknown_target";
      readonly resolverId: string;
      readonly slot: DynamicCapabilitySlot;
      readonly targetId: string;
    };

export type DynamicCapabilityProjectionMergeResult =
  | { readonly ok: true; readonly value: DynamicCapabilityProjection }
  | { readonly ok: false; readonly issues: ReadonlyArray<DynamicCapabilityMergeIssue> };

const dynamicCapabilitySlots: ReadonlyArray<DynamicCapabilitySlot> = [
  DYNAMIC_CAPABILITY_SLOT.TOOLS,
  DYNAMIC_CAPABILITY_SLOT.SKILLS,
  DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS,
];

const dynamicCapabilityResultFields = new Set<string>(dynamicCapabilitySlots);
const dynamicCapabilitySlotSelectionFields = new Set(["allow", "deny"]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseDynamicCapabilityTargetIds = (
  path: string,
  value: unknown,
  issues: DynamicCapabilityResolverResultIssue[],
): ReadonlyArray<string> | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ path, reason: "array_required" });
    return undefined;
  }
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.length === 0) {
      issues.push({ path: `${path}/${index}`, reason: "target_id_string_required" });
      continue;
    }
    out.push(item);
  }
  return out;
};

const parseDynamicCapabilitySlotSelection = (
  path: string,
  value: unknown,
  issues: DynamicCapabilityResolverResultIssue[],
): DynamicCapabilitySlotSelection | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, reason: "slot_object_required" });
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!dynamicCapabilitySlotSelectionFields.has(field)) {
      issues.push({ path: `${path}/${field}`, reason: "unknown_field" });
    }
  }
  const allow = parseDynamicCapabilityTargetIds(`${path}/allow`, value.allow, issues);
  const deny = parseDynamicCapabilityTargetIds(`${path}/deny`, value.deny, issues);
  return {
    ...(allow === undefined ? {} : { allow }),
    ...(deny === undefined ? {} : { deny }),
  };
};

export const parseDynamicCapabilityResolverResult = (
  value: unknown,
): DynamicCapabilityResolverResultParseResult => {
  const issues: DynamicCapabilityResolverResultIssue[] = [];
  if (!isRecord(value)) return { ok: false, issues: [{ path: "/", reason: "object_required" }] };
  for (const field of Object.keys(value)) {
    if (!dynamicCapabilityResultFields.has(field)) {
      issues.push({ path: `/${field}`, reason: "unknown_field" });
    }
  }
  const result: DynamicCapabilityResolverResult = {};
  for (const slot of dynamicCapabilitySlots) {
    if (!Object.prototype.hasOwnProperty.call(value, slot)) continue;
    const parsed = parseDynamicCapabilitySlotSelection(`/${slot}`, value[slot], issues);
    if (parsed !== undefined) {
      (result as Record<DynamicCapabilitySlot, DynamicCapabilitySlotSelection>)[slot] = parsed;
    }
  }
  return issues.length === 0 ? { ok: true, value: result } : { ok: false, issues };
};

export const dynamicCapabilitySlotsForEvent = (
  eventName: DynamicCapabilityEventName,
): ReadonlyArray<DynamicCapabilitySlot> =>
  eventName === DYNAMIC_CAPABILITY_EVENT.STEP_STARTED
    ? [DYNAMIC_CAPABILITY_SLOT.TOOLS]
    : dynamicCapabilitySlots;

const uniqueSorted = (values: Iterable<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const catalogIds = (
  catalog: DynamicCapabilityCompiledCatalog,
  slot: DynamicCapabilitySlot,
): ReadonlyArray<string> => {
  switch (slot) {
    case DYNAMIC_CAPABILITY_SLOT.TOOLS:
      return catalog.tools.map((tool) => tool.id);
    case DYNAMIC_CAPABILITY_SLOT.SKILLS:
      return catalog.skills.map((skill) => skill.id);
    case DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS:
      return catalog.instructions.map((instruction) => instruction.id);
  }
};

const selectionForSlot = (
  result: DynamicCapabilityResolverResult,
  slot: DynamicCapabilitySlot,
): DynamicCapabilitySlotSelection | undefined => {
  switch (slot) {
    case DYNAMIC_CAPABILITY_SLOT.TOOLS:
      return result.tools;
    case DYNAMIC_CAPABILITY_SLOT.SKILLS:
      return result.skills;
    case DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS:
      return result.instructions;
  }
};

const instructionDigestById = (
  catalog: DynamicCapabilityCompiledCatalog,
): ReadonlyMap<string, string> =>
  new Map(catalog.instructions.map((instruction) => [instruction.id, instruction.digest]));

const mergeProjectionEntries = (
  ids: ReadonlyArray<string>,
  slot: DynamicCapabilitySlot,
  inputs: ReadonlyArray<DynamicCapabilityResolverMergeInput>,
): ReadonlyArray<DynamicCapabilityProjectionEntry> => {
  const provenanceById = new Map<string, DynamicCapabilityResolverProvenance[]>();
  const allowed = new Set<string>();
  const denied = new Set<string>();
  for (const input of inputs) {
    const selection = selectionForSlot(input.result, slot);
    for (const id of selection?.allow ?? []) {
      allowed.add(id);
      provenanceById.set(id, [...(provenanceById.get(id) ?? []), input.provenance]);
    }
    for (const id of selection?.deny ?? []) {
      denied.add(id);
      provenanceById.set(id, [...(provenanceById.get(id) ?? []), input.provenance]);
    }
  }
  return uniqueSorted(ids).map((id) => {
    const decision = denied.has(id)
      ? DYNAMIC_CAPABILITY_VISIBILITY.DENIED
      : allowed.has(id)
        ? DYNAMIC_CAPABILITY_VISIBILITY.ALLOWED
        : DYNAMIC_CAPABILITY_VISIBILITY.BASELINE;
    return {
      id,
      visible: decision !== DYNAMIC_CAPABILITY_VISIBILITY.DENIED,
      decision,
      provenance: provenanceById.get(id) ?? [],
    };
  });
};

const unknownDynamicCapabilityTargets = (
  eventName: DynamicCapabilityEventName,
  catalog: DynamicCapabilityCompiledCatalog,
  inputs: ReadonlyArray<DynamicCapabilityResolverMergeInput>,
): ReadonlyArray<DynamicCapabilityMergeIssue> => {
  const issues: DynamicCapabilityMergeIssue[] = [];
  const allowedSlots = new Set(dynamicCapabilitySlotsForEvent(eventName));
  for (const input of inputs) {
    for (const slot of dynamicCapabilitySlots) {
      const selection = selectionForSlot(input.result, slot);
      if (selection === undefined) continue;
      if (slot !== input.provenance.slot) {
        issues.push({
          kind: "cross_slot_output",
          resolverId: input.provenance.resolverId,
          resolverSlot: input.provenance.slot,
          outputSlot: slot,
        });
      }
      if (!allowedSlots.has(slot)) {
        issues.push({
          kind: "event_slot_forbidden",
          resolverId: input.provenance.resolverId,
          eventName,
          slot,
        });
      }
      const known = new Set(catalogIds(catalog, slot));
      for (const targetId of [...(selection?.allow ?? []), ...(selection?.deny ?? [])]) {
        if (known.has(targetId)) continue;
        issues.push({
          kind: "unknown_target",
          resolverId: input.provenance.resolverId,
          slot,
          targetId,
        });
      }
    }
  }
  return issues;
};

export const mergeDynamicCapabilityProjection = (input: {
  readonly event: DynamicCapabilityEventRef;
  readonly catalog: DynamicCapabilityCompiledCatalog;
  readonly results: ReadonlyArray<DynamicCapabilityResolverMergeInput>;
}): DynamicCapabilityProjectionMergeResult => {
  const issues = unknownDynamicCapabilityTargets(input.event.name, input.catalog, input.results);
  if (issues.length > 0) return { ok: false, issues };
  const instructions = instructionDigestById(input.catalog);
  const instructionEntries = mergeProjectionEntries(
    catalogIds(input.catalog, DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS),
    DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS,
    input.results,
  ).map(
    (entry): DynamicCapabilityInstructionProjectionEntry => ({
      ...entry,
      digest: instructions.get(entry.id) ?? "",
    }),
  );
  return {
    ok: true,
    value: {
      version: DYNAMIC_CAPABILITY_PROJECTION_VERSION,
      event: input.event,
      tools: mergeProjectionEntries(
        catalogIds(input.catalog, DYNAMIC_CAPABILITY_SLOT.TOOLS),
        DYNAMIC_CAPABILITY_SLOT.TOOLS,
        input.results,
      ),
      skills: mergeProjectionEntries(
        catalogIds(input.catalog, DYNAMIC_CAPABILITY_SLOT.SKILLS),
        DYNAMIC_CAPABILITY_SLOT.SKILLS,
        input.results,
      ),
      instructions: instructionEntries,
      provenance: [...input.results]
        .map((result) => result.provenance)
        .sort(
          (left, right) =>
            left.slot.localeCompare(right.slot) || left.resolverId.localeCompare(right.resolverId),
        ),
    },
  };
};
