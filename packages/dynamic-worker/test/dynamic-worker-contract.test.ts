import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  DynamicWorkerFailure,
  makeDynamicWorkerTool,
  runDynamicWorker,
  staticPolicy,
  type DynamicWorkerBackend,
} from "../src";

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
          new DynamicWorkerFailure({
            code: "ProviderFailure",
            reason: "should not run",
          }),
        ),
    };

    const result = await Effect.runPromise(
      Effect.either(
        runDynamicWorker(backend, staticPolicy(), {
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
    expect(result._tag === "Left" ? result.left.reason : "").toBe(
      "egress is disabled",
    );
  });

  it("normalizes timeout as a typed dynamic worker failure", async () => {
    const backend: DynamicWorkerBackend = {
      run: () => Effect.never,
    };

    const result = await Effect.runPromise(
      Effect.either(
        runDynamicWorker(backend, staticPolicy({ maxTimeoutMs: 5 }), {
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
    if (
      result._tag !== "Left" ||
      result.left._tag !== "agent_os.dynamic_worker_failure"
    ) {
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
});
