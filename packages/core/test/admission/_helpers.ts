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

import { Layer, ManagedRuntime } from "effect";

import { EventBusLive, LedgerLive } from "../../src/ledger";
import { AiBinding } from "../../src/llm";
import { RefResolverLive } from "../../src/ref-resolver";
import { QuotaLive } from "../../src/quota";
import { AdmissionLive } from "../../src/admission";
import type { JsonSchemaObject } from "../../src/admission";
import type { EventHandler } from "../../src/types";

export const SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
};

export const makeRuntime = (state: DurableObjectState, ai: Ai) => {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state.storage.sql).pipe(Layer.provide(eventBus));
  const quota = QuotaLive(state).pipe(Layer.provide(eventBus));
  const aiLayer = Layer.succeed(AiBinding, ai);
  const refs = RefResolverLive({
    endpoint: () => null,
    credential: () => null,
  });
  const admission = AdmissionLive(state).pipe(Layer.provide(eventBus));
  return ManagedRuntime.make(
    Layer.mergeAll(ledger, quota, aiLayer, admission, refs),
  );
};

export const makeRuntimeWithRegistry = (
  state: DurableObjectState,
  ai: Ai,
  endpoints: Record<string, string>,
  credentials: Record<string, string>,
) => {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state.storage.sql).pipe(Layer.provide(eventBus));
  const quota = QuotaLive(state).pipe(Layer.provide(eventBus));
  const aiLayer = Layer.succeed(AiBinding, ai);
  const refs = RefResolverLive({
    endpoint: (ref) => endpoints[ref] ?? null,
    credential: (ref) => credentials[ref] ?? null,
  });
  const admission = AdmissionLive(state).pipe(Layer.provide(eventBus));
  return ManagedRuntime.make(
    Layer.mergeAll(ledger, quota, aiLayer, admission, refs),
  );
};

export const submitStructuredResp = (json: string, id = "c1") => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id,
            type: "function" as const,
            function: { name: "_submit_structured", arguments: json },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
