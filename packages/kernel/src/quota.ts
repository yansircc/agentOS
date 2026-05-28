import type { Tool } from "./tools";

export interface QuotaSpec {
  readonly key?: string;
  readonly windowMs: number;
  readonly limit: number;
  readonly amount?: number;
}

export function withQuota<A, R>(tool: Tool<A, R>, spec: QuotaSpec): Tool<A, R> {
  return { ...tool, quota: spec };
}
