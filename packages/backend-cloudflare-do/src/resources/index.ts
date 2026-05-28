/**
 * Resources public barrel.
 *
 * Replaces the former monolithic `packages/backend-cloudflare-do/src/resources.ts`
 * (519 lines). Dir-as-module — `from "./resources"` callers continue
 * to resolve here.
 *
 *   resources.ts  Resources Tag + ResourcesLive (orchestration)
 *   projection.ts Pure projectRows + loadState + types
 *   payload.ts    Schema decoders for resource.* event rows (leaf)
 */

export { Resources, ResourcesLive, type ResourceProjection } from "./resources";
