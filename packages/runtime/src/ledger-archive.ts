import { Context, Data } from "effect";
import {
  canonicalLedgerArchiveJson,
  decodeLedgerArchiveArtifact,
  validateLedgerArchiveChain,
  type LedgerArchiveArtifact,
  type LedgerArchiveReceipt,
} from "@agent-os/core/backend-protocol";
import { ledgerTruthKey } from "@agent-os/core/effect-claim";
import type { LedgerTruthIdentity } from "@agent-os/core/runtime-protocol";
import type { EventQueryOptions, LedgerEvent, RecordedLedgerEvent } from "@agent-os/core/types";
import { normalizeBackendPageLimit } from "@agent-os/core/backend-protocol";

export class LedgerArchiveError extends Data.TaggedError("agent_os.ledger_archive_error")<{
  readonly operation: "archive" | "read" | "evict";
  readonly cause: unknown;
}> {}

export interface StoredLedgerArchiveSegment {
  readonly receipt: LedgerArchiveReceipt;
  readonly bytes: Uint8Array;
}

export class LedgerArchive extends Context.Service<
  LedgerArchive,
  {
    readonly archive: (spec: {
      readonly identity: LedgerTruthIdentity;
      readonly throughEventId: number;
    }) => Promise<LedgerArchiveReceipt>;
    readonly evict: (receipt: LedgerArchiveReceipt) => Promise<{ readonly evicted: number }>;
  }
>()("@agent-os/LedgerArchive") {}

const sameEvent = (left: LedgerEvent, right: LedgerEvent): boolean =>
  canonicalLedgerArchiveJson(left) === canonicalLedgerArchiveJson(right);

export const decodeLedgerArchiveSegments = async (
  identity: LedgerTruthIdentity,
  stored: ReadonlyArray<StoredLedgerArchiveSegment>,
): Promise<ReadonlyArray<LedgerArchiveArtifact>> => {
  const artifacts: LedgerArchiveArtifact[] = [];
  for (const entry of stored) {
    if (entry.receipt.truthKey !== ledgerTruthKey(identity)) {
      throw new LedgerArchiveError({ operation: "read", cause: "receipt truth mismatch" });
    }
    const artifact = await decodeLedgerArchiveArtifact(entry.bytes, entry.receipt.segmentSha256);
    if (
      artifact.segment.events.length !== entry.receipt.eventCount ||
      artifact.segment.events[0]!.id !== entry.receipt.firstEventId ||
      artifact.segment.events.at(-1)!.id !== entry.receipt.lastEventId ||
      artifact.segment.previousSegmentSha256 !== entry.receipt.previousSegmentSha256
    ) {
      throw new LedgerArchiveError({ operation: "read", cause: "receipt metadata mismatch" });
    }
    artifacts.push(artifact);
  }
  try {
    validateLedgerArchiveChain(artifacts);
  } catch (cause) {
    throw new LedgerArchiveError({ operation: "read", cause });
  }
  return artifacts;
};

export const mergeLedgerArchiveEvents = (
  identity: LedgerTruthIdentity,
  artifacts: ReadonlyArray<LedgerArchiveArtifact>,
  hotEvents: ReadonlyArray<LedgerEvent>,
): ReadonlyArray<RecordedLedgerEvent> => {
  const byId = new Map<number, RecordedLedgerEvent>();
  const add = (event: RecordedLedgerEvent): void => {
    if (ledgerTruthKey(event) !== ledgerTruthKey(identity)) {
      throw new LedgerArchiveError({ operation: "read", cause: "event truth mismatch" });
    }
    const existing = byId.get(event.id);
    if (existing !== undefined && !sameEvent(existing, event)) {
      throw new LedgerArchiveError({ operation: "read", cause: "duplicate event id mismatch" });
    }
    byId.set(event.id, event);
  };
  for (const artifact of artifacts) for (const event of artifact.segment.events) add(event);
  for (const event of hotEvents as ReadonlyArray<RecordedLedgerEvent>) add(event);
  return Array.from(byId.values()).sort((left, right) => left.id - right.id);
};

export const queryLedgerArchiveEvents = (
  events: ReadonlyArray<RecordedLedgerEvent>,
  opts: EventQueryOptions = {},
): ReadonlyArray<RecordedLedgerEvent> => {
  const afterId = Math.max(0, Math.floor(opts.afterId ?? 0));
  const kinds = opts.kinds === undefined || opts.kinds.length === 0 ? null : new Set(opts.kinds);
  const owners =
    opts.factOwnerRefs === undefined || opts.factOwnerRefs.length === 0
      ? null
      : new Set(opts.factOwnerRefs);
  return events
    .filter(
      (event) =>
        event.id > afterId &&
        (kinds === null || kinds.has(event.kind)) &&
        (owners === null || owners.has(event.factOwnerRef)),
    )
    .slice(0, normalizeBackendPageLimit(opts.limit));
};
