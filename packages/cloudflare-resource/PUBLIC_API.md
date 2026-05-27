# @agent-os/cloudflare-resource Public API

Status: 1.0 target for provider-neutral algebra. Live D1 backend exports may be added under the same manifest when implemented.

## Frozen exports

- `.:CLOUDFLARE_RESOURCE_AUTHORITIES`
- `.:CLOUDFLARE_RESOURCE_EVENTS`
- `.:CLOUDFLARE_RESOURCE_EVENT_PREFIX`
- `.:CLOUDFLARE_RESOURCE_EVENT_VOCABULARY`
- `.:CloudflareResourceBindRequest`
- `.:CloudflareResourceBoundPayload`
- `.:CloudflareResourceCarrier`
- `.:CloudflareD1Fetch`
- `.:CloudflareD1FetchInit`
- `.:CloudflareD1FetchResponse`
- `.:CloudflareD1MutationInput`
- `.:CloudflareD1ResourceCarrierOptions`
- `.:CloudflareKVNamespaceFetch`
- `.:CloudflareKVNamespaceFetchInit`
- `.:CloudflareKVNamespaceFetchResponse`
- `.:CloudflareKVNamespaceMutationInput`
- `.:CloudflareKVNamespaceResourceCarrierOptions`
- `.:CloudflareQueueFetch`
- `.:CloudflareQueueFetchInit`
- `.:CloudflareQueueFetchResponse`
- `.:CloudflareQueueMutationInput`
- `.:CloudflareQueueResourceCarrierOptions`
- `.:CloudflareR2BucketFetch`
- `.:CloudflareR2BucketFetchInit`
- `.:CloudflareR2BucketFetchResponse`
- `.:CloudflareR2BucketMutationInput`
- `.:CloudflareR2BucketResourceCarrierOptions`
- `.:CloudflareResourceDestroyRequest`
- `.:CloudflareResourceDestroyedPayload`
- `.:CloudflareResourceEventKind`
- `.:CloudflareResourceFailedPayload`
- `.:CloudflareResourceFailure`
- `.:CloudflareResourceLedgerEvent`
- `.:CloudflareResourceLifecycleStep`
- `.:CloudflareResourceMutationFact`
- `.:CloudflareResourceMutationRecordedPayload`
- `.:CloudflareResourceMutationRequest`
- `.:CloudflareResourceProjection`
- `.:CloudflareResourceProvisionRequest`
- `.:CloudflareResourceProvisionedPayload`
- `.:CloudflareWorkflowFetch`
- `.:CloudflareWorkflowFetchInit`
- `.:CloudflareWorkflowFetchResponse`
- `.:CloudflareWorkflowMutationInput`
- `.:CloudflareWorkflowResourceCarrierOptions`
- `.:cloudflareResourceAuthorityContracts`
- `.:cloudflareResourceBoundaryContract`
- `.:cloudflareResourceExtensionPackage`
- `.:cloudflareResourceFailedPayload`
- `.:cloudflareResourceRejectionKind`
- `.:commitCloudflareResourceBound`
- `.:commitCloudflareResourceDestroyed`
- `.:commitCloudflareResourceFailed`
- `.:commitCloudflareResourceMutationRecorded`
- `.:commitCloudflareResourceProvisioned`
- `.:makeCloudflareD1ResourceCarrier`
- `.:makeCloudflareKVNamespaceResourceCarrier`
- `.:makeCloudflareQueueResourceCarrier`
- `.:makeCloudflareR2BucketResourceCarrier`
- `.:makeCloudflareWorkflowResourceCarrier`
- `.:projectCloudflareResource`
- `.:settleCloudflareResourceRejected`

## Experimental exports

None.

## Internal-only exports

Any package file or symbol not listed above.
