/**
 * @agent-os/ops-api — public barrel.
 *
 *
 * v0 is an HTTP projection of @agent-os/runtime Cloudflare backend RPC. It owns
 * no storage and ships no default ScopeResolver / OpsAuth.
 */

export { mountOpsApi, type AgentDOIntrospection, type MountOpsApiOptions } from "./mount";

export type {
  ScopeResolver,
  ScopeSummary,
  ResolvedScope,
  ScopeSurface,
  OpsAuth,
  OpsAction,
  OpsPrincipal,
  AttemptKey,
  RunStatus,
  RunListSpec,
  RunListPage,
  RunSummary,
} from "./types";

export { encodeAttemptKey, decodeAttemptKey } from "./encoding";

export type { OpsErrorBody, OpsErrorCode } from "./errors";
