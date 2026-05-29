import {
  validateToolRegistry,
  type ToolAdmitter,
  type ToolDefinition,
} from "@agent-os/kernel/tools";
import { materialRequirement } from "@agent-os/kernel/material-ref";
import { registerSkill, unregisterSkill, type SkillManifest } from "../src";

const originRef = {
  originId: "skill:test",
  originKind: "extension_package",
} as const;

const definition = (name: string): ToolDefinition => ({
  type: "function",
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
});

const admit: ToolAdmitter = () => ({ ok: true });

const manifest = (tools: SkillManifest["tools"]): SkillManifest => ({
  skillId: "test-skill",
  version: "0.1.0",
  originRef,
  tools,
});

describe("@agent-os/skill-registry", () => {
  it("registers a skill as core tools with skill origin and material requirements", () => {
    const requiredMaterials = [
      materialRequirement({
        slot: "api_token",
        kind: "credential",
        provider: "example",
        purpose: "tool_call",
      }),
    ];
    const result = registerSkill(
      manifest([
        {
          definition: definition("lookup"),
          authorityClass: "read",
          authorityId: "skill.lookup",
          requiredMaterials,
          admit,
          execute: async () => ({ ok: true }),
        },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.registration).toMatchObject({
      skillId: "test-skill",
      version: "0.1.0",
      toolIds: ["lookup"],
    });
    expect(validateToolRegistry(result.registration.tools)).toEqual({ ok: true });
    expect(result.registration.tools.lookup?.contract).toMatchObject({
      toolId: "lookup",
      authorityRef: { authorityId: "skill.lookup", authorityClass: "read" },
      requiredMaterials,
      originRef,
      roles: ["generator", "admitter"],
    });
  });

  it("rejects duplicate tools before constructing a registry", () => {
    const result = registerSkill(
      manifest([
        {
          definition: definition("lookup"),
          authorityClass: "read",
          admit,
          execute: async () => null,
        },
        {
          definition: definition("lookup"),
          authorityClass: "read",
          admit,
          execute: async () => null,
        },
      ]),
    );

    expect(result).toEqual({
      ok: false,
      issues: [{ kind: "duplicate_tool_id", skillId: "test-skill", toolId: "lookup" }],
    });
  });

  it("rejects invalid origin, material, admitter, and execute declarations", () => {
    const result = registerSkill({
      skillId: "bad-skill",
      version: "0.1.0",
      originRef: { originId: "", originKind: "extension_package" },
      tools: [
        {
          definition: definition("bad"),
          authorityClass: "",
          requiredMaterials: [{ slot: "", kind: "credential", required: true }],
          admit: null as unknown as ToolAdmitter,
          execute: null as unknown as (args: unknown) => Promise<unknown>,
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        { kind: "invalid_origin_ref", skillId: "bad-skill" },
        { kind: "invalid_authority_class", skillId: "bad-skill", toolId: "bad" },
        { kind: "invalid_required_material", skillId: "bad-skill", toolId: "bad" },
        { kind: "invalid_admitter", skillId: "bad-skill", toolId: "bad" },
        { kind: "invalid_execute", skillId: "bad-skill", toolId: "bad" },
      ],
    });
  });

  it("rejects tool definitions outside the closed JSON Schema dialect", () => {
    const result = registerSkill(
      manifest([
        {
          definition: {
            type: "function",
            function: {
              name: "lookup",
              description: "lookup tool",
              parameters: {
                type: "object",
                properties: {
                  key: { anyOf: [{ type: "string" }, { type: "number" }] },
                },
              },
            },
          },
          authorityClass: "read",
          admit,
          execute: async () => null,
        },
      ]),
    );

    expect(result).toEqual({
      ok: false,
      issues: [{ kind: "invalid_tool_definition", skillId: "test-skill", index: 0 }],
    });
  });

  it("unregisters only previously registered tool ids and fails closed on missing tools", () => {
    const result = registerSkill(
      manifest([
        {
          definition: definition("lookup"),
          authorityClass: "read",
          admit,
          execute: async () => null,
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(unregisterSkill(result.registration.tools, result.registration)).toEqual({
      ok: true,
      tools: {},
    });
    expect(unregisterSkill({}, result.registration)).toEqual({
      ok: false,
      issues: [{ kind: "tool_not_registered", skillId: "test-skill", toolId: "lookup" }],
    });
  });
});
