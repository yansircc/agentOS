import type { AuthorityRef, ScopeRef } from "@agent-os/kernel/effect-claim";

export const RUNTIME_FACT_OWNER = "@agent-os/runtime" as const;

/**
 * Exact runtime ledger identity used by reads and streams.
 *
 * @agentosPrimitive primitive.runtime.LedgerTruthIdentity
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export interface LedgerTruthIdentity {
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly scope?: never;
}

/**
 * Runtime-owned event commit spec; factOwnerRef is injected by the ledger service.
 *
 * @agentosPrimitive primitive.runtime.LedgerCommitEventSpec
 * @agentosInvariant invariant.ledger.single-commit-source
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export type LedgerCommitEventSpec = {
  readonly ts?: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly factOwnerRef?: never;
  readonly scope?: never;
};
