import {
  backendProtocolEventIdentityKey,
  type BackendProtocolEventIdentity,
  type BackendProtocolTruthIdentity,
} from "@agent-os/backend-protocol";
import { RUNTIME_FACT_OWNER } from "@agent-os/runtime";

export const truthIdentity = (scopeId: string): BackendProtocolTruthIdentity => ({
  scopeRef: { kind: "conversation", scopeId },
  effectAuthorityRef: { authorityClass: "effect", authorityId: scopeId },
});

export const runtimeEventIdentity = (scopeId: string): BackendProtocolEventIdentity => ({
  ...truthIdentity(scopeId),
  factOwnerRef: RUNTIME_FACT_OWNER,
});

export const projectionScopeKey = (scopeId: string): string =>
  backendProtocolEventIdentityKey(runtimeEventIdentity(scopeId));
