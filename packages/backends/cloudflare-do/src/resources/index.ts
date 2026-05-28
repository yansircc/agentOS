/**
 * Resources public barrel.
 *
 * Replaces the former monolithic `packages/backends/cloudflare-do/src/resources.ts`
 * (519 lines). Dir-as-module — `from "./resources"` callers continue
 * to resolve here.
 *
 *   resources.ts  Resources Tag + ResourcesLive (orchestration)
 *   projection.ts Pure projectRows + loadState + types
 *   payload.ts    Schema decoders for resource.* event rows (leaf)
 */

export { Resources, type ResourceProjection } from "@agent-os/runtime";
export { ResourcesLive } from "./resources";
