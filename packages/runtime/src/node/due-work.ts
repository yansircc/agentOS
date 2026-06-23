import type { LedgerEvent } from "@agent-os/core/types";
import {
  backendProtocolEventIdentityKey,
  type BackendProtocolEventIdentity,
} from "@agent-os/core/backend-protocol";

export interface NodePostgresDueWorkRow {
  readonly id: number;
  readonly identity: BackendProtocolEventIdentity;
  readonly identityKey: string;
  readonly fireAt: number;
  readonly kind: string;
  readonly payload: { readonly intentEventId: number };
  readonly claimToken: string | null;
  readonly redriveCount: number;
  readonly cancelRequestedAt: number | null;
  readonly cancelReason: string | null;
  readonly dispatchIntent: LedgerEvent | null;
  readonly dispatchSuccessCount: number;
  readonly dispatchAttemptCount: number;
}

export const withNodePostgresDueDrainLock = async <T>(
  locks: Map<string, Promise<void>>,
  identity: BackendProtocolEventIdentity,
  drain: () => Promise<T>,
): Promise<T> => {
  const identityKey = backendProtocolEventIdentityKey(identity);
  const previous = locks.get(identityKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => undefined).then(() => current);
  locks.set(identityKey, chained);
  await previous.catch(() => undefined);
  try {
    return await drain();
  } finally {
    release();
    if (locks.get(identityKey) === chained) {
      locks.delete(identityKey);
    }
  }
};
