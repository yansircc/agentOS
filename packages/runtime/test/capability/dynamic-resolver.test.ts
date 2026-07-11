import { describe, expect, it } from "@effect/vitest";
import {
  DYNAMIC_CAPABILITY_EVENT,
  DYNAMIC_CAPABILITY_FAILURE_REASON,
  DYNAMIC_CAPABILITY_PHASE_POLICY_ACCESS,
  DYNAMIC_CAPABILITY_PHASE_POLICY_DENIED_REASON,
  DYNAMIC_CAPABILITY_PHASE_POLICY_SOURCE,
  DYNAMIC_CAPABILITY_RESOLVER_STATUS,
  DYNAMIC_CAPABILITY_SLOT,
  DYNAMIC_CAPABILITY_VISIBILITY,
  lowerDynamicCapabilityPhasePolicy,
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

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

describe("runDynamicCapabilityResolvers", () => {
  it("provides a restricted read-only resolver context", async () => {
    let observed: DynamicCapabilityContext | undefined;
    const result = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      input: { phase: "observe", values: { ticket: "change-1" } },
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
    expect(observed?.input).toEqual({ phase: "observe", values: { ticket: "change-1" } });
    expect(Object.isFrozen(observed?.input.values)).toBe(true);
    expect(Object.isFrozen(observed?.auth)).toBe(true);
    expect("commit" in (observed as object)).toBe(false);
    expect("openProvider" in (observed as object)).toBe(false);
    expect("workspace" in (observed as object)).toBe(false);
  });

  it("detaches one deeply frozen snapshot before concurrent resolvers observe context", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const sourceEvent = structuredClone(turnEvent);
    const sourceCatalog = structuredClone(catalog);
    const sourceInput = { phase: "observe", values: { ticket: { id: "change-1" } } };
    const sourceAuth = { principal: { id: "principal-a", roles: ["admin"] } };
    const sourceProjections = { session: { id: "session:1", flags: ["ready"] } };
    let observed: DynamicCapabilityContext | undefined;

    const running = runDynamicCapabilityResolvers({
      event: sourceEvent,
      catalog: sourceCatalog,
      input: sourceInput,
      auth: sourceAuth,
      projections: sourceProjections,
      resolvers: [
        resolver("barrier", DYNAMIC_CAPABILITY_SLOT.TOOLS, async (context) => {
          observed = context;
          entered.resolve(undefined);
          await release.promise;
          const principal = context.auth.principal as {
            readonly id: string;
            readonly roles: ReadonlyArray<string>;
          };
          const ticket = context.input.values?.ticket as { readonly id: string };
          const session = context.projections.session as {
            readonly id: string;
            readonly flags: ReadonlyArray<string>;
          };
          return principal.id === "principal-a" &&
            principal.roles[0] === "admin" &&
            ticket.id === "change-1" &&
            session.flags[0] === "ready"
            ? { tools: { allow: ["read_file"] } }
            : { tools: { deny: ["read_file"] } };
        }),
      ],
    });

    await entered.promise;
    (sourceEvent as { turnRef?: string }).turnRef = "turn:mutated";
    (sourceCatalog.tools[0] as { id: string }).id = "mutated_tool";
    sourceInput.values.ticket.id = "mutated";
    sourceAuth.principal.id = "principal-b";
    sourceAuth.principal.roles[0] = "guest";
    sourceProjections.session.flags[0] = "stale";
    release.resolve(undefined);

    const result = await running;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.projection.event.turnRef).toBe("turn:1");
    expect(result.projection.tools.map((tool) => tool.id)).toEqual(["read_file", "write_file"]);
    expect(result.projection.tools[0]?.decision).toBe(DYNAMIC_CAPABILITY_VISIBILITY.ALLOWED);
    expect((observed?.input.values?.ticket as { readonly id: string }).id).toBe("change-1");
    expect(Object.isFrozen(observed?.input.values?.ticket)).toBe(true);
    expect(Object.isFrozen(observed?.auth.principal)).toBe(true);
    expect(
      Object.isFrozen(
        (observed?.auth.principal as { readonly roles: ReadonlyArray<string> }).roles,
      ),
    ).toBe(true);
    expect(Object.isFrozen(observed?.projections.session)).toBe(true);
  });

  it("prevents resolver mutation from reaching the raw input graph", async () => {
    const sourceAuth = { principal: { id: "principal-a" } };
    let mutationRejected = false;
    const result = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      auth: sourceAuth,
      resolvers: [
        resolver("cannot-mutate-source", DYNAMIC_CAPABILITY_SLOT.TOOLS, (context) => {
          try {
            (context.auth.principal as { id: string }).id = "mutated";
          } catch {
            mutationRejected = true;
          }
          return { tools: { allow: ["read_file"] } };
        }),
      ],
    });

    expect(result.ok).toBe(true);
    expect(mutationRejected).toBe(true);
    expect(sourceAuth).toEqual({ principal: { id: "principal-a" } });
  });

  it("fails closed with structured issues for values outside the JSON snapshot grammar", async () => {
    class UnsupportedClass {
      readonly value = "not-a-record";
    }
    const sparse: unknown[] = [];
    sparse.length = 1;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("snapshot must not invoke accessors");
      },
    });
    const hiddenProperty = Object.defineProperty({}, "hidden", {
      enumerable: false,
      value: "not-json",
    });
    const symbolProperty = { [Symbol("hidden")]: "not-json" };
    const extraArrayProperty: unknown[] & { extra?: string } = [];
    extraArrayProperty.extra = "not-json";
    const unsupportedValues: ReadonlyArray<unknown> = [
      new Map([["key", "value"]]),
      new Set(["value"]),
      new Date(0),
      new UnsupportedClass(),
      () => "value",
      undefined,
      Symbol("value"),
      1n,
      Number.POSITIVE_INFINITY,
      sparse,
      accessor,
      hiddenProperty,
      symbolProperty,
      extraArrayProperty,
    ];

    for (const unsupported of unsupportedValues) {
      let ran = false;
      const result = await runDynamicCapabilityResolvers({
        event: turnEvent,
        catalog,
        projections: { unsupported },
        resolvers: [
          resolver("must-not-run", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => {
            ran = true;
            return {};
          }),
        ],
      });

      expect(result).toMatchObject({
        ok: false,
        issues: [
          {
            kind: "context_invalid",
            reason: "json_value_required",
          },
        ],
      });
      expect(ran).toBe(false);
    }
  });

  it("rejects service and run-input wrapper accessors without invoking getters", async () => {
    let getterCalls = 0;
    let ran = false;
    const mustNotRun = resolver("must-not-run", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => {
      ran = true;
      return {};
    });
    const serviceInput = Object.defineProperty({ catalog, resolvers: [mustNotRun] }, "event", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new TypeError("service getter must not run");
      },
    });
    await expect(
      runDynamicCapabilityResolvers(
        serviceInput as unknown as Parameters<typeof runDynamicCapabilityResolvers>[0],
      ),
    ).resolves.toEqual({
      ok: false,
      issues: [{ kind: "context_invalid", path: '$["event"]', reason: "json_value_required" }],
    });

    for (const field of ["phase", "values"] as const) {
      const input = Object.defineProperty({}, field, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new TypeError("run-input getter must not run");
        },
      });
      await expect(
        runDynamicCapabilityResolvers({
          event: turnEvent,
          catalog,
          input,
          resolvers: [mustNotRun],
        }),
      ).resolves.toEqual({
        ok: false,
        issues: [
          {
            kind: "context_invalid",
            path: `$["input"][${JSON.stringify(field)}]`,
            reason: "json_value_required",
          },
        ],
      });
    }

    expect(getterCalls).toBe(0);
    expect(ran).toBe(false);
  });

  it("rejects every resolver-definition accessor without invoking getters", async () => {
    let getterCalls = 0;
    const fields = ["resolverId", "slot", "timeoutMs", "resolve"] as const;
    for (const field of fields) {
      const definition: Record<string, unknown> = {
        resolverId: "descriptor-probe",
        slot: DYNAMIC_CAPABILITY_SLOT.TOOLS,
        timeoutMs: 10,
        resolve: () => ({}),
      };
      delete definition[field];
      Object.defineProperty(definition, field, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new TypeError("resolver getter must not run");
        },
      });
      await expect(
        runDynamicCapabilityResolvers({
          event: turnEvent,
          catalog,
          resolvers: [definition as unknown as DynamicCapabilityResolverDefinition],
        }),
      ).resolves.toEqual({
        ok: false,
        issues: [
          {
            kind: "context_invalid",
            path: `$["resolvers"][0][${JSON.stringify(field)}]`,
            reason: "json_value_required",
          },
        ],
      });
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects symbol, non-enumerable, and unknown wrapper fields", async () => {
    const invalidWrappers = [
      {
        input: { event: turnEvent, catalog, resolvers: [], unknown: true },
        path: '$["unknown"]',
      },
      {
        input: {
          event: turnEvent,
          catalog,
          resolvers: [],
          [Symbol("hidden")]: true,
        },
        path: "$[Symbol(hidden)]",
      },
      {
        input: Object.defineProperty({ event: turnEvent, catalog, resolvers: [] }, "auth", {
          enumerable: false,
          value: {},
        }),
        path: '$["auth"]',
      },
      {
        input: {
          event: turnEvent,
          catalog,
          resolvers: [],
          input: { unknown: true },
        },
        path: '$["input"]["unknown"]',
      },
      {
        input: {
          event: turnEvent,
          catalog,
          resolvers: [],
          input: { [Symbol("hidden")]: true },
        },
        path: '$["input"][Symbol(hidden)]',
      },
      {
        input: {
          event: turnEvent,
          catalog,
          resolvers: [],
          input: Object.defineProperty({}, "phase", {
            enumerable: false,
            value: "hidden",
          }),
        },
        path: '$["input"]["phase"]',
      },
      {
        input: {
          event: turnEvent,
          catalog,
          resolvers: [
            {
              resolverId: "extra",
              slot: DYNAMIC_CAPABILITY_SLOT.TOOLS,
              resolve: () => ({}),
              unknown: true,
            },
          ],
        },
        path: '$["resolvers"][0]["unknown"]',
      },
    ];

    for (const invalid of invalidWrappers) {
      await expect(
        runDynamicCapabilityResolvers(
          invalid.input as unknown as Parameters<typeof runDynamicCapabilityResolvers>[0],
        ),
      ).resolves.toEqual({
        ok: false,
        issues: [{ kind: "context_invalid", path: invalid.path, reason: "json_value_required" }],
      });
    }
  });

  it("rejects service-only fields at the context-helper boundary", () => {
    for (const [field, value] of [
      ["resolvers", []],
      ["timeoutMs", 10],
    ] as const) {
      const result = makeDynamicCapabilityContext({
        event: turnEvent,
        catalog,
        [field]: value,
      } as unknown as Parameters<typeof makeDynamicCapabilityContext>[0]);
      expect(result).toEqual({
        ok: false,
        issue: {
          kind: "context_invalid",
          path: `$[${JSON.stringify(field)}]`,
          reason: "json_value_required",
        },
      });
    }
  });

  it("rejects cyclic context graphs without raw promise rejection", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let ran = false;
    const result = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      projections: { cyclic },
      resolvers: [
        resolver("must-not-run", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => {
          ran = true;
          return {};
        }),
      ],
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          kind: "context_invalid",
          path: '$["projections"]["cyclic"]["self"]',
          reason: "acyclic_value_required",
        },
      ],
    });
    expect(ran).toBe(false);
  });

  it("lowers product-authored phase policy into dynamic capability projection diagnostics", async () => {
    const result = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      input: { phase: "observe" },
      resolvers: [
        resolver("product-phase-policy", DYNAMIC_CAPABILITY_SLOT.TOOLS, (context) =>
          lowerDynamicCapabilityPhasePolicy({
            catalog: context.catalog,
            slot: DYNAMIC_CAPABILITY_SLOT.TOOLS,
            policy: {
              policyId: "zero-y3-fixture-policy",
              phase: context.input.phase ?? "unknown",
              allowedCategories: [DYNAMIC_CAPABILITY_PHASE_POLICY_ACCESS.READ],
              tools: [
                { id: "read_file", categories: [DYNAMIC_CAPABILITY_PHASE_POLICY_ACCESS.READ] },
                { id: "write_file", categories: [DYNAMIC_CAPABILITY_PHASE_POLICY_ACCESS.WRITE] },
              ],
              instructions: { allow: ["tone"] },
            },
          }),
        ),
        resolver("product-phase-instructions", DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS, (context) =>
          lowerDynamicCapabilityPhasePolicy({
            catalog: context.catalog,
            slot: DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS,
            policy: {
              policyId: "zero-y3-fixture-policy",
              phase: context.input.phase ?? "unknown",
              allowedCategories: [DYNAMIC_CAPABILITY_PHASE_POLICY_ACCESS.READ],
              tools: [
                { id: "read_file", categories: [DYNAMIC_CAPABILITY_PHASE_POLICY_ACCESS.READ] },
                { id: "write_file", categories: [DYNAMIC_CAPABILITY_PHASE_POLICY_ACCESS.WRITE] },
              ],
              instructions: { allow: ["tone"] },
            },
          }),
        ),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.projection.tools).toEqual([
      {
        id: "read_file",
        visible: true,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.ALLOWED,
        provenance: [
          {
            resolverId: "product-phase-policy",
            slot: "tools",
            eventName: "turn.started",
            status: "applied",
          },
        ],
      },
      {
        id: "write_file",
        visible: false,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.DENIED,
        provenance: [
          {
            resolverId: "product-phase-policy",
            slot: "tools",
            eventName: "turn.started",
            status: "applied",
          },
        ],
        diagnostics: [
          {
            reason: DYNAMIC_CAPABILITY_PHASE_POLICY_DENIED_REASON,
            source: DYNAMIC_CAPABILITY_PHASE_POLICY_SOURCE,
            targetId: "write_file",
            policyId: "zero-y3-fixture-policy",
            phase: "observe",
            requiredCategory: DYNAMIC_CAPABILITY_PHASE_POLICY_ACCESS.WRITE,
            category: DYNAMIC_CAPABILITY_PHASE_POLICY_ACCESS.WRITE,
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
            resolverId: "product-phase-instructions",
            slot: "instructions",
            eventName: "turn.started",
            status: "applied",
          },
        ],
      },
    ]);
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

  it("explains source event, resolver ids, merged per-principal projection, and failure provenance", async () => {
    const result = await runDynamicCapabilityResolvers({
      event: {
        name: DYNAMIC_CAPABILITY_EVENT.TURN_STARTED,
        sourceEventId: 42,
        sessionRef: "session:principal-a",
        turnRef: "turn:principal-a:2",
      },
      catalog,
      auth: { principal: "principal-a" },
      projections: { entitlement: { write: false }, session: { instructionMode: "terse" } },
      resolvers: [
        resolver("principal-tools", DYNAMIC_CAPABILITY_SLOT.TOOLS, (context) =>
          context.auth.principal === "principal-a"
            ? { tools: { deny: ["write_file"] } }
            : { tools: { deny: ["read_file", "write_file"] } },
        ),
        resolver("session-skills", DYNAMIC_CAPABILITY_SLOT.SKILLS, () => ({
          skills: { allow: ["review"] },
        })),
        resolver("session-instructions", DYNAMIC_CAPABILITY_SLOT.INSTRUCTIONS, (context) =>
          (context.projections.session as { readonly instructionMode?: string } | undefined)
            ?.instructionMode === "terse"
            ? { instructions: { allow: ["tone"] } }
            : { instructions: { deny: ["tone"] } },
        ),
        resolver("invalid-skill-output", DYNAMIC_CAPABILITY_SLOT.SKILLS, () => ({
          skills: { allow: ["review"], freeText: "not a compiled artifact" },
        })),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.projection.event).toEqual({
      name: DYNAMIC_CAPABILITY_EVENT.TURN_STARTED,
      sourceEventId: 42,
      sessionRef: "session:principal-a",
      turnRef: "turn:principal-a:2",
    });
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
            resolverId: "principal-tools",
            slot: "tools",
            eventName: "turn.started",
            status: "applied",
          },
        ],
      },
    ]);
    expect(result.projection.skills).toEqual([
      {
        id: "review",
        visible: true,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.ALLOWED,
        provenance: [
          {
            resolverId: "session-skills",
            slot: "skills",
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
            resolverId: "session-instructions",
            slot: "instructions",
            eventName: "turn.started",
            status: "applied",
          },
        ],
      },
    ]);
    expect(result.projection.provenance).toEqual([
      {
        resolverId: "session-instructions",
        slot: "instructions",
        eventName: "turn.started",
        status: "applied",
      },
      {
        resolverId: "invalid-skill-output",
        slot: "skills",
        eventName: "turn.started",
        status: DYNAMIC_CAPABILITY_RESOLVER_STATUS.FAILED,
        reason: DYNAMIC_CAPABILITY_FAILURE_REASON.INVALID_OUTPUT,
      },
      {
        resolverId: "session-skills",
        slot: "skills",
        eventName: "turn.started",
        status: "applied",
      },
      {
        resolverId: "principal-tools",
        slot: "tools",
        eventName: "turn.started",
        status: "applied",
      },
    ]);
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

  it("rejects invalid service and resolver timeouts before any resolver executes", async () => {
    const invalidTimeouts = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const timeoutMs of invalidTimeouts) {
      let ran = false;
      const serviceResult = await runDynamicCapabilityResolvers({
        event: turnEvent,
        catalog,
        timeoutMs,
        resolvers: [
          resolver("must-not-run", DYNAMIC_CAPABILITY_SLOT.TOOLS, () => {
            ran = true;
            return {};
          }),
        ],
      });
      expect(serviceResult).toEqual({
        ok: false,
        issues: [{ kind: "timeout_invalid", owner: { kind: "service" }, timeoutMs }],
      });
      expect(ran).toBe(false);
    }

    let resolverRan = false;
    const resolverResult = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      resolvers: [
        resolver(
          "invalid-timeout",
          DYNAMIC_CAPABILITY_SLOT.TOOLS,
          () => {
            resolverRan = true;
            return {};
          },
          Number.POSITIVE_INFINITY,
        ),
      ],
    });
    expect(resolverResult).toEqual({
      ok: false,
      issues: [
        {
          kind: "timeout_invalid",
          owner: {
            kind: "resolver",
            resolverId: "invalid-timeout",
            slot: DYNAMIC_CAPABILITY_SLOT.TOOLS,
          },
          timeoutMs: Number.POSITIVE_INFINITY,
        },
      ],
    });
    expect(resolverRan).toBe(false);
  });

  it("aborts cooperative resolver work before returning a timeout projection", async () => {
    let abortObserved = false;
    const result = await runDynamicCapabilityResolvers({
      event: turnEvent,
      catalog,
      resolvers: [
        resolver(
          "cooperative-timeout",
          DYNAMIC_CAPABILITY_SLOT.TOOLS,
          (_context, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  abortObserved = true;
                  resolve({ tools: { allow: ["read_file"] } });
                },
                { once: true },
              );
            }),
          1,
        ),
      ],
    });

    expect(abortObserved).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.projection.provenance).toEqual([
      {
        resolverId: "cooperative-timeout",
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
    const snapshot = makeDynamicCapabilityContext({
      event: turnEvent,
      catalog,
      auth: { user: "agent" },
      projections: {},
      materials: {},
    });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.issue));
    const context = snapshot.value;
    expect(context.event).toEqual(turnEvent);
    expect(context.catalog.instructions).toEqual([{ id: "tone", digest: "fnv1a32:tone" }]);
    expect(Object.isFrozen(context.materials)).toBe(true);
  });
});
