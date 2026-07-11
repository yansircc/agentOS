import { Predicate } from "effect";
import { validateAgainstSchema, type JsonSchemaObject } from "../json-schema-dialect";

export const BACKEND_CONFORMANCE_PROTOCOL_VERSION = "1" as const;

export const BACKEND_CONFORMANCE_CAPABILITY = {
  LEDGER_READ: "ledger.read",
  LEDGER_COMMIT: "ledger.commit",
  SCHEDULER_DUE_WORK: "scheduler.due-work",
  DISPATCH_DELIVERY: "dispatch.delivery",
  FANOUT_HANDLERS: "fanout.handlers",
  FANOUT_STREAM_SINKS: "fanout.stream-sinks",
  TELEMETRY_DIAGNOSTICS: "telemetry.diagnostics",
  RESOURCE_RESERVATION: "resource.reservation",
  QUOTA_GRANT: "quota.grant",
} as const;

export type BackendConformanceCapability =
  (typeof BACKEND_CONFORMANCE_CAPABILITY)[keyof typeof BACKEND_CONFORMANCE_CAPABILITY];

export const BACKEND_CONFORMANCE_LAW_ID = {
  LEDGER_READ_PREFIX: "ledger.read-prefix",
  LEDGER_BATCH_ATOMICITY: "ledger.batch-atomicity",
  LEDGER_ACK_READABLE: "ledger.ack-readable",
  LEDGER_PER_TRUTH_ORDERING: "ledger.per-truth-ordering",
  LEDGER_OWNER_INTEGRITY: "ledger.owner-integrity",
  LEDGER_IDEMPOTENT_APPEND: "ledger.idempotent-append",
  LEDGER_READ_YOUR_WRITES: "ledger.read-your-writes",
  SCHEDULER_EXACTLY_ONCE: "scheduler.exactly-once",
  DUE_WORK_SHARED_QUEUE: "due-work.shared-queue",
  DISPATCH_RECEIVER_DEDUPE: "dispatch.receiver-dedupe",
  DISPATCH_TRACE_CONTEXT: "dispatch.trace-context",
  DISPATCH_RETRY_DELIVERY: "dispatch.retry-delivery",
  DISPATCH_EXTERNAL_ENQUEUE_ACK: "dispatch.external-enqueue-ack",
  DISPATCH_TERMINAL_ATTEMPT_CAP: "dispatch.terminal-attempt-cap",
  DISPATCH_BACKOFF_SCHEDULE: "dispatch.backoff-schedule",
  FANOUT_HANDLER_FAILURE_ISOLATION: "fanout.handler-failure-isolation",
  FANOUT_STREAM_SINK_POST_COMMIT: "fanout.stream-sink-post-commit",
  RESOURCE_RESERVATION: "resource.reservation",
  RESOURCE_TERMINAL_IDEMPOTENCY: "resource.terminal-idempotency",
  RESOURCE_CONCURRENT_SERIALIZATION: "resource.concurrent-serialization",
  RESOURCE_CONCURRENT_IDEMPOTENCY: "resource.concurrent-idempotency",
  QUOTA_GRANT_SEMANTICS: "quota.grant-semantics",
  DISPATCH_CONCURRENT_DRAIN_CLAIM: "dispatch.concurrent-drain-claim",
  DISPATCH_CONCURRENT_RECEIVE_LINEARIZATION: "dispatch.concurrent-receive-linearization",
} as const;

export type BackendConformanceLawId =
  (typeof BACKEND_CONFORMANCE_LAW_ID)[keyof typeof BACKEND_CONFORMANCE_LAW_ID];

export interface BackendConformanceLaw {
  readonly id: BackendConformanceLawId;
  readonly title: string;
  readonly requiredCapabilities: ReadonlyArray<BackendConformanceCapability>;
}

const capability = BACKEND_CONFORMANCE_CAPABILITY;
const law = (
  id: BackendConformanceLawId,
  title: string,
  requiredCapabilities: ReadonlyArray<BackendConformanceCapability>,
): BackendConformanceLaw => ({ id, title, requiredCapabilities });

export const BACKEND_CONFORMANCE_LAWS = [
  law(BACKEND_CONFORMANCE_LAW_ID.LEDGER_READ_PREFIX, "ledger prefix reads", [
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.LEDGER_BATCH_ATOMICITY, "ledger batch atomicity", [
    capability.LEDGER_COMMIT,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.LEDGER_ACK_READABLE, "ledger acknowledgement is readable", [
    capability.LEDGER_COMMIT,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.LEDGER_PER_TRUTH_ORDERING, "per-truth ledger ordering", [
    capability.LEDGER_COMMIT,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.LEDGER_OWNER_INTEGRITY, "ledger owner integrity", [
    capability.LEDGER_COMMIT,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.LEDGER_IDEMPOTENT_APPEND, "idempotent ledger append", [
    capability.LEDGER_COMMIT,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.LEDGER_READ_YOUR_WRITES, "ledger read-your-writes", [
    capability.LEDGER_COMMIT,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.SCHEDULER_EXACTLY_ONCE, "scheduled events fire once", [
    capability.SCHEDULER_DUE_WORK,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.DUE_WORK_SHARED_QUEUE, "scheduler and dispatch share due work", [
    capability.SCHEDULER_DUE_WORK,
    capability.DISPATCH_DELIVERY,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.DISPATCH_RECEIVER_DEDUPE, "dispatch receiver dedupe", [
    capability.DISPATCH_DELIVERY,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.DISPATCH_TRACE_CONTEXT, "dispatch trace validation", [
    capability.DISPATCH_DELIVERY,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.DISPATCH_RETRY_DELIVERY, "dispatch retry delivery", [
    capability.DISPATCH_DELIVERY,
    capability.SCHEDULER_DUE_WORK,
    capability.LEDGER_READ,
  ]),
  law(
    BACKEND_CONFORMANCE_LAW_ID.DISPATCH_EXTERNAL_ENQUEUE_ACK,
    "external enqueue acknowledgement",
    [capability.DISPATCH_DELIVERY, capability.SCHEDULER_DUE_WORK, capability.LEDGER_READ],
  ),
  law(BACKEND_CONFORMANCE_LAW_ID.DISPATCH_TERMINAL_ATTEMPT_CAP, "dispatch terminal attempt cap", [
    capability.DISPATCH_DELIVERY,
    capability.SCHEDULER_DUE_WORK,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.DISPATCH_BACKOFF_SCHEDULE, "dispatch backoff schedule", [
    capability.DISPATCH_DELIVERY,
    capability.SCHEDULER_DUE_WORK,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.FANOUT_HANDLER_FAILURE_ISOLATION, "handler failure isolation", [
    capability.FANOUT_HANDLERS,
    capability.TELEMETRY_DIAGNOSTICS,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.FANOUT_STREAM_SINK_POST_COMMIT, "stream sink post-commit", [
    capability.FANOUT_STREAM_SINKS,
    capability.TELEMETRY_DIAGNOSTICS,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.RESOURCE_RESERVATION, "resource reservation", [
    capability.RESOURCE_RESERVATION,
    capability.LEDGER_READ,
  ]),
  law(BACKEND_CONFORMANCE_LAW_ID.RESOURCE_TERMINAL_IDEMPOTENCY, "resource terminal idempotency", [
    capability.RESOURCE_RESERVATION,
    capability.LEDGER_READ,
  ]),
  law(
    BACKEND_CONFORMANCE_LAW_ID.RESOURCE_CONCURRENT_SERIALIZATION,
    "resource concurrent serialization",
    [capability.RESOURCE_RESERVATION, capability.LEDGER_READ],
  ),
  law(
    BACKEND_CONFORMANCE_LAW_ID.RESOURCE_CONCURRENT_IDEMPOTENCY,
    "resource concurrent idempotency",
    [capability.RESOURCE_RESERVATION, capability.LEDGER_READ],
  ),
  law(BACKEND_CONFORMANCE_LAW_ID.QUOTA_GRANT_SEMANTICS, "quota grant semantics", [
    capability.QUOTA_GRANT,
    capability.LEDGER_READ,
  ]),
  law(
    BACKEND_CONFORMANCE_LAW_ID.DISPATCH_CONCURRENT_DRAIN_CLAIM,
    "concurrent dispatch drain claim",
    [capability.DISPATCH_DELIVERY, capability.SCHEDULER_DUE_WORK, capability.LEDGER_READ],
  ),
  law(
    BACKEND_CONFORMANCE_LAW_ID.DISPATCH_CONCURRENT_RECEIVE_LINEARIZATION,
    "concurrent dispatch receive linearization",
    [capability.DISPATCH_DELIVERY, capability.LEDGER_READ],
  ),
] as const satisfies ReadonlyArray<BackendConformanceLaw>;

export const BACKEND_CONFORMANCE_REQUIRED_CAPABILITIES = Object.values(
  BACKEND_CONFORMANCE_CAPABILITY,
) as ReadonlyArray<BackendConformanceCapability>;

export type BackendConformanceLawStatus = "passed" | "failed";

export interface BackendConformanceIssue {
  readonly code: string;
  readonly message: string;
}

export interface BackendConformanceLawResult {
  readonly lawId: BackendConformanceLawId;
  readonly status: BackendConformanceLawStatus;
  readonly issues: ReadonlyArray<BackendConformanceIssue>;
}

export interface BackendConformanceReport {
  readonly protocolVersion: typeof BACKEND_CONFORMANCE_PROTOCOL_VERSION;
  readonly backendId: string;
  readonly capabilities: ReadonlyArray<BackendConformanceCapability>;
  readonly results: ReadonlyArray<BackendConformanceLawResult>;
  readonly ok: boolean;
}

export const BACKEND_CONFORMANCE_RESULT_SCHEMA = {
  type: "object",
  properties: {
    protocolVersion: { type: "string", enum: [BACKEND_CONFORMANCE_PROTOCOL_VERSION] },
    backendId: { type: "string", minLength: 1 },
    capabilities: {
      type: "array",
      items: { type: "string", enum: [...BACKEND_CONFORMANCE_REQUIRED_CAPABILITIES] },
    },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lawId: {
            type: "string",
            enum: BACKEND_CONFORMANCE_LAWS.map((entry) => entry.id),
          },
          status: { type: "string", enum: ["passed", "failed"] },
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                code: { type: "string", minLength: 1 },
                message: { type: "string", minLength: 1 },
              },
              required: ["code", "message"],
              additionalProperties: false,
            },
          },
        },
        required: ["lawId", "status", "issues"],
        additionalProperties: false,
      },
    },
    ok: { type: "boolean" },
  },
  required: ["protocolVersion", "backendId", "capabilities", "results", "ok"],
  additionalProperties: false,
} satisfies JsonSchemaObject;

export type BackendConformanceReportValidation =
  | { readonly ok: true; readonly report: BackendConformanceReport }
  | { readonly ok: false; readonly issues: ReadonlyArray<string> };

const unique = (values: ReadonlyArray<string>): boolean => new Set(values).size === values.length;

export const validateBackendConformanceReport = (
  value: unknown,
): BackendConformanceReportValidation => {
  const schemaIssues = validateAgainstSchema(value, BACKEND_CONFORMANCE_RESULT_SCHEMA);
  if (schemaIssues.length > 0 || !Predicate.isObject(value)) {
    return { ok: false, issues: schemaIssues.length > 0 ? schemaIssues : ["report:invalid"] };
  }
  const report = value as unknown as BackendConformanceReport;
  const issues: string[] = [];
  if (!unique(report.capabilities)) issues.push("capabilities:duplicate");
  for (const capabilityId of BACKEND_CONFORMANCE_REQUIRED_CAPABILITIES) {
    if (!report.capabilities.includes(capabilityId))
      issues.push(`capabilities:missing:${capabilityId}`);
  }
  const expectedLawIds = BACKEND_CONFORMANCE_LAWS.map((entry) => entry.id);
  const actualLawIds = report.results.map((entry) => entry.lawId);
  if (!unique(actualLawIds)) issues.push("results:duplicate-law");
  if (
    actualLawIds.length !== expectedLawIds.length ||
    actualLawIds.some((lawId, index) => lawId !== expectedLawIds[index])
  ) {
    issues.push("results:manifest-order-mismatch");
  }
  for (const result of report.results) {
    if (result.status === "passed" && result.issues.length > 0) {
      issues.push(`results:passed-with-issues:${result.lawId}`);
    }
    if (result.status === "failed" && result.issues.length === 0) {
      issues.push(`results:failed-without-issues:${result.lawId}`);
    }
  }
  const derivedOk = report.results.every((result) => result.status === "passed");
  if (report.ok !== derivedOk) issues.push("report:ok-mismatch");
  return issues.length === 0 ? { ok: true, report } : { ok: false, issues };
};
