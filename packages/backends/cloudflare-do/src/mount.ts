import type {
  AgentBindings,
  AgentHandler,
  AgentManifestProjection,
  AgentManifest,
  AgentMountWarning,
  HandlerKind,
  MountedAgent,
} from "@agent-os/runtime-protocol";
import {
  defineAgentBindings,
  defineAgentManifest,
  mountAgent,
  projectAgentManifest,
} from "@agent-os/runtime-protocol";

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
  readonly bindings: Omit<AgentBindings<never>, "handlers"> & {
    readonly handlers: Readonly<Partial<Record<HandlerKind, AgentHandler>>>;
  };
  readonly port: CloudflareAgentMountPort;
  readonly warnings: ReadonlyArray<AgentMountWarning>;
}

export interface CloudflareAgentProjectionSinks {
  readonly info: AgentManifestProjection;
}

export interface CloudflareAgentMount {
  readonly driverConfig: CloudflareAgentDriverConfig;
  readonly projectionSinks: CloudflareAgentProjectionSinks;
}

export const defaultCloudflareAgentManifest = defineAgentManifest({
  agentId: "agent.cloudflare-do",
  scope: { kind: "conversation", idSource: "submit_scope" },
  effectAuthorityRef: { authorityClass: "agent", authorityId: "cloudflare-do" },
  handlers: [] as const,
});

const defaultCloudflareAgentBindings = defineAgentBindings<never>({
  handlers: {},
});

export const mountCloudflareAgent = <K extends HandlerKind = never>(
  manifest: AgentManifest<K> = defaultCloudflareAgentManifest as AgentManifest<K>,
  bindings: AgentBindings<K> = defaultCloudflareAgentBindings as AgentBindings<K>,
): CloudflareAgentMount => {
  const mounted: MountedAgent<K, CloudflareAgentMountPort> = mountAgent(
    manifest,
    bindings,
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
    },
  };
};
