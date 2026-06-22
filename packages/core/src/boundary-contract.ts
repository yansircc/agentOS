import { Predicate } from "effect";
import { ANCHOR_KINDS, INDETERMINATE_KINDS, REJECTION_KINDS } from "./claim-kinds";
import type { BoundaryPackage } from "./extensions";
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
    }
  | {
      readonly key: string;
      readonly phase: "lived";
      readonly anchorKinds: ReadonlyArray<AnchorRef["anchorKind"]>;
    }
  | {
      readonly key: string;
      readonly phase: "rejected";
      readonly rejectionKinds: ReadonlyArray<RejectionRef["rejectionKind"]>;
    }
  | {
      readonly key: string;
      readonly phase: "indeterminate";
      readonly indeterminateKinds: ReadonlyArray<IndeterminateRef["indeterminateKind"]>;
    };

export interface BoundaryEventContract {
  readonly payloadSchema: JsonSchemaObject;
  readonly claim?: BoundaryEventClaimContract;
}

/**
 * Boundary axis declaring that observable state is derived from ledger facts.
 *
 * @agentosPrimitive primitive.kernel.BoundaryProjectionContract
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/materialized-projections.md
 * @public
 */
export interface BoundaryProjectionContract {
  readonly derivedFromLedger: true;
  readonly shadowState: false;
}

/**
 * Five-axis boundary declaration for claim-bearing packages:
 * vocabulary, authority, material, settlement, and projection.
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
  readonly projection: BoundaryProjectionContract;
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
  | "settlement_invalid"
  | "projection_invalid";

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

const materialRequirementMatches = (
  left: MaterialRequirement,
  right: MaterialRequirement,
): boolean => {
  if (left.kind !== right.kind || left.slot !== right.slot || left.required !== right.required) {
    return false;
  }
  switch (left.kind) {
    case "credential":
      return (
        right.kind === "credential" &&
        left.provider === right.provider &&
        left.purpose === right.purpose
      );
    case "endpoint":
      return right.kind === "endpoint" && left.protocol === right.protocol;
    case "binding":
      return (
        right.kind === "binding" &&
        left.provider === right.provider &&
        left.bindingKind === right.bindingKind
      );
    case "external_resource":
      return (
        right.kind === "external_resource" &&
        left.provider === right.provider &&
        left.resourceKind === right.resourceKind
      );
  }
};

const authorityMaterialsAreDeclared = (
  effectAuthorityContracts: ReadonlyArray<EffectAuthorityContract>,
  materialRequirements: ReadonlyArray<MaterialRequirement>,
): boolean =>
  effectAuthorityContracts.every((contract) =>
    contract.requiredMaterials.every((required) =>
      materialRequirements.some((declared) => materialRequirementMatches(required, declared)),
    ),
  );

const materialRequirementsAreBoundToAuthority = (
  effectAuthorityContracts: ReadonlyArray<EffectAuthorityContract>,
  materialRequirements: ReadonlyArray<MaterialRequirement>,
): boolean =>
  materialRequirements.every((declared) =>
    effectAuthorityContracts.some((contract) =>
      contract.requiredMaterials.some((required) => materialRequirementMatches(required, declared)),
    ),
  );

export const defineBoundaryContract = <EventKind extends string>(
  contract: BoundaryContract<EventKind>,
): BoundaryContract<EventKind> & Authored<BoundaryContract<EventKind>> => authoredValue(contract);

export const boundaryPackage = (contract: BoundaryContract, version: string): BoundaryPackage =>
  ({
    ownerId: contract.ownerId,
    sourcePackageName: contract.sourcePackageName,
    kindPrefixes: contract.kindPrefixes,
    version,
    boundaryContract: contract,
  }) as BoundaryPackage;

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
        "settlement_invalid",
        "projection_invalid",
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
    !value.effectAuthorityContracts.every(isEffectAuthorityContract)
  ) {
    issues.push("authority_contract_invalid");
  }

  if (
    !Array.isArray(value.materialRequirements) ||
    !value.materialRequirements.every(isMaterialRequirement)
  ) {
    issues.push("material_requirements_invalid");
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

  if (
    !Predicate.isObject(value.projection) ||
    value.projection.derivedFromLedger !== true ||
    value.projection.shadowState !== false
  ) {
    issues.push("projection_invalid");
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, contract: authoredValue(value as unknown as BoundaryContract) };
};
