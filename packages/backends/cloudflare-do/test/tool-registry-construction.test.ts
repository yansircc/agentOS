import { describe, expect, it } from "@effect/vitest";
import { materialRequirement } from "@agent-os/kernel/material-ref";
import {
  defineToolFromDefinition,
  permissiveToolAdmitter,
  validateToolRegistry,
  type Tool,
} from "@agent-os/kernel/tools";

import { makeLookupTool } from "./_tool-fixture";

describe("tool registry construction", () => {
  it("binds tool identity and authority in one contract", () => {
    const tool = makeLookupTool();

    expect(validateToolRegistry({ lookup: tool })).toEqual({ ok: true });
    expect(tool.contract).toEqual({
      toolId: "lookup",
      authorityRef: {
        authorityId: "tool:lookup",
        authorityClass: "read",
      },
      requiredMaterials: [],
      originRef: {
        originId: "@agent-os/tool-registry/test",
        originKind: "tool_provider",
      },
      roles: ["generator", "admitter"],
    });
  });

  it("rejects tools without a single authority contract before execution", () => {
    const bareTool = {
      definition: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup a value",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: () => Promise.resolve({ value: 42 }),
    } as unknown as Tool;

    expect(validateToolRegistry({ lookup: bareTool })).toEqual({
      ok: false,
      issues: [
        {
          kind: "missing_contract",
          registryKey: "lookup",
          toolName: "lookup",
        },
      ],
    });
  });

  it("requires an admitter on every contracted tool", () => {
    const tool = makeLookupTool();
    const missingAdmitter = {
      ...tool,
      admit: undefined,
      contract: {
        ...tool.contract,
        roles: ["generator"],
      },
    } as unknown as Tool;

    expect(validateToolRegistry({ lookup: missingAdmitter })).toEqual({
      ok: false,
      issues: [
        {
          kind: "unregistered_contract",
          toolId: "lookup",
        },
        {
          kind: "missing_admitter",
          toolId: "lookup",
        },
        {
          kind: "missing_admitter_role",
          toolId: "lookup",
        },
      ],
    });
  });

  it("requires contracts produced by the registry constructor", () => {
    const tool = makeLookupTool();
    const handBuiltContract = {
      ...tool,
      contract: {
        toolId: "lookup",
        authorityRef: {
          authorityId: "tool:lookup",
          authorityClass: "read",
        },
        requiredMaterials: [],
        roles: ["generator", "admitter"],
      },
    } as unknown as Tool;

    expect(validateToolRegistry({ lookup: handBuiltContract })).toEqual({
      ok: false,
      issues: [
        {
          kind: "unregistered_contract",
          toolId: "lookup",
        },
      ],
    });
  });

  it("binds authority required materials into the tool contract", () => {
    const tool = defineToolFromDefinition({
      definition: {
        type: "function",
        function: {
          name: "deploy",
          description: "Deploy a worker",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: () => Promise.resolve({ ok: true }),
      admit: permissiveToolAdmitter,
      authorityClass: "deploy",
      requiredMaterials: [
        materialRequirement({
          slot: "cf_api_token",
          kind: "credential",
          provider: "cloudflare",
          purpose: "deploy",
        }),
        materialRequirement({
          slot: "worker_namespace",
          kind: "binding",
          provider: "cloudflare",
          bindingKind: "worker",
        }),
      ],
    });

    expect(validateToolRegistry({ deploy: tool })).toEqual({ ok: true });
    expect(tool.contract.requiredMaterials).toEqual([
      {
        slot: "cf_api_token",
        kind: "credential",
        required: true,
        provider: "cloudflare",
        purpose: "deploy",
      },
      {
        slot: "worker_namespace",
        kind: "binding",
        required: true,
        provider: "cloudflare",
        bindingKind: "worker",
      },
    ]);
  });

  it("rejects material requirements with fields from a different kind", () => {
    const tool = makeLookupTool();
    const invalidMaterials = {
      ...tool,
      contract: {
        ...tool.contract,
        requiredMaterials: [
          {
            slot: "api",
            kind: "credential",
            required: true,
            bindingKind: "d1",
          },
        ],
      },
    } as unknown as Tool;

    expect(validateToolRegistry({ lookup: invalidMaterials })).toEqual({
      ok: false,
      issues: [
        {
          kind: "invalid_required_material",
          toolId: "lookup",
        },
        {
          kind: "unregistered_contract",
          toolId: "lookup",
        },
      ],
    });
  });

  it("requires an explicit admitter at construction", () => {
    expect(() =>
      defineToolFromDefinition({
        definition: {
          type: "function",
          function: {
            name: "lookup",
            description: "Lookup a value",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
        execute: () => Promise.resolve({ value: 42 }),
        authorityClass: "read",
      } as never),
    ).toThrow("tool admitter is required");
  });
});
