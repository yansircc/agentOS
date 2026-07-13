import type {
  StaticTargetChannel,
  StaticTargetInstructionFragment,
  StaticTargetSchedule,
  StaticTargetSkill,
} from "./model";
import {
  importChannelPath,
  importSchedulePath,
  jsString,
  renderNamedImport,
  renderTypeImport,
  stableJson,
  stableJsonValue,
  staticTargetModules,
} from "./encoding";

export const renderChannelRegistry = (
  channels: ReadonlyArray<StaticTargetChannel>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const ordered = channels;
  const channelImports = ordered
    .map(
      (channel, index) =>
        `import channel_${index} from ${jsString(importChannelPath(channel.path))};`,
    )
    .join("\n");
  const entries =
    ordered.length === 0
      ? "[]"
      : `[\n${ordered
          .map(
            (channel, index) =>
              `  { name: ${jsString(channel.name)}, path: ${jsString(
                channel.path,
              )}, channel: channel_${index} as DefinedChannel },`,
          )
          .join("\n")}\n]`;
  return `${channelImports}
${renderNamedImport(["createChannelContext"], modules.runtimeChannel)}
${renderTypeImport(
  ["ChannelMethod", "ChannelRequest", "ChannelRoute", "ChannelRuntime", "DefinedChannel"],
  modules.runtimeChannel,
)}

type GeneratedChannelDefinition = {
  readonly name: string;
  readonly path: string;
  readonly channel: DefinedChannel;
};

type GeneratedChannelRoute = ChannelRoute & {
  readonly channelName: string;
  readonly mountPath: string;
  readonly channel: DefinedChannel;
};

export const generatedChannels = ${entries} as const satisfies ReadonlyArray<GeneratedChannelDefinition>;

const mountedChannelPath = (channelName: string, routePath: string): string =>
  routePath === "/" ? \`/channels/\${channelName}\` : \`/channels/\${channelName}\${routePath}\`;

const generatedRoutes = generatedChannels.flatMap((entry): ReadonlyArray<GeneratedChannelRoute> =>
  entry.channel.routes.map((route) => ({
    ...route,
    channelName: entry.name,
    mountPath: mountedChannelPath(entry.name, route.path),
    channel: entry.channel,
  })),
);

const routeSegments = (path: string): ReadonlyArray<string> =>
  path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const isRouteParamSegment = (segment: string): boolean => segment.startsWith(":");

const routePatternsConflict = (left: string, right: string): boolean => {
  const leftSegments = routeSegments(left);
  const rightSegments = routeSegments(right);
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every((leftSegment, index) => {
    const rightSegment = rightSegments[index] ?? "";
    return leftSegment === rightSegment || isRouteParamSegment(leftSegment) || isRouteParamSegment(rightSegment);
  });
};

const assertNoGeneratedChannelRouteConflicts = (routes: ReadonlyArray<GeneratedChannelRoute>): void => {
  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    const left = routes[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
      const right = routes[rightIndex];
      if (right === undefined || left.method !== right.method) continue;
      if (!routePatternsConflict(left.mountPath, right.mountPath)) continue;
      throw new Error(
        \`generated channel route conflict: \${left.method} \${left.mountPath} conflicts with \${right.mountPath}\`,
      );
    }
  }
};

assertNoGeneratedChannelRouteConflicts(generatedRoutes);

export const generatedChannelNames = generatedChannels.map((entry) => entry.name);
export const generatedChannelRoutes = generatedRoutes;

const matchGeneratedChannelPath = (
  pattern: string,
  pathname: string,
): Readonly<Record<string, string>> | null => {
  const patternSegments = routeSegments(pattern);
  const pathSegments = routeSegments(pathname);
  if (patternSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index] ?? "";
    const pathSegment = pathSegments[index] ?? "";
    if (patternSegment.startsWith(":")) {
      const paramName = patternSegment.slice(1);
      if (paramName.length === 0) return null;
      params[paramName] = decodeURIComponent(pathSegment);
      continue;
    }
    if (patternSegment !== pathSegment) return null;
  }
  return params;
};

export const dispatchGeneratedChannelRequest = async (
  request: Request,
  runtime: ChannelRuntime,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const method = request.method.toUpperCase() as ChannelMethod;
  for (const route of generatedChannelRoutes) {
    if (route.method !== method) continue;
    const params = matchGeneratedChannelPath(route.mountPath, url.pathname);
    if (params === null) continue;
    const channelRequest: ChannelRequest = {
      method: route.method,
      path: url.pathname,
      params,
      request,
      url,
    };
    const principal = await route.channel.verify(channelRequest);
    const context = createChannelContext(runtime, principal);
    return route.handler(channelRequest, context);
  }
  return null;
};
`;
};

export const renderScheduleRegistry = (
  schedules: ReadonlyArray<StaticTargetSchedule>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const ordered = schedules;
  const scheduleImports = ordered
    .map(
      (schedule, index) =>
        `import schedule_${index} from ${jsString(importSchedulePath(schedule.path))};`,
    )
    .join("\n");
  const entries =
    ordered.length === 0
      ? "[]"
      : `[\n${ordered
          .map(
            (schedule, index) =>
              `  { scheduleId: ${jsString(schedule.scheduleId)}, path: ${jsString(
                schedule.path,
              )}, cron: ${jsString(schedule.cron)}, schedule: schedule_${index} as DefinedSchedule },`,
          )
          .join("\n")}\n]`;
  return `${scheduleImports}
${renderNamedImport(["dispatchScheduleFire", "dispatchScheduleFireDelivery"], modules.runtimeSchedule)}
${renderTypeImport(
  [
    "DefinedSchedule",
    "ScheduleDefinitionProjection",
    "ScheduleFireDeliveryDispatchInput",
    "ScheduleFireDeliveryDispatchResult",
    "ScheduleFireDispatchResult",
    "SchedulePrincipal",
    "ScheduleRuntime",
  ],
  modules.runtimeSchedule,
)}
${renderTypeImport(["LedgerTruthIdentity"], modules.runtimeProtocol)}

type GeneratedScheduleDefinition = {
  readonly scheduleId: string;
  readonly path: string;
  readonly cron: string;
  readonly schedule: DefinedSchedule;
};

export type GeneratedScheduleTriggerInput = {
  readonly scheduleId: string;
  readonly scheduledAt: string | number | Date;
  readonly appPrincipal: SchedulePrincipal;
};

export type GeneratedScheduleDispatchInput = GeneratedScheduleTriggerInput & {
  readonly runtime: ScheduleRuntime;
  readonly identity: LedgerTruthIdentity;
};

export type GeneratedScheduleDeliveryDispatchInput = GeneratedScheduleDispatchInput & {
  readonly history: ScheduleFireDeliveryDispatchInput["history"];
};

export const generatedSchedules = ${entries} as const satisfies ReadonlyArray<GeneratedScheduleDefinition>;
export const generatedScheduleDefinitions = generatedSchedules.map(
  ({ scheduleId, path, cron }) => ({ scheduleId, path, cron }),
) satisfies ReadonlyArray<ScheduleDefinitionProjection>;
export const generatedScheduleIds = generatedScheduleDefinitions.map((entry) => entry.scheduleId);
export const generatedScheduleRegistry = new Map(
  generatedSchedules.map((entry) => [entry.scheduleId, entry]),
);

export const dispatchGeneratedSchedule = async (
  input: GeneratedScheduleDispatchInput,
): Promise<ScheduleFireDispatchResult> => {
  const entry = generatedScheduleRegistry.get(input.scheduleId);
  if (entry === undefined) {
    throw new Error(\`unknown generated schedule: \${input.scheduleId}\`);
  }
  return dispatchScheduleFire({
    runtime: input.runtime,
    schedule: entry.schedule,
    scheduleId: entry.scheduleId,
    appPrincipal: input.appPrincipal,
    scheduledAt: input.scheduledAt,
    scopeRef: input.identity.scopeRef,
    effectAuthorityRef: input.identity.effectAuthorityRef,
  });
};

export const dispatchGeneratedScheduleDelivery = async (
  input: GeneratedScheduleDeliveryDispatchInput,
): Promise<ScheduleFireDeliveryDispatchResult> => {
  const entry = generatedScheduleRegistry.get(input.scheduleId);
  if (entry === undefined) {
    throw new Error(\`unknown generated schedule: \${input.scheduleId}\`);
  }
  return dispatchScheduleFireDelivery({
    history: input.history,
    runtime: input.runtime,
    schedule: entry.schedule,
    scheduleId: entry.scheduleId,
    appPrincipal: input.appPrincipal,
    scheduledAt: input.scheduledAt,
    scopeRef: input.identity.scopeRef,
    effectAuthorityRef: input.identity.effectAuthorityRef,
  });
};
`;
};

export const renderSkillCatalog = (skills: ReadonlyArray<StaticTargetSkill>): string => {
  const entries = skills.map(
    (skill) =>
      `  ${JSON.stringify(
        stableJsonValue({
          description: skill.description,
          digest: skill.digest,
          files: skill.files.map((file) => ({
            bytes: file.bytes,
            digest: file.digest,
            path: file.path,
            resourceRef: `${skill.name}/${file.path}@${file.digest}`,
          })),
          name: skill.name,
          path: skill.path,
          text: skill.text,
        }),
      )}`,
  );
  return entries.length === 0 ? "[]" : `[\n${entries.join(",\n")}\n]`;
};

export const renderSkillResourceBundle = (skills: ReadonlyArray<StaticTargetSkill>): string =>
  stableJson(
    Object.fromEntries(
      skills.flatMap((skill) =>
        skill.files.map(
          (file) => [`${skill.name}/${file.path}@${file.digest}`, file.contentBase64] as const,
        ),
      ),
    ),
  );

export const renderInstructionFragments = (
  fragments: ReadonlyArray<StaticTargetInstructionFragment>,
): string => {
  const entries = [...fragments]
    .sort((left, right) => left.fragmentId.localeCompare(right.fragmentId))
    .map(
      (fragment) =>
        `  ${JSON.stringify(
          stableJsonValue({
            digest: fragment.digest,
            id: fragment.fragmentId,
            text: fragment.text,
          }),
        )}`,
    );
  return entries.length === 0 ? "[]" : `[\n${entries.join(",\n")}\n]`;
};
