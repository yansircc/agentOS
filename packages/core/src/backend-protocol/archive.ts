import { Data, Predicate } from "effect";
import { ledgerTruthKey } from "@agent-os/core/effect-claim";
import type { LedgerTruthIdentity } from "@agent-os/core/runtime-protocol";
import {
  decodeRecordedLedgerEvent,
  type LedgerEvent,
  type RecordedLedgerEvent,
} from "@agent-os/core/types";

export const LEDGER_ARCHIVE_PROTOCOL_VERSION = "1" as const;

export interface LedgerArchiveSegment {
  readonly protocolVersion: typeof LEDGER_ARCHIVE_PROTOCOL_VERSION;
  readonly identity: LedgerTruthIdentity;
  readonly previousSegmentSha256: string | null;
  readonly events: ReadonlyArray<RecordedLedgerEvent>;
}

export interface LedgerArchiveArtifact {
  readonly segment: LedgerArchiveSegment;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface LedgerArchiveReceipt {
  readonly protocolVersion: typeof LEDGER_ARCHIVE_PROTOCOL_VERSION;
  readonly archiveRef: string;
  readonly truthKey: string;
  readonly firstEventId: number;
  readonly lastEventId: number;
  readonly eventCount: number;
  readonly segmentSha256: string;
  readonly previousSegmentSha256: string | null;
}

export class LedgerArchiveProtocolError extends Data.TaggedError(
  "agent_os.ledger_archive_protocol_error",
)<{ readonly reason: string }> {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const stableJsonValue = (value: unknown, seen: Set<object>): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new LedgerArchiveProtocolError({ reason: "non-finite number" });
    return value;
  }
  const isArray = Array.isArray(value);
  if (!isArray && !Predicate.isObject(value)) {
    throw new LedgerArchiveProtocolError({ reason: "value is not canonical JSON" });
  }
  const container = value as object;
  if (seen.has(container)) throw new LedgerArchiveProtocolError({ reason: "cyclic value" });
  seen.add(container);
  try {
    if (isArray) {
      return Array.from(value, (entry) => stableJsonValue(entry, seen));
    }
    const record = value as Readonly<Record<string, unknown>>;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) throw new LedgerArchiveProtocolError({ reason: "undefined value" });
      output[key] = stableJsonValue(entry, seen);
    }
    return output;
  } finally {
    seen.delete(container);
  }
};

export const canonicalLedgerArchiveJson = (value: unknown): string =>
  JSON.stringify(stableJsonValue(value, new Set()));

export const sha256LedgerArchiveBytes = async (bytes: Uint8Array): Promise<string> => {
  const subtle = (
    globalThis as typeof globalThis & {
      readonly crypto?: {
        readonly subtle?: {
          readonly digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>;
        };
      };
    }
  ).crypto?.subtle;
  if (subtle === undefined) {
    throw new LedgerArchiveProtocolError({ reason: "Web Crypto SHA-256 is unavailable" });
  }
  return `sha256:${hex(new Uint8Array(await subtle.digest("SHA-256", new Uint8Array(bytes))))}`;
};

const assertIdentity = (event: LedgerEvent, identity: LedgerTruthIdentity): void => {
  if (ledgerTruthKey(event) !== ledgerTruthKey(identity)) {
    throw new LedgerArchiveProtocolError({ reason: "segment contains a different truth identity" });
  }
};

const normalizeEvents = (
  identity: LedgerTruthIdentity,
  events: ReadonlyArray<unknown>,
): ReadonlyArray<RecordedLedgerEvent> => {
  if (events.length === 0) {
    throw new LedgerArchiveProtocolError({ reason: "archive segment must contain events" });
  }
  const decoded = events.map(decodeRecordedLedgerEvent);
  let previousId = 0;
  for (const event of decoded) {
    assertIdentity(event, identity);
    if (event.id <= previousId) {
      throw new LedgerArchiveProtocolError({ reason: "archive event ids must strictly increase" });
    }
    previousId = event.id;
  }
  return decoded;
};

const segmentData = (segment: LedgerArchiveSegment) => ({
  protocolVersion: segment.protocolVersion,
  identity: segment.identity,
  previousSegmentSha256: segment.previousSegmentSha256,
  events: segment.events,
});

export const createLedgerArchiveArtifact = async (spec: {
  readonly identity: LedgerTruthIdentity;
  readonly previousSegmentSha256: string | null;
  readonly events: ReadonlyArray<unknown>;
}): Promise<LedgerArchiveArtifact> => {
  const segment: LedgerArchiveSegment = {
    protocolVersion: LEDGER_ARCHIVE_PROTOCOL_VERSION,
    identity: spec.identity,
    previousSegmentSha256: spec.previousSegmentSha256,
    events: normalizeEvents(spec.identity, spec.events),
  };
  const bytes = textEncoder.encode(canonicalLedgerArchiveJson(segmentData(segment)));
  return { segment, bytes, sha256: await sha256LedgerArchiveBytes(bytes) };
};

export const decodeLedgerArchiveArtifact = async (
  bytes: Uint8Array,
  expectedSha256?: string,
): Promise<LedgerArchiveArtifact> => {
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    throw new LedgerArchiveProtocolError({ reason: "archive bytes are not valid UTF-8" });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LedgerArchiveProtocolError({ reason: "archive bytes are not JSON" });
  }
  if (!Predicate.isObject(value)) {
    throw new LedgerArchiveProtocolError({ reason: "archive segment is not an object" });
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record.protocolVersion !== LEDGER_ARCHIVE_PROTOCOL_VERSION) {
    throw new LedgerArchiveProtocolError({ reason: "archive protocol version mismatch" });
  }
  if (!Predicate.isObject(record.identity) || !Array.isArray(record.events)) {
    throw new LedgerArchiveProtocolError({ reason: "archive segment shape is invalid" });
  }
  const identity = record.identity as unknown as LedgerTruthIdentity;
  const previousSegmentSha256 = record.previousSegmentSha256;
  if (previousSegmentSha256 !== null && typeof previousSegmentSha256 !== "string") {
    throw new LedgerArchiveProtocolError({ reason: "previous segment digest is invalid" });
  }
  const artifact = await createLedgerArchiveArtifact({
    identity,
    previousSegmentSha256,
    events: record.events,
  });
  if (!sameBytes(artifact.bytes, bytes)) {
    throw new LedgerArchiveProtocolError({ reason: "archive bytes are not canonical" });
  }
  if (expectedSha256 !== undefined && artifact.sha256 !== expectedSha256) {
    throw new LedgerArchiveProtocolError({ reason: "archive checksum mismatch" });
  }
  return artifact;
};

export const createLedgerArchiveReceipt = async (spec: {
  readonly artifact: LedgerArchiveArtifact;
  readonly archiveRef: string;
  readonly readback: Uint8Array;
}): Promise<LedgerArchiveReceipt> => {
  if (spec.archiveRef.length === 0) {
    throw new LedgerArchiveProtocolError({ reason: "archive ref is empty" });
  }
  const readback = await decodeLedgerArchiveArtifact(spec.readback, spec.artifact.sha256);
  if (
    canonicalLedgerArchiveJson(segmentData(readback.segment)) !==
    canonicalLedgerArchiveJson(segmentData(spec.artifact.segment))
  ) {
    throw new LedgerArchiveProtocolError({
      reason: "archive readback differs from written segment",
    });
  }
  const first = spec.artifact.segment.events[0]!;
  const last = spec.artifact.segment.events.at(-1)!;
  return {
    protocolVersion: LEDGER_ARCHIVE_PROTOCOL_VERSION,
    archiveRef: spec.archiveRef,
    truthKey: ledgerTruthKey(spec.artifact.segment.identity),
    firstEventId: first.id,
    lastEventId: last.id,
    eventCount: spec.artifact.segment.events.length,
    segmentSha256: spec.artifact.sha256,
    previousSegmentSha256: spec.artifact.segment.previousSegmentSha256,
  };
};

export const validateLedgerArchiveChain = (
  artifacts: ReadonlyArray<LedgerArchiveArtifact>,
): void => {
  let previous: LedgerArchiveArtifact | undefined;
  for (const artifact of artifacts) {
    if (previous === undefined) {
      if (artifact.segment.previousSegmentSha256 !== null) {
        throw new LedgerArchiveProtocolError({ reason: "first archive segment has a predecessor" });
      }
    } else {
      if (artifact.segment.previousSegmentSha256 !== previous.sha256) {
        throw new LedgerArchiveProtocolError({ reason: "archive segment chain is broken" });
      }
      if (ledgerTruthKey(artifact.segment.identity) !== ledgerTruthKey(previous.segment.identity)) {
        throw new LedgerArchiveProtocolError({ reason: "archive chain changes truth identity" });
      }
      if (artifact.segment.events[0]!.id <= previous.segment.events.at(-1)!.id) {
        throw new LedgerArchiveProtocolError({ reason: "archive segments overlap or reorder ids" });
      }
    }
    previous = artifact;
  }
};
