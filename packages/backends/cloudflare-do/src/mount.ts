import type { AnyMaterializedProjectionDefinition } from "@agent-os/runtime";
import type {
  AgentBindings,
  AgentHandler,
  AgentManifestProjection,
  AgentManifest,
  AgentMountWarning,
  HandlerKind,
  MountedAgent,
} from "@agent-os/runtime-protocol";
import { mountAgent, projectAgentManifest } from "@agent-os/runtime-protocol";

export interface CloudflareAgentMountPort {
  readonly backend: "cloudflare-do";
  readonly backendProtocol: "@agent-os/backend-protocol";
  readonly runtimeProtocol: "@agent-os/runtime-protocol";
  readonly transport: "sse-http";
}

export const cloudflareAgentMountPort: CloudflareAgentMountPort = {
  backend: "cloudflare-do",
  backendProtocol: "@agent-os/backend-protocol",
  runtimeProtocol: "@agent-os/runtime-protocol",
  transport: "sse-http",
};

export interface CloudflareAgentDriverConfig {
  readonly manifest: AgentManifest;
  readonly bindings: CloudflareAgentBindings;
  readonly port: CloudflareAgentMountPort;
  readonly warnings: ReadonlyArray<AgentMountWarning>;
}

export type CloudflareAgentBindings = Omit<AgentBindings<never>, "handlers"> & {
  readonly handlers: Readonly<Partial<Record<HandlerKind, AgentHandler>>>;
};

export interface CloudflareAgentProjectionSinks {
  readonly info: AgentManifestProjection;
  readonly materialized: ReadonlyArray<AnyMaterializedProjectionDefinition>;
}

export interface CloudflareAgentMount {
  readonly driverConfig: CloudflareAgentDriverConfig;
  readonly projectionSinks: CloudflareAgentProjectionSinks;
}

export interface CloudflareAgentProjectionSinkConfig {
  readonly materialized?: ReadonlyArray<AnyMaterializedProjectionDefinition>;
}

export const mountCloudflareAgent = (
  manifest: AgentManifest,
  bindings: CloudflareAgentBindings,
  projectionSinkConfig: CloudflareAgentProjectionSinkConfig = {},
): CloudflareAgentMount => {
  const mounted: MountedAgent<HandlerKind, CloudflareAgentMountPort> = mountAgent(
    manifest as AgentManifest<HandlerKind>,
    bindings as AgentBindings<HandlerKind>,
    cloudflareAgentMountPort,
  );
  return {
    driverConfig: {
      manifest: mounted.manifest,
      bindings: mounted.bindings,
      port: mounted.port,
      warnings: mounted.warnings,
    },
    projectionSinks: {
      info: projectAgentManifest(mounted.manifest),
      materialized: projectionSinkConfig.materialized ?? [],
    },
  };
};
