import { Effect } from "effect";
import { makePreClaim } from "@agent-os/core/effect-claim";
import { describe, expect, it } from "vite-plus/test";

import {
  DynamicWorkerProviderFailure,
  makeDynamicWorkerTool,
  runDynamicWorker,
  staticPolicy,
  truncateUtf8,
  type DynamicWorkerBackend,
  type DynamicWorkerLimits,
} from "../src";

const claim = makePreClaim({
  operationRef: "dynamic-worker:session-1:run-1",
  scopeRef: { kind: "session", scopeId: "session/1" },
  authorityRef: {
    authorityId: "dynamic-worker.run",
    authorityClass: "effect",
  },
  originRef: {
    originId: "@agent-os/dynamic-worker",
    originKind: "carrier",
  },
});

describe("@agent-os/dynamic-worker", () => {
  it("runs one bounded stateless Worker-compatible request", async () => {
    const backend: DynamicWorkerBackend = {
      run: (request) =>
        Effect.succeed({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: `ok:${request.request.url}`,
          workerId: "dw-1",
        }),
    };

    await expect(
      Effect.runPromise(
        runDynamicWorker(backend, staticPolicy(), {
          claim,
          code: "export default { fetch: () => new Response('ok') }",
          request: { url: "https://example.test/" },
          timeoutMs: 1000,
        }),
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: "ok:https://example.test/",
      workerId: "dw-1",
    });
  });

  it("keeps egress closed unless policy allowlists hosts", async () => {
    const backend: DynamicWorkerBackend = {
      run: () =>
        Effect.fail(
          new DynamicWorkerProviderFailure({
            code: "ProviderFailure",
            reason: "should not run",
          }),
        ),
    };

    const result = await Effect.runPromise(
      Effect.either(
        runDynamicWorker(backend, staticPolicy(), {
          claim,
          code: "export default { fetch: () => fetch('https://api.example') }",
          request: { url: "https://example.test/" },
          egress: { mode: "allowlist", hosts: ["api.example"] },
          timeoutMs: 1000,
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "agent_os.dynamic_worker_policy_denied",
      },
    });
    expect(result._tag === "Left" ? result.left.reason : "").toBe("egress is disabled");
  });

  it("normalizes timeout as a typed dynamic worker failure", async () => {
    const backend: DynamicWorkerBackend = {
      run: () => Effect.never,
    };

    const result = await Effect.runPromise(
      Effect.either(
        runDynamicWorker(backend, staticPolicy({ maxTimeoutMs: 5 }), {
          claim,
          code: "export default { fetch: async () => new Response('late') }",
          request: { url: "https://example.test/" },
          timeoutMs: 5,
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "agent_os.dynamic_worker_failure",
      },
    });
    if (result._tag !== "Left" || result.left._tag !== "agent_os.dynamic_worker_failure") {
      throw new Error("expected DynamicWorkerFailure");
    }
    expect(result.left.code).toBe("Timeout");
  });

  it("exposes a ledger-safe tool result with byte-capped response body", async () => {
    const backend: DynamicWorkerBackend = {
      run: () =>
        Effect.succeed({
          status: 200,
          body: "abcdef",
          workerId: "dw-tool",
        }),
    };
    const tool = makeDynamicWorkerTool({
      backend,
      policy: staticPolicy(),
      claim: () => claim,
      maxBodyBytes: 3,
    });

    await expect(
      tool.execute({
        code: "export default { fetch: () => new Response('abcdef') }",
        url: "https://example.test/",
      }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      headers: undefined,
      bodyHead: "abc",
      bodyBytes: 6,
      bodyTruncated: true,
      durationMs: expect.any(Number),
      workerId: "dw-tool",
    });
  });

  it("keeps bodyHead within the UTF-8 byte cap", () => {
    const accented = truncateUtf8("é", 1);
    expect(accented).toEqual({
      head: "",
      bytes: 2,
      truncated: true,
    });

    const mixed = truncateUtf8("é汉🙂z", 6);
    expect(mixed).toEqual({
      head: "é汉",
      bytes: 10,
      truncated: true,
    });
    expect(new TextEncoder().encode(mixed.head).length).toBeLessThanOrEqual(6);
  });

  it("forwards configured limits to policy and backend", async () => {
    const limits: DynamicWorkerLimits = { cpuMs: 7, subrequests: 2 };
    const seen: Array<{
      readonly owner: "policy" | "backend";
      readonly limits?: DynamicWorkerLimits;
    }> = [];
    const backend: DynamicWorkerBackend = {
      run: (request) =>
        Effect.sync(() => {
          seen.push({ owner: "backend", limits: request.limits });
          return {
            status: 200,
            body: "ok",
            workerId: "dw-limits",
          };
        }),
    };
    const tool = makeDynamicWorkerTool({
      backend,
      policy: ({ request }) =>
        Effect.sync(() => {
          seen.push({ owner: "policy", limits: request.limits });
        }),
      claim: () => claim,
      limits,
    });

    await expect(
      tool.execute({
        code: "export default { fetch: () => new Response('ok') }",
        url: "https://example.test/",
      }),
    ).resolves.toMatchObject({ ok: true, workerId: "dw-limits" });
    expect(seen).toEqual([
      { owner: "policy", limits },
      { owner: "backend", limits },
    ]);
  });

  it("resolves typed ScopeRef for policy without declaring stateful roots", async () => {
    const seen: unknown[] = [];
    const backend: DynamicWorkerBackend = {
      run: () =>
        Effect.succeed({
          status: 200,
          body: "ok",
          workerId: "dw-scope",
        }),
    };

    await expect(
      Effect.runPromise(
        runDynamicWorker(
          backend,
          ({ runtimeScope }) =>
            Effect.sync(() => {
              seen.push(runtimeScope);
            }),
          {
            claim: makePreClaim({
              ...claim,
              operationRef: "dynamic-worker:thread-t1:run",
              scopeRef: { kind: "conversation", scopeId: "thread/t1" },
            }),
            code: "export default { fetch: () => new Response('ok') }",
            request: { url: "https://example.test/" },
            timeoutMs: 1000,
          },
        ),
      ),
    ).resolves.toMatchObject({ workerId: "dw-scope" });

    expect(seen).toEqual([
      {
        scopeRef: { kind: "conversation", scopeId: "thread/t1" },
        scopeKey: "conversation:thread%2Ft1",
        ownerKind: "conversation",
      },
    ]);
  });

  it("settles run claims as carrier proofs or policy rejections", async () => {
    const claimScopes: unknown[] = [];
    const backend: DynamicWorkerBackend = {
      run: () =>
        Effect.succeed({
          status: 200,
          body: "ok",
          workerId: "dw-claim",
        }),
    };

    await expect(
      Effect.runPromise(
        runDynamicWorker(
          backend,
          ({ runtimeScope }) =>
            Effect.sync(() => {
              claimScopes.push(runtimeScope);
            }),
          {
            claim,
            code: "export default { fetch: () => new Response('ok') }",
            request: { url: "https://example.test/" },
            timeoutMs: 1000,
          },
        ),
      ),
    ).resolves.toMatchObject({
      workerId: "dw-claim",
      claim: {
        phase: "lived",
        operationRef: claim.operationRef,
        anchorRef: {
          anchorId: "dw-claim",
          anchorKind: "carrier_proof",
          carrierRef: "dynamic-worker",
        },
      },
    });
    expect(claimScopes).toEqual([
      {
        scopeRef: claim.scopeRef,
        scopeKey: "session:session%2F1",
        ownerKind: "session",
      },
    ]);

    const denied = await Effect.runPromise(
      Effect.either(
        runDynamicWorker(backend, staticPolicy(), {
          claim,
          code: "",
          request: { url: "https://example.test/" },
          timeoutMs: 1000,
        }),
      ),
    );

    expect(denied).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "agent_os.dynamic_worker_policy_denied",
        reason: "code must be non-empty",
        claim: {
          phase: "rejected",
          operationRef: claim.operationRef,
          rejectionRef: {
            rejectionId: claim.operationRef,
            rejectionKind: "policy_denied",
            reason: "code must be non-empty",
          },
        },
      },
    });

    const failed = await Effect.runPromise(
      Effect.either(
        runDynamicWorker(
          {
            run: () =>
              Effect.fail(
                new DynamicWorkerProviderFailure({
                  code: "ProviderFailure",
                  reason: "provider rejected execution",
                }),
              ),
          },
          staticPolicy(),
          {
            claim,
            code: "export default { fetch: () => new Response('ok') }",
            request: { url: "https://example.test/" },
            timeoutMs: 1000,
          },
        ),
      ),
    );

    expect(failed).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "agent_os.dynamic_worker_failure",
        code: "ProviderFailure",
        claim: {
          phase: "rejected",
          operationRef: claim.operationRef,
          rejectionRef: {
            rejectionId: claim.operationRef,
            rejectionKind: "provider_rejected",
            reason: "provider rejected execution",
          },
        },
      },
    });
  });
});
