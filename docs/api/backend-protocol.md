# @agent-os/backend-protocol API

## Public exports

- `.:DISPATCH_INBOUND_ACCEPTED`
- `.:DISPATCH_EVENT_KINDS`
- `.:DISPATCH_MAX_ATTEMPTS`
- `.:DISPATCH_OUTBOUND_DELIVERED`
- `.:DISPATCH_OUTBOUND_FAILED`
- `.:DISPATCH_OUTBOUND_REQUESTED`
- `.:DISPATCH_RETRY_POLICY`
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
- `.:parseDispatchBindingRef`
- `.:parseDurableTriggerRetryPolicy`
- `.:parseIntentPointerDuePayload`
- `.:parseRequestedPayload`
- `.:parseRequestedPayloadValue`
- `.:parseScheduledEventIntentPayload`
- `.:scheduledEventIntentPayload`
- `.:parseTraceContext`
- `.:BackendProtocolEventHandler`
- `.:BackendProtocolLedgerEventRpc`
- `.:DurableTriggerRetryPolicy`
- `.:DispatchOutboundDeliveredPayload`
- `.:DispatchOutboundFailedPayload`
- `.:DispatchPayloadParseFailure`
- `.:DispatchPayloadParseResult`
- `.:DispatchDeliveryReceipt`
- `.:DispatchRequestedPayload`
- `.:IntentPointerDuePayload`
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
