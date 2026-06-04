import { defineToolFromDefinition, pureToolExecution, type Tool } from "@agent-os/kernel/tools";

export const allowToolAdmitter = () => ({ ok: true as const });

export const makeLookupTool = (): Tool =>
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
    admit: allowToolAdmitter,
    authorityClass: "read",
    execution: pureToolExecution(),
    originRef: {
      originId: "@agent-os/tool-registry/test",
      originKind: "tool_provider",
    },
  });
