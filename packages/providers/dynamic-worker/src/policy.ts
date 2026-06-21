import { Effect } from "effect";

import {
  DEFAULT_MAX_BODY_BYTES,
  DYNAMIC_WORKER_MAX_TIMEOUT_MS,
  DynamicWorkerPolicyViolation,
  type DynamicWorkerPolicy,
  type DynamicWorkerRunRequest,
  type DynamicWorkerStaticPolicyOptions,
} from "./types";

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export const validateDynamicWorkerRequest = (
  request: DynamicWorkerRunRequest,
): Effect.Effect<void, DynamicWorkerPolicyViolation> =>
  Effect.withSpan("agentos.dynamic_worker.validate_request")(
    Effect.gen(function* () {
      if (request.code.trim().length === 0) {
        return yield* new DynamicWorkerPolicyViolation({
          reason: "code must be non-empty",
        });
      }
      if (request.request.url.trim().length === 0) {
        return yield* new DynamicWorkerPolicyViolation({
          reason: "request.url must be non-empty",
        });
      }
      if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
        return yield* new DynamicWorkerPolicyViolation({
          reason: "timeoutMs must be positive",
        });
      }
      if (request.timeoutMs > DYNAMIC_WORKER_MAX_TIMEOUT_MS) {
        return yield* new DynamicWorkerPolicyViolation({
          reason: `timeoutMs exceeds ${DYNAMIC_WORKER_MAX_TIMEOUT_MS}`,
        });
      }
      const maxBodyBytes = request.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      if (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0) {
        return yield* new DynamicWorkerPolicyViolation({
          reason: "maxBodyBytes must be positive",
        });
      }
    }),
  );

export const staticPolicy =
  (options: DynamicWorkerStaticPolicyOptions = {}): DynamicWorkerPolicy =>
  ({ request }) =>
    Effect.withSpan("agentos.dynamic_worker.static_policy")(
      Effect.gen(function* () {
        const maxTimeoutMs = options.maxTimeoutMs ?? DYNAMIC_WORKER_MAX_TIMEOUT_MS;
        if (request.timeoutMs > maxTimeoutMs) {
          return yield* new DynamicWorkerPolicyViolation({
            reason: `timeoutMs exceeds policy cap ${maxTimeoutMs}`,
          });
        }
        const maxCodeBytes = options.maxCodeBytes ?? 64_000;
        if (byteLength(request.code) > maxCodeBytes) {
          return yield* new DynamicWorkerPolicyViolation({
            reason: `code exceeds policy cap ${maxCodeBytes}`,
          });
        }
        const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        const requestedMaxBody = request.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        if (requestedMaxBody > maxBodyBytes) {
          return yield* new DynamicWorkerPolicyViolation({
            reason: `maxBodyBytes exceeds policy cap ${maxBodyBytes}`,
          });
        }
        const requestedEgress = request.egress ?? { mode: "none" as const };
        const allowEgress = options.allowEgress ?? false;
        if (requestedEgress.mode === "none") {
          return;
        }
        if (allowEgress === false) {
          return yield* new DynamicWorkerPolicyViolation({
            reason: "egress is disabled",
          });
        }
        const allowed = new Set(allowEgress);
        const blocked = requestedEgress.hosts.filter((host) => !allowed.has(host));
        if (blocked.length > 0) {
          return yield* new DynamicWorkerPolicyViolation({
            reason: `egress host not allowed: ${blocked.join(",")}`,
          });
        }
      }),
    );
