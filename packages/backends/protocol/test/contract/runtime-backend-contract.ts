import type {
  DispatchToScopeSpec,
  LedgerEvent,
  ResourceGrantResult,
  ResourceGrantSpec,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
} from "@agent-os/kernel/types";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { DISPATCH_EVENT_KINDS, DISPATCH_MAX_ATTEMPTS, dispatchBackoffMs } from "../../src";
import type { BindingMaterialRef } from "@agent-os/kernel/material-ref";
import type { DispatchToScopeResult } from "@agent-os/kernel/types";
import type {
  DispatchDeliveryResult,
  DispatchEnvelope,
  DispatchReceiverResult,
  DispatchTargetAdapter,
  GrantResult,
  ResourceProjection,
} from "@agent-os/runtime";

export type ContractDispatchReceiver = (
  envelope: DispatchEnvelope,
  accept: () => Promise<DispatchReceiverResult>,
) => Promise<DispatchReceiverResult>;

export type ContractDispatchTargetAdapter = (
  envelope: DispatchEnvelope,
) => Promise<DispatchDeliveryResult>;

export interface RuntimeBackendContractDriver {
  readonly bindingRef: BindingMaterialRef;
  readonly registerDispatchReceiver: (
    scope: string,
    receiver?: ContractDispatchReceiver,
  ) => void | Promise<void>;
  readonly setDispatchTargetAdapter: (
    adapter: DispatchTargetAdapter | ContractDispatchTargetAdapter,
  ) => void | Promise<void>;
  readonly addHandler: (
    kind: string,
    handler: (event: LedgerEvent) => void | Promise<void>,
  ) => { readonly unsubscribe: () => void } | void;
  readonly log: (scope: string, kind: string, payload: unknown) => Promise<LedgerEvent>;
  readonly events: (scope: string) => Promise<ReadonlyArray<LedgerEvent>>;
  readonly schedule: (
    scope: string,
    at: number,
    eventKind: string,
    data: unknown,
  ) => Promise<{ readonly id: number }>;
  readonly fireDue: (scope: string, now: number) => Promise<{ readonly fired: number }>;
  readonly dispatchToScope: (
    sourceScope: string,
    spec: DispatchToScopeSpec,
  ) => Promise<DispatchToScopeResult>;
  readonly drainDispatchDue: (
    scope: string,
    now: number,
  ) => Promise<{ readonly delivered: number; readonly failed: number }>;
  readonly nextDueAt: (scope: string) => Promise<number | null>;
  readonly pendingDueCount: (scope: string) => Promise<number>;
  readonly grantResource: (scope: string, spec: ResourceGrantSpec) => Promise<ResourceGrantResult>;
  readonly reserveResource: (
    scope: string,
    spec: ResourceReserveSpec,
  ) => Promise<ResourceReserveResult>;
  readonly consumeResource: (scope: string, spec: ResourceReservationSpec) => Promise<void>;
  readonly releaseResource: (scope: string, spec: ResourceReservationSpec) => Promise<void>;
  readonly projectResource: (scope: string, key: string) => Promise<ResourceProjection>;
  readonly quotaTryGrant: (
    scope: string,
    key: string,
    amount: number,
    windowMs: number,
    limit: number,
    toolName: string,
  ) => Promise<GrantResult>;
  readonly dispose: () => Promise<void>;
}

export type RuntimeBackendContractDriverFactory = () =>
  | RuntimeBackendContractDriver
  | Promise<RuntimeBackendContractDriver>;

const targetFor = (
  driver: RuntimeBackendContractDriver,
  scope: string,
): DispatchToScopeSpec["target"] => ({
  bindingRef: driver.bindingRef,
  scope,
  scopeRef: { kind: "conversation", scopeId: scope },
});

const dispatchSpec = (
  driver: RuntimeBackendContractDriver,
  targetScope: string,
  idempotencyKey: string,
  event = "app.received",
  data: unknown = { value: 1 },
): DispatchToScopeSpec => ({
  target: targetFor(driver, targetScope),
  event,
  data,
  idempotencyKey,
});

const payloadsOf = <T>(events: ReadonlyArray<LedgerEvent>, kind: string): ReadonlyArray<T> =>
  events.filter((event) => event.kind === kind).map((event) => event.payload as T);

const kindsOf = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind);

const SCHEDULED_REQUESTED = "durable_trigger.scheduled.requested";

export const runRuntimeBackendContractSuite = (
  name: string,
  makeDriver: RuntimeBackendContractDriverFactory,
): void => {
  const promise = <A>(thunk: () => Promise<A> | A): Effect.Effect<A> =>
    Effect.promise(() => Promise.resolve(thunk()));

  const expectRejectTagEffect = (input: Promise<unknown>, tag: string): Effect.Effect<void> =>
    promise(
      () =>
        expect(input).rejects.toMatchObject({
          name: expect.stringContaining(tag),
        }) as Promise<void>,
    );

  const withDriver = (
    fn: (driver: RuntimeBackendContractDriver) => Effect.Effect<void>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const driver = yield* promise(() => makeDriver());
      yield* fn(driver).pipe(Effect.ensuring(promise(() => driver.dispose())));
    });

  describe(name + " runtime backend protocol contract", () => {
    it.effect("fires scheduled due events exactly once", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          yield* promise(() =>
            driver.schedule("schedule-scope", 10, "app.scheduled", { job: "one" }),
          );

          expect(yield* promise(() => driver.nextDueAt("schedule-scope"))).toBe(10);
          expect(yield* promise(() => driver.fireDue("schedule-scope", 9))).toEqual({
            fired: 0,
          });
          expect(kindsOf(yield* promise(() => driver.events("schedule-scope")))).toEqual([
            SCHEDULED_REQUESTED,
          ]);
          expect(yield* promise(() => driver.fireDue("schedule-scope", 10))).toEqual({ fired: 1 });
          expect(yield* promise(() => driver.fireDue("schedule-scope", 10))).toEqual({ fired: 0 });

          const events = yield* promise(() => driver.events("schedule-scope"));
          expect(kindsOf(events)).toEqual([SCHEDULED_REQUESTED, "app.scheduled"]);
          expect(events[1]?.payload).toEqual({ job: "one" });
          expect(yield* promise(() => driver.pendingDueCount("schedule-scope"))).toBe(0);
        }),
      ),
    );

    it.effect("drains scheduler and delivery retry work from one due-work queue", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          let receiveAttempts = 0;
          yield* promise(() =>
            driver.registerDispatchReceiver("receiver", (_envelope, accept) => {
              receiveAttempts += 1;
              if (receiveAttempts === 1) return Promise.reject("transient");
              return accept();
            }),
          );

          yield* promise(() =>
            driver.dispatchToScope(
              "combo-scope",
              dispatchSpec(driver, "receiver", "combo-retry", "app.combo", { retry: true }),
            ),
          );
          const retryAt = yield* promise(() => driver.nextDueAt("combo-scope"));
          expect(typeof retryAt).toBe("number");

          yield* promise(() =>
            driver.schedule("combo-scope", 10, "app.combo.scheduled", { due: true }),
          );
          expect(yield* promise(() => driver.nextDueAt("combo-scope"))).toBe(10);
          expect(yield* promise(() => driver.fireDue("combo-scope", 10))).toEqual({ fired: 1 });
          expect(yield* promise(() => driver.nextDueAt("combo-scope"))).toBe(retryAt);
          expect(yield* promise(() => driver.drainDispatchDue("combo-scope", retryAt!))).toEqual({
            delivered: 1,
            failed: 0,
          });
          expect(yield* promise(() => driver.pendingDueCount("combo-scope"))).toBe(0);
        }),
      ),
    );

    it.effect(
      "delivers dispatches and dedupes receiver inbound facts by source and idempotency key",
      () =>
        withDriver((driver) =>
          Effect.gen(function* () {
            yield* promise(() => driver.registerDispatchReceiver("receiver"));
            const spec = dispatchSpec(driver, "receiver", "same-key", "app.received", { value: 1 });

            yield* promise(() => driver.dispatchToScope("sender", spec));
            yield* promise(() => driver.dispatchToScope("sender", spec));

            const receiverEvents = yield* promise(() => driver.events("receiver"));
            expect(kindsOf(receiverEvents)).toEqual([
              DISPATCH_EVENT_KINDS.INBOUND_ACCEPTED,
              "app.received",
            ]);
            expect(receiverEvents[1]?.payload).toEqual({ value: 1 });

            const senderEvents = yield* promise(() => driver.events("sender"));
            expect(payloadsOf(senderEvents, DISPATCH_EVENT_KINDS.OUTBOUND_REQUESTED)).toHaveLength(
              2,
            );
            expect(payloadsOf(senderEvents, DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED)).toHaveLength(
              2,
            );
            expect(yield* promise(() => driver.pendingDueCount("sender"))).toBe(0);
          }),
        ),
    );

    it.effect("records retry attempts and later delivery after transient dispatch failure", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          let receiveAttempts = 0;
          yield* promise(() =>
            driver.registerDispatchReceiver("receiver", (_envelope, accept) => {
              receiveAttempts += 1;
              if (receiveAttempts === 1) return Promise.reject("transient");
              return accept();
            }),
          );

          const result = yield* promise(() =>
            driver.dispatchToScope(
              "sender",
              dispatchSpec(driver, "receiver", "retry-once", "app.retry", { value: 2 }),
            ),
          );
          const firstEvents = yield* promise(() => driver.events("sender"));
          const failed = payloadsOf<{
            readonly outboundEventId: number;
            readonly attempt: number;
            readonly terminal: boolean;
            readonly nextAttemptAt?: number;
          }>(firstEvents, DISPATCH_EVENT_KINDS.OUTBOUND_FAILED);
          expect(failed).toHaveLength(1);
          expect(failed[0]).toMatchObject({
            outboundEventId: result.outboundEventId,
            attempt: 1,
            terminal: false,
          });
          expect(typeof failed[0]?.nextAttemptAt).toBe("number");
          expect(yield* promise(() => driver.nextDueAt("sender"))).toBe(failed[0]?.nextAttemptAt);

          expect(
            yield* promise(() => driver.drainDispatchDue("sender", failed[0]!.nextAttemptAt!)),
          ).toEqual({
            delivered: 1,
            failed: 0,
          });

          const senderEvents = yield* promise(() => driver.events("sender"));
          const delivered = payloadsOf<{
            readonly outboundEventId: number;
            readonly attempt: number;
          }>(senderEvents, DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED);
          expect(delivered).toHaveLength(1);
          expect(delivered[0]).toMatchObject({
            outboundEventId: result.outboundEventId,
            attempt: 2,
          });
          expect(receiveAttempts).toBe(2);
          expect(yield* promise(() => driver.pendingDueCount("sender"))).toBe(0);
        }),
      ),
    );

    it.effect("drains Queue, HTTP, and provider target adapters through delivery receipts", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const targets = [
            { label: "queue", targetScope: "image-queue", event: "image.job.queued" },
            { label: "http", targetScope: "image-http", event: "image.provider.invoked" },
            { label: "provider", targetScope: "image-provider", event: "image.provider.done" },
          ] as const;

          for (const target of targets) {
            let attempts = 0;
            yield* promise(() =>
              driver.setDispatchTargetAdapter((envelope) => {
                attempts += 1;
                if (attempts === 1) return Promise.reject(`${target.label} unavailable`);
                return Promise.resolve({
                  receipt: {
                    anchorId: `${target.label}:image-gen:${envelope.idempotencyKey}`,
                    anchorKind: "external_receipt",
                  },
                });
              }),
            );

            const sourceScope = `external-sender-${target.label}`;
            const idempotencyKey = `${target.label}-adapter`;
            const result = yield* promise(() =>
              driver.dispatchToScope(
                sourceScope,
                dispatchSpec(driver, target.targetScope, idempotencyKey, target.event, {
                  prompt: "test",
                }),
              ),
            );
            const firstEvents = yield* promise(() => driver.events(sourceScope));
            const failed = payloadsOf<{
              readonly outboundEventId: number;
              readonly attempt: number;
              readonly terminal: boolean;
              readonly nextAttemptAt?: number;
            }>(firstEvents, DISPATCH_EVENT_KINDS.OUTBOUND_FAILED);
            expect(failed).toHaveLength(1);
            expect(failed[0]).toMatchObject({
              outboundEventId: result.outboundEventId,
              attempt: 1,
              terminal: false,
            });
            expect(typeof failed[0]?.nextAttemptAt).toBe("number");

            expect(
              yield* promise(() => driver.drainDispatchDue(sourceScope, failed[0]!.nextAttemptAt!)),
            ).toEqual({
              delivered: 1,
              failed: 0,
            });

            const senderEvents = yield* promise(() => driver.events(sourceScope));
            const delivered = payloadsOf<{
              readonly outboundEventId: number;
              readonly deliveryReceipt: unknown;
              readonly deliveredEventId?: unknown;
              readonly attempt: number;
              readonly claim?: { readonly anchorRef?: unknown };
            }>(senderEvents, DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED);
            expect(delivered).toHaveLength(1);
            expect(delivered[0]).toMatchObject({
              outboundEventId: result.outboundEventId,
              deliveryReceipt: {
                anchorId: `${target.label}:image-gen:${idempotencyKey}`,
                anchorKind: "external_receipt",
              },
              attempt: 2,
            });
            expect(delivered[0]).not.toHaveProperty("deliveredEventId");
            expect(delivered[0]?.claim?.anchorRef).toMatchObject({
              anchorKind: "external_receipt",
            });
            expect(yield* promise(() => driver.events(target.targetScope))).toEqual([]);
            expect(yield* promise(() => driver.pendingDueCount(sourceScope))).toBe(0);
            expect(attempts).toBe(2);
          }
        }),
      ),
    );

    it.effect("marks dispatch terminal failure at the shared attempt cap", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          yield* promise(() =>
            driver.registerDispatchReceiver("receiver", () => Promise.reject("permanent")),
          );

          yield* promise(() =>
            driver.dispatchToScope(
              "sender",
              dispatchSpec(driver, "receiver", "terminal", "app.never", { value: 3 }),
            ),
          );

          for (let i = 0; i < DISPATCH_MAX_ATTEMPTS + 2; i += 1) {
            const next = yield* promise(() => driver.nextDueAt("sender"));
            if (next === null) break;
            yield* promise(() => driver.drainDispatchDue("sender", next));
          }

          const senderEvents = yield* promise(() => driver.events("sender"));
          const failed = payloadsOf<{
            readonly attempt: number;
            readonly terminal: boolean;
            readonly nextAttemptAt?: number;
          }>(senderEvents, DISPATCH_EVENT_KINDS.OUTBOUND_FAILED);
          expect(failed).toHaveLength(DISPATCH_MAX_ATTEMPTS);
          expect(failed.at(-1)).toMatchObject({
            attempt: DISPATCH_MAX_ATTEMPTS,
            terminal: true,
          });
          expect(failed.at(-1)?.nextAttemptAt).toBeUndefined();
          expect(yield* promise(() => driver.pendingDueCount("sender"))).toBe(0);
        }),
      ),
    );

    it.effect("uses the shared dispatch backoff schedule", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          let receiveAttempts = 0;
          yield* promise(() =>
            driver.registerDispatchReceiver("receiver", () => {
              receiveAttempts += 1;
              return Promise.reject("retry schedule");
            }),
          );

          yield* promise(() =>
            driver.dispatchToScope(
              "sender",
              dispatchSpec(driver, "receiver", "backoff", "app.backoff", { value: 4 }),
            ),
          );
          let senderEvents = yield* promise(() => driver.events("sender"));
          const first = payloadsOf<{ readonly nextAttemptAt?: number }>(
            senderEvents,
            DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
          )[0];
          expect(typeof first?.nextAttemptAt).toBe("number");

          yield* promise(() => driver.drainDispatchDue("sender", first!.nextAttemptAt!));
          senderEvents = yield* promise(() => driver.events("sender"));
          const failures = payloadsOf<{
            readonly attempt: number;
            readonly nextAttemptAt?: number;
          }>(senderEvents, DISPATCH_EVENT_KINDS.OUTBOUND_FAILED);
          expect(failures[0]?.nextAttemptAt).toBeDefined();
          expect(failures[1]?.nextAttemptAt).toBe(
            failures[0]!.nextAttemptAt! + dispatchBackoffMs(2),
          );
          expect(receiveAttempts).toBe(2);
        }),
      ),
    );

    it.effect("absorbs failing event handlers without dropping facts or later handlers", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const calls: string[] = [];
          driver.addHandler("app.handled", () => {
            calls.push("rejecting");
            return Promise.reject("handler failed");
          });
          driver.addHandler("app.handled", () => {
            calls.push("after");
          });

          yield* promise(() => driver.log("handler-scope", "app.handled", { ok: true }));

          expect(calls).toEqual(["rejecting", "after"]);
          const events = yield* promise(() => driver.events("handler-scope"));
          expect(kindsOf(events)).toEqual(["app.handled"]);
        }),
      ),
    );

    it.effect("keeps resource reservation semantics identical", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          expect(
            yield* promise(() =>
              driver.grantResource("resource-scope", { key: "credit", amount: 5, ref: "seed" }),
            ),
          ).toMatchObject({ eventId: expect.any(Number) });

          const first = yield* promise(() =>
            driver.reserveResource("resource-scope", {
              key: "credit",
              amount: 2,
              ref: "req-1",
              idempotencyKey: "reserve-1",
            }),
          );
          const second = yield* promise(() =>
            driver.reserveResource("resource-scope", {
              key: "credit",
              amount: 2,
              ref: "req-1-retry",
              idempotencyKey: "reserve-1",
            }),
          );
          expect(second.reservationId).toBe(first.reservationId);
          expect(yield* promise(() => driver.projectResource("resource-scope", "credit"))).toEqual({
            available: 3,
            reserved: 2,
            consumed: 0,
          });

          yield* expectRejectTagEffect(
            driver.reserveResource("resource-scope", {
              key: "credit",
              amount: 10,
              ref: "too-large",
              idempotencyKey: "reserve-too-large",
            }),
            "agent_os.resource_insufficient",
          );
          const events = yield* promise(() => driver.events("resource-scope"));
          expect(kindsOf(events)).toEqual([
            "resource.granted",
            "resource.reserved",
            "resource.reserve_rejected",
          ]);
        }),
      ),
    );

    it.effect("keeps quota grant, rate-limit, and malformed-fact semantics identical", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          expect(
            yield* promise(() =>
              driver.quotaTryGrant("quota-scope", "tool-a", 1, 60_000, 1, "tool-a"),
            ),
          ).toMatchObject({ granted: true, consumed: 0, limit: 1 });
          expect(
            yield* promise(() =>
              driver.quotaTryGrant("quota-scope", "tool-a", 1, 60_000, 1, "tool-a"),
            ),
          ).toMatchObject({ granted: false, consumed: 1, limit: 1 });
          yield* promise(() =>
            driver.log("quota-scope", "dispatch.consumed", {
              key: "tool-a",
              amount: "x",
              toolName: "tool-a",
            }),
          );

          yield* expectRejectTagEffect(
            driver.quotaTryGrant(
              "quota-scope",
              "tool-a",
              1,
              Number.POSITIVE_INFINITY,
              10,
              "tool-a",
            ),
            "agent_os.sql_error",
          );

          const events = yield* promise(() => driver.events("quota-scope"));
          expect(kindsOf(events)).toEqual([
            "dispatch.consumed",
            "dispatch.rate_limited",
            "dispatch.consumed",
          ]);
        }),
      ),
    );
  });
};
