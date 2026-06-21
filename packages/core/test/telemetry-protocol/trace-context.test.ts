import { describe, expect, it } from "@effect/vitest";

import {
  copyTraceContext,
  validateOptionalTraceContext,
  validateTraceContext,
} from "../../src/telemetry-protocol/index";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("trace context", () => {
  it("accepts and copies valid W3C trace context verbatim", () => {
    const context = {
      traceparent,
      tracestate: "vendor=value,other=state",
    };
    expect(validateTraceContext(context)).toEqual({ ok: true, traceContext: context });
    expect(copyTraceContext(context)).toEqual(context);
  });

  it("rejects malformed traceparent and tracestate", () => {
    expect(validateTraceContext({ traceparent: "00-test" }).ok).toBe(false);
    expect(
      validateTraceContext({
        traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      }).ok,
    ).toBe(false);
    expect(
      validateTraceContext({
        traceparent,
        tracestate: "vendor=value,vendor=duplicate",
      }).ok,
    ).toBe(false);
  });

  it("treats omitted context as absent and present context as requiring traceparent", () => {
    expect(validateOptionalTraceContext(undefined)).toEqual({ ok: true });
    expect(validateOptionalTraceContext({ tracestate: "vendor=value" }).ok).toBe(false);
  });
});
