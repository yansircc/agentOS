import type {
  ResourceGrantResult,
  ResourceGrantSpec,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
} from "@agent-os/kernel/types";
/**
 * Resources — deterministic contract tests.
 *
 * Validates P2 of contract:
 *   - no account/reservation tables;
 *   - balance is reconstructed from resource_pool.* ledger facts;
 *   - reserve is idempotent by idempotencyKey;
 *   - consume/release are mutually exclusive, same-terminal duplicates no-op.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { LedgerEventRpc } from "@agent-os/kernel/types";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";
import type { DispatchTestDO } from "./test-worker";
import { testTruthIdentity } from "./_identity";

interface TestEnv {
  readonly DISPATCH_DO: DurableObjectNamespace<DispatchTestDO>;
}

interface ResourceRpc {
  readonly grantResource: (spec: ResourceGrantSpec) => Promise<ResourceGrantResult>;
  readonly reserveResource: (spec: ResourceReserveSpec) => Promise<ResourceReserveResult>;
  readonly consumeResource: (spec: ResourceReservationSpec) => Promise<void>;
  readonly releaseResource: (spec: ResourceReservationSpec) => Promise<void>;
  readonly events: (identity: BackendProtocolTruthIdentity) => Promise<LedgerEventRpc[]>;
}

interface Balance {
  readonly available: number;
  readonly reserved: number;
  readonly consumed: number;
}

const testEnv = env as unknown as TestEnv;

const stubFor = (scope: string): DurableObjectStub<DispatchTestDO> & ResourceRpc =>
  testEnv.DISPATCH_DO.get(
    testEnv.DISPATCH_DO.idFromName(scope),
  ) as DurableObjectStub<DispatchTestDO> & ResourceRpc;

const eventsFor = (stub: ResourceRpc, scope: string): Promise<LedgerEventRpc[]> =>
  stub.events(testTruthIdentity(scope));

const resourceEvents = (events: ReadonlyArray<LedgerEventRpc>): ReadonlyArray<LedgerEventRpc> =>
  events.filter((e) => e.kind.startsWith("resource_pool."));

const countKind = (events: ReadonlyArray<LedgerEventRpc>, kind: string): number => {
  let count = 0;
  for (const event of events) {
    if (event.kind === kind) count += 1;
  }
  return count;
};

const projectBalance = (events: ReadonlyArray<LedgerEventRpc>, key: string): Balance => {
  let grants = 0;
  const reservations = new Map<
    string,
    { key: string; amount: number; status: "active" | "consumed" | "released" }
  >();

  for (const event of resourceEvents(events)) {
    const payload = event.payload as Record<string, unknown>;
    if (event.kind === "resource_pool.granted" && payload.key === key) {
      grants += Number(payload.amount);
    }
    if (event.kind === "resource_pool.reserved" && payload.key === key) {
      reservations.set(String(payload.reservationId), {
        key,
        amount: Number(payload.amount),
        status: "active",
      });
    }
    if (event.kind === "resource_pool.consumed" || event.kind === "resource_pool.released") {
      const reservation = reservations.get(String(payload.reservationId));
      if (reservation !== undefined) {
        reservation.status = event.kind === "resource_pool.consumed" ? "consumed" : "released";
      }
    }
  }

  let reserved = 0;
  let consumed = 0;
  for (const reservation of reservations.values()) {
    if (reservation.status === "active") reserved += reservation.amount;
    if (reservation.status === "consumed") consumed += reservation.amount;
  }
  return {
    available: grants - reserved - consumed,
    reserved,
    consumed,
  };
};

describe("Resources — business resource reservation ledger", () => {
  it("reserve succeeds when projected available balance is sufficient", async () => {
    const scope = "resource-reserve-success";
    const stub = stubFor(scope);

    await stub.grantResource({ key: "credit", amount: 5, ref: "seed" });
    const { reservationId } = await stub.reserveResource({
      key: "credit",
      amount: 2,
      ref: "req-1",
      idempotencyKey: "reserve-1",
    });

    expect(reservationId).toMatch(/^[0-9a-f-]{36}$/);
    const events = await eventsFor(stub, scope);
    expect(resourceEvents(events).map((e) => e.kind)).toEqual([
      "resource_pool.granted",
      "resource_pool.reserved",
    ]);
    expect(projectBalance(events, "credit")).toEqual({
      available: 3,
      reserved: 2,
      consumed: 0,
    });
  });

  it("reserve rejects without writing resource_pool.reserved when insufficient", async () => {
    const scope = "resource-reserve-insufficient";
    const stub = stubFor(scope);

    await runInDurableObject(stub, async (instance) => {
      const rpc = instance as unknown as ResourceRpc;
      await rpc.grantResource({ key: "credit", amount: 1, ref: "seed" });

      let caught:
        | { _tag?: string; key?: string; requested?: number; available?: number }
        | undefined;
      try {
        await rpc.reserveResource({
          key: "credit",
          amount: 2,
          ref: "req-too-large",
          idempotencyKey: "reserve-too-large",
        });
      } catch (e) {
        caught = e as {
          _tag?: string;
          key?: string;
          requested?: number;
          available?: number;
        };
      }

      expect(caught?._tag).toBe("agent_os.resource_insufficient");
      expect(caught?.key).toBe("credit");
      expect(caught?.requested).toBe(2);
      expect(caught?.available).toBe(1);
    });

    const events = await eventsFor(stub, scope);
    expect(resourceEvents(events).map((e) => e.kind)).toEqual([
      "resource_pool.granted",
      "resource_pool.reserve_rejected",
    ]);
    expect(countKind(events, "resource_pool.reserved")).toBe(0);
  });

  it("same idempotencyKey returns the same reservation without duplicating ledger rows", async () => {
    const scope = "resource-reserve-idempotent";
    const stub = stubFor(scope);

    await stub.grantResource({ key: "credit", amount: 5, ref: "seed" });
    const first = await stub.reserveResource({
      key: "credit",
      amount: 2,
      ref: "req-1",
      idempotencyKey: "same-reserve",
    });
    const second = await stub.reserveResource({
      key: "credit",
      amount: 2,
      ref: "req-1-retry",
      idempotencyKey: "same-reserve",
    });

    expect(second.reservationId).toBe(first.reservationId);
    const events = await eventsFor(stub, scope);
    expect(countKind(events, "resource_pool.reserved")).toBe(1);
    expect(projectBalance(events, "credit")).toEqual({
      available: 3,
      reserved: 2,
      consumed: 0,
    });
  });

  it("consume and release are mutually exclusive", async () => {
    const scope = "resource-terminal-exclusive";
    const stub = stubFor(scope);
    await stub.grantResource({ key: "credit", amount: 5, ref: "seed" });
    const { reservationId } = await stub.reserveResource({
      key: "credit",
      amount: 2,
      ref: "req-1",
      idempotencyKey: "reserve-1",
    });
    await stub.consumeResource({ reservationId, ref: "job-done" });

    await runInDurableObject(stub, async (instance) => {
      const rpc = instance as unknown as ResourceRpc;
      let caught: { _tag?: string; reservationId?: string; status?: string } | undefined;
      try {
        await rpc.releaseResource({ reservationId, ref: "late-release" });
      } catch (e) {
        caught = e as {
          _tag?: string;
          reservationId?: string;
          status?: string;
        };
      }
      expect(caught?._tag).toBe("agent_os.resource_reservation_closed");
      expect(caught?.reservationId).toBe(reservationId);
      expect(caught?.status).toBe("consumed");
    });

    const events = await eventsFor(stub, scope);
    expect(countKind(events, "resource_pool.consumed")).toBe(1);
    expect(countKind(events, "resource_pool.released")).toBe(0);
  });

  it("duplicate consume/release for the same terminal state is idempotent", async () => {
    const scope = "resource-terminal-idempotent";
    const stub = stubFor(scope);
    await stub.grantResource({ key: "credit", amount: 10, ref: "seed" });
    const consumed = await stub.reserveResource({
      key: "credit",
      amount: 2,
      ref: "consume-req",
      idempotencyKey: "consume-reserve",
    });
    const released = await stub.reserveResource({
      key: "credit",
      amount: 3,
      ref: "release-req",
      idempotencyKey: "release-reserve",
    });

    await stub.consumeResource({
      reservationId: consumed.reservationId,
      ref: "job-done",
    });
    await stub.consumeResource({
      reservationId: consumed.reservationId,
      ref: "job-done-retry",
    });
    await stub.releaseResource({
      reservationId: released.reservationId,
      ref: "job-cancelled",
    });
    await stub.releaseResource({
      reservationId: released.reservationId,
      ref: "job-cancelled-retry",
    });

    const events = await eventsFor(stub, scope);
    expect(countKind(events, "resource_pool.consumed")).toBe(1);
    expect(countKind(events, "resource_pool.released")).toBe(1);
  });

  it("projection reconstructs balance from events only", async () => {
    const scope = "resource-projection";
    const stub = stubFor(scope);
    await stub.grantResource({ key: "credit", amount: 10, ref: "seed" });
    const consumed = await stub.reserveResource({
      key: "credit",
      amount: 3,
      ref: "consume-req",
      idempotencyKey: "consume-reserve",
    });
    const active = await stub.reserveResource({
      key: "credit",
      amount: 2,
      ref: "active-req",
      idempotencyKey: "active-reserve",
    });
    const released = await stub.reserveResource({
      key: "credit",
      amount: 1,
      ref: "release-req",
      idempotencyKey: "release-reserve",
    });

    await stub.consumeResource({
      reservationId: consumed.reservationId,
      ref: "job-done",
    });
    await stub.releaseResource({
      reservationId: released.reservationId,
      ref: "job-cancelled",
    });

    const events = await eventsFor(stub, scope);
    expect(active.reservationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(projectBalance(events, "credit")).toEqual({
      available: 5,
      reserved: 2,
      consumed: 3,
    });
  });
});
