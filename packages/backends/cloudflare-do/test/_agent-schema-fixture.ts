import { Schema } from "effect";
import {
  defineAgentSchema,
  type AgentSchema,
  type AgentSchemaSpec,
} from "@agent-os/kernel/agent-schema";
import {
  defineTool,
  deterministicToolExecution,
  type Tool,
  type ToolAdmitter,
} from "@agent-os/kernel/tools";

export const SummarySchema = defineAgentSchema(Schema.Struct({ summary: Schema.String }));

export const SummarySchemaSpec: AgentSchemaSpec<{ readonly summary: string }> = {
  agentSchema: SummarySchema,
  fingerprint: "test-fingerprint",
};

export const emptyArgsSchema = Schema.Struct({});

export const defineEmptyTool = <R>(spec: {
  readonly name: string;
  readonly description: string;
  readonly authority: string;
  readonly admit: ToolAdmitter<Record<string, never>>;
  readonly execute: Tool<Record<string, never>, R>["execute"];
}): Tool<Record<string, never>, R> =>
  defineTool({
    name: spec.name,
    description: spec.description,
    args: emptyArgsSchema,
    authority: spec.authority,
    admit: spec.admit,
    execution: deterministicToolExecution(),
    execute: spec.execute,
  });

export const toolDefinition = (
  name: string,
  argsSchema: AgentSchema<unknown> = defineAgentSchema(Schema.Struct({ q: Schema.String })),
) => ({
  type: "function" as const,
  function: {
    name,
    description: "Look up something",
    parameters: argsSchema,
  },
});
