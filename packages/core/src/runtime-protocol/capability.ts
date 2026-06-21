import type { BoundaryPackage } from "@agent-os/core/extensions";
import type { AuthorityRef, FactOwnerRef, ScopeRef } from "@agent-os/core/effect-claim";
import type { MaterialRef } from "@agent-os/core/material-ref";
import { Option } from "effect";
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

export type AgentCapabilityMaterialRefs<Definition> = {
  readonly [Key in keyof AgentCapabilityMaterialsOf<Definition>]: MaterialRef;
};

export type BindAgentCapabilityOptions<Definition> =
  keyof AgentCapabilityMaterialsOf<Definition> extends never
    ? { readonly materials?: AgentCapabilityMaterialRefs<Definition> }
    : { readonly materials: AgentCapabilityMaterialRefs<Definition> };

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
