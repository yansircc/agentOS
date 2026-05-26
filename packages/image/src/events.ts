import { isRecord } from "./shared";

/**
 * Reserved substrate vocabulary. v0 has no public writer for these events:
 * passing one to AgentDOBase.emitEvent / scheduleEvent / dispatchToScope will
 * fail with ReservedEventKindError. Use these constants only for read-side
 * projection of substrate-emitted facts when a future image job writer ships.
 */
export const IMAGE_EVENTS = {
  JOB_REQUESTED: "image.job.requested",
  PROVIDER_COMPLETED: "image.provider.completed",
  ARTIFACT_MATERIALIZED: "image.artifact.materialized",
  JOB_FAILED: "image.job.failed",
  JOB_CANCELLED: "image.job.cancelled",
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
  if (!isRecord(payload)) return undefined;
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
        const artifacts = isRecord(event.payload) && "artifactRef" in event.payload
          ? [...current.artifacts, event.payload.artifactRef]
          : current.artifacts;
        jobs.set(jobId, { ...current, status: "materialized", artifacts });
        break;
      }
      case IMAGE_EVENTS.JOB_FAILED:
        jobs.set(jobId, {
          ...current,
          status: "failed",
          failure: isRecord(event.payload) ? event.payload.failure : undefined,
        });
        break;
      case IMAGE_EVENTS.JOB_CANCELLED:
        jobs.set(jobId, { ...current, status: "cancelled" });
        break;
    }
  }
  return jobs;
};
