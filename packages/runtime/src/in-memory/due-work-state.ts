import { SqlError } from "@agent-os/core/errors";
import {
  backendProtocolEventIdentityKey,
  durableProcessLifecycleState,
  durableTriggerDuePayload,
  type BackendProtocolEventIdentity,
  type DurableProcessLifecycleState,
  type IntentPointerDuePayload,
} from "@agent-os/core/backend-protocol";

export interface InMemoryDueWorkRow {
  readonly id: number;
  readonly identity: BackendProtocolEventIdentity;
  readonly identityKey: string;
  readonly fireAt: number;
  readonly kind: string;
  readonly payload: IntentPointerDuePayload;
  completedAt: number | null;
  claimedAt: number | null;
  claimToken: string | null;
  claimDeadlineAt: number | null;
  redriveCount: number;
  cancelRequestedAt: number | null;
  cancelReason: string | null;
  cancelledAt: number | null;
}

export const createInMemoryDueWorkRow = (spec: {
  readonly id: number;
  readonly identity: BackendProtocolEventIdentity;
  readonly fireAt: number;
  readonly kind: string;
  readonly intentEventId: number;
}): InMemoryDueWorkRow => ({
  id: spec.id,
  identity: spec.identity,
  identityKey: backendProtocolEventIdentityKey(spec.identity),
  fireAt: spec.fireAt,
  kind: spec.kind,
  payload: durableTriggerDuePayload(spec.intentEventId),
  completedAt: null,
  claimedAt: null,
  claimToken: null,
  claimDeadlineAt: null,
  redriveCount: 0,
  cancelRequestedAt: null,
  cancelReason: null,
  cancelledAt: null,
});

export const duePendingRows = (
  dueWork: ReadonlyArray<InMemoryDueWorkRow>,
  identity: BackendProtocolEventIdentity,
  now: number,
): ReadonlyArray<InMemoryDueWorkRow> => {
  const identityKey = backendProtocolEventIdentityKey(identity);
  return dueWork
    .filter(
      (row) => row.identityKey === identityKey && row.completedAt === null && row.fireAt <= now,
    )
    .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
};

export const dueClaimableRows = (
  dueWork: ReadonlyArray<InMemoryDueWorkRow>,
  identity: BackendProtocolEventIdentity,
  now: number,
): ReadonlyArray<InMemoryDueWorkRow> => {
  const identityKey = backendProtocolEventIdentityKey(identity);
  return dueWork
    .filter(
      (row) =>
        row.identityKey === identityKey &&
        row.completedAt === null &&
        row.fireAt <= now &&
        (row.claimToken === null || (row.claimDeadlineAt !== null && row.claimDeadlineAt <= now)),
    )
    .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
};

export const nextDueAtForIdentity = (
  dueWork: ReadonlyArray<InMemoryDueWorkRow>,
  identity: BackendProtocolEventIdentity,
): number | null => {
  const identityKey = backendProtocolEventIdentityKey(identity);
  let minDueAt: number | null = null;
  for (const row of dueWork) {
    if (row.identityKey !== identityKey) continue;
    if (row.completedAt !== null) continue;
    const next = row.claimToken === null ? row.fireAt : row.claimDeadlineAt;
    if (next === null) continue;
    if (minDueAt === null || next < minDueAt) minDueAt = next;
  }
  return minDueAt;
};

export const claimInMemoryDueWorkRow = (
  row: InMemoryDueWorkRow,
  now: number,
  token: string,
  deadlineAt: number,
): InMemoryDueWorkRow | null => {
  if (row.completedAt !== null || row.fireAt > now) return null;
  if (row.claimToken !== null && (row.claimDeadlineAt === null || row.claimDeadlineAt > now)) {
    return null;
  }
  const redrive = row.claimToken !== null;
  row.claimedAt = now;
  row.claimToken = token;
  row.claimDeadlineAt = deadlineAt;
  if (redrive) row.redriveCount += 1;
  return row;
};

export const dueRowsByTriggerIntent = (
  dueWork: ReadonlyArray<InMemoryDueWorkRow>,
  identity: BackendProtocolEventIdentity,
  kind: string,
  intentEventId: number,
): ReadonlyArray<InMemoryDueWorkRow> => {
  const identityKey = backendProtocolEventIdentityKey(identity);
  return dueWork
    .filter(
      (row) =>
        row.identityKey === identityKey &&
        row.completedAt === null &&
        row.kind === kind &&
        row.payload.intentEventId === intentEventId,
    )
    .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
};

export const requestDueCancellation = (
  row: InMemoryDueWorkRow,
  now: number,
  reason?: string,
): boolean => {
  if (row.completedAt !== null) return false;
  row.cancelRequestedAt ??= now;
  row.cancelReason ??= reason ?? null;
  if (row.claimToken !== null && (row.claimDeadlineAt === null || row.claimDeadlineAt > now)) {
    row.claimDeadlineAt = now;
  }
  return true;
};

export const stuckDueWorkRows = (
  dueWork: ReadonlyArray<InMemoryDueWorkRow>,
  identity: BackendProtocolEventIdentity,
  now: number,
): ReadonlyArray<{
  readonly dueWorkId: number;
  readonly triggerKind: string;
  readonly intentEventId: number;
  readonly claimDeadlineAt: number;
  readonly redriveCount: number;
}> => {
  const identityKey = backendProtocolEventIdentityKey(identity);
  return dueWork
    .filter(
      (row) =>
        row.identityKey === identityKey &&
        row.completedAt === null &&
        row.claimToken !== null &&
        row.claimDeadlineAt !== null &&
        row.claimDeadlineAt <= now,
    )
    .sort((a, b) => (a.claimDeadlineAt ?? 0) - (b.claimDeadlineAt ?? 0) || a.id - b.id)
    .map((row) => ({
      dueWorkId: row.id,
      triggerKind: row.kind,
      intentEventId: row.payload.intentEventId,
      claimDeadlineAt: row.claimDeadlineAt ?? now,
      redriveCount: row.redriveCount,
    }));
};

export const durableProcessLifecycleRows = (
  dueWork: ReadonlyArray<InMemoryDueWorkRow>,
  identity: BackendProtocolEventIdentity,
): ReadonlyArray<DurableProcessLifecycleState> => {
  const identityKey = backendProtocolEventIdentityKey(identity);
  const states: DurableProcessLifecycleState[] = [];
  for (const row of [...dueWork]
    .filter((row) => row.identityKey === identityKey)
    .sort((left, right) => left.id - right.id)) {
    const result = durableProcessLifecycleState({
      id: row.id,
      fireAt: row.fireAt,
      kind: row.kind,
      intentEventId: row.payload.intentEventId,
      completedAt: row.completedAt,
      claimedAt: row.claimedAt,
      claimToken: row.claimToken,
      claimDeadlineAt: row.claimDeadlineAt,
      redriveCount: row.redriveCount,
      cancelRequestedAt: row.cancelRequestedAt,
      cancelReason: row.cancelReason,
      cancelledAt: row.cancelledAt,
    });
    if (!result.ok) throw new SqlError({ cause: result.cause });
    states.push(result.state);
  }
  return states;
};
