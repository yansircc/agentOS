import type { QuotaState, QuotaStateSpec, ResourceState } from "@agent-os/kernel/types";
import { Effect } from "effect";
import { ABORT, SqlError } from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { decodeConsumedPayloadSync } from "./quota/payload";
import { projectRows } from "./resources/projection";
import { type AttemptKey, type CapabilityLease, projectLease } from "./admission";
import { loadAdmissionRows } from "./admission/payload";
import {
  scopeRefKey,
  validateEffectClaim,
  type AnchorRef,
  type AuthorityRef,
  type EffectClaim,
  type LivedClaim,
  type OriginRef,
  type PreClaim,
  type RejectedClaim,
  type RejectionRef,
  type ScopeRef,
} from "@agent-os/kernel/effect-claim";
import { validateTerminalClaim } from "@agent-os/kernel/settlement-contract";
import { dispatchSettlementContract } from "@agent-os/backend-protocol";
import { toolSettlementContract } from "@agent-os/runtime";

const abortKinds = new Set<string>(Object.values(ABORT));

const payloadObject = (payload: unknown): Record<string, unknown> =>
  payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

export interface ClaimTraceSpec {
  readonly operationRef?: string;
  readonly phases?: ReadonlyArray<EffectClaim["phase"]>;
}

interface ClaimTraceBase {
  readonly eventId: number;
  readonly eventKind: string;
  readonly scopeKey: string;
  readonly ts: number;
  readonly operationRef: string;
  readonly scopeRef: ScopeRef;
  readonly authorityRef: AuthorityRef;
  readonly originRef: OriginRef;
}

export interface PreClaimTraceEntry extends ClaimTraceBase {
  readonly phase: PreClaim["phase"];
}

export interface LivedClaimTraceEntry extends ClaimTraceBase {
  readonly phase: LivedClaim["phase"];
  readonly anchorRef: AnchorRef;
}

export interface RejectedClaimTraceEntry extends ClaimTraceBase {
  readonly phase: RejectedClaim["phase"];
  readonly rejectionRef: RejectionRef;
}

export type ClaimTraceEntry = PreClaimTraceEntry | LivedClaimTraceEntry | RejectedClaimTraceEntry;

interface FailurePlaneBase {
  readonly eventId: number;
  readonly eventKind: string;
  readonly scopeKey: string;
  readonly ts: number;
}

export interface ClaimRejectedFailurePlaneEntry extends FailurePlaneBase {
  readonly plane: "claim_rejected";
  readonly operationRef: string;
  readonly rejectionRef: RejectionRef;
  readonly reason?: string;
}

export interface RunAbortedFailurePlaneEntry extends FailurePlaneBase {
  readonly plane: "run_aborted";
  readonly reason?: string;
}

export type FailurePlaneEntry = ClaimRejectedFailurePlaneEntry | RunAbortedFailurePlaneEntry;

const claimFromEvent = (event: LedgerEvent): EffectClaim | null => {
  const raw = payloadObject(event.payload).claim;
  if (event.kind === "dispatch.outbound.delivered" || event.kind === "dispatch.inbound.accepted") {
    const validation = validateTerminalClaim(dispatchSettlementContract, raw);
    return validation.ok ? validation.claim : null;
  }
  if (event.kind === "tool.executed" || event.kind === "tool.rejected") {
    const validation = validateTerminalClaim(toolSettlementContract, raw);
    return validation.ok ? validation.claim : null;
  }
  const validation = validateEffectClaim(raw);
  return validation.ok ? validation.claim : null;
};

const claimTraceBase = (event: LedgerEvent, claim: EffectClaim): ClaimTraceBase => ({
  eventId: event.id,
  eventKind: event.kind,
  scopeKey: scopeRefKey(event.scopeRef),
  ts: event.ts,
  operationRef: claim.operationRef,
  scopeRef: claim.scopeRef,
  authorityRef: claim.authorityRef,
  originRef: claim.originRef,
});

const claimTraceEntry = (event: LedgerEvent, claim: EffectClaim): ClaimTraceEntry => {
  const base = claimTraceBase(event, claim);
  switch (claim.phase) {
    case "pre":
      return { ...base, phase: "pre" };
    case "lived":
      return { ...base, phase: "lived", anchorRef: claim.anchorRef };
    case "rejected":
      return {
        ...base,
        phase: "rejected",
        rejectionRef: claim.rejectionRef,
      };
  }
};

export const projectClaimTrace = (
  events: ReadonlyArray<LedgerEvent>,
  spec: ClaimTraceSpec = {},
): ReadonlyArray<ClaimTraceEntry> => {
  const phases =
    spec.phases !== undefined && spec.phases.length > 0
      ? new Set<EffectClaim["phase"]>(spec.phases)
      : undefined;
  const rows: ClaimTraceEntry[] = [];

  for (const event of events) {
    const claim = claimFromEvent(event);
    if (claim === null) continue;
    if (spec.operationRef !== undefined && claim.operationRef !== spec.operationRef) {
      continue;
    }
    if (phases !== undefined && !phases.has(claim.phase)) continue;
    rows.push(claimTraceEntry(event, claim));
  }
  return rows;
};

export const projectFailurePlane = (
  events: ReadonlyArray<LedgerEvent>,
): ReadonlyArray<FailurePlaneEntry> => {
  const rows: FailurePlaneEntry[] = [];
  for (const event of events) {
    const claim = claimFromEvent(event);
    if (claim?.phase === "rejected") {
      rows.push({
        eventId: event.id,
        eventKind: event.kind,
        scopeKey: scopeRefKey(event.scopeRef),
        ts: event.ts,
        plane: "claim_rejected",
        operationRef: claim.operationRef,
        rejectionRef: claim.rejectionRef,
        reason: claim.rejectionRef.reason,
      });
      continue;
    }
    if (abortKinds.has(event.kind)) {
      const reason = payloadObject(event.payload).reason;
      rows.push({
        eventId: event.id,
        eventKind: event.kind,
        scopeKey: scopeRefKey(event.scopeRef),
        ts: event.ts,
        plane: "run_aborted",
        ...(typeof reason === "string" ? { reason } : {}),
      });
    }
  }
  return rows;
};

export const projectQuotaState = (
  events: ReadonlyArray<LedgerEvent>,
  spec: QuotaStateSpec,
  now: number,
): QuotaState => {
  const windowStart = spec.windowMs === Number.POSITIVE_INFINITY ? 0 : now - spec.windowMs;
  let consumed = 0;
  for (const event of events) {
    if (event.kind !== "quota.consumed") continue;
    if (event.ts < windowStart) continue;
    const payload = decodeConsumedPayloadSync(event.payload);
    if (payload.key === spec.key) {
      consumed += payload.amount;
    }
  }
  return {
    consumed,
    limit: spec.limit,
    remaining: Math.max(0, spec.limit - consumed),
    refundable: 0,
    ...(spec.windowMs === Number.POSITIVE_INFINITY ? {} : { windowStart }),
  };
};

export const projectResourceState = (
  events: ReadonlyArray<LedgerEvent>,
  key: string,
): ResourceState => {
  const state = projectRows(
    events
      .filter((event) => event.kind.startsWith("resource_pool."))
      .map((event) => ({
        kind: event.kind,
        payload: JSON.stringify(event.payload),
      })),
  );
  const projection = state.byKey.get(key) ?? {
    available: 0,
    reserved: 0,
    consumed: 0,
  };
  const reservations = Array.from(state.byId.values())
    .filter((reservation) => reservation.key === key && reservation.status === "active")
    .map((reservation) => ({
      id: reservation.reservationId,
      amount: reservation.amount,
    }));
  return {
    granted: projection.available + projection.reserved + projection.consumed,
    reserved: projection.reserved,
    consumed: projection.consumed,
    available: projection.available,
    reservations,
  };
};

export const projectAdmissionLease = (
  sql: SqlStorage,
  scope: string,
  key: AttemptKey,
  now: number,
): Effect.Effect<CapabilityLease | null, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* loadAdmissionRows(sql, scope);
    const { lease } = projectLease(rows, key, now);
    return lease.status === "unknown" ? null : lease;
  });
