/**
 * @agent-os/ops-htmx — SSR + HTMX read-only console.
 *
 * Spec: docs/specs/spec-36-ops-ui-htmx.md
 *
 * v0 renders HTML from @agent-os/ops-api GET responses. It owns no storage,
 * no scope resolver, no AgentDOBase access, and no mutation routes.
 */

export { isOpsHtmxPath, mountOpsHtmx } from "./mount";

export type { MountOpsHtmxOptions, OpsApiFetch } from "./types";
