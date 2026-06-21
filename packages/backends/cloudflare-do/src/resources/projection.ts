import {
  emptyResourceProjection,
  projectResourceRows,
  type ProjectedResourceState,
  type ResourceProjection,
  type ResourceProtocolEventRow,
  type ResourceReservationProjection,
  type ResourceReservationStatus,
} from "@agent-os/core/backend-protocol";
import { sqlText } from "../storage/sql-row";
import { eventIdentity, eventIdentityColumns } from "../ledger/identity";
import type { FactOwnerRef } from "@agent-os/core/effect-claim";
import type { LedgerTruthIdentity } from "@agent-os/core/runtime-protocol";

export type {
  ProjectedResourceState as ProjectedState,
  ResourceProjection,
  ResourceProtocolEventRow as ResourceEventRow,
  ResourceReservationProjection as ReservationState,
  ResourceReservationStatus as TerminalStatus,
};

export { emptyResourceProjection as emptyProjection, projectResourceRows as projectRows };

export const loadState = (
  sql: SqlStorage,
  identity: LedgerTruthIdentity,
  factOwnerRef: FactOwnerRef,
): ProjectedResourceState => {
  const columns = eventIdentityColumns(eventIdentity(identity, factOwnerRef));
  const rows = sql
    .exec(
      "SELECT kind, payload FROM events WHERE event_identity_key = ? AND kind LIKE 'resource_pool.%' ORDER BY id",
      columns.event_identity_key,
    )
    .toArray() as unknown as ResourceProtocolEventRow[];
  return projectResourceRows(
    rows.map((row) => ({
      kind: sqlText(row.kind, "events.kind"),
      payload: sqlText(row.payload, "events.payload"),
    })),
  );
};
