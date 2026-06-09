import type {
  AgentBindings,
  AgentManifest,
  HandlerKind,
  MountedAgent,
} from "@agent-os/runtime-protocol";
import { defineAgentBindings, defineAgentManifest, mountAgent } from "@agent-os/runtime-protocol";

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

const defaultCloudflareAgentManifest = defineAgentManifest({
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
): MountedAgent<K, CloudflareAgentMountPort> =>
  mountAgent(manifest, bindings, cloudflareAgentMountPort);
