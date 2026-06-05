/**
 * RuntimeScope resolver.
 *
 * Resolves typed ScopeRef values into stable carrier-safe keys. Stateful roots
 * are a separate operation and are valid only for `kind: "session"`.
 */

import { scopeRefKey, type ScopeRef } from "./effect-claim";

export type RuntimeScopeKind = ScopeRef["kind"];

export interface RuntimeScopeResolution {
  readonly scopeRef: ScopeRef;
  readonly scopeKey: string;
  readonly ownerKind: RuntimeScopeKind;
  readonly externalSystemRef?: string;
}

export type StatefulScopeRootResult =
  | { readonly ok: true; readonly stateRoot: string; readonly cleanupRef: string }
  | {
      readonly ok: false;
      readonly reason: "scope_kind_is_not_session";
      readonly kind: RuntimeScopeKind;
    };

export const runtimeScopeKey = scopeRefKey;

export const resolveRuntimeScope = (scopeRef: ScopeRef): RuntimeScopeResolution => ({
  scopeRef,
  scopeKey: runtimeScopeKey(scopeRef),
  ownerKind: scopeRef.kind,
  ...(scopeRef.kind === "external" ? { externalSystemRef: scopeRef.systemRef } : {}),
});

export const resolveStatefulSessionRoot = (
  scopeRef: ScopeRef,
  carrierRef: string,
): StatefulScopeRootResult => {
  if (scopeRef.kind !== "session") {
    return {
      ok: false,
      reason: "scope_kind_is_not_session",
      kind: scopeRef.kind,
    };
  }

  const scopeKeyPart = encodeURIComponent(scopeRef.scopeId).replace(/\./g, "%2E");
  const root = ["session", scopeKeyPart, carrierRef].join("/");
  return {
    ok: true,
    stateRoot: `agentos://${root}`,
    cleanupRef: `cleanup://${root}`,
  };
};
