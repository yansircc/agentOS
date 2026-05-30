# @agent-os/backend-protocol API

## Public exports

- `.:DISPATCH_INBOUND_ACCEPTED`
- `.:DISPATCH_EVENT_KINDS`
- `.:DISPATCH_MAX_ATTEMPTS`
- `.:DISPATCH_OUTBOUND_DELIVERED`
- `.:DISPATCH_OUTBOUND_FAILED`
- `.:DISPATCH_OUTBOUND_REQUESTED`
- `.:DISPATCH_RETRY_POLICY`
- `.:DUE_WORK_DELIVERY_RETRY`
- `.:DUE_WORK_RECONCILER_RUN`
- `.:DUE_WORK_SCHEDULED_EVENT`
- `.:DURABLE_TRIGGER_SCHEDULED_REQUESTED`
- `.:copyTraceContext`
- `.:describeDispatchCause`
- `.:dispatchBackoffMs`
- `.:dispatchExternalDeliveryReceipt`
- `.:dispatchPayloadParseFailure`
- `.:durableTriggerBackoffMs`
- `.:durableTriggerDuePayload`
- `.:eventToProtocolRpc`
- `.:fireBackendEventHandlers`
- `.:isDueWorkKind`
- `.:parseDispatchBindingRef`
- `.:parseDurableTriggerRetryPolicy`
- `.:parseDueWorkPayload`
- `.:parseRequestedPayload`
- `.:parseRequestedPayloadValue`
- `.:parseScheduledEventIntentPayload`
- `.:reconcilerRunIntentPayload`
- `.:scheduledEventIntentPayload`
- `.:parseTraceContext`
- `.:BackendProtocolEventHandler`
- `.:BackendProtocolLedgerEventRpc`
- `.:DurableTriggerDuePayload`
- `.:DurableTriggerIntentPayload`
- `.:DurableTriggerKind`
- `.:DurableTriggerRetryPolicy`
- `.:DispatchOutboundDeliveredPayload`
- `.:DispatchOutboundFailedPayload`
- `.:DispatchPayloadParseFailure`
- `.:DispatchPayloadParseResult`
- `.:DispatchDeliveryReceipt`
- `.:DispatchRequestedPayload`
- `.:DeliveryRetryDuePayload`
- `.:DueWorkKind`
- `.:DueWorkPayload`
- `.:ReconcilerRunDuePayload`
- `.:ReconcilerRunIntentPayload`
- `.:ScheduledEventDuePayload`
- `.:ScheduledEventIntentPayload`

- `.:dispatchCarrierRef`
- `.:dispatchLedgerDeliveryReceipt`
- `.:dispatchSettlementContract`
- `.:parseDispatchLivedClaim`
- `.:settleDispatchInboundAccepted`
- `.:settleDispatchOutboundDelivered`

## Experimental exports

None.

## Internal-only exports

None.
