/**
 * EffectClaim calculus.
 *
 * This module is intentionally not exported from the public barrel yet. It is
 * a core-owned invariant helper used by adopting effect boundaries before the
 * type becomes public API.
 */

export type ScopeRef =
  | { readonly kind: "realm"; readonly scopeId: string }
  | { readonly kind: "conversation"; readonly scopeId: string }
  | { readonly kind: "session"; readonly scopeId: string }
  | { readonly kind: "artifact"; readonly scopeId: string }
  | {
      readonly kind: "external";
      readonly scopeId: string;
      readonly systemRef: string;
    };

export interface AuthorityRef {
  readonly authorityId: string;
  readonly authorityClass: string;
  readonly version?: string;
}

export interface OriginRef {
  readonly originId: string;
  readonly originKind: string;
  readonly version?: string;
}

export type OperationRef = string;

export interface AnchorRef {
  readonly anchorId: string;
  readonly anchorKind: "ledger_event" | "carrier_proof" | "external_receipt" | "dry_run_proof";
  readonly carrierRef?: string;
}

export interface RejectionRef {
  readonly rejectionId: string;
  readonly rejectionKind:
    | "capability_denied"
    | "policy_denied"
    | "validation_failed"
    | "unsupported"
    | "resource_denied"
    | "provider_rejected";
  readonly reason?: string;
}

export interface PreClaim {
  readonly phase: "pre";
  readonly operationRef: OperationRef;
  readonly scopeRef: ScopeRef;
  readonly authorityRef: AuthorityRef;
  readonly originRef: OriginRef;
}

export interface LivedClaim extends Omit<PreClaim, "phase"> {
  readonly phase: "lived";
  readonly anchorRef: AnchorRef;
}

export interface RejectedClaim extends Omit<PreClaim, "phase"> {
  readonly phase: "rejected";
  readonly rejectionRef: RejectionRef;
}

export type EffectClaim = PreClaim | LivedClaim | RejectedClaim;

/**
 * Runtime roles around EffectClaim. Writer authority is intentionally not a
 * ClaimRole; durable namespace ownership remains spec-34 ExtensionCapability.
 */
export type ClaimRole = "generator" | "admitter" | "resolver" | "reader";

export type AdmitVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly rejectionRef: RejectionRef;
    };

export const INVALID_ADMITTER_VERDICT_REASON = "invalid_admitter_verdict" as const;
export const INVALID_ADMITTER_REJECTION_REF_REASON = "invalid_admitter_rejection_ref" as const;
export const ADMITTER_ERROR_REASON_PREFIX = "admitter_error: " as const;

export type ClaimValidationIssue =
  | "claim_must_be_object"
  | "phase_invalid"
  | "operation_ref_invalid"
  | "scope_ref_invalid"
  | "authority_ref_invalid"
  | "origin_ref_invalid"
  | "anchor_ref_invalid"
  | "rejection_ref_invalid"
  | "pre_claim_has_terminal_ref"
  | "lived_claim_missing_anchor"
  | "lived_claim_has_rejection"
  | "rejected_claim_missing_rejection"
  | "rejected_claim_has_anchor";

export type ClaimValidation =
  | { readonly ok: true; readonly claim: EffectClaim }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<ClaimValidationIssue>;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key));

const SIMPLE_SCOPE_KEYS = new Set(["kind", "scopeId"]);
const EXTERNAL_SCOPE_KEYS = new Set(["kind", "scopeId", "systemRef"]);

export const makeOperationRef = (
  namespace: string,
  parts: ReadonlyArray<string | number>,
): OperationRef => [namespace, ...parts.map((part) => encodeURIComponent(String(part)))].join(":");

export const makePreClaim = (spec: {
  readonly operationRef: OperationRef;
  readonly scopeRef: ScopeRef;
  readonly authorityRef: AuthorityRef;
  readonly originRef: OriginRef;
}): PreClaim => ({ phase: "pre", ...spec });

export const settleLivedClaim = (claim: PreClaim, anchorRef: AnchorRef): LivedClaim => ({
  phase: "lived",
  operationRef: claim.operationRef,
  scopeRef: claim.scopeRef,
  authorityRef: claim.authorityRef,
  originRef: claim.originRef,
  anchorRef,
});

export const settleRejectedClaim = (
  claim: PreClaim,
  rejectionRef: RejectionRef,
): RejectedClaim => ({
  phase: "rejected",
  operationRef: claim.operationRef,
  scopeRef: claim.scopeRef,
  authorityRef: claim.authorityRef,
  originRef: claim.originRef,
  rejectionRef,
});

export const invalidAdmitterVerdictRejectionRef = (claim: PreClaim): RejectionRef => ({
  rejectionId: claim.operationRef,
  rejectionKind: "policy_denied",
  reason: INVALID_ADMITTER_VERDICT_REASON,
});

export const invalidAdmitterRejectionRef = (claim: PreClaim): RejectionRef => ({
  rejectionId: claim.operationRef,
  rejectionKind: "policy_denied",
  reason: INVALID_ADMITTER_REJECTION_REF_REASON,
});

export const admitterErrorRejectionRef = (claim: PreClaim, cause: unknown): RejectionRef => ({
  rejectionId: claim.operationRef,
  rejectionKind: "provider_rejected",
  reason: `${ADMITTER_ERROR_REASON_PREFIX}${String(cause)}`,
});

export const isScopeRef = (value: unknown): value is ScopeRef => {
  if (!isRecord(value) || !isNonEmptyString(value.scopeId)) {
    return false;
  }
  switch (value.kind) {
    case "realm":
    case "conversation":
    case "session":
    case "artifact":
      return hasOnlyKeys(value, SIMPLE_SCOPE_KEYS);
    case "external":
      return hasOnlyKeys(value, EXTERNAL_SCOPE_KEYS) && isNonEmptyString(value.systemRef);
    default:
      return false;
  }
};

export const isAuthorityRef = (value: unknown): value is AuthorityRef =>
  isRecord(value) &&
  isNonEmptyString(value.authorityId) &&
  isNonEmptyString(value.authorityClass) &&
  optionalString(value.version);

export const isOriginRef = (value: unknown): value is OriginRef =>
  isRecord(value) &&
  isNonEmptyString(value.originId) &&
  isNonEmptyString(value.originKind) &&
  optionalString(value.version);

export const isAnchorRef = (value: unknown): value is AnchorRef =>
  isRecord(value) &&
  isNonEmptyString(value.anchorId) &&
  (value.anchorKind === "ledger_event" ||
    value.anchorKind === "carrier_proof" ||
    value.anchorKind === "external_receipt" ||
    value.anchorKind === "dry_run_proof") &&
  optionalString(value.carrierRef);

export const isRejectionRef = (value: unknown): value is RejectionRef =>
  isRecord(value) &&
  isNonEmptyString(value.rejectionId) &&
  (value.rejectionKind === "capability_denied" ||
    value.rejectionKind === "policy_denied" ||
    value.rejectionKind === "validation_failed" ||
    value.rejectionKind === "unsupported" ||
    value.rejectionKind === "resource_denied" ||
    value.rejectionKind === "provider_rejected") &&
  optionalString(value.reason);

export const normalizeAdmitVerdict = (claim: PreClaim, verdict: unknown): AdmitVerdict => {
  if (isRecord(verdict) && verdict.ok === true) return { ok: true };
  if (isRecord(verdict) && verdict.ok === false) {
    return isRejectionRef(verdict.rejectionRef)
      ? { ok: false, rejectionRef: verdict.rejectionRef }
      : { ok: false, rejectionRef: invalidAdmitterRejectionRef(claim) };
  }
  return { ok: false, rejectionRef: invalidAdmitterVerdictRejectionRef(claim) };
};

export const validateEffectClaim = (value: unknown): ClaimValidation => {
  if (!isRecord(value)) {
    return { ok: false, issues: ["claim_must_be_object"] };
  }

  const issues: ClaimValidationIssue[] = [];
  if (value.phase !== "pre" && value.phase !== "lived" && value.phase !== "rejected") {
    issues.push("phase_invalid");
  }
  if (!isNonEmptyString(value.operationRef)) {
    issues.push("operation_ref_invalid");
  }
  if (!isScopeRef(value.scopeRef)) {
    issues.push("scope_ref_invalid");
  }
  if (!isAuthorityRef(value.authorityRef)) {
    issues.push("authority_ref_invalid");
  }
  if (!isOriginRef(value.originRef)) {
    issues.push("origin_ref_invalid");
  }

  if (value.phase === "pre") {
    if (value.anchorRef !== undefined || value.rejectionRef !== undefined) {
      issues.push("pre_claim_has_terminal_ref");
    }
  }

  if (value.phase === "lived") {
    if (!isAnchorRef(value.anchorRef)) {
      issues.push("lived_claim_missing_anchor");
    }
    if (value.rejectionRef !== undefined) {
      issues.push("lived_claim_has_rejection");
    }
  }

  if (value.phase === "rejected") {
    if (!isRejectionRef(value.rejectionRef)) {
      issues.push("rejected_claim_missing_rejection");
    }
    if (value.anchorRef !== undefined) {
      issues.push("rejected_claim_has_anchor");
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, claim: value as unknown as EffectClaim };
};
