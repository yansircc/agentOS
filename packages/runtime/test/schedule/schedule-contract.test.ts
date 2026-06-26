import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  createScheduleContext,
  cronMinuteExpression,
  defineSchedule,
  dispatchScheduleFire,
  projectScheduleFireHistory,
  scheduleFireId,
  scheduledMinute,
  type ScheduleHandler,
  type ScheduleSessionSubmitTurnInput,
  type ScheduleRuntime,
  type ScheduleWorkflowRunInput,
} from "../../src/schedule";
import { inMemoryConversationTruthIdentity } from "../../src/in-memory/state-helpers";
import { lowerLocalAgentRuntime } from "../../src/local";
import * as runtimeRoot from "../../src/index";

const delivered = {
  ok: true,
  status: "delivered",
  runId: 1,
  final: "ok",
  eventCount: 1,
  tokensUsed: 0,
} as const;

const runtime: ScheduleRuntime = {
  sessions: {
    submitTurn: async () => delivered,
  },
  workflows: {
    run: async () => delivered,
  },
};

const appPrincipal = {
  authority: "agentos.app",
  subject: "agent:daily",
  claims: { deployment: "prod" },
};

const handler: ScheduleHandler = () => delivered;
const runtimeIdentity = {
  scopeRef: { kind: "conversation" as const, scopeId: "schedule-contract-test" },
  effectAuthorityRef: { authorityClass: "test", authorityId: "schedule-contract-test" },
};

const runtimePackageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, unknown> };

describe("@agent-os/runtime/schedule", () => {
  it("defines an immutable authored schedule contract", () => {
    const schedule = defineSchedule({ cron: "*/15   9-17 * * 1-5", handler });

    expect(schedule).toEqual({
      cron: "*/15 9-17 * * 1-5",
      handler,
    });
    expect(Object.isFrozen(schedule)).toBe(true);
  });

  it("rejects values outside the cron declaration grammar", () => {
    expect(() => defineSchedule(null as never)).toThrow(/requires a schedule object/);
    expect(() => defineSchedule({ cron: "* * * * *", handler: undefined as never })).toThrow(
      /requires a handler/,
    );
    expect(() => cronMinuteExpression("* * * *")).toThrow(/exactly five fields/);
    expect(() => cronMinuteExpression("* * * * * *")).toThrow(/exactly five fields/);
    expect(() => cronMinuteExpression("* * * * @daily")).toThrow(/unsupported syntax/);
  });

  it("normalizes scheduledAt to the UTC scheduled minute", () => {
    expect(scheduledMinute("2026-06-26T01:02:59.999Z")).toBe("2026-06-26T01:02:00.000Z");
    expect(scheduledMinute(new Date("2026-06-26T01:02:42.123Z"))).toBe(
      "2026-06-26T01:02:00.000Z",
    );
    expect(() => scheduledMinute("not-a-date")).toThrow(/valid timestamp/);
  });

  it("derives stable fire identity from app principal, schedule id, and scheduled minute", () => {
    const left = scheduleFireId({
      appPrincipal,
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:02:59.999Z",
    });
    const right = scheduleFireId({
      appPrincipal,
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:02:00.000Z",
    });
    const nextMinute = scheduleFireId({
      appPrincipal,
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:03:00.000Z",
    });

    expect(left).toBe(right);
    expect(left).not.toBe(nextMinute);
    expect(left).toContain("daily-summary");
  });

  it("creates a restricted context over product ingress only", () => {
    const context = createScheduleContext(runtime, {
      appPrincipal,
      fireId: "fire:daily-summary:2026-06-26T01:02Z",
      scheduledAt: "2026-06-26T01:02:59.999Z",
    });

    expect(Object.keys(context).sort()).toEqual([
      "appPrincipal",
      "fireId",
      "scheduledAt",
      "sessions",
      "workflows",
    ]);
    expect(context.scheduledAt).toBe("2026-06-26T01:02:00.000Z");
    expect(context.sessions.submitTurn).toBe(runtime.sessions.submitTurn);
    expect(context.workflows.run).toBe(runtime.workflows.run);
    expect("waitUntil" in context).toBe(false);
    expect("request" in context).toBe(false);
    expect("backend" in context).toBe(false);
    expect("scheduler" in context).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.appPrincipal)).toBe(true);
    expect(Object.isFrozen(context.sessions)).toBe(true);
    expect(Object.isFrozen(context.workflows)).toBe(true);
  });

  it("dispatches a schedule fire by forcing session product idempotency to fireId", async () => {
    let capturedInput: ScheduleSessionSubmitTurnInput | undefined;
    const schedule = defineSchedule({
      cron: "* * * * *",
      handler: (context) =>
        context.sessions.submitTurn({
          sessionRef: "session:s1",
          turnRef: "turn:s1:1",
          intent: "daily summary",
          context: { from: "schedule" },
        }),
    });
    const dispatchRuntime: ScheduleRuntime = {
      sessions: {
        submitTurn: async (input) => {
          capturedInput = input;
          return { ...delivered, runId: 42 };
        },
      },
      workflows: runtime.workflows,
    };

    const result = await dispatchScheduleFire({
      ...runtimeIdentity,
      runtime: dispatchRuntime,
      schedule,
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:02:59.999Z",
      appPrincipal,
    });

    expect(result.ok).toBe(true);
    expect(result.fireId).toBe(capturedInput?.idempotencyKey);
    expect(result.requested.kind).toBe("schedule.fire_requested");
    if (!result.ok) expect.fail("expected schedule fire dispatch");
    expect(result.productLink).toEqual({
      kind: "session_turn",
      sessionRef: "session:s1",
      turnRef: "turn:s1:1",
      runtimeRunId: 42,
      idempotencyKey: result.fireId,
    });
    expect(result.outcome(100).payload).toEqual({
      scheduleId: "daily-summary",
      fireId: result.fireId,
      scheduledAt: "2026-06-26T01:02:00.000Z",
      requestedEventId: 100,
      productLink: result.productLink,
    });
    expect(JSON.stringify(result.outcome(100))).not.toContain("delivered");
    expect(JSON.stringify(result.outcome(100))).not.toContain("final");
  });

  it("lets product ingress own duplicate fire suppression by fireId", async () => {
    const submittedByIdempotencyKey = new Map<string, typeof delivered & { readonly runId: number }>();
    const submittedInputs: ScheduleSessionSubmitTurnInput[] = [];
    const schedule = defineSchedule({
      cron: "* * * * *",
      handler: (context) =>
        context.sessions.submitTurn({
          sessionRef: "session:s1",
          turnRef: context.fireId,
          intent: "daily summary",
          context: { from: "schedule" },
        }),
    });
    const dispatchRuntime: ScheduleRuntime = {
      sessions: {
        submitTurn: async (input) => {
          const existing = submittedByIdempotencyKey.get(input.idempotencyKey ?? "");
          if (existing !== undefined) return existing;
          submittedInputs.push(input);
          const result = { ...delivered, runId: submittedInputs.length };
          submittedByIdempotencyKey.set(input.idempotencyKey ?? "", result);
          return result;
        },
      },
      workflows: runtime.workflows,
    };
    const input = {
      ...runtimeIdentity,
      runtime: dispatchRuntime,
      schedule,
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:02:42.000Z",
      appPrincipal,
    } as const;

    const first = await dispatchScheduleFire(input);
    const second = await dispatchScheduleFire(input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) expect.fail("expected duplicate fire dispatches");
    expect(first.fireId).toBe(second.fireId);
    expect(submittedInputs).toHaveLength(1);
    expect(submittedInputs[0]?.idempotencyKey).toBe(first.fireId);
    expect(first.productLink.runtimeRunId).toBe(second.productLink.runtimeRunId);
  });

  it("dispatches a schedule fire through workflow product ingress", async () => {
    let capturedInput: ScheduleWorkflowRunInput | undefined;
    const schedule = defineSchedule({
      cron: "* * * * *",
      handler: (context) =>
        context.workflows.run({
          workflowId: "daily-summary",
          workflowRunId: "workflow-run:daily-summary:1",
          intent: "daily summary",
          context: { from: "schedule" },
          inputDigest: "sha256:input",
        }),
    });
    const dispatchRuntime: ScheduleRuntime = {
      sessions: runtime.sessions,
      workflows: {
        run: async (input) => {
          capturedInput = input;
          return { ...delivered, runId: 77 };
        },
      },
    };

    const result = await dispatchScheduleFire({
      ...runtimeIdentity,
      runtime: dispatchRuntime,
      schedule,
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:02:00.000Z",
      appPrincipal,
    });

    expect(result.ok).toBe(true);
    expect(result.fireId).toBe(capturedInput?.idempotencyKey);
    if (!result.ok) expect.fail("expected schedule fire dispatch");
    expect(result.productLink).toEqual({
      kind: "workflow_run",
      workflowId: "daily-summary",
      workflowRunId: "workflow-run:daily-summary:1",
      runtimeRunId: 77,
      idempotencyKey: result.fireId,
      inputDigest: "sha256:input",
    });
  });

  it("fails closed when a handler does not hand off to product ingress", async () => {
    const result = await dispatchScheduleFire({
      ...runtimeIdentity,
      runtime,
      schedule: defineSchedule({ cron: "* * * * *", handler: () => undefined }),
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:02:00.000Z",
      appPrincipal,
    });

    expect(result).toMatchObject({
      ok: false,
      phase: "contract",
      reason: "schedule_fire_product_ingress_missing",
    });
    expect(result.outcome(100).kind).toBe("schedule.fire_failed");
  });

  it("fails closed before product ingress when the handler overrides fire idempotency", async () => {
    let called = false;
    const result = await dispatchScheduleFire({
      ...runtimeIdentity,
      runtime: {
        sessions: {
          submitTurn: async () => {
            called = true;
            return delivered;
          },
        },
        workflows: runtime.workflows,
      },
      schedule: defineSchedule({
        cron: "* * * * *",
        handler: (context) =>
          context.sessions.submitTurn({
            sessionRef: "session:s1",
            turnRef: "turn:s1:1",
            intent: "daily summary",
            context: {},
            idempotencyKey: "not-the-fire-id",
          }),
      }),
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:02:00.000Z",
      appPrincipal,
    });

    expect(called).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      phase: "contract",
      reason: "schedule_fire_idempotency_key_mismatch",
    });
  });

  it("fails closed when product ingress cannot prove a submitted runtime run", async () => {
    const result = await dispatchScheduleFire({
      ...runtimeIdentity,
      runtime: {
        sessions: {
          submitTurn: async () => ({ ...delivered, runId: 0 }) as never,
        },
        workflows: runtime.workflows,
      },
      schedule: defineSchedule({
        cron: "* * * * *",
        handler: (context) =>
          context.sessions.submitTurn({
            sessionRef: "session:s1",
            turnRef: "turn:s1:1",
            intent: "daily summary",
            context: {},
          }),
      }),
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:02:00.000Z",
      appPrincipal,
    });

    expect(result).toMatchObject({
      ok: false,
      phase: "product_ingress",
      reason: "schedule_fire_product_ingress_result_invalid",
    });
  });

  it("fails closed when a handler attempts multiple product handoffs", async () => {
    const result = await dispatchScheduleFire({
      ...runtimeIdentity,
      runtime: {
        sessions: {
          submitTurn: async () => ({ ...delivered, runId: 1 }),
        },
        workflows: {
          run: async () => ({ ...delivered, runId: 2 }),
        },
      },
      schedule: defineSchedule({
        cron: "* * * * *",
        handler: async (context) => {
          await context.sessions.submitTurn({
            sessionRef: "session:s1",
            turnRef: "turn:s1:1",
            intent: "daily summary",
            context: {},
          });
          try {
            await context.workflows.run({
              workflowId: "daily-summary",
              workflowRunId: "workflow-run:daily-summary:1",
              intent: "daily summary",
              context: {},
            });
          } catch {
            return undefined;
          }
        },
      }),
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:02:00.000Z",
      appPrincipal,
    });

    expect(result).toMatchObject({
      ok: false,
      phase: "contract",
      reason: "schedule_fire_multiple_product_ingress_calls",
    });
  });

  it("commits schedule fire requested and outcome through the local host ledger", async () => {
    const identity = "schedule-contract-test";
    const truthIdentity = inMemoryConversationTruthIdentity(identity);
    const lowered = await lowerLocalAgentRuntime({
      target: "node@1",
      identity,
      cwd: process.cwd(),
    });
    const dispatch = await dispatchScheduleFire({
      ...truthIdentity,
      runtime: {
        sessions: {
          submitTurn: async () => ({ ...delivered, runId: 42 }),
        },
        workflows: runtime.workflows,
      },
      schedule: defineSchedule({
        cron: "* * * * *",
        handler: (context) =>
          context.sessions.submitTurn({
            sessionRef: "session:s1",
            turnRef: "turn:s1:1",
            intent: "daily summary",
            context: {},
          }),
      }),
      scheduleId: "daily-summary",
      scheduledAt: "2026-06-26T01:02:00.000Z",
      appPrincipal,
    });

    const committed = await lowered.commitScheduleFireDispatch(dispatch);

    expect(committed.map((event) => event.kind)).toEqual([
      "schedule.fire_requested",
      "schedule.fire_dispatched",
    ]);
    expect(committed[1]?.payload).toMatchObject({
      requestedEventId: committed[0]?.id,
      productLink: {
        kind: "session_turn",
        runtimeRunId: 42,
        idempotencyKey: dispatch.fireId,
      },
    });
    expect(lowered.runtime.events().map((event) => event.kind)).toEqual([
      "schedule.fire_requested",
      "schedule.fire_dispatched",
    ]);
  });

  it("projects generated local schedule fires through the manifest truth identity", async () => {
    const truthIdentity = {
      scopeRef: { kind: "session" as const, scopeId: "generated-local-schedule" },
      effectAuthorityRef: { authorityClass: "effect", authorityId: "generated-local-schedule" },
    };
    const lowered = await lowerLocalAgentRuntime({
      target: "node@1",
      identity: "generated-local-schedule",
      truthIdentity,
      cwd: process.cwd(),
      llm: {
        kind: "test",
        responses: [
          {
            items: [{ type: "message", text: "scheduled session complete" }],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
        ],
      },
    });
    const schedule = defineSchedule({
      cron: "* * * * *",
      handler: (context) =>
        context.sessions.submitTurn({
          sessionRef: "session:scheduled",
          turnRef: context.fireId,
          intent: "scheduled session",
          context: { scheduledAt: context.scheduledAt },
        }),
    });

    const dispatch = await dispatchScheduleFire({
      ...truthIdentity,
      runtime: {
        sessions: {
          submitTurn: (input) =>
            lowered.submitWithProductLink(input, {
              kind: "session_turn",
              sessionRef: input.sessionRef,
              turnRef: input.turnRef,
              ...(input.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: input.idempotencyKey }),
            }),
        },
        workflows: runtime.workflows,
      },
      schedule,
      scheduleId: "daily-session",
      scheduledAt: "2026-06-26T09:00:42.000Z",
      appPrincipal,
    });
    if (!dispatch.ok) expect.fail("expected generated local schedule dispatch");

    await lowered.commitScheduleFireDispatch(dispatch);

    const history = projectScheduleFireHistory(lowered.runtime.events(), {
      scheduleId: "daily-session",
    });

    expect(history.fires).toHaveLength(1);
    expect(history.fires[0]).toMatchObject({
      status: "dispatched",
      fireId: dispatch.fireId,
      product: {
        kind: "session_turn",
        link: {
          sessionRef: "session:scheduled",
          turnRef: dispatch.fireId,
          runtimeRunId: dispatch.productLink.runtimeRunId,
          idempotencyKey: dispatch.fireId,
        },
        turn: {
          status: { kind: "delivered" },
        },
      },
    });
  });

  it("fails closed when context inputs are not positive contracts", () => {
    expect(() => createScheduleContext(null as never, {
      appPrincipal,
      fireId: "fire:1",
      scheduledAt: "2026-06-26T01:02:00.000Z",
    })).toThrow(/runtime must be an object/);
    expect(() =>
      createScheduleContext(
        { sessions: { submitTurn: undefined as never }, workflows: runtime.workflows },
        { appPrincipal, fireId: "fire:1", scheduledAt: "2026-06-26T01:02:00.000Z" },
      ),
    ).toThrow(/sessions\.submitTurn/);
    expect(() =>
      createScheduleContext(runtime, {
        appPrincipal: { authority: "", subject: "agent:daily" },
        fireId: "fire:1",
        scheduledAt: "2026-06-26T01:02:00.000Z",
      }),
    ).toThrow(/requires authority/);
    expect(() =>
      createScheduleContext(runtime, {
        appPrincipal,
        fireId: "",
        scheduledAt: "2026-06-26T01:02:00.000Z",
      }),
    ).toThrow(/requires fireId/);
  });

  it("does not leak the schedule authoring surface through the runtime root barrel", () => {
    expect("defineSchedule" in runtimeRoot).toBe(false);
    expect("createScheduleContext" in runtimeRoot).toBe(false);
    expect("scheduleFireId" in runtimeRoot).toBe(false);
  });

  it("publishes the schedule contract only as an explicit package subpath", () => {
    expect(runtimePackageJson.exports["./schedule"]).toEqual({
      types: "./src/schedule/index.ts",
      default: "./src/schedule/index.ts",
    });
    expect(runtimePackageJson.exports["."]).toEqual({
      types: "./src/index.ts",
      default: "./src/index.ts",
    });
  });
});
