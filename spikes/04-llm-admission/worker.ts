/**
 * agent-OS spike-04 — LLM admission & lease registry on `cf-ai-binding`.
 *
 * Single-point penetration test of spec-25 v0:
 *   - §4.1  canonical schema fingerprint (effect-json-schema-v1)
 *   - §6    adapter law (encode / decode / classify, pure)
 *   - §7.1  attemptStructured (gate -> encode -> provider -> decode ->
 *           decideTier -> transactionSync(evidence + deliver))
 *   - §7.2  projectLease(events, key, now), pure projection
 *   - §8.1  invalidate barrier as a separate ledger event kind
 *   - §10   admission-impact-driven tier rule
 *
 * Spike code is exempt from EFF rules (spec-24 §14.3):
 * plain TS async/Promise, no Effect runtime.
 *
 * Routes (see test.sh for usage):
 *   POST /attempt        run attemptStructured under a live/probe stimulus
 *   POST /probe          shorthand for stimulus.kind = "probe"
 *   POST /invalidate     append an llm.structured.invalidate barrier
 *   GET  /lease/:fp      project lease for a fingerprint+strategy
 *   GET  /events         dump all events
 *   GET  /counter        providerCallsCount delta witness for A7
 *   POST /reset          wipe DO state + reset deliverFault + counter
 *   POST /test/unit      run pure-function unit tests (A1 / A2 / A5)
 */

import { DurableObject } from "cloudflare:workers";

interface Env {
  AI: Ai;
  ADMISSION_DO: DurableObjectNamespace<AdmissionDO>;
}

// ============================================================
// SECTION A — Types (spec-25 §3–§8)
// ============================================================

// spec-25 §3 defines five transport kinds; only "cf-ai-binding" is enabled
// in this spike (spec-25 §11). Other kinds are spec surface, not exercised
// here.

type LlmRoute = {
  readonly kind: "cf-ai-binding";
  readonly modelId: string;
  readonly gatewayRef?: string;
};

type Strategy = "forced-tool-call";

type JsonSchemaObject = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean;
};

type JsonSchemaNode =
  | { readonly type: "string"; readonly enum?: ReadonlyArray<string> }
  | { readonly type: "number" }
  | { readonly type: "boolean" }
  | { readonly type: "array"; readonly items: JsonSchemaNode }
  | JsonSchemaObject;

type SchemaContract = {
  readonly schema: JsonSchemaObject;
  readonly fingerprint: string;       // §4.1 format: "<algoVer>:sha256:<hex>"
};

type ProbeInput = { readonly synthetic: string };
type LiveInput = { readonly userText: string };

type Stimulus =
  | { readonly kind: "probe"; readonly synthetic: ProbeInput }
  | {
      readonly kind: "live";
      readonly userInput: LiveInput;
      // §5: pure function returning data; NEVER an Effect.
      readonly deliver: (decoded: DecodedOutput) => DeliverSpec;
    };

type DeliverSpec = {
  readonly event: string;
  readonly payload: unknown;
};

type DecodedOutput = Record<string, unknown>;

type OutcomeClass =
  | "Supported"
  | "ProviderRejected"
  | "SchemaUnsupported"
  | "BehaviorFailed"
  | "AuthError"
  | "RateLimited"
  | "TransientError"
  | "ConfigError";

type Outcome =
  | { readonly class: "Supported"; readonly tokensUsed: number }
  | { readonly class: "ProviderRejected"; readonly status: number; readonly body: string }
  | { readonly class: "SchemaUnsupported"; readonly reason: string }
  | { readonly class: "BehaviorFailed"; readonly sampleDigest: string }
  | { readonly class: "AuthError"; readonly status: number }
  | { readonly class: "RateLimited"; readonly retryAfterMs?: number }
  | { readonly class: "TransientError"; readonly cause: string }
  | { readonly class: "ConfigError"; readonly reason: string };

type AttemptKey = {
  readonly routeFingerprint: string;
  readonly schemaFingerprint: string;
  readonly strategy: Strategy;
  readonly adapterVersion: string;
};

type EvidenceRow = {
  readonly id: number;
  readonly ts: number;
  readonly kind: "llm.structured.evidence";
  readonly key: AttemptKey;
  readonly stimulusKind: "probe" | "live";
  readonly outcome: Outcome;
  readonly tier: "do-sqlite" | "analytics-engine";
};

type BarrierRow = {
  readonly id: number;
  readonly ts: number;
  readonly kind: "llm.structured.invalidate";
  readonly key: Partial<AttemptKey>;
  readonly reason: string;
  readonly by: string;
};

type LedgerRow = EvidenceRow | BarrierRow;

type CapabilityLease =
  | {
      readonly status: "supported";
      readonly pinnedStrategy: Strategy;
      readonly validUntilSoft: number;
      readonly validUntilHard: number;
      readonly lastEvidenceTs: number;
    }
  | {
      readonly status: "unsupported";
      readonly failureClass: Exclude<OutcomeClass, "Supported">;
      readonly retryAfter: number;
      readonly lastEvidenceTs: number;
    }
  | { readonly status: "unknown" };

type Tier = "do-sqlite" | "analytics-engine";

// ============================================================
// SECTION B — Canonical schema fingerprint (spec-25 §4.1)
// ============================================================

const FINGERPRINT_ALGO_VERSION = "effect-json-schema-v1";

// JSON Schema fields whose value is an array semantically representing
// a SET (order does not affect schema meaning). These are sorted during
// canonicalization per spec-25 §4.1 rule c.
const SET_SEMANTICS_ARRAYS = new Set(["required", "enum"]);

/** Deterministic JSON: object keys sorted recursively;
 *  set-semantics arrays sorted; ordered arrays preserved. */
function canonicalize(node: unknown, parentKey?: string): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    const mapped = node.map((item) => canonicalize(item));
    if (parentKey !== undefined && SET_SEMANTICS_ARRAYS.has(parentKey)) {
      return [...mapped].sort((a, b) => {
        const sa = typeof a === "string" ? a : JSON.stringify(a);
        const sb = typeof b === "string" ? b : JSON.stringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
    }
    return mapped;
  }
  // Strip non-semantic annotations (§4.1 rule d).
  const STRIP = new Set(["title", "description", "examples", "$comment"]);
  const obj = node as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => !STRIP.has(k) && !k.startsWith("x-"))
    .sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) out[k] = canonicalize(obj[k], k);
  return out;
}

function canonicalJsonString(node: unknown): string {
  // Object.keys traversal order is preserved by JSON.stringify in
  // V8/JSC; canonicalize() above already sorted keys.
  return JSON.stringify(canonicalize(node));
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeSchemaContract(
  schema: JsonSchemaObject,
): Promise<SchemaContract> {
  const canon = canonicalJsonString(schema);
  const hex = await sha256Hex(canon);
  return {
    schema,
    fingerprint: `${FINGERPRINT_ALGO_VERSION}:sha256:${hex}`,
  };
}

function routeFingerprint(route: LlmRoute): string {
  const canon = canonicalJsonString({
    kind: route.kind,
    modelId: route.modelId,
    gatewayRef: route.gatewayRef ?? null,
  });
  // Synchronous fingerprint via simple FNV-1a for routes (small, low-collision-need).
  // SHA-256 is reserved for schema where determinism across implementations matters.
  let hash = 2166136261;
  for (let i = 0; i < canon.length; i++) {
    hash ^= canon.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// ============================================================
// SECTION C — Adapter: cf-ai-binding (spec-25 §6)
// ============================================================

type AdapterMode = "production" | "test-decode-mismatch";

type ProviderRequest = {
  readonly model: string;
  readonly body: Record<string, unknown>;
};

type ProviderResponse = {
  readonly raw: unknown;
};

const ADAPTER_VERSION = "1.0.0";

const cfAiBindingAdapter = {
  kind: "cf-ai-binding" as const,
  version: ADAPTER_VERSION,

  encode(
    route: LlmRoute,
    schema: SchemaContract,
    stimulus: Stimulus,
    strategy: Strategy,
  ): ProviderRequest {
    if (strategy !== "forced-tool-call") {
      throw new Error(`adapter does not support strategy=${strategy}`);
    }
    const userText =
      stimulus.kind === "live"
        ? stimulus.userInput.userText
        : stimulus.synthetic.synthetic;
    return {
      model: route.modelId,
      body: {
        messages: [
          {
            role: "system",
            content:
              "Return strictly structured output by calling the submit tool. Do not respond in free text.",
          },
          { role: "user", content: userText },
        ],
        max_tokens: 2048,
        tools: [
          {
            type: "function",
            function: {
              name: "_submit_structured",
              description: "Submit the structured result. Args ARE the result.",
              parameters: schema.schema,
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "_submit_structured" },
        },
      },
    };
  },

  decode(
    response: ProviderResponse,
    schema: SchemaContract,
    _strategy: Strategy,
    mode: AdapterMode = "production",
  ): { ok: true; decoded: DecodedOutput } | { ok: false; outcome: Outcome } {
    if (mode === "test-decode-mismatch") {
      return {
        ok: false,
        outcome: {
          class: "BehaviorFailed",
          sampleDigest: "synthetic-test-decode-mismatch",
        },
      };
    }
    const raw = response.raw as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    const tc = raw.choices?.[0]?.message?.tool_calls?.[0]?.function;
    if (!tc || tc.name !== "_submit_structured" || !tc.arguments) {
      return {
        ok: false,
        outcome: { class: "BehaviorFailed", sampleDigest: "no-tool-call" },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(tc.arguments);
    } catch (e) {
      return {
        ok: false,
        outcome: {
          class: "BehaviorFailed",
          sampleDigest: `args-parse-failed:${String(e).slice(0, 40)}`,
        },
      };
    }
    const violations = validateAgainstSchema(parsed, schema.schema);
    if (violations.length > 0) {
      return {
        ok: false,
        outcome: {
          class: "BehaviorFailed",
          sampleDigest: `violations:${violations.join(",")}`.slice(0, 120),
        },
      };
    }
    return { ok: true, decoded: parsed as DecodedOutput };
  },

  classify(error: unknown): Outcome {
    const msg = error instanceof Error ? error.message : String(error);
    const lower = msg.toLowerCase();
    if (lower.includes("401") || lower.includes("unauthor"))
      return { class: "AuthError", status: 401 };
    if (lower.includes("429") || lower.includes("rate"))
      return { class: "RateLimited" };
    if (lower.includes("timeout") || lower.includes("network"))
      return { class: "TransientError", cause: msg };
    return { class: "ProviderRejected", status: 0, body: msg };
  },
};

/** Schema validator (sufficient for spike test schemas; not a full JSON-Schema impl). */
function validateAgainstSchema(value: unknown, schema: JsonSchemaNode): string[] {
  const violations: string[] = [];
  function walk(v: unknown, s: JsonSchemaNode, path: string): void {
    if (s.type === "object") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        violations.push(`${path}:not-object`);
        return;
      }
      const obj = v as Record<string, unknown>;
      for (const req of s.required ?? []) {
        if (!(req in obj)) violations.push(`${path}.${req}:missing`);
      }
      for (const [k, sub] of Object.entries(s.properties)) {
        if (k in obj) walk(obj[k], sub, `${path}.${k}`);
      }
    } else if (s.type === "array") {
      if (!Array.isArray(v)) {
        violations.push(`${path}:not-array`);
        return;
      }
      v.forEach((item, i) => walk(item, s.items, `${path}[${i}]`));
    } else if (s.type === "string") {
      if (typeof v !== "string") violations.push(`${path}:not-string`);
      else if (s.enum && !s.enum.includes(v))
        violations.push(`${path}:not-in-enum`);
    } else if (s.type === "number") {
      if (typeof v !== "number") violations.push(`${path}:not-number`);
    } else if (s.type === "boolean") {
      if (typeof v !== "boolean") violations.push(`${path}:not-boolean`);
    }
  }
  walk(value, schema, "$");
  return violations;
}

// ============================================================
// SECTION D — decideTier truth table (spec-25 §10, spike-04 §A5)
// ============================================================

/**
 * Pure function. NO IO, NO append, NO clock.
 * `preLease.status === "supported"` already implies "not soft-expired"
 * because projectLease handles expiry. Likewise barrier-cut-off evidence
 * is already discarded by projectLease, so `latestBarrierTs >
 * preLease.lastEvidenceTs` is unreachable for a correct projection —
 * Row 12 of the truth table is defense-in-depth.
 */
function decideTier(
  preLease: CapabilityLease,
  outcome: Outcome,
  stimulusKind: "probe" | "live",
  latestBarrierTs: number,
): Tier {
  // Row 4: probe is always lease-bearing.
  if (stimulusKind === "probe") return "do-sqlite";

  // Rows 5-11: any non-Supported outcome → DO (lease-bearing failures and
  // non-lease-bearing classes both required in DO per §10).
  if (outcome.class !== "Supported") return "do-sqlite";

  // Row 2: reinforcement of an existing supported lease → AE only when
  // no intervening barrier and lease has not been hard-expired or
  // barrier-invalidated by projectLease.
  if (preLease.status === "supported") {
    // Row 12 defense-in-depth: if a barrier somehow survived to here,
    // treat as admission-forming.
    if (latestBarrierTs > preLease.lastEvidenceTs) return "do-sqlite";
    return "analytics-engine";
  }

  // Rows 1, 3, 12 (via preLease=unknown after projection): admission-forming.
  return "do-sqlite";
}

// ============================================================
// SECTION E — AdmissionDO (spec-25 §7, §8, §10)
// ============================================================

const SOFT_REFRESH_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_HARD_MS = 7 * 24 * 60 * 60 * 1000;

// §8 TTL table for unsupported outcomes (BehaviorFailed exponential omitted in spike).
function unsupportedTtlMs(cls: Exclude<OutcomeClass, "Supported">): number {
  switch (cls) {
    case "ProviderRejected":
    case "SchemaUnsupported":
      return 7 * 24 * 60 * 60 * 1000;
    case "BehaviorFailed":
      return 24 * 60 * 60 * 1000; // start TTL; backoff not exercised in spike
    case "AuthError":
    case "RateLimited":
    case "TransientError":
    case "ConfigError":
      return 0; // not lease-bearing
  }
}

export class AdmissionDO extends DurableObject<Env> {
  // Test-only: provider call counter (A7).
  private providerCallsCount = 0;

  // Test-only: deliverWriter fault injection (A3). Worker-private, NOT on the
  // public attemptStructured signature — never leak into core-shaped API.
  private deliverFault: "none" | "throw_after_evidence" = "none";

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        key_route TEXT,
        key_schema TEXT,
        key_strategy TEXT,
        key_adapter_ver TEXT,
        stimulus_kind TEXT,
        outcome_class TEXT,
        tier TEXT,
        payload TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS deliver_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `);
  }

  // ---------- test harness controls ----------

  async reset(spec: {
    deliverFault?: "none" | "throw_after_evidence";
  }): Promise<{ ok: true }> {
    this.ctx.storage.sql.exec("DELETE FROM events");
    this.ctx.storage.sql.exec("DELETE FROM deliver_log");
    this.providerCallsCount = 0;
    this.deliverFault = spec.deliverFault ?? "none";
    return { ok: true };
  }

  async getCounter(): Promise<{ providerCallsCount: number }> {
    return { providerCallsCount: this.providerCallsCount };
  }

  async getEvents(): Promise<unknown> {
    const evRows = this.ctx.storage.sql
      .exec("SELECT * FROM events ORDER BY id")
      .toArray();
    const delRows = this.ctx.storage.sql
      .exec("SELECT * FROM deliver_log ORDER BY id")
      .toArray();
    return {
      events: evRows.map((r) => ({
        id: Number(r.id),
        ts: Number(r.ts),
        kind: String(r.kind),
        key: {
          route: r.key_route,
          schema: r.key_schema,
          strategy: r.key_strategy,
          adapterVersion: r.key_adapter_ver,
        },
        stimulusKind: r.stimulus_kind,
        outcomeClass: r.outcome_class,
        tier: r.tier,
        payload: JSON.parse(String(r.payload)),
      })),
      deliveries: delRows.map((r) => ({
        id: Number(r.id),
        ts: Number(r.ts),
        event: String(r.event),
        payload: JSON.parse(String(r.payload)),
      })),
    };
  }

  // ---------- pure projection (spec-25 §7.2) ----------

  private loadAllRows(): LedgerRow[] {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM events ORDER BY id")
      .toArray();
    const out: LedgerRow[] = [];
    for (const r of rows) {
      const key: AttemptKey = {
        routeFingerprint: String(r.key_route ?? ""),
        schemaFingerprint: String(r.key_schema ?? ""),
        strategy: String(r.key_strategy ?? "") as Strategy,
        adapterVersion: String(r.key_adapter_ver ?? ""),
      };
      const payload = JSON.parse(String(r.payload));
      if (r.kind === "llm.structured.evidence") {
        out.push({
          id: Number(r.id),
          ts: Number(r.ts),
          kind: "llm.structured.evidence",
          key,
          stimulusKind: String(r.stimulus_kind) as "probe" | "live",
          outcome: payload.outcome,
          tier: String(r.tier) as Tier,
        });
      } else if (r.kind === "llm.structured.invalidate") {
        out.push({
          id: Number(r.id),
          ts: Number(r.ts),
          kind: "llm.structured.invalidate",
          key: payload.key,
          reason: String(payload.reason ?? ""),
          by: String(payload.by ?? ""),
        });
      }
    }
    return out;
  }

  private keysMatch(a: AttemptKey, b: Partial<AttemptKey>): boolean {
    if (b.routeFingerprint !== undefined && a.routeFingerprint !== b.routeFingerprint)
      return false;
    if (b.schemaFingerprint !== undefined && a.schemaFingerprint !== b.schemaFingerprint)
      return false;
    if (b.strategy !== undefined && a.strategy !== b.strategy) return false;
    if (b.adapterVersion !== undefined && a.adapterVersion !== b.adapterVersion)
      return false;
    return true;
  }

  /**
   * projectLease(events, key, now)
   *   - rows filtered to those matching key
   *   - barrier with ts > evidence ts wipes that evidence
   *   - AE-tier rows are ignored (spec-25 §10: projectLease reads DO only)
   *   - non-lease-bearing outcome classes are skipped (§8)
   */
  private projectLease(rows: LedgerRow[], key: AttemptKey, now: number): {
    lease: CapabilityLease;
    latestBarrierTs: number;
  } {
    const adapterMajor = (v: string) => v.split(".")[0];
    const curMajor = adapterMajor(key.adapterVersion);

    // Find the latest barrier for this key (§8.1).
    let latestBarrierTs = 0;
    for (const r of rows) {
      if (r.kind === "llm.structured.invalidate" && this.keysMatch(key, r.key)) {
        if (r.ts > latestBarrierTs) latestBarrierTs = r.ts;
      }
    }

    // Eligible evidence: matching key, DO-tier, post-barrier, same adapter major (§9).
    const eligible = rows.filter(
      (r): r is EvidenceRow =>
        r.kind === "llm.structured.evidence" &&
        this.keysMatch(key, r.key) &&
        r.tier === "do-sqlite" &&
        r.ts > latestBarrierTs &&
        adapterMajor(r.key.adapterVersion) === curMajor,
    );

    // Walk newest-first, skipping non-lease-bearing classes.
    const sorted = [...eligible].sort((a, b) => b.ts - a.ts);
    for (const ev of sorted) {
      const cls = ev.outcome.class;
      // §8: AuthError / RateLimited / TransientError / ConfigError don't
      // define lease status. Skip past them.
      if (
        cls === "AuthError" ||
        cls === "RateLimited" ||
        cls === "TransientError" ||
        cls === "ConfigError"
      )
        continue;

      if (cls === "Supported") {
        const elapsed = now - ev.ts;
        if (elapsed < SUPPORTED_HARD_MS) {
          return {
            lease: {
              status: "supported",
              pinnedStrategy: ev.key.strategy,
              validUntilSoft: ev.ts + SOFT_REFRESH_MS,
              validUntilHard: ev.ts + SUPPORTED_HARD_MS,
              lastEvidenceTs: ev.ts,
            },
            latestBarrierTs,
          };
        }
        // hard-expired Supported → treat as unknown, keep walking
        continue;
      }

      // Unsupported lease-bearing class
      const ttl = unsupportedTtlMs(cls);
      if (ttl === 0) continue;
      if (now - ev.ts < ttl) {
        return {
          lease: {
            status: "unsupported",
            failureClass: cls,
            retryAfter: ev.ts + ttl,
            lastEvidenceTs: ev.ts,
          },
          latestBarrierTs,
        };
      }
    }

    return { lease: { status: "unknown" }, latestBarrierTs };
  }

  // ---------- public RPC: attemptStructured (spec-25 §7.1) ----------

  async attemptStructured(spec: {
    route: LlmRoute;
    schemaContract: SchemaContract;
    strategy: Strategy;
    stimulus:
      | { kind: "probe"; synthetic: ProbeInput }
      | { kind: "live"; userInput: LiveInput; deliverEventName: string };
    adapterMode?: AdapterMode;
  }): Promise<{
    ok: boolean;
    outcome: Outcome;
    lease: CapabilityLease;
    decoded?: DecodedOutput;
    tier: Tier;
    shortCircuited?: boolean;
  }> {
    const adapterMode = spec.adapterMode ?? "production";
    const now = Date.now();
    const key: AttemptKey = {
      routeFingerprint: routeFingerprint(spec.route),
      schemaFingerprint: spec.schemaContract.fingerprint,
      strategy: spec.strategy,
      adapterVersion: cfAiBindingAdapter.version,
    };

    // Step 2: project lease BEFORE any append (pre-call state for tier decision).
    const allRows = this.loadAllRows();
    const { lease: preLease, latestBarrierTs } = this.projectLease(allRows, key, now);

    // Step 3: gate.
    if (preLease.status === "supported" && now < preLease.validUntilHard) {
      // proceed (admission cached as supported)
    } else if (preLease.status === "unsupported" && now < preLease.retryAfter) {
      return {
        ok: false,
        outcome: {
          class: preLease.failureClass,
          // reconstruct a minimal outcome shape for the short-circuit reply
          ...(preLease.failureClass === "BehaviorFailed"
            ? { sampleDigest: "cached-short-circuit" }
            : preLease.failureClass === "ProviderRejected"
              ? { status: 0, body: "cached-short-circuit" }
              : preLease.failureClass === "SchemaUnsupported"
                ? { reason: "cached-short-circuit" }
                : {}),
        } as Outcome,
        lease: preLease,
        tier: "do-sqlite",
        shortCircuited: true,
      };
    }
    // unknown / hard-expired → this call IS the admission probe; proceed.

    // Step 4-6: encode → call provider → decode.
    const req = cfAiBindingAdapter.encode(
      spec.route,
      spec.schemaContract,
      spec.stimulus.kind === "live"
        ? {
            kind: "live",
            userInput: spec.stimulus.userInput,
            deliver: () => ({ event: "_unused", payload: null }),
          }
        : { kind: "probe", synthetic: spec.stimulus.synthetic },
      spec.strategy,
    );

    let outcome: Outcome;
    let decoded: DecodedOutput | undefined;
    try {
      this.providerCallsCount += 1;
      const raw = await (this.env.AI as { run: (m: string, p: unknown) => Promise<unknown> }).run(
        req.model,
        req.body,
      );
      const d = cfAiBindingAdapter.decode(
        { raw },
        spec.schemaContract,
        spec.strategy,
        adapterMode,
      );
      if (d.ok) {
        decoded = d.decoded;
        const usage = (raw as { usage?: { total_tokens?: number } }).usage;
        outcome = { class: "Supported", tokensUsed: usage?.total_tokens ?? 0 };
      } else {
        outcome = d.outcome;
      }
    } catch (e) {
      outcome = cfAiBindingAdapter.classify(e);
    }

    // Step 7: tier decision from PRE-append inputs only.
    const stimulusKind = spec.stimulus.kind;
    const tier = decideTier(preLease, outcome, stimulusKind, latestBarrierTs);

    // Step 8: transactionSync(evidence + deliver).
    const evidencePayload = {
      key,
      stimulusKind,
      outcome,
      adapterId: `cf-ai-binding@${cfAiBindingAdapter.version}`,
    };
    const deliverEventName =
      spec.stimulus.kind === "live" ? spec.stimulus.deliverEventName : null;

    const committed = this.runTransaction(
      () => {
        this.ctx.storage.sql.exec(
          `INSERT INTO events
            (ts, kind, key_route, key_schema, key_strategy, key_adapter_ver,
             stimulus_kind, outcome_class, tier, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          now,
          "llm.structured.evidence",
          key.routeFingerprint,
          key.schemaFingerprint,
          key.strategy,
          key.adapterVersion,
          stimulusKind,
          outcome.class,
          tier,
          JSON.stringify(evidencePayload),
        );

        // Fault injection point — worker-private, NOT on attemptStructured signature.
        if (this.deliverFault === "throw_after_evidence") {
          throw new Error("TEST_FAULT: deliverWriter throws inside transaction");
        }

        if (
          outcome.class === "Supported" &&
          stimulusKind === "live" &&
          deliverEventName &&
          decoded !== undefined
        ) {
          this.ctx.storage.sql.exec(
            `INSERT INTO deliver_log (ts, event, payload) VALUES (?, ?, ?)`,
            now,
            deliverEventName,
            JSON.stringify(decoded),
          );
        }
      },
      "evidence+deliver",
    );

    // Re-project lease AFTER commit (read-only; not used for tier).
    const postRows = committed ? this.loadAllRows() : allRows;
    const { lease: postLease } = this.projectLease(postRows, key, now);

    return {
      ok: outcome.class === "Supported" && committed,
      outcome,
      lease: postLease,
      decoded,
      tier,
      shortCircuited: false,
    };
  }

  /** Wraps ctx.storage.transactionSync; returns false if the inner threw. */
  private runTransaction(work: () => void, _label: string): boolean {
    try {
      this.ctx.storage.transactionSync(work);
      return true;
    } catch (_e) {
      return false;
    }
  }

  // ---------- admin: invalidate barrier (§8.1) ----------

  async invalidate(spec: {
    key: Partial<AttemptKey>;
    reason: string;
    by: string;
  }): Promise<{ ok: true; barrierId: number }> {
    const now = Date.now();
    const cursor = this.ctx.storage.sql.exec(
      `INSERT INTO events
        (ts, kind, key_route, key_schema, key_strategy, key_adapter_ver,
         tier, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id`,
      now,
      "llm.structured.invalidate",
      spec.key.routeFingerprint ?? null,
      spec.key.schemaFingerprint ?? null,
      spec.key.strategy ?? null,
      spec.key.adapterVersion ?? null,
      "do-sqlite",
      JSON.stringify({ key: spec.key, reason: spec.reason, by: spec.by }),
    );
    const id = Number(cursor.one().id);
    return { ok: true, barrierId: id };
  }

  // ---------- read: projectLease via HTTP ----------

  async readLease(spec: { key: AttemptKey; now?: number }): Promise<{
    lease: CapabilityLease;
    latestBarrierTs: number;
  }> {
    const rows = this.loadAllRows();
    return this.projectLease(rows, spec.key, spec.now ?? Date.now());
  }
}

// ============================================================
// SECTION F — Worker entry / HTTP routes
// ============================================================

// Test schemas (spec-25 §4.1 + spike-04 README §Test schema).
const SCHEMA_S1: JsonSchemaObject = {
  type: "object",
  properties: {
    summary: { type: "string" },
    sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
  },
  required: ["summary", "sentiment"],
  additionalProperties: false,
};

const SCHEMA_S2: JsonSchemaObject = {
  type: "object",
  properties: {
    summary: { type: "string" },
    sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "sentiment", "keywords"],
  additionalProperties: false,
};

const SCHEMA_S3_REORDERED: JsonSchemaObject = {
  type: "object",
  properties: {
    keywords: { type: "array", items: { type: "string" } },
    sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
    summary: { type: "string" },
  },
  required: ["sentiment", "summary", "keywords"],
  additionalProperties: false,
};

const SCHEMA_S4_ANY: JsonSchemaObject = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

const DEFAULT_ROUTE: LlmRoute = {
  kind: "cf-ai-binding",
  modelId: "@cf/openai/gpt-oss-120b",
};

function doStub(env: Env): DurableObjectStub<AdmissionDO> {
  return env.ADMISSION_DO.get(env.ADMISSION_DO.idFromName("spike-04"));
}

async function runUnitTests(): Promise<unknown> {
  const fpS1 = await makeSchemaContract(SCHEMA_S1);
  const fpS2 = await makeSchemaContract(SCHEMA_S2);
  const fpS3 = await makeSchemaContract(SCHEMA_S3_REORDERED);
  const fpS2b = await makeSchemaContract(SCHEMA_S2); // repeat

  // A1 / A2 fingerprint assertions
  const fingerprint = {
    A1_S2_stable_across_calls: fpS2.fingerprint === fpS2b.fingerprint,
    A2_S2_eq_S3_reordered: fpS2.fingerprint === fpS3.fingerprint,
    S1_ne_S2: fpS1.fingerprint !== fpS2.fingerprint,
    fingerprints: {
      S1: fpS1.fingerprint,
      S2: fpS2.fingerprint,
      S3: fpS3.fingerprint,
    },
  };

  // A5 decideTier 12-row truth table
  const supportedLease = (lastTs: number): CapabilityLease => ({
    status: "supported",
    pinnedStrategy: "forced-tool-call",
    validUntilSoft: lastTs + SOFT_REFRESH_MS,
    validUntilHard: lastTs + SUPPORTED_HARD_MS,
    lastEvidenceTs: lastTs,
  });
  const unknownLease: CapabilityLease = { status: "unknown" };

  const cases = [
    {
      n: 1, name: "unknown+Supported live", expect: "do-sqlite",
      args: [unknownLease, { class: "Supported", tokensUsed: 0 } as Outcome, "live", 0] as const,
    },
    {
      n: 2, name: "supported+Supported live (reinforce)", expect: "analytics-engine",
      args: [supportedLease(1000), { class: "Supported", tokensUsed: 0 } as Outcome, "live", 0] as const,
    },
    {
      n: 3, name: "supported (hard-expired turns to unknown in projection) +Supported live → unknown branch",
      expect: "do-sqlite",
      args: [unknownLease, { class: "Supported", tokensUsed: 0 } as Outcome, "live", 0] as const,
    },
    {
      n: 4, name: "any+Supported probe", expect: "do-sqlite",
      args: [unknownLease, { class: "Supported", tokensUsed: 0 } as Outcome, "probe", 0] as const,
    },
    {
      n: 5, name: "ProviderRejected", expect: "do-sqlite",
      args: [unknownLease, { class: "ProviderRejected", status: 400, body: "" } as Outcome, "live", 0] as const,
    },
    {
      n: 6, name: "SchemaUnsupported", expect: "do-sqlite",
      args: [unknownLease, { class: "SchemaUnsupported", reason: "" } as Outcome, "live", 0] as const,
    },
    {
      n: 7, name: "BehaviorFailed", expect: "do-sqlite",
      args: [unknownLease, { class: "BehaviorFailed", sampleDigest: "" } as Outcome, "live", 0] as const,
    },
    {
      n: 8, name: "AuthError", expect: "do-sqlite",
      args: [unknownLease, { class: "AuthError", status: 401 } as Outcome, "live", 0] as const,
    },
    {
      n: 9, name: "RateLimited", expect: "do-sqlite",
      args: [unknownLease, { class: "RateLimited" } as Outcome, "live", 0] as const,
    },
    {
      n: 10, name: "TransientError", expect: "do-sqlite",
      args: [unknownLease, { class: "TransientError", cause: "" } as Outcome, "live", 0] as const,
    },
    {
      n: 11, name: "ConfigError", expect: "do-sqlite",
      args: [unknownLease, { class: "ConfigError", reason: "" } as Outcome, "live", 0] as const,
    },
    {
      n: 12, name: "supported+Supported live + barrier>lastEvidenceTs (defense-in-depth)",
      expect: "do-sqlite",
      args: [supportedLease(1000), { class: "Supported", tokensUsed: 0 } as Outcome, "live", 2000] as const,
    },
  ];

  const decideTierResults = cases.map((c) => {
    const got = decideTier(c.args[0], c.args[1], c.args[2], c.args[3]);
    return { n: c.n, name: c.name, expect: c.expect, got, pass: got === c.expect };
  });

  return {
    A1_A2_fingerprint: fingerprint,
    A5_decideTier_truthtable: decideTierResults,
    allPass:
      fingerprint.A1_S2_stable_across_calls &&
      fingerprint.A2_S2_eq_S3_reordered &&
      fingerprint.S1_ne_S2 &&
      decideTierResults.every((r) => r.pass),
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const stub = doStub(env);

    if (req.method === "POST" && url.pathname === "/test/unit") {
      return Response.json(await runUnitTests());
    }

    if (req.method === "POST" && url.pathname === "/reset") {
      const body = (await req.json().catch(() => ({}))) as {
        deliverFault?: "none" | "throw_after_evidence";
      };
      const r = await stub.reset(body);
      return Response.json(r);
    }

    if (req.method === "GET" && url.pathname === "/counter") {
      return Response.json(await stub.getCounter());
    }

    if (req.method === "GET" && url.pathname === "/events") {
      return Response.json(await stub.getEvents());
    }

    if (req.method === "POST" && url.pathname === "/attempt") {
      const body = (await req.json()) as {
        schemaName: "S1" | "S2" | "S3" | "S4";
        stimulus:
          | { kind: "live"; userText: string; deliverEventName: string }
          | { kind: "probe"; synthetic: string };
        adapterMode?: AdapterMode;
      };
      const schemaObj =
        body.schemaName === "S1"
          ? SCHEMA_S1
          : body.schemaName === "S2"
            ? SCHEMA_S2
            : body.schemaName === "S3"
              ? SCHEMA_S3_REORDERED
              : SCHEMA_S4_ANY;
      const contract = await makeSchemaContract(schemaObj);
      const stim =
        body.stimulus.kind === "live"
          ? {
              kind: "live" as const,
              userInput: { userText: body.stimulus.userText },
              deliverEventName: body.stimulus.deliverEventName,
            }
          : {
              kind: "probe" as const,
              synthetic: { synthetic: body.stimulus.synthetic },
            };
      const r = await stub.attemptStructured({
        route: DEFAULT_ROUTE,
        schemaContract: contract,
        strategy: "forced-tool-call",
        stimulus: stim,
        adapterMode: body.adapterMode,
      });
      return Response.json({
        ...(r as Record<string, unknown>),
        schemaFingerprint: contract.fingerprint,
      });
    }

    if (req.method === "POST" && url.pathname === "/invalidate") {
      const body = (await req.json()) as {
        key: Partial<AttemptKey>;
        reason: string;
        by: string;
      };
      const r = await stub.invalidate(body);
      return Response.json(r);
    }

    if (req.method === "GET" && url.pathname.startsWith("/lease/")) {
      const rest = url.pathname.slice("/lease/".length);
      const [schemaFingerprint, strategy = "forced-tool-call"] = rest.split("|");
      const key: AttemptKey = {
        routeFingerprint: routeFingerprint(DEFAULT_ROUTE),
        schemaFingerprint: decodeURIComponent(schemaFingerprint),
        strategy: strategy as Strategy,
        adapterVersion: ADAPTER_VERSION,
      };
      const r = await stub.readLease({ key });
      return Response.json(r);
    }

    return new Response(
      [
        "agent-os spike-04 (LLM admission)",
        "",
        "POST /test/unit                run A1/A2/A5 pure-function tests",
        "POST /reset                    { deliverFault?: 'none'|'throw_after_evidence' }",
        "POST /attempt                  { schemaName, stimulus, adapterMode? }",
        "POST /invalidate               { key, reason, by }",
        "GET  /lease/:fingerprint       project lease for the given fingerprint",
        "GET  /events                   dump events + deliver_log",
        "GET  /counter                  providerCallsCount",
        "",
        `model: ${DEFAULT_ROUTE.modelId}`,
        `adapter version: ${ADAPTER_VERSION}`,
        `fingerprint algorithm: ${FINGERPRINT_ALGO_VERSION}`,
      ].join("\n"),
      { headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
