import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";

import {
  AGENTOS_CONFIG_CLIENT,
  AGENTOS_CONFIG_LLM_ROUTE,
  AGENTOS_CONFIG_PROFILE,
  AGENTOS_CONFIG_TARGET,
  WORKSPACE_TOPOLOGY,
  decodeAgentOsConfig,
} from "../src";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(fs.readFileSync(path.join(packageRoot, "schema.json"), "utf8")) as {
  readonly properties: {
    readonly profile: { readonly const: string };
    readonly target: { readonly properties: { readonly kind: { readonly const: string } } };
    readonly client: {
      readonly properties: { readonly kind: { readonly enum: ReadonlyArray<string> } };
    };
    readonly llm: { readonly properties: { readonly route: { readonly const: string } } };
    readonly workspace: {
      readonly properties: {
        readonly topology: {
          readonly properties: { readonly kind: { readonly const: string } };
        };
      };
    };
  };
};

describe("agentOS config package", () => {
  it("exposes the public schema constants from the same config vocabulary as the decoder", () => {
    expect(schema.properties.profile.const).toBe(AGENTOS_CONFIG_PROFILE.WORKSPACE_V1);
    expect(schema.properties.target.properties.kind.const).toBe(
      AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1,
    );
    expect(schema.properties.client.properties.kind.enum).toEqual([
      AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1,
      AGENTOS_CONFIG_CLIENT.BROWSER_DIRECT_V1,
    ]);
    expect(schema.properties.llm.properties.route.const).toBe(
      AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE,
    );
    expect(schema.properties.workspace.properties.topology.properties.kind.const).toBe(
      WORKSPACE_TOPOLOGY.PER_SCOPE,
    );
  });

  it("reuses the authoring decoder instead of defining a second config decoder", () => {
    const decoded = decodeAgentOsConfig({
      $schema: "./node_modules/@agent-os/config/schema.json",
      profile: AGENTOS_CONFIG_PROFILE.WORKSPACE_V1,
      agent: "./agent",
      deployment: { id: "web-cursor-demo", version: "0.1.0" },
      target: {
        kind: AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1,
        durableObject: { className: "AgentOS", binding: "AGENT_OS" },
      },
      client: { kind: AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1 },
      llm: {
        route: AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE,
        endpointRef: "openrouter",
        credentialRef: "openrouter-key",
        modelRef: "openrouter-default-text-model",
      },
      workspace: {
        binding: "Sandbox",
        root: "/workspace",
        topology: {
          kind: WORKSPACE_TOPOLOGY.PER_SCOPE,
          allocator: "workspace-per-scope-v1",
        },
      },
    });

    expect(decoded.ok).toBe(true);
  });
});
