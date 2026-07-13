import { Option, Predicate } from "effect";
import { ANCHOR_KINDS, INDETERMINATE_KINDS, REJECTION_KINDS } from "./claim-kinds";
import { validateAgainstSchema, type JsonSchemaObject } from "./json-schema-dialect";
import {
  isEffectAuthorityContract,
  isMaterialRequirement,
  type EffectAuthorityContract,
  type MaterialRequirement,
} from "./material-ref";
import type { AnchorRef, ClaimRole, IndeterminateRef, RejectionRef } from "./effect-claim";
import { validateSettlementContract, type SettlementContract } from "./settlement-contract";
import { isNonEmptyString } from "./string-guards";
import { authoredValue } from "./value-brands";
import type { Authored } from "./value-brands";

export type BoundaryClaimPhase = "pre" | "lived" | "rejected" | "indeterminate";

export type BoundaryEventClaimContract =
  | {
      readonly key: string;
      readonly phase: "pre";
      readonly authorityContractId: string;
    }
  | {
      readonly key: string;
      readonly phase: "lived";
      readonly authorityContractId: string;
      readonly anchorKinds: ReadonlyArray<AnchorRef["anchorKind"]>;
    }
  | {
      readonly key: string;
      readonly phase: "rejected";
      readonly authorityContractId: string;
      readonly rejectionKinds: ReadonlyArray<RejectionRef["rejectionKind"]>;
    }
  | {
      readonly key: string;
      readonly phase: "indeterminate";
      readonly authorityContractId: string;
      readonly indeterminateKinds: ReadonlyArray<IndeterminateRef["indeterminateKind"]>;
    };

export interface BoundaryEventContract {
  readonly payloadSchema: JsonSchemaObject;
  readonly claim?: BoundaryEventClaimContract;
}

/**
 * Four-axis boundary declaration for claim-bearing packages:
 * vocabulary, authority, material, and settlement.
 *
 * Event keys are the vocabulary. Claim slots are event-local so non-claim
 * extension facts do not need to lie as terminal claim events.
 *
 * @agentosPrimitive primitive.kernel.BoundaryContract
 * @agentosInvariant invariant.d10.namespace-integrity
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/boundary-contract.md
 * @public
 */
export interface BoundaryContract<EventKind extends string = string> {
  readonly ownerId: string;
  readonly sourcePackageName: string;
  readonly kindPrefixes: ReadonlyArray<string>;
  readonly roles: ReadonlyArray<ClaimRole>;
  readonly events: Readonly<Record<EventKind, BoundaryEventContract>>;
  readonly effectAuthorityContracts: ReadonlyArray<EffectAuthorityContract>;
  readonly materialRequirements: ReadonlyArray<MaterialRequirement>;
  readonly settlement: SettlementContract;
}

export interface BoundaryModuleManifest {
  readonly ownerId: string;
  readonly sourcePackageName: string;
  readonly kindPrefixes: ReadonlyArray<string>;
  readonly version: string;
}

declare const boundaryModuleBrand: unique symbol;

/**
 * Pure compiled projection of one authored BoundaryContract.
 *
 * The contract remains the only owner of the four boundary axes. The manifest
 * contains only installation identity derived from that same contract.
 *
 * @public
 */
export interface BoundaryModule<EventKind extends string = string> {
  readonly contract: BoundaryContract<EventKind> & Authored<BoundaryContract<EventKind>>;
  readonly manifest: BoundaryModuleManifest;
  readonly [boundaryModuleBrand]: true;
}

export type BoundaryContractIssue =
  | "owner_id_invalid"
  | "source_package_name_invalid"
  | "kind_prefixes_invalid"
  | "roles_invalid"
  | "events_invalid"
  | "event_outside_prefix"
  | "event_payload_schema_invalid"
  | "event_claim_invalid"
  | "event_claim_outside_settlement"
  | "event_claim_key_collides_with_payload"
  | "authority_contract_invalid"
  | "material_requirements_invalid"
  | "authority_material_outside_axis"
  | "material_authority_unbound"
  | "claim_authority_contract_invalid"
  | "settlement_invalid";

export type BoundaryContractValidation =
  | { readonly ok: true; readonly contract: BoundaryContract & Authored<BoundaryContract> }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<BoundaryContractIssue>;
    };

const CLAIM_ROLES = new Set<ClaimRole>(["generator", "admitter", "resolver", "reader"]);
const CLAIM_PHASES = new Set<BoundaryClaimPhase>(["pre", "lived", "rejected", "indeterminate"]);
const ANCHOR_KIND_SET = new Set<AnchorRef["anchorKind"]>(ANCHOR_KINDS);
const REJECTION_KIND_SET = new Set<RejectionRef["rejectionKind"]>(REJECTION_KINDS);
const INDETERMINATE_KIND_SET = new Set<IndeterminateRef["indeterminateKind"]>(INDETERMINATE_KINDS);

const nonEmptyStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);

const nonEmptyArrayOf = <T>(value: unknown, allowed: ReadonlySet<T>): value is ReadonlyArray<T> =>
  Array.isArray(value) && value.length > 0 && value.every((item) => allowed.has(item as T));

const valuesOwnedByPrefix = (
  values: ReadonlyArray<string>,
  prefixes: ReadonlyArray<string>,
): boolean => values.every((value) => prefixes.some((prefix) => value.startsWith(prefix)));

const isJsonSchemaObject = (value: unknown): value is JsonSchemaObject =>
  Predicate.isObject(value) &&
  value.type === "object" &&
  Predicate.isObject(value.properties) &&
  (value.required === undefined ||
    (Array.isArray(value.required) && value.required.every(isNonEmptyString))) &&
  (value.additionalProperties === undefined || typeof value.additionalProperties === "boolean");

const isBoundaryEventClaimContract = (value: unknown): value is BoundaryEventClaimContract =>
  Predicate.isObject(value) &&
  isNonEmptyString(value.key) &&
  isNonEmptyString(value.authorityContractId) &&
  typeof value.phase === "string" &&
  CLAIM_PHASES.has(value.phase as BoundaryClaimPhase) &&
  (value.phase === "pre"
    ? value.anchorKinds === undefined &&
      value.rejectionKinds === undefined &&
      value.indeterminateKinds === undefined
    : value.phase === "lived"
      ? nonEmptyArrayOf(value.anchorKinds, ANCHOR_KIND_SET) &&
        value.rejectionKinds === undefined &&
        value.indeterminateKinds === undefined
      : value.phase === "rejected"
        ? nonEmptyArrayOf(value.rejectionKinds, REJECTION_KIND_SET) &&
          value.anchorKinds === undefined &&
          value.indeterminateKinds === undefined
        : nonEmptyArrayOf(value.indeterminateKinds, INDETERMINATE_KIND_SET) &&
          value.anchorKinds === undefined &&
          value.rejectionKinds === undefined);

const isBoundaryEventContract = (value: unknown): value is BoundaryEventContract =>
  Predicate.isObject(value) &&
  isJsonSchemaObject(value.payloadSchema) &&
  (value.claim === undefined || isBoundaryEventClaimContract(value.claim));

export const validateBoundaryPayload = (
  contract: BoundaryEventContract,
  payload: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> => validateAgainstSchema(payload, contract.payloadSchema);

const eventEntries = (
  events: unknown,
): ReadonlyArray<readonly [string, BoundaryEventContract]> | null => {
  if (!Predicate.isObject(events)) return null;
  const entries = Object.entries(events);
  if (entries.length === 0) return null;
  const out: Array<readonly [string, BoundaryEventContract]> = [];
  for (const [event, contract] of entries) {
    if (!isNonEmptyString(event) || !isBoundaryEventContract(contract)) return null;
    out.push([event, contract]);
  }
  return out;
};

const eventClaimKeysDoNotCollide = (
  entries: ReadonlyArray<readonly [string, BoundaryEventContract]>,
): boolean =>
  entries.every(([, contract]) => {
    const key = contract.claim?.key;
    return key === undefined || !(key in contract.payloadSchema.properties);
  });

const eventClaimVocabularyIsInSettlement = (
  entries: ReadonlyArray<readonly [string, BoundaryEventContract]>,
  settlement: SettlementContract,
): boolean =>
  entries.every(([, eventContract]) => {
    const claim = eventContract.claim;
    if (claim === undefined || claim.phase === "pre") return true;
    if (claim.phase === "lived") {
      return claim.anchorKinds.every((anchorKind) => settlement.anchorKinds.includes(anchorKind));
    }
    if (claim.phase === "rejected") {
      return claim.rejectionKinds.every((rejectionKind) =>
        settlement.rejectionKinds.includes(rejectionKind),
      );
    }
    return claim.indeterminateKinds.every((indeterminateKind) =>
      settlement.indeterminateKinds.includes(indeterminateKind),
    );
  });

const authorityMaterialsAreDeclared = (
  effectAuthorityContracts: ReadonlyArray<EffectAuthorityContract>,
  materialRequirements: ReadonlyArray<MaterialRequirement>,
): boolean =>
  effectAuthorityContracts.every((contract) =>
    contract.requiredMaterialSlots.every((requiredSlot) =>
      materialRequirements.some((declared) => declared.slot === requiredSlot),
    ),
  );

const materialRequirementsAreBoundToAuthority = (
  effectAuthorityContracts: ReadonlyArray<EffectAuthorityContract>,
  materialRequirements: ReadonlyArray<MaterialRequirement>,
): boolean =>
  materialRequirements.every((declared) =>
    effectAuthorityContracts.some((contract) =>
      contract.requiredMaterialSlots.includes(declared.slot),
    ),
  );

const authorityContractsAreUnique = (contracts: ReadonlyArray<EffectAuthorityContract>): boolean =>
  new Set(contracts.map((contract) => contract.authorityContractId)).size === contracts.length;

const eventClaimAuthoritiesAreDeclared = (
  entries: ReadonlyArray<readonly [string, BoundaryEventContract]>,
  contracts: ReadonlyArray<EffectAuthorityContract>,
): boolean => {
  const declared = new Set(contracts.map((contract) => contract.authorityContractId));
  return entries.every(([, eventContract]) => {
    const authorityContractId = eventContract.claim?.authorityContractId;
    return authorityContractId === undefined || declared.has(authorityContractId);
  });
};

export const defineBoundaryContract = <EventKind extends string>(
  contract: BoundaryContract<EventKind>,
): BoundaryContract<EventKind> & Authored<BoundaryContract<EventKind>> => authoredValue(contract);

export const validateBoundaryContract = (value: unknown): BoundaryContractValidation => {
  if (!Predicate.isObject(value)) {
    return {
      ok: false,
      issues: [
        "owner_id_invalid",
        "source_package_name_invalid",
        "kind_prefixes_invalid",
        "roles_invalid",
        "events_invalid",
        "authority_contract_invalid",
        "material_requirements_invalid",
        "claim_authority_contract_invalid",
        "settlement_invalid",
      ],
    };
  }

  const issues: BoundaryContractIssue[] = [];
  if (!isNonEmptyString(value.ownerId)) {
    issues.push("owner_id_invalid");
  }

  if (!isNonEmptyString(value.sourcePackageName)) {
    issues.push("source_package_name_invalid");
  }

  const prefixes = value.kindPrefixes;
  if (!nonEmptyStringArray(prefixes)) {
    issues.push("kind_prefixes_invalid");
  }

  if (!nonEmptyArrayOf(value.roles, CLAIM_ROLES)) {
    issues.push("roles_invalid");
  }

  const entries = eventEntries(value.events);
  const settlementValidation = validateSettlementContract(value.settlement);
  if (entries === null) {
    issues.push("events_invalid");
  } else {
    const eventKinds = entries.map(([event]) => event);
    if (nonEmptyStringArray(prefixes) && !valuesOwnedByPrefix(eventKinds, prefixes)) {
      issues.push("event_outside_prefix");
    }
    if (!entries.every(([, contract]) => isJsonSchemaObject(contract.payloadSchema))) {
      issues.push("event_payload_schema_invalid");
    }
    if (
      !entries.every(
        ([, contract]) =>
          contract.claim === undefined || isBoundaryEventClaimContract(contract.claim),
      )
    ) {
      issues.push("event_claim_invalid");
    }
    if (!eventClaimKeysDoNotCollide(entries)) {
      issues.push("event_claim_key_collides_with_payload");
    }
    if (
      settlementValidation.ok &&
      !eventClaimVocabularyIsInSettlement(entries, settlementValidation.contract)
    ) {
      issues.push("event_claim_outside_settlement");
    }
  }

  if (
    !Array.isArray(value.effectAuthorityContracts) ||
    !value.effectAuthorityContracts.every(isEffectAuthorityContract) ||
    !authorityContractsAreUnique(value.effectAuthorityContracts)
  ) {
    issues.push("authority_contract_invalid");
  }

  if (
    !Array.isArray(value.materialRequirements) ||
    !value.materialRequirements.every(isMaterialRequirement) ||
    new Set(value.materialRequirements.map((requirement) => requirement.slot)).size !==
      value.materialRequirements.length
  ) {
    issues.push("material_requirements_invalid");
  }

  if (
    entries !== null &&
    Array.isArray(value.effectAuthorityContracts) &&
    value.effectAuthorityContracts.every(isEffectAuthorityContract) &&
    authorityContractsAreUnique(value.effectAuthorityContracts) &&
    !eventClaimAuthoritiesAreDeclared(entries, value.effectAuthorityContracts)
  ) {
    issues.push("claim_authority_contract_invalid");
  }

  if (
    Array.isArray(value.effectAuthorityContracts) &&
    value.effectAuthorityContracts.every(isEffectAuthorityContract) &&
    Array.isArray(value.materialRequirements) &&
    value.materialRequirements.every(isMaterialRequirement) &&
    !authorityMaterialsAreDeclared(value.effectAuthorityContracts, value.materialRequirements)
  ) {
    issues.push("authority_material_outside_axis");
  }

  if (
    Array.isArray(value.effectAuthorityContracts) &&
    value.effectAuthorityContracts.every(isEffectAuthorityContract) &&
    Array.isArray(value.materialRequirements) &&
    value.materialRequirements.every(isMaterialRequirement) &&
    !materialRequirementsAreBoundToAuthority(
      value.effectAuthorityContracts,
      value.materialRequirements,
    )
  ) {
    issues.push("material_authority_unbound");
  }

  if (!settlementValidation.ok) {
    issues.push("settlement_invalid");
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, contract: authoredValue(value as unknown as BoundaryContract) };
};

const failBoundaryCompilation = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

/**
 * Compile one authored boundary declaration into deterministic install data.
 *
 * @public
 */
export const compileBoundaryContract = <EventKind extends string>(
  contract: BoundaryContract<EventKind>,
  version: string,
): BoundaryModule<EventKind> => {
  const validation = validateBoundaryContract(contract);
  if (!validation.ok) {
    return failBoundaryCompilation(
      `compileBoundaryContract: invalid BoundaryContract (${validation.issues.join(",")})`,
    );
  }
  if (!isNonEmptyString(version)) {
    return failBoundaryCompilation("compileBoundaryContract: version must be a non-empty string");
  }
  return {
    contract: validation.contract as BoundaryContract<EventKind> &
      Authored<BoundaryContract<EventKind>>,
    manifest: {
      ownerId: validation.contract.ownerId,
      sourcePackageName: validation.contract.sourcePackageName,
      kindPrefixes: validation.contract.kindPrefixes,
      version,
    },
  } as BoundaryModule<EventKind>;
};
