import type { MaterialRef } from "@agent-os/core/material-ref";
import {
  WORKSPACE_TOPOLOGY,
  workspaceBindingRef,
  workspaceProviderResourceId,
  type AgentCapabilityBindingRef,
  type AgentExecutionDomainRef,
  type AgentToolBindingRef,
  type WorkspaceTopology,
} from "@agent-os/core/runtime-protocol";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_TOOL_DEFAULT_DECLARATIONS,
  WORKSPACE_TOOL_EXPOSURE_PROFILES,
  type WorkspaceToolDefaultDeclaration,
} from "@agent-os/runtime";
import { isWorkspaceToolName } from "../shared";
import {
  PRODUCT_AGENT_KIND,
  type ProductPlan,
  type ProductPlanToolAsset,
  verifyProductPlanDigest,
} from "../manifest-compiler";
import {
  DEPLOYMENT_TARGET_KIND,
  PROVIDER_PROTOCOL,
  type StaticTargetBinding,
} from "../deployment-intent";
import {
  STATIC_CLIENT_KIND,
  STATIC_PROFILE_KIND,
  STATIC_TARGET_KIND,
  type BoundAgentManifest,
  type StaticClientKind,
  type StaticLlmRouteBinding,
  type StaticRuntimeBootstrapModel,
  type StaticTarget,
  type StaticTargetBindingKind,
  type StaticTargetBoundDeployment,
  type StaticTargetHostProjection,
  type StaticTargetLinkIssue,
  type StaticTargetLinkOptions,
  type StaticTargetLinkResult,
  type StaticTargetPlan,
  type StaticTargetPlanResult,
  type StaticTargetPlanShared,
  type StaticTargetProfileProjection,
  type StaticTargetProvenance,
  type StaticTargetRenderInput,
  type StaticTargetWorkspace,
  type StaticTargetWorkspaceOperations,
} from "./model";
import { DEFAULT_STATIC_TARGET_PACKAGE_SCOPE, packageScopePattern } from "./encoding";
import { linkStaticTargetPlan } from "./linker";

export interface StaticTargetBindingFacts {
  readonly deployment: StaticTargetBoundDeployment;
  readonly target: StaticTarget;
  readonly client: StaticClientKind;
  readonly llmRoutes: Readonly<Record<string, StaticLlmRouteBinding>>;
  readonly workspace?: StaticTargetWorkspace;
  readonly provenance: StaticTargetProvenance;
}

export const defaultWorkspaceTopology = (): WorkspaceTopology => ({
  kind: WORKSPACE_TOPOLOGY.PER_SCOPE,
  allocator: "workspace-per-scope-v1",
});

export const materialRefFor = (ref: string, resourceKind: string): MaterialRef => ({
  kind: "external_resource",
  provider: "agent-os",
  resourceKind,
  ref,
});

export const toolBindingFromAsset = (tool: ProductPlanToolAsset): AgentToolBindingRef => ({
  bindingRef: `tool.${tool.name}`,
  ...(tool.executionDomain === undefined ? {} : { executionDomain: tool.executionDomain }),
  ...(tool.interaction === undefined ? {} : { interaction: tool.interaction }),
  ...(tool.materialRefs.length === 0 ? {} : { materialRefs: tool.materialRefs }),
  ...(tool.effects.length === 0 ? {} : { effects: tool.effects }),
  ...(tool.receiptPolicy === undefined ? {} : { receiptPolicy: tool.receiptPolicy }),
});

export const defaultWorkspaceToolBinding = (
  tool: WorkspaceToolDefaultDeclaration,
): AgentToolBindingRef => ({
  bindingRef: tool.name,
  executionDomain: tool.executionDomain,
  interaction: tool.interaction,
  materialRefs: tool.materialRefs,
  effects: tool.effects,
  receiptPolicy: tool.receiptPolicy,
});

export const sortedRecord = <A>(
  entries: ReadonlyArray<readonly [string, A]>,
): Readonly<Record<string, A>> =>
  Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));

export const selectedToolsFor = (
  product: ProductPlan,
):
  | { readonly ok: true; readonly tools: Readonly<Record<string, AgentToolBindingRef>> }
  | { readonly ok: false; readonly issues: ReadonlyArray<StaticTargetLinkIssue> } => {
  const custom = new Map(product.assets.tools.map((tool) => [tool.name, tool] as const));
  const workspaceDefaults = new Map<string, WorkspaceToolDefaultDeclaration>(
    (product.agent.kind === PRODUCT_AGENT_KIND.WORKSPACE
      ? WORKSPACE_TOOL_DEFAULT_DECLARATIONS
      : []
    ).map((tool) => [tool.name, tool] as const),
  );
  const selected =
    product.toolSelection ??
    [...workspaceDefaults.keys(), ...custom.keys()].sort((a, b) => a.localeCompare(b));
  const unknown = selected.find((toolId) => !workspaceDefaults.has(toolId) && !custom.has(toolId));
  if (unknown !== undefined) {
    return { ok: false, issues: [{ kind: "tool_selection_unknown", toolId: unknown }] };
  }
  return {
    ok: true,
    tools: sortedRecord(
      selected.map((toolId): readonly [string, AgentToolBindingRef] => {
        const defaultTool = workspaceDefaults.get(toolId);
        if (defaultTool !== undefined) return [toolId, defaultWorkspaceToolBinding(defaultTool)];
        return [toolId, toolBindingFromAsset(custom.get(toolId) as ProductPlanToolAsset)];
      }),
    ),
  };
};

export const llmRoutesFor = (
  product: ProductPlan,
  binding: StaticTargetBinding,
):
  | { readonly ok: true; readonly routes: Readonly<Record<string, StaticLlmRouteBinding>> }
  | { readonly ok: false; readonly issues: ReadonlyArray<StaticTargetLinkIssue> } => {
  const logicalId = product.modelPreference ?? "default";
  if (binding.kind === "local") {
    return {
      ok: true,
      routes: {
        default: {
          protocol: PROVIDER_PROTOCOL.OPENAI_CHAT_COMPATIBLE,
          route: PROVIDER_PROTOCOL.OPENAI_CHAT_COMPATIBLE,
          endpointRef: "openai-compatible-endpoint",
          credentialRef: "openai-compatible-credential",
          modelRef: logicalId === "default" ? "openai-compatible-model" : logicalId,
        },
      },
    };
  }
  const selected = binding.providers[logicalId];
  if (selected === undefined) {
    return { ok: false, issues: [{ kind: "model_provider_unbound", logicalId }] };
  }
  const routes = Object.entries(binding.providers).map(
    ([id, provider]): readonly [string, StaticLlmRouteBinding] => [
      id,
      { ...provider, route: provider.protocol },
    ],
  );
  return {
    ok: true,
    routes: sortedRecord([
      ["default", { ...selected, route: selected.protocol }],
      ...routes.filter(([id]) => id !== "default"),
    ]),
  };
};

export const deploymentIdentityFor = (product: ProductPlan, binding: StaticTargetBinding) =>
  binding.kind === "local"
    ? { id: `local-${product.agent.id}` }
    : { id: binding.release.id, version: binding.release.version };

export const targetForBinding = (binding: StaticTargetBinding): StaticTarget => {
  if (binding.kind === "local" || binding.target.kind === DEPLOYMENT_TARGET_KIND.NODE) {
    return { kind: STATIC_TARGET_KIND.NODE };
  }
  return {
    kind: STATIC_TARGET_KIND.CLOUDFLARE_DO,
    durableObject: {
      className: binding.target.className,
      binding: binding.target.binding,
    },
    materialResolver: { path: binding.target.materialResolver },
  };
};

export const workspaceForBinding = (
  product: ProductPlan,
  binding: StaticTargetBinding,
  deploymentId: string,
): StaticTargetWorkspace | null => {
  if (product.agent.kind !== PRODUCT_AGENT_KIND.WORKSPACE) return null;
  const authored = binding.kind === "deployment" ? binding.workspace : undefined;
  if (binding.kind === "deployment" && authored === undefined) return null;
  const bindingName = authored?.binding ?? "Workspace";
  const bindingRef = workspaceBindingRef(bindingName);
  const topology = authored?.topology ?? defaultWorkspaceTopology();
  const scopeRef = { kind: "session" as const, scopeId: product.agent.id };
  const root = binding.kind === "local" ? binding.cwd : binding.workspace?.root;
  if (root === undefined) return null;
  return {
    binding: bindingName,
    bindingRef,
    root,
    topology,
    scope: { idSource: "manifest", scopeRef },
    providerResourceId: workspaceProviderResourceId({
      deploymentNamespace: deploymentId,
      workspaceBindingRef: bindingRef,
      topology,
      scopeRef,
    }),
  };
};

export const manifestForBinding = (
  product: ProductPlan,
  routes: Readonly<Record<string, StaticLlmRouteBinding>>,
  workspace: StaticTargetWorkspace | null,
  tools: Readonly<Record<string, AgentToolBindingRef>>,
): BoundAgentManifest => {
  const executionDomainIds = new Set(
    Object.values(tools).flatMap((tool) =>
      tool.executionDomain === undefined ? [] : [tool.executionDomain],
    ),
  );
  const interactionIds = new Set(
    Object.values(tools).flatMap((tool) =>
      tool.interaction === undefined ? [] : [tool.interaction],
    ),
  );
  const materialIds = new Set(Object.values(tools).flatMap((tool) => tool.materialRefs ?? []));
  const executionDomains: Readonly<Record<string, AgentExecutionDomainRef>> = sortedRecord(
    [...executionDomainIds].map((id) => [id, { bindingRef: id }] as const),
  );
  const interactions = sortedRecord(
    [...interactionIds].map((id) => [id, { bindingRef: id }] as const),
  );
  const materials = sortedRecord(
    [...materialIds].map(
      (id) =>
        [
          id,
          id === "workspace" && workspace !== null
            ? materialRefFor(workspace.providerResourceId, "workspace-env")
            : materialRefFor(id, "tool-material"),
        ] as const,
    ),
  );
  const capabilities: Readonly<Record<string, AgentCapabilityBindingRef>> =
    workspace === null ? {} : { workspaceOperations: { bindingRef: WORKSPACE_OP_FACT_OWNER } };
  return {
    agentId: product.agent.id,
    scope:
      product.agent.kind === PRODUCT_AGENT_KIND.WORKSPACE
        ? { kind: "session", idSource: "manifest", stableScopeId: product.agent.id }
        : { kind: "conversation", idSource: "manifest", stableScopeId: product.agent.id },
    effectAuthorityRef: { authorityClass: "agent", authorityId: product.agent.id },
    handlers: [],
    instructions: { path: product.instructions.path, digest: product.instructions.digest },
    llmRoutes: sortedRecord(Object.keys(routes).map((id) => [id, { bindingRef: id }] as const)),
    ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
    ...(Object.keys(tools).length === 0 ? {} : { tools }),
    ...(Object.keys(materials).length === 0 ? {} : { materials }),
    ...(Object.keys(executionDomains).length === 0 ? {} : { executionDomains }),
    ...(Object.keys(interactions).length === 0 ? {} : { interactions }),
    ...(product.outputSchema === undefined ? {} : { outputSchema: product.outputSchema }),
  };
};

export const bindingFactsFor = (
  product: ProductPlan,
  binding: StaticTargetBinding,
):
  | { readonly ok: true; readonly value: StaticTargetBindingFacts }
  | { readonly ok: false; readonly issues: ReadonlyArray<StaticTargetLinkIssue> } => {
  if (!verifyProductPlanDigest(product))
    return { ok: false, issues: [{ kind: "product_digest_mismatch" }] };
  const routes = llmRoutesFor(product, binding);
  if (!routes.ok) return routes;
  const identity = deploymentIdentityFor(product, binding);
  const workspace = workspaceForBinding(product, binding, identity.id);
  if (product.agent.kind === PRODUCT_AGENT_KIND.WORKSPACE && workspace === null) {
    return { ok: false, issues: [{ kind: "workspace_binding_required", host: binding.kind }] };
  }
  const selectedTools = selectedToolsFor(product);
  if (!selectedTools.ok) return selectedTools;
  const target = targetForBinding(binding);
  const manifest = manifestForBinding(product, routes.routes, workspace, selectedTools.tools);
  const deployment: StaticTargetBoundDeployment = {
    deploymentId: identity.id,
    manifest,
    backend: target.kind === STATIC_TARGET_KIND.NODE ? "node" : "cloudflare-do",
    adapter: target.kind,
    codec: "agentos-json@1",
    providerStrategy: PROVIDER_PROTOCOL.OPENAI_CHAT_COMPATIBLE,
  };
  const deploymentOrigins = {
    "/deployment/id": binding.kind === "local" ? "host:local#agent-id" : "deployment:/release/id",
    "/target": binding.kind === "local" ? "host:local#node" : "deployment:/target",
    "/client": binding.kind === "local" ? "host:local#direct" : "deployment:/transport",
    "/providers": binding.kind === "local" ? "host:local#environment" : "deployment:/providers",
  };
  return {
    ok: true,
    value: {
      deployment,
      target,
      client: binding.kind === "local" ? STATIC_CLIENT_KIND.DIRECT : binding.transport,
      llmRoutes: routes.routes,
      ...(workspace === null ? {} : { workspace }),
      provenance: {
        manifest: product.provenance,
        deployment: deploymentOrigins,
        exclusions: {},
      },
    },
  };
};

const workspaceMutationToolNames = new Set<string>(WORKSPACE_TOOL_EXPOSURE_PROFILES.mutation);
const workspaceShellToolNames = new Set<string>(WORKSPACE_TOOL_EXPOSURE_PROFILES.shell);

const staticRuntimeBootstrapFor = (
  product: ProductPlan,
  facts: StaticTargetBindingFacts,
  toolNames: ReadonlyArray<string>,
): StaticRuntimeBootstrapModel => {
  const authoredToolNames = new Set(product.assets.tools.map((tool) => tool.name));
  return {
    toolNames,
    customToolNames: toolNames.filter((toolName) => authoredToolNames.has(toolName)),
    manifestTools: facts.deployment.manifest.tools,
    llmRoutes: facts.llmRoutes,
    skills: [...product.assets.skills].sort((left, right) => left.name.localeCompare(right.name)),
    instructionFragments: [...product.assets.instructionFragments].sort((left, right) =>
      left.fragmentId.localeCompare(right.fragmentId),
    ),
    dynamicResolvers: [...product.assets.dynamicResolvers].sort(
      (left, right) =>
        left.slot.localeCompare(right.slot) || left.resolverId.localeCompare(right.resolverId),
    ),
  };
};

const workspaceOperationsFor = (
  product: ProductPlan,
  toolNames: ReadonlyArray<string>,
): StaticTargetWorkspaceOperations => {
  const authoredToolNames = new Set(product.assets.tools.map((tool) => tool.name));
  const selected = toolNames.filter(
    (toolName) => isWorkspaceToolName(toolName) && !authoredToolNames.has(toolName),
  );
  return {
    toolNames: selected,
    usesMutationTools: selected.some((toolName) => workspaceMutationToolNames.has(toolName)),
    usesShellTools: selected.some((toolName) => workspaceShellToolNames.has(toolName)),
  };
};

const staticTargetRenderInputFor = (
  product: ProductPlan,
  facts: StaticTargetBindingFacts,
  toolNames: ReadonlyArray<string>,
): StaticTargetRenderInput => ({
  deployment: facts.deployment,
  bootstrap: staticRuntimeBootstrapFor(product, facts, toolNames),
  channels: [...product.assets.channels].sort((left, right) => left.name.localeCompare(right.name)),
  schedules: [...product.assets.schedules].sort((left, right) =>
    left.scheduleId.localeCompare(right.scheduleId),
  ),
  workspaceOperations: workspaceOperationsFor(product, toolNames),
});

const staticTargetProfileProjectionFor = (
  product: ProductPlan,
  facts: StaticTargetBindingFacts,
  toolNames: ReadonlyArray<string>,
): StaticTargetProfileProjection => {
  const renderInput = staticTargetRenderInputFor(product, facts, toolNames);
  if (product.agent.kind === PRODUCT_AGENT_KIND.WORKSPACE) {
    const workspace = facts.workspace as StaticTargetWorkspace;
    return {
      kind: STATIC_PROFILE_KIND.WORKSPACE,
      renderInput: { ...renderInput, workspace },
      deployment: {
        workspace: {
          binding: workspace.binding,
          bindingRef: workspace.bindingRef,
          root: workspace.root,
          topology: workspace.topology,
          scope: workspace.scope,
          providerResourceId: workspace.providerResourceId,
        },
      },
      canonicalDeployment: {
        profile: STATIC_PROFILE_KIND.WORKSPACE,
        workspaceTopology: workspace.topology,
      },
      mount: {
        projectionSinks: [
          "agent.info",
          "workspace.state",
          "workspace.files",
          "runtime.events",
          "runtime.input_requests",
        ],
        providerResourceId: workspace.providerResourceId,
      },
      nodeWorkspace: workspace,
    };
  }
  return {
    kind: STATIC_PROFILE_KIND.CHAT,
    renderInput,
    deployment: {},
    canonicalDeployment: { profile: STATIC_PROFILE_KIND.CHAT },
    mount: {
      projectionSinks: ["agent.info", "runtime.events", "runtime.input_requests"],
    },
    nodeWorkspace: null,
  };
};

const unsupportedCombinationFor = (
  profile: StaticTargetProfileProjection,
  target: StaticTarget,
  client: StaticClientKind,
): StaticTargetLinkIssue | null =>
  target.kind === STATIC_TARGET_KIND.NODE && client === STATIC_CLIENT_KIND.SVELTE_KIT_REMOTE
    ? {
        kind: "unsupported_static_combination",
        profile: profile.kind,
        target: target.kind,
        client,
      }
    : null;

const staticTargetHostProjectionFor = (
  facts: StaticTargetBindingFacts,
  shared: StaticTargetPlanShared,
  profile: StaticTargetProfileProjection,
): StaticTargetHostProjection => {
  if (facts.target.kind === STATIC_TARGET_KIND.NODE) {
    const nodeWorkspace = profile.nodeWorkspace;
    return {
      kind: STATIC_TARGET_KIND.NODE,
      target: facts.target,
      deployment: {
        ...shared.deployment,
        backend: facts.deployment.backend,
        adapter: facts.deployment.adapter,
        ...(nodeWorkspace === null
          ? {}
          : {
              workspace: {
                binding: nodeWorkspace.binding,
                bindingRef: nodeWorkspace.bindingRef,
                root: nodeWorkspace.root,
                topology: nodeWorkspace.topology,
                providerResourceId: nodeWorkspace.providerResourceId,
              },
            }),
      },
      canonicalDeployment: { target: STATIC_TARGET_KIND.NODE },
      mount: { driver: { kind: "local-node", target: STATIC_TARGET_KIND.NODE } },
    };
  }
  return {
    kind: STATIC_TARGET_KIND.CLOUDFLARE_DO,
    target: facts.target,
    deployment: {
      ...shared.deployment,
      backend: facts.deployment.backend,
      adapter: facts.deployment.adapter,
      ...profile.deployment,
    },
    canonicalDeployment: { target: STATIC_TARGET_KIND.CLOUDFLARE_DO },
    mount: {
      driver: {
        kind: "cloudflare-do",
        className: facts.target.durableObject.className,
        binding: facts.target.durableObject.binding,
      },
    },
  };
};

export const staticTargetPlanFor = (
  product: ProductPlan,
  facts: StaticTargetBindingFacts,
  packageScope: string,
): StaticTargetPlanResult => {
  const manifest = facts.deployment.manifest;
  const toolNames = Object.keys(manifest.tools ?? {}).sort();
  const authoredToolNames = new Set(product.assets.tools.map((tool) => tool.name));
  const shared: StaticTargetPlanShared = {
    packageScope,
    deployment: {
      deploymentId: facts.deployment.deploymentId,
      codec: facts.deployment.codec,
      providerStrategy: facts.deployment.providerStrategy,
    },
    manifest,
    provenance: facts.provenance,
    toolNames,
    authoredManifestToolNames: toolNames.filter((toolName) => authoredToolNames.has(toolName)),
  };
  const profile = staticTargetProfileProjectionFor(product, facts, toolNames);
  const client = { kind: facts.client } as const;
  const unsupported = unsupportedCombinationFor(profile, facts.target, client.kind);
  if (unsupported !== null) return { ok: false, issues: [unsupported] };
  return {
    ok: true,
    value: {
      shared,
      profile,
      client,
      host: staticTargetHostProjectionFor(facts, shared, profile),
    },
  };
};

/** Bind one product plan to one explicit host without reinterpreting product semantics. */
export const bindStaticTargetPlan = (
  product: ProductPlan,
  binding: StaticTargetBinding,
  options: StaticTargetLinkOptions = {},
): StaticTargetPlanResult => {
  const packageScope = options.packageScope ?? DEFAULT_STATIC_TARGET_PACKAGE_SCOPE;
  if (!packageScopePattern.test(packageScope)) {
    return {
      ok: false,
      issues: [{ kind: "invalid_static_package_scope", scope: packageScope }],
    };
  }
  const facts = bindingFactsFor(product, binding);
  if (!facts.ok) return facts;
  return staticTargetPlanFor(product, facts.value, packageScope);
};

/** Compile the explicit product/host pair to the generated residual program. */
export const linkStaticTarget = (
  product: ProductPlan,
  binding: StaticTargetBinding,
  options: StaticTargetLinkOptions = {},
): StaticTargetLinkResult => linkStaticTargetPlan(bindStaticTargetPlan(product, binding, options));
