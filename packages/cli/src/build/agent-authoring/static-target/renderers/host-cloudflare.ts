import type { StaticCloudflareTarget, StaticTargetRenderInput } from "../model";
import {
  jsString,
  renderNamedImport,
  renderTypeImport,
  stableJson,
  staticTargetModules,
} from "../encoding";

export const renderCloudflareScopeHelper = (
  normalized: StaticTargetRenderInput,
  target: StaticCloudflareTarget,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const submitScope = normalized.deployment.manifest.scope.idSource === "submit_scope";
  const identityProjection = submitScope
    ? `export const agentOSTruthIdentityFor = (scopeId: string): LedgerTruthIdentity => {
  if (scopeId.length === 0) throw Error("authenticated routing scope is missing");
  return cloudflareDefaultTruthIdentityFromRoutingScope(scopeId, ${jsString(
    normalized.deployment.manifest.scope.kind,
  )});
};`
    : `export const agentOSTruthIdentity = manifestTruthIdentity(manifest as AgentManifest);
export const agentOSScopeId = agentOSTruthIdentity.scopeRef.scopeId;`;
  const scopeParameter = submitScope ? "scopeId: string" : "scopeId: string = agentOSScopeId";
  return `${renderNamedImport(["durableObjectRpcClient"], `${modules.cloudflareDoRuntime}/do-rpc`)}
${
  submitScope
    ? renderNamedImport(
        ["cloudflareDefaultTruthIdentityFromRoutingScope"],
        modules.cloudflareDoRuntime,
      )
    : ""
}
${renderNamedImport(["manifestTruthIdentity"], modules.runtimeProtocol)}
${renderTypeImport(["AgentRuntimeClient"], modules.cloudflareDoRuntime)}
${renderTypeImport(["DurableObjectRpcClient"], `${modules.cloudflareDoRuntime}/do-rpc`)}
${renderTypeImport(["AgentManifest", "LedgerTruthIdentity"], modules.runtimeProtocol)}
import manifest from "./manifest.json";

export type AgentOSTargetEnv = {
  readonly [binding: string]: unknown;
};

${identityProjection}
export const agentOSDurableObjectBinding = ${jsString(target.durableObject.binding)};

export const agentOSDurableObjectNamespace = (
  env: AgentOSTargetEnv,
): DurableObjectNamespace =>
  env[agentOSDurableObjectBinding] as DurableObjectNamespace;

export const agentOSRpcClient = <
  Rpc extends Pick<AgentRuntimeClient, "events" | "streamEvents"> = AgentRuntimeClient,
>(
  env: AgentOSTargetEnv,
  ${scopeParameter},
): DurableObjectRpcClient<Rpc> => durableObjectRpcClient<Rpc>(agentOSDurableObjectNamespace(env), scopeId);
`;
};

export const renderCloudflareWorkerEntry = (
  normalized: StaticTargetRenderInput,
  target: StaticCloudflareTarget,
  modules: ReturnType<typeof staticTargetModules>,
  profile: {
    readonly sandboxImport: string;
    readonly sandboxExport: string;
  },
): string => {
  const hasChannels = normalized.channels.length > 0;
  const hasSchedules = normalized.schedules.length > 0;
  const cloudflareScopeImports = [
    ...(hasChannels || hasSchedules ? ["agentOSRpcClient"] : []),
    ...(hasSchedules ? ["agentOSScopeId"] : []),
  ];
  return `${profile.sandboxImport}${renderNamedImport([target.durableObject.className], "./target")}
${hasChannels ? `${renderNamedImport(["dispatchGeneratedChannelRequest"], "./channels")}\n${renderTypeImport(["AgentRuntimeClient"], modules.cloudflareDoRuntime)}\n${renderTypeImport(["ChannelRuntime"], modules.runtimeChannel)}\n` : ""}${hasSchedules ? `${renderNamedImport(["generatedSchedules"], "./schedules")}\n${renderTypeImport(["GeneratedScheduleTriggerInput"], "./schedules")}\n` : ""}${cloudflareScopeImports.length === 0 ? "" : `${renderNamedImport(cloudflareScopeImports, "./cloudflare-scope")}\n`}${renderTypeImport(["AgentOSTargetEnv"], "./cloudflare-scope")}

export { ${target.durableObject.className}${profile.sandboxExport} };

${
  hasChannels
    ? `type AgentOSChannelRpc = Pick<AgentRuntimeClient, "events" | "streamEvents"> & {
  readonly submitRunInput: ChannelRuntime["submit"];
  readonly dispatchToScope: ChannelRuntime["dispatch"];
};

const generatedChannelRuntimeFor = (env: AgentOSTargetEnv): ChannelRuntime => {
  const runtime = agentOSRpcClient<AgentOSChannelRpc>(env);
  return Object.freeze({
    submit: (input) => runtime.submitRunInput(input),
    dispatch: (spec) => runtime.dispatchToScope(spec),
  });
};
`
    : ""
}
${
  hasSchedules
    ? `type AgentOSScheduleRpc = {
  readonly dispatchSchedule: (input: GeneratedScheduleTriggerInput) => Promise<unknown>;
};

const generatedScheduleAppPrincipal: GeneratedScheduleTriggerInput["appPrincipal"] = {
  authority: "agentos.app",
  subject: agentOSScopeId,
};

const generatedScheduleInputsFor = (
  controller: ScheduledController,
): ReadonlyArray<GeneratedScheduleTriggerInput> =>
  generatedSchedules
    .filter((entry) => entry.cron === controller.cron)
    .map((entry) => ({
      scheduleId: entry.scheduleId,
      scheduledAt: controller.scheduledTime,
      appPrincipal: generatedScheduleAppPrincipal,
    }));
`
    : ""
}

export default {
  async fetch(request: Request, env: AgentOSTargetEnv): Promise<Response> {
    ${
      hasChannels
        ? `const channelResponse = await dispatchGeneratedChannelRequest(request, generatedChannelRuntimeFor(env));
    if (channelResponse !== null) return channelResponse;`
        : ""
    }
    return new Response("agentOS Cloudflare target", { status: 404 });
  },
  ${
    hasSchedules
      ? `scheduled(controller: ScheduledController, env: AgentOSTargetEnv, ctx: ExecutionContext): void {
    const runtime = agentOSRpcClient<AgentOSScheduleRpc>(env);
    for (const input of generatedScheduleInputsFor(controller)) {
      ctx.waitUntil(runtime.dispatchSchedule(input));
    }
  },`
      : ""
  }
} satisfies ExportedHandler<AgentOSTargetEnv>;
`;
};

export const renderCloudflareWranglerConfig = (
  normalized: StaticTargetRenderInput,
  profileConfig: Readonly<Record<string, unknown>>,
): string => {
  return stableJson({
    $schema: "node_modules/wrangler/config-schema.json",
    name: normalized.deployment.deploymentId,
    main: "./worker.ts",
    compatibility_date: "2026-04-15",
    compatibility_flags: ["nodejs_compat"],
    ...profileConfig,
  });
};
