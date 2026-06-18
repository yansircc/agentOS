import { Data, Effect, Predicate } from "effect";
import {
  authorityRefKey,
  validateEffectClaim,
  type EffectClaim,
  type FactOwnerRef,
  type LivedClaim,
  type RejectedClaim,
  type ScopeRef,
} from "@agent-os/kernel/effect-claim";
import {
  validateBoundaryPayload,
  type BoundaryContract,
  type BoundaryEventContract,
} from "@agent-os/kernel/boundary-contract";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import { validateTerminalClaim } from "@agent-os/kernel/settlement-contract";
import type { LedgerEvent } from "@agent-os/kernel/types";

type BoundaryCommitIssue =
  | "event_outside_vocabulary"
  | "payload_must_be_object"
  | "payload_schema_invalid"
  | "claim_missing"
  | "claim_invalid"
  | "claim_phase_invalid"
  | "claim_authority_invalid"
  | "claim_settlement_invalid"
  | "committed_event_kind_mismatch"
  | "committed_fact_owner_mismatch"
  | "committed_scope_ref_mismatch"
  | "committed_effect_authority_mismatch";

export interface BoundaryCommitIdentity {
  readonly kind: string;
  readonly factOwnerRef: FactOwnerRef;
  readonly scopeRef?: ScopeRef;
  readonly effectAuthorityRef?: EffectClaim["effectAuthorityRef"];
}

export class BoundaryCommitRejected extends Data.TaggedError("agent_os.boundary_commit_rejected")<{
  readonly packageId: string;
  readonly event: string;
  readonly issue: BoundaryCommitIssue;
}> {}

const contractAuthorityKeys = (contract: BoundaryContract): ReadonlySet<string> =>
  new Set(
    contract.effectAuthorityContracts.map(({ effectAuthorityRef }) =>
      authorityRefKey(effectAuthorityRef),
    ),
  );

const reject = (
  contract: BoundaryContract,
  event: string,
  issue: BoundaryCommitIssue,
): BoundaryCommitRejected =>
  new BoundaryCommitRejected({ packageId: contract.packageId, event, issue });

const payloadForSchema = (
  payload: Readonly<Record<string, unknown>>,
  eventContract: BoundaryEventContract,
): Readonly<Record<string, unknown>> => {
  const claimKey = eventContract.claim?.key;
  if (claimKey === undefined || !(claimKey in payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== claimKey) out[key] = value;
  }
  return out;
};

const terminalClaimMatchesEventSlot = (
  eventContract: BoundaryEventContract,
  claim: LivedClaim | RejectedClaim,
): boolean => {
  const claimContract = eventContract.claim;
  if (claimContract === undefined || claimContract.phase === "pre") return true;
  if (claimContract.phase === "lived" && claim.phase === "lived") {
    return claimContract.anchorKinds.includes(claim.anchorRef.anchorKind);
  }
  if (claimContract.phase === "rejected" && claim.phase === "rejected") {
    return claimContract.rejectionKinds.includes(claim.rejectionRef.rejectionKind);
  }
  return true;
};

const validatedClaimFromPayload = (
  eventContract: BoundaryEventContract,
  payload: Readonly<Record<string, unknown>>,
): EffectClaim | null => {
  const claimKey = eventContract.claim?.key;
  if (claimKey === undefined) return null;
  const validation = validateEffectClaim(payload[claimKey]);
  return validation.ok ? validation.claim : null;
};

export const validateBoundaryEventPayload = (
  contract: BoundaryContract,
  event: string,
  payload: unknown,
): BoundaryCommitRejected | null => {
  const eventContract = contract.events[event];
  if (eventContract === undefined) {
    return reject(contract, event, "event_outside_vocabulary");
  }
  if (!Predicate.isObject(payload)) {
    return reject(contract, event, "payload_must_be_object");
  }
  if (validateBoundaryPayload(eventContract, payloadForSchema(payload, eventContract)).length > 0) {
    return reject(contract, event, "payload_schema_invalid");
  }

  const claimContract = eventContract.claim;
  if (claimContract === undefined) {
    return null;
  }

  const claim = payload[claimContract.key];
  if (claim === undefined) {
    return reject(contract, event, "claim_missing");
  }
  const validation = validateEffectClaim(claim);
  if (!validation.ok) {
    return reject(contract, event, "claim_invalid");
  }
  if (validation.claim.phase !== claimContract.phase) {
    return reject(contract, event, "claim_phase_invalid");
  }
  if (validation.claim.phase !== "pre") {
    const terminalValidation = validateTerminalClaim(contract.settlement, validation.claim);
    if (
      !terminalValidation.ok ||
      !terminalClaimMatchesEventSlot(eventContract, terminalValidation.claim)
    ) {
      return reject(contract, event, "claim_settlement_invalid");
    }
  }
  const authorityKeys = contractAuthorityKeys(contract);
  if (
    authorityKeys.size > 0 &&
    !authorityKeys.has(authorityRefKey(validation.claim.effectAuthorityRef))
  ) {
    return reject(contract, event, "claim_authority_invalid");
  }
  return null;
};

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const boundaryCommitIdentity = (
  contract: BoundaryContract,
  event: string,
  payload: Readonly<Record<string, unknown>>,
): BoundaryCommitIdentity => {
  const eventContract = contract.events[event];
  const claim =
    eventContract === undefined ? null : validatedClaimFromPayload(eventContract, payload);
  return {
    kind: event,
    factOwnerRef: contract.packageId,
    ...(claim === null
      ? {}
      : {
          scopeRef: claim.scopeRef,
          effectAuthorityRef: claim.effectAuthorityRef,
        }),
  };
};

const validateCommittedBoundaryEvent = (
  contract: BoundaryContract,
  event: string,
  payload: Readonly<Record<string, unknown>>,
  committed: LedgerEvent,
): BoundaryCommitRejected | null => {
  if (committed.kind !== event) {
    return reject(contract, event, "committed_event_kind_mismatch");
  }
  if (committed.factOwnerRef !== contract.packageId) {
    return reject(contract, event, "committed_fact_owner_mismatch");
  }
  const identity = boundaryCommitIdentity(contract, event, payload);
  if (identity.scopeRef !== undefined && !sameJson(committed.scopeRef, identity.scopeRef)) {
    return reject(contract, event, "committed_scope_ref_mismatch");
  }
  if (
    identity.effectAuthorityRef !== undefined &&
    !sameJson(committed.effectAuthorityRef, identity.effectAuthorityRef)
  ) {
    return reject(contract, event, "committed_effect_authority_mismatch");
  }
  const authorityKeys = contractAuthorityKeys(contract);
  if (authorityKeys.size > 0 && !authorityKeys.has(authorityRefKey(committed.effectAuthorityRef))) {
    return reject(contract, event, "committed_effect_authority_mismatch");
  }
  return null;
};

export const commitBoundaryEvent = (
  contract: BoundaryContract,
  event: string,
  payload: unknown,
  commit: (
    identity: BoundaryCommitIdentity,
  ) => Effect.Effect<LedgerEvent, SqlError | JsonStringifyError>,
): Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError> =>
  Effect.gen(function* () {
    const rejected = validateBoundaryEventPayload(contract, event, payload);
    if (rejected !== null) {
      return yield* Effect.fail(rejected);
    }
    const objectPayload = payload as Readonly<Record<string, unknown>>;
    const identity = boundaryCommitIdentity(contract, event, objectPayload);
    const committed = yield* commit(identity);
    const committedRejected = validateCommittedBoundaryEvent(
      contract,
      event,
      objectPayload,
      committed,
    );
    if (committedRejected !== null) {
      return yield* Effect.fail(committedRejected);
    }
    return committed;
  });
