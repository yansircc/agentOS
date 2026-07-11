import { Layer } from "effect";
import { LedgerArchive } from "../ledger-archive";
import type { InMemoryBackendState } from "./state";

export const InMemoryLedgerArchiveLive = (
  state: InMemoryBackendState,
): Layer.Layer<LedgerArchive> =>
  Layer.succeed(LedgerArchive, {
    archive: (spec) => state.archiveLedger(spec),
    evict: (receipt) => state.evictArchivedLedger(receipt),
  });
