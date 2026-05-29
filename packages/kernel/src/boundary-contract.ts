import { Predicate } from "effect";
import type { BoundaryPackage } from "./extensions";
import type { JsonSchemaObject } from "./json-schema";
import {
  isAuthorityContract,
  isMaterialRequirement,
  type AuthorityContract,
  type MaterialRequirement,
} from "./material-ref";
import type { ClaimRole } from "./effect-claim";
import { validateSettlementContract, type SettlementContract } from "./settlement-contract";
import { isNonEmptyString } from "./string-guards";

export type BoundaryClaimPhase = "pre" | "lived" | "rejected";

export interface BoundaryEventClaimContract {
  readonly key: string;
  readonly phase: BoundaryClaimPhase;
}

export interface BoundaryEventContract {
  readonly payloadSchema: JsonSchemaObject;
  readonly claim?: BoundaryEventClaimContract;
}

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
 */
export interface BoundaryContract<EventKind extends string = string> {
  readonly packageId: string;
  readonly kindPrefixes: ReadonlyArray<string>;
  readonly roles: ReadonlyArray<ClaimRole>;
  readonly events: Readonly<Record<EventKind, BoundaryEventContract>>;
  readonly authorityContracts: ReadonlyArray<AuthorityContract>;
  readonly materialRequirements: ReadonlyArray<MaterialRequirement>;
  readonly settlement: SettlementContract;
  readonly projection: BoundaryProjectionContract;
}

export type BoundaryContractIssue =
  | "package_id_invalid"
  | "kind_prefixes_invalid"
  | "roles_invalid"
  | "events_invalid"
  | "event_outside_prefix"
  | "event_payload_schema_invalid"
  | "event_claim_invalid"
  | "event_claim_key_collides_with_payload"
  | "authority_contract_invalid"
  | "material_requirements_invalid"
  | "authority_material_outside_axis"
  | "material_authority_unbound"
  | "settlement_invalid"
  | "projection_invalid";

export type BoundaryContractValidation =
  | { readonly ok: true; readonly contract: BoundaryContract }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<BoundaryContractIssue>;
    };

const CLAIM_ROLES = new Set<ClaimRole>(["generator", "admitter", "resolver", "reader"]);
const CLAIM_PHASES = new Set<BoundaryClaimPhase>(["pre", "lived", "rejected"]);

const nonEmptyStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);

const nonEmptyArrayOf = <T>(value: unknown, allowed: ReadonlySet<T>): value is ReadonlyArray<T> =>
  Array.isArray(value) && value.length > 0 && value.every((item) => allowed.has(item as T));

const valuesOwnedByPrefix = (
  values: ReadonlyArray<string>,
  prefixes: ReadonlyArray<string>,
): boolean => values.every((value) => prefixes.some((prefix) => value.startsWith(prefix)));

const isJsonSchemaObject = (value: unknown): value is JsonSchemaObject =>
  Predicate.isRecord(value) &&
  value.type === "object" &&
  Predicate.isRecord(value.properties) &&
  (value.required === undefined ||
    (Array.isArray(value.required) && value.required.every(isNonEmptyString))) &&
  (value.additionalProperties === undefined || typeof value.additionalProperties === "boolean");

const isBoundaryEventClaimContract = (value: unknown): value is BoundaryEventClaimContract =>
  Predicate.isRecord(value) &&
  isNonEmptyString(value.key) &&
  typeof value.phase === "string" &&
  CLAIM_PHASES.has(value.phase as BoundaryClaimPhase);

const isBoundaryEventContract = (value: unknown): value is BoundaryEventContract =>
  Predicate.isRecord(value) &&
  isJsonSchemaObject(value.payloadSchema) &&
  (value.claim === undefined || isBoundaryEventClaimContract(value.claim));

const eventEntries = (
  events: unknown,
): ReadonlyArray<readonly [string, BoundaryEventContract]> | null => {
  if (!Predicate.isRecord(events)) return null;
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
  authorityContracts: ReadonlyArray<AuthorityContract>,
  materialRequirements: ReadonlyArray<MaterialRequirement>,
): boolean =>
  authorityContracts.every((contract) =>
    contract.requiredMaterials.every((required) =>
      materialRequirements.some((declared) => materialRequirementMatches(required, declared)),
    ),
  );

const materialRequirementsAreBoundToAuthority = (
  authorityContracts: ReadonlyArray<AuthorityContract>,
  materialRequirements: ReadonlyArray<MaterialRequirement>,
): boolean =>
  materialRequirements.every((declared) =>
    authorityContracts.some((contract) =>
      contract.requiredMaterials.some((required) => materialRequirementMatches(required, declared)),
    ),
  );

export const defineBoundaryContract = <EventKind extends string>(
  contract: BoundaryContract<EventKind>,
): BoundaryContract<EventKind> => contract;

export const boundaryPackage = (contract: BoundaryContract, version: string): BoundaryPackage => ({
  packageId: contract.packageId,
  kindPrefixes: contract.kindPrefixes,
  version,
  boundaryContract: contract,
});

export const validateBoundaryContract = (value: unknown): BoundaryContractValidation => {
  if (!Predicate.isRecord(value)) {
    return {
      ok: false,
      issues: [
        "package_id_invalid",
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
  if (!isNonEmptyString(value.packageId)) {
    issues.push("package_id_invalid");
  }

  const prefixes = value.kindPrefixes;
  if (!nonEmptyStringArray(prefixes)) {
    issues.push("kind_prefixes_invalid");
  }

  if (!nonEmptyArrayOf(value.roles, CLAIM_ROLES)) {
    issues.push("roles_invalid");
  }

  const entries = eventEntries(value.events);
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
    if (!entries.every(([, contract]) => contract.claim === undefined || isBoundaryEventClaimContract(contract.claim))) {
      issues.push("event_claim_invalid");
    }
    if (!eventClaimKeysDoNotCollide(entries)) {
      issues.push("event_claim_key_collides_with_payload");
    }
  }

  if (
    !Array.isArray(value.authorityContracts) ||
    !value.authorityContracts.every(isAuthorityContract)
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
    Array.isArray(value.authorityContracts) &&
    value.authorityContracts.every(isAuthorityContract) &&
    Array.isArray(value.materialRequirements) &&
    value.materialRequirements.every(isMaterialRequirement) &&
    !authorityMaterialsAreDeclared(value.authorityContracts, value.materialRequirements)
  ) {
    issues.push("authority_material_outside_axis");
  }

  if (
    Array.isArray(value.authorityContracts) &&
    value.authorityContracts.every(isAuthorityContract) &&
    Array.isArray(value.materialRequirements) &&
    value.materialRequirements.every(isMaterialRequirement) &&
    !materialRequirementsAreBoundToAuthority(value.authorityContracts, value.materialRequirements)
  ) {
    issues.push("material_authority_unbound");
  }

  if (!validateSettlementContract(value.settlement).ok) {
    issues.push("settlement_invalid");
  }

  if (
    !Predicate.isRecord(value.projection) ||
    value.projection.derivedFromLedger !== true ||
    value.projection.shadowState !== false
  ) {
    issues.push("projection_invalid");
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, contract: value as unknown as BoundaryContract };
};
