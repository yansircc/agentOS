import { Schema } from "effect";
import { defineCarrier, event, none } from "@agent-os/core/carrier";

export const RUNTIME_DIAGNOSTIC_EVENT_PREFIX = "runtime_diagnostic.";
export const RUNTIME_DIAGNOSTIC_FACT_OWNER = "@agent-os/runtime-diagnostic";

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

export const runtimeDiagnosticCarrier = defineCarrier({
  ownerId: RUNTIME_DIAGNOSTIC_FACT_OWNER,
  sourcePackageName: "@agent-os/runtime",
  prefix: RUNTIME_DIAGNOSTIC_EVENT_PREFIX,
  roles: ["generator", "reader"],
  events: {
    handler_missing: event({
      kind: "handler_missing",
      payload: Schema.Struct({
        capabilityId: NonEmptyString,
        eventKind: NonEmptyString,
        requestedEventId: Schema.Number,
      }),
      claim: none(),
    }),
    handler_failed: event({
      kind: "handler_failed",
      payload: Schema.Struct({
        capabilityId: NonEmptyString,
        handler: NonEmptyString,
        reason: NonEmptyString,
        requestedEventId: Schema.Number,
      }),
      claim: none(),
    }),
    projection_timeout: event({
      kind: "projection_timeout",
      payload: Schema.Struct({
        capabilityId: NonEmptyString,
        projectionKind: NonEmptyString,
        waitReason: Schema.Literals(["missing", "not_ready"]),
        maxAttempts: Schema.Number,
        lastObservedEventId: Schema.optional(Schema.Number),
        operationRef: Schema.optional(NonEmptyString),
        authority: Schema.optional(NonEmptyString),
        requestedEventId: Schema.Number,
      }),
      claim: none(),
    }),
    preflight_failed: event({
      kind: "preflight_failed",
      payload: Schema.Struct({
        capabilityId: Schema.optional(NonEmptyString),
        pass: Schema.Literals([
          "name_unique",
          "host_fact",
          "peer_dag",
          "config",
          "secret",
          "self_diagnostic",
          "global_unique",
        ]),
        reason: NonEmptyString,
        detail: Schema.optional(Schema.String),
      }),
      claim: none(),
    }),
  },
});

export const RUNTIME_DIAGNOSTIC_KIND = runtimeDiagnosticCarrier.kind;
export const RUNTIME_DIAGNOSTIC_EVENTS = runtimeDiagnosticCarrier.events;
export const RUNTIME_DIAGNOSTIC_RESERVED_KINDS = [RUNTIME_DIAGNOSTIC_KIND.HANDLER_MISSING] as const;
export const runtimeDiagnosticBoundaryContract = runtimeDiagnosticCarrier.boundaryContract;
export const runtimeDiagnosticSettlementContract = runtimeDiagnosticCarrier.settlementContract;
export const runtimeDiagnosticBoundaryPackage = runtimeDiagnosticCarrier.boundaryPackage;

/**
 * Preflight diagnostic sink for host-level diagnostic persistence before runtime layer is built.
 * @public
 */
export interface PreflightDiagnosticSink {
  readonly commit: (diagnostic: {
    readonly capabilityId?: string;
    readonly pass:
      | "name_unique"
      | "host_fact"
      | "peer_dag"
      | "config"
      | "secret"
      | "self_diagnostic"
      | "global_unique";
    readonly reason: string;
    readonly detail?: string;
  }) => Promise<void> | void;
}
