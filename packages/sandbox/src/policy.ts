import { Effect } from "effect";

import {
  DEFAULT_MAX_OUTPUT_BYTES,
  SANDBOX_MAX_TIMEOUT_MS,
  type SandboxPolicy,
  SandboxPolicyDenied,
  type SandboxRunRequest,
  type StaticPolicyOptions,
} from "./types";

export const validateRequest = (
  request: SandboxRunRequest,
): Effect.Effect<void, SandboxPolicyDenied> =>
  Effect.gen(function* () {
    // Tool callers need one closed failure channel; malformed requests surface
    // as PolicyDenied rather than expanding the tool result error algebra.
    if (request.command.trim().length === 0) {
      return yield* new SandboxPolicyDenied({ reason: "command must be non-empty" });
    }
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      return yield* new SandboxPolicyDenied({ reason: "timeoutMs must be positive" });
    }
    if (request.timeoutMs > SANDBOX_MAX_TIMEOUT_MS) {
      return yield* new SandboxPolicyDenied({
        reason: `timeoutMs exceeds ${SANDBOX_MAX_TIMEOUT_MS}`,
      });
    }
    const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
      return yield* new SandboxPolicyDenied({
        reason: "maxOutputBytes must be positive",
      });
    }
  });

export const staticPolicy = (
  options: StaticPolicyOptions = {},
): SandboxPolicy =>
  ({ request }) =>
    Effect.gen(function* () {
      const maxTimeoutMs = options.maxTimeoutMs ?? SANDBOX_MAX_TIMEOUT_MS;
      if (request.timeoutMs > maxTimeoutMs) {
        return yield* new SandboxPolicyDenied({
          reason: `timeoutMs exceeds policy cap ${maxTimeoutMs}`,
        });
      }
      const requestedNetwork = request.network ?? { mode: "none" as const };
      const allowNetwork = options.allowNetwork ?? false;
      if (requestedNetwork.mode === "none") {
        return;
      }
      if (allowNetwork === false) {
        return yield* new SandboxPolicyDenied({ reason: "network is disabled" });
      }
      const allowed = new Set(allowNetwork);
      const blocked = requestedNetwork.hosts.filter((host) => !allowed.has(host));
      if (blocked.length > 0) {
        return yield* new SandboxPolicyDenied({
          reason: `network host not allowed: ${blocked.join(",")}`,
        });
      }
    });
