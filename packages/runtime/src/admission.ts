import { Context, Effect } from "effect";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type { LlmRoute } from "@agent-os/kernel/llm";
import type { SchemaContract } from "@agent-os/kernel/json-schema";
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
  readonly schemaContract: SchemaContract;
  readonly strategy: Strategy;
  readonly stimulus: Stimulus;
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

export class Admission extends Context.Tag("@agent-os/Admission")<
  Admission,
  {
    readonly attemptStructured: <O>(
      spec: AttemptSpec,
    ) => Effect.Effect<AttemptResult<O>, SqlError | JsonStringifyError>;
    readonly invalidate: (
      spec: InvalidateSpec,
    ) => Effect.Effect<{ readonly barrierId: number }, SqlError | JsonStringifyError>;
  }
>() {}
