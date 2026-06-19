import type {
  EventQueryOptions,
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
import { makeOperationRef, makePreClaim, type FactOwnerRef } from "@agent-os/kernel/effect-claim";
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

export type RuntimeBackendLedgerCommitSpec = {
  readonly ts?: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly scopeRef: BackendProtocolEventIdentity["scopeRef"];
  readonly effectAuthorityRef: BackendProtocolEventIdentity["effectAuthorityRef"];
  readonly factOwnerRef?: never;
  readonly scope?: never;
};

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
  readonly commit: (
    events: ReadonlyArray<RuntimeBackendLedgerCommitSpec>,
  ) => Promise<ReadonlyArray<LedgerEvent>>;
  readonly events: (
    identity: BackendProtocolEventIdentity,
    opts?: EventQueryOptions,
  ) => Promise<ReadonlyArray<LedgerEvent>>;
  readonly streamSnapshot: (
    identity: BackendProtocolEventIdentity,
    opts?: Pick<EventQueryOptions, "afterId" | "kinds" | "factOwnerRefs">,
  ) => Promise<ReadonlyArray<LedgerEvent>>;
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
  readonly receive: (
    targetIdentity: BackendProtocolEventIdentity,
    envelope: DispatchEnvelope,
  ) => Promise<DispatchReceiverResult>;
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
  readonly storageErrorTag?: string;
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

const dispatchEnvelope = (
  sourceIdentity: BackendProtocolEventIdentity,
  targetIdentity: BackendProtocolEventIdentity,
  outboundEventId: number,
  idempotencyKey: string,
  event = "app.received",
  data: unknown = { value: 1 },
): DispatchEnvelope => {
  const sourceScope = backendProtocolTruthIdentityKey(sourceIdentity);
  const targetScope = backendProtocolTruthIdentityKey(targetIdentity);
  return {
    sourceScope,
    outboundEventId,
    targetScope,
    event,
    data,
    idempotencyKey,
    claim: makePreClaim({
      operationRef: makeOperationRef("dispatch", [sourceScope, targetScope, idempotencyKey]),
      scopeRef: targetIdentity.scopeRef,
      effectAuthorityRef: {
        authorityId: "cap_dispatch",
        authorityClass: "effect",
      },
      originRef: {
        originId: sourceScope,
        originKind: "agent_do",
      },
    }),
  };
};

const payloadsOf = <T>(events: ReadonlyArray<LedgerEvent>, kind: string): ReadonlyArray<T> =>
  events.filter((event) => event.kind === kind).map((event) => event.payload as T);

const kindsOf = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind);

const ledgerSpec = (
  identity: BackendProtocolEventIdentity,
  kind: string,
  payload: unknown = {},
  ts?: number,
): RuntimeBackendLedgerCommitSpec => {
  const spec = {
    kind,
    payload,
    scopeRef: identity.scopeRef,
    effectAuthorityRef: identity.effectAuthorityRef,
  };
  return ts === undefined ? spec : { ...spec, ts };
};

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
  const storageErrorTag = options.storageErrorTag ?? "agent_os.runtime_storage_error";
  const contractIdentity = (scopeId: string): BackendProtocolEventIdentity =>
    contractEventIdentity(scopeId, options.runtimeFactOwner);

  const promise = <A>(thunk: () => Promise<A> | A): Effect.Effect<A> =>
    Effect.promise(() => Promise.resolve(thunk()));

  const expectRejectTagEffect = (input: Promise<unknown>, tag: string): Effect.Effect<void> =>
    promise(
      () =>
        expect(input).rejects.toMatchObject({
          _tag: tag,
        }) as Promise<void>,
    );

  const expectRejectEffect = (input: Promise<unknown>): Effect.Effect<void> =>
    promise(() => expect(input).rejects.toBeTruthy() as Promise<void>);

  const withDriver = (
    fn: (driver: RuntimeBackendContractDriver) => Effect.Effect<void>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const driver = yield* promise(() => makeDriver());
      yield* fn(driver).pipe(Effect.ensuring(promise(() => driver.dispose())));
    });

  describe(name + " runtime backend protocol contract", () => {
    it.effect("satisfies the ledger prefix law for cursor, limit, kind, and stream reads", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const identity = contractIdentity("ledger-prefix");
          const committed = yield* promise(() =>
            driver.commit([
              ledgerSpec(identity, "ledger_law.prefix.a", { n: 1 }),
              ledgerSpec(identity, "ledger_law.prefix.b", { n: 2 }),
              ledgerSpec(identity, "ledger_law.prefix.c", { n: 3 }),
            ]),
          );

          expect(kindsOf(committed)).toEqual([
            "ledger_law.prefix.a",
            "ledger_law.prefix.b",
            "ledger_law.prefix.c",
          ]);
          expectEventsIdentity(committed, identity);
          expect(yield* promise(() => driver.events(identity))).toEqual(committed);
          expect(yield* promise(() => driver.events(identity, { limit: 2 }))).toEqual(
            committed.slice(0, 2),
          );
          expect(
            yield* promise(() => driver.events(identity, { afterId: committed[0]!.id })),
          ).toEqual(committed.slice(1));
          expect(
            yield* promise(() => driver.events(identity, { kinds: ["ledger_law.prefix.c"] })),
          ).toEqual([committed[2]]);
          expect(
            yield* promise(() =>
              driver.streamSnapshot(identity, {
                afterId: committed[0]!.id,
                kinds: ["ledger_law.prefix.b", "ledger_law.prefix.c"],
                factOwnerRefs: [options.runtimeFactOwner],
              }),
            ),
          ).toEqual(committed.slice(1));
        }),
      ),
    );

    it.effect("satisfies the ledger batch atomicity law", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const identity = contractIdentity("ledger-batch-atomic");
          yield* expectRejectEffect(
            driver.commit([
              ledgerSpec(identity, "ledger_law.batch.before", { ok: true }),
              ledgerSpec(identity, "ledger_law.batch.invalid", { value: BigInt(1) }),
              ledgerSpec(identity, "ledger_law.batch.after", { ok: true }),
            ]),
          );
          expect(yield* promise(() => driver.events(identity))).toEqual([]);

          const committed = yield* promise(() =>
            driver.commit([
              ledgerSpec(identity, "ledger_law.batch.one", { ok: 1 }),
              ledgerSpec(identity, "ledger_law.batch.two", { ok: 2 }),
            ]),
          );
          expect(committed).toHaveLength(2);
          expect(committed[1]!.id).toBe(committed[0]!.id + 1);
          expect(yield* promise(() => driver.events(identity))).toEqual(committed);
        }),
      ),
    );

    it.effect("satisfies the ledger durable ack law", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const identity = contractIdentity("ledger-durable-ack");
          const committed = yield* promise(() =>
            driver.commit([
              ledgerSpec(identity, "ledger_law.ack", {
                nested: { ok: true },
                list: [1, 2, 3],
              }),
            ]),
          );
          const ack = committed[0];
          expect(ack).toBeDefined();
          expect(ack).toMatchObject({
            id: expect.any(Number),
            ts: expect.any(Number),
            kind: "ledger_law.ack",
            payload: { nested: { ok: true }, list: [1, 2, 3] },
          });
          expectEventIdentity(ack, identity);
          expect(
            yield* promise(() => driver.events(identity, { afterId: ack!.id - 1, limit: 1 })),
          ).toEqual([ack]);
        }),
      ),
    );

    it.effect("satisfies the ledger per-truth ordering law", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const alpha = contractIdentity("ledger-order-alpha");
          const beta = contractIdentity("ledger-order-beta");
          yield* promise(() =>
            driver.commit([
              ledgerSpec(alpha, "ledger_law.order.alpha.1", { value: "a1" }),
              ledgerSpec(alpha, "ledger_law.order.alpha.2", { value: "a2" }),
            ]),
          );
          yield* promise(() =>
            driver.commit([
              ledgerSpec(beta, "ledger_law.order.beta.1", { value: "b1" }),
              ledgerSpec(beta, "ledger_law.order.beta.2", { value: "b2" }),
            ]),
          );

          const alphaEvents = yield* promise(() => driver.events(alpha));
          const betaEvents = yield* promise(() => driver.events(beta));
          expect(kindsOf(alphaEvents)).toEqual([
            "ledger_law.order.alpha.1",
            "ledger_law.order.alpha.2",
          ]);
          expect(kindsOf(betaEvents)).toEqual([
            "ledger_law.order.beta.1",
            "ledger_law.order.beta.2",
          ]);
          expect(alphaEvents[0]!.id).toBeLessThan(alphaEvents[1]!.id);
          expect(betaEvents[0]!.id).toBeLessThan(betaEvents[1]!.id);
        }),
      ),
    );

    it.effect("satisfies the ledger owner integrity law", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const identity = contractIdentity("ledger-owner-integrity");
          const callerOwner = "@agent-os/caller-owned-test";
          const [event] = yield* promise(() =>
            driver.commit([
              {
                ...ledgerSpec(identity, "ledger_law.owner", { ok: true }),
                factOwnerRef: callerOwner,
              } as unknown as RuntimeBackendLedgerCommitSpec,
            ]),
          );

          expectEventIdentity(event, identity);
          expect(event?.factOwnerRef).toBe(options.runtimeFactOwner);
          expect(
            yield* promise(() => driver.events(identity, { factOwnerRefs: [callerOwner] })),
          ).toEqual([]);
          expect(
            yield* promise(() =>
              driver.events(identity, { factOwnerRefs: [options.runtimeFactOwner] }),
            ),
          ).toEqual([event]);
        }),
      ),
    );

    it.effect("satisfies the ledger idempotent append law for empty batches", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const identity = contractIdentity("ledger-idempotent-empty");
          expect(yield* promise(() => driver.commit([]))).toEqual([]);
          expect(yield* promise(() => driver.commit([]))).toEqual([]);
          expect(yield* promise(() => driver.events(identity))).toEqual([]);

          const first = yield* promise(() =>
            driver.commit([
              ledgerSpec(identity, "ledger_law.idempotent.non_empty", { attempt: 1 }),
            ]),
          );
          const second = yield* promise(() =>
            driver.commit([
              ledgerSpec(identity, "ledger_law.idempotent.non_empty", { attempt: 1 }),
            ]),
          );
          expect(first).toHaveLength(1);
          expect(second).toHaveLength(1);
          expect(second[0]!.id).toBeGreaterThan(first[0]!.id);
          expect(kindsOf(yield* promise(() => driver.events(identity)))).toEqual([
            "ledger_law.idempotent.non_empty",
            "ledger_law.idempotent.non_empty",
          ]);
        }),
      ),
    );

    it.effect("satisfies the ledger read-your-writes law", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const identity = contractIdentity("ledger-read-your-writes");
          const first = yield* promise(() =>
            driver.commit([ledgerSpec(identity, "ledger_law.read.first", { value: 1 })]),
          );
          expect(yield* promise(() => driver.events(identity))).toEqual(first);

          const second = yield* promise(() =>
            driver.commit([ledgerSpec(identity, "ledger_law.read.second", { value: 2 })]),
          );
          expect(yield* promise(() => driver.events(identity))).toEqual([...first, ...second]);
          expect(
            yield* promise(() => driver.streamSnapshot(identity, { afterId: first[0]!.id })),
          ).toEqual(second);
        }),
      ),
    );

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
            readonly claim?: unknown;
          }>(firstEvents, DISPATCH_EVENT_KINDS.OUTBOUND_FAILED);
          expect(failed).toHaveLength(1);
          expect(failed[0]).toMatchObject({
            outboundEventId: result.outboundEventId,
            attempt: 1,
            terminal: false,
            claim: {
              phase: "indeterminate",
              indeterminateRef: {
                indeterminateKind: "retry_pending",
                reason: "retry_pending",
              },
            },
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

          expect(
            yield* promise(() =>
              driver.drainDispatchDue(contractIdentity("sender"), failed[0]!.nextAttemptAt!),
            ),
          ).toEqual({
            delivered: 0,
            failed: 0,
          });
          const redrainedEvents = yield* promise(() => driver.events(senderIdentity));
          expect(payloadsOf(redrainedEvents, DISPATCH_EVENT_KINDS.OUTBOUND_FAILED)).toHaveLength(1);
          expect(payloadsOf(redrainedEvents, DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED)).toHaveLength(
            1,
          );
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
                readonly claim: unknown;
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
                claim: {
                  phase: "indeterminate",
                  indeterminateRef: {
                    indeterminateKind: "provider_pending",
                    reason: "provider_pending",
                  },
                },
              });
              expect(enqueued[0]).not.toHaveProperty("deliveryReceipt");
              expect(
                yield* promise(() =>
                  driver.drainDispatchDue(sourceIdentity, failed[0]!.nextAttemptAt!),
                ),
              ).toEqual({
                delivered: 0,
                failed: 0,
              });
              const redrainedEvents = yield* promise(() => driver.events(sourceIdentity));
              expect(
                payloadsOf(redrainedEvents, DISPATCH_EVENT_KINDS.OUTBOUND_FAILED),
              ).toHaveLength(1);
              expect(
                payloadsOf(redrainedEvents, DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED),
              ).toHaveLength(1);
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

    it.effect("terminalizes resource reservations idempotently", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const resourceIdentity = contractIdentity("resource-terminal");
          const creditProjection = projectionKey(resourceIdentity, "resource", "credit");
          yield* promise(() =>
            driver.grantResource(resourceIdentity, {
              key: "credit",
              amount: 5,
              ref: "seed",
            }),
          );
          const reserved = yield* promise(() =>
            driver.reserveResource(resourceIdentity, {
              key: "credit",
              amount: 2,
              ref: "req-1",
              idempotencyKey: "reserve-terminal",
            }),
          );

          yield* promise(() =>
            driver.consumeResource(resourceIdentity, {
              reservationId: reserved.reservationId,
              ref: "consume-1",
            }),
          );
          yield* promise(() =>
            driver.consumeResource(resourceIdentity, {
              reservationId: reserved.reservationId,
              ref: "consume-1-retry",
            }),
          );
          yield* expectRejectTagEffect(
            driver.releaseResource(resourceIdentity, {
              reservationId: reserved.reservationId,
              ref: "release-after-consume",
            }),
            "agent_os.resource_reservation_closed",
          );

          expect(yield* promise(() => driver.projectResource(creditProjection))).toEqual({
            available: 3,
            reserved: 0,
            consumed: 2,
          });
          const events = yield* promise(() => driver.events(resourceIdentity));
          expectEventsIdentity(events, resourceIdentity);
          expect(kindsOf(events)).toEqual([
            "resource_pool.granted",
            "resource_pool.reserved",
            "resource_pool.consumed",
          ]);
        }),
      ),
    );

    it.effect("serializes concurrent resource reserve decisions", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const resourceIdentity = contractIdentity("resource-concurrent-reserve");
          const creditProjection = projectionKey(resourceIdentity, "resource", "credit");
          yield* promise(() =>
            driver.grantResource(resourceIdentity, {
              key: "credit",
              amount: 5,
              ref: "seed",
            }),
          );

          const settled = yield* promise(() =>
            Promise.allSettled(
              Array.from({ length: 8 }, (_value, index) =>
                driver.reserveResource(resourceIdentity, {
                  key: "credit",
                  amount: 3,
                  ref: `req-${index}`,
                  idempotencyKey: `reserve-${index}`,
                }),
              ),
            ),
          );
          const fulfilled = settled.filter(
            (result): result is PromiseFulfilledResult<ResourceReserveResult> =>
              result.status === "fulfilled",
          );
          const rejected = settled.filter(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );

          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(settled.length - 1);
          for (const failure of rejected) {
            expect(failure.reason).toMatchObject({
              name: expect.stringContaining("agent_os.resource_insufficient"),
            });
          }
          expect(yield* promise(() => driver.projectResource(creditProjection))).toEqual({
            available: 2,
            reserved: 3,
            consumed: 0,
          });

          const events = yield* promise(() => driver.events(resourceIdentity));
          expectEventsIdentity(events, resourceIdentity);
          expect(payloadsOf(events, "resource_pool.reserved")).toHaveLength(1);
          expect(payloadsOf(events, "resource_pool.reserve_rejected")).toHaveLength(
            settled.length - 1,
          );
        }),
      ),
    );

    it.effect("dedupes concurrent resource reserves by idempotency key", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const resourceIdentity = contractIdentity("resource-concurrent-idempotency");
          const creditProjection = projectionKey(resourceIdentity, "resource", "credit");
          yield* promise(() =>
            driver.grantResource(resourceIdentity, {
              key: "credit",
              amount: 10,
              ref: "seed",
            }),
          );

          const results = yield* promise(() =>
            Promise.all(
              Array.from({ length: 8 }, (_value, index) =>
                driver.reserveResource(resourceIdentity, {
                  key: "credit",
                  amount: 2,
                  ref: `retry-${index}`,
                  idempotencyKey: "same-reserve",
                }),
              ),
            ),
          );

          expect(new Set(results.map((result) => result.reservationId)).size).toBe(1);
          expect(yield* promise(() => driver.projectResource(creditProjection))).toEqual({
            available: 8,
            reserved: 2,
            consumed: 0,
          });

          const events = yield* promise(() => driver.events(resourceIdentity));
          expectEventsIdentity(events, resourceIdentity);
          expect(payloadsOf(events, "resource_pool.reserved")).toHaveLength(1);
          expect(payloadsOf(events, "resource_pool.reserve_rejected")).toHaveLength(0);
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
            storageErrorTag,
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

export const runDispatchReceiveConcurrencyContract = (
  name: string,
  makeDriver: RuntimeBackendContractDriverFactory,
  options: RuntimeBackendContractSuiteOptions,
): void => {
  const contractIdentity = (scopeId: string): BackendProtocolEventIdentity =>
    contractEventIdentity(scopeId, options.runtimeFactOwner);

  const promise = <A>(thunk: () => Promise<A> | A): Effect.Effect<A> =>
    Effect.promise(() => Promise.resolve(thunk()));

  const withDriver = (
    fn: (driver: RuntimeBackendContractDriver) => Effect.Effect<void>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const driver = yield* promise(() => makeDriver());
      yield* fn(driver).pipe(Effect.ensuring(promise(() => driver.dispose())));
    });

  describe(name + " dispatch receive concurrency contract", () => {
    it.effect("linearizes concurrent dispatch receives by source and idempotency key", () =>
      withDriver((driver) =>
        Effect.gen(function* () {
          const senderIdentity = contractIdentity("concurrent-receive-sender");
          const receiverIdentity = contractIdentity("concurrent-receive-receiver");
          const concurrency = 16;
          const envelopes = Array.from({ length: concurrency }, (_value, index) =>
            dispatchEnvelope(
              senderIdentity,
              receiverIdentity,
              10_000 + index,
              "concurrent-receive-key",
              "app.concurrent-receive",
              { value: 6 },
            ),
          );
          const acceptResults = yield* promise(() =>
            Promise.all(envelopes.map((envelope) => driver.receive(receiverIdentity, envelope))),
          );

          expect(acceptResults).toHaveLength(concurrency);
          expect(new Set(acceptResults.map((result) => result.deliveredEventId)).size).toBe(1);

          const receiverEvents = yield* promise(() => driver.events(receiverIdentity));
          expect(kindsOf(receiverEvents)).toEqual([
            DISPATCH_EVENT_KINDS.INBOUND_ACCEPTED,
            "app.concurrent-receive",
          ]);
          expectEventsIdentity(receiverEvents, receiverIdentity);
          expect(receiverEvents[1]?.payload).toEqual({ value: 6 });

          const deliveredEventId = acceptResults[0]!.deliveredEventId;
          const acceptedPayload = receiverEvents[0]!.payload as {
            readonly deliveredEventId?: unknown;
            readonly idempotencyKey?: unknown;
            readonly outboundEventId?: unknown;
            readonly sourceScope?: unknown;
          };
          expect(acceptedPayload).toMatchObject({
            idempotencyKey: "concurrent-receive-key",
            deliveredEventId,
          });
          expect(envelopes.map((envelope) => envelope.outboundEventId)).toContain(
            acceptedPayload.outboundEventId,
          );
          expect(typeof acceptedPayload.sourceScope).toBe("string");
          expect(receiverEvents[1]?.id).toBe(deliveredEventId);
        }),
      ),
    );
  });
};
