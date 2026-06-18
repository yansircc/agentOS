import { describe, expect, it } from "@effect/vitest";

import { compileAgentTree } from "../src";

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
});
