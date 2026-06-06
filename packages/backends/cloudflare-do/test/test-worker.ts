/**
 * Test worker entry.
 *
 * Test DOs are factory-configured for product paths.
 */

import { DurableObject } from "cloudflare:workers";
import { Cause, Effect, Exit, Option, Schema, Predicate } from "effect";
import {
  credential,
  createAgentDurableObject,
  defineAgentDO,
  durableObjectDispatchTarget,
  endpoint,
  openAIChat,
  type AgentEventHandlerContext,
  type AgentRuntimeClient,
  type CloudflareAgentEnv,
} from "../src";
import { withAgentDOTestingDrain } from "./_testing-drain";
import { testTruthIdentity } from "./_identity";
import {
  defineProjection,
  makeProjectionRegistryResult,
  MaterializedProjectionRegistry,
  MaterializedProjections,
  triggerParseFail,
  attachedStreamParseOk,
  projectionFail,
  projectionIdentity,
  projectionMalformed,
  projectionPut,
  triggerParseOk,
  type AttachedStreamHandler,
  type DispatchTargetAdapter,
  type DurableTrigger,
  type TriggerCancellation,
  type TriggerTx,
  type MaterializedProjectionRebuildResult,
} from "@agent-os/runtime";
import { CapabilityRejected, DurableTriggerAcquireCancelled } from "@agent-os/kernel/errors";
import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { eventNamespace, type ExtensionCapability } from "@agent-os/kernel/extensions";
import { makePreClaim, type FactOwnerRef } from "@agent-os/kernel/effect-claim";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import { defineSettlementContract, settleLived } from "@agent-os/kernel/settlement-contract";
import { defineTool, pureToolExecution } from "@agent-os/kernel/tools";
import type { EventHandler } from "@agent-os/kernel/types";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";
import { CloudflareMaterializedProjectionsLive } from "../src/materialized-projections";
import { commitLedgerTransaction } from "../src/ledger/commit";
import type { EventBusService } from "../src/ledger/event-bus";

const allowToolAdmitter = () => ({ ok: true as const });

export class TestAgentDO extends DurableObject {}

export const EmitTestDO = createAgentDurableObject<CloudflareAgentEnv>({
  eventHandlers: ({ runtime }) => [
    {
      kind: "interview.answer",
      handler: (event) =>
        runtime
          .emitEvent({
            event: "interview.followup",
            data: { sourceId: event.id, sourcePayload: event.payload },
          })
          .then(() => undefined),
    },
  ],
});
export type EmitTestDO = InstanceType<typeof EmitTestDO>;

interface DispatchEnv extends CloudflareAgentEnv {
  readonly DISPATCH_DO: DurableObjectNamespace;
}

const DEAD_TARGET: DispatchTargetAdapter = {
  deliver: () => Promise.reject("dead dispatch target"),
};

let dispatchTargetMaterializations = 0;

const dispatchTarget = (env: DispatchEnv): DispatchTargetAdapter => {
  dispatchTargetMaterializations += 1;
  return durableObjectDispatchTarget(env.DISPATCH_DO);
};

const dispatchBindingKey = (ref: string): string =>
  materialRefKey(
    bindingMaterialRef({ provider: "cloudflare", bindingKind: "durable_object", ref }),
  );

export const DispatchTestDO = createAgentDurableObject<DispatchEnv>({
  dispatchTargets: (env) => ({
    [dispatchBindingKey("peer")]: dispatchTarget(env),
    [dispatchBindingKey("dead")]: DEAD_TARGET,
    [dispatchBindingKey("generic")]: durableObjectDispatchTarget(env.DISPATCH_DO),
  }),
  eventHandlers: ({ runtime }) => [
    {
      kind: "dispatch.inbound.accepted",
      handler: () =>
        runtime
          .emitEvent({ event: "test.inbound_accepted_handler_fired", data: {} })
          .then(() => undefined),
    },
    {
      kind: "dispatch.outbound.requested",
      handler: () =>
        runtime
          .emitEvent({ event: "test.outbound_requested_handler_fired", data: {} })
          .then(() => undefined),
    },
    {
      kind: "test.delivered",
      handler: (event) =>
        runtime
          .emitEvent({
            event: "test.followup",
            data: { sourceId: event.id, sourcePayload: event.payload },
          })
          .then(() => undefined),
    },
  ],
});
export type DispatchTestDO = InstanceType<typeof DispatchTestDO>;

export const STREAM_OWNER_FACT_OWNER = "@agent-os/stream-owner-test";
export const STREAM_OWNER_COMMAND_EVENT = "stream.command.owner";
export const STREAM_OWNER_VISIBLE_EVENT = "stream.owner.visible";

const streamOwnerSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/stream-owner-test",
  anchorKinds: [],
  rejectionKinds: [],
});

const streamOwnerBoundaryContract = defineBoundaryContract({
  packageId: STREAM_OWNER_FACT_OWNER,
  kindPrefixes: ["stream.owner."],
  roles: ["generator", "reader"],
  effectAuthorityContracts: [],
  materialRequirements: [],
  events: {
    [STREAM_OWNER_VISIBLE_EVENT]: {
      payloadSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
        },
        required: ["label"],
        additionalProperties: false,
      },
    },
  },
  settlement: streamOwnerSettlementContract,
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const StreamTestDO = createAgentDurableObject<CloudflareAgentEnv>({
  extensions: () => [boundaryPackage(streamOwnerBoundaryContract, "0.1.0")],
  eventHandlers: ({ capabilities }) => [
    {
      kind: "stream.slow",
      handler: () => scheduler.wait(1_000),
    },
    {
      kind: STREAM_OWNER_COMMAND_EVENT,
      handler: (event) => {
        const capability = capabilities.get(STREAM_OWNER_FACT_OWNER);
        if (capability === undefined) {
          return Promise.reject(
            new CapabilityRejected({
              event: STREAM_OWNER_VISIBLE_EVENT,
              capability: `extension:${STREAM_OWNER_FACT_OWNER}`,
            }),
          );
        }
        return capability
          .commit({
            event: STREAM_OWNER_VISIBLE_EVENT,
            data: {
              label:
                typeof event.payload === "object" &&
                event.payload !== null &&
                "label" in event.payload &&
                typeof event.payload.label === "string"
                  ? event.payload.label
                  : "visible",
            },
          })
          .then(() => undefined);
      },
    },
  ],
});
export type StreamTestDO = InstanceType<typeof StreamTestDO>;

const proofSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/proof",
  anchorKinds: ["carrier_proof"],
  rejectionKinds: [],
});

const proofBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/proof",
  kindPrefixes: ["proof."],
  roles: ["generator", "reader"],
  effectAuthorityContracts: [],
  materialRequirements: [],
  events: {
    "proof.recorded": {
      payloadSchema: {
        type: "object",
        properties: {
          proofRef: { type: "string" },
        },
        required: ["proofRef"],
        additionalProperties: false,
      },
      claim: { key: "claim", phase: "lived", anchorKinds: ["carrier_proof"] },
    },
  },
  settlement: proofSettlementContract,
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

const proofPreClaimForScope = (scopeId: string) =>
  makePreClaim({
    operationRef: "proof:record",
    scopeRef: { kind: "conversation", scopeId },
    effectAuthorityRef: { authorityId: "proof.record", authorityClass: "effect" },
    originRef: { originId: "extension-test", originKind: "test" },
  });

const proofPreClaim = proofPreClaimForScope("extension-proof");

export const proofLivedClaim = settleLived(proofSettlementContract, proofPreClaim, {
  anchorId: "proof:record",
  anchorKind: "carrier_proof",
  carrierRef: "proof",
});

export const proofLivedClaimForScope = (scopeId: string) =>
  settleLived(proofSettlementContract, proofPreClaimForScope(scopeId), {
    anchorId: "proof:record",
    anchorKind: "carrier_proof",
    carrierRef: "proof",
  });

export const EXTENSION_COMMAND_EVENT = "test.extension.command";
export const EXTENSION_RESULT_EVENT = "test.extension.result";

type ExtensionCommand =
  | { readonly op: "commitImageFact"; readonly data: unknown }
  | { readonly op: "commitWrongPrefix"; readonly data: unknown }
  | { readonly op: "commitMissingExtension"; readonly data: unknown }
  | { readonly op: "scheduleImageFact"; readonly at: number; readonly data: unknown }
  | { readonly op: "commitProofFact"; readonly data: unknown }
  | { readonly op: "commitProofOther"; readonly data: unknown }
  | { readonly op: "scheduleProofFact"; readonly at: number; readonly data: unknown };

type ExtensionCommandParseResult =
  | { readonly ok: true; readonly command: ExtensionCommand }
  | { readonly ok: false; readonly error: Record<string, unknown> };

const malformedCommand = (message: string): ExtensionCommandParseResult => ({
  ok: false,
  error: { message },
});

const parseExtensionCommand = (value: unknown): ExtensionCommandParseResult => {
  if (!Predicate.isRecord(value) || typeof value.op !== "string") {
    return malformedCommand("extension command malformed");
  }
  const data = value.data;
  switch (value.op) {
    case "commitImageFact":
    case "commitWrongPrefix":
    case "commitMissingExtension":
    case "commitProofFact":
    case "commitProofOther":
      return { ok: true, command: { op: value.op, data } };
    case "scheduleImageFact":
    case "scheduleProofFact":
      if (typeof value.at !== "number") return malformedCommand("extension command at malformed");
      return { ok: true, command: { op: value.op, at: value.at, data } };
    default:
      return malformedCommand(`extension command unsupported: ${value.op}`);
  }
};

const errorPayload = (cause: unknown): Record<string, unknown> => {
  if (Predicate.isRecord(cause)) {
    return {
      ...(typeof cause._tag === "string" ? { _tag: cause._tag } : {}),
      ...(typeof cause.event === "string" ? { event: cause.event } : {}),
      ...(typeof cause.capability === "string" ? { capability: cause.capability } : {}),
      ...(typeof cause.issue === "string" ? { issue: cause.issue } : {}),
      ...(typeof cause.message === "string" ? { message: cause.message } : {}),
    };
  }
  if (cause instanceof Error) return { message: cause.message };
  return { message: String(cause) };
};

type CapabilityResult =
  | { readonly ok: true; readonly capability: ExtensionCapability }
  | { readonly ok: false; readonly error: CapabilityRejected };

const capabilityOrReject = (
  capabilities: ReadonlyMap<string, ExtensionCapability>,
  packageId: string,
): CapabilityResult => {
  const cap = capabilities.get(packageId);
  if (cap !== undefined) return { ok: true, capability: cap };
  return {
    ok: false,
    error: new CapabilityRejected({
      event: "*",
      capability:
        packageId === "@agent-os/image"
          ? `extension:${packageId}:boundary`
          : `extension:${packageId}`,
    }),
  };
};

const capabilityPromise = (
  capabilities: ReadonlyMap<string, ExtensionCapability>,
  packageId: string,
): Promise<ExtensionCapability> => {
  const result = capabilityOrReject(capabilities, packageId);
  return result.ok ? Promise.resolve(result.capability) : Promise.reject(result.error);
};

const runExtensionCommand = (
  capabilities: ReadonlyMap<string, ExtensionCapability>,
  command: ExtensionCommand,
) => {
  const image = () => capabilityPromise(capabilities, "@agent-os/image");
  const proof = () => capabilityPromise(capabilities, "@agent-os/proof");
  const missing = () => capabilityPromise(capabilities, "@agent-os/missing");
  return command.op === "commitImageFact"
    ? image().then((cap) => cap.commit({ event: "image.job.recorded", data: command.data }))
    : command.op === "commitWrongPrefix"
      ? image().then((cap) => cap.commit({ event: "git.commit.recorded", data: command.data }))
      : command.op === "commitMissingExtension"
        ? missing().then((cap) => cap.commit({ event: "missing.fact", data: command.data }))
        : command.op === "scheduleImageFact"
          ? image().then((cap) =>
              cap.time({
                at: command.at,
                event: "image.job.deferred",
                data: command.data,
              }),
            )
          : command.op === "commitProofFact"
            ? proof().then((cap) => cap.commit({ event: "proof.recorded", data: command.data }))
            : command.op === "commitProofOther"
              ? proof().then((cap) => cap.commit({ event: "proof.other", data: command.data }))
              : proof().then((cap) =>
                  cap.time({
                    at: command.at,
                    event: "proof.recorded",
                    data: command.data,
                  }),
                );
};

const extensionCommandHandlers = ({
  runtime,
  capabilities,
}: AgentEventHandlerContext<AgentRuntimeClient>) => [
  {
    kind: EXTENSION_COMMAND_EVENT,
    handler: async (event: Parameters<EventHandler>[0]) => {
      const parsed = parseExtensionCommand(event.payload);
      if (!parsed.ok) {
        await runtime.emitEvent({
          event: EXTENSION_RESULT_EVENT,
          data: {
            op: "malformed",
            ok: false,
            error: parsed.error,
          },
        });
        return;
      }
      const outcome = await runExtensionCommand(capabilities, parsed.command).then(
        (result) => ({ ok: true, result }) as const,
        (cause) => ({ ok: false, error: errorPayload(cause) }) as const,
      );
      await runtime.emitEvent({
        event: EXTENSION_RESULT_EVENT,
        data: { op: parsed.command.op, ...outcome },
      });
    },
  },
];

export const ExtensionTestDO = createAgentDurableObject<CloudflareAgentEnv>({
  extensions: () => [
    eventNamespace({
      packageId: "@agent-os/image",
      kindPrefixes: ["image."],
      version: "0.3.0",
    }),
    boundaryPackage(proofBoundaryContract, "0.1.0"),
  ],
  eventHandlers: extensionCommandHandlers,
});
export type ExtensionTestDO = InstanceType<typeof ExtensionTestDO>;

const facadeLookup = defineTool({
  name: "lookup",
  description: "Lookup a symbolic key",
  args: Schema.Struct({ key: Schema.String }),
  authority: "read",
  admit: allowToolAdmitter,
  execution: pureToolExecution(),
  execute: ({ key }) => ({ value: key }),
});

export const makeFacadeSubmitChatResponse = (): Response =>
  Response.json({
    id: "chatcmpl_facade_submit",
    object: "chat.completion",
    model: "gpt-4.1-mini",
    created: 1_700_000_000,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "facade done",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    },
  });

export const FacadeSubmitTestDO = defineAgentDO<CloudflareAgentEnv>({
  bindings: [
    endpoint<CloudflareAgentEnv>("llm").from(() => "https://stub.openai.test/v1"),
    credential<CloudflareAgentEnv>("llm-key").from(() => "stub-key"),
  ],
  llms: {
    default: openAIChat({
      model: "gpt-4.1-mini",
      endpoint: "llm",
      credential: "llm-key",
    }),
  },
  tools: [facadeLookup],
  scopeRefForScope: (scope) => ({ kind: "conversation", scopeId: scope }),
});
export type FacadeSubmitTestDO = InstanceType<typeof FacadeSubmitTestDO>;

interface FoldIntent {
  readonly label: string;
}

const parseFoldIntent = (raw: unknown) => {
  if (!Predicate.isRecord(raw) || typeof raw.label !== "string") {
    return triggerParseFail<FoldIntent>("fold intent malformed");
  }
  return triggerParseOk({ label: raw.label });
};

const foldTrigger = {
  kind: "test.fold",
  intentEventKind: "test.fold.requested",
  cancellation: "cooperative",
  parseIntent: parseFoldIntent,
  acquire: (intent: FoldIntent) => Effect.succeed(intent),
  commit: (outcome, tx) => {
    const seen = tx.events({ kinds: ["test.fold.done"] }).length;
    tx.insertEvent({
      kind: "test.fold.done",
      payload: { label: outcome.label, seen },
    });
  },
  commitCancelled: () => undefined,
} satisfies DurableTrigger<FoldIntent, FoldIntent>;

export const TriggerFacadeTestDO = defineAgentDO<CloudflareAgentEnv>({
  bindings: [],
  triggers: [foldTrigger],
});
export type TriggerFacadeTestDO = InstanceType<typeof TriggerFacadeTestDO>;

export const TriggerFactoryErrorTestDO = defineAgentDO<CloudflareAgentEnv>({
  bindings: [],
  triggers: () => {
    JSON.parse("{");
    return [];
  },
});
export type TriggerFactoryErrorTestDO = InstanceType<typeof TriggerFactoryErrorTestDO>;

interface BoundaryIntent {
  readonly label: string;
}

const parseBoundaryIntent = (raw: unknown) => {
  if (!Predicate.isRecord(raw) || typeof raw.label !== "string") {
    return triggerParseFail<BoundaryIntent>("boundary intent malformed");
  }
  return triggerParseOk({ label: raw.label });
};

export const TriggerBoundaryTestDO = defineAgentDO<CloudflareAgentEnv>({
  bindings: [],
  triggers: (ctx) => {
    ctx.sql.exec("CREATE TABLE IF NOT EXISTS test_projection (label TEXT NOT NULL)");
    const rollbackTrigger = {
      kind: "test.rollback_projection",
      intentEventKind: "test.rollback_projection.requested",
      cancellation: "cooperative",
      parseIntent: parseBoundaryIntent,
      acquire: (intent: BoundaryIntent) => Effect.succeed(intent),
      commit: (outcome, tx) => {
        tx.insertEvent({
          kind: "test.rollback_projection.done",
          payload: { label: outcome.label },
        });
        ctx.sql.exec("INSERT INTO test_projection (label) VALUES (?)", outcome.label);
        ctx.sql.exec("INSERT INTO missing_projection_table (label) VALUES (?)", outcome.label);
      },
      commitCancelled: () => undefined,
    } satisfies DurableTrigger<BoundaryIntent, BoundaryIntent>;
    const thenableTrigger = {
      kind: "test.thenable_commit",
      intentEventKind: "test.thenable_commit.requested",
      cancellation: "cooperative",
      parseIntent: parseBoundaryIntent,
      acquire: (intent: BoundaryIntent) => Effect.succeed(intent),
      commit: ((outcome: BoundaryIntent, tx: TriggerTx) => {
        tx.insertEvent({
          kind: "test.thenable_commit.done",
          payload: { label: outcome.label },
        });
        return Promise.resolve(undefined);
      }) as DurableTrigger<BoundaryIntent, BoundaryIntent>["commit"],
      commitCancelled: () => undefined,
    } satisfies DurableTrigger<BoundaryIntent, BoundaryIntent>;
    return [rollbackTrigger, thenableTrigger];
  },
});
export type TriggerBoundaryTestDO = InstanceType<typeof TriggerBoundaryTestDO>;

interface ChainIntent {
  readonly step: number;
}

const parseChainIntent = (raw: unknown) => {
  if (!Predicate.isRecord(raw) || typeof raw.step !== "number") {
    return triggerParseFail<ChainIntent>("chain intent malformed");
  }
  return triggerParseOk({ step: raw.step });
};

const chainTrigger = {
  kind: "test.chain",
  intentEventKind: "test.chain.requested",
  cancellation: "cooperative",
  parseIntent: parseChainIntent,
  acquire: (intent: ChainIntent) => Effect.succeed(intent),
  commit: (outcome, tx) => {
    tx.insertEvent({ kind: "test.chain.done", payload: { step: outcome.step } });
    if (outcome.step < 3) {
      tx.enqueue({
        triggerKind: "test.chain",
        intentEventKind: "test.chain.requested",
        payload: { step: outcome.step + 1 },
        fireAt: tx.now,
      });
    }
  },
  commitCancelled: () => undefined,
} satisfies DurableTrigger<ChainIntent, ChainIntent>;

export const TriggerTestingDrainTestDO = withAgentDOTestingDrain(
  defineAgentDO<CloudflareAgentEnv>({
    bindings: [],
    triggers: [chainTrigger],
  }),
);
export type TriggerTestingDrainTestDO = InstanceType<typeof TriggerTestingDrainTestDO>;

interface CancelIntent {
  readonly label: string;
}

const parseCancelIntent = (raw: unknown) => {
  if (!Predicate.isRecord(raw) || typeof raw.label !== "string") {
    return triggerParseFail<CancelIntent>("cancel intent malformed");
  }
  return triggerParseOk({ label: raw.label });
};

const acquireCancelled = (
  kind: string,
  ctx: Parameters<DurableTrigger<CancelIntent, CancelIntent>["acquire"]>[1],
  reason?: string,
) =>
  new DurableTriggerAcquireCancelled({
    scope: ctx.scope,
    kind,
    dueWorkId: ctx.dueWorkId,
    intentEventId: ctx.intentEventId,
    ...(reason === undefined ? {} : { reason }),
  });

export const TriggerCancelTestDO = withAgentDOTestingDrain(
  defineAgentDO<CloudflareAgentEnv>({
    bindings: [],
    triggers: (ctx) => {
      ctx.sql.exec(`
        CREATE TABLE IF NOT EXISTS test_acquire_observations (
          trigger_kind TEXT NOT NULL,
          mode TEXT NOT NULL,
          aborted INTEGER NOT NULL
        )
      `);
      const cancellableTrigger = {
        kind: "test.cancellable",
        intentEventKind: "test.cancellable.requested",
        cancellation: "cooperative",
        parseIntent: parseCancelIntent,
        acquire: (intent: CancelIntent, acquireCtx) =>
          Effect.tryPromise({
            try: () =>
              Promise.race([
                scheduler.wait(50).then(() => intent),
                new Promise<CancelIntent>((_resolve, reject) => {
                  if (acquireCtx.signal.aborted) {
                    reject(acquireCancelled("test.cancellable", acquireCtx, "already aborted"));
                    return;
                  }
                  acquireCtx.signal.addEventListener(
                    "abort",
                    () =>
                      reject(
                        acquireCancelled(
                          "test.cancellable",
                          acquireCtx,
                          String(acquireCtx.signal.reason ?? "aborted"),
                        ),
                      ),
                    { once: true },
                  );
                }),
              ]),
            catch: (cause) =>
              cause instanceof DurableTriggerAcquireCancelled
                ? cause
                : acquireCancelled("test.cancellable", acquireCtx, String(cause)),
          }),
        commit: (outcome, tx) => {
          tx.insertEvent({ kind: "test.cancellable.done", payload: outcome });
        },
        commitCancelled: (intent, cancellation, tx) => {
          tx.insertEvent({
            kind: "test.cancellable.cancelled",
            payload: { label: intent.label, reason: cancellation.reason ?? null },
          });
        },
      } satisfies DurableTrigger<CancelIntent, CancelIntent>;
      const genericCancelTrigger = {
        kind: "test.generic_cancel",
        intentEventKind: "test.generic_cancel.requested",
        cancellation: "ignored",
        parseIntent: parseCancelIntent,
        acquire: (intent: CancelIntent) => Effect.succeed(intent),
        commit: (outcome, tx) => {
          tx.insertEvent({ kind: "test.generic_cancel.done", payload: outcome });
        },
        commitCancelled: () => undefined,
      } satisfies DurableTrigger<CancelIntent, CancelIntent>;
      const thenableCancelTrigger = {
        kind: "test.thenable_cancel",
        intentEventKind: "test.thenable_cancel.requested",
        cancellation: "cooperative",
        parseIntent: parseCancelIntent,
        acquire: (intent: CancelIntent) => Effect.succeed(intent),
        commit: (outcome, tx) => {
          tx.insertEvent({ kind: "test.thenable_cancel.done", payload: outcome });
        },
        commitCancelled: ((
          intent: CancelIntent,
          _cancellation: TriggerCancellation,
          tx: TriggerTx,
        ) => {
          tx.insertEvent({ kind: "test.thenable_cancel.cancelled", payload: intent });
          return Promise.resolve(undefined);
        }) as DurableTrigger<CancelIntent, CancelIntent>["commitCancelled"],
      } satisfies DurableTrigger<CancelIntent, CancelIntent>;
      const redriveTrigger = {
        kind: "test.redrive_once",
        intentEventKind: "test.redrive_once.requested",
        cancellation: "cooperative",
        acquireDeadlineMs: 1,
        parseIntent: parseCancelIntent,
        acquire: (intent: CancelIntent, acquireCtx) =>
          Effect.gen(function* () {
            ctx.sql.exec(
              "INSERT INTO test_acquire_observations (trigger_kind, mode, aborted) VALUES (?, ?, ?)",
              "test.redrive_once",
              acquireCtx.acquireMode,
              acquireCtx.signal.aborted ? 1 : 0,
            );
            if (acquireCtx.acquireMode === "normal") {
              yield* Effect.promise(() => scheduler.wait(50));
            }
            return intent;
          }),
        commit: (outcome, tx) => {
          tx.insertEvent({ kind: "test.redrive_once.done", payload: outcome });
        },
        commitCancelled: () => undefined,
      } satisfies DurableTrigger<CancelIntent, CancelIntent>;
      const redriveCancelledTrigger = {
        kind: "test.redrive_cancelled",
        intentEventKind: "test.redrive_cancelled.requested",
        cancellation: "cooperative",
        acquireDeadlineMs: 1,
        parseIntent: parseCancelIntent,
        acquire: (intent: CancelIntent, acquireCtx) =>
          Effect.gen(function* () {
            ctx.sql.exec(
              "INSERT INTO test_acquire_observations (trigger_kind, mode, aborted) VALUES (?, ?, ?)",
              "test.redrive_cancelled",
              acquireCtx.acquireMode,
              acquireCtx.signal.aborted ? 1 : 0,
            );
            if (acquireCtx.signal.aborted) {
              return yield* Effect.fail(
                acquireCancelled("test.redrive_cancelled", acquireCtx, "redrive aborted"),
              );
            }
            yield* Effect.promise(() => scheduler.wait(50));
            return intent;
          }),
        commit: (outcome, tx) => {
          tx.insertEvent({ kind: "test.redrive_cancelled.done", payload: outcome });
        },
        commitCancelled: (intent, cancellation, tx) => {
          tx.insertEvent({
            kind: "test.redrive_cancelled.cancelled",
            payload: { label: intent.label, reason: cancellation.reason ?? null },
          });
        },
      } satisfies DurableTrigger<CancelIntent, CancelIntent>;
      const defaultDeadlineTrigger = {
        kind: "test.default_deadline",
        intentEventKind: "test.default_deadline.requested",
        cancellation: "cooperative",
        parseIntent: parseCancelIntent,
        acquire: (intent: CancelIntent) =>
          Effect.promise(() => scheduler.wait(50)).pipe(Effect.as(intent)),
        commit: (outcome, tx) => {
          tx.insertEvent({ kind: "test.default_deadline.done", payload: outcome });
        },
        commitCancelled: () => undefined,
      } satisfies DurableTrigger<CancelIntent, CancelIntent>;
      return [
        cancellableTrigger,
        genericCancelTrigger,
        thenableCancelTrigger,
        redriveTrigger,
        redriveCancelledTrigger,
        defaultDeadlineTrigger,
      ];
    },
  }),
);
export type TriggerCancelTestDO = InstanceType<typeof TriggerCancelTestDO>;

const attachedEcho = {
  kind: "test.attached_echo",
  mode: "bidi",
  cancellation: "cooperative",
  onDetach: "abort",
  parseStart: (raw) => attachedStreamParseOk(raw),
  run: async function* (_start, input) {
    for await (const frame of input) {
      if (frame.kind !== "input") continue;
      yield { kind: "output", channel: "stdout", payload: frame.payload };
      yield { kind: "completed", terminal: { echoed: frame.payload } };
      return;
    }
  },
  commitTerminal: (terminal, tx) => {
    tx.insertEvent({ kind: "test.attached_echo.completed", payload: terminal });
  },
} satisfies AttachedStreamHandler<unknown, unknown>;

const attachedOutput = {
  kind: "test.attached_output",
  mode: "output_only",
  cancellation: "cooperative",
  onDetach: "abort",
  parseStart: (raw) => attachedStreamParseOk(raw),
  run: async function* (start) {
    yield { kind: "progress", payload: { start } };
    yield { kind: "completed", terminal: { ok: true, start } };
  },
  commitTerminal: (terminal, tx) => {
    tx.insertEvent({ kind: "test.attached_output.completed", payload: terminal });
  },
} satisfies AttachedStreamHandler<unknown, unknown>;

const attachedCancellable = {
  kind: "test.attached_cancellable",
  mode: "output_only",
  cancellation: "cooperative",
  onDetach: "abort",
  parseStart: (raw) => attachedStreamParseOk(raw),
  run: async function* (_start, _input, ctx) {
    yield { kind: "progress", payload: { waiting: true } };
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
    yield { kind: "cancelled", reason: String(ctx.signal.reason ?? "cancelled") };
  },
  commitTerminal: (terminal, tx) => {
    tx.insertEvent({ kind: "test.attached_cancellable.cancelled", payload: terminal });
  },
} satisfies AttachedStreamHandler<unknown, unknown>;

export const AttachedStreamTestDO = defineAgentDO<CloudflareAgentEnv>({
  bindings: [],
  streams: [attachedEcho, attachedOutput, attachedCancellable],
});
export type AttachedStreamTestDO = InstanceType<typeof AttachedStreamTestDO>;

const materializedRunProjection = defineProjection({
  kind: "run.workflow",
  version: 1,
  eventKinds: ["run.requested", "run.completed", "run.failed"],
  identity: Schema.Struct({ runId: Schema.String }),
  state: Schema.Struct({
    runId: Schema.String,
    status: Schema.Literal("requested", "completed"),
    handoff: Schema.optional(Schema.String),
  }),
  identityKey: (identity) => identity.runId,
  identify: (event) => {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return projectionMalformed("payload");
    const runId = (payload as { readonly runId?: unknown }).runId;
    return typeof runId === "string" ? projectionIdentity({ runId }) : projectionMalformed("runId");
  },
  initial: (identity) => ({ runId: identity.runId, status: "requested" as const }),
  reduce: (state, event) => {
    if (event.kind === "run.failed") return projectionFail("projection rejected run.failed");
    if (event.kind === "run.completed") {
      const payload = event.payload as { readonly handoff?: unknown };
      return projectionPut({
        ...state,
        status: "completed" as const,
        ...(typeof payload.handoff === "string" ? { handoff: payload.handoff } : {}),
      });
    }
    return projectionPut(state);
  },
});

const materializedRunFailingRebuildProjection = defineProjection({
  ...materializedRunProjection,
  version: 2,
  reduce: (state, event) =>
    event.kind === "run.completed"
      ? projectionFail("projection rebuild failed")
      : projectionPut(state),
});

const MaterializedProjectionBaseDO = defineAgentDO<CloudflareAgentEnv>({
  bindings: [],
  projections: [materializedRunProjection],
});

const silentEventBus = {
  fire: () => Effect.void,
  fireMany: () => Effect.void,
  fanoutDiagnostics: () => [],
  subscribe: () => ({ unsubscribe: () => undefined }),
} satisfies EventBusService;

export class MaterializedProjectionTestDO extends MaterializedProjectionBaseDO {
  async emitForFactOwner(
    scopeId: string,
    factOwnerRef: FactOwnerRef,
    event: string,
    data: unknown,
  ): Promise<void> {
    const identity = testTruthIdentity(scopeId);
    const exit = await Effect.runPromiseExit(
      commitLedgerTransaction(this.ctx, silentEventBus, { factOwnerRef }, (tx) => {
        tx.append({
          ts: Date.now(),
          kind: event,
          scopeRef: identity.scopeRef,
          effectAuthorityRef: identity.effectAuthorityRef,
          payload: data,
        });
      }),
    );
    if (Exit.isSuccess(exit)) return;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) return Promise.reject(failure.value);
    return Promise.reject(exit.cause);
  }

  async rebuildWithFailingProjection(
    spec: BackendProtocolEventIdentity & { readonly kind: string },
  ): Promise<MaterializedProjectionRebuildResult> {
    const registryResult = makeProjectionRegistryResult([materializedRunFailingRebuildProjection]);
    if (registryResult._tag === "failure") {
      return Promise.reject(registryResult.error);
    }
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const projections = yield* MaterializedProjections;
        return yield* projections.rebuild(spec);
      }).pipe(
        Effect.provide(CloudflareMaterializedProjectionsLive(this.ctx)),
        Effect.provideService(MaterializedProjectionRegistry, registryResult.registry),
      ),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) return Promise.reject(failure.value);
    return Promise.reject(exit.cause);
  }
}

interface WorkerEnv extends CloudflareAgentEnv {
  readonly STREAM_DO: DurableObjectNamespace<StreamTestDO>;
  readonly EXTENSION_DO: DurableObjectNamespace<ExtensionTestDO>;
  readonly FACADE_SUBMIT_DO: DurableObjectNamespace<FacadeSubmitTestDO>;
  readonly TRIGGER_FACADE_DO: DurableObjectNamespace<TriggerFacadeTestDO>;
  readonly TRIGGER_FACTORY_ERROR_DO: DurableObjectNamespace<TriggerFactoryErrorTestDO>;
  readonly TRIGGER_BOUNDARY_DO: DurableObjectNamespace<TriggerBoundaryTestDO>;
  readonly TRIGGER_CANCEL_DO: DurableObjectNamespace<TriggerCancelTestDO>;
  readonly ATTACHED_STREAM_DO: DurableObjectNamespace<AttachedStreamTestDO>;
  readonly MATERIALIZED_PROJECTION_DO: DurableObjectNamespace<MaterializedProjectionTestDO>;
}

const parseLastEventId = (value: string | null): number => {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/dispatch-target-materializations") {
      return Response.json({ count: dispatchTargetMaterializations });
    }
    const match = url.pathname.match(/^\/stream\/([^/]+)$/);
    if (match !== null) {
      const scope = decodeURIComponent(match[1] ?? "");
      const stub = env.STREAM_DO.get(env.STREAM_DO.idFromName(scope));
      return stub.streamEvents(testTruthIdentity(scope), {
        afterId: parseLastEventId(req.headers.get("Last-Event-ID")),
      });
    }
    return new Response("@agent-os/backend-cloudflare-do test worker (not for direct use)");
  },
};
