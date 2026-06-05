import type {
  BackendProtocolEventIdentity,
  BackendProtocolTruthIdentity,
} from "@agent-os/backend-protocol";
import type { AuthorityRef } from "@agent-os/kernel/effect-claim";
import { RUNTIME_FACT_OWNER } from "@agent-os/runtime";

export const testTruthIdentity = (
  scopeId: string,
  effectAuthorityRef: AuthorityRef = { authorityClass: "effect", authorityId: scopeId },
): BackendProtocolTruthIdentity => ({
  scopeRef: { kind: "conversation", scopeId },
  effectAuthorityRef,
});

export const testEventIdentity = (
  scopeId: string,
  effectAuthorityRef?: AuthorityRef,
): BackendProtocolEventIdentity => ({
  ...testTruthIdentity(scopeId, effectAuthorityRef),
  factOwnerRef: RUNTIME_FACT_OWNER,
});
