import type { BoundaryPackage } from "@agent-os/kernel/extensions";
import type { AuthorityRef, FactOwnerRef, ScopeRef } from "@agent-os/kernel/effect-claim";
import type { ToolError } from "@agent-os/kernel/errors";
import type { MaterialRef } from "@agent-os/kernel/material-ref";
import type { ResolvedMaterial } from "@agent-os/kernel/ref-resolver";
import type {
  ResolvedToolMaterials,
  ToolExecutionContext,
  ToolIntentEmitter,
  ToolProjectionRow,
  ToolProjectionWaiter,
} from "@agent-os/kernel/tools";
import { Option, type Effect } from "effect";
import { defineAgentSubmitBindings, type AgentSubmitBindings } from "./bindings";

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

export interface AgentCapabilityMaterial<Slot extends string = string, Value = ResolvedMaterial> {
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
  Record<string, AgentCapabilityMaterial<string, ResolvedMaterial>>
>;

export interface DefineAgentCapabilitySpec<
  Intents extends AgentCapabilityIntentMap = {},
  Projections extends AgentCapabilityProjectionMap = {},
  Materials extends AgentCapabilityMaterialMap = {},
> {
  readonly id: string;
  readonly boundaryPackage?: BoundaryPackage;
  readonly intents?: Intents;
  readonly projections?: Projections;
  readonly materials?: Materials;
}

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

export type AgentCapabilityMaterialValue<Material> =
  Material extends AgentCapabilityMaterial<string, infer Value> ? Value : never;

export type AgentCapabilityMaterialRefs<Definition> = {
  readonly [Key in keyof AgentCapabilityMaterialsOf<Definition>]: MaterialRef;
};

export type AgentCapabilityResolvedMaterials<Definition> = {
  readonly [Key in keyof AgentCapabilityMaterialsOf<Definition>]: AgentCapabilityMaterialValue<
    AgentCapabilityMaterialsOf<Definition>[Key]
  >;
};

export type BindAgentCapabilityOptions<Definition> =
  keyof AgentCapabilityMaterialsOf<Definition> extends never
    ? { readonly materials?: AgentCapabilityMaterialRefs<Definition> }
    : { readonly materials: AgentCapabilityMaterialRefs<Definition> };

export interface AgentCapabilityRuntimeContext<Definition> {
  readonly materials: ResolvedToolMaterials & AgentCapabilityResolvedMaterials<Definition>;
  readonly emitIntent: ToolIntentEmitter;
  readonly awaitProjection: ToolProjectionWaiter;
}

export interface AgentCapabilityProjectionAwaitOptions<State> {
  readonly maxAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly ready?: (row: ToolProjectionRow<State>) => boolean;
}

export type AgentCapabilityHandle<Definition> = {
  readonly id: Definition extends { readonly id: infer Id } ? Id : string;
  readonly intents: {
    readonly [Key in keyof AgentCapabilityIntentsOf<Definition>]: (
      payload: AgentCapabilityIntentPayload<AgentCapabilityIntentsOf<Definition>[Key]>,
    ) => ReturnType<ToolIntentEmitter>;
  };
  readonly projections: {
    readonly [Key in keyof AgentCapabilityProjectionsOf<Definition>]: {
      readonly await: (
        identity: AgentCapabilityProjectionIdentity<AgentCapabilityProjectionsOf<Definition>[Key]>,
        options?: AgentCapabilityProjectionAwaitOptions<
          AgentCapabilityProjectionState<AgentCapabilityProjectionsOf<Definition>[Key]>
        >,
      ) => Effect.Effect<
        ToolProjectionRow<
          AgentCapabilityProjectionState<AgentCapabilityProjectionsOf<Definition>[Key]>
        >,
        ToolError,
        never
      >;
    };
  };
  readonly materials: AgentCapabilityResolvedMaterials<Definition>;
};

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
  <Value = ResolvedMaterial>() =>
  <const Slot extends string>(slot: Slot): AgentCapabilityMaterial<Slot, Value> => ({
    slot,
  });

export const defineAgentCapability = <
  const Intents extends AgentCapabilityIntentMap = {},
  const Projections extends AgentCapabilityProjectionMap = {},
  const Materials extends AgentCapabilityMaterialMap = {},
>(
  spec: DefineAgentCapabilitySpec<Intents, Projections, Materials>,
): AgentCapabilityDefinition<Intents, Projections, Materials> => ({
  id: spec.id,
  ...(spec.boundaryPackage === undefined ? {} : { boundaryPackage: spec.boundaryPackage }),
  intents: (spec.intents ?? {}) as Intents,
  projections: (spec.projections ?? {}) as Projections,
  materials: (spec.materials ?? {}) as Materials,
});

const failAgentCapability = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const missingBoundaryPackage = (capabilityId: string, key: string): never =>
  failAgentCapability(`agent capability ${capabilityId} intent ${key} has no boundary package`);

const intentBoundaryPackage = (
  definition: AnyAgentCapabilityDefinition,
  key: string,
  intent: AgentCapabilityIntent,
): BoundaryPackage =>
  intent.boundaryPackage ??
  definition.boundaryPackage ??
  missingBoundaryPackage(definition.id, key);

const materialSlotEntries = <Definition>(
  definition: Definition,
): ReadonlyArray<readonly [keyof AgentCapabilityMaterialsOf<Definition>, string]> => {
  const materials =
    (definition as { readonly materials?: AgentCapabilityMaterialMap }).materials ?? {};
  return Object.entries(materials).map(([key, material]) => [
    key as keyof AgentCapabilityMaterialsOf<Definition>,
    material.slot,
  ]);
};

export const submitBindingsForAgentCapability = <Definition extends AnyAgentCapabilityDefinition>(
  definition: Definition,
  options: BindAgentCapabilityOptions<Definition>,
): AgentSubmitBindings => {
  const materialRefs: Record<string, MaterialRef> = {};
  for (const [key, slot] of materialSlotEntries(definition)) {
    const ref = options.materials?.[key];
    if (ref !== undefined) {
      materialRefs[slot] = ref;
    }
  }

  return defineAgentSubmitBindings({
    toolIntents: Object.entries(definition.intents).map(([key, intent]) => ({
      kind: intent.kind,
      boundaryPackage: intentBoundaryPackage(definition, key, intent),
    })),
    ...(Object.keys(materialRefs).length === 0 ? {} : { materials: materialRefs }),
  });
};

export const assertAgentCapabilityRuntimeContext = <
  Definition extends AnyAgentCapabilityDefinition,
>(
  definition: Definition,
  toolContext: ToolExecutionContext,
): AgentCapabilityRuntimeContext<Definition> => {
  if (toolContext.emitIntent === undefined) {
    return failAgentCapability(`agent capability ${definition.id} requires emitIntent`);
  }
  if (toolContext.awaitProjection === undefined) {
    return failAgentCapability(`agent capability ${definition.id} requires awaitProjection`);
  }
  for (const [, slot] of materialSlotEntries(definition)) {
    if (!(slot in toolContext.materials)) {
      return failAgentCapability(
        `agent capability ${definition.id} requires material slot ${slot}`,
      );
    }
  }
  return toolContext as AgentCapabilityRuntimeContext<Definition>;
};

export const createAgentCapabilityHandle = <Definition extends AnyAgentCapabilityDefinition>(
  definition: Definition,
  capabilityContext: AgentCapabilityRuntimeContext<Definition>,
): AgentCapabilityHandle<Definition> => {
  const intents: Record<string, unknown> = {};
  for (const [key, intent] of Object.entries(definition.intents)) {
    intents[key] = (payload: unknown) => capabilityContext.emitIntent(intent.kind, payload);
  }

  const projections: Record<string, unknown> = {};
  for (const [key, projection] of Object.entries(definition.projections)) {
    projections[key] = {
      await: (identity: unknown, options: AgentCapabilityProjectionAwaitOptions<unknown> = {}) =>
        capabilityContext.awaitProjection({
          kind: projection.kind,
          ...(projection.scopeRef === undefined ? {} : { scopeRef: projection.scopeRef }),
          ...(projection.effectAuthorityRef === undefined
            ? {}
            : { effectAuthorityRef: projection.effectAuthorityRef }),
          ...(projection.factOwnerRef === undefined
            ? {}
            : { factOwnerRef: projection.factOwnerRef }),
          identity,
          ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
          ...(options.pollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: options.pollIntervalMs }),
          ...(options.ready === undefined ? {} : { ready: options.ready }),
        }),
    };
  }

  const materials: Record<string, ResolvedMaterial> = {};
  for (const [key, slot] of materialSlotEntries(definition)) {
    materials[String(key)] = capabilityContext.materials[slot];
  }

  return {
    id: definition.id as AgentCapabilityHandle<Definition>["id"],
    intents: intents as AgentCapabilityHandle<Definition>["intents"],
    projections: projections as AgentCapabilityHandle<Definition>["projections"],
    materials: materials as AgentCapabilityHandle<Definition>["materials"],
  };
};
