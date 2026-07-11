import { Layer } from "effect";
import {
  canonicalLedgerArchiveJson,
  createLedgerArchiveArtifact,
  createLedgerArchiveReceipt,
  decodeLedgerArchiveArtifact,
  type BackendProtocolTruthIdentity,
  type LedgerArchiveReceipt,
} from "@agent-os/core/backend-protocol";
import { backendProtocolTruthIdentityKey } from "@agent-os/core/backend-protocol";
import {
  decodeLedgerArchiveSegments,
  ledgerArchiveReceiptForExactCut,
  LedgerArchive,
  LedgerArchiveError,
  type StoredLedgerArchiveSegment,
} from "../../ledger-archive";
import { ensureLedgerSchema } from "./commit";
import { selectLedgerEvents } from "./ledger";

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const parseReceipt = (value: unknown): LedgerArchiveReceipt => {
  if (typeof value !== "string") {
    throw new LedgerArchiveError({ operation: "read", cause: "archive receipt is not text" });
  }
  return JSON.parse(value) as LedgerArchiveReceipt;
};

interface CloudflareArchiveRow extends StoredLedgerArchiveSegment {
  readonly encodedBytes: string;
}

const selectCloudflareArchiveRows = (
  sql: SqlStorage,
  truthKey: string,
): ReadonlyArray<CloudflareArchiveRow> =>
  sql
    .exec(
      `SELECT segment_sha256, truth_key, previous_segment_sha256, first_event_id,
              last_event_id, archive_ref, receipt, bytes
       FROM ledger_archive_segments
       WHERE truth_key = ? ORDER BY first_event_id ASC`,
      truthKey,
    )
    .toArray()
    .map((row) => {
      const record = row as unknown as Readonly<Record<string, unknown>>;
      const receipt = parseReceipt(record.receipt);
      if (
        typeof record.bytes !== "string" ||
        record.segment_sha256 !== receipt.segmentSha256 ||
        record.truth_key !== receipt.truthKey ||
        record.previous_segment_sha256 !== receipt.previousSegmentSha256 ||
        Number(record.first_event_id) !== receipt.firstEventId ||
        Number(record.last_event_id) !== receipt.lastEventId ||
        record.archive_ref !== receipt.archiveRef
      ) {
        throw new LedgerArchiveError({ operation: "read", cause: "archive row mismatch" });
      }
      return {
        receipt,
        bytes: decodeBase64(record.bytes),
        encodedBytes: record.bytes,
      };
    });

const sameCloudflareArchiveRows = (
  left: ReadonlyArray<CloudflareArchiveRow>,
  right: ReadonlyArray<CloudflareArchiveRow>,
): boolean =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.encodedBytes === right[index]?.encodedBytes &&
      canonicalLedgerArchiveJson(entry.receipt) ===
        canonicalLedgerArchiveJson(right[index]?.receipt),
  );

export const selectCloudflareArchiveSegments = (
  sql: SqlStorage,
  identity: BackendProtocolTruthIdentity,
): ReadonlyArray<StoredLedgerArchiveSegment> => {
  ensureLedgerSchema(sql);
  return selectCloudflareArchiveRows(sql, backendProtocolTruthIdentityKey(identity));
};

export const CloudflareLedgerArchiveLive = (
  state: DurableObjectState,
): Layer.Layer<LedgerArchive> => {
  const sql = state.storage.sql;
  ensureLedgerSchema(sql);
  return Layer.succeed(LedgerArchive, {
    archive: async (spec) => {
      const truthKey = backendProtocolTruthIdentityKey(spec.identity);
      const stored = selectCloudflareArchiveRows(sql, truthKey);
      const artifacts = await decodeLedgerArchiveSegments(spec.identity, stored);
      const retry = ledgerArchiveReceiptForExactCut(stored, spec.throughEventId);
      if (retry !== undefined) return retry;
      const previous = artifacts.at(-1);
      const hot = selectLedgerEvents(sql, spec.identity, {});
      const previousLastId = previous?.segment.events.at(-1)?.id ?? 0;
      const events = hot.filter(
        (event) => event.id > previousLastId && event.id <= spec.throughEventId,
      );
      if (events.length === 0) {
        throw new LedgerArchiveError({ operation: "archive", cause: "no hot events to archive" });
      }
      const artifact = await createLedgerArchiveArtifact({
        identity: spec.identity,
        previousSegmentSha256: previous?.sha256 ?? null,
        events,
      });
      const archiveRef = `sqlite:${encodeURIComponent(truthKey)}:${artifact.sha256}`;
      const receipt = await createLedgerArchiveReceipt({
        artifact,
        archiveRef,
        readback: artifact.bytes,
      });
      state.storage.transactionSync(() => {
        if (!sameCloudflareArchiveRows(stored, selectCloudflareArchiveRows(sql, truthKey))) {
          return;
        }
        sql.exec(
          `INSERT INTO ledger_archive_segments
              (segment_sha256, truth_key, previous_segment_sha256, first_event_id,
               last_event_id, archive_ref, bytes, receipt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
          receipt.segmentSha256,
          truthKey,
          receipt.previousSegmentSha256,
          receipt.firstEventId,
          receipt.lastEventId,
          receipt.archiveRef,
          encodeBase64(artifact.bytes),
          canonicalLedgerArchiveJson(receipt),
        );
      });
      const readback = selectCloudflareArchiveRows(sql, truthKey).find(
        (entry) => entry.receipt.previousSegmentSha256 === receipt.previousSegmentSha256,
      );
      if (readback === undefined) {
        throw new LedgerArchiveError({ operation: "archive", cause: "archive readback missing" });
      }
      if (readback.receipt.segmentSha256 !== receipt.segmentSha256) {
        throw new LedgerArchiveError({
          operation: "archive",
          cause: "archive chain predecessor already has a different successor",
        });
      }
      const readbackReceipt = await createLedgerArchiveReceipt({
        artifact,
        archiveRef,
        readback: readback.bytes,
      });
      if (
        canonicalLedgerArchiveJson(readback.receipt) !== canonicalLedgerArchiveJson(readbackReceipt)
      ) {
        throw new LedgerArchiveError({
          operation: "archive",
          cause: "archive readback receipt mismatch",
        });
      }
      return readbackReceipt;
    },
    evict: async (receipt) => {
      const stored = selectCloudflareArchiveRows(sql, receipt.truthKey);
      const targetIndex = stored.findIndex(
        (entry) =>
          entry.receipt.segmentSha256 === receipt.segmentSha256 &&
          canonicalLedgerArchiveJson(entry.receipt) === canonicalLedgerArchiveJson(receipt),
      );
      if (targetIndex < 0) {
        throw new LedgerArchiveError({
          operation: "evict",
          cause: "receipt is not authoritative",
        });
      }
      const target = stored[targetIndex]!;
      const decodedTarget = await decodeLedgerArchiveArtifact(
        target.bytes,
        target.receipt.segmentSha256,
      );
      const artifacts = await decodeLedgerArchiveSegments(decodedTarget.segment.identity, stored);
      const artifact = artifacts[targetIndex]!;
      const hot = selectLedgerEvents(sql, artifact.segment.identity, {});
      const ids = new Set(artifact.segment.events.map((event) => event.id));
      const candidates = hot.filter((event) => ids.has(event.id));
      if (candidates.length === 0) return { evicted: 0 };
      if (
        candidates.length !== ids.size ||
        candidates.some((event) => {
          const archived = artifact.segment.events.find((candidate) => candidate.id === event.id);
          return (
            archived === undefined ||
            canonicalLedgerArchiveJson(event) !== canonicalLedgerArchiveJson(archived)
          );
        })
      ) {
        throw new LedgerArchiveError({ operation: "evict", cause: "hot event set mismatch" });
      }
      state.storage.transactionSync(() => {
        if (
          !sameCloudflareArchiveRows(stored, selectCloudflareArchiveRows(sql, receipt.truthKey))
        ) {
          throw new LedgerArchiveError({ operation: "evict", cause: "archive chain changed" });
        }
        sql.exec(
          `DELETE FROM events WHERE id IN (${Array.from(ids, () => "?").join(", ")})`,
          ...ids,
        );
      });
      return { evicted: candidates.length };
    },
  });
};

export const corruptCloudflareArchiveForTest = (
  state: DurableObjectState,
  receipt: LedgerArchiveReceipt,
): void => {
  state.storage.sql.exec(
    `UPDATE ledger_archive_segments SET bytes = ? WHERE segment_sha256 = ?`,
    encodeBase64(new TextEncoder().encode("corrupt")),
    receipt.segmentSha256,
  );
};
