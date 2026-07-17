import {
  parseInputRequestResumePayload,
  submitResumeDecisionFromInputRequestRef,
  type SubmitResumeDecision,
} from "@agent-os/core/runtime-protocol";
import type {
  AgUiInputRequestResumeBinding,
  AgUiRunAgentInput,
  AgUiSubmitDefaults,
} from "./ag-ui";

const singleResumeEntry = (
  resume: ReadonlyArray<NonNullable<AgUiRunAgentInput["resume"]>[number]>,
): NonNullable<AgUiRunAgentInput["resume"]>[number] | undefined => {
  if (resume.length === 0) return undefined;
  if (resume.length !== 1) {
    throw new TypeError("AG-UI resume input must contain exactly one resume entry");
  }
  return resume[0];
};

const inputRequestBindingFor = (
  bindings: ReadonlyArray<AgUiInputRequestResumeBinding> | undefined,
  interruptId: string,
): AgUiInputRequestResumeBinding => {
  const matches = (bindings ?? []).filter(
    (binding) => binding.request.ref.interruptId === interruptId,
  );
  if (matches.length !== 1) {
    throw new TypeError("AG-UI resume input has no unique runtime InputRequest binding");
  }
  return matches[0]!;
};

export const submitResumeForAgUiInput = (
  input: AgUiRunAgentInput,
  defaults: AgUiSubmitDefaults,
): SubmitResumeDecision | undefined => {
  const entry = singleResumeEntry(input.resume ?? []);
  if (entry === undefined) return defaults.resume;
  if (defaults.resume !== undefined) {
    throw new TypeError("AG-UI resume input cannot be combined with defaults.resume");
  }
  if (entry.status !== "resolved") {
    throw new TypeError(
      "AG-UI resume input must be resolved before it can become SubmitSpec.resume",
    );
  }
  const binding = inputRequestBindingFor(defaults.inputRequests, entry.interruptId);
  const parsed = parseInputRequestResumePayload(binding.request.kind, entry.payload);
  if (!parsed.ok) {
    throw new TypeError(`AG-UI resume input failed InputRequest contract: ${parsed.reason}`);
  }
  return submitResumeDecisionFromInputRequestRef(binding.request.ref, {
    decisionRef: binding.decisionRef,
    resume: parsed.resume,
  });
};
