import { Effect, Fiber, TestClock } from "effect";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { describe, expect, it } from "@effect/vitest";

import {
  DynamicWorkerProviderFailure,
  dynamicWorkerSettlementRef,
  runDynamicWorker,
  staticPolicy,
  truncateUtf8,
  type DynamicWorkerBackend,
  type DynamicWorkerLimits,
} from "../src";

const claim = makePreClaim({
  operationRef: "dynamic-worker:session-1:run-1",
  scopeRef: { kind: "session", scopeId: "session/1" },
  effectAuthorityRef: {
    authorityId: "dynamic-worker.run",
    authorityClass: "effect",
  },
  originRef: {
    originId: "@agent-os/dynamic-worker",
    originKind: "carrier",
  },
});

describe("@agent-os/dynamic-worker", () => {
  it.effect("runs one bounded stateless Worker-compatible request", () =>
    Effect.gen(function* () {
      const backend: DynamicWorkerBackend = {
        run: (request) =>
          Effect.succeed({
            status: 200,
            headers: { "content-type": "text/plain" },
            body: `ok:${request.request.url}`,
            workerId: "dw-1",
          }),
      };

      const result = yield* runDynamicWorker(backend, staticPolicy(), {
        claim,
        code: "export default { fetch: () => new Response('ok') }",
        request: { url: "https://example.test/" },
        timeoutMs: 1000,
      });
      expect(result).toMatchObject({
        status: 200,
        body: "ok:https://example.test/",
        workerId: "dw-1",
      });
    }),
  );

  it.effect("keeps egress closed unless policy allowlists hosts", () =>
    Effect.gen(function* () {
      const backend: DynamicWorkerBackend = {
        run: () =>
          Effect.fail(
            new DynamicWorkerProviderFailure({
              code: "ProviderFailure",
              reason: "should not run",
            }),
          ),
      };

      const result = yield* Effect.either(
        runDynamicWorker(backend, staticPolicy(), {
          claim,
          code: "export default { fetch: () => fetch('https://api.example') }",
          request: { url: "https://example.test/" },
          egress: { mode: "allowlist", hosts: ["api.example"] },
          timeoutMs: 1000,
        }),
      );

      expect(result).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "agent_os.dynamic_worker_policy_denied",
        },
      });
      expect(result._tag === "Left" ? result.left.reason : "").toBe("egress is disabled");
    }),
  );

  it.effect("normalizes timeout as a typed dynamic worker failure", () =>
    Effect.gen(function* () {
      const backend: DynamicWorkerBackend = {
        run: () => Effect.never,
      };

      const fiber = yield* Effect.either(
        runDynamicWorker(backend, staticPolicy({ maxTimeoutMs: 5 }), {
          claim,
          code: "export default { fetch: async () => new Response('late') }",
          request: { url: "https://example.test/" },
          timeoutMs: 5,
        }),
      ).pipe(Effect.fork);
      yield* TestClock.adjust("6 millis");
      const result = yield* Fiber.join(fiber);

      expect(result).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "agent_os.dynamic_worker_failure",
        },
      });
      if (result._tag === "Left" && result.left._tag === "agent_os.dynamic_worker_failure") {
        expect(result.left.code).toBe("Timeout");
      } else {
        expect.fail("expected DynamicWorkerFailure");
      }
    }),
  );

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

  it.effect("forwards configured limits to policy and backend", () =>
    Effect.gen(function* () {
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
      const result = yield* runDynamicWorker(
        backend,
        ({ request }) =>
          Effect.sync(() => {
            seen.push({ owner: "policy", limits: request.limits });
          }),
        {
          claim,
          code: "export default { fetch: () => new Response('ok') }",
          request: { url: "https://example.test/" },
          timeoutMs: 1000,
          limits,
        },
      );
      expect(result).toMatchObject({ workerId: "dw-limits" });
      expect(seen).toEqual([
        { owner: "policy", limits },
        { owner: "backend", limits },
      ]);
    }),
  );

  it.effect("resolves typed ScopeRef for policy without declaring stateful roots", () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const backend: DynamicWorkerBackend = {
        run: () =>
          Effect.succeed({
            status: 200,
            body: "ok",
            workerId: "dw-scope",
          }),
      };

      const result = yield* runDynamicWorker(
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
      );
      expect(result).toMatchObject({ workerId: "dw-scope" });

      expect(seen).toEqual([
        {
          scopeRef: { kind: "conversation", scopeId: "thread/t1" },
          scopeKey: "conversation:thread%2Ft1",
          ownerKind: "conversation",
        },
      ]);
    }),
  );

  it.effect("settles run claims as carrier proofs or policy rejections", () =>
    Effect.gen(function* () {
      const claimScopes: unknown[] = [];
      const backend: DynamicWorkerBackend = {
        run: () =>
          Effect.succeed({
            status: 200,
            body: "ok",
            workerId: "dw-claim",
          }),
      };

      const success = yield* runDynamicWorker(
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
      );
      expect(success).toMatchObject({
        workerId: "dw-claim",
        claim: {
          phase: "lived",
          operationRef: claim.operationRef,
          anchorRef: {
            anchorId: dynamicWorkerSettlementRef("dw-claim"),
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

      const denied = yield* Effect.either(
        runDynamicWorker(backend, staticPolicy(), {
          claim,
          code: "",
          request: { url: "https://example.test/" },
          timeoutMs: 1000,
        }),
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
              rejectionId: dynamicWorkerSettlementRef(claim.operationRef, "rejected"),
              rejectionKind: "policy_denied",
              reason: dynamicWorkerSettlementRef("policy_denied"),
            },
          },
        },
      });

      const failed = yield* Effect.either(
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
              rejectionId: dynamicWorkerSettlementRef(claim.operationRef, "rejected"),
              rejectionKind: "provider_rejected",
              reason: "dynamic_worker_ProviderFailure",
            },
          },
        },
      });
    }),
  );

  it.effect("does not expose provider failure bodies through failure", () =>
    Effect.gen(function* () {
      const backend: DynamicWorkerBackend = {
        run: () =>
          Effect.fail(
            new DynamicWorkerProviderFailure({
              code: "ProviderFailure",
              reason: "raw provider secret reason",
              body: "raw_provider_body_secret",
              status: 500,
              workerId: "dw-secret",
            }),
          ),
      };

      const failed = yield* Effect.either(
        runDynamicWorker(backend, staticPolicy(), {
          claim,
          code: "export default { fetch: () => new Response('ok') }",
          request: { url: "https://example.test/" },
          timeoutMs: 1000,
        }),
      );

      expect(JSON.stringify(failed)).not.toContain("raw_provider_body_secret");
      expect(JSON.stringify(failed)).not.toContain("raw provider secret reason");
    }),
  );
});
