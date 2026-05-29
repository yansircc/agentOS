import { Layer } from "effect";
import {
  Admission,
  Dispatch,
  Ledger,
  LlmTransport,
  Quota,
  Resources,
  Scheduler,
} from "@agent-os/runtime";
import {
  createInMemoryBackendState,
  type InMemoryBackendState,
  type InMemoryEventHandlerRegistration,
} from "./state";
import { InMemoryAdmissionLive } from "./admission";
import { InMemoryDispatchLive } from "./dispatch";
import type { InMemoryDispatchTargetRegistry } from "./dispatch-types";
import { InMemoryLedgerLive } from "./ledger";
import { InMemoryLlmTransportLive, type InMemoryLlmTransportOptions } from "./llm";
import { InMemoryQuotaLive } from "./quota";
import { InMemoryResourcesLive } from "./resources";
import { InMemorySchedulerLive } from "./scheduler";

export type InMemoryRuntimeServices =
  | Ledger
  | Scheduler
  | Dispatch
  | Resources
  | Quota
  | LlmTransport
  | Admission;

export interface InMemoryRuntimeLayerOptions {
  readonly state?: InMemoryBackendState;
  readonly scope: string;
  readonly handlers?: Iterable<InMemoryEventHandlerRegistration>;
  readonly dispatchTargets?: InMemoryDispatchTargetRegistry;
  readonly llm?: InMemoryLlmTransportOptions;
}

export interface InMemoryRuntimeBackend {
  readonly state: InMemoryBackendState;
  readonly layer: Layer.Layer<InMemoryRuntimeServices>;
}

export const createInMemoryRuntimeBackend = (
  options: InMemoryRuntimeLayerOptions,
): InMemoryRuntimeBackend => {
  const state = options.state ?? createInMemoryBackendState({ handlers: options.handlers });
  const llmLayer = InMemoryLlmTransportLive(options.llm);
  const admissionLayer = InMemoryAdmissionLive(state).pipe(Layer.provide(llmLayer));
  return {
    state,
    layer: Layer.mergeAll(
      InMemoryLedgerLive(state),
      InMemorySchedulerLive(state, options.scope),
      InMemoryDispatchLive(state, options.scope, options.dispatchTargets),
      InMemoryResourcesLive(state),
      InMemoryQuotaLive(state),
      llmLayer,
      admissionLayer,
    ),
  };
};

export const makeInMemoryRuntimeLayer = (
  options: InMemoryRuntimeLayerOptions,
): Layer.Layer<InMemoryRuntimeServices> => createInMemoryRuntimeBackend(options).layer;
