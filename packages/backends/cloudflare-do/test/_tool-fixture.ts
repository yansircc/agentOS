import {
  defineToolFromDefinition,
  permissiveToolAdmitter,
  pureToolExecution,
  type Tool,
} from "@agent-os/kernel/tools";

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
    admit: permissiveToolAdmitter,
    authorityClass: "read",
    execution: pureToolExecution(),
    originRef: {
      originId: "@agent-os/tool-registry/test",
      originKind: "tool_provider",
    },
  });
