# @agent-os/backend-protocol API

## Public exports

- `.:DISPATCH_INBOUND_ACCEPTED`
- `.:DISPATCH_EVENT_KINDS`
- `.:DISPATCH_MAX_ATTEMPTS`
- `.:DISPATCH_OUTBOUND_DELIVERED`
- `.:DISPATCH_OUTBOUND_FAILED`
- `.:DISPATCH_OUTBOUND_REQUESTED`
- `.:DUE_WORK_DELIVERY_RETRY`
- `.:DUE_WORK_SCHEDULED_EVENT`
- `.:copyTraceContext`
- `.:describeDispatchCause`
- `.:dispatchBackoffMs`
- `.:dispatchPayloadParseFailure`
- `.:eventToProtocolRpc`
- `.:fireBackendEventHandlers`
- `.:isDueWorkKind`
- `.:parseDispatchBindingRef`
- `.:parseDueWorkPayload`
- `.:parseRequestedPayload`
- `.:parseRequestedPayloadValue`
- `.:parseTraceContext`
- `.:BackendProtocolEventHandler`
- `.:BackendProtocolLedgerEventRpc`
- `.:DispatchOutboundDeliveredPayload`
- `.:DispatchOutboundFailedPayload`
- `.:DispatchPayloadParseFailure`
- `.:DispatchPayloadParseResult`
- `.:DispatchDeliveryReceipt`
- `.:DispatchRequestedPayload`
- `.:DeliveryRetryDuePayload`
- `.:DueWorkKind`
- `.:DueWorkPayload`
- `.:ScheduledEventDuePayload`

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
