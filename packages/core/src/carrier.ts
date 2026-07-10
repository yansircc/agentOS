import { Option } from "effect";
import { defineAgentSchema, type AgentSchemaDecoder } from "./agent-schema";
import {
  compileBoundaryContract,
  type BoundaryContract,
  type BoundaryEventContract,
  type BoundaryModule,
  type BoundaryProjectionContract,
  validateBoundaryContract,
} from "./boundary-contract";
import {
  validateEffectClaim,
  type IndeterminateClaim,
  type IndeterminateRef,
  type PreClaim,
  type AnchorRef,
  type LivedClaim,
  type RejectedClaim,
  type RejectionRef,
} from "./effect-claim";
import { validateAgainstSchema, type JsonSchemaObject } from "./json-schema-dialect";
import type { EffectAuthorityContract, MaterialRequirement } from "./material-ref";
import type { Recordable } from "./value-brands";
import {
  defineSettlementContract,
  settleIndeterminate,
  settleLived,
  settleRejected,
  validateIndeterminateClaim,
  validateTerminalClaim,
  type SettlementContract,
} from "./settlement-contract";

type ClaimSlot =
  | { readonly kind: "none" }
  | { readonly kind: "pre"; readonly key: string }
  | {
      readonly kind: "lived";
      readonly key: string;
      readonly anchorKinds: ReadonlyArray<AnchorRef["anchorKind"]>;
    }
  | {
      readonly kind: "rejected";
      readonly key: string;
      readonly rejectionKinds: ReadonlyArray<RejectionRef["rejectionKind"]>;
    }
  | {
      readonly kind: "indeterminate";
      readonly key: string;
      readonly indeterminateKinds: ReadonlyArray<IndeterminateRef["indeterminateKind"]>;
    };

export type CarrierEventPayload<
  S extends AgentSchemaDecoder<unknown>,
  Slot extends ClaimSlot,
> = S["Type"] &
  (Slot extends { readonly kind: "pre"; readonly key: infer Key extends string }
    ? { readonly [K in Key]: PreClaim }
    : Slot extends { readonly kind: "lived"; readonly key: infer Key extends string }
      ? { readonly [K in Key]: LivedClaim }
      : Slot extends { readonly kind: "rejected"; readonly key: infer Key extends string }
        ? { readonly [K in Key]: RejectedClaim }
        : Slot extends { readonly kind: "indeterminate"; readonly key: infer Key extends string }
          ? { readonly [K in Key]: IndeterminateClaim }
          : {});

export interface CarrierEvent<
  Kind extends string,
  S extends AgentSchemaDecoder<unknown>,
  Slot extends ClaimSlot,
> {
  readonly kind: Kind;
  readonly payload: S;
  readonly claim: Slot;
}

export type CarrierEventPayloads<
  Prefix extends string,
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> = {
  readonly [Name in keyof Events &
    string as `${Prefix}${Events[Name]["kind"]}`]: CarrierEventPayload<
    Events[Name]["payload"],
    Events[Name]["claim"]
  >;
};

export type CarrierKindView<
  Prefix extends string,
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> = {
  readonly [Name in keyof Events & string as Uppercase<Name>]: `${Prefix}${Events[Name]["kind"]}`;
};

export type CarrierHandlers<
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> = {
  readonly [Name in keyof Events & string]?: (input: {
    readonly data: CarrierEventPayload<Events[Name]["payload"], Events[Name]["claim"]>;
    readonly event: unknown;
    readonly agent: unknown;
    readonly env: unknown;
  }) => void | Promise<void>;
};

type LivedEventNames<
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> = {
  readonly [Name in keyof Events & string]: Events[Name]["claim"] extends { readonly kind: "lived" }
    ? Name
    : never;
}[keyof Events & string];

type RejectedEventNames<
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> = {
  readonly [Name in keyof Events & string]: Events[Name]["claim"] extends {
    readonly kind: "rejected";
  }
    ? Name
    : never;
}[keyof Events & string];

type IndeterminateEventNames<
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> = {
  readonly [Name in keyof Events & string]: Events[Name]["claim"] extends {
    readonly kind: "indeterminate";
  }
    ? Name
    : never;
}[keyof Events & string];

export type CarrierSettleSpec = {
  readonly anchorId: string;
  readonly anchorKind?: AnchorRef["anchorKind"];
  readonly carrierRef?: string;
};

export type CarrierRejectSpec = {
  readonly rejectionId: string;
  readonly rejectionKind?: RejectionRef["rejectionKind"];
  readonly reason?: string;
};

export type CarrierIndeterminateSpec = {
  readonly indeterminateId: string;
  readonly indeterminateKind?: IndeterminateRef["indeterminateKind"];
  readonly reason?: string;
  readonly carrierRef?: string;
};

export type CarrierSettleMap<
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> = {
  readonly [Name in LivedEventNames<Events>]: (
    claim: PreClaim,
    spec: CarrierSettleSpec,
  ) => LivedClaim & Recordable<LivedClaim>;
};

export type CarrierRejectMap<
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> = {
  readonly [Name in RejectedEventNames<Events>]: (
    claim: PreClaim,
    spec: CarrierRejectSpec,
  ) => RejectedClaim & Recordable<RejectedClaim>;
};

export type CarrierIndeterminateMap<
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> = {
  readonly [Name in IndeterminateEventNames<Events>]: (
    claim: PreClaim,
    spec: CarrierIndeterminateSpec,
  ) => IndeterminateClaim & Recordable<IndeterminateClaim>;
};

export interface Carrier<
  Prefix extends string,
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> {
  readonly ownerId: string;
  readonly sourcePackageName: string;
  readonly prefix: Prefix;
  readonly kind: CarrierKindView<Prefix, Events>;
  readonly events: CarrierEventPayloads<Prefix, Events>;
  readonly boundaryContract: BoundaryContract<keyof CarrierEventPayloads<Prefix, Events> & string>;
  readonly settlementContract: SettlementContract;
  readonly boundaryModule: (version: string) => BoundaryModule;
  readonly settle: CarrierSettleMap<Events>;
  readonly reject: CarrierRejectMap<Events>;
  readonly indeterminate: CarrierIndeterminateMap<Events>;
  readonly decode: (
    event: keyof CarrierEventPayloads<Prefix, Events> & string,
    payload: unknown,
  ) => CarrierEventPayloads<Prefix, Events>[keyof CarrierEventPayloads<Prefix, Events> & string];
  readonly handlers: (
    handlers: CarrierHandlers<Events>,
  ) => Readonly<
    Record<
      string,
      (input: {
        readonly data: unknown;
        readonly event: unknown;
        readonly agent: unknown;
        readonly env: unknown;
      }) => void | Promise<void>
    >
  >;
}

export interface DefineCarrierSpec<
  Prefix extends string,
  Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
> {
  readonly ownerId: string;
  readonly sourcePackageName: string;
  readonly prefix: Prefix;
  readonly roles: BoundaryContract["roles"];
  readonly events: Events;
  readonly effectAuthorityContracts?: ReadonlyArray<EffectAuthorityContract>;
  readonly materialRequirements?: ReadonlyArray<MaterialRequirement>;
}

const failCarrier = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

export const none = (): { readonly kind: "none" } => ({ kind: "none" });

export const pre = <const Key extends string>(spec: {
  readonly key: Key;
}): { readonly kind: "pre"; readonly key: Key } => ({
  kind: "pre",
  key: spec.key,
});

export const lived = <
  const Key extends string,
  const Kinds extends ReadonlyArray<AnchorRef["anchorKind"]>,
>(spec: {
  readonly key: Key;
  readonly anchorKinds: Kinds;
}): { readonly kind: "lived"; readonly key: Key; readonly anchorKinds: Kinds } => ({
  kind: "lived",
  key: spec.key,
  anchorKinds: spec.anchorKinds,
});

export const rejected = <
  const Key extends string,
  const Kinds extends ReadonlyArray<RejectionRef["rejectionKind"]>,
>(spec: {
  readonly key: Key;
  readonly rejectionKinds: Kinds;
}): { readonly kind: "rejected"; readonly key: Key; readonly rejectionKinds: Kinds } => ({
  kind: "rejected",
  key: spec.key,
  rejectionKinds: spec.rejectionKinds,
});

export const indeterminate = <
  const Key extends string,
  const Kinds extends ReadonlyArray<IndeterminateRef["indeterminateKind"]>,
>(spec: {
  readonly key: Key;
  readonly indeterminateKinds: Kinds;
}): {
  readonly kind: "indeterminate";
  readonly key: Key;
  readonly indeterminateKinds: Kinds;
} => ({
  kind: "indeterminate",
  key: spec.key,
  indeterminateKinds: spec.indeterminateKinds,
});

export const event = <
  const Kind extends string,
  S extends AgentSchemaDecoder<unknown>,
  const Slot extends ClaimSlot,
>(spec: {
  readonly kind: Kind;
  readonly payload: S;
  readonly claim: Slot;
}): CarrierEvent<Kind, S, Slot> => spec;

const schemaWithoutClaimCollision = (
  schema: JsonSchemaObject,
  claim: ClaimSlot,
  eventName: string,
): JsonSchemaObject => {
  if (claim.kind !== "none" && claim.key in schema.properties) {
    return failCarrier(
      `carrier event ${eventName} payload schema declares claim slot ${claim.key}`,
    );
  }
  return schema;
};

const boundaryClaimFor = (slot: ClaimSlot): BoundaryEventContract["claim"] => {
  switch (slot.kind) {
    case "none":
      return undefined;
    case "pre":
      return { key: slot.key, phase: "pre" };
    case "lived":
      return { key: slot.key, phase: "lived", anchorKinds: slot.anchorKinds };
    case "rejected":
      return { key: slot.key, phase: "rejected", rejectionKinds: slot.rejectionKinds };
    case "indeterminate":
      return {
        key: slot.key,
        phase: "indeterminate",
        indeterminateKinds: slot.indeterminateKinds,
      };
  }
};

const claimMatchesSlotVocabulary = (
  slot: ClaimSlot,
  claim: LivedClaim | RejectedClaim | IndeterminateClaim,
): boolean => {
  if (slot.kind === "lived" && claim.phase === "lived") {
    return slot.anchorKinds.includes(claim.anchorRef.anchorKind);
  }
  if (slot.kind === "rejected" && claim.phase === "rejected") {
    return slot.rejectionKinds.includes(claim.rejectionRef.rejectionKind);
  }
  if (slot.kind === "indeterminate" && claim.phase === "indeterminate") {
    return slot.indeterminateKinds.includes(claim.indeterminateRef.indeterminateKind);
  }
  return true;
};

const decodePayload = (
  schema: JsonSchemaObject,
  claim: ClaimSlot,
  settlementContract: SettlementContract,
  payload: unknown,
  eventKind: string,
): unknown => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return failCarrier(`carrier event ${eventKind} payload must be object`);
  }
  const record = payload as Readonly<Record<string, unknown>>;
  const payloadForSchema =
    claim.kind === "none" || !(claim.key in record)
      ? record
      : Object.fromEntries(Object.entries(record).filter(([key]) => key !== claim.key));
  const violations = validateAgainstSchema(payloadForSchema, schema);
  if (violations.length > 0) {
    return failCarrier(
      `carrier event ${eventKind} payload violates schema: ${violations.join(",")}`,
    );
  }
  if (claim.kind === "none") {
    return payload;
  }
  const claimValue = record[claim.key];
  if (claimValue === undefined) {
    return failCarrier(`carrier event ${eventKind} payload missing claim slot ${claim.key}`);
  }
  const claimValidation =
    claim.kind === "pre"
      ? validateEffectClaim(claimValue)
      : claim.kind === "indeterminate"
        ? validateIndeterminateClaim(settlementContract, claimValue)
        : validateTerminalClaim(settlementContract, claimValue);
  if (!claimValidation.ok) {
    return failCarrier(`carrier event ${eventKind} claim slot ${claim.key} invalid`);
  }
  if (claimValidation.claim.phase !== claim.kind) {
    return failCarrier(
      `carrier event ${eventKind} claim slot ${claim.key} has phase ${claimValidation.claim.phase}`,
    );
  }
  if (
    claim.kind !== "pre" &&
    !claimMatchesSlotVocabulary(
      claim,
      claimValidation.claim as LivedClaim | RejectedClaim | IndeterminateClaim,
    )
  ) {
    return failCarrier(
      `carrier event ${eventKind} claim slot ${claim.key} outside event vocabulary`,
    );
  }
  return payload;
};

export const defineCarrier = <
  const Prefix extends string,
  const Events extends Readonly<
    Record<string, CarrierEvent<string, AgentSchemaDecoder<unknown>, ClaimSlot>>
  >,
>(
  spec: DefineCarrierSpec<Prefix, Events>,
): Carrier<Prefix, Events> => {
  const fullKinds = new Map<string, string>();
  const kind: Record<string, string> = {};
  const payloadEvents: Record<string, unknown> = {};
  const boundaryEvents: Record<string, BoundaryEventContract> = {};
  const schemas = new Map<string, JsonSchemaObject>();
  const slots = new Map<string, ClaimSlot>();
  const anchorKinds = new Set<AnchorRef["anchorKind"]>();
  const rejectionKinds = new Set<RejectionRef["rejectionKind"]>();
  const indeterminateKinds = new Set<IndeterminateRef["indeterminateKind"]>();
  const settle: Record<string, unknown> = {};
  const reject: Record<string, unknown> = {};
  const indeterminateClaims: Record<string, unknown> = {};

  for (const [name, carrierEvent] of Object.entries(spec.events)) {
    const eventKind = `${spec.prefix}${carrierEvent.kind}`;
    if (fullKinds.has(eventKind)) {
      return failCarrier(`duplicate carrier event kind ${eventKind}`);
    }
    fullKinds.set(eventKind, name);
    kind[name.toUpperCase()] = eventKind;

    const schema = schemaWithoutClaimCollision(
      defineAgentSchema(carrierEvent.payload).jsonSchema,
      carrierEvent.claim,
      eventKind,
    );
    schemas.set(eventKind, schema);
    slots.set(eventKind, carrierEvent.claim);
    payloadEvents[eventKind] = undefined;

    const claim = boundaryClaimFor(carrierEvent.claim);
    boundaryEvents[eventKind] = {
      payloadSchema: schema,
      ...(claim === undefined ? {} : { claim }),
    };

    if (carrierEvent.claim.kind === "lived") {
      for (const anchorKind of carrierEvent.claim.anchorKinds) anchorKinds.add(anchorKind);
      const slot = carrierEvent.claim;
      settle[name] = (claim: PreClaim, settleSpec: CarrierSettleSpec) =>
        settleLived(settlementContract, claim, {
          anchorId: settleSpec.anchorId,
          anchorKind: settleSpec.anchorKind ?? slot.anchorKinds[0]!,
          ...(settleSpec.carrierRef === undefined ? {} : { carrierRef: settleSpec.carrierRef }),
        });
    }

    if (carrierEvent.claim.kind === "rejected") {
      for (const rejectionKind of carrierEvent.claim.rejectionKinds) {
        rejectionKinds.add(rejectionKind);
      }
      const slot = carrierEvent.claim;
      reject[name] = (claim: PreClaim, rejectionSpec: CarrierRejectSpec) =>
        settleRejected(settlementContract, claim, {
          rejectionId: rejectionSpec.rejectionId,
          rejectionKind: rejectionSpec.rejectionKind ?? slot.rejectionKinds[0]!,
          ...(rejectionSpec.reason === undefined ? {} : { reason: rejectionSpec.reason }),
        });
    }

    if (carrierEvent.claim.kind === "indeterminate") {
      for (const indeterminateKind of carrierEvent.claim.indeterminateKinds) {
        indeterminateKinds.add(indeterminateKind);
      }
      const slot = carrierEvent.claim;
      indeterminateClaims[name] = (claim: PreClaim, indeterminateSpec: CarrierIndeterminateSpec) =>
        settleIndeterminate(settlementContract, claim, {
          indeterminateId: indeterminateSpec.indeterminateId,
          indeterminateKind: indeterminateSpec.indeterminateKind ?? slot.indeterminateKinds[0]!,
          ...(indeterminateSpec.reason === undefined ? {} : { reason: indeterminateSpec.reason }),
          ...(indeterminateSpec.carrierRef === undefined
            ? {}
            : { carrierRef: indeterminateSpec.carrierRef }),
        });
    }
  }

  const settlementContract = defineSettlementContract({
    settlementId: spec.ownerId,
    anchorKinds: [...anchorKinds],
    rejectionKinds: [...rejectionKinds],
    indeterminateKinds: [...indeterminateKinds],
  });

  const boundaryContract = {
    ownerId: spec.ownerId,
    sourcePackageName: spec.sourcePackageName,
    kindPrefixes: [spec.prefix],
    roles: spec.roles,
    events: boundaryEvents,
    effectAuthorityContracts: spec.effectAuthorityContracts ?? [],
    materialRequirements: spec.materialRequirements ?? [],
    settlement: settlementContract,
    projection: {
      derivedFromLedger: true,
      shadowState: false,
    } satisfies BoundaryProjectionContract,
  } satisfies BoundaryContract;
  const boundaryValidation = validateBoundaryContract(boundaryContract);
  if (!boundaryValidation.ok) {
    return failCarrier(
      `carrier boundary contract ${spec.ownerId} invalid: ${boundaryValidation.issues.join(",")}`,
    );
  }

  return {
    ownerId: spec.ownerId,
    sourcePackageName: spec.sourcePackageName,
    prefix: spec.prefix,
    kind: kind as CarrierKindView<Prefix, Events>,
    events: payloadEvents as CarrierEventPayloads<Prefix, Events>,
    boundaryContract: boundaryContract as unknown as BoundaryContract<
      keyof CarrierEventPayloads<Prefix, Events> & string
    >,
    settlementContract,
    boundaryModule: (version) => compileBoundaryContract(boundaryContract, version),
    settle: settle as CarrierSettleMap<Events>,
    reject: reject as CarrierRejectMap<Events>,
    indeterminate: indeterminateClaims as CarrierIndeterminateMap<Events>,
    decode: (eventKind, payload) => {
      const schema = schemas.get(eventKind);
      const slot = slots.get(eventKind);
      if (schema === undefined || slot === undefined) {
        return failCarrier(`unknown carrier event ${eventKind}`);
      }
      return decodePayload(
        schema,
        slot,
        settlementContract,
        payload,
        eventKind,
      ) as CarrierEventPayloads<Prefix, Events>[keyof CarrierEventPayloads<Prefix, Events> &
        string];
    },
    handlers: (handlers) => {
      const out: Record<
        string,
        (input: {
          readonly data: unknown;
          readonly event: unknown;
          readonly agent: unknown;
          readonly env: unknown;
        }) => void | Promise<void>
      > = {};
      for (const [name, handler] of Object.entries(handlers)) {
        if (handler === undefined) continue;
        const eventKind = kind[name.toUpperCase()];
        if (eventKind === undefined) return failCarrier(`unknown carrier handler ${name}`);
        out[eventKind] = (input) =>
          handler({
            ...input,
            data: decodePayload(
              schemas.get(eventKind)!,
              slots.get(eventKind)!,
              settlementContract,
              input.data,
              eventKind,
            ) as never,
          });
      }
      return out;
    },
  };
};
