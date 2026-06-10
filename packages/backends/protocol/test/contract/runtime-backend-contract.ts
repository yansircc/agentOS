import type {
  LedgerEvent,
  ResourceGrantResult,
  ResourceGrantSpec,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
} from "@agent-os/kernel/types";
import type { TelemetryFanoutDiagnostic, TraceContext } from "@agent-os/telemetry-protocol";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  DISPATCH_EVENT_KINDS,
  DISPATCH_MAX_ATTEMPTS,
  backendProtocolProjectionKey,
  backendProtocolTruthIdentityKey,
  dispatchBackoffMs,
  dispatchExternalEnqueueAcknowledgement,
  type BackendProtocolDispatchTarget,
  type BackendProtocolEventIdentity,
  type BackendProtocolProjectionKey,
  type DispatchEnvelope,
  type DispatchReceiverResult,
  type DispatchTargetAdapter,
  type DispatchTargetResult,
  type GrantResult,
  type ResourceProjection,
} from "../../src";
import type { BindingMaterialRef } from "@agent-os/kernel/material-ref";
import type { FactOwnerRef } from "@agent-os/kernel/effect-claim";
import type { DispatchToScopeResult } from "@agent-os/kernel/types";

export type ContractDispatchReceiver = (
  envelope: DispatchEnvelope,
  accept: () => Promise<DispatchReceiverResult>,
) => Promise<DispatchReceiverResult>;

export type ContractDispatchTargetAdapter = (
  envelope: DispatchEnvelope,
) => Promise<DispatchTargetResult>;

export interface RuntimeBackendDispatchSpec {
  readonly target: BackendProtocolDispatchTarget;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly traceContext?: TraceContext;
}

export interface RuntimeBackendContractDriver {
  readonly bindingRef: BindingMaterialRef;
  readonly registerDispatchReceiver: (
    identity: BackendProtocolEventIdentity,
    receiver?: ContractDispatchReceiver,
  ) => void | Promise<void>;
  readonly setDispatchTargetAdapter: (
    adapter: DispatchTargetAdapter | ContractDispatchTargetAdapter,
  ) => void | Promise<void>;
  readonly addHandler: (
    kind: string,
    handler: (event: LedgerEvent) => void | Promise<void>,
  ) => { readonly unsubscribe: () => void } | void;
  readonly addSink: (
    identity: BackendProtocolEventIdentity,
    kind: string,
    sink: (event: LedgerEvent) => void,
  ) => { readonly unsubscribe: () => void } | void | Promise<{ readonly unsubscribe: () => void }>;
  readonly telemetryDiagnostics: () =>
    | ReadonlyArray<TelemetryFanoutDiagnostic>
    | Promise<ReadonlyArray<TelemetryFanoutDiagnostic>>;
  readonly log: (
    identity: BackendProtocolEventIdentity,
    kind: string,
    payload: unknown,
  ) => Promise<LedgerEvent>;
  readonly events: (identity: BackendProtocolEventIdentity) => Promise<ReadonlyArray<LedgerEvent>>;
  readonly schedule: (
    identity: BackendProtocolEventIdentity,
    at: number,
    eventKind: string,
    data: unknown,
  ) => Promise<{ readonly id: number }>;
  readonly fireDue: (
    identity: BackendProtocolEventIdentity,
    now: number,
  ) => Promise<{ readonly fired: number }>;
  readonly dispatchToScope: (
    sourceIdentity: BackendProtocolEventIdentity,
    spec: RuntimeBackendDispatchSpec,
  ) => Promise<DispatchToScopeResult>;
  readonly drainDispatchDue: (
    identity: BackendProtocolEventIdentity,
    now: number,
  ) => Promise<{ readonly delivered: number; readonly failed: number }>;
  readonly nextDueAt: (identity: BackendProtocolEventIdentity) => Promise<number | null>;
  readonly pendingDueCount: (identity: BackendProtocolEventIdentity) => Promise<number>;
  readonly grantResource: (
    identity: BackendProtocolEventIdentity,
    spec: ResourceGrantSpec,
  ) => Promise<ResourceGrantResult>;
  readonly reserveResource: (
    identity: BackendProtocolEventIdentity,
    spec: ResourceReserveSpec,
  ) => Promise<ResourceReserveResult>;
  readonly consumeResource: (
    identity: BackendProtocolEventIdentity,
    spec: ResourceReservationSpec,
  ) => Promise<void>;
  readonly releaseResource: (
    identity: BackendProtocolEventIdentity,
    spec: ResourceReservationSpec,
  ) => Promise<void>;
  readonly projectResource: (key: BackendProtocolProjectionKey) => Promise<ResourceProjection>;
  readonly quotaTryGrant: (
    identity: BackendProtocolEventIdentity,
    key: BackendProtocolProjectionKey,
    amount: number,
    windowMs: number,
    limit: number,
    toolName: string,
    operationRef: string,
  ) => Promise<GrantResult>;
  readonly dispose: () => Promise<void>;
}

export type RuntimeBackendContractDriverFactory = () =>
  | RuntimeBackendContractDriver
  | Promise<RuntimeBackendContractDriver>;

export interface RuntimeBackendContractSuiteOptions {
  readonly runtimeFactOwner: FactOwnerRef;
}

const contractEventIdentity = (
  scopeId: string,
  factOwnerRef: FactOwnerRef,
): BackendProtocolEventIdentity => ({
  scopeRef: { kind: "conversation", scopeId },
  effectAuthorityRef: { authorityClass: "effect", authorityId: scopeId },
  factOwnerRef,
});

const projectionKey = (
  identity: BackendProtocolEventIdentity,
  projectionKind: string,
  projectionId: string,
): BackendProtocolProjectionKey => ({
  ...identity,
  projectionKind,
  projectionId,
});

const targetFor = (
  driver: RuntimeBackendContractDriver,
  scopeId: string,
): RuntimeBackendDispatchSpec["target"] => ({
  bindingRef: driver.bindingRef,
  scopeRef: { kind: "conversation", scopeId },
  effectAuthorityRef: { authorityClass: "effect", authorityId: scopeId },
});

const dispatchSpec = (
  driver: RuntimeBackendContractDriver,
  targetScope: string,
  idempotencyKey: string,
  event = "app.received",
  data: unknown = { value: 1 },
): RuntimeBackendDispatchSpec => ({
  target: targetFor(driver, targetScope),
  event,
  data,
  idempotencyKey,
});

const payloadsOf = <T>(events: ReadonlyArray<LedgerEvent>, kind: string): ReadonlyArray<T> =>
  events.filter((event) => event.kind === kind).map((event) => event.payload as T);

const kindsOf = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind);

const expectEventIdentity = (
  event: LedgerEvent | undefined,
  identity: BackendProtocolEventIdentity,
): void => {
  expect(event).toBeDefined();
  expect(event).toMatchObject({
    scopeRef: identity.scopeRef,
    effectAuthorityRef: identity.effectAuthorityRef,
    factOwnerRef: identity.factOwnerRef,
  });
  expect(event).not.toHaveProperty("scope");
};

const expectEventsIdentity = (
  events: ReadonlyArray<LedgerEvent>,
  identity: BackendProtocolEventIdentity,
): void => {
  for (const event of events) {
    expectEventIdentity(event, identity);
  }
};

const SCHEDULED_REQUESTED = "durable_trigger.scheduled.requested";

export const runRuntimeBackendContractSuite = (
  name: string,
  makeDriver: RuntimeBackendContractDriverFactory,
  options: RuntimeBackendContractSuiteOptions,
): void => {
  const contractIdentity = (scopeId: string): BackendProtocolEventIdentity =>
    contractEventIdentity(scopeId, options.runtimeFactOwner);

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
            driver.schedule(contractIdentity("schedule-scope"), 10, "app.scheduled", {
              job: "one",
            }),
          );

          expect(yield* promise(() => driver.nextDueAt(contractIdentity("schedule-scope")))).toBe(
            10,
          );
          expect(
            yield* promise(() => driver.fireDue(contractIdentity("schedule-scope"), 9)),
          ).toEqual({
            fired: 0,
          });
          expect(
            kindsOf(yield* promise(() => driver.events(contractIdentity("schedule-scope")))),
          ).toEqual([SCHEDULED_REQUESTED]);
          expect(
            yield* promise(() => driver.fireDue(contractIdentity("schedule-scope"), 10)),
          ).toEqual({
            fired: 1,
          });
          expect(
            yield* promise(() => driver.fireDue(contractIdentity("schedule-scope"), 10)),
          ).toEqual({
            fired: 0,
          });

          const scheduleIdentity = contractIdentity("schedule-scope");
          const events = yield* promise(() => driver.events(scheduleIdentity));
          expect(kindsOf(events)).toEqual([SCHEDULED_REQUESTED, "app.scheduled"]);
          expectEventsIdentity(events, scheduleIdentity);
          expect(events[1]?.payload).toEqual({ job: "one" });
          expect(
            yield* promise(() => driver.pendingDueCount(contractIdentity("schedule-scope"))),
          ).toBe(0);
        }),
      ),
    );

    it.effect("drains scheduler and delivery retry work from one due-work queue", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          let receiveAttempts = 0;
          yield* promise(() =>
            driver.registerDispatchReceiver(contractIdentity("receiver"), (_envelope, accept) => {
              receiveAttempts += 1;
              if (receiveAttempts === 1) return Promise.reject("transient");
              return accept();
            }),
          );

          yield* promise(() =>
            driver.dispatchToScope(
              contractIdentity("combo-scope"),
              dispatchSpec(driver, "receiver", "combo-retry", "app.combo", { retry: true }),
            ),
          );
          const retryAt = yield* promise(() => driver.nextDueAt(contractIdentity("combo-scope")));
          expect(typeof retryAt).toBe("number");

          yield* promise(() =>
            driver.schedule(contractIdentity("combo-scope"), 10, "app.combo.scheduled", {
              due: true,
            }),
          );
          expect(yield* promise(() => driver.nextDueAt(contractIdentity("combo-scope")))).toBe(10);
          expect(yield* promise(() => driver.fireDue(contractIdentity("combo-scope"), 10))).toEqual(
            {
              fired: 1,
            },
          );
          expect(yield* promise(() => driver.nextDueAt(contractIdentity("combo-scope")))).toBe(
            retryAt,
          );
          expect(
            yield* promise(() =>
              driver.drainDispatchDue(contractIdentity("combo-scope"), retryAt!),
            ),
          ).toEqual({
            delivered: 1,
            failed: 0,
          });
          expect(
            yield* promise(() => driver.pendingDueCount(contractIdentity("combo-scope"))),
          ).toBe(0);
        }),
      ),
    );

    it.effect(
      "delivers dispatches and dedupes receiver inbound facts by source and idempotency key",
      () =>
        withDriver((driver) =>
          Effect.gen(function* () {
            yield* promise(() => driver.registerDispatchReceiver(contractIdentity("receiver")));
            const spec = dispatchSpec(driver, "receiver", "same-key", "app.received", { value: 1 });

            yield* promise(() => driver.dispatchToScope(contractIdentity("sender"), spec));
            yield* promise(() => driver.dispatchToScope(contractIdentity("sender"), spec));

            const receiverIdentity = contractIdentity("receiver");
            const receiverEvents = yield* promise(() => driver.events(receiverIdentity));
            expect(kindsOf(receiverEvents)).toEqual([
              DISPATCH_EVENT_KINDS.INBOUND_ACCEPTED,
              "app.received",
            ]);
            expectEventsIdentity(receiverEvents, receiverIdentity);
            expect(receiverEvents[1]?.payload).toEqual({ value: 1 });

            const senderIdentity = contractIdentity("sender");
            const senderEvents = yield* promise(() => driver.events(senderIdentity));
            expectEventsIdentity(senderEvents, senderIdentity);
            expect(payloadsOf(senderEvents, DISPATCH_EVENT_KINDS.OUTBOUND_REQUESTED)).toHaveLength(
              2,
            );
            expect(payloadsOf(senderEvents, DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED)).toHaveLength(
              2,
            );
            expect(yield* promise(() => driver.pendingDueCount(contractIdentity("sender")))).toBe(
              0,
            );
          }),
        ),
    );

    it.effect("rejects malformed trace context before dispatch propagation", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          yield* promise(() => driver.registerDispatchReceiver(contractIdentity("receiver")));
          yield* expectRejectTagEffect(
            driver.dispatchToScope(contractIdentity("sender"), {
              ...dispatchSpec(driver, "receiver", "bad-trace", "app.received", { value: 1 }),
              traceContext: {
                traceparent: "00-test",
              },
            }),
            "agent_os.invalid_trace_context",
          );

          expect(yield* promise(() => driver.events(contractIdentity("sender")))).toEqual([]);
          expect(yield* promise(() => driver.events(contractIdentity("receiver")))).toEqual([]);
        }),
      ),
    );

    it.effect("records retry attempts and later delivery after transient dispatch failure", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          let receiveAttempts = 0;
          yield* promise(() =>
            driver.registerDispatchReceiver(contractIdentity("receiver"), (_envelope, accept) => {
              receiveAttempts += 1;
              if (receiveAttempts === 1) return Promise.reject("transient");
              return accept();
            }),
          );

          const result = yield* promise(() =>
            driver.dispatchToScope(
              contractIdentity("sender"),
              dispatchSpec(driver, "receiver", "retry-once", "app.retry", { value: 2 }),
            ),
          );
          const firstEvents = yield* promise(() => driver.events(contractIdentity("sender")));
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
          expect(yield* promise(() => driver.nextDueAt(contractIdentity("sender")))).toBe(
            failed[0]?.nextAttemptAt,
          );

          expect(
            yield* promise(() =>
              driver.drainDispatchDue(contractIdentity("sender"), failed[0]!.nextAttemptAt!),
            ),
          ).toEqual({
            delivered: 1,
            failed: 0,
          });

          const senderIdentity = contractIdentity("sender");
          const senderEvents = yield* promise(() => driver.events(senderIdentity));
          expectEventsIdentity(senderEvents, senderIdentity);
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
          expect(yield* promise(() => driver.pendingDueCount(contractIdentity("sender")))).toBe(0);
        }),
      ),
    );

    it.effect(
      "drains Queue, HTTP, and provider target adapters through enqueue acknowledgements",
      () =>
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
                    _tag: "enqueued",
                    acknowledgement: dispatchExternalEnqueueAcknowledgement({
                      targetKind: target.label,
                      targetScope: envelope.targetScope,
                      idempotencyKey: envelope.idempotencyKey,
                    }),
                  });
                }),
              );

              const sourceScope = `external-sender-${target.label}`;
              const idempotencyKey = `${target.label}-adapter`;
              const result = yield* promise(() =>
                driver.dispatchToScope(
                  contractIdentity(sourceScope),
                  dispatchSpec(driver, target.targetScope, idempotencyKey, target.event, {
                    prompt: "test",
                  }),
                ),
              );
              const firstEvents = yield* promise(() =>
                driver.events(contractIdentity(sourceScope)),
              );
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
                yield* promise(() =>
                  driver.drainDispatchDue(contractIdentity(sourceScope), failed[0]!.nextAttemptAt!),
                ),
              ).toEqual({
                delivered: 0,
                failed: 0,
              });

              const sourceIdentity = contractIdentity(sourceScope);
              const senderEvents = yield* promise(() => driver.events(sourceIdentity));
              expectEventsIdentity(senderEvents, sourceIdentity);
              const delivered = payloadsOf<{
                readonly outboundEventId: number;
                readonly attempt: number;
              }>(senderEvents, DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED);
              expect(delivered).toHaveLength(0);
              const enqueued = payloadsOf<{
                readonly outboundEventId: number;
                readonly enqueueAcknowledgement: unknown;
                readonly deliveryReceipt?: unknown;
                readonly claim?: unknown;
                readonly attempt: number;
              }>(senderEvents, DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED);
              expect(enqueued).toHaveLength(1);
              expect(enqueued[0]).toMatchObject({
                outboundEventId: result.outboundEventId,
                enqueueAcknowledgement: {
                  acknowledgementId: expect.stringMatching(
                    `^dispatch\\.${target.label}\\.enqueued:.*:${idempotencyKey}$`,
                  ),
                  acknowledgementKind: "external_enqueue",
                },
                attempt: 2,
              });
              expect(enqueued[0]).not.toHaveProperty("deliveryReceipt");
              expect(enqueued[0]).not.toHaveProperty("claim");
              expect(
                yield* promise(() => driver.events(contractIdentity(target.targetScope))),
              ).toEqual([]);
              expect(
                yield* promise(() => driver.pendingDueCount(contractIdentity(sourceScope))),
              ).toBe(0);
              expect(attempts).toBe(2);
            }
          }),
        ),
    );

    it.effect("marks dispatch terminal failure at the shared attempt cap", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          yield* promise(() =>
            driver.registerDispatchReceiver(contractIdentity("receiver"), () =>
              Promise.reject("permanent"),
            ),
          );

          yield* promise(() =>
            driver.dispatchToScope(
              contractIdentity("sender"),
              dispatchSpec(driver, "receiver", "terminal", "app.never", { value: 3 }),
            ),
          );

          for (let i = 0; i < DISPATCH_MAX_ATTEMPTS + 2; i += 1) {
            const next = yield* promise(() => driver.nextDueAt(contractIdentity("sender")));
            if (next === null) break;
            yield* promise(() => driver.drainDispatchDue(contractIdentity("sender"), next));
          }

          const senderIdentity = contractIdentity("sender");
          const senderEvents = yield* promise(() => driver.events(senderIdentity));
          expectEventsIdentity(senderEvents, senderIdentity);
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
          expect(yield* promise(() => driver.pendingDueCount(contractIdentity("sender")))).toBe(0);
        }),
      ),
    );

    it.effect("uses the shared dispatch backoff schedule", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          let receiveAttempts = 0;
          yield* promise(() =>
            driver.registerDispatchReceiver(contractIdentity("receiver"), () => {
              receiveAttempts += 1;
              return Promise.reject("retry schedule");
            }),
          );

          yield* promise(() =>
            driver.dispatchToScope(
              contractIdentity("sender"),
              dispatchSpec(driver, "receiver", "backoff", "app.backoff", { value: 4 }),
            ),
          );
          let senderEvents = yield* promise(() => driver.events(contractIdentity("sender")));
          const first = payloadsOf<{ readonly nextAttemptAt?: number }>(
            senderEvents,
            DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
          )[0];
          expect(typeof first?.nextAttemptAt).toBe("number");

          yield* promise(() =>
            driver.drainDispatchDue(contractIdentity("sender"), first!.nextAttemptAt!),
          );
          senderEvents = yield* promise(() => driver.events(contractIdentity("sender")));
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

          yield* promise(() =>
            driver.log(contractIdentity("handler-scope"), "app.handled", { ok: true }),
          );

          expect(calls).toEqual(["rejecting", "after"]);
          const handlerIdentity = contractIdentity("handler-scope");
          const events = yield* promise(() => driver.events(handlerIdentity));
          expect(kindsOf(events)).toEqual(["app.handled"]);
          expectEventsIdentity(events, handlerIdentity);
        }),
      ),
    );

    it.effect("treats stream sink failure as post-commit diagnostics", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const calls: number[] = [];
          yield* promise(() =>
            driver.addSink(contractIdentity("sink-scope"), "app.sink", (event) => {
              calls.push(event.id);
              throw new Error("sink failed after commit");
            }),
          );

          const event = yield* promise(() =>
            driver.log(contractIdentity("sink-scope"), "app.sink", { committed: true }),
          );

          expect(calls).toEqual([event.id]);
          expect(yield* promise(() => driver.events(contractIdentity("sink-scope")))).toEqual([
            event,
          ]);

          const diagnostics = yield* promise(() => driver.telemetryDiagnostics());
          expect(
            diagnostics.some(
              (entry) =>
                entry.phase === "sink" &&
                entry.eventId === event.id &&
                entry.kind === "app.sink" &&
                entry.identityKey ===
                  backendProtocolTruthIdentityKey(contractIdentity("sink-scope")) &&
                entry.message.includes("sink failed after commit"),
            ),
          ).toBe(true);
        }),
      ),
    );

    it.effect("keeps resource reservation semantics identical", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const resourceIdentity = contractIdentity("resource-scope");
          const creditProjection = projectionKey(resourceIdentity, "resource", "credit");
          expect(backendProtocolProjectionKey(creditProjection)).not.toBe(
            backendProtocolProjectionKey({
              ...creditProjection,
              effectAuthorityRef: { authorityClass: "effect", authorityId: "resource-other" },
            }),
          );

          expect(
            yield* promise(() =>
              driver.grantResource(resourceIdentity, {
                key: "credit",
                amount: 5,
                ref: "seed",
              }),
            ),
          ).toMatchObject({ eventId: expect.any(Number) });

          const first = yield* promise(() =>
            driver.reserveResource(resourceIdentity, {
              key: "credit",
              amount: 2,
              ref: "req-1",
              idempotencyKey: "reserve-1",
            }),
          );
          const second = yield* promise(() =>
            driver.reserveResource(resourceIdentity, {
              key: "credit",
              amount: 2,
              ref: "req-1-retry",
              idempotencyKey: "reserve-1",
            }),
          );
          expect(second.reservationId).toBe(first.reservationId);
          expect(yield* promise(() => driver.projectResource(creditProjection))).toEqual({
            available: 3,
            reserved: 2,
            consumed: 0,
          });

          yield* expectRejectTagEffect(
            driver.reserveResource(resourceIdentity, {
              key: "credit",
              amount: 10,
              ref: "too-large",
              idempotencyKey: "reserve-too-large",
            }),
            "agent_os.resource_insufficient",
          );
          const events = yield* promise(() => driver.events(resourceIdentity));
          expectEventsIdentity(events, resourceIdentity);
          expect(kindsOf(events)).toEqual([
            "resource_pool.granted",
            "resource_pool.reserved",
            "resource_pool.reserve_rejected",
          ]);
        }),
      ),
    );

    it.effect("keeps quota grant, rate-limit, and malformed-fact semantics identical", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const quotaIdentity = contractIdentity("quota-scope");
          const toolAProjection = projectionKey(quotaIdentity, "quota", "tool-a");
          expect(backendProtocolProjectionKey(toolAProjection)).not.toBe(
            backendProtocolProjectionKey({ ...toolAProjection, projectionId: "tool-b" }),
          );

          expect(
            yield* promise(() =>
              driver.quotaTryGrant(quotaIdentity, toolAProjection, 1, 60_000, 1, "tool-a", "op-1"),
            ),
          ).toMatchObject({ granted: true, consumed: 0, limit: 1 });
          expect(
            yield* promise(() =>
              driver.quotaTryGrant(quotaIdentity, toolAProjection, 1, 60_000, 1, "tool-a", "op-2"),
            ),
          ).toMatchObject({ granted: false, consumed: 1, limit: 1 });
          yield* promise(() =>
            driver.log(quotaIdentity, "quota.consumed", {
              key: "tool-a",
              amount: "x",
              toolName: "tool-a",
              operationRef: "bad-op",
            }),
          );

          yield* expectRejectTagEffect(
            driver.quotaTryGrant(
              quotaIdentity,
              toolAProjection,
              1,
              Number.POSITIVE_INFINITY,
              10,
              "tool-a",
              "op-3",
            ),
            "agent_os.sql_error",
          );

          const events = yield* promise(() => driver.events(quotaIdentity));
          expectEventsIdentity(events, quotaIdentity);
          expect(kindsOf(events)).toEqual([
            "quota.consumed",
            "quota.rate_limited",
            "quota.consumed",
          ]);
        }),
      ),
    );

    it.effect("claims one due dispatch retry across concurrent drainers", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const senderIdentity = contractIdentity("concurrent-sender");
          const receiverIdentity = contractIdentity("concurrent-receiver");
          let receiveAttempts = 0;
          let releaseRetry: (() => void) | undefined;
          let retryStartedResolve: (() => void) | undefined;
          const retryStarted = new Promise<void>((resolve) => {
            retryStartedResolve = resolve;
          });
          const waitForRetryStarted = (): Promise<void> =>
            new Promise((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error("concurrent retry drain never reached receiver")),
                1_000,
              );
              retryStarted.then(
                () => {
                  clearTimeout(timeout);
                  resolve();
                },
                (cause) => {
                  clearTimeout(timeout);
                  reject(cause);
                },
              );
            });

          yield* promise(() =>
            driver.registerDispatchReceiver(receiverIdentity, (_envelope, accept) => {
              receiveAttempts += 1;
              if (receiveAttempts === 1) return Promise.reject("retry once");
              retryStartedResolve?.();
              return new Promise<void>((resolve) => {
                releaseRetry = resolve;
              }).then(() => accept());
            }),
          );

          yield* promise(() =>
            driver.dispatchToScope(
              senderIdentity,
              dispatchSpec(driver, "concurrent-receiver", "concurrent-claim", "app.concurrent", {
                value: 5,
              }),
            ),
          );
          const firstEvents = yield* promise(() => driver.events(senderIdentity));
          const failed = payloadsOf<{ readonly nextAttemptAt?: number }>(
            firstEvents,
            DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
          );
          expect(failed).toHaveLength(1);
          expect(typeof failed[0]?.nextAttemptAt).toBe("number");

          const concurrentDrains = Array.from({ length: 8 }, () =>
            driver.drainDispatchDue(senderIdentity, failed[0]!.nextAttemptAt!),
          );
          yield* promise(waitForRetryStarted);
          releaseRetry?.();
          const results = yield* promise(() => Promise.all(concurrentDrains));

          expect(results.reduce((sum, result) => sum + result.delivered, 0)).toBe(1);
          expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
          expect(
            results.filter((result) => result.delivered === 0 && result.failed === 0),
          ).toHaveLength(results.length - 1);
          expect(receiveAttempts).toBe(2);

          const senderEvents = yield* promise(() => driver.events(senderIdentity));
          const delivered = payloadsOf<{ readonly attempt: number }>(
            senderEvents,
            DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED,
          );
          expect(delivered).toHaveLength(1);
          expect(delivered[0]).toMatchObject({ attempt: 2 });
          expect(yield* promise(() => driver.pendingDueCount(senderIdentity))).toBe(0);
        }),
      ),
    );
  });
};
