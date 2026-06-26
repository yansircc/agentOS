import { describe, expect, it } from "@effect/vitest";
import {
  DYNAMIC_CAPABILITY_EVENT,
  DYNAMIC_CAPABILITY_FAILURE_REASON,
  DYNAMIC_CAPABILITY_RESOLVER_STATUS,
  DYNAMIC_CAPABILITY_SLOT,
  DYNAMIC_CAPABILITY_VISIBILITY,
  type DynamicCapabilityCompiledCatalog,
  type DynamicCapabilityContext,
  type DynamicCapabilityEventRef,
} from "@agent-os/core/runtime-protocol";
import {
  makeDynamicCapabilityContext,
  runDynamicCapabilityResolvers,
  type DynamicCapabilityResolverDefinition,
} from "../../src/capability";

const catalog: DynamicCapabilityCompiledCatalog = {
  tools: [
    { id: "read_file", bindingRef: "tool.read_file" },
    { id: "write_file", bindingRef: "tool.write_file" },
  ],
  skills: [{ id: "review", digest: "fnv1a32:review" }],
  instructions: [{ id: "tone", digest: "fnv1a32:tone" }],
};

const turnEvent: DynamicCapabilityEventRef = {
  name: DYNAMIC_CAPABILITY_EVENT.TURN_STARTED,
  sourceEventId: 10,
  sessionRef: "session:1",
  turnRef: "turn:1",
};

const resolver = (
  resolverId: string,
  slot: DynamicCapabilityResolverDefinition["slot"],
  resolve: DynamicCapabilityResolverDefinition["resolve"],
  timeoutMs?: number,
): DynamicCapabilityResolverDefinition => ({
  resolverId,
  slot,
  resolve,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

describe("runDynamicCapabilityResolvers", () => {
  it("provides a restricted read-only resolver context", async () => {
    let observed: DynamicCapabilityContext | undefined;
    const result = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      auth: { role: "admin" },
      projections: { session: { id: "session:1" } },
      materials: {},
      resolvers: [
        resolver("inspect", DYNAMIC_CAPABILITY_SLOT.TOOLS, (context) => {
          observed = context;
          return { tools: { allow: ["read_file"] } };
        }),
      ],
    });

    expect(result.ok).toBe(true);
    expect(observed).toBeDefined();
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed?.catalog.tools)).toBe(true);
    expect(Object.isFrozen(observed?.catalog.tools[0])).toBe(true);
    expect(Object.isFrozen(observed?.auth)).toBe(true);
    expect("commit" in (observed as object)).toBe(false);
    expect("openProvider" in (observed as object)).toBe(false);
    expect("workspace" in (observed as object)).toBe(false);
  });

  it("applies deny-wins merge over compiled catalog ids", async () => {
    const result = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      resolvers: [
        resolver("allow-write", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => ({
          tools: { allow: ["write_file"] },
        })),
        resolver("deny-write", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => ({
          tools: { deny: ["write_file"] },
        })),
        resolver("allow-skill", DYNAMIC_CAPABILITY_SLOT.SKILLS, () => ({
          skills: { allow: ["review"] },
        })),
        resolver("allow-instruction", DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS, () => ({
          instructions: { allow: ["tone"] },
        })),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.projection.tools).toEqual([
      {
        id: "read_file",
        visible: true,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.BASELINE,
        provenance: [],
      },
      {
        id: "write_file",
        visible: false,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.DENIED,
        provenance: [
          {
            resolverId: "allow-write",
            slot: "tools",
            eventName: "turn.started",
            status: "applied",
          },
          {
            resolverId: "deny-write",
            slot: "tools",
            eventName: "turn.started",
            status: "applied",
          },
        ],
      },
    ]);
    expect(result.projection.instructions).toEqual([
      {
        id: "tone",
        digest: "fnv1a32:tone",
        visible: true,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.ALLOWED,
        provenance: [
          {
            resolverId: "allow-instruction",
            slot: "instructions",
            eventName: "turn.started",
            status: "applied",
          },
        ],
      },
    ]);
    expect(JSON.stringify(result.projection.instructions)).not.toContain("prompt");
  });

  it("fails closed when resolver output selects an unknown compiled id", async () => {
    const result = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      resolvers: [
        resolver("unknown", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => ({
          tools: { allow: ["missing"] },
        })),
      ],
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          kind: "merge_failed",
          issues: [
            {
              kind: "unknown_target",
              resolverId: "unknown",
              slot: "tools",
              targetId: "missing",
            },
          ],
        },
      ],
    });
  });

  it("records throw, timeout, and invalid output as empty-delta provenance", async () => {
    const result = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      timeoutMs: 5,
      resolvers: [
        resolver("throws", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => {
          throw new Error("boom");
        }),
        resolver("times-out", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => new Promise(() => undefined), 1),
        resolver("invalid", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => ({
          tools: { allow: ["read_file"], text: "free prompt" },
        })),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.projection.tools).toEqual([
      {
        id: "read_file",
        visible: true,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.BASELINE,
        provenance: [],
      },
      {
        id: "write_file",
        visible: true,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.BASELINE,
        provenance: [],
      },
    ]);
    expect(result.projection.provenance).toEqual([
      {
        resolverId: "invalid",
        slot: "tools",
        eventName: "turn.started",
        status: DYNAMIC_CAPABILITY_RESOLVER_STATUS.FAILED,
        reason: DYNAMIC_CAPABILITY_FAILURE_REASON.INVALID_OUTPUT,
      },
      {
        resolverId: "throws",
        slot: "tools",
        eventName: "turn.started",
        status: DYNAMIC_CAPABILITY_RESOLVER_STATUS.FAILED,
        reason: DYNAMIC_CAPABILITY_FAILURE_REASON.RESOLVER_THROW,
      },
      {
        resolverId: "times-out",
        slot: "tools",
        eventName: "turn.started",
        status: DYNAMIC_CAPABILITY_RESOLVER_STATUS.TIMED_OUT,
        reason: DYNAMIC_CAPABILITY_FAILURE_REASON.RESOLVER_TIMEOUT,
      },
    ]);
  });

  it("runs only tool resolvers for step.started", async () => {
    let skillRan = false;
    const result = await runDynamicCapabilityResolvers({
      event: { name: DYNAMIC_CAPABILITY_EVENT.STEP_STARTED, stepRef: "step:1" },
      catalog,
      resolvers: [
        resolver("tool-step", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => ({
          tools: { deny: ["write_file"] },
        })),
        resolver("skill-step", DYNAMIC_CAPABILITY_SLOT.SKILLS, () => {
          skillRan = true;
          return { skills: { deny: ["review"] } };
        }),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(skillRan).toBe(false);
    expect(result.projection.skills).toEqual([
      {
        id: "review",
        visible: true,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.BASELINE,
        provenance: [],
      },
    ]);
    expect(result.projection.tools.find((tool) => tool.id === "write_file")).toEqual({
      id: "write_file",
      visible: false,
      decision: DYNAMIC_CAPABILITY_VISIBILITY.DENIED,
      provenance: [
        {
          resolverId: "tool-step",
          slot: "tools",
          eventName: "step.started",
          status: "applied",
        },
      ],
    });
  });

  it("rejects duplicate resolver ids within a slot before execution", async () => {
    let ran = false;
    const result = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      resolvers: [
        resolver("dup", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => {
          ran = true;
          return {};
        }),
        resolver("dup", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => {
          ran = true;
          return {};
        }),
      ],
    });

    expect(ran).toBe(false);
    expect(result).toEqual({
      ok: false,
      issues: [{ kind: "resolver_id_duplicate", resolverId: "dup", slot: "tools" }],
    });
  });

  it("builds the same restricted context without executing resolvers", () => {
    const context = makeDynamicCapabilityContext({
      event: turnEvent,
      catalog,
      auth: { user: "agent" },
      projections: {},
      materials: {},
    });

    expect(context.event).toEqual(turnEvent);
    expect(context.catalog.instructions).toEqual([{ id: "tone", digest: "fnv1a32:tone" }]);
    expect(Object.isFrozen(context.materials)).toBe(true);
  });
});
