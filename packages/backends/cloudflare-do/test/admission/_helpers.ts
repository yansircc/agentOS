/**
 * Shared test fixtures used by admission/*.test.ts files.
 *
 * Lives next to the split test files so each contract test reaches for
 * the same `makeRuntime` layer composition and the same Chat-Completions
 * shaped stub response (`submitStructuredResp`) without each file rebuilding
 * the runtime by hand. Mirrors the prior monolith's setup block at
 * admission-contract.test.ts:346-385.
 *
 * NOT a test file — vitest ignores _-prefixed files via glob.
 */

import { Context, Layer, ManagedRuntime, Schema } from "effect";

import { EventBusLive, LedgerLive } from "../../src/ledger";
import { LlmTransport } from "@agent-os/runtime";
import { RefResolverLive } from "@agent-os/kernel/ref-resolver";
import { QuotaLive } from "../../src/quota";
import { AdmissionLive } from "../../src/admission";
import type { EventHandler } from "@agent-os/kernel/types";
import { structuredToolResp } from "../_stub-ai";

export const SCHEMA = Schema.Struct({ summary: Schema.String });

export const makeRuntime = (
  state: DurableObjectState,
  llm: Context.Tag.Service<typeof LlmTransport>,
) => {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state).pipe(Layer.provide(eventBus));
  const quota = QuotaLive(state).pipe(Layer.provide(eventBus));
  const llmTransport = Layer.succeed(LlmTransport, llm);
  const refs = RefResolverLive({
    material: () => null,
  });
  const admission = AdmissionLive(state).pipe(
    Layer.provide(Layer.mergeAll(eventBus, llmTransport)),
  );
  return ManagedRuntime.make(Layer.mergeAll(ledger, quota, llmTransport, admission, refs));
};

export const makeRuntimeWithRegistry = (
  state: DurableObjectState,
  llm: Context.Tag.Service<typeof LlmTransport>,
  endpoints: Record<string, string>,
  credentials: Record<string, string>,
) => {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state).pipe(Layer.provide(eventBus));
  const quota = QuotaLive(state).pipe(Layer.provide(eventBus));
  const llmTransport = Layer.succeed(LlmTransport, llm);
  const refs = RefResolverLive({
    material: (ref) => {
      switch (ref.kind) {
        case "endpoint":
          return endpoints[ref.ref] ?? null;
        case "credential":
          return credentials[ref.ref] ?? null;
        default:
          return null;
      }
    },
  });
  const admission = AdmissionLive(state).pipe(
    Layer.provide(Layer.mergeAll(eventBus, llmTransport)),
  );
  return ManagedRuntime.make(Layer.mergeAll(ledger, quota, llmTransport, admission, refs));
};

export const submitStructuredResp = structuredToolResp;
