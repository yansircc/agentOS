/**
 * @agent-os/ops-htmx — SSR + HTMX read-only console.
 *
 *
 * v0 renders HTML from @agent-os/ops-api GET responses. It owns no storage,
 * no scope resolver, no Cloudflare backend access, and no mutation routes.
 */

export { isOpsHtmxPath, mountOpsHtmx } from "./mount";

export type { MountOpsHtmxOptions, OpsApiFetch } from "./types";
