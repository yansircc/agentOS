import { useSyncExternalStore } from "react";
import type { AgentClientSelector, AgentClientStore } from "@agent-os/client";

export type { AgentClientSelector, AgentClientStore } from "@agent-os/client";

export const useAgentClientSnapshot = <Snapshot>(store: AgentClientStore<Snapshot>): Snapshot => {
  const subscribe = (listener: () => void) => store.subscribe(listener);
  const getSnapshot = () => store.getSnapshot();
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export const useClientStore = <Snapshot, Selected>(
  store: AgentClientStore<Snapshot>,
  selector: AgentClientSelector<Snapshot, Selected>,
): Selected => {
  const subscribe = (listener: () => void) => store.subscribe(listener);
  const getSelectedSnapshot = () => selector(store.getSnapshot());
  return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot);
};
