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

export const selectCloudflareArchiveSegments = (
  sql: SqlStorage,
  identity: BackendProtocolTruthIdentity,
): ReadonlyArray<StoredLedgerArchiveSegment> => {
  ensureLedgerSchema(sql);
  return sql
    .exec(
      `SELECT receipt, bytes FROM ledger_archive_segments
       WHERE truth_key = ? ORDER BY first_event_id ASC`,
      backendProtocolTruthIdentityKey(identity),
    )
    .toArray()
    .map((row) => {
      const record = row as unknown as { readonly receipt: unknown; readonly bytes: unknown };
      if (typeof record.bytes !== "string") {
        throw new LedgerArchiveError({ operation: "read", cause: "archive bytes are not text" });
      }
      return { receipt: parseReceipt(record.receipt), bytes: decodeBase64(record.bytes) };
    });
};

export const CloudflareLedgerArchiveLive = (
  state: DurableObjectState,
): Layer.Layer<LedgerArchive> => {
  const sql = state.storage.sql;
  ensureLedgerSchema(sql);
  return Layer.succeed(LedgerArchive, {
    archive: async (spec) => {
      const stored = selectCloudflareArchiveSegments(sql, spec.identity);
      const previous = stored.at(-1);
      const hot = selectLedgerEvents(sql, spec.identity, {});
      const previousLastId = previous?.receipt.lastEventId ?? 0;
      const events = hot.filter(
        (event) => event.id > previousLastId && event.id <= spec.throughEventId,
      );
      if (events.length === 0) {
        if (previous !== undefined && spec.throughEventId <= previous.receipt.lastEventId) {
          return previous.receipt;
        }
        throw new LedgerArchiveError({ operation: "archive", cause: "no hot events to archive" });
      }
      const artifact = await createLedgerArchiveArtifact({
        identity: spec.identity,
        previousSegmentSha256: previous?.receipt.segmentSha256 ?? null,
        events,
      });
      const truthKey = backendProtocolTruthIdentityKey(spec.identity);
      const archiveRef = `sqlite:${encodeURIComponent(truthKey)}:${artifact.sha256}`;
      const receipt = await createLedgerArchiveReceipt({
        artifact,
        archiveRef,
        readback: artifact.bytes,
      });
      state.storage.transactionSync(() => {
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
      const readback = selectCloudflareArchiveSegments(sql, spec.identity).find(
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
      const row = sql
        .exec(
          `SELECT receipt, bytes FROM ledger_archive_segments WHERE segment_sha256 = ?`,
          receipt.segmentSha256,
        )
        .toArray()[0] as { readonly receipt?: unknown; readonly bytes?: unknown } | undefined;
      if (
        row === undefined ||
        typeof row.bytes !== "string" ||
        canonicalLedgerArchiveJson(parseReceipt(row.receipt)) !==
          canonicalLedgerArchiveJson(receipt)
      ) {
        throw new LedgerArchiveError({
          operation: "evict",
          cause: "receipt is not authoritative",
        });
      }
      const artifact = await decodeLedgerArchiveArtifact(
        decodeBase64(row.bytes),
        receipt.segmentSha256,
      );
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
