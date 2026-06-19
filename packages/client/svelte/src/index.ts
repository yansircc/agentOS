import { derived, readable, type Readable } from "svelte/store";
import type { AgentClientSelector, AgentClientStore } from "@agent-os/client";

export type { AgentClientSelector, AgentClientStore } from "@agent-os/client";

export const clientReadable = <Snapshot>(store: AgentClientStore<Snapshot>): Readable<Snapshot> =>
  readable(store.getSnapshot(), (set) =>
    store.subscribe(() => {
      set(store.getSnapshot());
    }),
  );

export const selectClientReadable = <Snapshot, Selected>(
  store: AgentClientStore<Snapshot>,
  selector: AgentClientSelector<Snapshot, Selected>,
): Readable<Selected> => derived(clientReadable(store), selector);
