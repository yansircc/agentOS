import type { CommitJournal, CommitJournalTransaction, LedgerEvent } from "@agent-os/runtime";

export const createInMemoryCommitJournal = (): CommitJournal => {
  let nextId = 1;
  const rows: LedgerEvent[] = [];
  const sinks = new Set<(event: LedgerEvent) => void>();

  const events: CommitJournal["events"] = (opts = {}) =>
    Promise.resolve(
      rows.filter((row) => {
        if (opts.scope !== undefined && row.scope !== opts.scope) return false;
        if (opts.afterId !== undefined && row.id <= opts.afterId) return false;
        if (opts.kinds !== undefined && opts.kinds.length > 0 && !opts.kinds.includes(row.kind)) {
          return false;
        }
        return true;
      }),
    );

  const transact: CommitJournal["transact"] = (run) =>
    Promise.resolve().then(() => {
      const staged: LedgerEvent[] = [];
      const tx: CommitJournalTransaction = {
        appendEvent: (spec) => {
          const id = nextId + staged.length;
          const event: LedgerEvent = {
            id,
            ts: spec.ts ?? id,
            kind: spec.kind,
            scope: spec.scope,
            payload: spec.payload,
          };
          staged.push(event);
          return event;
        },
      };

      const value = run(tx);
      nextId += staged.length;
      rows.push(...staged);
      for (const event of staged) {
        for (const sink of Array.from(sinks)) sink(event);
      }
      return { value, events: staged };
    });

  return {
    transact,
    events,
    subscribe: (sink) => {
      sinks.add(sink);
      return { unsubscribe: () => sinks.delete(sink) };
    },
  };
};
