import { Predicate } from "effect";
import type { BoundaryPackage } from "./extensions";
import {
  isAuthorityContract,
  isMaterialRequirement,
  type AuthorityContract,
  type MaterialRequirement,
} from "./material-ref";
import type { ClaimRole } from "./effect-claim";
import { validateSettlementContract, type SettlementContract } from "./settlement-contract";
import { isNonEmptyString } from "./string-guards";

type ClaimPhase = "pre" | "lived" | "rejected";

export interface BoundaryProjectionContract {
  readonly derivedFromLedger: true;
  readonly shadowState: false;
}

/**
 * Five-axis boundary declaration for claim-bearing packages:
 * vocabulary, authority, material, settlement, and projection.
 *
 * Cleanup is not a sixth axis here. Release/destruction semantics remain
 * carrier-owned settlement vocabulary until multiple packages expose cleanup as an
 * independent contract surface.
 */
export interface BoundaryContract<EventKind extends string = string> {
  readonly packageId: string;
  readonly kindPrefixes: ReadonlyArray<string>;
  readonly roles: ReadonlyArray<ClaimRole>;
  readonly vocabulary: Readonly<Record<string, EventKind>>;
  readonly authorityContracts: ReadonlyArray<AuthorityContract>;
  readonly materialRequirements: ReadonlyArray<MaterialRequirement>;
  readonly claimPayloadKey: "claim";
  readonly claimPhases: Readonly<Record<EventKind, ReadonlyArray<"pre" | "lived" | "rejected">>>;
  readonly settlement: SettlementContract;
  readonly projection: BoundaryProjectionContract;
}

export type BoundaryContractIssue =
  | "package_id_invalid"
  | "kind_prefixes_invalid"
  | "roles_invalid"
  | "vocabulary_invalid"
  | "vocabulary_outside_prefix"
  | "authority_contract_invalid"
  | "material_requirements_invalid"
  | "authority_material_outside_axis"
  | "material_authority_unbound"
  | "claim_payload_key_invalid"
  | "claim_phases_invalid"
  | "settlement_invalid"
  | "projection_invalid";

export type BoundaryContractValidation =
  | { readonly ok: true; readonly contract: BoundaryContract }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<BoundaryContractIssue>;
    };

const CLAIM_ROLES = new Set<ClaimRole>(["generator", "admitter", "resolver", "reader"]);
const CLAIM_PHASES = new Set<ClaimPhase>(["pre", "lived", "rejected"]);

const nonEmptyStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);

const nonEmptyArrayOf = <T>(value: unknown, allowed: ReadonlySet<T>): value is ReadonlyArray<T> =>
  Array.isArray(value) && value.length > 0 && value.every((item) => allowed.has(item as T));

const vocabularyValues = (value: unknown): ReadonlyArray<string> | null => {
  if (!Predicate.isRecord(value)) return null;
  const values = Object.values(value);
  if (values.length === 0 || !values.every(isNonEmptyString)) return null;
  return values;
};

const valuesOwnedByPrefix = (
  values: ReadonlyArray<string>,
  prefixes: ReadonlyArray<string>,
): boolean => values.every((value) => prefixes.some((prefix) => value.startsWith(prefix)));

const claimPhasesAreValid = (
  claimPhases: unknown,
  vocabularyValuesList: ReadonlyArray<string>,
): claimPhases is Readonly<Record<string, ReadonlyArray<ClaimPhase>>> => {
  if (!Predicate.isRecord(claimPhases)) return false;
  const vocabularySet = new Set(vocabularyValuesList);
  const phaseKeys = Object.keys(claimPhases);
  if (phaseKeys.length !== vocabularySet.size) return false;
  for (const value of vocabularySet) {
    const phases = claimPhases[value];
    if (!nonEmptyArrayOf(phases, CLAIM_PHASES)) return false;
    if (phases.includes("pre") && phases.some((phase) => phase !== "pre")) return false;
  }
  return phaseKeys.every((kind) => vocabularySet.has(kind));
};

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
        "vocabulary_invalid",
        "authority_contract_invalid",
        "material_requirements_invalid",
        "claim_payload_key_invalid",
        "claim_phases_invalid",
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

  const values = vocabularyValues(value.vocabulary);
  if (values === null) {
    issues.push("vocabulary_invalid");
  } else if (nonEmptyStringArray(prefixes) && !valuesOwnedByPrefix(values, prefixes)) {
    issues.push("vocabulary_outside_prefix");
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

  if (value.claimPayloadKey !== "claim") {
    issues.push("claim_payload_key_invalid");
  }

  if (values === null || !claimPhasesAreValid(value.claimPhases, values)) {
    issues.push("claim_phases_invalid");
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
