import { describe, expect, it } from "@effect/vitest";

import {
  AGENTOS_CONFIG_CLIENT,
  AGENTOS_CONFIG_LLM_ROUTE,
  AGENTOS_CONFIG_PROFILE,
  AGENTOS_CONFIG_TARGET,
  WORKSPACE_TOPOLOGY,
  compileAgentTree,
  decodeAgentOsConfig,
  linkWorkspaceStaticTarget,
  normalizeAgentOsConfig,
  type AgentOsConfigV1,
} from "../src";

type StaticTargetGeneratedPath =
  | ".agentos/generated/manifest.json"
  | ".agentos/generated/deployment.json"
  | ".agentos/generated/provenance.json"
  | ".agentos/generated/fingerprints.json"
  | ".agentos/generated/target.ts"
  | ".agentos/generated/client.ts"
  | ".agentos/generated/client.d.ts";

const generatedText = (
  result: ReturnType<typeof linkWorkspaceStaticTarget>,
  path: StaticTargetGeneratedPath,
): string => {
  expect(result.ok).toBe(true);
  if (!result.ok) expect.fail(JSON.stringify(result.issues));
  const file = result.value.files.find((item) => item.path === path);
  expect(file).toBeDefined();
  return file?.text ?? "";
};

const generatedJson = <T>(
  result: ReturnType<typeof linkWorkspaceStaticTarget>,
  path: StaticTargetGeneratedPath,
): T => JSON.parse(generatedText(result, path)) as T;

describe("agent authored tree compiler", () => {
  it("compiles a minimal authored tree to AgentManifest<Authored> with provenance", () => {
    const result = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Answer with weather facts." },
        {
          path: "agent/tools/weather.ts",
          kind: "tool",
          declaration: {},
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) expect.fail(JSON.stringify(result.issues));
    expect(result.value.manifest.agentId).toBe("agent");
    expect(result.value.manifest.value.agentId).toBe("agent");
    expect(Object.prototype.propertyIsEnumerable.call(result.value.manifest, "value")).toBe(false);
    expect(result.value.manifest.instructions).toEqual({
      path: "agent/instructions.md",
      digest: expect.stringMatching(/^fnv1a32:[0-9a-f]{8}:/),
    });
    expect(result.value.manifest.scope).toEqual({
      kind: "conversation",
      idSource: "submit_scope",
    });
    expect(result.value.manifest.llmRoutes).toEqual({
      default: { bindingRef: "llm.default" },
    });
    expect(result.value.manifest.tools?.weather).toEqual({
      bindingRef: "tool.weather",
      executionDomain: "app-runtime",
      interaction: "never",
    });
    expect(result.value.provenance["/tools/weather/bindingRef"]).toBe(
      "path:agent/tools/weather.ts",
    );
    expect(result.value.provenance["/tools/weather/executionDomain"]).toBe(
      "default:framework-defaults@agentos/v1#/tools/weather/executionDomain",
    );
    expect(result.value.provenance["/tools/weather/interaction"]).toBe(
      "default:framework-defaults@agentos/v1#/tools/weather/interaction",
    );
    expect(result.value.provenance["/llmRoutes/default/bindingRef"]).toBe(
      "default:framework-defaults@agentos/v1#/llmRoutes/default/bindingRef",
    );
    expect(result.value.provenance["/scope"]).toBe("default:framework-defaults@agentos/v1#/scope");
    expect(result.value.provenance["/handlers"]).toBe(
      "default:framework-defaults@agentos/v1#/handlers",
    );
    expect(result.value.provenance["/effectAuthorityRef"]).toBe(
      "default:framework-defaults@agentos/v1#/effectAuthorityRef",
    );
    expect(result.value.provenance["/agentId"]).toBe(
      "default:framework-defaults@agentos/v1#/agentId",
    );
  });

  it("keeps generated runtime artifacts out of the manifest", () => {
    const result = compileAgentTree({
      files: [
        { path: "instructions.md", kind: "markdown", text: "run" },
        {
          path: "agent.json",
          kind: "json",
          value: {
            agentId: "agent.authored",
            handlers: ["user_message"],
            workerEntry: "./worker.ts",
          },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ kind: "unknown_field", path: "agent.json", field: "workerEntry" }],
    });
  });

  it("rejects malformed agent.json value domains instead of casting them into manifest facts", () => {
    const result = compileAgentTree({
      files: [
        { path: "instructions.md", kind: "markdown", text: "run" },
        {
          path: "agent.json",
          kind: "json",
          value: {
            scope: { kind: "conversation", idSource: "bogus" },
            effectAuthorityRef: { authorityId: "", authorityClass: 123 },
            handlers: [123],
            llmRoutes: { default: { bindingRef: 123 } },
            materials: { weather: { kind: "credential", ref: "" } },
            executionDomains: { workspace: { bindingRef: 123 } },
            interactions: { approval: { bindingRef: 123 } },
            tools: {
              weather: {
                bindingRef: 123,
                materialRefs: ["weather", 1],
                effects: ["network", 1],
              },
            },
            outputSchema: { fingerprint: "not-a-schema" },
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) expect.fail("malformed agent.json compiled successfully");
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/scope/idSource",
      reason: "scope_id_source_invalid",
    });
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/effectAuthorityRef",
      reason: "authority_ref_invalid",
    });
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/handlers/0",
      reason: "handler_kind_invalid",
    });
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/llmRoutes/bindingRef",
      reason: "non_empty_string_required",
    });
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/materials",
      reason: "material_ref_invalid",
    });
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/executionDomains/bindingRef",
      reason: "non_empty_string_required",
    });
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/interactions/bindingRef",
      reason: "non_empty_string_required",
    });
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/bindingRef",
      reason: "non_empty_string_required",
    });
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/materialRefs[1]",
      reason: "non_empty_string_required",
    });
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/effects[1]",
      reason: "non_empty_string_required",
    });
    expect(result.issues).toContainEqual({
      kind: "invalid_authored_value",
      path: "agent.json",
      field: "/outputSchema",
      reason: "agent_schema_spec_invalid",
    });
  });

  it("rejects explicit non-string domain and interaction binding refs", () => {
    const result = compileAgentTree({
      files: [
        { path: "instructions.md", kind: "markdown", text: "run" },
        {
          path: "domains/workspace.json",
          kind: "json",
          value: { bindingRef: 123 },
        },
        {
          path: "interactions/approval.json",
          kind: "json",
          value: { bindingRef: "" },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          kind: "invalid_authored_value",
          path: "domains/workspace.json",
          field: "/bindingRef",
          reason: "non_empty_string_required",
        },
        {
          kind: "invalid_authored_value",
          path: "interactions/approval.json",
          field: "/bindingRef",
          reason: "non_empty_string_required",
        },
      ],
    });
  });

  it("rejects effectful tools instead of filling dangerous defaults", () => {
    const result = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Fetch data." },
        {
          path: "agent/tools/fetch.ts",
          kind: "tool",
          declaration: { effects: ["provider_call"] },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        { kind: "effectful_tool_missing_material", toolId: "fetch" },
        { kind: "effectful_tool_missing_execution_domain", toolId: "fetch" },
        { kind: "effectful_tool_missing_interaction", toolId: "fetch" },
        { kind: "effectful_tool_missing_receipt_policy", toolId: "fetch" },
      ],
    });
  });

  it("rejects each missing effectful tool contract instead of defaulting it", () => {
    const cases = [
      {
        declaration: {
          effects: ["provider_call"],
          executionDomain: "workspace",
          interaction: "approval",
          receiptPolicy: "required",
        },
        expected: [{ kind: "effectful_tool_missing_material", toolId: "effectful" }],
      },
      {
        declaration: {
          effects: ["network"],
          interaction: "approval",
          receiptPolicy: "required",
        },
        expected: [{ kind: "effectful_tool_missing_execution_domain", toolId: "effectful" }],
      },
      {
        declaration: {
          effects: ["network"],
          executionDomain: "workspace",
          receiptPolicy: "required",
        },
        expected: [{ kind: "effectful_tool_missing_interaction", toolId: "effectful" }],
      },
    ] as const;

    for (const { declaration, expected } of cases) {
      const result = compileAgentTree({
        files: [
          { path: "agent/instructions.md", kind: "markdown", text: "Run effectfully." },
          {
            path: "agent/tools/effectful.ts",
            kind: "tool",
            declaration,
          },
        ],
      });

      expect(result).toEqual({ ok: false, issues: expected });
    }
  });

  it("rejects duplicate authored facts in one value layer", () => {
    const result = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Lookup." },
        {
          path: "agent/tools/weather.ts",
          kind: "tool",
          declaration: {},
        },
        {
          path: "agent/agent.json",
          kind: "json",
          value: {
            tools: {
              weather: { bindingRef: "tool.other" },
            },
          },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          kind: "duplicate_fact",
          factKey: "/tools/weather/bindingRef",
          origins: [
            "path:agent/tools/weather.ts",
            "author:agent/agent.json#/tools/weather/bindingRef",
          ],
        },
      ],
    });
  });

  it("normalizes workspace@1 JSONC data into the existing DeploymentSpec with origins", () => {
    const compiled = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Run workspace tasks." },
        {
          path: "agent/agent.json",
          kind: "json",
          value: {
            agentId: "agent.workspace",
            scope: { kind: "session", idSource: "manifest", stableScopeId: "workspace-ledger" },
          },
        },
        { path: "agent/tools/read_file.ts", kind: "tool", declaration: {} },
      ],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) expect.fail(JSON.stringify(compiled.issues));

    const config: AgentOsConfigV1 = {
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
      },
    };

    const normalized = normalizeAgentOsConfig(config, compiled.value);

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) expect.fail(JSON.stringify(normalized.issues));
    expect(normalized.value.deployment.deploymentId).toBe("web-cursor-demo");
    expect(normalized.value.deployment.manifest).toBe(compiled.value.manifest);
    expect(normalized.value.deployment).toMatchObject({
      backend: "cloudflare-do",
      adapter: "cloudflare-do@1",
      codec: "agentos-json@1",
      providerStrategy: "openai-chat-compatible",
    });
    expect(normalized.value.deploymentVersion).toBe("0.1.0");
    expect(normalized.value.workspace.topology).toEqual({
      kind: WORKSPACE_TOPOLOGY.PER_SCOPE,
      allocator: "workspace-per-scope-v1",
    });
    expect(normalized.value.workspace.bindingRef).toBe("Sandbox");
    expect(normalized.value.workspace.providerResourceId).toBe(
      "agentos-provider-resource:workspace:v1:web-cursor-demo:Sandbox:per_scope:workspace-per-scope-v1:session%3Aworkspace-ledger",
    );
    expect(normalized.value.workspace.providerResourceId).not.toBe("workspace-ledger");
    expect(normalized.value.origins["/deployment/id"]).toBe(
      "author:agentos.config.jsonc#/deployment/id",
    );
    expect(normalized.value.origins["/workspace/topology/kind"]).toBe(
      "macro(workspace@1)#/workspace/topology/kind",
    );
    expect(normalized.value.origins["/deployment/backend"]).toBe("derived:/target/kind");
    expect(normalized.value.origins["/workspace/providerResourceId"]).toBe(
      "derived:/deployment/id+/workspace/binding+/workspace/topology+/agent/scope",
    );
  });

  it("accepts explicit workspace topology as authored data instead of macro default", () => {
    const compiled = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Run." },
        {
          path: "agent/agent.json",
          kind: "json",
          value: {
            agentId: "agent.workspace.explicit",
            scope: { kind: "session", idSource: "manifest", stableScopeId: "explicit-ledger" },
          },
        },
      ],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) expect.fail(JSON.stringify(compiled.issues));

    const normalized = normalizeAgentOsConfig(
      {
        profile: AGENTOS_CONFIG_PROFILE.WORKSPACE_V1,
        agent: "./agent",
        deployment: { id: "workspace-explicit" },
        target: {
          kind: AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1,
          durableObject: { className: "AgentOS", binding: "AGENT_OS" },
        },
        client: { kind: AGENTOS_CONFIG_CLIENT.BROWSER_DIRECT_V1 },
        llm: {
          route: AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE,
          endpointRef: "openrouter",
          credentialRef: "openrouter-key",
          modelRef: "model",
        },
        workspace: {
          binding: "Sandbox",
          root: "/workspace",
          topology: { kind: WORKSPACE_TOPOLOGY.PER_SCOPE, allocator: "custom-allocator" },
        },
      },
      compiled.value,
    );

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) expect.fail(JSON.stringify(normalized.issues));
    expect(normalized.value.workspace.topology.allocator).toBe("custom-allocator");
    expect(normalized.value.origins["/workspace/topology/allocator"]).toBe(
      "author:agentos.config.jsonc#/workspace/topology/allocator",
    );
  });

  it("fails config normalization when workspace topology cannot derive a manifest-owned scope", () => {
    const compiled = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Run." },
        {
          path: "agent/agent.json",
          kind: "json",
          value: {
            agentId: "agent.submit-scoped",
            scope: { kind: "conversation", idSource: "submit_scope" },
          },
        },
      ],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) expect.fail(JSON.stringify(compiled.issues));

    const normalized = normalizeAgentOsConfig(
      {
        profile: AGENTOS_CONFIG_PROFILE.WORKSPACE_V1,
        agent: "./agent",
        deployment: { id: "workspace-submit-scoped" },
        target: {
          kind: AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1,
          durableObject: { className: "AgentOS", binding: "AGENT_OS" },
        },
        client: { kind: AGENTOS_CONFIG_CLIENT.BROWSER_DIRECT_V1 },
        llm: {
          route: AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE,
          endpointRef: "openrouter",
          credentialRef: "openrouter-key",
          modelRef: "model",
        },
        workspace: {
          binding: "Sandbox",
          root: "/workspace",
        },
      },
      compiled.value,
    );

    expect(normalized.ok).toBe(false);
    if (normalized.ok) expect.fail("submit-scoped workspace config normalized successfully");
    expect(normalized.issues).toEqual([
      {
        kind: "workspace_scope_not_manifest_owned",
        path: "agent/agent.json#/scope",
        reason: "scope_not_manifest_owned",
      },
    ]);
  });

  it("links a closed workspace target as static imports plus semantic JSON data", () => {
    const compiled = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Run workspace tasks." },
        {
          path: "agent/agent.json",
          kind: "json",
          value: {
            agentId: "agent.workspace",
            scope: { kind: "session", idSource: "manifest", stableScopeId: "workspace-ledger" },
          },
        },
        { path: "agent/tools/write_file.ts", kind: "tool", declaration: {} },
        { path: "agent/tools/read_file.ts", kind: "tool", declaration: {} },
      ],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) expect.fail(JSON.stringify(compiled.issues));

    const normalized = normalizeAgentOsConfig(
      {
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
        },
      },
      compiled.value,
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) expect.fail(JSON.stringify(normalized.issues));

    const linked = linkWorkspaceStaticTarget(normalized.value);

    expect(linked.ok).toBe(true);
    if (!linked.ok) expect.fail(JSON.stringify(linked.issues));
    expect(linked.value.moduleGraph).toEqual([
      { kind: "semantic-json", source: "./manifest.json", imports: ["default as declarations"] },
      { kind: "semantic-json", source: "./deployment.json", imports: ["default as deployment"] },
      {
        kind: "target-runtime",
        source: "@agent-os/backend-cloudflare-do",
        imports: ["createAgentDurableObject", "installCloudflareWorkspaceOperationProvider"],
      },
      {
        kind: "provider-runtime",
        source: "@agent-os/llm-transport-effect-ai",
        imports: ["OpenAiCompatibleLlmTransportLive"],
      },
      {
        kind: "workspace-host",
        source: "@agent-os/workspace-agent",
        imports: ["defineWorkspaceAgentMount", "WORKSPACE_AGENT_PROJECTION"],
      },
      {
        kind: "workspace-binding",
        source: "@agent-os/workspace-binding",
        imports: ["bindWorkspaceToolsForRuntime"],
      },
      {
        kind: "execution-domain-runtime",
        source: "@agent-os/workspace-env-cloudflare",
        imports: ["makeCloudflareWorkspaceEnv"],
      },
      {
        kind: "platform-runtime",
        source: "@cloudflare/sandbox",
        imports: ["getSandbox", "Sandbox", "SandboxTransport"],
      },
      {
        kind: "effect-runtime",
        source: "effect",
        imports: ["Effect"],
      },
      {
        kind: "workspace-client",
        source: "@agent-os/workspace-agent",
        imports: [
          "createWorkspaceAgentClientBridge",
          "CreateWorkspaceAgentClientOptions",
          "WorkspaceAgentClientBridge",
        ],
      },
      {
        kind: "client-core",
        source: "@agent-os/client",
        imports: ["AgentClientSnapshot"],
      },
      {
        kind: "client-framework",
        source: "@agent-os/client-svelte",
        imports: ["clientReadable", "selectClientReadable"],
      },
      {
        kind: "client-framework",
        source: "svelte/store",
        imports: ["Readable"],
      },
    ]);
    expect(linked.value.canonicalDeployment).toEqual({
      target: AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1,
      llmRoute: AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE,
      client: AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1,
      workspaceTopology: {
        kind: WORKSPACE_TOPOLOGY.PER_SCOPE,
        allocator: "workspace-per-scope-v1",
      },
      toolNames: ["read_file", "write_file"],
    });
    expect(linked.value.mount).toMatchObject({
      driver: { kind: "cloudflare-do", className: "AgentOS", binding: "AGENT_OS" },
      projectionSinks: ["agent.info", "runtime.events", "runtime.input_requests"],
    });

    const target = generatedText(linked, ".agentos/generated/target.ts");
    expect(target).toContain('import semanticDeclarations from "./manifest.json";');
    expect(target).toContain('import deploymentProvenance from "./deployment.json";');
    expect(target).toContain(
      'import { createAgentDurableObject, installCloudflareWorkspaceOperationProvider } from "@agent-os/backend-cloudflare-do";',
    );
    expect(target).toContain(
      'import { OpenAiCompatibleLlmTransportLive } from "@agent-os/llm-transport-effect-ai";',
    );
    expect(target).toContain(
      'import { bindWorkspaceToolsForRuntime } from "@agent-os/workspace-binding";',
    );
    expect(target).toContain(
      'import { makeCloudflareWorkspaceEnv } from "@agent-os/workspace-env-cloudflare";',
    );
    expect(target).toContain('import { getSandbox } from "@cloudflare/sandbox";');
    expect(target).not.toContain('import tool_0 from "../../agent/tools/read_file";');
    expect(target).not.toContain('import tool_1 from "../../agent/tools/write_file";');
    expect(target).toContain("manifest: semanticManifest");
    expect(target).toContain("llmTransport: () => OpenAiCompatibleLlmTransportLive");
    expect(target).toContain(
      'const generatedWorkspaceToolNames = ["read_file", "write_file"] as const;',
    );
    expect(target).toContain("bindWorkspaceToolsForRuntime({");
    expect(target).toContain("toolNames: generatedWorkspaceToolNames");
    expect(target).toContain('mutationPolicy: "receipt-backed"');
    expect(target).toContain("installCloudflareWorkspaceOperationProvider({");
    expect(target).toContain("workspaceOperationInstallFor(env).extensions");
    expect(target).toContain("override submit(spec: AgentSubmitSpec): Promise<SubmitResult>");
    expect(target).toContain(
      'getSandbox(workspaceNamespaceFor(env), "agentos-provider-resource:workspace:v1:web-cursor-demo:Sandbox:per_scope:workspace-per-scope-v1:session%3Aworkspace-ledger"',
    );
    expect(target).toContain(
      'workspaceRef: "agentos-provider-resource:workspace:v1:web-cursor-demo:Sandbox:per_scope:workspace-per-scope-v1:session%3Aworkspace-ledger"',
    );

    const durableObjectConfig = target.slice(target.indexOf("createAgentDurableObject<"));
    expect(durableObjectConfig).not.toContain("deploymentProvenance");
    expect(durableObjectConfig).not.toContain("targetDeployment");
    expect(target).not.toContain("makeRuntime({");
    expect(target).not.toContain("dynamic import");
    expect(target).not.toContain("workspaceExtension(");

    const deployment = generatedJson<{
      readonly workspace?: {
        readonly binding?: string;
        readonly bindingRef?: string;
        readonly root?: string;
        readonly topology?: unknown;
        readonly providerResourceId?: string;
      };
    }>(linked, ".agentos/generated/deployment.json");
    expect(deployment.workspace).toEqual({
      binding: "Sandbox",
      bindingRef: "Sandbox",
      root: "/workspace",
      topology: {
        kind: WORKSPACE_TOPOLOGY.PER_SCOPE,
        allocator: "workspace-per-scope-v1",
      },
      providerResourceId:
        "agentos-provider-resource:workspace:v1:web-cursor-demo:Sandbox:per_scope:workspace-per-scope-v1:session%3Aworkspace-ledger",
    });

    const client = generatedText(linked, ".agentos/generated/client.ts");
    expect(client).toContain(
      'import { createWorkspaceAgentClientBridge } from "@agent-os/workspace-agent";',
    );
    expect(client).toContain(
      'import { clientReadable, selectClientReadable } from "@agent-os/client-svelte";',
    );
    expect(client).toContain('import type { AgentClientSnapshot } from "@agent-os/client";');
    expect(client).toContain('import type { Readable } from "svelte/store";');
    expect(client).toContain("createWorkspaceAgentClientBridge(options)");
    expect(client).toContain("snapshot: clientReadable(bridge.client)");
    expect(client).toContain(
      "events: selectClientReadable(bridge.client, (snapshot) => snapshot.events)",
    );
    expect(client).toContain("inputRequests: selectClientReadable(");
    expect(client).not.toContain("new EventSource");
    expect(client).not.toContain("query.live");
    expect(client).not.toContain("appendRuntimeEventsToSnapshot");
    expect(client).not.toContain("createAgentClient(");
    expect(client).not.toContain("@agent-os/ag-ui");

    const clientTypes = generatedText(linked, ".agentos/generated/client.d.ts");
    expect(clientTypes).toContain('} from "./client";');

    const publicLinked = linkWorkspaceStaticTarget(normalized.value, {
      packageScope: "@yansirplus",
    });
    expect(publicLinked.ok).toBe(true);
    if (!publicLinked.ok) expect.fail(JSON.stringify(publicLinked.issues));
    expect(publicLinked.value.moduleGraph).toContainEqual({
      kind: "target-runtime",
      source: "@yansirplus/backend-cloudflare-do",
      imports: ["createAgentDurableObject", "installCloudflareWorkspaceOperationProvider"],
    });
    expect(publicLinked.value.moduleGraph).toContainEqual({
      kind: "client-framework",
      source: "@yansirplus/client-svelte",
      imports: ["clientReadable", "selectClientReadable"],
    });
    expect(generatedText(publicLinked, ".agentos/generated/target.ts")).toContain(
      'import { createAgentDurableObject, installCloudflareWorkspaceOperationProvider } from "@yansirplus/backend-cloudflare-do";',
    );
    const publicClient = generatedText(publicLinked, ".agentos/generated/client.ts");
    expect(publicClient).toContain(
      'import { createWorkspaceAgentClientBridge } from "@yansirplus/workspace-agent";',
    );
    expect(publicClient).not.toContain("@agent-os/");

    expect(linkWorkspaceStaticTarget(normalized.value, { packageScope: "agent-os" })).toEqual({
      ok: false,
      issues: [{ kind: "invalid_static_package_scope", scope: "agent-os" }],
    });
  });

  it("emits byte-stable generated files and changes the module graph when tool imports change", () => {
    const compile = (tools: ReadonlyArray<string>) => {
      const compiled = compileAgentTree({
        files: [
          { path: "agent/instructions.md", kind: "markdown", text: "Run workspace tasks." },
          {
            path: "agent/agent.json",
            kind: "json",
            value: {
              agentId: "agent.workspace",
              scope: { kind: "session", idSource: "manifest", stableScopeId: "workspace-ledger" },
            },
          },
          ...tools.map((tool) => ({
            path: `agent/tools/${tool}.ts`,
            kind: "tool" as const,
            declaration: {},
          })),
        ],
      });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) expect.fail(JSON.stringify(compiled.issues));
      const normalized = normalizeAgentOsConfig(
        {
          profile: AGENTOS_CONFIG_PROFILE.WORKSPACE_V1,
          agent: "./agent",
          deployment: { id: "web-cursor-demo" },
          target: {
            kind: AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1,
            durableObject: { className: "AgentOS", binding: "AGENT_OS" },
          },
          client: { kind: AGENTOS_CONFIG_CLIENT.BROWSER_DIRECT_V1 },
          llm: {
            route: AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE,
            endpointRef: "openrouter",
            credentialRef: "openrouter-key",
            modelRef: "model",
          },
          workspace: {
            binding: "Sandbox",
            root: "/workspace",
          },
        },
        compiled.value,
      );
      expect(normalized.ok).toBe(true);
      if (!normalized.ok) expect.fail(JSON.stringify(normalized.issues));
      const linked = linkWorkspaceStaticTarget(normalized.value);
      expect(linked.ok).toBe(true);
      if (!linked.ok) expect.fail(JSON.stringify(linked.issues));
      return linked.value;
    };

    const first = compile(["read_file"]);
    const second = compile(["read_file"]);
    const withExtraTool = compile(["read_file", "custom_tool"]);

    expect(first.files).toEqual(second.files);
    expect(first.moduleGraph).toEqual(second.moduleGraph);
    expect(first.moduleGraph).not.toEqual(withExtraTool.moduleGraph);
    expect(withExtraTool.moduleGraph).toContainEqual({
      kind: "authored-tool",
      source: "../../agent/tools/custom_tool",
      imports: ["default as tool_0"],
    });
    expect(withExtraTool.moduleGraph).not.toContainEqual({
      kind: "client-framework",
      source: "@agent-os/client-svelte",
      imports: ["clientReadable", "selectClientReadable"],
    });
    expect(
      generatedText({ ok: true, value: withExtraTool }, ".agentos/generated/client.ts"),
    ).not.toContain("@agent-os/client-svelte");
    expect(generatedText({ ok: true, value: first }, ".agentos/generated/fingerprints.json")).toBe(
      generatedText({ ok: true, value: second }, ".agentos/generated/fingerprints.json"),
    );
  });

  it("rejects config runtime facts and executable values instead of normalizing them", () => {
    const decoded = decodeAgentOsConfig({
      profile: AGENTOS_CONFIG_PROFILE.WORKSPACE_V1,
      agent: "./agent",
      deployment: { id: "bad" },
      target: {
        kind: AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1,
        durableObject: { className: "AgentOS", binding: "AGENT_OS" },
      },
      client: { kind: AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1 },
      llm: {
        route: AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE,
        endpointRef: "openrouter",
        credentialRef: "openrouter-key",
        modelRef: "model",
      },
      workspace: {
        binding: "Sandbox",
        root: "/workspace",
        continuationRef: "cont",
      },
      deriveTarget: () => "cloudflare",
    });

    expect(decoded.ok).toBe(false);
    if (decoded.ok) expect.fail("invalid config decoded successfully");
    expect(decoded.issues).toContainEqual({
      kind: "runtime_fact_forbidden",
      path: "agentos.config.jsonc",
      field: "workspace.continuationRef",
    });
    expect(decoded.issues).toContainEqual({
      kind: "function_in_config",
      path: "agentos.config.jsonc.deriveTarget",
    });
    expect(decoded.issues).toContainEqual({
      kind: "unknown_field",
      path: "agentos.config.jsonc",
      field: "deriveTarget",
    });
  });
});
