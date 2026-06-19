import type { AnchorRef, IndeterminateRef, RejectionRef } from "./effect-claim";

export const ANCHOR_KINDS = [
  "ledger_event",
  "carrier_proof",
  "external_receipt",
  "dry_run_proof",
] as const satisfies ReadonlyArray<AnchorRef["anchorKind"]>;

export const REJECTION_KINDS = [
  "capability_denied",
  "policy_denied",
  "validation_failed",
  "unsupported",
  "resource_denied",
  "provider_rejected",
] as const satisfies ReadonlyArray<RejectionRef["rejectionKind"]>;

export const INDETERMINATE_KINDS = [
  "provider_pending",
  "reconcile_required",
  "retry_pending",
  "witness_unavailable",
] as const satisfies ReadonlyArray<IndeterminateRef["indeterminateKind"]>;
