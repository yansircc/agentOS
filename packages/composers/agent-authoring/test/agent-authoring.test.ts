import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  | ".agentos/generated/sveltekit.remote.ts"
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const buildCli = path.join(repoRoot, "packages/composers/agent-authoring/bin/build-cli.ts");
const workspaceDefaultToolNames = ["bash", "glob", "grep", "read_file", "write_file"] as const;

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
              read_file: {
                interaction: 123,
                receiptPolicy: "none",
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
      field: "/tools/read_file/interaction",
      reason: "interaction_invalid",
    });
    expect(result.issues).toContainEqual({
      kind: "workspace_default_tool_control_field_forbidden",
      path: "agent.json",
      toolId: "read_file",
      field: "receiptPolicy",
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

  it("rejects agent.json tool controls for custom and obsolete slugs", () => {
    const result = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Lookup." },
        {
          path: "agent/agent.json",
          kind: "json",
          value: {
            tools: {
              weather: false,
              delete_path: false,
              edit_file: false,
              list_files: false,
              glob_files: false,
              grep_files: false,
            },
          },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          kind: "unknown_workspace_default_tool_control",
          path: "agent.json",
          toolId: "weather",
        },
        {
          kind: "unknown_workspace_default_tool_control",
          path: "agent.json",
          toolId: "delete_path",
        },
        {
          kind: "unknown_workspace_default_tool_control",
          path: "agent.json",
          toolId: "edit_file",
        },
        {
          kind: "unknown_workspace_default_tool_control",
          path: "agent.json",
          toolId: "list_files",
        },
        {
          kind: "unknown_workspace_default_tool_control",
          path: "agent.json",
          toolId: "glob_files",
        },
        {
          kind: "unknown_workspace_default_tool_control",
          path: "agent.json",
          toolId: "grep_files",
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
    expect(Object.keys(normalized.value.deployment.manifest.tools ?? {}).sort()).toEqual([
      ...workspaceDefaultToolNames,
    ]);
    expect(normalized.value.deployment.manifest.tools?.read_file).toEqual({
      bindingRef: "read_file",
      executionDomain: "workspace",
      interaction: "never",
      materialRefs: ["workspace"],
      effects: ["workspace_read"],
      receiptPolicy: "workspace.snapshot",
    });
    expect(normalized.value.deployment.manifest.tools?.bash?.interaction).toBe("never");
    expect(normalized.value.deployment.manifest.materials?.workspace).toEqual({
      kind: "external_resource",
      provider: "agent-os",
      resourceKind: "workspace-env",
      ref: normalized.value.workspace.providerResourceId,
    });
    expect(normalized.value.deployment.manifest.executionDomains).toMatchObject({
      "app-runtime": { bindingRef: "app-runtime" },
      workspace: { bindingRef: "workspace" },
    });
    expect(normalized.value.deployment.manifest.interactions).toEqual({
      approval: { bindingRef: "approval" },
      never: { bindingRef: "never" },
    });
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
    expect(normalized.value.workspace.cloudflareSandboxId).toMatch(/^[a-z0-9-]{1,63}$/);
    expect(normalized.value.workspace.cloudflareSandboxId).not.toBe(
      normalized.value.workspace.providerResourceId,
    );
    expect(normalized.value.workspace.cloudflareSandboxId.length).toBeLessThanOrEqual(63);
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
    expect(normalized.value.origins["/workspace/cloudflareSandboxId"]).toBe(
      "derived:/workspace/providerResourceId",
    );
    expect(normalized.value.provenance.manifest["/tools/read_file/bindingRef"]).toBe(
      "macro(workspace@1)#/tools/read_file/bindingRef",
    );
    expect(normalized.value.provenance.manifest["/tools/bash/interaction"]).toBe(
      "macro(workspace@1)#/tools/bash/interaction",
    );
    expect(normalized.value.provenance.manifest["/materials/workspace"]).toBe(
      "macro(workspace@1)#/materials/workspace",
    );
    expect(normalized.value.provenance.manifest["/executionDomains/workspace/bindingRef"]).toBe(
      "macro(workspace@1)#/executionDomains/workspace/bindingRef",
    );
    expect(normalized.value.provenance.manifest["/interactions/approval/bindingRef"]).toBe(
      "default:framework-defaults@agentos/v1#/interactions/approval/bindingRef",
    );
  });

  it("fails closed when final manifest tool refs do not resolve", () => {
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
        {
          path: "agent/tools/custom_effect.ts",
          kind: "tool",
          declaration: {
            effects: ["provider_call"],
            materialRefs: ["missing_material"],
            executionDomain: "missing_domain",
            interaction: "missing_interaction",
            receiptPolicy: "required",
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

    expect(normalized).toEqual({
      ok: false,
      issues: [
        {
          kind: "tool_material_ref_unresolved",
          toolId: "custom_effect",
          materialRef: "missing_material",
        },
        {
          kind: "tool_execution_domain_ref_unresolved",
          toolId: "custom_effect",
          executionDomain: "missing_domain",
        },
        {
          kind: "tool_interaction_ref_unresolved",
          toolId: "custom_effect",
          interaction: "missing_interaction",
        },
      ],
    });
  });

  it("allows safety-monotone interaction overrides for workspace defaults", () => {
    const compiled = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Run workspace tasks." },
        {
          path: "agent/agent.json",
          kind: "json",
          value: {
            agentId: "agent.workspace",
            scope: { kind: "session", idSource: "manifest", stableScopeId: "workspace-ledger" },
            tools: {
              write_file: { interaction: "approval" },
            },
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
    expect(normalized.value.deployment.manifest.tools?.write_file?.interaction).toBe("approval");
    expect(normalized.value.provenance.manifest["/tools/write_file/interaction"]).toBe(
      "author:agent/agent.json#/tools/write_file/interaction",
    );
    expect(normalized.value.provenance.manifest["/tools/write_file/receiptPolicy"]).toBe(
      "macro(workspace@1)#/tools/write_file/receiptPolicy",
    );
  });

  it("rejects unsafe and obsolete workspace default controls", () => {
    const obsoleteDefault = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Run workspace tasks." },
        {
          path: "agent/agent.json",
          kind: "json",
          value: {
            tools: {
              run_shell: { interaction: "never" },
            },
          },
        },
      ],
    });
    expect(obsoleteDefault).toEqual({
      ok: false,
      issues: [
        {
          kind: "unknown_workspace_default_tool_control",
          path: "agent.json",
          toolId: "run_shell",
        },
      ],
    });

    const receiptOverride = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Run workspace tasks." },
        {
          path: "agent/agent.json",
          kind: "json",
          value: {
            tools: {
              write_file: { receiptPolicy: "none" },
            },
          },
        },
      ],
    });
    expect(receiptOverride).toEqual({
      ok: false,
      issues: [
        {
          kind: "workspace_default_tool_control_field_forbidden",
          path: "agent.json",
          toolId: "write_file",
          field: "receiptPolicy",
        },
      ],
    });
  });

  it("applies disable controls before resolving default/custom collisions", () => {
    const enabledShadow = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Run workspace tasks." },
        { path: "agent/tools/write_file.ts", kind: "tool", declaration: {} },
      ],
    });
    expect(enabledShadow.ok).toBe(true);
    if (!enabledShadow.ok) expect.fail(JSON.stringify(enabledShadow.issues));
    const enabledShadowNormalized = normalizeAgentOsConfig(
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
      enabledShadow.value,
    );
    expect(enabledShadowNormalized).toEqual({
      ok: false,
      issues: [
        {
          kind: "workspace_default_tool_shadowed",
          path: "tools/write_file.ts",
          toolId: "write_file",
        },
      ],
    });

    const disabledReplacement = compileAgentTree({
      files: [
        { path: "agent/instructions.md", kind: "markdown", text: "Run workspace tasks." },
        {
          path: "agent/agent.json",
          kind: "json",
          value: {
            agentId: "agent.workspace",
            scope: { kind: "session", idSource: "manifest", stableScopeId: "workspace-ledger" },
            tools: {
              write_file: false,
              bash: false,
            },
          },
        },
        { path: "agent/tools/write_file.ts", kind: "tool", declaration: {} },
      ],
    });
    expect(disabledReplacement.ok).toBe(true);
    if (!disabledReplacement.ok) expect.fail(JSON.stringify(disabledReplacement.issues));
    const disabledReplacementNormalized = normalizeAgentOsConfig(
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
      disabledReplacement.value,
    );
    expect(disabledReplacementNormalized.ok).toBe(true);
    if (!disabledReplacementNormalized.ok) {
      expect.fail(JSON.stringify(disabledReplacementNormalized.issues));
    }
    expect(
      Object.keys(disabledReplacementNormalized.value.deployment.manifest.tools ?? {}),
    ).toEqual(["glob", "grep", "read_file", "write_file"]);
    expect(disabledReplacementNormalized.value.deployment.manifest.tools?.bash).toBeUndefined();
    expect(disabledReplacementNormalized.value.deployment.manifest.tools?.write_file).toEqual({
      bindingRef: "tool.write_file",
      executionDomain: "app-runtime",
      interaction: "never",
    });
    expect(disabledReplacementNormalized.value.authoredToolNames).toEqual(["write_file"]);
    expect(disabledReplacementNormalized.value.provenance.exclusions).toEqual({
      "/tools/bash": "author:agent/agent.json#/tools/bash",
      "/tools/write_file": "author:agent/agent.json#/tools/write_file",
    });

    const linked = linkWorkspaceStaticTarget(disabledReplacementNormalized.value);
    expect(linked.ok).toBe(true);
    if (!linked.ok) expect.fail(JSON.stringify(linked.issues));
    expect(linked.value.moduleGraph).toContainEqual({
      kind: "authored-tool",
      source: "../../agent/tools/write_file",
      imports: ["default as tool_0"],
    });
    const target = generatedText(linked, ".agentos/generated/target.ts");
    expect(target).toContain('import tool_0 from "../../agent/tools/write_file";');
    expect(target).toContain('"write_file": tool_0');
    expect(target).toContain(
      'const generatedWorkspaceToolNames = ["glob", "grep", "read_file"] as const;',
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
        source: "@agent-os/runtime/cloudflare",
        imports: ["createAgentDurableObject", "installCloudflareWorkspaceOperationProvider"],
      },
      {
        kind: "provider-runtime",
        source: "@agent-os/runtime/llm-effect-ai",
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
        kind: "client-transport",
        source: "./sveltekit.remote",
        imports: ["invokeAgentCommand", "runEventStream"],
      },
      {
        kind: "client-transport",
        source: "$app/server",
        imports: ["command", "getRequestEvent", "query"],
      },
      {
        kind: "client-transport",
        source: "@agent-os/sse-http",
        imports: ["decodeSseHttpEvents", "responseToSseHttpChunks"],
      },
      {
        kind: "client-core",
        source: "@agent-os/client",
        imports: ["AgentClientSnapshot"],
      },
      {
        kind: "client-framework",
        source: "@agent-os/client/svelte",
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
      toolNames: [...workspaceDefaultToolNames],
    });
    expect(linked.value.mount).toMatchObject({
      driver: { kind: "cloudflare-do", className: "AgentOS", binding: "AGENT_OS" },
      projectionSinks: [
        "agent.info",
        "workspace.state",
        "workspace.files",
        "runtime.events",
        "runtime.input_requests",
      ],
    });

    const target = generatedText(linked, ".agentos/generated/target.ts");
    expect(target).toContain('import semanticDeclarations from "./manifest.json";');
    expect(target).toContain('import deploymentProvenance from "./deployment.json";');
    expect(target).toContain(
      'import { createAgentDurableObject, installCloudflareWorkspaceOperationProvider } from "@agent-os/runtime/cloudflare";',
    );
    expect(target).toContain(
      'import { OpenAiCompatibleLlmTransportLive } from "@agent-os/runtime/llm-effect-ai";',
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
    expect(target).not.toContain('import tool_0 from "../../agent/tools/bash";');
    expect(target).toContain("manifest: semanticManifest");
    expect(target).toContain("llmTransport: () => OpenAiCompatibleLlmTransportLive");
    expect(target).toContain(
      'const generatedWorkspaceToolNames = ["bash", "glob", "grep", "read_file", "write_file"] as const;',
    );
    expect(target).toContain(
      `const generatedWorkspaceSandboxId = "${normalized.value.workspace.cloudflareSandboxId}";`,
    );
    expect(target).toContain("bindWorkspaceToolsForRuntime({");
    expect(target).toContain("toolNames: generatedWorkspaceToolNames");
    expect(target).toContain('mutationPolicy: "receipt-backed"');
    expect(target).toContain('shellPolicy: "receipt-backed"');
    expect(target).toContain("readonly OPENROUTER_DEFAULT_TEXT_MODEL?: string;");
    expect(target).toContain('ref.kind === "model" && ref.ref === "openrouter-default-text-model"');
    expect(target).toContain("const modelId = requiredStringMaterial(");
    expect(target).toContain("if (!modelId.ok) return modelId;");
    expect(target).toContain("modelId: modelId.value");
    expect(target).toContain(
      'materialValue(env, { kind: "model", ref: "openrouter-default-text-model" })',
    );
    expect(target).not.toContain('modelId: "openrouter-default-text-model"');
    expect(target).not.toContain("throw new TypeError");
    expect(target).toContain("installCloudflareWorkspaceOperationProvider({");
    expect(target).toContain("workspaceOperationInstallFor(env).extensions");
    expect(target).toContain("override submit(spec: AgentSubmitSpec): Promise<SubmitResult>");
    expect(target).toContain("submitRunInput(input: SubmitRunInput): Promise<SubmitResult>");
    expect(target).toContain("readWorkspaceState(");
    expect(target).toContain("workspaceFileEntryFor");
    expect(target).toContain("includeHidden: input.includeHidden ?? true");
    expect(target).toContain("readWorkspaceFile(");
    expect(target).toContain("resetWorkspace(): Promise<WorkspaceAgentMutationCommandOutput>");
    expect(target).toContain("destroyWorkspace(): Promise<WorkspaceAgentMutationCommandOutput>");
    expect(target).toContain("getSandbox(workspaceNamespaceFor(env), generatedWorkspaceSandboxId");
    expect(target).not.toContain(
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

    const remote = generatedText(linked, ".agentos/generated/sveltekit.remote.ts");
    expect(remote).toContain('import { command, getRequestEvent, query } from "$app/server";');
    expect(remote).toContain(
      'import { durableObjectRpcClient } from "@agent-os/runtime/cloudflare/do-rpc";',
    );
    expect(remote).toContain(
      'import { decodeSseHttpEvents, responseToSseHttpChunks } from "@agent-os/sse-http";',
    );
    expect(remote).toContain('import type { SseHttpEvent } from "@agent-os/sse-http";');
    expect(remote).toContain("const fail = (status: number, message: string): GeneratedFailure =>");
    expect(remote).toContain(
      "const rejectFailure = (failure: GeneratedFailure): Promise<never> =>",
    );
    expect(remote).toContain(
      'type AgentOSSubmitRunInput = Parameters<AgentOSRemote["submitRunInput"]>[0];',
    );
    expect(remote).toContain("): GeneratedResult<{ readonly input: AgentOSSubmitRunInput }> =>");
    expect(remote).toContain("export const invokeAgentCommand = command(");
    expect(remote).toContain("runtime.submitRunInput(submitInput.value.input)");
    expect(remote).toContain("runtime.readWorkspaceState(readStateInput.value)");
    expect(remote).toContain("iterator.return(undefined)");
    expect(remote).toContain('import { Result, Schema } from "effect";');
    expect(remote).toContain(
      "const jsonValueFromString = (data: string): GeneratedResult<unknown>",
    );
    expect(remote).toContain("Result.try({");
    expect(remote).toContain("const ledgerEventFromSse = (");
    expect(remote).toContain('if (event.event !== "ledger") return { ok: true, value: null };');
    expect(remote).toContain('return fail(502, "invalid ledger stream event: empty data");');
    expect(remote).toContain('catch: () => "invalid ledger stream event: malformed JSON"');
    expect(remote).toContain("onFailure: (message) => fail(502, message)");
    expect(remote).toContain("const ledgerEvent = ledgerEventFromSse(result.value);");
    expect(remote).not.toContain("runtimeEventFromLedger(JSON.parse(result.value.data))");
    expect(remote).not.toContain("try {");
    expect(remote).not.toContain("} catch");
    expect(remote).toContain("runtime.readWorkspaceFile(readFileInput.value)");
    expect(remote).toContain("export const runEventStream = query.live(");
    expect(remote).toContain('platformEnv["AGENT_OS"] as DurableObjectNamespace');
    expect(remote).not.toContain("AgentSubmitSpec");
    expect(remote).not.toContain('from "@sveltejs/kit"');
    expect(remote).not.toContain("getSandbox");

    const deployment = generatedJson<{
      readonly workspace?: {
        readonly binding?: string;
        readonly bindingRef?: string;
        readonly root?: string;
        readonly topology?: unknown;
        readonly providerResourceId?: string;
        readonly cloudflareSandboxId?: string;
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
      cloudflareSandboxId: normalized.value.workspace.cloudflareSandboxId,
    });

    const client = generatedText(linked, ".agentos/generated/client.ts");
    expect(client).toContain(
      'import { createWorkspaceAgentClientBridge } from "@agent-os/workspace-agent";',
    );
    expect(client).toContain(
      'import { invokeAgentCommand, runEventStream } from "./sveltekit.remote";',
    );
    expect(client).toContain(
      'import { clientReadable, selectClientReadable } from "@agent-os/client/svelte";',
    );
    expect(client).toContain('import type { AgentClientSnapshot } from "@agent-os/client";');
    expect(client).toContain('import type { Readable } from "svelte/store";');
    expect(client).toContain("streamSource: options.streamSource ?? generatedStreamSource");
    expect(client).toContain("rpcInvoker: options.rpcInvoker ?? generatedRpcInvoker");
    expect(client).toContain("snapshot: clientReadable(bridge.client)");
    expect(client).toContain(
      "events: selectClientReadable(bridge.client, (snapshot) => snapshot.events)",
    );
    expect(client).toContain("inputRequests: selectClientReadable(");
    expect(client).not.toContain("new EventSource");
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
      source: "@yansirplus/runtime/cloudflare",
      imports: ["createAgentDurableObject", "installCloudflareWorkspaceOperationProvider"],
    });
    expect(publicLinked.value.moduleGraph).toContainEqual({
      kind: "client-framework",
      source: "@yansirplus/client/svelte",
      imports: ["clientReadable", "selectClientReadable"],
    });
    expect(generatedText(publicLinked, ".agentos/generated/target.ts")).toContain(
      'import { createAgentDurableObject, installCloudflareWorkspaceOperationProvider } from "@yansirplus/runtime/cloudflare";',
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

    const first = compile([]);
    const second = compile([]);
    const withExtraTool = compile(["custom_tool"]);

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
      source: "@agent-os/client/svelte",
      imports: ["clientReadable", "selectClientReadable"],
    });
    expect(
      generatedText({ ok: true, value: withExtraTool }, ".agentos/generated/client.ts"),
    ).not.toContain("@agent-os/client/svelte");
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

  it("exposes build as the package-owned agentos subcommand", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agent-authoring-build-cli-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
      mkdirSync(path.join(root, "agent"), { recursive: true });
      writeFileSync(path.join(root, "agent/instructions.md"), "Operate on workspace files.");
      writeFileSync(
        path.join(root, "agent/agent.json"),
        JSON.stringify(
          {
            agentId: "fixture-agent",
            scope: {
              kind: "session",
              idSource: "manifest",
              stableScopeId: "fixture-scope",
            },
            effectAuthorityRef: {
              authorityClass: "effect",
              authorityId: "fixture-agent",
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(root, "agentos.config.jsonc"),
        [
          "{",
          '  "$schema": "./node_modules/@agent-os/config/schema.json",',
          '  "profile": "workspace@1",',
          '  "agent": "./agent",',
          '  "deployment": { "id": "fixture-deployment", "version": "0.1.0" },',
          '  "target": {',
          '    "kind": "cloudflare-do@1",',
          '    "durableObject": { "className": "AgentOS", "binding": "AGENT_OS" }',
          "  },",
          '  "client": { "kind": "svelte-kit-remote@1" },',
          '  "llm": {',
          '    "route": "openai-chat-compatible",',
          '    "endpointRef": "openrouter",',
          '    "credentialRef": "openrouter-key",',
          '    "modelRef": "openrouter-default-text-model"',
          "  },",
          '  "workspace": { "binding": "Sandbox", "root": "/workspace" }',
          "}",
          "",
        ].join("\n"),
      );

      const result = spawnSync("bun", [buildCli, "build", "--cwd", root], {
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("generated 8 agentOS files");
      const manifest = JSON.parse(
        readFileSync(path.join(root, ".agentos/generated/manifest.json"), "utf8"),
      ) as { readonly agentId?: string; readonly tools?: Record<string, unknown> };
      expect(manifest.agentId).toBe("fixture-agent");
      expect(Object.keys(manifest.tools ?? {}).sort()).toEqual([...workspaceDefaultToolNames]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
