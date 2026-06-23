import {
  ResourceInsufficient,
  ResourceReservationClosed,
  ResourceReservationNotFound,
  SqlError,
} from "@agent-os/core/errors";
import { RESOURCE_EVENT_KIND } from "@agent-os/core/backend-protocol";
import type {
  LedgerEvent,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
} from "@agent-os/core/types";

export interface ResourceReserveTransactionRow {
  readonly status: "existing" | "reserved" | "insufficient";
  readonly reservationId: string;
  readonly available: number;
  readonly event: LedgerEvent | null;
}

export interface ResourceTerminalTransactionRow {
  readonly status: "written" | "noop" | "missing" | "closed";
  readonly closedStatus: "consumed" | "released" | null;
  readonly event: LedgerEvent | null;
}

export const nodePostgresResourceReserveResult = (
  row: ResourceReserveTransactionRow | undefined,
  spec: ResourceReserveSpec,
): ResourceReserveResult => {
  if (row === undefined) throw new SqlError({ cause: "resource reserve returned no result" });
  if (row.status === "insufficient") {
    throw new ResourceInsufficient({
      key: spec.key,
      requested: spec.amount,
      available: row.available,
    });
  }
  return { reservationId: row.reservationId };
};

export const assertNodePostgresResourceTerminalResult = (
  row: ResourceTerminalTransactionRow | undefined,
  spec: ResourceReservationSpec,
  terminalKind: typeof RESOURCE_EVENT_KIND.CONSUMED | typeof RESOURCE_EVENT_KIND.RELEASED,
): void => {
  if (row === undefined) throw new SqlError({ cause: "resource terminal returned no result" });
  const terminalStatus = terminalKind === RESOURCE_EVENT_KIND.CONSUMED ? "consumed" : "released";
  if (row.status === "missing") {
    throw new ResourceReservationNotFound({ reservationId: spec.reservationId });
  }
  if (row.status === "closed") {
    throw new ResourceReservationClosed({
      reservationId: spec.reservationId,
      status: row.closedStatus ?? terminalStatus,
    });
  }
};
