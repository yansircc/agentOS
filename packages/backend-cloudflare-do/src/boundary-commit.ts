import { Data, Effect } from "effect";
import { validateEffectClaim, type EffectClaim } from "@agent-os/kernel/effect-claim";
import type { BoundaryContract } from "@agent-os/kernel/boundary-contract";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/runtime";

type BoundaryCommitIssue =
  | "event_outside_vocabulary"
  | "payload_must_be_object"
  | "claim_missing"
  | "claim_invalid"
  | "claim_phase_invalid"
  | "claim_authority_invalid"
  | "claim_anchor_invalid";

export class BoundaryCommitRejected extends Data.TaggedError("agent_os.boundary_commit_rejected")<{
  readonly packageId: string;
  readonly event: string;
  readonly issue: BoundaryCommitIssue;
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const authorityKey = (claim: EffectClaim): string =>
  `${claim.authorityRef.authorityClass}:${claim.authorityRef.authorityId}:${claim.authorityRef.version ?? ""}`;

const contractAuthorityKeys = (contract: BoundaryContract): ReadonlySet<string> =>
  new Set(
    contract.authorityContracts.map(
      ({ authorityRef }) =>
        `${authorityRef.authorityClass}:${authorityRef.authorityId}:${authorityRef.version ?? ""}`,
    ),
  );

const reject = (
  contract: BoundaryContract,
  event: string,
  issue: BoundaryCommitIssue,
): BoundaryCommitRejected =>
  new BoundaryCommitRejected({ packageId: contract.packageId, event, issue });

export const validateBoundaryEventPayload = (
  contract: BoundaryContract,
  event: string,
  payload: unknown,
): BoundaryCommitRejected | null => {
  const phases = contract.claimPhases[event];
  if (phases === undefined) {
    return reject(contract, event, "event_outside_vocabulary");
  }
  if (!isRecord(payload)) {
    return reject(contract, event, "payload_must_be_object");
  }
  const claim = payload[contract.claimPayloadKey];
  if (claim === undefined) {
    return reject(contract, event, "claim_missing");
  }
  const validation = validateEffectClaim(claim);
  if (!validation.ok) {
    return reject(contract, event, "claim_invalid");
  }
  if (!phases.includes(validation.claim.phase)) {
    return reject(contract, event, "claim_phase_invalid");
  }
  if (
    validation.claim.phase === "lived" &&
    !contract.proof.anchorKinds.includes(validation.claim.anchorRef.anchorKind)
  ) {
    return reject(contract, event, "claim_anchor_invalid");
  }
  const authorityKeys = contractAuthorityKeys(contract);
  if (authorityKeys.size > 0 && !authorityKeys.has(authorityKey(validation.claim))) {
    return reject(contract, event, "claim_authority_invalid");
  }
  return null;
};

export const commitBoundaryEvent = (
  contract: BoundaryContract,
  event: string,
  payload: unknown,
  commit: () => Effect.Effect<LedgerEvent, SqlError | JsonStringifyError>,
): Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError> =>
  Effect.gen(function* () {
    const rejected = validateBoundaryEventPayload(contract, event, payload);
    if (rejected !== null) {
      return yield* Effect.fail(rejected);
    }
    return yield* commit();
  });
