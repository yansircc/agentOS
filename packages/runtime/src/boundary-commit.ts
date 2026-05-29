import { Data, Effect, Predicate } from "effect";
import { validateEffectClaim, type EffectClaim } from "@agent-os/kernel/effect-claim";
import type {
  BoundaryContract,
  BoundaryEventContract,
} from "@agent-os/kernel/boundary-contract";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import { validateAgainstSchema } from "@agent-os/kernel/json-schema";
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
  | "claim_settlement_invalid";

export class BoundaryCommitRejected extends Data.TaggedError("agent_os.boundary_commit_rejected")<{
  readonly packageId: string;
  readonly event: string;
  readonly issue: BoundaryCommitIssue;
}> {}

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

export const validateBoundaryEventPayload = (
  contract: BoundaryContract,
  event: string,
  payload: unknown,
): BoundaryCommitRejected | null => {
  const eventContract = contract.events[event];
  if (eventContract === undefined) {
    return reject(contract, event, "event_outside_vocabulary");
  }
  if (!Predicate.isRecord(payload)) {
    return reject(contract, event, "payload_must_be_object");
  }
  if (validateAgainstSchema(payloadForSchema(payload, eventContract), eventContract.payloadSchema).length > 0) {
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
  if (
    validation.claim.phase !== "pre" &&
    !validateTerminalClaim(contract.settlement, validation.claim).ok
  ) {
    return reject(contract, event, "claim_settlement_invalid");
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
