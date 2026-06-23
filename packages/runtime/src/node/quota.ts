import { SqlError } from "@agent-os/core/errors";
import {
  QUOTA_EVENT_KIND,
  projectQuotaGrantUsage,
  type BackendProtocolEventIdentity,
  type BackendProtocolProjectionKey,
  type GrantResult,
} from "@agent-os/core/backend-protocol";
import type { LedgerEvent } from "@agent-os/core/types";

export interface NodePostgresLedgerEventSpec {
  readonly ts: number;
  readonly kind: string;
  readonly identity: BackendProtocolEventIdentity;
  readonly payload: unknown;
}

export const nodePostgresQuotaGrantDecision = (
  events: ReadonlyArray<LedgerEvent>,
  spec: {
    readonly now: number;
    readonly identity: BackendProtocolEventIdentity;
    readonly key: BackendProtocolProjectionKey;
    readonly amount: number;
    readonly windowMs: number;
    readonly limit: number;
    readonly toolName: string;
    readonly operationRef: string;
  },
): { readonly result: GrantResult; readonly event?: NodePostgresLedgerEventSpec } => {
  const windowStart = spec.windowMs === Number.POSITIVE_INFINITY ? 0 : spec.now - spec.windowMs;
  let usage: ReturnType<typeof projectQuotaGrantUsage>;
  try {
    usage = projectQuotaGrantUsage(events, {
      key: spec.key.projectionId,
      windowStart,
      operationRef: spec.operationRef,
    });
  } catch (cause) {
    throw new SqlError({ cause });
  }
  if (usage.alreadyGranted) {
    return {
      result: { granted: true, consumed: usage.consumed, limit: spec.limit },
    };
  }
  const consumed = usage.consumed;
  if (consumed + spec.amount > spec.limit) {
    return {
      result: { granted: false, consumed, limit: spec.limit },
      event: {
        ts: spec.now,
        kind: QUOTA_EVENT_KIND.RATE_LIMITED,
        identity: spec.identity,
        payload: {
          key: spec.key.projectionId,
          attempted: spec.amount,
          consumed,
          limit: spec.limit,
          windowMs: spec.windowMs,
          toolName: spec.toolName,
        },
      },
    };
  }
  return {
    result: { granted: true, consumed, limit: spec.limit },
    event: {
      ts: spec.now,
      kind: QUOTA_EVENT_KIND.CONSUMED,
      identity: spec.identity,
      payload: {
        key: spec.key.projectionId,
        amount: spec.amount,
        toolName: spec.toolName,
        operationRef: spec.operationRef,
      },
    },
  };
};
