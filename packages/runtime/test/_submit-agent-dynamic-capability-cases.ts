import {
  DYNAMIC_CAPABILITY_EVENT,
  DYNAMIC_CAPABILITY_PROJECTION_VERSION,
  DYNAMIC_CAPABILITY_SLOT,
  DYNAMIC_CAPABILITY_VISIBILITY,
  type DynamicCapabilityProjection,
} from "@agent-os/core/runtime-protocol";
import {
  Effect,
  Schema,
  expect,
  it,
  defineTool,
  deterministicToolExecution,
  decodeRuntimeLedgerEvent,
  RUNTIME_EVENT_KIND,
  baseSpec,
  response,
  runSubmit,
} from "./_submit-agent-harness";

const dynamicProjection = (
  overrides: Partial<DynamicCapabilityProjection> = {},
): DynamicCapabilityProjection => ({
  version: DYNAMIC_CAPABILITY_PROJECTION_VERSION,
  event: { name: DYNAMIC_CAPABILITY_EVENT.STEP_STARTED },
  tools: [],
  skills: [],
  instructions: [],
  provenance: [],
  ...overrides,
});

const projectionEntry = (id: string, visible: boolean) => ({
  id,
  visible,
  decision: visible ? DYNAMIC_CAPABILITY_VISIBILITY.ALLOWED : DYNAMIC_CAPABILITY_VISIBILITY.DENIED,
  provenance: [
    {
      resolverId: `resolver:${id}`,
      slot: DYNAMIC_CAPABILITY_SLOT.TOOLS,
      eventName: DYNAMIC_CAPABILITY_EVENT.STEP_STARTED,
      status: "applied" as const,
    },
  ],
});

export const registerSubmitAgentDynamicCapabilityCases = () => {
  it.effect("assembles model-visible tools from dynamic capability projection", () =>
    Effect.gen(function* () {
      const readFile = defineTool({
        name: "read_file",
        description: "read file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => Effect.succeed({ path, content: "input" }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeFile = defineTool({
        name: "write_file",
        description: "write file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => Effect.succeed({ path, written: true }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: { read_file: readFile, write_file: writeFile },
          dynamicCapabilityProjection: dynamicProjection({
            tools: [projectionEntry("read_file", true), projectionEntry("write_file", false)],
          }),
        }),
        [response({ items: [{ type: "message", text: "done" }] })],
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      expect(llmRequests[0]?.tools?.map((tool) => tool.function.name)).toEqual(["read_file"]);
      expect(
        events
          .map((event) => decodeRuntimeLedgerEvent(event))
          .filter(
            (decoded) =>
              decoded._tag === "runtime" && decoded.event.kind === RUNTIME_EVENT_KIND.LLM_REQUESTED,
          )
          .map((decoded) =>
            decoded._tag === "runtime" && decoded.event.kind === RUNTIME_EVENT_KIND.LLM_REQUESTED
              ? decoded.event.payload.toolNames
              : [],
          ),
      ).toEqual([["read_file"]]);
    }),
  );

  it.effect("rejects direct calls to projection-hidden tools before execution", () =>
    Effect.gen(function* () {
      let writeFileExecuted = false;
      const writeFile = defineTool({
        name: "write_file",
        description: "write file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => {
          writeFileExecuted = true;
          return Effect.succeed({ path, written: true });
        },
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { write_file: writeFile },
          dynamicCapabilityProjection: dynamicProjection({
            tools: [projectionEntry("write_file", false)],
          }),
        }),
        [
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-hidden",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: '{"path":"out.txt"}',
                  },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(writeFileExecuted).toBe(false);
      const rejected = events
        .map((event) => decodeRuntimeLedgerEvent(event))
        .find((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.rejected");
      expect(
        rejected?._tag === "runtime" && rejected.event.kind === "tool.rejected"
          ? rejected.event.payload.diagnostics
          : undefined,
      ).toMatchObject({
        phase: "policy",
        reason: "tool_visibility_denied",
      });
      expect(
        events
          .map((event) => decodeRuntimeLedgerEvent(event))
          .filter((decoded) => decoded._tag === "runtime")
          .map((decoded) => (decoded._tag === "runtime" ? decoded.event.kind : "unknown")),
      ).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.requested",
        "llm.response",
        "tool.rejected",
        "agent.aborted.tool_error",
      ]);
    }),
  );

  it.effect("adds only visible matching dynamic instruction fragments to system prompt", () =>
    Effect.gen(function* () {
      const { result, llmRequests } = yield* runSubmit(
        baseSpec({
          system: "Base system.",
          dynamicCapabilityProjection: dynamicProjection({
            instructions: [
              {
                ...projectionEntry("visible-instruction", true),
                digest: "sha256:visible",
                provenance: [
                  {
                    resolverId: "resolver:visible-instruction",
                    slot: DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS,
                    eventName: DYNAMIC_CAPABILITY_EVENT.STEP_STARTED,
                    status: "applied",
                  },
                ],
              },
              {
                ...projectionEntry("hidden-instruction", false),
                digest: "sha256:hidden",
                provenance: [
                  {
                    resolverId: "resolver:hidden-instruction",
                    slot: DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS,
                    eventName: DYNAMIC_CAPABILITY_EVENT.STEP_STARTED,
                    status: "applied",
                  },
                ],
              },
              {
                ...projectionEntry("stale-instruction", true),
                digest: "sha256:current",
                provenance: [
                  {
                    resolverId: "resolver:stale-instruction",
                    slot: DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS,
                    eventName: DYNAMIC_CAPABILITY_EVENT.STEP_STARTED,
                    status: "applied",
                  },
                ],
              },
            ],
          }),
          instructionFragments: [
            {
              id: "hidden-instruction",
              digest: "sha256:hidden",
              text: "Hidden instruction text.",
            },
            {
              id: "stale-instruction",
              digest: "sha256:stale",
              text: "Stale instruction text.",
            },
            {
              id: "visible-instruction",
              digest: "sha256:visible",
              text: "Visible instruction text.",
            },
          ],
        }),
        [response({ items: [{ type: "message", text: "done" }] })],
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      const system = llmRequests[0]?.messages[0]?.content ?? "";
      expect(system).toContain("Base system.");
      expect(system).toContain("Visible instruction text.");
      expect(system).not.toContain("Hidden instruction text.");
      expect(system).not.toContain("Stale instruction text.");
    }),
  );
};
