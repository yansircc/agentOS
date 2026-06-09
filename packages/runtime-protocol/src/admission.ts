import type { AgentSchemaSpec } from "@agent-os/kernel/agent-schema";
import type { LlmRoute } from "@agent-os/llm-protocol";
import type { TraceContext } from "@agent-os/telemetry-protocol";
import type {
  AdmissionImpact,
  AttemptKey,
  CapabilityLease,
  Outcome,
  Strategy,
} from "./admission-lease";

export * from "./admission-fingerprint";
export * from "./admission-lease";

export type ProbeInput = { readonly synthetic: unknown };
export type LiveInput = { readonly userText: string };

export type Stimulus =
  | { readonly kind: "probe"; readonly synthetic: ProbeInput }
  | {
      readonly kind: "live";
      readonly userInput: LiveInput;
    };

export type DecodedOutput = Record<string, unknown>;

export type AttemptSpec = {
  readonly scope: string;
  readonly route: LlmRoute;
  readonly schemaSpec: AgentSchemaSpec;
  readonly strategy: Strategy;
  readonly stimulus: Stimulus;
  readonly traceContext?: TraceContext;
  readonly signal?: AbortSignal;
};

export type AttemptResult<O> =
  | {
      readonly ok: true;
      readonly decoded: O;
      readonly outcome: Outcome;
      readonly lease: CapabilityLease;
      readonly admissionImpact: AdmissionImpact;
      readonly shortCircuited: false;
    }
  | {
      readonly ok: false;
      readonly outcome: Outcome;
      readonly lease: CapabilityLease;
      readonly admissionImpact: AdmissionImpact;
      readonly shortCircuited: boolean;
    };

export type InvalidateSpec = {
  readonly scope: string;
  readonly key: Partial<AttemptKey>;
  readonly reason: string;
  readonly by: string;
};
