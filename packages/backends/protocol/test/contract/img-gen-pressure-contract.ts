import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  triggerParseFail,
  triggerParseOk,
  type AnyDurableTrigger,
  type DurableTrigger,
} from "./durable-trigger-contract";

interface ScanIntent {
  readonly scanId: string;
}

interface PressureWorld {
  readonly staleOutboxIds: ReadonlyArray<string>;
  readonly staleRunningJobIds: ReadonlyArray<string>;
  readonly orphanR2Keys: ReadonlyArray<string>;
  readonly stalePlanningRequestIds: ReadonlyArray<string>;
}

export interface ImgGenPressureDriver {
  readonly enqueue: (
    trigger: AnyDurableTrigger,
    payload: ScanIntent,
    fireAt: number,
  ) => Promise<void>;
  readonly drainDue: (now: number) => Promise<void>;
  readonly events: () => Promise<ReadonlyArray<LedgerEvent>>;
  readonly dispose: () => Promise<void>;
}

export type ImgGenPressureDriverFactory = (
  triggers: ReadonlyArray<AnyDurableTrigger>,
) => ImgGenPressureDriver | Promise<ImgGenPressureDriver>;

const parseScanIntent = (raw: unknown) => {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { scanId?: unknown }).scanId !== "string"
  ) {
    return triggerParseFail<ScanIntent>("img-gen scan intent malformed");
  }
  return triggerParseOk({ scanId: (raw as { readonly scanId: string }).scanId });
};

export const createImgGenPressureTriggers = (
  world: PressureWorld,
): ReadonlyArray<AnyDurableTrigger> => {
  const retryDeliveryTrigger = {
    kind: "img.delivery_retry",
    intentEventKind: "image.job.retry.requested",
    cancellation: "cooperative",
    parseIntent: (raw: unknown) => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as { jobId?: unknown }).jobId !== "string"
      ) {
        return triggerParseFail<{ readonly jobId: string }>("image retry intent malformed");
      }
      return triggerParseOk({ jobId: (raw as { readonly jobId: string }).jobId });
    },
    acquire: (intent) => Effect.succeed(intent),
    commit: (outcome, tx) => {
      tx.insertEvent({ kind: "image.job.retry.drained", payload: outcome });
    },
    commitCancelled: () => undefined,
  } satisfies DurableTrigger<{ readonly jobId: string }, { readonly jobId: string }>;

  const artifactDeleteTrigger = {
    kind: "artifact.delete",
    intentEventKind: "artifact.delete.requested",
    cancellation: "cooperative",
    parseIntent: (raw: unknown) => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as { r2Key?: unknown }).r2Key !== "string"
      ) {
        return triggerParseFail<{ readonly r2Key: string }>("artifact delete intent malformed");
      }
      return triggerParseOk({ r2Key: (raw as { readonly r2Key: string }).r2Key });
    },
    acquire: (intent) => Effect.succeed(intent),
    commit: (outcome, tx) => {
      tx.insertEvent({ kind: "artifact.delete.drained", payload: outcome });
    },
    commitCancelled: () => undefined,
  } satisfies DurableTrigger<{ readonly r2Key: string }, { readonly r2Key: string }>;

  const staleQueuedOutboxScan = {
    kind: "img.scan.stale_outbox",
    intentEventKind: "image.outbox.scan.requested",
    cancellation: "cooperative",
    parseIntent: parseScanIntent,
    acquire: () => Effect.succeed(world.staleOutboxIds),
    commit: (ids, tx) => {
      for (const outboxId of ids) {
        tx.insertEvent({ kind: "image.outbox.redrive.requested", payload: { outboxId } });
      }
    },
    commitCancelled: () => undefined,
  } satisfies DurableTrigger<ScanIntent, ReadonlyArray<string>>;

  const staleRunningJobScan = {
    kind: "img.scan.stale_running",
    intentEventKind: "image.running.scan.requested",
    cancellation: "cooperative",
    parseIntent: parseScanIntent,
    acquire: () => Effect.succeed(world.staleRunningJobIds),
    commit: (jobIds, tx) => {
      for (const jobId of jobIds) {
        tx.insertEvent({ kind: "image.job.retry_scheduled", payload: { jobId } });
        tx.enqueue({
          triggerKind: retryDeliveryTrigger.kind,
          intentEventKind: retryDeliveryTrigger.intentEventKind,
          payload: { jobId },
          fireAt: tx.now,
        });
      }
    },
    commitCancelled: () => undefined,
  } satisfies DurableTrigger<ScanIntent, ReadonlyArray<string>>;

  const r2OrphanScan = {
    kind: "img.scan.r2_orphan",
    intentEventKind: "artifact.orphan.scan.requested",
    cancellation: "cooperative",
    parseIntent: parseScanIntent,
    acquire: () => Effect.succeed(world.orphanR2Keys),
    commit: (r2Keys, tx) => {
      for (const r2Key of r2Keys) {
        tx.enqueue({
          triggerKind: artifactDeleteTrigger.kind,
          intentEventKind: artifactDeleteTrigger.intentEventKind,
          payload: { r2Key },
          fireAt: tx.now,
        });
      }
    },
    commitCancelled: () => undefined,
  } satisfies DurableTrigger<ScanIntent, ReadonlyArray<string>>;

  const stalePlanningScan = {
    kind: "img.scan.stale_planning",
    intentEventKind: "planning.scan.requested",
    cancellation: "cooperative",
    parseIntent: parseScanIntent,
    acquire: () => Effect.succeed(world.stalePlanningRequestIds),
    commit: (requestIds, tx) => {
      for (const requestId of requestIds) {
        tx.insertEvent({ kind: "planning.redrive.requested", payload: { requestId } });
      }
    },
    commitCancelled: () => undefined,
  } satisfies DurableTrigger<ScanIntent, ReadonlyArray<string>>;

  return [
    retryDeliveryTrigger,
    artifactDeleteTrigger,
    staleQueuedOutboxScan,
    staleRunningJobScan,
    r2OrphanScan,
    stalePlanningScan,
  ];
};

const kindsOf = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind);

const sorted = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...values].sort();

export const runImgGenPressureContract = (
  name: string,
  makeDriver: ImgGenPressureDriverFactory,
): void => {
  describe(name + " img-gen durable trigger pressure", () => {
    it.effect("drains scan intents into repair facts and chained intents", () =>
      Effect.withSpan("agentos.test.img_gen_pressure.contract")(
        Effect.gen(function* () {
          const triggers = createImgGenPressureTriggers({
            staleOutboxIds: ["outbox-1"],
            staleRunningJobIds: ["job-1"],
            orphanR2Keys: ["r2/orphan.png"],
            stalePlanningRequestIds: ["request-1"],
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const driver = yield* Effect.acquireRelease(
                Effect.promise(() => Promise.resolve(makeDriver(triggers))),
                (driver) => Effect.promise(() => driver.dispose()),
              );
              for (const trigger of triggers.filter((candidate) =>
                candidate.kind.startsWith("img.scan."),
              )) {
                yield* Effect.promise(() => driver.enqueue(trigger, { scanId: trigger.kind }, 100));
              }
              yield* Effect.promise(() => driver.drainDue(100));
              yield* Effect.promise(() => driver.drainDue(100));

              const kinds = sorted(kindsOf(yield* Effect.promise(() => driver.events())));
              expect(kinds).toEqual(
                sorted([
                  "artifact.delete.drained",
                  "artifact.delete.requested",
                  "artifact.orphan.scan.requested",
                  "image.job.retry.drained",
                  "image.job.retry.requested",
                  "image.job.retry_scheduled",
                  "image.outbox.redrive.requested",
                  "image.outbox.scan.requested",
                  "image.running.scan.requested",
                  "planning.redrive.requested",
                  "planning.scan.requested",
                ]),
              );
              expect(kinds).not.toContain("planning.program.invoked");
              expect(kinds).not.toContain("r2.deleted");
            }),
          );
        }),
      ),
    );
  });
};
