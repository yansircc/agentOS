import type { MaterialRef, ResolvedMaterial } from "@agent-os/kernel";
import type { LedgerEvent } from "./types";

export interface CommitJournalTransaction {
  readonly appendEvent: (spec: {
    readonly kind: string;
    readonly scope: string;
    readonly payload: unknown;
    readonly ts?: number;
  }) => LedgerEvent;
}

export interface CommitJournal {
  readonly transact: <A>(
    run: (tx: CommitJournalTransaction) => A,
  ) => Promise<{ readonly value: A; readonly events: ReadonlyArray<LedgerEvent> }>;
  readonly events: (opts?: {
    readonly scope?: string;
    readonly afterId?: number;
    readonly kinds?: ReadonlyArray<string>;
  }) => Promise<ReadonlyArray<LedgerEvent>>;
  readonly subscribe: (sink: (event: LedgerEvent) => void) => { readonly unsubscribe: () => void };
}

export interface TimerBackend {
  readonly scheduleAt: (at: number) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface ScopeRouter<Envelope = unknown, Result = unknown> {
  readonly dispatch: (targetScope: string, envelope: Envelope) => Promise<Result>;
}

export interface MaterialResolver {
  readonly material: (ref: MaterialRef) => Promise<ResolvedMaterial>;
}
