import {
  CapabilityRejected,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  SqlError,
  UnsupportedScopeRef,
  isCoreClaimedEventKind,
} from "@agent-os/core/errors";
import {
  isAuthorityRef,
  isScopeRef,
  makeOperationRef,
  makePreClaim,
} from "@agent-os/core/effect-claim";
import { materialRefKey, type BindingMaterialRef } from "@agent-os/core/material-ref";
import {
  DISPATCH_RETRY_POLICY,
  backendProtocolTruthIdentityKey,
  copyTraceContext,
  dispatchLedgerDeliveryReceipt,
  settleDispatchInboundAccepted,
  type BackendProtocolEventIdentity,
  type BackendProtocolTruthIdentity,
  type DispatchEnvelope,
  type DispatchRequestedPayload,
} from "@agent-os/core/backend-protocol";
import {
  InvalidTraceContext,
  validateOptionalTraceContext,
} from "@agent-os/core/telemetry-protocol";

export interface NodePostgresDispatchToScopeSpec {
  readonly target: BackendProtocolTruthIdentity & { readonly bindingRef: BindingMaterialRef };
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly traceContext?: unknown;
}

export const prepareNodePostgresDispatchRequest = (
  identity: BackendProtocolEventIdentity,
  spec: NodePostgresDispatchToScopeSpec,
  hasTarget: (bindingKey: string) => boolean,
): DispatchRequestedPayload => {
  if (isCoreClaimedEventKind(spec.event)) {
    throw new CapabilityRejected({ event: spec.event, capability: "cap_app" });
  }
  const bindingKey = materialRefKey(spec.target.bindingRef);
  if (!hasTarget(bindingKey)) {
    throw new DispatchTargetNotFound({ bindingRef: bindingKey });
  }
  if (!isScopeRef(spec.target.scopeRef)) {
    throw new UnsupportedScopeRef({ scopeId: "malformed", position: "target" });
  }
  if (!isAuthorityRef(spec.target.effectAuthorityRef)) {
    throw new SqlError({ cause: "dispatch target effectAuthorityRef malformed" });
  }
  const traceContextResult = validateOptionalTraceContext(spec.traceContext);
  if (!traceContextResult.ok) {
    throw new InvalidTraceContext({
      position: "dispatch",
      reason: traceContextResult.reason,
    });
  }
  const sourceScope = backendProtocolTruthIdentityKey(identity);
  const targetScope = backendProtocolTruthIdentityKey(spec.target);
  const claim = makePreClaim({
    operationRef: makeOperationRef("dispatch", [
      sourceScope,
      bindingKey,
      targetScope,
      spec.idempotencyKey,
    ]),
    scopeRef: spec.target.scopeRef,
    effectAuthorityRef: {
      authorityId: "cap_dispatch",
      authorityClass: "effect",
    },
    originRef: {
      originId: sourceScope,
      originKind: "agent_do",
    },
  });
  return {
    target: spec.target,
    event: spec.event,
    data: spec.data,
    idempotencyKey: spec.idempotencyKey,
    retryPolicy: DISPATCH_RETRY_POLICY,
    claim,
    ...(traceContextResult.traceContext === undefined
      ? {}
      : { traceContext: copyTraceContext(traceContextResult.traceContext) }),
  };
};

export const assertNodePostgresDispatchEnvelope = (
  identity: BackendProtocolEventIdentity,
  envelope: DispatchEnvelope,
): string => {
  const scopeLabel = backendProtocolTruthIdentityKey(identity);
  if (envelope.targetScope !== scopeLabel) {
    throw new DispatchScopeMismatch({ expected: scopeLabel, actual: envelope.targetScope });
  }
  if (isCoreClaimedEventKind(envelope.event)) {
    throw new CapabilityRejected({ event: envelope.event, capability: "cap_app" });
  }
  return scopeLabel;
};

export const nodePostgresDispatchReceipt = (targetScope: string, deliveredEventId: number) => ({
  deliveredEventId,
  receipt: dispatchLedgerDeliveryReceipt({
    targetScope,
    deliveredEventId,
  }),
});

export const nodePostgresDispatchAcceptedPayload = (
  envelope: DispatchEnvelope,
  scopeLabel: string,
  deliveredEventId: number,
): unknown => {
  const traceContextResult = validateOptionalTraceContext(envelope.traceContext);
  if (!traceContextResult.ok) {
    throw new InvalidTraceContext({
      position: "dispatch",
      reason: traceContextResult.reason,
    });
  }
  const claim = settleDispatchInboundAccepted(envelope.claim, {
    sourceScope: envelope.sourceScope,
    targetScope: scopeLabel,
    deliveredEventId,
  });
  return {
    sourceScope: envelope.sourceScope,
    outboundEventId: envelope.outboundEventId,
    idempotencyKey: envelope.idempotencyKey,
    deliveredEventId,
    claim,
    ...(traceContextResult.traceContext === undefined
      ? {}
      : { traceContext: copyTraceContext(traceContextResult.traceContext) }),
  };
};
