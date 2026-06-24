import type { BoundaryPackage } from "@agent-os/core/extensions";
import type { AuthorityRef, FactOwnerRef, ScopeRef } from "@agent-os/core/effect-claim";

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
