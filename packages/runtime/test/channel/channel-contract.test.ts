import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  createChannelContext,
  defineChannel,
  del,
  get,
  patch,
  post,
  put,
  type ChannelHandler,
  type ChannelMethod,
  type ChannelRuntime,
} from "../../src/channel";
import * as runtimeRoot from "../../src/index";

const handler: ChannelHandler = () => ({}) as Response;
const verifier = () => ({ authority: "provider.signature", subject: "provider-user:123" });
const channelRuntime: ChannelRuntime = {
  submit: async () => ({
    ok: true,
    status: "delivered",
    runId: 1,
    final: "ok",
    eventCount: 1,
    tokensUsed: 0,
  }),
  dispatch: async () => ({ outboundEventId: 1 }),
};
const runtimePackageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, unknown> };

describe("@agent-os/runtime/channel", () => {
  it("defines method-specific authored routes", () => {
    expect(get("/inbound", handler)).toMatchObject({ method: "GET", path: "/inbound" });
    expect(post("/inbound", handler)).toMatchObject({ method: "POST", path: "/inbound" });
    expect(put("/inbound", handler)).toMatchObject({ method: "PUT", path: "/inbound" });
    expect(patch("/inbound", handler)).toMatchObject({ method: "PATCH", path: "/inbound" });
    expect(del("/inbound", handler)).toMatchObject({ method: "DELETE", path: "/inbound" });
  });

  it("normalizes a channel into an immutable route contract", () => {
    const route = post("/events/:eventId", handler);
    const channel = defineChannel({ verify: verifier, routes: [route] as const });

    expect(channel.verify).toBe(verifier);
    expect(channel.routes).toEqual([
      {
        method: "POST",
        path: "/events/:eventId",
        handler,
      },
    ]);
    expect(Object.isFrozen(channel)).toBe(true);
    expect(Object.isFrozen(channel.routes)).toBe(true);
    expect(Object.isFrozen(channel.routes[0])).toBe(true);
  });

  it("rejects values outside the authored route grammar", () => {
    expect(() => defineChannel({ verify: verifier, routes: [] })).toThrow(/at least one route/);
    expect(() =>
      defineChannel({ verify: undefined as never, routes: [post("/events", handler)] }),
    ).toThrow(/requires a verifier/);
    expect(() => get("inbound", handler)).toThrow(/start with/);
    expect(() => get("/inbound?token=secret", handler)).toThrow(/query or hash/);
    expect(() =>
      defineChannel({
        verify: verifier,
        routes: [
          {
            method: "TRACE" as ChannelMethod,
            path: "/inbound",
            handler,
          },
        ],
      }),
    ).toThrow(/Unsupported channel method/);
  });

  it("creates a restricted dispatch context from a verifier-derived principal", () => {
    const principal = {
      authority: "github.webhook.signature",
      subject: "installation:42",
      claims: { repository: "agent-os" },
    };
    const context = createChannelContext(channelRuntime, principal);
    expect(context).toEqual({
      principal,
      submit: channelRuntime.submit,
      dispatch: channelRuntime.dispatch,
    });
    expect(Object.keys(context).sort()).toEqual(["dispatch", "principal", "submit"]);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.principal)).toBe(true);
    expect(Object.isFrozen(context.principal.claims)).toBe(true);
  });

  it("fails closed when channel context inputs are not positive contracts", () => {
    expect(() => createChannelContext(null as never, verifier())).toThrow(/must be an object/);
    expect(() =>
      createChannelContext({ submit: undefined as never, dispatch: channelRuntime.dispatch }, verifier()),
    ).toThrow(/requires submit/);
    expect(() =>
      createChannelContext(channelRuntime, { authority: "", subject: "provider-user:123" }),
    ).toThrow(/requires authority/);
    expect(() =>
      createChannelContext(channelRuntime, {
        authority: "provider.signature",
        subject: "",
      }),
    ).toThrow(/requires subject/);
  });

  it("keeps provider lifecycle facts out of the pure channel contract", () => {
    const channel = defineChannel({ verify: verifier, routes: [post("/events", handler)] });
    expect(channel).toEqual({
      verify: verifier,
      routes: [
        {
          method: "POST",
          path: "/events",
          handler,
        },
      ],
    });
  });

  it("does not leak the channel authoring surface through the runtime root barrel", () => {
    expect("defineChannel" in runtimeRoot).toBe(false);
    expect("get" in runtimeRoot).toBe(false);
    expect("post" in runtimeRoot).toBe(false);
  });

  it("publishes the channel contract only as an explicit package subpath", () => {
    expect(runtimePackageJson.exports["./channel"]).toEqual({
      types: "./src/channel/index.ts",
      default: "./src/channel/index.ts",
    });
    expect(runtimePackageJson.exports["."]).toEqual({
      types: "./src/index.ts",
      default: "./src/index.ts",
    });
  });
});
