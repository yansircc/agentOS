import { Schema } from "effect";
import { defineTool, pureToolExecution, type Tool } from "@agent-os/kernel/tools";

export const allowToolAdmitter = () => ({ ok: true as const });

export const makeLookupTool = (): Tool =>
  defineTool({
    name: "lookup",
    description: "Lookup a value",
    args: Schema.Struct({}),
    execute: () => Promise.resolve({ value: 42 }),
    admit: allowToolAdmitter,
    authority: "read",
    execution: pureToolExecution(),
    originRef: {
      originId: "@agent-os/tool-registry/test",
      originKind: "tool_provider",
    },
  });
