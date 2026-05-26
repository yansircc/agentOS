import {
  DEFAULT_MAX_BODY_BYTES,
  DynamicWorkerFailure,
  DynamicWorkerPolicyDenied,
  type DynamicWorkerRunSuccess,
  type DynamicWorkerToolResult,
} from "./types";

export const truncateUtf8 = (
  text: string,
  maxBytes: number,
): { readonly head: string; readonly bytes: number; readonly truncated: boolean } => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { head: text, bytes: encoded.length, truncated: false };
  }
  const head = new TextDecoder().decode(encoded.slice(0, maxBytes));
  return { head, bytes: encoded.length, truncated: true };
};

export const toDynamicWorkerToolResult = (
  result: DynamicWorkerRunSuccess,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): DynamicWorkerToolResult => {
  const body = truncateUtf8(result.body, maxBodyBytes);
  return {
    ok: true,
    status: result.status,
    headers: result.headers,
    bodyHead: body.head,
    bodyBytes: body.bytes,
    bodyTruncated: body.truncated,
    durationMs: result.durationMs,
    workerId: result.workerId,
  };
};

export const failureToToolResult = (
  failure: DynamicWorkerFailure | DynamicWorkerPolicyDenied,
  durationMs: number,
  maxBodyBytes: number,
): DynamicWorkerToolResult => {
  const isPolicy = failure._tag === "agent_os.dynamic_worker_policy_denied";
  const body = truncateUtf8(isPolicy ? "" : failure.body ?? "", maxBodyBytes);
  return {
    ok: false,
    bodyHead: body.head,
    bodyBytes: body.bytes,
    bodyTruncated: body.truncated,
    durationMs,
    workerId: isPolicy ? "policy" : failure.workerId ?? "unknown",
    failureCode: isPolicy ? "PolicyDenied" : failure.code,
    reason: failure.reason,
    ...(isPolicy || failure.status === undefined ? {} : { status: failure.status }),
  };
};
