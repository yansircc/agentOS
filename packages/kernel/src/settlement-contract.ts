import { Option, Predicate } from "effect";

import {
  validateEffectClaim,
  type AnchorRef,
  type LivedClaim,
  type PreClaim,
  type RejectedClaim,
  type RejectionRef,
} from "./effect-claim";
import { ANCHOR_KINDS, REJECTION_KINDS } from "./claim-kinds";
import { isNonEmptyString } from "./string-guards";
import { authoredValue, ownerRecordableMint } from "./value-brands";
import type { Authored, Recordable } from "./value-brands";

export const SYMBOLIC_SETTLEMENT_VALUE_PATTERN = "^[A-Za-z0-9_.:-]{1,128}$";
const SYMBOLIC_SETTLEMENT_VALUE = new RegExp(SYMBOLIC_SETTLEMENT_VALUE_PATTERN);
const SYMBOLIC_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-";

export interface SettlementContract {
  readonly settlementId: string;
  readonly anchorKinds: ReadonlyArray<AnchorRef["anchorKind"]>;
  readonly rejectionKinds: ReadonlyArray<RejectionRef["rejectionKind"]>;
}

export type SettlementContractIssue =
  | "settlement_id_invalid"
  | "anchor_kinds_invalid"
  | "rejection_kinds_invalid";

export type SettlementContractValidation =
  | { readonly ok: true; readonly contract: SettlementContract & Authored<SettlementContract> }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<SettlementContractIssue>;
    };

export type TerminalClaimIssue =
  | "claim_invalid"
  | "claim_not_terminal"
  | "anchor_kind_outside_contract"
  | "anchor_id_not_symbolic"
  | "carrier_ref_not_symbolic"
  | "rejection_kind_outside_contract"
  | "rejection_id_not_symbolic"
  | "reason_not_symbolic";

export type TerminalClaimValidation =
  | {
      readonly ok: true;
      readonly claim:
        | (LivedClaim & Recordable<LivedClaim>)
        | (RejectedClaim & Recordable<RejectedClaim>);
    }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<TerminalClaimIssue>;
    };

const noDuplicates = <T>(values: ReadonlyArray<T>): boolean =>
  new Set(values).size === values.length;

const isAnchorKind = (value: unknown): value is AnchorRef["anchorKind"] =>
  ANCHOR_KINDS.includes(value as AnchorRef["anchorKind"]);

const isRejectionKind = (value: unknown): value is RejectionRef["rejectionKind"] =>
  REJECTION_KINDS.includes(value as RejectionRef["rejectionKind"]);

const arrayOf = <T>(
  value: unknown,
  predicate: (item: unknown) => item is T,
): value is ReadonlyArray<T> =>
  Array.isArray(value) && value.every(predicate) && noDuplicates(value);

const failConstruction = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const recordableTerminalClaim = <Claim extends LivedClaim | RejectedClaim>(
  claim: Claim,
): Claim & Recordable<Claim> => ownerRecordableMint.recordable(claim);

export const isSymbolicSettlementValue = (value: string): boolean =>
  SYMBOLIC_SETTLEMENT_VALUE.test(value);

const encodeSymbolicPart = (value: string | number): string => {
  const raw = String(value);
  if (raw.length === 0) return "_";
  let encoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    encoded += SYMBOLIC_CHARS.includes(char)
      ? char
      : `_x${raw.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  return encoded;
};

const fnv1a32 = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const symbolicSettlementRef = (
  namespace: string,
  parts: ReadonlyArray<string | number>,
): string => {
  const encoded = [namespace, ...parts].map(encodeSymbolicPart).join(":");
  if (isSymbolicSettlementValue(encoded)) return encoded;
  const prefix = encodeSymbolicPart(namespace).slice(0, 64) || "settlement";
  return `${prefix}:${fnv1a32(encoded)}`;
};

export const validateSettlementContract = (value: unknown): SettlementContractValidation => {
  if (!Predicate.isObject(value)) {
    return {
      ok: false,
      issues: ["settlement_id_invalid", "anchor_kinds_invalid", "rejection_kinds_invalid"],
    };
  }

  const issues: SettlementContractIssue[] = [];
  if (!isNonEmptyString(value.settlementId)) {
    issues.push("settlement_id_invalid");
  }
  if (!arrayOf(value.anchorKinds, isAnchorKind)) {
    issues.push("anchor_kinds_invalid");
  }
  if (!arrayOf(value.rejectionKinds, isRejectionKind)) {
    issues.push("rejection_kinds_invalid");
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, contract: authoredValue(value as unknown as SettlementContract) };
};

export const defineSettlementContract = <Contract extends SettlementContract>(
  contract: Contract,
): Contract & Authored<Contract> => {
  const validation = validateSettlementContract(contract);
  if (!validation.ok) {
    return failConstruction(
      `settlement contract ${contract.settlementId || "<unknown>"} invalid: ${validation.issues.join(",")}`,
    );
  }
  return authoredValue(contract);
};

export const validateTerminalClaim = (
  contract: SettlementContract,
  claim: unknown,
): TerminalClaimValidation => {
  const validation = validateEffectClaim(claim);
  if (!validation.ok) {
    return { ok: false, issues: ["claim_invalid"] };
  }
  if (validation.claim.phase === "pre") {
    return { ok: false, issues: ["claim_not_terminal"] };
  }

  const issues = terminalClaimFieldIssues(contract, validation.claim);

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    claim:
      validation.claim.phase === "lived"
        ? recordableTerminalClaim(validation.claim)
        : recordableTerminalClaim(validation.claim),
  };
};

const terminalClaimFieldIssues = (
  contract: SettlementContract,
  claim: LivedClaim | RejectedClaim,
): ReadonlyArray<TerminalClaimIssue> => {
  const issues: TerminalClaimIssue[] = [];
  if (claim.phase === "lived") {
    if (!contract.anchorKinds.includes(claim.anchorRef.anchorKind)) {
      issues.push("anchor_kind_outside_contract");
    }
    if (!isSymbolicSettlementValue(claim.anchorRef.anchorId)) {
      issues.push("anchor_id_not_symbolic");
    }
    if (
      claim.anchorRef.carrierRef !== undefined &&
      !isSymbolicSettlementValue(claim.anchorRef.carrierRef)
    ) {
      issues.push("carrier_ref_not_symbolic");
    }
  } else {
    if (!contract.rejectionKinds.includes(claim.rejectionRef.rejectionKind)) {
      issues.push("rejection_kind_outside_contract");
    }
    if (!isSymbolicSettlementValue(claim.rejectionRef.rejectionId)) {
      issues.push("rejection_id_not_symbolic");
    }
    if (
      claim.rejectionRef.reason !== undefined &&
      !isSymbolicSettlementValue(claim.rejectionRef.reason)
    ) {
      issues.push("reason_not_symbolic");
    }
  }
  return issues;
};

export const settleLived = (
  contract: SettlementContract,
  claim: PreClaim,
  anchorRef: AnchorRef,
): LivedClaim & Recordable<LivedClaim> => {
  const lived: LivedClaim = {
    phase: "lived",
    operationRef: claim.operationRef,
    scopeRef: claim.scopeRef,
    effectAuthorityRef: claim.effectAuthorityRef,
    originRef: claim.originRef,
    anchorRef,
  };
  const issues = terminalClaimFieldIssues(contract, lived);
  if (issues.length > 0) {
    return failConstruction(
      `settled lived claim violates ${contract.settlementId}: ${issues.join(",")}`,
    );
  }
  return recordableTerminalClaim(lived);
};

export const settleRejected = (
  contract: SettlementContract,
  claim: PreClaim,
  rejectionRef: RejectionRef,
): RejectedClaim & Recordable<RejectedClaim> => {
  const rejected: RejectedClaim = {
    phase: "rejected",
    operationRef: claim.operationRef,
    scopeRef: claim.scopeRef,
    effectAuthorityRef: claim.effectAuthorityRef,
    originRef: claim.originRef,
    rejectionRef,
  };
  const issues = terminalClaimFieldIssues(contract, rejected);
  if (issues.length > 0) {
    return failConstruction(
      `settled rejected claim violates ${contract.settlementId}: ${issues.join(",")}`,
    );
  }
  return recordableTerminalClaim(rejected);
};
