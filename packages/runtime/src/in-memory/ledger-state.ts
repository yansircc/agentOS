import { SqlError } from "@agent-os/core/errors";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/core/types";
import {
  backendProtocolEventIdentityKey,
  backendProtocolTruthIdentityKey,
  normalizeBackendPageLimit,
  type BackendProtocolTruthIdentity,
} from "@agent-os/core/backend-protocol";
import { authorityRefKey, scopeRefKey } from "@agent-os/core/effect-claim";
import { assertRuntimeLedgerTransitions } from "@agent-os/core/runtime-protocol";
import {
  eventIdentity,
  eventTruthIdentity,
  groupRuntimeTransitionEventsByTruthIdentity,
  normalizeNonNegativeInteger,
} from "./state-helpers";

export const appendRowsToLedgerIndexes = (
  events: ReadonlyArray<LedgerEvent>,
  rows: LedgerEvent[],
  rowsByTruthIdentityKey: Map<string, LedgerEvent[]>,
  rowsByEventIdentityKey: Map<string, LedgerEvent[]>,
): void => {
  rows.push(...events);
  for (const event of events) {
    const truthKey = backendProtocolTruthIdentityKey(eventTruthIdentity(event));
    const eventKey = backendProtocolEventIdentityKey(eventIdentity(event));
    const truthRows = rowsByTruthIdentityKey.get(truthKey);
    if (truthRows === undefined) {
      rowsByTruthIdentityKey.set(truthKey, [event]);
    } else {
      truthRows.push(event);
    }
    const eventRows = rowsByEventIdentityKey.get(eventKey);
    if (eventRows === undefined) {
      rowsByEventIdentityKey.set(eventKey, [event]);
    } else {
      eventRows.push(event);
    }
  }
};

export const assertInMemoryRuntimeLedgerTransitionBatch = (
  events: ReadonlyArray<LedgerEvent>,
  rowsForTruthIdentity: (identity: BackendProtocolTruthIdentity) => ReadonlyArray<LedgerEvent>,
): void => {
  for (const group of groupRuntimeTransitionEventsByTruthIdentity(events)) {
    assertRuntimeLedgerTransitions({
      history: rowsForTruthIdentity(group.identity),
      events: group.events,
    });
  }
};

export const queryInMemoryLedgerRows = (
  rows: ReadonlyArray<LedgerEvent>,
  identity: BackendProtocolTruthIdentity,
  opts: EventQueryOptions = {},
): ReadonlyArray<LedgerEvent> => {
  const afterId = normalizeNonNegativeInteger(opts.afterId, 0);
  const limit = normalizeBackendPageLimit(opts.limit);
  const kinds =
    opts.kinds === undefined
      ? undefined
      : new Set(Array.from(new Set(opts.kinds)).filter((kind) => kind.length > 0));
  if (
    opts.scopeRef !== undefined &&
    scopeRefKey(opts.scopeRef) !== scopeRefKey(identity.scopeRef)
  ) {
    return [];
  }
  if (
    opts.effectAuthorityRef !== undefined &&
    authorityRefKey(opts.effectAuthorityRef) !== authorityRefKey(identity.effectAuthorityRef)
  ) {
    return [];
  }
  const factOwnerRefs =
    opts.factOwnerRefs === undefined
      ? undefined
      : new Set(Array.from(new Set(opts.factOwnerRefs)).filter((owner) => owner.length > 0));
  const selected = rows.filter((row) => {
    if (row.id <= afterId) return false;
    if (kinds !== undefined && kinds.size > 0 && !kinds.has(row.kind)) return false;
    if (
      factOwnerRefs !== undefined &&
      factOwnerRefs.size > 0 &&
      !factOwnerRefs.has(row.factOwnerRef)
    ) {
      return false;
    }
    return true;
  });
  return selected.slice(0, limit);
};

export const sqlErrorFromUnknown = (cause: unknown): SqlError =>
  cause instanceof SqlError ? cause : new SqlError({ cause });
