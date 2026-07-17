# @agent-os/runtime Public API Intent

## Cloudflare Workspace Identity Boundary

`./cloudflare:createCloudflareSandboxWorkspaceEnvResolver` and
`./cloudflare:createCloudflareWorkspaceEnvResolver` are the public host
composition boundary for installation-persistent workspaces. Authenticated
`scope` alone selects `sandboxId` and `workspaceRef`; runtime-owned `runId`
selects only a transient lease over that workspace. Same-scope runs converge,
cross-scope runs diverge, and lease cleanup does not evict the scope resource.

Generated `workspace@1` Cloudflare targets with `scope.idSource="submit_scope"`
derive scope from the named Durable Object routing identity. They do not accept
tenant, installation, sandbox, or workspace selectors in submit input and do
not emit deployment-time operational workspace constants. Generated host paths
without an authenticated scope source fail closed; they must not fall back to a
manifest scope.

`./cloudflare:cloudflareDefaultTruthIdentityFromRoutingScope` is the runtime-owned
projection from that authenticated routing scope to ledger truth identity. It
derives both `scopeRef` and `effectAuthorityRef` from the same scope; generated
submit, inspection, and event paths must share it instead of combining dynamic
scope with manifest-owned authority.

## Cloudflare Material Resolver Boundary

`./cloudflare:defineCloudflareMaterialResolverFactory` is the public host
composition boundary for generated Cloudflare targets. An app authors
`agent/material-resolver.ts` and adapts its typed D1, KV, Durable Object,
service, or secret-vault bindings into a `RefResolver`. Generated code passes
the raw Worker env to that factory and caches one resolver per env object; it
does not expect Wrangler to inject a JavaScript resolver object.

The factory receives each runtime-owned `MaterialResolutionRequest`, including
its authenticated `truthIdentity`, symbolic `materialRef`, and optional
expected version. The app-owned resolver enforces tenant authorization and
version policy. Resolved values remain scoped resources and are disposed by the
provider-call acquire/use/release boundary; submit input, ledger events,
projections, diagnostics, traces, and generated configuration carry only
symbolic refs and safe resolution status.

Generated `cloudflare-do@1` builds fail closed when
`agent/material-resolver.ts` is absent or non-regular. A `node@1` build rejects
that Cloudflare-only authored module; node hosts continue to inject the shared
`RefResolver` contract through their own composition boundary.

## Local Runtime Boundary

`./local:createLocalAgentRuntime` is the public dev/test harness. It exposes the
local runtime as `submit`, `events`, `diagnostics`, and `inspect` over the same
lowering substrate used by generated local targets.

`./local:lowerLocalAgentRuntime` is the product lowerer used by generated
`node@1` `LocalAgentApp` output. Use it, or the generated app, when product
sessions, workflows, channels, schedules, dynamic capability wiring, generated
target identity, or `submitWithProductLink` are part of the boundary. It is not
a license to duplicate raw `resolveRuntime + submitAgentEffect +
workspaceOperations` assembly in product code.

`./local:CreateLocalAgentRuntimeOptions.initialEvents` is the local
runtime-ledger hydration input for product-shell backends that persist the
runtime ledger outside the live process. Hydration accepts only a complete,
contiguous ledger prefix for the same runtime truth identity, and validates
runtime protocol events plus generic decision-gate events before installing
them into the local runtime. It is the continuation source for
`inspectInputRequest`, `resumeInputRequest`, and `decideInputRequest`; partial
event slices and product-owned facts fail closed.

`./local:createLocalRuntimeLedgerSource` is the read-only product-shell
projection source for persisted local ledger events. It projects run inspection
and input-request settlement from ledger facts without constructing a second
product store. Runtime events own run lifecycle and interruption state;
decision-gate events own generic input-request settlement.

`./local:createLocalRuntimeLedgerSnapshotSseResponse` and
`./local:encodeLocalRuntimeLedgerSnapshotSse` project that source as a finite
SSE response. They emit the current ledger snapshot and close; they do not
simulate live append notifications or polling semantics.

Product links are runtime evidence links only. agentOS owns runtime run ids,
terminal runtime status, tool events, diagnostics, and evidence correlation.
Product applications own product control-plane facts such as Change, Candidate,
Grant, Intent, Receipt, approval, deployment, and product receipt records.

## In-Memory Assembly Boundary

`./capability:resolveRuntimeInstallGraph` is the backend-neutral capability
resolver. It validates declarations and install output without constructing an
in-memory backend or selecting terminal Effect execution.

`./in-memory:resolveRuntime` materializes that graph into the in-memory adapter.
It requires an explicit `InMemoryRuntimeExecution` supplied by the concrete
host; the in-memory assembler does not own a global Effect runtime. This is an
advanced host-composition surface, not the ordinary product entrypoint. Local
products use `./local:createLocalAgentRuntime`,
`./local:lowerLocalAgentRuntime`, or a generated app and continue to receive
Promise/Response facades.

## Decision Gate Boundary

`./decision-gate` owns the public constructor/projection surface for
generic runtime input-request settlement. They let product backends construct
and inspect approval, rejection, cancellation, expiration, and consumption
facts without copying `decision_gate.*` payload grammar.

These exports own only runtime continuation refs and opaque product correlation
refs such as `subjectRef` and `decisionRef`. They do not own product
vocabulary such as Candidate, Grant, Receipt, preview, deployment, or
capability-flow facts.

`prepareInputRequestDecisionResume` is the generic product-shell handoff recipe
for an already-approved input request. It reads runtime and `decision_gate.*`
ledger facts, validates the request resume payload against the input-request
kind, and returns both the runtime resume command payload and the
`decision_gate.consumed` event spec. Product backends still own capability
evaluation, policy enforcement, product decision writes, and durable product
operation/receipt facts.

## External Effect Boundary

`./external-effect` is the public vocabulary-neutral runner for one
idempotent external-effect attempt. It owns only the orchestration join between
"no existing attempt" and "found existing attempt" over caller-owned `Event`,
`Request`, `Projection`, and `AttemptKey` types.

`projectExternalEffectAttempt` projects caller-owned attempt events into a
neutral status plus caller-owned evidence refs. It does not define receipt
schema, witness schema, terminal product meaning, or a record store.

`defineExternalEffectAttempt` is only a type-fixing helper over the same
runner. It lets callers bind their `Spec`, `Event`, `Projection`, `Request`,
and `AttemptKey` algebra once while leaving the Effect `E` and `R` channels to
the supplied effects.

It does not own claim envelopes, ledger event records, receipt envelopes,
witness models, record stores, idempotency-key derivation, provider material, or
product control-plane vocabulary. Concrete callers supply those facts through
their own carrier/projection contracts.

`./testing` exposes external-effect conformance as an adapter-driven report.
Adapters must map their caller-owned events, requests, projections, witnesses,
receipts, and external-system outcomes to each scenario's required observation
keys. The helper validates the report shape; it does not define product facts or
durable-operation vocabulary.

`./testing` also exposes the executable backend conformance harness. Core owns the
ordered law manifest and report contract; runtime/testing owns only driver execution.
`runBackendConformance` returns the Effect program that evaluates every required law
with a fresh driver and validates the result through the core protocol. The concrete
test or process host owns terminal execution. `registerBackendConformanceSuite` maps
the same law bodies into a caller-provided test registrar without importing a test
framework.

The scenario set is partitioned by executable owner. Runner-owned join
scenarios are limited to `request_before_effect`,
`duplicate_attempt_reuses_existing`, `running_replay_uses_caller_request`, and
`running_replay_does_not_duplicate_request`; tests may prove those solely by
calling the existing runner surface with caller-supplied functions. Crash
reconcile, witness/provider indeterminate handling, digest or contract mismatch,
invalid projection rejection, error-channel preservation, R-channel
non-leakage, canonical-ref protection, and receipt-backed neutral attempt
projection remain adapter-observed. The conformance report can require
observations for those cases, but agentOS does
not execute or define the caller's receipt, witness, provider, reconcile, or
product-control-plane lifecycle.

`LedgerArchive` is the backend-neutral archive/eviction service. Implementations
must preserve one logical ledger across archive and hot storage and fail closed on
receipt, checksum, chain, or hot-row mismatch.

## Public exports

- `.:Admission`
- `.:BoundaryEvents`
- `.:Dispatch`
- `.:Ledger`
- `.:LedgerArchive`
- `.:Quota`
- `.:Resources`
- `./admission:Admission`
- `./ag-ui:AG_UI_WIRE_COMPATIBILITY`
- `./ag-ui:AgUiContext`
- `./ag-ui:AgUiContextSchema`
- `./ag-ui:AgUiCustomFrame`
- `./ag-ui:AgUiEventType`
- `./ag-ui:AgUiFrame`
- `./ag-ui:AgUiFrameSafetyIssue`
- `./ag-ui:AgUiFrameSafetySpec`
- `./ag-ui:AgUiInputRequestResumeBinding`
- `./ag-ui:AgUiLedgerEnvelopeFrame`
- `./ag-ui:AgUiLedgerEnvelopeProjectionSpec`
- `./ag-ui:AgUiLedgerEventEnvelope`
- `./ag-ui:AgUiLedgerProjectionSpec`
- `./ag-ui:AgUiMessage`
- `./ag-ui:AgUiMessageRole`
- `./ag-ui:AgUiMessageRoleSchema`
- `./ag-ui:AgUiMessageSchema`
- `./ag-ui:AgUiReasoningFrame`
- `./ag-ui:AgUiRecordedLedgerEvent`
- `./ag-ui:AgUiResumeEntrySchema`
- `./ag-ui:AgUiRunAgentInput`
- `./ag-ui:AgUiRunAgentInputSchema`
- `./ag-ui:agUiRunAgentInputToSubmitInput`
- `./ag-ui:AgUiRunErrorFrame`
- `./ag-ui:AgUiRunFinishedFrame`
- `./ag-ui:AgUiRunStartedFrame`
- `./ag-ui:AgUiRuntimeProjectionSpec`
- `./ag-ui:AgUiSafeEventFrameProjector`
- `./ag-ui:AgUiSafeEventProjector`
- `./ag-ui:AgUiSafeLedgerEvent`
- `./ag-ui:AgUiSafeValue`
- `./ag-ui:AgUiSseChunk`
- `./ag-ui:AgUiSubmitDefaults`
- `./ag-ui:AgUiTextMessageContentFrame`
- `./ag-ui:AgUiTextMessageEndFrame`
- `./ag-ui:AgUiTextMessageStartFrame`
- `./ag-ui:AgUiTool`
- `./ag-ui:AgUiToolCallArgsFrame`
- `./ag-ui:AgUiToolCallEndFrame`
- `./ag-ui:AgUiToolCallResultFrame`
- `./ag-ui:AgUiToolCallStartFrame`
- `./ag-ui:AgUiToolSchema`
- `./ag-ui:decodeAgUiRecordedLedgerEvent`
- `./ag-ui:decodeAgUiRunAgentInput`
- `./ag-ui:decodeLedgerEventToAgUiEnvelope`
- `./ag-ui:encodeAgUiLedgerEventEnvelopeSse`
- `./ag-ui:framesForAgUiLedgerEnvelope`
- `./ag-ui:framesForAgUiLedgerEnvelopes`
- `./ag-ui:projectLedgerEventsToAgUiEnvelopes`
- `./ag-ui:projectLedgerEventsToAgUiFrames`
- `./ag-ui:projectLedgerEventToAgUiEnvelope`
- `./ag-ui:projectLedgerSseToAgUiEnvelopes`
- `./ag-ui:projectLedgerSseToAgUiSse`
- `./ag-ui:projectSafeLedgerEventToAgUiFrames`
- `./ag-ui:projectToolsToAgUiTools`
- `./ag-ui:projectToolToAgUiTool`
- `./ag-ui:verifyAgUiFrameSafety`
- `./attached-stream:AnyAttachedStreamHandler`
- `./attached-stream:AttachedStreamCancellationMode`
- `./attached-stream:AttachedStreamCancelResult`
- `./attached-stream:AttachedStreamCancelSpec`
- `./attached-stream:AttachedStreamCtx`
- `./attached-stream:AttachedStreamDetachMode`
- `./attached-stream:AttachedStreamHandler`
- `./attached-stream:AttachedStreamHandlerOutput`
- `./attached-stream:AttachedStreamOutputSource`
- `./attached-stream:attachedStreamParseFail`
- `./attached-stream:attachedStreamParseOk`
- `./attached-stream:AttachedStreamParseResult`
- `./attached-stream:AttachedStreamQueue`
- `./attached-stream:AttachedStreamRegistry`
- `./attached-stream:AttachedStreamRegistryMap`
- `./attached-stream:AttachedStreams`
- `./attached-stream:AttachedStreamSendResult`
- `./attached-stream:AttachedStreamSendSpec`
- `./attached-stream:AttachedStreamServiceError`
- `./attached-stream:AttachedStreamSession`
- `./attached-stream:AttachedStreamsService`
- `./attached-stream:AttachedStreamStartSpec`
- `./attached-stream:AttachedStreamTerminal`
- `./attached-stream:AttachedStreamTerminalCommitAck`
- `./attached-stream:AttachedStreamTerminalCommitSpec`
- `./attached-stream:AttachedStreamTx`
- `./attached-stream:createAttachedStreamQueue`
- `./attached-stream:getAttachedStreamHandler`
- `./attached-stream:makeAttachedStreamRegistry`
- `./attached-stream:MakeAttachedStreamRegistryOptions`
- `./attached-stream:makeAttachedStreamService`
- `./attached-stream:MakeAttachedStreamServiceSpec`
- `./attached-stream:runSynchronousAttachedStreamCommit`
- `./boundary-commit:boundaryCommitIdentity`
- `./boundary-commit:BoundaryCommitIdentity`
- `./boundary-commit:BoundaryCommitRejected`
- `./boundary-commit:commitBoundaryEvent`
- `./boundary-commit:validateBoundaryEventPayload`
- `./boundary-commit:validateCommittedBoundaryEvent`
- `./boundary-events:BoundaryEvents`
- `./capability:CapabilityConfigRequirement`
- `./capability:CapabilityContract`
- `./capability:CapabilityEventHandlerContext`
- `./capability:CapabilityHostFactRequirement`
- `./capability:CapabilityInstallation`
- `./capability:CapabilityInstallContext`
- `./capability:CapabilityPeerRequirement`
- `./capability:CapabilityRequirement`
- `./capability:CapabilityRequirements`
- `./capability:CapabilityRuntimeHandle`
- `./capability:CapabilitySecretRequirement`
- `./capability:createCapabilityResolverRuntime`
- `./capability:defineCapability`
- `./capability:DefineCapabilitySpec`
- `./capability:defineHost`
- `./capability:DefineHostSpec`
- `./capability:DynamicCapabilityResolverDefinition`
- `./capability:DynamicCapabilityResolverServiceInput`
- `./capability:DynamicCapabilityResolverServiceIssue`
- `./capability:DynamicCapabilityResolverServiceResult`
- `./capability:HostProfile`
- `./capability:HostProvidedFact`
- `./capability:makeDynamicCapabilityContext`
- `./capability:nodeHost`
- `./capability:PreflightDiagnostic`
- `./capability:PreflightDiagnosticSink`
- `./capability:ResolvedCapabilityEventHandlerFactory`
- `./capability:ResolvedCapabilityInstallGraph`
- `./capability:ResolvedHostFacts`
- `./capability:resolveRuntimeInstallGraph`
- `./capability:ResolveRuntimeInstallGraphOptions`
- `./capability:ResolveRuntimeInstallGraphResult`
- `./capability:runDynamicCapabilityResolvers`
- `./capability:WORKSPACE_OPERATION_HOST_FACT`
- `./capability:WorkspaceOperationBindingEnvResolverInput`
- `./capability:WorkspaceOperationEnvResolver`
- `./capability:WorkspaceOperationEnvResolverInput`
- `./capability:WorkspaceOperationHostFacts`
- `./capability:WorkspaceOperationRequestedEnvResolverInput`
- `./capability:workspaceOperations`
- `./capability:WorkspaceOperationsOptions`
- `./channel:ChannelContext`
- `./channel:ChannelDispatch`
- `./channel:ChannelHandler`
- `./channel:ChannelMethod`
- `./channel:ChannelPrincipal`
- `./channel:ChannelRequest`
- `./channel:ChannelRoute`
- `./channel:ChannelRuntime`
- `./channel:ChannelSubmit`
- `./channel:ChannelVerifier`
- `./channel:createChannelContext`
- `./channel:defineChannel`
- `./channel:DefinedChannel`
- `./channel:del`
- `./channel:get`
- `./channel:patch`
- `./channel:post`
- `./channel:put`
- `./cloudflare:AgentAttachedStreamCancelSpec`
- `./cloudflare:AgentAttachedStreamSpec`
- `./cloudflare:AgentDeclaredIntent`
- `./cloudflare:AgentDurableObjectConfig`
- `./cloudflare:AgentEventHandlerContext`
- `./cloudflare:AgentEventHandlerRegistration`
- `./cloudflare:AgentRuntimeClient`
- `./cloudflare:AgentRuntimeReaderClient`
- `./cloudflare:AgentSubmitSpec`
- `./cloudflare:AgentTriggerCancelSpec`
- `./cloudflare:AgentTriggerIntentSpec`
- `./cloudflare:AgentWorkspaceJobSpec`
- `./cloudflare:CloudflareAgentBindingSource`
- `./cloudflare:CloudflareAgentDeploymentSpec`
- `./cloudflare:CloudflareAgentDriverConfig`
- `./cloudflare:CloudflareAgentEnv`
- `./cloudflare:CloudflareAgentMount`
- `./cloudflare:cloudflareAgentMountPort`
- `./cloudflare:CloudflareAgentMountPort`
- `./cloudflare:CloudflareAgentProjectionSinks`
- `./cloudflare:CloudflareAgentProjectionSource`
- `./cloudflare:CloudflareAttachedStreamFactory`
- `./cloudflare:CloudflareAttachedStreamFactoryContext`
- `./cloudflare:CloudflareAttachedStreamSource`
- `./cloudflare:cloudflareDefaultTruthIdentityFromRoutingScope`
- `./cloudflare:CloudflareLedgerSseSource`
- `./cloudflare:CloudflareMaterialResolverBindings`
- `./cloudflare:CloudflareMaterialResolverFactory`
- `./cloudflare:CloudflareSandboxTransport`
- `./cloudflare:CloudflareSandboxWorkspaceClient`
- `./cloudflare:CloudflareSandboxWorkspaceEnvResolverOptions`
- `./cloudflare:CloudflareSandboxWorkspaceNamespace`
- `./cloudflare:CloudflareTriggerFactory`
- `./cloudflare:CloudflareTriggerFactoryContext`
- `./cloudflare:CloudflareTriggerSource`
- `./cloudflare:CloudflareWorkspaceEnvBinding`
- `./cloudflare:CloudflareWorkspaceEnvLease`
- `./cloudflare:CloudflareWorkspaceEnvResolver`
- `./cloudflare:CloudflareWorkspaceEnvResolverError`
- `./cloudflare:CloudflareWorkspaceEnvResolverInput`
- `./cloudflare:CloudflareWorkspaceEnvResolverOptions`
- `./cloudflare:CloudflareWorkspaceIdentityInput`
- `./cloudflare:CloudflareWorkspaceJobProjectionReader`
- `./cloudflare:CloudflareWorkspaceJobResponseOptions`
- `./cloudflare:CloudflareWorkspaceJobResponseProjection`
- `./cloudflare:CloudflareWorkspaceLeaseIdentity`
- `./cloudflare:createAgentDurableObject`
- `./cloudflare:createCloudflareLedgerAgUiHistorySseResponse`
- `./cloudflare:createCloudflareLedgerAgUiSseResponse`
- `./cloudflare:createCloudflareSandboxWorkspaceEnvResolver`
- `./cloudflare:createCloudflareWorkspaceEnvResolver`
- `./cloudflare:createCloudflareWorkspaceJobResponse`
- `./cloudflare:defineCloudflareMaterialResolverFactory`
- `./cloudflare:DispatchTargetNamespace`
- `./cloudflare:DispatchTargetRegistry`
- `./cloudflare:durableObjectDispatchTarget`
- `./cloudflare:httpDispatchTarget`
- `./cloudflare:HttpDispatchTargetSpec`
- `./cloudflare:makeCloudflareWorkspaceEnv`
- `./cloudflare:materializeCloudflareAgentDeployment`
- `./cloudflare:MaterializedAgentConfig`
- `./cloudflare:mountCloudflareAgent`
- `./cloudflare:providerDispatchTarget`
- `./cloudflare:ProviderDispatchTargetSpec`
- `./cloudflare:queueDispatchTarget`
- `./cloudflare:QueueDispatchTargetBinding`
- `./cloudflare/do-rpc:DURABLE_OBJECT_RPC_INVOKE`
- `./cloudflare/do-rpc:durableObjectRpcClient`
- `./cloudflare/do-rpc:DurableObjectRpcClient`
- `./cloudflare/do-rpc:DurableObjectRpcErrorV1`
- `./cloudflare/do-rpc:durableObjectRpcInvoke`
- `./cloudflare/do-rpc:DurableObjectRpcRejected`
- `./cloudflare/do-rpc:DurableObjectRpcResult`
- `./cloudflare/do-rpc:DurableObjectRpcServer`
- `./cloudflare/do-rpc:FunctionFree`
- `./cloudflare/ops-api:AgentDOIntrospection`
- `./cloudflare/ops-api:AttemptKey`
- `./cloudflare/ops-api:CloudflareAgentDOIntrospectionRpc`
- `./cloudflare/ops-api:cloudflareAgentDoOpsStubFor`
- `./cloudflare/ops-api:CloudflareAgentDOResolvedScope`
- `./cloudflare/ops-api:decodeAttemptKey`
- `./cloudflare/ops-api:encodeAttemptKey`
- `./cloudflare/ops-api:mountOpsApi`
- `./cloudflare/ops-api:MountOpsApiOptions`
- `./cloudflare/ops-api:OpsAction`
- `./cloudflare/ops-api:OpsAuth`
- `./cloudflare/ops-api:OpsErrorBody`
- `./cloudflare/ops-api:OpsErrorCode`
- `./cloudflare/ops-api:OpsPrincipal`
- `./cloudflare/ops-api:ResolvedScope`
- `./cloudflare/ops-api:RunListPage`
- `./cloudflare/ops-api:RunListSpec`
- `./cloudflare/ops-api:RunStatus`
- `./cloudflare/ops-api:RunSummary`
- `./cloudflare/ops-api:ScopeResolver`
- `./cloudflare/ops-api:ScopeSummary`
- `./cloudflare/ops-api:ScopeSurface`
- `./continuation:ContinuationProjection`
- `./continuation:ContinuationResumeDecisionResult`
- `./continuation:fingerprintFailureDiagnostic`
- `./continuation:projectContinuation`
- `./continuation:projectContinuationRefs`
- `./continuation:projectRecoveryAttemptBudget`
- `./continuation:submitResumeDecisionFromContinuationProjection`
- `./decision-gate:DECISION_GATE_EVENTS`
- `./decision-gate:DECISION_GATE_KIND`
- `./decision-gate:decisionGateCancelledEvent`
- `./decision-gate:DecisionGateCancelledPayload`
- `./decision-gate:DecisionGateClosedEventSpec`
- `./decision-gate:decisionGateConsumedEvent`
- `./decision-gate:DecisionGateConsumedEventSpec`
- `./decision-gate:DecisionGateConsumedPayload`
- `./decision-gate:decisionGateDecidedEvent`
- `./decision-gate:DecisionGateDecidedEventSpec`
- `./decision-gate:DecisionGateDecidedPayload`
- `./decision-gate:DecisionGateDecision`
- `./decision-gate:DecisionGateEventIdentitySpec`
- `./decision-gate:DecisionGateEventKind`
- `./decision-gate:decisionGateExpiredEvent`
- `./decision-gate:DecisionGateExpiredPayload`
- `./decision-gate:DecisionGateLedgerEvent`
- `./decision-gate:DecisionGateProjection`
- `./decision-gate:decisionGateRequestedEvent`
- `./decision-gate:DecisionGateRequestedEventSpec`
- `./decision-gate:DecisionGateRequestedPayload`
- `./decision-gate:decisionGateSettlementRef`
- `./decision-gate:settleDecisionGateConsumed`
- `./dispatch:Dispatch`
- `./external-effect:DefinedExternalEffectAttempt`
- `./external-effect:defineExternalEffectAttempt`
- `./external-effect:ExternalEffectAttemptLookup`
- `./external-effect:ExternalEffectAttemptProjection`
- `./external-effect:ExternalEffectAttemptProjectionStatus`
- `./external-effect:ExternalEffectKnownAttemptProjectionStatus`
- `./external-effect:ExternalEffectRequestedState`
- `./external-effect:projectExternalEffectAttempt`
- `./external-effect:ProjectExternalEffectAttemptSpec`
- `./external-effect:runExternalEffectAttempt`
- `./external-effect:RunExternalEffectAttemptSpec`
- `./in-memory:createInMemoryRuntimeBackend`
- `./in-memory:InMemoryAdmissionLive`
- `./in-memory:InMemoryAttachedStreamsLive`
- `./in-memory:InMemoryBoundaryEventsLive`
- `./in-memory:InMemoryDispatchLive`
- `./in-memory:InMemoryDispatchTargetRegistry`
- `./in-memory:InMemoryEventHandlerRegistration`
- `./in-memory:InMemoryEventSpec`
- `./in-memory:InMemoryEventSubscription`
- `./in-memory:InMemoryLedgerLive`
- `./in-memory:InMemoryLlmTransportLive`
- `./in-memory:InMemoryLlmTransportOptions`
- `./in-memory:InMemoryMaterializedProjectionsLive`
- `./in-memory:InMemoryQuotaLive`
- `./in-memory:InMemoryResourcesLive`
- `./in-memory:InMemoryRuntimeBackend`
- `./in-memory:InMemoryRuntimeExecution`
- `./in-memory:InMemoryRuntimeServices`
- `./in-memory:InMemorySchedulerLive`
- `./in-memory:makeInMemoryRuntimeLayer`
- `./in-memory:ResolvedRuntime`
- `./in-memory:ResolvedRuntimeInstallGraph`
- `./in-memory:resolveRuntime`
- `./in-memory:ResolveRuntimeOptions`
- `./in-memory:ResolveRuntimeResult`
- `./input-request:InputRequestDecisionResumeResult`
- `./input-request:InputRequestProjection`
- `./input-request:InputRequestResumeDecisionResult`
- `./input-request:prepareInputRequestDecisionResume`
- `./input-request:projectInputRequest`
- `./input-request:projectInputRequests`
- `./input-request:projectInputRequestSettlement`
- `./input-request:submitResumeDecisionFromInputRequestProjection`
- `./inspection:InspectionBindingSummary`
- `./inspection:InspectionCompileSection`
- `./inspection:InspectionExecutionDomain`
- `./inspection:InspectionExecutionDomainBinding`
- `./inspection:InspectionExecutionDomainReplayLaw`
- `./inspection:InspectionGraphRegistration`
- `./inspection:InspectionHostFactStatus`
- `./inspection:InspectionManifestSummary`
- `./inspection:InspectionNamedBinding`
- `./inspection:InspectionReceiptBackedToolBinding`
- `./inspection:InspectionResolveSection`
- `./inspection:InspectionRuntimeSection`
- `./inspection:InspectionSnapshot`
- `./inspection:InspectionToolAuthority`
- `./inspection:InspectionToolBinding`
- `./inspection:InspectionToolExecution`
- `./inspection:InspectionToolExecutionDeterministic`
- `./inspection:InspectionToolExecutionExternal`
- `./inspection:InspectionToolIntentBinding`
- `./inspection:InspectionUnavailableSection`
- `./inspection:projectInspectionSnapshot`
- `./inspection:ProjectInspectionSnapshotInput`
- `./ledger-archive:decodeLedgerArchiveSegments`
- `./ledger-archive:LedgerArchive`
- `./ledger-archive:LedgerArchiveError`
- `./ledger-archive:mergeLedgerArchiveEvents`
- `./ledger-archive:queryLedgerArchiveEvents`
- `./ledger-archive:StoredLedgerArchiveSegment`
- `./ledger:Ledger`
- `./ledger:recordLedgerPortEvent`
- `./ledger:recordLedgerPortEvents`
- `./ledger:runtimeStorageError`
- `./ledger:RuntimeStorageError`
- `./ledger:RuntimeStorageOperation`
- `./ledger:runtimeStorageOrJsonError`
- `./llm-effect-ai/anthropic:AnthropicEffectAiLlmTransportLive`
- `./llm-effect-ai/anthropic:defaultEffectAiLanguageModelFactory`
- `./llm-effect-ai/anthropic:makeAnthropicEffectAiLlmTransportLayer`
- `./llm-effect-ai/openai-compatible:makeOpenAiCompatibleLlmTransportLayer`
- `./llm-effect-ai/openai-compatible:OpenAiCompatibleLlmTransportLive`
- `./llm-effect-ai/openai-compatible:OpenAiCompatibleProviderMaterialPreflightInput`
- `./llm-effect-ai/openai-compatible:preflightOpenAiCompatibleProviderMaterial`
- `./llm-effect-ai/openai-compatible:ProviderMaterialPreflightDiagnostic`
- `./local:createLocalAgentRuntime`
- `./local:CreateLocalAgentRuntimeOptions`
- `./local:createLocalRuntimeLedgerSnapshotSseResponse`
- `./local:createLocalRuntimeLedgerSource`
- `./local:createLocalWorkspaceEnv`
- `./local:CreateLocalWorkspaceEnvOptions`
- `./local:encodeLocalRuntimeLedgerSnapshotSse`
- `./local:LocalAgentRuntime`
- `./local:LocalAgentRuntimeLlm`
- `./local:LocalAgentRuntimeLlmPreflight`
- `./local:LocalAgentRuntimeLlmPreflightInput`
- `./local:LocalAgentRuntimeResolveError`
- `./local:LocalAgentRuntimeTarget`
- `./local:LocalAgentRuntimeTestLlm`
- `./local:LocalAgentRuntimeTransportLlm`
- `./local:LocalAgentSubmitInput`
- `./local:LocalRuntimeLedgerHydrationError`
- `./local:LocalRuntimeLedgerSnapshotSource`
- `./local:LocalRuntimeLedgerSnapshotSseOptions`
- `./local:LocalRuntimeLedgerSource`
- `./local:LocalRuntimeLedgerSourceOptions`
- `./local:LocalWorkspaceEnvError`
- `./local:LoweredLocalAgentRuntime`
- `./local:lowerLocalAgentRuntime`
- `./local:LowerLocalAgentRuntimeOptions`
- `./local:validateLocalRuntimeLedgerHydrationEvents`
- `./node:FactOwnerRef`
- `./node:NodePostgresBackend`
- `./node:NodePostgresBackendOptions`
- `./node:NodePostgresEventSubscription`
- `./node:nodePostgresProjectionKey`
- `./node:nodePostgresRuntimeIdentity`
- `./projection:AnyMaterializedProjectionDefinition`
- `./projection:applyProjectionEvent`
- `./projection:applyProjectionEventResult`
- `./projection:defineProjection`
- `./projection:getProjection`
- `./projection:makeProjectionRegistry`
- `./projection:makeProjectionRegistryResult`
- `./projection:MaterializedProjectionDefinition`
- `./projection:MaterializedProjectionEventIdentity`
- `./projection:MaterializedProjectionGetSpec`
- `./projection:MaterializedProjectionListSpec`
- `./projection:MaterializedProjectionRebuildResult`
- `./projection:MaterializedProjectionRegistry`
- `./projection:MaterializedProjectionRow`
- `./projection:MaterializedProjections`
- `./projection:MaterializedProjectionStatus`
- `./projection:ProjectionApplicationError`
- `./projection:ProjectionApplyEventResult`
- `./projection:ProjectionApplyResult`
- `./projection:ProjectionCurrentLookup`
- `./projection:ProjectionCurrentRow`
- `./projection:projectionDelete`
- `./projection:ProjectionDelete`
- `./projection:projectionFail`
- `./projection:ProjectionFail`
- `./projection:ProjectionIdentifyMalformed`
- `./projection:ProjectionIdentifyOk`
- `./projection:ProjectionIdentifyResult`
- `./projection:ProjectionIdentifySkip`
- `./projection:projectionIdentity`
- `./projection:projectionKeep`
- `./projection:ProjectionKeep`
- `./projection:projectionMalformed`
- `./projection:projectionPut`
- `./projection:ProjectionPut`
- `./projection:ProjectionReduceContext`
- `./projection:ProjectionReduceResult`
- `./projection:ProjectionReducerReturnedThenable`
- `./projection:ProjectionRegistry`
- `./projection:ProjectionRegistryBuildResult`
- `./projection:ProjectionRegistryError`
- `./projection:projectionSkip`
- `./projection:ProjectionStatus`
- `./projection:ProjectionWaitSpec`
- `./projection:ProjectionWaitTimedOut`
- `./projection:UnregisteredProjectionKind`
- `./projection:waitForProjection`
- `./quota:Quota`
- `./resources:Resources`
- `./run-projector:AgentSessionListProjection`
- `./run-projector:AgentSessionProjection`
- `./run-projector:AgentSessionStatus`
- `./run-projector:AgentSessionTurnLinksProjection`
- `./run-projector:AgentSessionTurnProjection`
- `./run-projector:AgentSessionTurnRuntimeLink`
- `./run-projector:projectAgentSession`
- `./run-projector:projectAgentSessions`
- `./run-projector:projectAgentSessionTurnLinks`
- `./run-projector:projectInputRequestSettlement`
- `./run-projector:projectRunInspection`
- `./run-projector:projectRunsPage`
- `./run-projector:projectRunStatus`
- `./run-projector:projectRunTrace`
- `./run-projector:projectSubmitResult`
- `./run-projector:projectWorkflowRun`
- `./run-projector:projectWorkflowRunLinks`
- `./run-projector:projectWorkflowRuns`
- `./run-projector:RUN_BEARING_KINDS`
- `./run-projector:RunInspection`
- `./run-projector:RunInspectionDiagnostic`
- `./run-projector:WorkflowRunAttemptProjection`
- `./run-projector:WorkflowRunError`
- `./run-projector:WorkflowRunLinksProjection`
- `./run-projector:WorkflowRunListProjection`
- `./run-projector:WorkflowRunProjection`
- `./run-projector:WorkflowRunRuntimeLink`
- `./run-projector:WorkflowRunStatus`
- `./runtime-diagnostic:RUNTIME_DIAGNOSTIC_EVENT_PREFIX`
- `./runtime-diagnostic:RUNTIME_DIAGNOSTIC_EVENTS`
- `./runtime-diagnostic:RUNTIME_DIAGNOSTIC_FACT_OWNER`
- `./runtime-diagnostic:RUNTIME_DIAGNOSTIC_KIND`
- `./runtime-diagnostic:RUNTIME_DIAGNOSTIC_RESERVED_KINDS`
- `./runtime-diagnostic:runtimeDiagnosticBoundaryContract`
- `./runtime-diagnostic:runtimeDiagnosticBoundaryModule`
- `./runtime-diagnostic:runtimeDiagnosticCarrier`
- `./runtime-diagnostic:runtimeDiagnosticSettlementContract`
- `./schedule:createScheduleContext`
- `./schedule:cronMinuteExpression`
- `./schedule:CronMinuteExpression`
- `./schedule:DefinedSchedule`
- `./schedule:defineSchedule`
- `./schedule:dispatchScheduleFire`
- `./schedule:dispatchScheduleFireDelivery`
- `./schedule:projectScheduleFireHistory`
- `./schedule:projectScheduleIngressDeliveryHistory`
- `./schedule:ScheduleContext`
- `./schedule:ScheduleContextSpec`
- `./schedule:ScheduleDefinition`
- `./schedule:ScheduleDefinitionProjection`
- `./schedule:scheduledMinute`
- `./schedule:ScheduledMinute`
- `./schedule:ScheduleFireBaseProjection`
- `./schedule:ScheduleFireDeliveryDispatchInput`
- `./schedule:ScheduleFireDeliveryDispatchResult`
- `./schedule:ScheduleFireDispatchedEventSpec`
- `./schedule:ScheduleFireDispatchInput`
- `./schedule:ScheduleFireDispatchResult`
- `./schedule:ScheduleFireFailedEventSpec`
- `./schedule:ScheduleFireHistoryProjection`
- `./schedule:ScheduleFireHistorySpec`
- `./schedule:scheduleFireId`
- `./schedule:ScheduleFireIdentitySpec`
- `./schedule:ScheduleFireProductProjection`
- `./schedule:ScheduleFireProjection`
- `./schedule:ScheduleFireRequestedEventSpec`
- `./schedule:ScheduleFireSessionProductProjection`
- `./schedule:ScheduleFireStatus`
- `./schedule:ScheduleFireWorkflowProductProjection`
- `./schedule:ScheduleHandler`
- `./schedule:SchedulePrincipal`
- `./schedule:ScheduleRuntime`
- `./schedule:ScheduleSessions`
- `./schedule:ScheduleSessionSubmitTurnInput`
- `./schedule:ScheduleWorkflowRunInput`
- `./schedule:ScheduleWorkflows`
- `./scheduler:Scheduler`
- `./sse-http:createAttachedStreamSseResponse`
- `./sse-http:createSseHttpResponse`
- `./sse-http:createSseHttpTextResponse`
- `./sse-http:createSseHttpWritableResponse`
- `./sse-http:decodeSseHttpEvents`
- `./sse-http:encodeSseHttpData`
- `./sse-http:encodeSseHttpEvent`
- `./sse-http:encodeSseHttpJsonEvent`
- `./sse-http:parseSseHttpEventBlock`
- `./sse-http:responseToSseHttpChunks`
- `./sse-http:SSE_HTTP_CONTENT_TYPE`
- `./sse-http:SseHttpChunk`
- `./sse-http:SseHttpEvent`
- `./sse-http:SseHttpResponseOptions`
- `./sse-http:SseHttpSource`
- `./sse-http:SseHttpWritableResponse`
- `./structured-output:decodeStructuredOutputFromItems`
- `./structured-output:StructuredDecodeResult`
- `./submit-live:decodeSubmitLiveFrame`
- `./submit-live:encodeSubmitLiveFrame`
- `./submit-live:RecordedLlmStreamFrame`
- `./submit-live:recordLlmStreamFrame`
- `./submit-live:SUBMIT_LIVE_MAX_FRAME_BYTES`
- `./submit-live:SubmitLiveFrame`
- `./submit-live:SubmitLiveFrameError`
- `./telemetry-otlp:OTLP_GENAI_SEMCONV_MAPPING_VERSION`
- `./telemetry-otlp:OtlpAttributeValue`
- `./telemetry-otlp:OtlpProjection`
- `./telemetry-otlp:OtlpProjectionSpan`
- `./telemetry-otlp:projectOtlpSpans`
- `./telemetry-tree:projectTelemetryEventTree`
- `./testing:BackendConformanceLawExecution`
- `./testing:BackendConformanceRegistrar`
- `./testing:ContractDispatchReceiver`
- `./testing:ContractDispatchTargetAdapter`
- `./testing:createBackendConformanceLaws`
- `./testing:createInMemoryWorkspaceEnv`
- `./testing:CreateInMemoryWorkspaceEnvOptions`
- `./testing:EXTERNAL_EFFECT_ADAPTER_OBSERVED_SCENARIOS`
- `./testing:EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS`
- `./testing:EXTERNAL_EFFECT_RUNNER_JOIN_SCENARIOS`
- `./testing:externalEffectConformance`
- `./testing:ExternalEffectConformanceAdapter`
- `./testing:ExternalEffectConformanceEvidence`
- `./testing:ExternalEffectConformanceIssue`
- `./testing:ExternalEffectConformanceReport`
- `./testing:ExternalEffectConformanceScenario`
- `./testing:ExternalEffectConformanceScenarioId`
- `./testing:ExternalEffectConformanceScenarioOwnership`
- `./testing:ExternalEffectConformanceScenarioReport`
- `./testing:ExternalEffectConformanceScenarioResult`
- `./testing:InMemoryWorkspaceEnvError`
- `./testing:InMemoryWorkspaceExecScript`
- `./testing:registerBackendConformanceSuite`
- `./testing:runBackendConformance`
- `./testing:RuntimeBackendContractDriver`
- `./testing:RuntimeBackendContractDriverFactory`
- `./testing:RuntimeBackendContractSuiteOptions`
- `./testing:RuntimeBackendDispatchSpec`
- `./testing:RuntimeBackendLedgerCommitSpec`
- `./tool-settlement:settleToolAdmissionRejected`
- `./tool-settlement:settleToolExecuted`
- `./tool-settlement:settleToolExecutionRejected`
- `./tool-settlement:settleToolPolicyRejected`
- `./tool-settlement:toolErrorReason`
- `./tool-settlement:toolExecutionRejectionKind`
- `./tool-settlement:toolSettlementContract`
- `./trigger:AcquireCtx`
- `./trigger:AnyDurableTrigger`
- `./trigger:DEFAULT_TRIGGER_ACQUIRE_DEADLINE_MS`
- `./trigger:DEFAULT_TRIGGER_DRAIN_MAX_ITERATIONS`
- `./trigger:drainTriggerPumpUntilQuiet`
- `./trigger:DurableTrigger`
- `./trigger:DurableTriggerCancellationMode`
- `./trigger:DurableTriggerRegistry`
- `./trigger:getDurableTrigger`
- `./trigger:makeDurableTriggerRegistry`
- `./trigger:runSynchronousTriggerCommit`
- `./trigger:scheduledEventTrigger`
- `./trigger:TriggerCancellation`
- `./trigger:TriggerCancelResult`
- `./trigger:TriggerCancelSpec`
- `./trigger:TriggerDrainResult`
- `./trigger:TriggerDrainUntilQuietOptions`
- `./trigger:TriggerDrainUntilQuietResult`
- `./trigger:TriggerEventSpec`
- `./trigger:TriggerIntentSpec`
- `./trigger:triggerParseFail`
- `./trigger:triggerParseOk`
- `./trigger:TriggerParseResult`
- `./trigger:TriggerPump`
- `./trigger:TriggerRegistry`
- `./trigger:TriggerStuckResult`
- `./trigger:TriggerStuckRow`
- `./trigger:TriggerTx`
- `./witness-port:makeWitnessPort`
- `./witness-port:WitnessPort`
- `./witness-port:WitnessPortIssue`
- `./witness-port:WitnessPortRejected`
- `./witness-port:WitnessPortService`
- `./witness-port:WitnessRequest`
- `./workspace-agent:defineWorkspaceAgentMount`
- `./workspace-agent:isWorkspaceAgentCommandName`
- `./workspace-agent:isWorkspaceAgentProjectionName`
- `./workspace-agent:WORKSPACE_AGENT_COMMAND`
- `./workspace-agent:WORKSPACE_AGENT_PROJECTION`
- `./workspace-agent:WORKSPACE_AGENT_PROJECTION_SCHEMA`
- `./workspace-agent:WorkspaceAgentCommandInputByName`
- `./workspace-agent:WorkspaceAgentCommandName`
- `./workspace-agent:WorkspaceAgentCommandOutputByName`
- `./workspace-agent:WorkspaceAgentCustomCommandInput`
- `./workspace-agent:WorkspaceAgentDecideInputRequestCommandInput`
- `./workspace-agent:WorkspaceAgentDestroyCommandInput`
- `./workspace-agent:WorkspaceAgentDriverMount`
- `./workspace-agent:WorkspaceAgentFileEntry`
- `./workspace-agent:WorkspaceAgentFilesProjection`
- `./workspace-agent:WorkspaceAgentFilesProjectionShape`
- `./workspace-agent:WorkspaceAgentGeneratedMount`
- `./workspace-agent:WorkspaceAgentInspectInputRequestCommandInput`
- `./workspace-agent:WorkspaceAgentMutationCommandOutput`
- `./workspace-agent:WorkspaceAgentProjectionName`
- `./workspace-agent:WorkspaceAgentProjectionRead`
- `./workspace-agent:WorkspaceAgentProjectionSchema`
- `./workspace-agent:WorkspaceAgentProjectionSink`
- `./workspace-agent:WorkspaceAgentProjectionValueByName`
- `./workspace-agent:WorkspaceAgentReadFileCommandInput`
- `./workspace-agent:WorkspaceAgentReadFileCommandOutput`
- `./workspace-agent:WorkspaceAgentReadStateCommandInput`
- `./workspace-agent:WorkspaceAgentReadStateCommandOutput`
- `./workspace-agent:WorkspaceAgentResetCommandInput`
- `./workspace-agent:WorkspaceAgentResumeInputRequestCommandInput`
- `./workspace-agent:WorkspaceAgentStateProjection`
- `./workspace-agent:WorkspaceAgentStateProjectionShape`
- `./workspace-agent:WorkspaceAgentSubmitCommandInput`
- `./workspace-binding:bindWorkspaceToolsForRuntime`
- `./workspace-binding:BindWorkspaceToolsForRuntimeOptions`
- `./workspace-binding:workspaceEnvMaterialRef`
- `./workspace-binding:WorkspaceMutationPolicy`
- `./workspace-binding:WorkspaceShellPolicy`
- `./workspace-binding:WorkspaceToolExposurePolicy`
- `./workspace-binding:WorkspaceToolExposureProfile`
- `./workspace-env:createWorkspaceEnv`
- `./workspace-env:CreateWorkspaceEnvOptions`
- `./workspace-env:createWorkspaceTools`
- `./workspace-env:CreateWorkspaceToolsOptions`
- `./workspace-env:diffWorkspaceFiles`
- `./workspace-env:editWorkspaceFile`
- `./workspace-env:EditWorkspaceFileOptions`
- `./workspace-env:globWorkspaceFiles`
- `./workspace-env:GlobWorkspaceFilesOptions`
- `./workspace-env:grepWorkspaceFiles`
- `./workspace-env:GrepWorkspaceFilesOptions`
- `./workspace-env:normalizeWorkspaceToolPath`
- `./workspace-env:NormalizeWorkspaceToolPathOptions`
- `./workspace-env:walkWorkspaceFiles`
- `./workspace-env:WalkWorkspaceFilesOptions`
- `./workspace-env:WORKSPACE_TOOL_DEFAULT_DECLARATIONS`
- `./workspace-env:WORKSPACE_TOOL_EXPOSURE_PROFILES`
- `./workspace-env:WORKSPACE_TOOL_NAMES`
- `./workspace-env:WORKSPACE_TOOL_SPECS`
- `./workspace-env:WorkspaceBashResult`
- `./workspace-env:WorkspaceEditFileResult`
- `./workspace-env:WorkspaceEnv`
- `./workspace-env:WorkspaceEnvBackend`
- `./workspace-env:WorkspaceEnvInputError`
- `./workspace-env:WorkspaceExecOptions`
- `./workspace-env:WorkspaceExecResult`
- `./workspace-env:WorkspaceFilesDiff`
- `./workspace-env:WorkspaceFileSnapshot`
- `./workspace-env:WorkspaceFileStat`
- `./workspace-env:WorkspaceGlobFilesResult`
- `./workspace-env:WorkspaceGrepFilesResult`
- `./workspace-env:WorkspaceGrepMatch`
- `./workspace-env:WorkspaceGrepMode`
- `./workspace-env:WorkspaceOperationOptions`
- `./workspace-env:WorkspaceReadFileLineRange`
- `./workspace-env:WorkspaceReadFileResult`
- `./workspace-env:WorkspaceToolCategory`
- `./workspace-env:WorkspaceToolDefaultDeclaration`
- `./workspace-env:WorkspaceToolEffect`
- `./workspace-env:WorkspaceToolEnvRef`
- `./workspace-env:WorkspaceToolExecHookInput`
- `./workspace-env:WorkspaceToolHooks`
- `./workspace-env:WorkspaceToolInteractionFloor`
- `./workspace-env:WorkspaceToolName`
- `./workspace-env:WorkspaceToolReceiptPolicy`
- `./workspace-env:WorkspaceTools`
- `./workspace-env:WorkspaceToolSpec`
- `./workspace-env:WorkspaceToolWriteHookInput`
- `./workspace-env:WorkspaceWriteFileResult`
- `./workspace-job-observability:projectWorkspaceJobObservability`
- `./workspace-job-observability:WorkspaceJobFailureExplanation`
- `./workspace-job-observability:WorkspaceJobObservabilityProjection`
- `./workspace-job-observability:WorkspaceJobObservabilityRequest`
- `./workspace-job:runWorkspaceJobEffect`
- `./workspace-job:RunWorkspaceJobSpec`
- `./workspace-job:WorkspaceJobAttemptContext`
- `./workspace-job:WorkspaceJobCandidateMissing`
- `./workspace-job:WorkspaceJobDataPlane`
- `./workspace-job:WorkspaceJobDataPlaneFailed`
- `./workspace-job:WorkspaceJobFinalizedArtifact`
- `./workspace-job:WorkspaceJobRecovery`
- `./workspace-job:WorkspaceJobRepairDecisionInput`
- `./workspace-job:WorkspaceJobRunIdMismatch`
- `./workspace-job:WorkspaceJobSeedFile`
- `./workspace-job:WorkspaceJobTerminalArtifactBuild`
- `./workspace-job:WorkspaceJobTerminalArtifactWriteResult`
- `./workspace-job:WorkspaceJobVerifier`
- `./workspace-job:WorkspaceJobVerifierFailed`
- `./workspace-job:WorkspaceJobVerifierResult`
- `./workspace-op:WORKSPACE_OP_FACT_OWNER`
- `./workspace-op:WORKSPACE_OP_KIND`
- `./workspace-op:WORKSPACE_OP_PROJECTION_KIND`

## Experimental exports

- `./structured-output:StructuredCallFailureClassification`
- `./structured-output:classifyStructuredCallFailure`
- `./structured-output:structuredOutputRequest`
- `./llm-effect-ai:EFFECT_AI_TRANSPORT_ADAPTER_VERSION`
- `./llm-effect-ai:EffectAiAborted`
- `./llm-effect-ai:EffectAiAdapterError`
- `./llm-effect-ai:EffectAiJsonEncodeFailed`
- `./llm-effect-ai:EffectAiLanguageModelFactory`
- `./llm-effect-ai:EffectAiMissingUsage`
- `./llm-effect-ai:EffectAiPromptError`
- `./llm-effect-ai:EffectAiProviderExecutedToolRejected`
- `./llm-effect-ai:EffectAiResolvedRoute`
- `./llm-effect-ai:EffectAiSupportedRoute`
- `./llm-effect-ai:EffectAiToolHandlerCalled`
- `./llm-effect-ai:EffectAiUnsupportedOutputPart`
- `./llm-effect-ai:EffectAiUnsupportedRoute`
- `./llm-effect-ai:OpenAiCompatibleLlmTransportLive`
- `./llm-effect-ai:effectAiPromptFromMessages`
- `./llm-effect-ai:effectAiToolFromDefinition`
- `./llm-effect-ai:effectAiToolkitFromToolDefinitions`
- `./llm-effect-ai:makeEffectAiLlmTransportLayer`
- `./llm-effect-ai:makeOpenAiCompatibleLlmTransportLayer`
- `./llm-effect-ai:normalizeEffectAiResponse`
- `./llm-effect-ai:OpenAiCompatibleProviderMaterialPreflightInput`
- `./llm-effect-ai:preflightOpenAiCompatibleProviderMaterial`
- `./llm-effect-ai:ProviderMaterialPreflightDiagnostic`
- `./llm-effect-ai:resolveEffectAiRoute`
- `./llm-effect-ai:streamEffectAiLanguageModel`

## Internal-only exports

Any package file or symbol not listed above.
