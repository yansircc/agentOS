import { STATIC_TARGET_KIND } from "./model";
import type {
  StaticCloudflareTarget,
  StaticLlmRouteBinding,
  StaticTarget,
  StaticTargetChannel,
  StaticTargetDynamicResolver,
  StaticTargetGeneratedFilePath,
  StaticTargetModuleImport,
  StaticTargetSchedule,
} from "./model";

export const generatedPath = <Path extends StaticTargetGeneratedFilePath>(
  path: Path,
  text: string,
) => ({
  path,
  text,
});

export const stableJsonValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableJsonValue);
  const record = value as Readonly<Record<string, unknown>>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = stableJsonValue(record[key]);
  return sorted;
};

export const stableJson = (value: unknown): string =>
  `${JSON.stringify(stableJsonValue(value), null, 2)}\n`;

export const jsString = (value: string): string => JSON.stringify(value);

export const identifierSuffix = (value: string): string =>
  value.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^[^A-Za-z_$]+/u, "_$&");

export type LlmMaterialKind = "endpoint" | "credential" | "model";

export interface LlmMaterialEnvBinding {
  readonly kind: LlmMaterialKind;
  readonly ref: string;
  readonly envName: string;
}

export const materialEnvNameForRef = (kind: LlmMaterialKind, ref: string): string => {
  const prefix =
    kind === "endpoint"
      ? "AGENTOS_ENDPOINT"
      : kind === "credential"
        ? "AGENTOS_CREDENTIAL"
        : "AGENTOS_MODEL";
  const suffix =
    ref
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "REF";
  return `${prefix}_${suffix}`;
};

export const llmMaterialEnvBindingsForRoutes = (
  routes: Readonly<Record<string, StaticLlmRouteBinding>>,
): ReadonlyArray<LlmMaterialEnvBinding> =>
  Object.values(routes).flatMap((route) =>
    (
      [
        ["endpoint", route.endpointRef],
        ["credential", route.credentialRef],
        ["model", route.modelRef],
      ] as const
    ).map(([kind, ref]) => ({ kind, ref, envName: materialEnvNameForRef(kind, ref) })),
  );

export const routeEntries = (
  routes: Readonly<Record<string, StaticLlmRouteBinding>>,
): ReadonlyArray<readonly [string, StaticLlmRouteBinding]> =>
  Object.entries(routes).sort(([left], [right]) => left.localeCompare(right));

export const uniqueLlmMaterialEnvBindings = (
  routes: Readonly<Record<string, StaticLlmRouteBinding>>,
) => {
  const bindings = new Map<string, LlmMaterialEnvBinding>();
  for (const binding of llmMaterialEnvBindingsForRoutes(routes)) {
    bindings.set(`${binding.kind}:${binding.ref}`, binding);
  }
  return [...bindings.values()].sort((left, right) =>
    `${left.kind}:${left.ref}`.localeCompare(`${right.kind}:${right.ref}`),
  );
};

export const renderMaterialValueFunction = (
  routes: Readonly<Record<string, StaticLlmRouteBinding>>,
): string => {
  const bindings = uniqueLlmMaterialEnvBindings(routes).filter(
    (binding) => binding.kind === "model",
  );
  const cases = bindings
    .map(
      (binding) => `  if (ref.kind === ${jsString(binding.kind)} && ref.ref === ${jsString(
        binding.ref,
      )}) {
    return materialEnvValue(env, ${jsString(binding.envName)});
  }`,
    )
    .join("\n");
  return `const materialValue = (
  env: AgentOSTargetEnv,
  ref: { readonly kind: string; readonly ref: string },
): NonNullable<unknown> | null => {
${cases}
  return null;
};`;
};

export const renderGeneratedProviderPreflight = (
  routes: Readonly<Record<string, StaticLlmRouteBinding>>,
): string => {
  const diagnostics = routeEntries(routes)
    .map(
      ([bindingRef, route]) => `  ...preflightOpenAiCompatibleProviderMaterial({
    route: {
      kind: ${jsString(route.route)},
      endpointRef: ${jsString(route.endpointRef)},
      credentialRef: ${jsString(route.credentialRef)},
      modelId: typeof materialValue(env, { kind: "model", ref: ${jsString(
        route.modelRef,
      )} }) === "string"
        ? materialValue(env, { kind: "model", ref: ${jsString(route.modelRef)} }) as string
        : "",
    },
    refResolver,
    routeBindingRef: ${jsString(bindingRef)},
    modelMaterial: {
      ref: ${jsString(route.modelRef)},
      value: materialValue(env, { kind: "model", ref: ${jsString(route.modelRef)} }),
    },
  }),`,
    )
    .join("\n");
  return `const generatedProviderPreflightDiagnosticsFor = (
  env: AgentOSTargetEnv,
  refResolver: RefResolver,
): ReturnType<typeof preflightOpenAiCompatibleProviderMaterial> => [
${diagnostics}
];`;
};

export const renderGeneratedLlmRoutesFor = (
  routes: Readonly<Record<string, StaticLlmRouteBinding>>,
): string => {
  const checks = routeEntries(routes)
    .map(([bindingRef, route]) => {
      const suffix = identifierSuffix(bindingRef);
      return `  const modelId_${suffix} = requiredStringMaterial(
    "model",
    ${jsString(route.modelRef)},
    materialValue(env, { kind: "model", ref: ${jsString(route.modelRef)} }),
  );
  if (!modelId_${suffix}.ok) return modelId_${suffix};`;
    })
    .join("\n");
  const entries = routeEntries(routes)
    .map(
      ([bindingRef, route]) => `      ${jsString(bindingRef)}: {
        kind: ${jsString(route.route)},
        endpointRef: ${jsString(route.endpointRef)},
        credentialRef: ${jsString(route.credentialRef)},
        modelId: modelId_${identifierSuffix(bindingRef)}.value,
      },`,
    )
    .join("\n");
  return `const generatedLlmRoutesFor = (
  env: AgentOSTargetEnv,
): GeneratedTargetResult<NonNullable<AgentSubmitBindings["llmRoutes"]>> => {
${checks}
  return {
    ok: true,
    value: {
${entries}
    },
  };
};`;
};

export const importToolPath = (toolName: string): string => `../../agent/tools/${toolName}`;

export const importMaterialResolverPath = (path: string): string =>
  `../../${path.replace(/^\.\//u, "").replace(/\.ts$/u, "")}`;

export const importChannelPath = (path: string): string => `../../${path.replace(/\.ts$/u, "")}`;

export const importSchedulePath = (path: string): string => `../../${path.replace(/\.ts$/u, "")}`;

export const importDynamicResolverPath = (resolverPath: string): string =>
  `../../${resolverPath.replace(/\.ts$/u, "")}`;

export const SOURCE_PACKAGE_SCOPE = "@agent-os";
export const INJECTED_PUBLIC_PACKAGE_SCOPE = "__AGENTOS_PUBLIC_PACKAGE_SCOPE__";
export const packageScopePattern = /^@[a-z0-9][a-z0-9._-]*$/u;
export const DEFAULT_STATIC_TARGET_PACKAGE_SCOPE = packageScopePattern.test(
  INJECTED_PUBLIC_PACKAGE_SCOPE,
)
  ? INJECTED_PUBLIC_PACKAGE_SCOPE
  : SOURCE_PACKAGE_SCOPE;

export const publicPackageSpecifier = (scope: string, name: string): string => `${scope}/${name}`;

export const cloudflareTargetFor = (target: StaticTarget): StaticCloudflareTarget => {
  if (target.kind === STATIC_TARGET_KIND.CLOUDFLARE_DO) return target;
  throw new TypeError(`cloudflare target renderer received ${target.kind}`);
};

export const staticTargetModules = (scope: string) => ({
  runtimeCapability: publicPackageSpecifier(scope, "runtime/capability"),
  cloudflareDoRuntime: publicPackageSpecifier(scope, "runtime/cloudflare"),
  localRuntime: publicPackageSpecifier(scope, "runtime/local"),
  openAiCompatibleTransport: publicPackageSpecifier(
    scope,
    "runtime/llm-effect-ai/openai-compatible",
  ),
  workspaceAgentHost: publicPackageSpecifier(scope, "runtime/workspace-agent"),
  workspaceAgentClient: publicPackageSpecifier(scope, "client/workspace-agent"),
  productShellClient: publicPackageSpecifier(scope, "client/product-shell-client"),
  workspaceBinding: publicPackageSpecifier(scope, "runtime/workspace-binding"),
  workspaceEnvCloudflare: publicPackageSpecifier(scope, "runtime/cloudflare"),
  runtimeChannel: publicPackageSpecifier(scope, "runtime/channel"),
  runtimeSchedule: publicPackageSpecifier(scope, "runtime/schedule"),
  runtimeRunProjector: publicPackageSpecifier(scope, "runtime/run-projector"),
  clientCore: publicPackageSpecifier(scope, "client"),
  clientSvelte: publicPackageSpecifier(scope, "client/svelte"),
  runtimeProtocol: publicPackageSpecifier(scope, "core/runtime-protocol"),
  coreRefResolver: publicPackageSpecifier(scope, "core/ref-resolver"),
  coreTools: publicPackageSpecifier(scope, "core/tools"),
  sseHttp: publicPackageSpecifier(scope, "runtime/sse-http"),
  cloudflareSandbox: "@cloudflare/sandbox",
  svelteKitServer: "$app/server",
  svelteKitKit: "@sveltejs/kit",
  effect: "effect",
  svelteStore: "svelte/store",
});

export const renderNamedImport = (names: ReadonlyArray<string>, source: string): string =>
  `import { ${names.join(", ")} } ${"from"} ${jsString(source)};`;

export const renderTypeImport = (names: ReadonlyArray<string>, source: string): string =>
  `import type { ${names.join(", ")} } ${"from"} ${jsString(source)};`;

export const generatedToolImports = (
  toolNames: ReadonlyArray<string>,
): ReadonlyArray<StaticTargetModuleImport> =>
  toolNames.map((toolName, index) => ({
    kind: "authored-tool",
    source: importToolPath(toolName),
    imports: [`default as tool_${index}`],
  }));

export const generatedChannelImports = (
  channels: ReadonlyArray<StaticTargetChannel>,
): ReadonlyArray<StaticTargetModuleImport> =>
  channels.map((channel, index) => ({
    kind: "authored-channel",
    source: importChannelPath(channel.path),
    imports: [`default as channel_${index}`],
  }));

export const generatedScheduleImports = (
  schedules: ReadonlyArray<StaticTargetSchedule>,
): ReadonlyArray<StaticTargetModuleImport> =>
  schedules.map((schedule, index) => ({
    kind: "authored-schedule",
    source: importSchedulePath(schedule.path),
    imports: [`default as schedule_${index}`],
  }));

export const generatedDynamicResolverImports = (
  resolvers: ReadonlyArray<StaticTargetDynamicResolver>,
): ReadonlyArray<StaticTargetModuleImport> =>
  resolvers.map((resolver, index) => ({
    kind: "authored-dynamic-resolver",
    source: importDynamicResolverPath(resolver.path),
    imports: [`default as dynamicResolver_${index}`],
  }));
