# @agent-os/runtime Public API Intent

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

Product links are runtime evidence links only. agentOS owns runtime run ids,
terminal runtime status, tool events, diagnostics, and evidence correlation.
Product applications own product control-plane facts such as Change, Candidate,
Grant, Intent, Receipt, approval, deployment, and product receipt records.

## Decision Gate Boundary

Root `decisionGate*` exports are the public constructor/projection surface for
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
`runBackendConformance` runs every required law with a fresh driver and validates the
result through the core protocol. `registerBackendConformanceSuite` maps the same law
bodies into a caller-provided test registrar without importing a test framework.

The scenario set is partitioned by executable owner. Runner-owned join
scenarios are limited to `request_before_effect`,
`duplicate_attempt_reuses_existing`, `running_replay_uses_caller_request`, and
`running_replay_does_not_duplicate_request`; tests may prove those solely by
calling the existing runner surface with caller-supplied functions. Crash
reconcile, witness/provider indeterminate handling, digest or contract mismatch,
invalid projection rejection, error-channel preservation, R-channel
non-leakage, canonical-ref protection, and receipt-backed neutral attempt
projection remain adapter-observed. The
conformance report can require observations for those cases, but agentOS does
not execute or define the caller's receipt, witness, provider, reconcile, or
product-control-plane lifecycle.

## Public exports

- `.:AcquireCtx`
- `.:Admission`
- `.:AgentSessionProjection`
- `.:AgentSessionStatus`
- `.:AgentSessionTurnProjection`
- `.:AgentSessionTurnLinksProjection`
- `.:AgentSessionTurnRuntimeLink`
- `.:AnyAttachedStreamHandler`
- `.:AnyDurableTrigger`
- `.:AnyMaterializedProjectionDefinition`
- `.:applyProjectionEvent`
- `.:applyProjectionEventResult`
- `.:AttachedStreamCancellationMode`
- `.:AttachedStreamCancelResult`
- `.:AttachedStreamCancelSpec`
- `.:AttachedStreamCtx`
- `.:AttachedStreamDetachMode`
- `.:AttachedStreamHandler`
- `.:AttachedStreamHandlerOutput`
- `.:AttachedStreamOutputSource`
- `.:attachedStreamParseFail`
- `.:attachedStreamParseOk`
- `.:AttachedStreamParseResult`
- `.:AttachedStreamQueue`
- `.:AttachedStreamRegistry`
- `.:AttachedStreamRegistryMap`
- `.:AttachedStreams`
- `.:AttachedStreamSendResult`
- `.:AttachedStreamSendSpec`
- `.:AttachedStreamServiceError`
- `.:AttachedStreamSession`
- `.:AttachedStreamsService`
- `.:AttachedStreamStartSpec`
- `.:AttachedStreamTerminal`
- `.:AttachedStreamTerminalCommitAck`
- `.:AttachedStreamTerminalCommitSpec`
- `.:AttachedStreamTx`
- `.:bindWorkspaceToolsForRuntime`
- `.:BindWorkspaceToolsForRuntimeOptions`
- `.:boundaryCommitIdentity`
- `.:BoundaryCommitIdentity`
- `.:BoundaryCommitRejected`
- `.:BoundaryEvents`
- `.:CapabilityContract`
- `.:CapabilityEventHandlerContext`
- `.:CapabilityInstallContext`
- `.:CapabilityInstallation`
- `.:CapabilityRequirement`
- `.:CapabilityRequirements`
- `.:CapabilityRuntimeHandle`
- `.:commitBoundaryEvent`
- `.:ContinuationProjection`
- `.:ContinuationResumeDecisionResult`
- `.:createAttachedStreamQueue`
- `.:createAttachedStreamSseResponse`
- `.:createSseHttpResponse`
- `.:createSseHttpTextResponse`
- `.:createWorkspaceEnv`
- `.:CreateWorkspaceEnvOptions`
- `.:createWorkspaceTools`
- `.:CreateWorkspaceToolsOptions`
- `.:DECISION_GATE_EVENTS`
- `.:DECISION_GATE_KIND`
- `.:decisionGateCancelledEvent`
- `.:DecisionGateCancelledPayload`
- `.:DecisionGateClosedEventSpec`
- `.:decisionGateConsumedEvent`
- `.:DecisionGateConsumedEventSpec`
- `.:DecisionGateConsumedPayload`
- `.:decisionGateDecidedEvent`
- `.:DecisionGateDecidedEventSpec`
- `.:DecisionGateDecidedPayload`
- `.:DecisionGateDecision`
- `.:DecisionGateEventIdentitySpec`
- `.:DecisionGateEventKind`
- `.:decisionGateExpiredEvent`
- `.:DecisionGateExpiredPayload`
- `.:DecisionGateLedgerEvent`
- `.:DecisionGateProjection`
- `.:decisionGateRequestedEvent`
- `.:DecisionGateRequestedEventSpec`
- `.:DecisionGateRequestedPayload`
- `.:decisionGateSettlementRef`
- `.:decodeSseHttpEvents`
- `.:decodeStructuredOutputFromItems`
- `.:DEFAULT_TRIGGER_ACQUIRE_DEADLINE_MS`
- `.:DEFAULT_TRIGGER_DRAIN_MAX_ITERATIONS`
- `.:defineCapability`
- `.:DefineCapabilitySpec`
- `.:defineHost`
- `.:DefineHostSpec`
- `.:defineProjection`
- `.:defineWorkspaceAgentMount`
- `.:diffWorkspaceFiles`
- `.:Dispatch`
- `.:drainTriggerPumpUntilQuiet`
- `.:DurableTrigger`
- `.:DurableTriggerCancellationMode`
- `.:DurableTriggerRegistry`
- `.:editWorkspaceFile`
- `.:EditWorkspaceFileOptions`
- `.:encodeSseHttpData`
- `.:encodeSseHttpEvent`
- `.:encodeSseHttpJsonEvent`
- `.:fingerprintFailureDiagnostic`
- `.:getAttachedStreamHandler`
- `.:getDurableTrigger`
- `.:getProjection`
- `.:globWorkspaceFiles`
- `.:GlobWorkspaceFilesOptions`
- `.:grepWorkspaceFiles`
- `.:GrepWorkspaceFilesOptions`
- `.:HostProfile`
- `.:HostProvidedFact`
- `.:InputRequestDecisionResumeResult`
- `.:InputRequestProjection`
- `.:InputRequestResumeDecisionResult`
- `.:InspectionBindingSummary`
- `.:InspectionCompileSection`
- `.:InspectionExecutionDomain`
- `.:InspectionExecutionDomainBinding`
- `.:InspectionExecutionDomainReplayLaw`
- `.:InspectionGraphRegistration`
- `.:InspectionHostFactStatus`
- `.:InspectionManifestSummary`
- `.:InspectionNamedBinding`
- `.:InspectionReceiptBackedToolBinding`
- `.:InspectionResolveSection`
- `.:InspectionRuntimeSection`
- `.:InspectionSnapshot`
- `.:InspectionToolAuthority`
- `.:InspectionToolBinding`
- `.:InspectionToolExecution`
- `.:InspectionToolExecutionDeterministic`
- `.:InspectionToolExecutionExternal`
- `.:InspectionToolIntentBinding`
- `.:InspectionUnavailableSection`
- `.:isWorkspaceAgentCommandName`
- `.:isWorkspaceAgentProjectionName`
- `.:Ledger`
- `.:makeAttachedStreamRegistry`
- `.:MakeAttachedStreamRegistryOptions`
- `.:makeAttachedStreamService`
- `.:MakeAttachedStreamServiceSpec`
- `.:makeDurableTriggerRegistry`
- `.:makeProjectionRegistry`
- `.:makeProjectionRegistryResult`
- `.:makeWitnessPort`
- `.:MaterializedProjectionDefinition`
- `.:MaterializedProjectionEventIdentity`
- `.:MaterializedProjectionGetSpec`
- `.:MaterializedProjectionListSpec`
- `.:MaterializedProjectionRebuildResult`
- `.:MaterializedProjectionRegistry`
- `.:MaterializedProjectionRow`
- `.:MaterializedProjections`
- `.:MaterializedProjectionStatus`
- `.:normalizeWorkspaceToolPath`
- `.:NormalizeWorkspaceToolPathOptions`
- `.:nodeHost`
- `.:parseSseHttpEventBlock`
- `.:projectAgentSession`
- `.:projectAgentSessionTurnLinks`
- `.:projectContinuation`
- `.:projectContinuationRefs`
- `.:prepareInputRequestDecisionResume`
- `.:projectInputRequest`
- `.:projectInputRequests`
- `.:projectInputRequestSettlement`
- `.:ProjectInspectionSnapshotInput`
- `.:projectInspectionSnapshot`
- `.:ProjectionApplicationError`
- `.:ProjectionApplyEventResult`
- `.:ProjectionApplyResult`
- `.:ProjectionCurrentLookup`
- `.:ProjectionCurrentRow`
- `.:projectionDelete`
- `.:ProjectionDelete`
- `.:projectionFail`
- `.:ProjectionFail`
- `.:ProjectionIdentifyMalformed`
- `.:ProjectionIdentifyOk`
- `.:ProjectionIdentifyResult`
- `.:ProjectionIdentifySkip`
- `.:projectionIdentity`
- `.:projectionKeep`
- `.:ProjectionKeep`
- `.:projectionMalformed`
- `.:projectionPut`
- `.:ProjectionPut`
- `.:ProjectionReduceContext`
- `.:ProjectionReduceResult`
- `.:ProjectionReducerReturnedThenable`
- `.:ProjectionRegistry`
- `.:ProjectionRegistryBuildResult`
- `.:ProjectionRegistryError`
- `.:projectionSkip`
- `.:ProjectionStatus`
- `.:ProjectionWaitSpec`
- `.:ProjectionWaitTimedOut`
- `.:PreflightDiagnostic`
- `.:PreflightDiagnosticSink`
- `.:projectRecoveryAttemptBudget`
- `.:projectRunsPage`
- `.:projectRunInspection`
- `.:projectRunStatus`
- `.:projectRunTrace`
- `.:projectSubmitResult`
- `.:projectTelemetryEventTree`
- `.:projectWorkflowRun`
- `.:projectWorkflowRunLinks`
- `.:projectWorkspaceJobObservability`
- `.:Quota`
- `.:recordLedgerPortEvent`
- `.:recordLedgerPortEvents`
- `.:ResolvedCapabilityEventHandlerFactory`
- `.:ResolvedCapabilityInstallGraph`
- `.:ResolvedHostFacts`
- `.:ResolvedRuntime`
- `.:ResolveRuntimeInstallGraphResult`
- `.:ResolveRuntimeOptions`
- `.:ResolveRuntimeResult`
- `.:resolveRuntime`
- `.:resolveRuntimeInstallGraph`
- `.:RunInspection`
- `.:RunInspectionDiagnostic`
- `.:Resources`
- `.:responseToSseHttpChunks`
- `.:RUN_BEARING_KINDS`
- `.:RUNTIME_DIAGNOSTIC_EVENTS`
- `.:RUNTIME_DIAGNOSTIC_EVENT_PREFIX`
- `.:RUNTIME_DIAGNOSTIC_FACT_OWNER`
- `.:RUNTIME_DIAGNOSTIC_KIND`
- `.:RUNTIME_DIAGNOSTIC_RESERVED_KINDS`
- `.:runtimeDiagnosticBoundaryContract`
- `.:runtimeDiagnosticBoundaryModule`
- `.:runtimeDiagnosticCarrier`
- `.:runtimeDiagnosticSettlementContract`
- `.:runSynchronousAttachedStreamCommit`
- `.:runSynchronousTriggerCommit`
- `.:runtimeStorageError`
- `.:RuntimeStorageError`
- `.:RuntimeStorageOperation`
- `.:runtimeStorageOrJsonError`
- `.:runWorkspaceJobEffect`
- `.:RunWorkspaceJobSpec`
- `.:scheduledEventTrigger`
- `.:Scheduler`
- `.:settleDecisionGateConsumed`
- `.:settleToolAdmissionRejected`
- `.:settleToolExecuted`
- `.:settleToolExecutionRejected`
- `.:settleToolPolicyRejected`
- `.:SSE_HTTP_CONTENT_TYPE`
- `.:SseHttpChunk`
- `.:SseHttpEvent`
- `.:SseHttpResponseOptions`
- `.:SseHttpSource`
- `.:StructuredDecodeResult`
- `.:submitResumeDecisionFromContinuationProjection`
- `.:submitResumeDecisionFromInputRequestProjection`
- `.:Tool`
- `.:ToolDefinition`
- `.:toolErrorReason`
- `.:toolExecutionRejectionKind`
- `.:toolSettlementContract`
- `.:TriggerCancellation`
- `.:TriggerCancelResult`
- `.:TriggerCancelSpec`
- `.:TriggerDrainResult`
- `.:TriggerDrainUntilQuietOptions`
- `.:TriggerDrainUntilQuietResult`
- `.:TriggerEventSpec`
- `.:TriggerIntentSpec`
- `.:triggerParseFail`
- `.:triggerParseOk`
- `.:TriggerParseResult`
- `.:TriggerPump`
- `.:TriggerRegistry`
- `.:TriggerStuckResult`
- `.:TriggerStuckRow`
- `.:TriggerTx`
- `.:UnregisteredProjectionKind`
- `.:validateBoundaryEventPayload`
- `.:validateCommittedBoundaryEvent`
- `.:waitForProjection`
- `.:walkWorkspaceFiles`
- `.:WalkWorkspaceFilesOptions`
- `.:WitnessPort`
- `.:WitnessPortIssue`
- `.:WitnessPortRejected`
- `.:WitnessPortService`
- `.:WitnessRequest`
- `.:WorkflowRunAttemptProjection`
- `.:WorkflowRunError`
- `.:WorkflowRunLinksProjection`
- `.:WorkflowRunProjection`
- `.:WorkflowRunRuntimeLink`
- `.:WorkflowRunStatus`
- `.:WORKSPACE_AGENT_COMMAND`
- `.:WORKSPACE_AGENT_PROJECTION`
- `.:WORKSPACE_AGENT_PROJECTION_SCHEMA`
- `.:WORKSPACE_OPERATION_HOST_FACT`
- `.:WORKSPACE_OP_FACT_OWNER`
- `.:WORKSPACE_OP_KIND`
- `.:WORKSPACE_OP_PROJECTION_KIND`
- `.:workspaceOperations`
- `.:WorkspaceOperationBindingEnvResolverInput`
- `.:WorkspaceOperationEnvResolver`
- `.:WorkspaceOperationEnvResolverInput`
- `.:WorkspaceOperationHostFacts`
- `.:WorkspaceOperationsOptions`
- `.:WorkspaceOperationRequestedEnvResolverInput`
- `.:WORKSPACE_TOOL_DEFAULT_DECLARATIONS`
- `.:WORKSPACE_TOOL_EXPOSURE_PROFILES`
- `.:WORKSPACE_TOOL_NAMES`
- `.:WORKSPACE_TOOL_SPECS`
- `.:WorkspaceAgentCommandInputByName`
- `.:WorkspaceAgentCommandName`
- `.:WorkspaceAgentCommandOutputByName`
- `.:WorkspaceAgentCustomCommandInput`
- `.:WorkspaceAgentDecideInputRequestCommandInput`
- `.:WorkspaceAgentDestroyCommandInput`
- `.:WorkspaceAgentDriverMount`
- `.:WorkspaceAgentFileEntry`
- `.:WorkspaceAgentFilesProjection`
- `.:WorkspaceAgentFilesProjectionShape`
- `.:WorkspaceAgentGeneratedMount`
- `.:WorkspaceAgentInspectInputRequestCommandInput`
- `.:WorkspaceAgentMutationCommandOutput`
- `.:WorkspaceAgentProjectionName`
- `.:WorkspaceAgentProjectionRead`
- `.:WorkspaceAgentProjectionSchema`
- `.:WorkspaceAgentProjectionSink`
- `.:WorkspaceAgentProjectionValueByName`
- `.:WorkspaceAgentReadFileCommandInput`
- `.:WorkspaceAgentReadFileCommandOutput`
- `.:WorkspaceAgentReadStateCommandInput`
- `.:WorkspaceAgentReadStateCommandOutput`
- `.:WorkspaceAgentResetCommandInput`
- `.:WorkspaceAgentResumeInputRequestCommandInput`
- `.:WorkspaceAgentStateProjection`
- `.:WorkspaceAgentStateProjectionShape`
- `.:WorkspaceAgentSubmitCommandInput`
- `.:WorkspaceBashResult`
- `.:WorkspaceEditFileResult`
- `.:WorkspaceEnv`
- `.:WorkspaceEnvBackend`
- `.:WorkspaceEnvInputError`
- `.:workspaceEnvMaterialRef`
- `.:WorkspaceExecOptions`
- `.:WorkspaceExecResult`
- `.:WorkspaceFilesDiff`
- `.:WorkspaceFileSnapshot`
- `.:WorkspaceFileStat`
- `.:WorkspaceGlobFilesResult`
- `.:WorkspaceGrepFilesResult`
- `.:WorkspaceGrepMatch`
- `.:WorkspaceGrepMode`
- `.:WorkspaceJobAttemptContext`
- `.:WorkspaceJobCandidateMissing`
- `.:WorkspaceJobDataPlane`
- `.:WorkspaceJobDataPlaneFailed`
- `.:WorkspaceJobFailureExplanation`
- `.:WorkspaceJobFinalizedArtifact`
- `.:WorkspaceJobObservabilityProjection`
- `.:WorkspaceJobObservabilityRequest`
- `.:WorkspaceJobRecovery`
- `.:WorkspaceJobRepairDecisionInput`
- `.:WorkspaceJobRunIdMismatch`
- `.:WorkspaceJobSeedFile`
- `.:WorkspaceJobTerminalArtifactBuild`
- `.:WorkspaceJobTerminalArtifactWriteResult`
- `.:WorkspaceJobVerifier`
- `.:WorkspaceJobVerifierFailed`
- `.:WorkspaceJobVerifierResult`
- `.:WorkspaceMutationPolicy`
- `.:WorkspaceOperationOptions`
- `.:WorkspaceReadFileLineRange`
- `.:WorkspaceReadFileResult`
- `.:WorkspaceShellPolicy`
- `.:WorkspaceToolCategory`
- `.:WorkspaceToolDefaultDeclaration`
- `.:WorkspaceToolEffect`
- `.:WorkspaceToolEnvRef`
- `.:WorkspaceToolExecHookInput`
- `.:WorkspaceToolExposurePolicy`
- `.:WorkspaceToolExposureProfile`
- `.:WorkspaceToolHooks`
- `.:WorkspaceToolInteractionFloor`
- `.:WorkspaceToolName`
- `.:WorkspaceToolReceiptPolicy`
- `.:WorkspaceTools`
- `.:WorkspaceToolSpec`
- `.:WorkspaceToolWriteHookInput`
- `.:WorkspaceWriteFileResult`
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
- `./capability:CapabilityConfigRequirement`
- `./capability:CapabilityContract`
- `./capability:CapabilityEventHandlerContext`
- `./capability:CapabilityHostFactRequirement`
- `./capability:CapabilityInstallContext`
- `./capability:CapabilityInstallation`
- `./capability:CapabilityPeerRequirement`
- `./capability:CapabilityRequirement`
- `./capability:CapabilityRequirements`
- `./capability:CapabilityRuntimeHandle`
- `./capability:CapabilitySecretRequirement`
- `./capability:defineCapability`
- `./capability:DefineCapabilitySpec`
- `./capability:defineHost`
- `./capability:DefineHostSpec`
- `./capability:HostProfile`
- `./capability:HostProvidedFact`
- `./capability:nodeHost`
- `./capability:PreflightDiagnostic`
- `./capability:PreflightDiagnosticSink`
- `./capability:ResolvedCapabilityEventHandlerFactory`
- `./capability:ResolvedCapabilityInstallGraph`
- `./capability:ResolvedHostFacts`
- `./capability:ResolvedRuntime`
- `./capability:ResolveRuntimeInstallGraphResult`
- `./capability:ResolveRuntimeOptions`
- `./capability:ResolveRuntimeResult`
- `./capability:resolveRuntime`
- `./capability:resolveRuntimeInstallGraph`
- `./capability:WORKSPACE_OPERATION_HOST_FACT`
- `./capability:workspaceOperations`
- `./capability:WorkspaceOperationBindingEnvResolverInput`
- `./capability:WorkspaceOperationEnvResolver`
- `./capability:WorkspaceOperationEnvResolverInput`
- `./capability:WorkspaceOperationHostFacts`
- `./capability:WorkspaceOperationsOptions`
- `./capability:WorkspaceOperationRequestedEnvResolverInput`
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
- `./cloudflare:CloudflareLedgerSseSource`
- `./cloudflare:CloudflareTriggerFactory`
- `./cloudflare:CloudflareTriggerFactoryContext`
- `./cloudflare:CloudflareTriggerSource`
- `./cloudflare:CloudflareWorkspaceJobProjectionReader`
- `./cloudflare:CloudflareWorkspaceJobResponseOptions`
- `./cloudflare:CloudflareWorkspaceJobResponseProjection`
- `./cloudflare:createAgentDurableObject`
- `./cloudflare:createCloudflareLedgerAgUiHistorySseResponse`
- `./cloudflare:createCloudflareLedgerAgUiSseResponse`
- `./cloudflare:createCloudflareWorkspaceJobResponse`
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
- `./cloudflare/do-rpc:durableObjectRpcInvoke`
- `./cloudflare/do-rpc:DurableObjectRpcClient`
- `./cloudflare/do-rpc:DurableObjectRpcErrorV1`
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
- `./channel:DefinedChannel`
- `./channel:createChannelContext`
- `./channel:defineChannel`
- `./channel:get`
- `./channel:post`
- `./channel:put`
- `./channel:del`
- `./channel:patch`
- `./external-effect:ExternalEffectAttemptLookup`
- `./external-effect:ExternalEffectAttemptProjection`
- `./external-effect:ExternalEffectAttemptProjectionStatus`
- `./external-effect:ExternalEffectKnownAttemptProjectionStatus`
- `./external-effect:ExternalEffectRequestedState`
- `./external-effect:DefinedExternalEffectAttempt`
- `./external-effect:defineExternalEffectAttempt`
- `./external-effect:ProjectExternalEffectAttemptSpec`
- `./external-effect:projectExternalEffectAttempt`
- `./external-effect:RunExternalEffectAttemptSpec`
- `./external-effect:runExternalEffectAttempt`
- `./schedule:CronMinuteExpression`
- `./schedule:DefinedSchedule`
- `./schedule:ScheduleContext`
- `./schedule:ScheduleContextSpec`
- `./schedule:ScheduleDefinition`
- `./schedule:ScheduleFireIdentitySpec`
- `./schedule:ScheduleFireDispatchInput`
- `./schedule:ScheduleFireRequestedEventSpec`
- `./schedule:ScheduleFireDispatchedEventSpec`
- `./schedule:ScheduleFireFailedEventSpec`
- `./schedule:ScheduleFireDispatchResult`
- `./schedule:ScheduleFireDeliveryDispatchInput`
- `./schedule:ScheduleFireDeliveryDispatchResult`
- `./schedule:ScheduleDefinitionProjection`
- `./schedule:ScheduleFireStatus`
- `./schedule:ScheduleFireSessionProductProjection`
- `./schedule:ScheduleFireWorkflowProductProjection`
- `./schedule:ScheduleFireProductProjection`
- `./schedule:ScheduleFireBaseProjection`
- `./schedule:ScheduleFireProjection`
- `./schedule:ScheduleFireHistorySpec`
- `./schedule:ScheduleFireHistoryProjection`
- `./schedule:ScheduleHandler`
- `./schedule:SchedulePrincipal`
- `./schedule:ScheduleRuntime`
- `./schedule:ScheduleSessionSubmitTurnInput`
- `./schedule:ScheduleSessions`
- `./schedule:ScheduleWorkflowRunInput`
- `./schedule:ScheduleWorkflows`
- `./schedule:ScheduledMinute`
- `./schedule:createScheduleContext`
- `./schedule:cronMinuteExpression`
- `./schedule:defineSchedule`
- `./schedule:dispatchScheduleFire`
- `./schedule:dispatchScheduleFireDelivery`
- `./schedule:projectScheduleFireHistory`
- `./schedule:projectScheduleIngressDeliveryHistory`
- `./schedule:scheduleFireId`
- `./schedule:scheduledMinute`
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
- `./in-memory:InMemoryRuntimeServices`
- `./in-memory:InMemorySchedulerLive`
- `./in-memory:makeInMemoryRuntimeLayer`
- `./in-memory:ResolvedRuntimeInstallGraph`
- `./llm-effect-ai/anthropic:AnthropicEffectAiLlmTransportLive`
- `./llm-effect-ai/anthropic:defaultEffectAiLanguageModelFactory`
- `./llm-effect-ai/anthropic:makeAnthropicEffectAiLlmTransportLayer`
- `./llm-effect-ai/openai-compatible:makeOpenAiCompatibleLlmTransportLayer`
- `./llm-effect-ai/openai-compatible:OpenAiCompatibleLlmTransportLive`
- `./llm-effect-ai/openai-compatible:OpenAiCompatibleProviderMaterialPreflightInput`
- `./llm-effect-ai/openai-compatible:preflightOpenAiCompatibleProviderMaterial`
- `./llm-effect-ai/openai-compatible:ProviderMaterialPreflightDiagnostic`
- `./local:CreateLocalAgentRuntimeOptions`
- `./local:createLocalAgentRuntime`
- `./local:createLocalRuntimeLedgerSource`
- `./local:CreateLocalWorkspaceEnvOptions`
- `./local:createLocalWorkspaceEnv`
- `./local:LocalAgentRuntime`
- `./local:LocalAgentRuntimeLlm`
- `./local:LocalAgentRuntimeLlmPreflight`
- `./local:LocalAgentRuntimeLlmPreflightInput`
- `./local:LocalAgentRuntimeResolveError`
- `./local:LocalRuntimeLedgerHydrationError`
- `./local:LocalRuntimeLedgerSource`
- `./local:LocalRuntimeLedgerSourceOptions`
- `./local:LocalAgentRuntimeTarget`
- `./local:LocalAgentSubmitInput`
- `./local:LocalAgentRuntimeTestLlm`
- `./local:LocalAgentRuntimeTransportLlm`
- `./local:LocalWorkspaceEnvError`
- `./local:validateLocalRuntimeLedgerHydrationEvents`
- `./local:LoweredLocalAgentRuntime`
- `./local:LowerLocalAgentRuntimeOptions`
- `./local:lowerLocalAgentRuntime`
- `./node:FactOwnerRef`
- `./node:NodePostgresBackend`
- `./node:NodePostgresBackendOptions`
- `./node:NodePostgresEventSubscription`
- `./node:nodePostgresProjectionKey`
- `./node:nodePostgresRuntimeIdentity`
- `./run-projector:AgentSessionProjection`
- `./run-projector:AgentSessionListProjection`
- `./run-projector:AgentSessionStatus`
- `./run-projector:AgentSessionTurnProjection`
- `./run-projector:AgentSessionTurnLinksProjection`
- `./run-projector:AgentSessionTurnRuntimeLink`
- `./run-projector:projectAgentSession`
- `./run-projector:projectAgentSessions`
- `./run-projector:projectAgentSessionTurnLinks`
- `./run-projector:projectInputRequestSettlement`
- `./run-projector:projectRunsPage`
- `./run-projector:projectRunInspection`
- `./run-projector:projectRunStatus`
- `./run-projector:projectRunTrace`
- `./run-projector:projectSubmitResult`
- `./run-projector:projectWorkflowRun`
- `./run-projector:projectWorkflowRuns`
- `./run-projector:projectWorkflowRunLinks`
- `./run-projector:RUN_BEARING_KINDS`
- `./run-projector:RunInspection`
- `./run-projector:RunInspectionDiagnostic`
- `./run-projector:WorkflowRunAttemptProjection`
- `./run-projector:WorkflowRunError`
- `./run-projector:WorkflowRunListProjection`
- `./run-projector:WorkflowRunLinksProjection`
- `./run-projector:WorkflowRunProjection`
- `./run-projector:WorkflowRunRuntimeLink`
- `./run-projector:WorkflowRunStatus`
- `./sse-http:createAttachedStreamSseResponse`
- `./sse-http:createSseHttpResponse`
- `./sse-http:createSseHttpTextResponse`
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
- `./telemetry-otlp:OTLP_GENAI_SEMCONV_MAPPING_VERSION`
- `./telemetry-otlp:OtlpAttributeValue`
- `./telemetry-otlp:OtlpProjection`
- `./telemetry-otlp:OtlpProjectionSpan`
- `./telemetry-otlp:projectOtlpSpans`
- `./testing:EXTERNAL_EFFECT_ADAPTER_OBSERVED_SCENARIOS`
- `./testing:EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS`
- `./testing:EXTERNAL_EFFECT_RUNNER_JOIN_SCENARIOS`
- `./testing:BackendConformanceLawExecution`
- `./testing:BackendConformanceRegistrar`
- `./testing:ContractDispatchReceiver`
- `./testing:ContractDispatchTargetAdapter`
- `./testing:createBackendConformanceLaws`
- `./testing:createInMemoryWorkspaceEnv`
- `./testing:CreateInMemoryWorkspaceEnvOptions`
- `./testing:ExternalEffectConformanceAdapter`
- `./testing:ExternalEffectConformanceEvidence`
- `./testing:ExternalEffectConformanceIssue`
- `./testing:ExternalEffectConformanceReport`
- `./testing:ExternalEffectConformanceScenario`
- `./testing:ExternalEffectConformanceScenarioId`
- `./testing:ExternalEffectConformanceScenarioOwnership`
- `./testing:ExternalEffectConformanceScenarioReport`
- `./testing:ExternalEffectConformanceScenarioResult`
- `./testing:externalEffectConformance`
- `./testing:InMemoryWorkspaceEnvError`
- `./testing:InMemoryWorkspaceExecScript`
- `./testing:registerBackendConformanceSuite`
- `./testing:runBackendConformance`
- `./testing:RuntimeBackendContractDriver`
- `./testing:RuntimeBackendContractDriverFactory`
- `./testing:RuntimeBackendContractSuiteOptions`
- `./testing:RuntimeBackendDispatchSpec`
- `./testing:RuntimeBackendLedgerCommitSpec`
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

- `./capability:DynamicCapabilityResolverDefinition`
- `./capability:DynamicCapabilityResolverServiceInput`
- `./capability:DynamicCapabilityResolverServiceIssue`
- `./capability:DynamicCapabilityResolverServiceResult`
- `./capability:makeDynamicCapabilityContext`
- `./capability:runDynamicCapabilityResolvers`

## Experimental exports

- `.:StructuredCallFailureClassification`
- `.:classifyStructuredCallFailure`
- `.:structuredOutputRequest`
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
- `./llm-effect-ai:callEffectAiLanguageModel`
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

## Internal-only exports

Any package file or symbol not listed above.
