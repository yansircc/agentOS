import type { RuntimeLedgerEvent } from "@agent-os/core/runtime-protocol";
import type {
  AgentClientCommandMap,
  AgentClientConnectionStatus,
  AgentClientController,
  AgentClientRpcInvoker,
  AgentClientSnapshot,
  CreateAgentClientOptions,
} from "./index";

export interface AgentClientTransportCallbacks {
  readonly getSnapshot: () => AgentClientSnapshot;
  readonly appendEvents: (events: ReadonlyArray<RuntimeLedgerEvent>) => void;
  readonly setConnection: (status: AgentClientConnectionStatus, error?: unknown) => void;
}

export type AgentClientTransportController<Commands extends AgentClientCommandMap> = Pick<
  AgentClientController<Commands>,
  "invoke" | "connect" | "disconnect"
>;

export const createAgentClientTransport = <Commands extends AgentClientCommandMap>(
  options: CreateAgentClientOptions<Commands>,
  callbacks: AgentClientTransportCallbacks,
): AgentClientTransportController<Commands> => {
  let activeStreamAbort: AbortController | undefined;

  const invoke: AgentClientRpcInvoker<Commands> = (name, input, commandOptions) => {
    if (options.rpcInvoker === undefined) {
      return Promise.reject(new Error(`missing rpcInvoker for command ${name}`));
    }
    return options.rpcInvoker(name, input, commandOptions);
  };

  return {
    invoke,
    async connect(connectOptions) {
      if (options.streamSource === undefined) {
        throw new Error("missing streamSource");
      }
      if (connectOptions?.signal?.aborted === true) {
        callbacks.setConnection("closed");
        return;
      }

      activeStreamAbort?.abort();
      const streamAbort = new AbortController();
      activeStreamAbort = streamAbort;
      const abortFromCaller = () => streamAbort.abort(connectOptions?.signal?.reason);
      connectOptions?.signal?.addEventListener("abort", abortFromCaller, { once: true });

      try {
        callbacks.setConnection("connecting");
        const cursor = { afterEventId: callbacks.getSnapshot().lastEventId };
        const stream = options.streamSource.open(cursor, { signal: streamAbort.signal });
        callbacks.setConnection("open");
        for await (const event of stream) {
          if (streamAbort.signal.aborted) break;
          callbacks.appendEvents([event]);
        }
        callbacks.setConnection("closed");
      } catch (error) {
        callbacks.setConnection(streamAbort.signal.aborted ? "closed" : "failed", error);
      } finally {
        connectOptions?.signal?.removeEventListener("abort", abortFromCaller);
        if (activeStreamAbort === streamAbort) activeStreamAbort = undefined;
      }
    },
    disconnect() {
      activeStreamAbort?.abort();
      activeStreamAbort = undefined;
      callbacks.setConnection("closed");
    },
  };
};
