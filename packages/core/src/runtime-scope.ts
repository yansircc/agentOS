/**
 * RuntimeScope resolver.
 *
 * Resolves typed ScopeRef values into stable carrier-safe keys. Stateful roots
 * are a separate operation and are valid only for `kind: "session"`.
 */

import type { ScopeRef } from "./effect-claim";

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

const encodeScopePart = (value: string): string =>
  encodeURIComponent(value).replace(/\./g, "%2E");

export const runtimeScopeKey = (scopeRef: ScopeRef): string => {
  switch (scopeRef.kind) {
    case "external":
      return [
        "external",
        encodeScopePart(scopeRef.systemRef),
        encodeScopePart(scopeRef.scopeId),
      ].join(":");
    default:
      return [scopeRef.kind, encodeScopePart(scopeRef.scopeId)].join(":");
  }
};

export const resolveRuntimeScope = (
  scopeRef: ScopeRef,
): RuntimeScopeResolution => ({
  scopeRef,
  scopeKey: runtimeScopeKey(scopeRef),
  ownerKind: scopeRef.kind,
  ...(scopeRef.kind === "external"
    ? { externalSystemRef: scopeRef.systemRef }
    : {}),
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

  const root = ["session", encodeScopePart(scopeRef.scopeId), carrierRef].join(
    "/",
  );
  return {
    ok: true,
    stateRoot: `agentos://${root}`,
    cleanupRef: `cleanup://${root}`,
  };
};
