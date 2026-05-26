/**
 * @agent-os/ops-api — uniform error responses (spec-35 §4)
 */

export type OpsErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "scope_not_found"
  | "run_not_found"
  | "not_introspectable"
  | "method_not_allowed"
  | "upstream_failure";

const STATUS: Record<OpsErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  scope_not_found: 404,
  run_not_found: 404,
  not_introspectable: 501,
  method_not_allowed: 405,
  upstream_failure: 502,
};

export interface OpsErrorBody {
  readonly error: OpsErrorCode;
  readonly message: string;
}

export const opsError = (code: OpsErrorCode, message: string): Response => {
  const body: OpsErrorBody = { error: code, message };
  return new Response(JSON.stringify(body), {
    status: STATUS[code],
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
};

export const jsonOk = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
