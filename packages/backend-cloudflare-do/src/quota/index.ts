/**
 * Quota public barrel.
 *
 *   service.ts    Quota Tag + QuotaLive (runtime service — owns the
 *                 quota_grants / quota_usage projection and emits
 *                 quota.consumed events into the ledger).
 *   decorator.ts  withQuota — application-facing decorator that wraps
 *                 a Tool's `execute` with a Quota.consume gate so apps
 *                 declare quota intent at the tool definition site
 *                 instead of inline at the call site.
 *
 * Two files because the surfaces have different audiences (runtime vs.
 * app) and the decorator is a thin shim that depends on the service
 * Tag — splitting keeps the service free of any application-API
 * concerns.
 */

export * from "./service";
export * from "./decorator";
