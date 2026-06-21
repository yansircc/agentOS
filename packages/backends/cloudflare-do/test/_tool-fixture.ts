import { Effect, Schema } from "effect";
import { defineTool, deterministicToolExecution, type Tool } from "@agent-os/kernel/tools";

export const allowToolAdmitter = () =>
  Effect.withSpan("agentos.test.tool_fixture.allow")(Effect.succeed({ ok: true as const }));

export const makeLookupTool = (): Tool =>
  defineTool({
    name: "lookup",
    description: "Lookup a value",
    args: Schema.Struct({}),
    execute: () =>
      Effect.withSpan("agentos.test.tool_fixture.lookup")(Effect.succeed({ value: 42 })),
    admit: allowToolAdmitter,
    authority: "read",
    execution: deterministicToolExecution(),
    originRef: {
      originId: "@agent-os/tool-registry/test",
      originKind: "tool_provider",
    },
  });
