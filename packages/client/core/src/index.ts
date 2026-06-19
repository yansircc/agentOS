export type AgentClientListener = () => void;
export type AgentClientUnsubscribe = () => void;

export interface AgentClientStore<Snapshot> {
  subscribe(listener: AgentClientListener): AgentClientUnsubscribe;
  getSnapshot(): Snapshot;
}

export interface AgentClientStoreController<Snapshot> extends AgentClientStore<Snapshot> {
  setSnapshot(snapshot: Snapshot): void;
}

export type AgentClientSelector<Snapshot, Selected> = (snapshot: Snapshot) => Selected;

export const createAgentClientStore = <Snapshot>(
  initialSnapshot: Snapshot,
): AgentClientStoreController<Snapshot> => {
  let snapshot = initialSnapshot;
  const listeners = new Set<AgentClientListener>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    setSnapshot(nextSnapshot) {
      if (Object.is(snapshot, nextSnapshot)) return;
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
  };
};

export const selectAgentClientSnapshot = <Snapshot, Selected>(
  store: AgentClientStore<Snapshot>,
  selector: AgentClientSelector<Snapshot, Selected>,
): Selected => selector(store.getSnapshot());
