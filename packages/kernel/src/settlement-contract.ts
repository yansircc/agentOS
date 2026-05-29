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

const SYMBOLIC_SETTLEMENT_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;
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
  | { readonly ok: true; readonly contract: SettlementContract }
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
  | { readonly ok: true; readonly claim: LivedClaim | RejectedClaim }
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
  if (!Predicate.isRecord(value)) {
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
  return { ok: true, contract: value as unknown as SettlementContract };
};

export const defineSettlementContract = <Contract extends SettlementContract>(
  contract: Contract,
): Contract => {
  const validation = validateSettlementContract(contract);
  if (!validation.ok) {
    return failConstruction(
      `settlement contract ${contract.settlementId || "<unknown>"} invalid: ${validation.issues.join(",")}`,
    );
  }
  return contract;
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

  const issues: TerminalClaimIssue[] = [];
  if (validation.claim.phase === "lived") {
    if (!contract.anchorKinds.includes(validation.claim.anchorRef.anchorKind)) {
      issues.push("anchor_kind_outside_contract");
    }
    if (!isSymbolicSettlementValue(validation.claim.anchorRef.anchorId)) {
      issues.push("anchor_id_not_symbolic");
    }
    if (
      validation.claim.anchorRef.carrierRef !== undefined &&
      !isSymbolicSettlementValue(validation.claim.anchorRef.carrierRef)
    ) {
      issues.push("carrier_ref_not_symbolic");
    }
  } else {
    if (!contract.rejectionKinds.includes(validation.claim.rejectionRef.rejectionKind)) {
      issues.push("rejection_kind_outside_contract");
    }
    if (!isSymbolicSettlementValue(validation.claim.rejectionRef.rejectionId)) {
      issues.push("rejection_id_not_symbolic");
    }
    if (
      validation.claim.rejectionRef.reason !== undefined &&
      !isSymbolicSettlementValue(validation.claim.rejectionRef.reason)
    ) {
      issues.push("reason_not_symbolic");
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, claim: validation.claim };
};

export const settleLived = (
  contract: SettlementContract,
  claim: PreClaim,
  anchorRef: AnchorRef,
): LivedClaim => {
  const lived: LivedClaim = {
    phase: "lived",
    operationRef: claim.operationRef,
    scopeRef: claim.scopeRef,
    authorityRef: claim.authorityRef,
    originRef: claim.originRef,
    anchorRef,
  };
  const validation = validateTerminalClaim(contract, lived);
  if (!validation.ok) {
    return failConstruction(
      `settled lived claim violates ${contract.settlementId}: ${validation.issues.join(",")}`,
    );
  }
  return lived;
};

export const settleRejected = (
  contract: SettlementContract,
  claim: PreClaim,
  rejectionRef: RejectionRef,
): RejectedClaim => {
  const rejected: RejectedClaim = {
    phase: "rejected",
    operationRef: claim.operationRef,
    scopeRef: claim.scopeRef,
    authorityRef: claim.authorityRef,
    originRef: claim.originRef,
    rejectionRef,
  };
  const validation = validateTerminalClaim(contract, rejected);
  if (!validation.ok) {
    return failConstruction(
      `settled rejected claim violates ${contract.settlementId}: ${validation.issues.join(",")}`,
    );
  }
  return rejected;
};
