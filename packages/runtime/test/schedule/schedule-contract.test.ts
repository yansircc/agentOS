import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  createScheduleContext,
  cronMinuteExpression,
  defineSchedule,
  scheduleFireId,
  scheduledMinute,
  type ScheduleHandler,
  type ScheduleRuntime,
} from "../../src/schedule";
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
