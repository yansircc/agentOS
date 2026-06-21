/**
 * Resources public barrel.
 *
 * Runtime Cloudflare resource modules are split by protocol role
 * (519 lines). Dir-as-module — `from "./resources"` callers continue
 * to resolve here.
 *
 *   resources.ts  Resources Tag + ResourcesLive (orchestration)
 *   projection.ts SQL row loading + backend-protocol projection helpers
 */

export { Resources } from "@agent-os/runtime";
export type { ResourceProjection } from "@agent-os/core/backend-protocol";
export { ResourcesLive } from "./resources";
