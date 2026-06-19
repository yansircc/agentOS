import { describe, expect, it } from "@effect/vitest";
import {
  ProviderHttpFailure,
  ProviderOutputDecodeError,
  UpstreamFailure,
} from "@agent-os/kernel/errors";

import {
  classifyStructuredCallFailure,
  type StructuredCallFailureClassification,
} from "../src/structured-output";
import { publicRuntimeCauseReason } from "../src/failure-classification";

const expectRecordEvidence = (
  classification: StructuredCallFailureClassification,
): Exclude<StructuredCallFailureClassification, { readonly kind: "fail_before_evidence" }> => {
  expect(classification.kind).toBe("record_evidence");
  if (classification.kind !== "record_evidence") {
    throw new Error("expected record_evidence classification");
  }
  return classification;
};

describe("structured output failure classification", () => {
  it("records symbolic external failure facts instead of raw thrown messages", () => {
    const error = new Error("api key sk-live-secret leaked by provider body");
    const classification = expectRecordEvidence(
      classifyStructuredCallFailure(new UpstreamFailure({ cause: error })),
    );

    expect(classification.outcome).toEqual({
      class: "TransientError",
      cause: "Error",
    });
    expect(JSON.stringify(classification.outcome)).not.toContain("sk-live-secret");
    expect(JSON.stringify(classification.outcome)).not.toContain("provider body");
  });

  it("classifies provider http failures without recording provider code or body text", () => {
    const failure = new ProviderHttpFailure({
      provider: "openrouter",
      status: 400,
      code: "invalid_request_sk-live-secret",
      type: "body-contained-secret",
      flags: ["schema"],
    });
    const classification = expectRecordEvidence(
      classifyStructuredCallFailure(new UpstreamFailure({ cause: failure })),
    );

    expect(classification.outcome).toEqual({
      class: "SchemaUnsupported",
      reason: "provider_http_failure:openrouter:http_400:schema",
    });
    expect(JSON.stringify(classification.outcome)).not.toContain("sk-live-secret");
    expect(JSON.stringify(classification.outcome)).not.toContain("body-contained-secret");
  });

  it("keeps provider output decode failures out of admission evidence", () => {
    const failure = new UpstreamFailure({
      cause: new ProviderOutputDecodeError({
        field: "usage",
        reason: "missing_or_invalid_usage",
      }),
    });

    expect(classifyStructuredCallFailure(failure)).toEqual({
      kind: "fail_before_evidence",
      failure,
    });
  });

  it("uses the same public runtime cause classifier for tool and structured paths", () => {
    expect(publicRuntimeCauseReason("secret raw string")).toBe("string");
    expect(publicRuntimeCauseReason({ _tag: "runtime.symbolic_tag" })).toBe("runtime.symbolic_tag");
    expect(publicRuntimeCauseReason({ reason: "not symbolic because it has spaces" })).toBe(
      "object",
    );
  });
});
