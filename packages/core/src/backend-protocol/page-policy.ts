export interface BackendPagePolicy {
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

export const BACKEND_PAGE_POLICY = {
  defaultLimit: 1_000,
  maxLimit: 1_000,
} as const satisfies BackendPagePolicy;

export const normalizeBackendPageLimit = (
  limit: number | undefined,
  policy: BackendPagePolicy = BACKEND_PAGE_POLICY,
): number => {
  if (limit === undefined || !Number.isFinite(limit)) return policy.defaultLimit;
  return Math.max(0, Math.min(policy.maxLimit, Math.floor(limit)));
};
