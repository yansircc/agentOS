import { Predicate } from "effect";
import { isSymbolicSettlementValue } from "@agent-os/core/settlement-contract";

const symbolicReasonOr = (value: string, fallback: string): string =>
  isSymbolicSettlementValue(value) ? value : fallback;

/**
 * Classifies external/runtime causes into ledger-safe symbolic vocabulary.
 *
 * This function is the runtime-owned boundary for data that originated outside
 * agentOS. It may record stable tags, status classes, and provider flags; it
 * must not record thrown messages, response bodies, or provider material.
 */
export const publicRuntimeCauseReason = (cause: unknown): string => {
  if (Predicate.isObject(cause) && cause._tag === "agent_os.provider_http_failure") {
    const provider = symbolicReasonOr(String(cause.provider), "provider");
    const status = typeof cause.status === "number" ? `http_${cause.status}` : "http_error";
    const flags = Array.isArray(cause.flags)
      ? cause.flags
          .filter((flag): flag is string => typeof flag === "string")
          .map((flag) => symbolicReasonOr(flag, "flag"))
          .join(":")
      : "";
    return ["provider_http_failure", provider, status, flags].filter(Boolean).join(":");
  }
  if (Predicate.isObject(cause) && typeof cause.reason === "string") {
    return symbolicReasonOr(cause.reason, "object");
  }
  if (Predicate.isObject(cause) && typeof cause._tag === "string") {
    return symbolicReasonOr(cause._tag, "object");
  }
  if (cause instanceof Error) return symbolicReasonOr(cause.name, "Error");
  return symbolicReasonOr(typeof cause, "unknown");
};
