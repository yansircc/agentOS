import { describe, expect, it } from "vite-plus/test";

import { resolveRuntimeScope, resolveStatefulSessionRoot } from "../src/runtime-scope";

describe("RuntimeScope resolver", () => {
  it("resolves typed ScopeRef values without parsing scopeId prefixes", () => {
    expect(resolveRuntimeScope({ kind: "conversation", scopeId: "thread/a.b" })).toEqual({
      scopeRef: { kind: "conversation", scopeId: "thread/a.b" },
      scopeKey: "conversation:thread%2Fa%2Eb",
      ownerKind: "conversation",
    });
    expect(
      resolveRuntimeScope({
        kind: "external",
        scopeId: "site/acme",
        systemRef: "cloudflare",
      }),
    ).toEqual({
      scopeRef: {
        kind: "external",
        scopeId: "site/acme",
        systemRef: "cloudflare",
      },
      scopeKey: "external:cloudflare:site%2Facme",
      ownerKind: "external",
      externalSystemRef: "cloudflare",
    });
  });

  it("allows stateful roots only for session scopes", () => {
    expect(
      resolveStatefulSessionRoot({ kind: "session", scopeId: "session/s1" }, "workspace"),
    ).toEqual({
      ok: true,
      stateRoot: "agentos://session/session%2Fs1/workspace",
      cleanupRef: "cleanup://session/session%2Fs1/workspace",
    });
    expect(
      resolveStatefulSessionRoot({ kind: "conversation", scopeId: "thread/t1" }, "workspace"),
    ).toEqual({
      ok: false,
      reason: "scope_kind_is_not_session",
      kind: "conversation",
    });
  });
});
