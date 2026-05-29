import { Predicate } from "effect";
import { IMAGE_EVENT_PREFIX } from "./extension";

/**
 * Package-owned vocabulary. Core does not reserve modality prefixes globally:
 * a DO protects these facts by declaring `imageEventNamespace(version)` in its
 * factory config, which makes app-facing core write paths reject image.*.
 * v0 ships projection names and the negative gate declaration only; positive
 * package commits remain deferred by contract.
 */
export const IMAGE_EVENTS = {
  JOB_REQUESTED: `${IMAGE_EVENT_PREFIX}job.requested`,
  PROVIDER_COMPLETED: `${IMAGE_EVENT_PREFIX}provider.completed`,
  ARTIFACT_MATERIALIZED: `${IMAGE_EVENT_PREFIX}artifact.materialized`,
  JOB_FAILED: `${IMAGE_EVENT_PREFIX}job.failed`,
  JOB_CANCELLED: `${IMAGE_EVENT_PREFIX}job.cancelled`,
} as const;

export type ImageEventKind = (typeof IMAGE_EVENTS)[keyof typeof IMAGE_EVENTS];

export interface ImageLedgerEvent {
  readonly kind: string;
  readonly payload: unknown;
}

export type ImageJobStatus =
  | "requested"
  | "provider_completed"
  | "materialized"
  | "failed"
  | "cancelled";

export interface ImageJobProjection {
  readonly jobId: string;
  readonly status: ImageJobStatus;
  readonly artifacts: ReadonlyArray<unknown>;
  readonly failure?: unknown;
}

const jobIdFromPayload = (payload: unknown): string | undefined => {
  if (!Predicate.isRecord(payload)) return undefined;
  return typeof payload.jobId === "string" ? payload.jobId : undefined;
};

export const projectImageJobs = (
  events: Iterable<ImageLedgerEvent>,
): ReadonlyMap<string, ImageJobProjection> => {
  const jobs = new Map<string, ImageJobProjection>();
  for (const event of events) {
    const jobId = jobIdFromPayload(event.payload);
    if (jobId === undefined) continue;
    const current = jobs.get(jobId) ?? {
      jobId,
      status: "requested" as ImageJobStatus,
      artifacts: [],
    };
    switch (event.kind) {
      case IMAGE_EVENTS.JOB_REQUESTED:
        jobs.set(jobId, { ...current, status: "requested" });
        break;
      case IMAGE_EVENTS.PROVIDER_COMPLETED:
        jobs.set(jobId, { ...current, status: "provider_completed" });
        break;
      case IMAGE_EVENTS.ARTIFACT_MATERIALIZED: {
        const artifacts =
          Predicate.isRecord(event.payload) && "artifactRef" in event.payload
            ? [...current.artifacts, event.payload.artifactRef]
            : current.artifacts;
        jobs.set(jobId, { ...current, status: "materialized", artifacts });
        break;
      }
      case IMAGE_EVENTS.JOB_FAILED:
        jobs.set(jobId, {
          ...current,
          status: "failed",
          failure: Predicate.isRecord(event.payload) ? event.payload.failure : undefined,
        });
        break;
      case IMAGE_EVENTS.JOB_CANCELLED:
        jobs.set(jobId, { ...current, status: "cancelled" });
        break;
    }
  }
  return jobs;
};
