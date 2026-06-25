import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  defineChannel,
  del,
  get,
  patch,
  post,
  put,
  type ChannelHandler,
  type ChannelMethod,
} from "../../src/channel";
import * as runtimeRoot from "../../src/index";

const handler: ChannelHandler = () => new Response("ok");
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
    const channel = defineChannel({ routes: [route] as const });

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
    expect(() => defineChannel({ routes: [] })).toThrow(/at least one route/);
    expect(() => get("inbound", handler)).toThrow(/start with/);
    expect(() => get("/inbound?token=secret", handler)).toThrow(/query or hash/);
    expect(() =>
      defineChannel({
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

  it("keeps provider lifecycle facts out of the pure channel contract", () => {
    const channel = defineChannel({ routes: [post("/events", handler)] });
    expect(channel).toEqual({
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
