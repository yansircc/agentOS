/**
 * Admission IO contract tests.
 *
 * Provider wire dispatch is not tested here. Admission consumes an agentOS
 * LlmTransport and writes evidence only; submit owns delivery and terminal
 * run facts.
 */

import { Cause, Effect, Exit, Option, Schema } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {} from "@effect/vitest";
import { llmWireDescriptorFingerprint } from "@agent-os/core/llm-protocol";

import { Ledger } from "../../src/ledger";
import { Admission, makeAdmissionSchemaSpec } from "../../src/admission";
import { finalTextResp, stubLlmTransport, stubLlmWireDescriptor } from "../_stub-ai";
import { SCHEMA, makeRuntime, submitStructuredResp, testIdentity } from "./_helpers";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}
const testEnv = env as unknown as TestEnv;

const route = {
  kind: "openai-chat-compatible",
  endpointRef: "test-endpoint",
  credentialRef: "test-credential",
  modelId: "test-model",
} as const;

describe("admission — IO contract: attemptStructured", () => {
  it("additionalProperties:false rejects extra keys as BehaviorFailed", async () => {
    const scope = "admission-closed-schema";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([
        submitStructuredResp(JSON.stringify({ summary: "ok", extra: "should-be-rejected" }), "c1"),
      ]);
      const runtime = makeRuntime(state, llm, scope);

      const schemaSpec = await runtime.runPromise(
        makeAdmissionSchemaSpec(Schema.Struct({ summary: Schema.String })),
      );

      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaSpec,
            strategy: "forced-tool-call",
            stimulus: { kind: "live", userInput: { userText: "hi" } },
          });
        }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.outcome.class).toBe("BehaviorFailed");
        if (result.outcome.class === "BehaviorFailed") {
          expect(result.outcome.sampleDigest).toContain("decode-failed");
        }
      }

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          return yield* ledger.events(testIdentity(scope));
        }),
      );
      expect(events.filter((event) => event.kind === "structured.done")).toHaveLength(0);

      await runtime.dispose();
    });
  });

  it("happy path commits evidence only and reuses the supported lease", async () => {
    const scope = "admission-happy";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([
        submitStructuredResp('{"summary":"first"}', "c1"),
        submitStructuredResp('{"summary":"second"}', "c2"),
      ]);
      const runtime = makeRuntime(state, llm, scope);
      const schemaSpec = await runtime.runPromise(makeAdmissionSchemaSpec(SCHEMA));

      const attempt = (userText: string) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const admission = yield* Admission;
            return yield* admission.attemptStructured<{ summary: string }>({
              scope,
              route,
              schemaSpec,
              strategy: "forced-tool-call",
              stimulus: { kind: "live", userInput: { userText } },
            });
          }),
        );

      const first = await attempt("hello");
      expect(first.ok).toBe(true);
      expect(first.admissionImpact).toBe("lease-bearing");
      if (first.ok) expect(first.decoded).toEqual({ summary: "first" });

      const second = await attempt("hello again");
      expect(second.ok).toBe(true);
      expect(second.admissionImpact).toBe("reinforcement");

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          return yield* ledger.events(testIdentity(scope));
        }),
      );
      const evidence = events.filter((event) => event.kind === "llm.structured.evidence");
      expect(evidence).toHaveLength(2);
      expect(events.some((event) => event.kind === "structured.done")).toBe(false);
      const payload = evidence[0]?.payload as {
        readonly adapterId?: string;
        readonly key?: {
          readonly providerOutputAdapterVersion?: string;
          readonly transportAdapterVersion?: string;
        };
      };
      expect(payload.adapterId).toBe("openai-chat-compatible@test-output-1.0.0");
      expect(payload.key?.providerOutputAdapterVersion).toBe("1.0.0");
      expect(payload.key?.transportAdapterVersion).toBe("1.0.0");

      await runtime.dispose();
    });
  });

  it("short-circuits after BehaviorFailed without another provider call", async () => {
    const scope = "admission-short-circuit";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([finalTextResp("not a structured tool response")]);
      const runtime = makeRuntime(state, llm, scope);
      const schemaSpec = await runtime.runPromise(makeAdmissionSchemaSpec(SCHEMA));

      const attempt = (userText: string) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const admission = yield* Admission;
            return yield* admission.attemptStructured<{ summary: string }>({
              scope,
              route,
              schemaSpec,
              strategy: "forced-tool-call",
              stimulus: { kind: "live", userInput: { userText } },
            });
          }),
        );

      const first = await attempt("x");
      expect(first.ok).toBe(false);
      if (!first.ok) {
        expect(first.outcome.class).toBe("BehaviorFailed");
        expect(first.shortCircuited).toBe(false);
      }

      const second = await attempt("y");
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.outcome.class).toBe("BehaviorFailed");
        expect(second.shortCircuited).toBe(true);
      }

      await runtime.dispose();
    });
  });

  it("invalidate barrier resets the lease and the next attempt re-probes", async () => {
    const scope = "admission-invalidate";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([
        finalTextResp("not a structured tool response"),
        submitStructuredResp('{"summary":"post-barrier"}', "c2"),
      ]);
      const runtime = makeRuntime(state, llm, scope);
      const schemaSpec = await runtime.runPromise(makeAdmissionSchemaSpec(SCHEMA));

      await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaSpec,
            strategy: "forced-tool-call",
            stimulus: { kind: "live", userInput: { userText: "x" } },
          });
        }),
      );

      await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          yield* admission.invalidate({
            scope,
            key: {
              routeFingerprint: llmWireDescriptorFingerprint(stubLlmWireDescriptor(route)),
              schemaFingerprint: schemaSpec.fingerprint,
              strategy: "forced-tool-call",
            },
            reason: "test reset",
            by: "test",
          });
        }),
      );

      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaSpec,
            strategy: "forced-tool-call",
            stimulus: { kind: "live", userInput: { userText: "y" } },
          });
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decoded).toEqual({ summary: "post-barrier" });
        expect(result.admissionImpact).toBe("lease-bearing");
      }

      await runtime.dispose();
    });
  });
});

describe("admission malformed payload storage failures", () => {
  it("evidence row missing key field escapes as RuntimeStorageError", async () => {
    const scope = "admission-malformed-evidence";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const runtime = makeRuntime(state, stubLlmTransport([]), scope);
      const schemaSpec = await runtime.runPromise(makeAdmissionSchemaSpec(SCHEMA));

      await runtime.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const identity = testIdentity(scope);
          yield* ledger.commit([
            {
              kind: "llm.structured.evidence",
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload: {
                stimulusKind: "live",
                outcome: { class: "Supported", tokensUsed: 10 },
                admissionImpact: "lease-bearing",
              },
            },
          ]);
        }),
      );

      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaSpec,
            strategy: "forced-tool-call",
            stimulus: { kind: "live", userInput: { userText: "x" } },
          });
        }),
      );

      expectRuntimeStorageError(exit);
      await runtime.dispose();
    });
  });

  it("invalidate row with non-object key escapes as RuntimeStorageError", async () => {
    const scope = "admission-malformed-invalidate";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const runtime = makeRuntime(state, stubLlmTransport([]), scope);
      const schemaSpec = await runtime.runPromise(makeAdmissionSchemaSpec(SCHEMA));

      await runtime.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const identity = testIdentity(scope);
          yield* ledger.commit([
            {
              kind: "llm.structured.invalidate",
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload: { key: "not-an-object", reason: "test", by: "test" },
            },
          ]);
        }),
      );

      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaSpec,
            strategy: "forced-tool-call",
            stimulus: { kind: "live", userInput: { userText: "x" } },
          });
        }),
      );

      expectRuntimeStorageError(exit);
      await runtime.dispose();
    });
  });
});

const expectRuntimeStorageError = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect((failure.value as { _tag: string })._tag).toBe("agent_os.runtime_storage_error");
    }
  }
};
