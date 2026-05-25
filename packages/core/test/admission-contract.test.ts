/**
 * Admission (spec-25) — contract tests.
 *
 * Three layers of validation:
 *   1. Pure-function level: `decideTier` 12-row truth table, fingerprint
 *      canonical equivalence (set-semantics arrays from spike-04).
 *   2. Pure projection: `projectLease` on hand-built event lists.
 *   3. IO contract: `Admission.attemptStructured` end-to-end through the
 *      same Layer composition AgentDOBase uses, including the
 *      transactionSync(evidence + deliver) atomic write and the
 *      lease-cached short-circuit on BehaviorFailed.
 *   4. End-to-end through `submitAgentEffect` with `outputSchema`.
 */

import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { EventBusLive } from "../src/event-bus";
import { Ledger, LedgerLive } from "../src/ledger";
import { AiBinding } from "../src/llm";
import { ProviderRegistryLive } from "../src/provider-registry";
import { QuotaLive } from "../src/quota-service";
import {
  ADAPTER_VERSION,
  Admission,
  AdmissionLive,
  type AttemptKey,
  type BarrierRow,
  type CapabilityLease,
  type EvidenceRow,
  type JsonSchemaObject,
  decideTier,
  makeSchemaContract,
  projectLease,
  routeFingerprint,
} from "../src/admission";
import {
  type InternalSubmitSpec,
  submitAgentEffect,
} from "../src/submit-agent";
import type { EventHandler } from "../src/types";
import { stubAi } from "./_stub-ai";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}
const testEnv = env as unknown as TestEnv;

// ============================================================
// Pure-function tests (no DO needed)
// ============================================================

describe("admission — decideTier truth table (spec-25 §10, spike-04 §A5)", () => {
  const supported = (lastTs: number): CapabilityLease => ({
    status: "supported",
    pinnedStrategy: "forced-tool-call",
    validUntilSoft: lastTs + 24 * 60 * 60 * 1000,
    validUntilHard: lastTs + 7 * 24 * 60 * 60 * 1000,
    lastEvidenceTs: lastTs,
  });
  const unknown: CapabilityLease = { status: "unknown" };

  // 12 rows per spike-04 §A5
  it.each([
    [1,  "unknown+Supported live",        unknown,         { class: "Supported", tokensUsed: 0 } as const, "live"  as const, 0,    "lease-bearing" as const],
    [2,  "supported+Supported reinforce", supported(1000), { class: "Supported", tokensUsed: 0 } as const, "live"  as const, 0,    "reinforcement" as const],
    [3,  "hard-expired surfaces unknown", unknown,         { class: "Supported", tokensUsed: 0 } as const, "live"  as const, 0,    "lease-bearing" as const],
    [4,  "any+Supported probe",           unknown,         { class: "Supported", tokensUsed: 0 } as const, "probe" as const, 0,    "lease-bearing" as const],
    [5,  "ProviderRejected",              unknown,         { class: "ProviderRejected", status: 400, body: "" } as const, "live" as const, 0, "lease-bearing" as const],
    [6,  "SchemaUnsupported",             unknown,         { class: "SchemaUnsupported", reason: "" } as const, "live" as const, 0, "lease-bearing" as const],
    [7,  "BehaviorFailed",                unknown,         { class: "BehaviorFailed", sampleDigest: "" } as const, "live" as const, 0, "lease-bearing" as const],
    [8,  "AuthError",                     unknown,         { class: "AuthError", status: 401 } as const, "live" as const, 0, "lease-bearing" as const],
    [9,  "RateLimited",                   unknown,         { class: "RateLimited" } as const, "live" as const, 0, "lease-bearing" as const],
    [10, "TransientError",                unknown,         { class: "TransientError", cause: "" } as const, "live" as const, 0, "lease-bearing" as const],
    [11, "ConfigError",                   unknown,         { class: "ConfigError", reason: "" } as const, "live" as const, 0, "lease-bearing" as const],
    [12, "barrier-after-lastEvidenceTs (defense-in-depth)", supported(1000), { class: "Supported", tokensUsed: 0 } as const, "live" as const, 2000, "lease-bearing" as const],
  ])("row %i — %s", (_n, _name, preLease, outcome, stim, barrierTs, expected) => {
    expect(decideTier(preLease, outcome, stim, barrierTs)).toBe(expected);
  });
});

describe("admission — canonical fingerprint (spec-25 §4.1, spike-04 A1/A2)", () => {
  const S1: JsonSchemaObject = {
    type: "object",
    properties: {
      summary: { type: "string" },
      sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
    },
    required: ["summary", "sentiment"],
  };
  const S2: JsonSchemaObject = {
    type: "object",
    properties: {
      summary: { type: "string" },
      sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
      keywords: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "sentiment", "keywords"],
  };
  // S3 = S2 with reordered properties AND reordered `required` array.
  // Per §4.1 rule a (sort keys) + rule c' (sort set-semantics arrays),
  // fingerprint MUST equal S2.
  const S3: JsonSchemaObject = {
    type: "object",
    properties: {
      keywords: { type: "array", items: { type: "string" } },
      sentiment: { type: "string", enum: ["neutral", "negative", "positive"] },
      summary: { type: "string" },
    },
    required: ["keywords", "sentiment", "summary"],
  };

  it("stability: same schema yields byte-equal fingerprint across calls", async () => {
    const a = await Effect.runPromise(makeSchemaContract(S2));
    const b = await Effect.runPromise(makeSchemaContract(S2));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint.startsWith("effect-json-schema-v1:sha256:")).toBe(true);
  });

  it("set-semantics: S2 == S3 (property + required + enum reorder)", async () => {
    const fS2 = await Effect.runPromise(makeSchemaContract(S2));
    const fS3 = await Effect.runPromise(makeSchemaContract(S3));
    expect(fS3.fingerprint).toBe(fS2.fingerprint);
  });

  it("distinction: S1 != S2 (different schemas)", async () => {
    const fS1 = await Effect.runPromise(makeSchemaContract(S1));
    const fS2 = await Effect.runPromise(makeSchemaContract(S2));
    expect(fS1.fingerprint).not.toBe(fS2.fingerprint);
  });

  it("routeFingerprint is deterministic, prefix-tagged, and collision-free for distinct routes", () => {
    const r = routeFingerprint({ kind: "cf-ai-binding", modelId: "@cf/x/y" });
    expect(r.startsWith("route-json-v1:")).toBe(true);
    const r2 = routeFingerprint({ kind: "cf-ai-binding", modelId: "@cf/x/y" });
    expect(r).toBe(r2);
    // Codex P1 regression guard: two different modelIds must produce two
    // different route keys. The previous 32-bit FNV implementation aliased
    // distinct routes onto the same hash (e.g. `@cf/3hwlz7pq9l` and
    // `@cf/x3qxkshczh` collided), letting a model's unsupported lease
    // short-circuit another model. The canonical-JSON key is collision-free
    // by construction.
    const a = routeFingerprint({ kind: "cf-ai-binding", modelId: "@cf/3hwlz7pq9l" });
    const b = routeFingerprint({ kind: "cf-ai-binding", modelId: "@cf/x3qxkshczh" });
    expect(a).not.toBe(b);
  });
});

describe("admission — projectLease pure projection (spec-25 §7.2)", () => {
  const key: AttemptKey = {
    routeFingerprint: "fnv1a:routeX",
    schemaFingerprint: "effect-json-schema-v1:sha256:schemaX",
    strategy: "forced-tool-call",
    adapterVersion: "1.0.0",
  };

  const ev = (id: number, ts: number, outcome: EvidenceRow["outcome"], extras?: { stim?: "probe" | "live"; impact?: EvidenceRow["admissionImpact"]; adapter?: string }): EvidenceRow => ({
    id,
    ts,
    kind: "llm.structured.evidence",
    key: { ...key, adapterVersion: extras?.adapter ?? key.adapterVersion },
    stimulusKind: extras?.stim ?? "live",
    outcome,
    admissionImpact: extras?.impact ?? "lease-bearing",
  });

  const barrier = (id: number, ts: number, k: Partial<AttemptKey> = key): BarrierRow => ({
    id,
    ts,
    kind: "llm.structured.invalidate",
    key: k,
  });

  it("no events → unknown", () => {
    const { lease } = projectLease([], key, 10_000);
    expect(lease.status).toBe("unknown");
  });

  it("single Supported within hard-expiry → supported lease", () => {
    const rows = [ev(1, 1000, { class: "Supported", tokensUsed: 5 })];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("supported");
    if (lease.status === "supported") {
      expect(lease.lastEvidenceTs).toBe(1000);
    }
  });

  it("BehaviorFailed within 24h → unsupported lease", () => {
    const rows = [ev(1, 1000, { class: "BehaviorFailed", sampleDigest: "" })];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("unsupported");
    if (lease.status === "unsupported") {
      expect(lease.failureClass).toBe("BehaviorFailed");
    }
  });

  it("AuthError is NOT lease-bearing — walks past it", () => {
    // newer AuthError, older Supported → should land on Supported
    const rows = [
      ev(1, 1000, { class: "Supported", tokensUsed: 5 }),
      ev(2, 1500, { class: "AuthError", status: 401 }),
    ];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("supported");
  });

  it("barrier wipes earlier evidence", () => {
    const rows = [
      ev(1, 1000, { class: "Supported", tokensUsed: 5 }),
      barrier(2, 1500),
    ];
    const { lease, latestBarrierTs } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("unknown");
    expect(latestBarrierTs).toBe(1500);
  });

  it("reinforcement evidence is ignored by projection (lease-bearing only)", () => {
    const rows = [
      ev(1, 1000, { class: "Supported", tokensUsed: 5 }, { impact: "reinforcement" }),
    ];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("unknown");
  });

  // Codex P1: same-millisecond evidence resolution by (ts, id).
  it("same ms: newer id wins — Supported(id=1) + BehaviorFailed(id=2) at ts=100 → unsupported", () => {
    const rows = [
      ev(1, 100, { class: "Supported", tokensUsed: 5 }),
      ev(2, 100, { class: "BehaviorFailed", sampleDigest: "x" }),
    ];
    const { lease } = projectLease(rows, key, 200);
    expect(lease.status).toBe("unsupported");
    if (lease.status === "unsupported") {
      expect(lease.failureClass).toBe("BehaviorFailed");
    }
  });

  it("same ms reversed: BehaviorFailed(id=1) + Supported(id=2) at ts=100 → supported", () => {
    const rows = [
      ev(1, 100, { class: "BehaviorFailed", sampleDigest: "x" }),
      ev(2, 100, { class: "Supported", tokensUsed: 5 }),
    ];
    const { lease } = projectLease(rows, key, 200);
    expect(lease.status).toBe("supported");
  });

  it("same ms barrier vs evidence: barrier id > evidence id → evidence cut off", () => {
    // ts=100: evidence id=1, barrier id=2. Barrier comes after evidence
    // under (ts, id) order, so the Supported is wiped → unknown.
    const rows = [
      ev(1, 100, { class: "Supported", tokensUsed: 5 }),
      barrier(2, 100),
    ];
    const { lease, latestBarrierTs } = projectLease(rows, key, 200);
    expect(lease.status).toBe("unknown");
    expect(latestBarrierTs).toBe(100);
  });

  it("same ms barrier vs evidence: barrier id < evidence id → evidence survives", () => {
    // ts=100: barrier id=1, evidence id=2. Evidence is strictly after
    // the barrier under (ts, id) order, so it survives.
    const rows = [
      barrier(1, 100),
      ev(2, 100, { class: "Supported", tokensUsed: 5 }),
    ];
    const { lease } = projectLease(rows, key, 200);
    expect(lease.status).toBe("supported");
  });

  it("different adapter major version is filtered out (§9)", () => {
    const rows = [
      ev(1, 1000, { class: "Supported", tokensUsed: 5 }, { adapter: "2.0.0" }),
    ];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("unknown");
  });
});

// ============================================================
// IO contract tests (DO + transactionSync)
// ============================================================

const SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
};

const makeRuntime = (state: DurableObjectState, ai: Ai) => {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state.storage.sql).pipe(Layer.provide(eventBus));
  const quota = QuotaLive(state).pipe(Layer.provide(eventBus));
  const aiLayer = Layer.succeed(AiBinding, ai);
  const admission = AdmissionLive(state).pipe(
    Layer.provide(eventBus),
    Layer.provide(aiLayer),
  );
  const registry = ProviderRegistryLive({ endpoints: {}, credentials: {} });
  return ManagedRuntime.make(
    Layer.mergeAll(ledger, quota, aiLayer, admission, registry),
  );
};

const submitStructuredResp = (json: string, id = "c1") => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id,
            type: "function" as const,
            function: { name: "_submit_structured", arguments: json },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

describe("admission — IO contract: attemptStructured", () => {
  it("additionalProperties:false rejects extra keys → BehaviorFailed", async () => {
    const scope = "admission-closed-schema";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      // LLM returns valid `summary` + an extra `extra` key. With
      // additionalProperties:false the decoder MUST reject this as
      // BehaviorFailed (Codex P1: prior implementation silently passed).
      const ai = stubAi([
        submitStructuredResp(
          JSON.stringify({ summary: "ok", extra: "should-be-rejected" }),
          "c1",
        ),
      ]);
      const runtime = makeRuntime(state, ai);

      const closedSchema: JsonSchemaObject = {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      };
      const schemaContract = await runtime.runPromise(makeSchemaContract(closedSchema));

      const r = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route: { kind: "cf-ai-binding", modelId: "@cf/test/model" },
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "hi" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
          });
        }),
      );

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.outcome.class).toBe("BehaviorFailed");
        if (r.outcome.class === "BehaviorFailed") {
          expect(r.outcome.sampleDigest).toContain("unknown-property");
        }
      }

      // No deliver row should have been written.
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const deliveries = events.filter((e) => e.kind === "structured.done");
      expect(deliveries).toHaveLength(0);

      await runtime.dispose();
    });
  });

  it("happy path: evidence + deliver committed atomically; lease-bearing first, reinforcement on second", async () => {
    const scope = "admission-happy";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([
        submitStructuredResp('{"summary":"first"}', "c1"),
        submitStructuredResp('{"summary":"second"}', "c2"),
      ]);
      const runtime = makeRuntime(state, ai);

      const schemaContract = await runtime.runPromise(makeSchemaContract(SCHEMA));

      // Two consecutive Supported attempts in same scope.
      const r1 = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route: { kind: "cf-ai-binding", modelId: "@cf/test/model" },
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "hello" },
              deliver: (decoded) => ({
                event: "structured.done",
                payload: decoded,
              }),
            },
          });
        }),
      );

      expect(r1.ok).toBe(true);
      expect(r1.admissionImpact).toBe("lease-bearing");
      if (r1.ok) {
        expect(r1.decoded).toEqual({ summary: "first" });
      }

      const r2 = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route: { kind: "cf-ai-binding", modelId: "@cf/test/model" },
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "hello again" },
              deliver: (decoded) => ({
                event: "structured.done",
                payload: decoded,
              }),
            },
          });
        }),
      );

      expect(r2.ok).toBe(true);
      expect(r2.admissionImpact).toBe("reinforcement");

      // Ledger contents: 2 evidence rows + 2 deliver rows (one for each).
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const counts = events.reduce<Record<string, number>>((acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts["llm.structured.evidence"]).toBe(2);
      expect(counts["structured.done"]).toBe(2);

      await runtime.dispose();
    });
  });

  it("short-circuit after BehaviorFailed: second call does NOT consume the AI queue", async () => {
    const scope = "admission-short-circuit";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      // Only ONE stub response. If the second attemptStructured call
      // calls ai.run again, the queue throws → SqlError-equivalent test
      // failure. The lease short-circuit must prevent that call.
      const ai = stubAi([
        submitStructuredResp('{"summary":"first-and-only"}', "c1"),
      ]);
      const runtime = makeRuntime(state, ai);

      const schemaContract = await runtime.runPromise(makeSchemaContract(SCHEMA));

      const route = { kind: "cf-ai-binding" as const, modelId: "@cf/test/model" };

      // First call: adapterMode=test-decode-mismatch forces BehaviorFailed
      // despite the stub returning a valid response. (The AI is called
      // because the adapter's decode is what fails, not the provider.)
      const r1 = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "x" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
            adapterMode: "test-decode-mismatch",
          });
        }),
      );
      expect(r1.ok).toBe(false);
      if (!r1.ok) {
        expect(r1.outcome.class).toBe("BehaviorFailed");
        expect(r1.shortCircuited).toBe(false); // first call was the admission probe
      }

      // Second call: lease is unsupported; provider must NOT be called.
      const r2 = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "y" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
          });
        }),
      );
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.shortCircuited).toBe(true);
        expect(r2.outcome.class).toBe("BehaviorFailed");
      }

      await runtime.dispose();
    });
  });

  it("invalidate barrier resets the lease — next attempt re-probes provider", async () => {
    const scope = "admission-invalidate";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([
        // first call: forced to BehaviorFailed
        submitStructuredResp('{"summary":"ignored"}', "c1"),
        // post-barrier call: provider is invoked again
        submitStructuredResp('{"summary":"post-barrier"}', "c2"),
      ]);
      const runtime = makeRuntime(state, ai);
      const schemaContract = await runtime.runPromise(makeSchemaContract(SCHEMA));
      const route = { kind: "cf-ai-binding" as const, modelId: "@cf/test/model" };

      // 1) BehaviorFailed
      await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "x" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
            adapterMode: "test-decode-mismatch",
          });
        }),
      );

      // 2) Append barrier
      await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          yield* admission.invalidate({
            scope,
            key: {
              routeFingerprint: routeFingerprint(route),
              schemaFingerprint: schemaContract.fingerprint,
              strategy: "forced-tool-call",
              adapterVersion: ADAPTER_VERSION,
            },
            reason: "test reset",
            by: "test",
          });
        }),
      );

      // 3) Next attempt — barrier wipes lease, provider IS called and
      // returns the second stub response (Supported this time).
      const r3 = await runtime.runPromise(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route,
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "y" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
          });
        }),
      );
      expect(r3.ok).toBe(true);
      if (r3.ok) {
        expect(r3.decoded).toEqual({ summary: "post-barrier" });
        expect(r3.admissionImpact).toBe("lease-bearing"); // post-barrier first Supported = admission-forming
      }

      await runtime.dispose();
    });
  });
});

// ============================================================
// End-to-end: submitAgentEffect with outputSchema
// ============================================================

describe("admission — submitAgent outputSchema path (spec-25 §12.1)", () => {
  it("outputSchema present → admission path; result.final is the decoded JSON", async () => {
    const scope = "submit-outputschema";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([
        submitStructuredResp('{"summary":"from-submit"}', "c1"),
      ]);
      const runtime = makeRuntime(state, ai);

      const spec: InternalSubmitSpec = {
        intent: "summarize",
        context: {},
        route: { kind: "cf-ai-binding", modelId: "@cf/test/model" } as const,
        tools: {},
        outputSchema: SCHEMA,
        deliver: { scope, event: "structured.done" },
      };

      const r = await runtime.runPromise(submitAgentEffect(spec));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(JSON.parse(r.final)).toEqual({ summary: "from-submit" });
      }

      // Ledger should contain: chat.ingested + llm.structured.evidence + deliver event.
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("chat.ingested");
      expect(kinds).toContain("llm.structured.evidence");
      expect(kinds).toContain("structured.done");

      await runtime.dispose();
    });
  });

  it("outputSchema + non-empty tools → aborts with output_schema_excludes_tools_in_v0_2_10", async () => {
    const scope = "submit-outputschema-conflict";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([]); // no responses needed; submit aborts before any LLM call
      const runtime = makeRuntime(state, ai);

      const spec: InternalSubmitSpec = {
        intent: "x",
        context: {},
        route: { kind: "cf-ai-binding", modelId: "@cf/test/model" } as const,
        tools: {
          someTool: {
            definition: {
              type: "function",
              function: {
                name: "someTool",
                description: "x",
                parameters: { type: "object", properties: {}, required: [] },
              },
            },
            execute: async () => "y",
          },
        },
        outputSchema: SCHEMA,
        deliver: { scope, event: "structured.done" },
      };

      const exit = await runtime.runPromiseExit(submitAgentEffect(spec));
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.ok).toBe(false);
        if (!exit.value.ok) {
          expect(exit.value.reason).toBe("upstream_failure");
        }
      }

      // Confirm payload mentions the exclusivity reason.
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const aborted = events.find(
        (e) => e.kind === "agent.aborted.upstream_failure",
      );
      expect(aborted).toBeDefined();
      if (aborted) {
        const p = aborted.payload as { reason?: string };
        expect(p.reason).toBe("output_schema_excludes_tools_in_v0_2_10");
      }

      await runtime.dispose();
    });
  });
});

// ============================================================
// Codex P2 regression guard: malformed admission payload → SqlError,
// NOT a raw `TypeError: undefined is not an object` defect leaking out
// of projectLease. Mirrors quota's malformed-payload defense.
// ============================================================

describe("admission — malformed payload → SqlError (Codex P2)", () => {
  it("evidence row missing `key` field → SqlError escapes Promise", async () => {
    const scope = "admission-malformed-evidence";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([]);
      const runtime = makeRuntime(state, ai);
      const schemaContract = await runtime.runPromise(makeSchemaContract(SCHEMA));

      state.storage.sql.exec(
        "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?)",
        Date.now(),
        "llm.structured.evidence",
        scope,
        JSON.stringify({
          stimulusKind: "live",
          outcome: { class: "Supported", tokensUsed: 10 },
          admissionImpact: "lease-bearing",
        }),
      );

      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route: { kind: "cf-ai-binding", modelId: "@cf/test/model" },
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "x" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
          });
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect((failure.value as { _tag: string })._tag).toBe(
            "agent_os.sql_error",
          );
        }
      }

      await runtime.dispose();
    });
  });

  it("invalidate row with non-object `key` → SqlError escapes Promise", async () => {
    const scope = "admission-malformed-invalidate";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([]);
      const runtime = makeRuntime(state, ai);
      const schemaContract = await runtime.runPromise(makeSchemaContract(SCHEMA));

      state.storage.sql.exec(
        "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?)",
        Date.now(),
        "llm.structured.invalidate",
        scope,
        JSON.stringify({
          key: "not-an-object",
          reason: "test",
          by: "test",
        }),
      );

      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const admission = yield* Admission;
          return yield* admission.attemptStructured<{ summary: string }>({
            scope,
            route: { kind: "cf-ai-binding", modelId: "@cf/test/model" },
            schemaContract,
            strategy: "forced-tool-call",
            stimulus: {
              kind: "live",
              userInput: { userText: "x" },
              deliver: (d) => ({ event: "structured.done", payload: d }),
            },
          });
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect((failure.value as { _tag: string })._tag).toBe(
            "agent_os.sql_error",
          );
        }
      }

      await runtime.dispose();
    });
  });
});
