import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { defineCarrier, event, indeterminate, lived, none, pre, rejected } from "../src/carrier";
import { makePreClaim } from "../src/effect-claim";

const claim = makePreClaim({
  operationRef: "example:op",
  scopeRef: { kind: "conversation", scopeId: "thread:1" },
  effectAuthorityRef: { authorityId: "example.record", authorityClass: "effect" },
  originRef: { originId: "example", originKind: "test" },
});

const exampleCarrier = () =>
  defineCarrier({
    ownerId: "@agent-os/example-carrier",
    sourcePackageName: "@agent-os/example-carrier",
    prefix: "example.",
    roles: ["generator", "reader"],
    events: {
      requested: event({
        kind: "requested",
        payload: Schema.Struct({
          subjectRef: Schema.String,
        }),
        claim: pre({ key: "claim" }),
      }),
      decided: event({
        kind: "decided",
        payload: Schema.Struct({
          subjectRef: Schema.String,
          decision: Schema.Literals(["approved", "rejected"]),
        }),
        claim: none(),
      }),
      consumed: event({
        kind: "consumed",
        payload: Schema.Struct({
          subjectRef: Schema.String,
        }),
        claim: lived({ key: "claim", anchorKinds: ["ledger_event"] }),
      }),
      failed: event({
        kind: "failed",
        payload: Schema.Struct({
          subjectRef: Schema.String,
        }),
        claim: rejected({ key: "claim", rejectionKinds: ["policy_denied"] }),
      }),
      pending: event({
        kind: "pending",
        payload: Schema.Struct({
          subjectRef: Schema.String,
        }),
        claim: indeterminate({ key: "claim", indeterminateKinds: ["provider_pending"] }),
      }),
    },
  });

describe("defineCarrier", () => {
  it("derives event kinds, boundary events, and settlement vocabulary", () => {
    const carrier = exampleCarrier();

    expect(carrier.kind.REQUESTED).toBe("example.requested");
    expect(carrier.kind.DECIDED).toBe("example.decided");
    expect(Object.keys(carrier.boundaryContract.events)).toEqual([
      "example.requested",
      "example.decided",
      "example.consumed",
      "example.failed",
      "example.pending",
    ]);
    expect(carrier.boundaryContract.events["example.decided"]?.claim).toBeUndefined();
    expect(carrier.boundaryContract.events["example.requested"]?.claim).toEqual({
      key: "claim",
      phase: "pre",
    });
    expect(carrier.settlementContract.anchorKinds).toEqual(["ledger_event"]);
    expect(carrier.settlementContract.rejectionKinds).toEqual(["policy_denied"]);
    expect(carrier.settlementContract.indeterminateKinds).toEqual(["provider_pending"]);
    expect("projection" in carrier).toBe(false);
  });

  it("decodes none, pre, lived, and rejected claim slots", () => {
    const carrier = exampleCarrier();
    const livedClaim = carrier.settle.consumed(claim, {
      anchorId: "event:1",
      carrierRef: "example:carrier",
    });
    const rejectedClaim = carrier.reject.failed(claim, {
      rejectionId: "policy:1",
      reason: "policy_denied",
    });
    const indeterminateClaim = carrier.indeterminate.pending(claim, {
      indeterminateId: "pending:1",
      reason: "provider_pending",
    });

    expect(
      carrier.decode("example.decided", {
        subjectRef: "subject:1",
        decision: "approved",
      }),
    ).toEqual({
      subjectRef: "subject:1",
      decision: "approved",
    });
    expect(
      carrier.decode("example.requested", {
        subjectRef: "subject:1",
        claim,
      }),
    ).toEqual({
      subjectRef: "subject:1",
      claim,
    });
    expect(
      carrier.decode("example.consumed", {
        subjectRef: "subject:1",
        claim: livedClaim,
      }),
    ).toEqual({
      subjectRef: "subject:1",
      claim: livedClaim,
    });
    expect(
      carrier.decode("example.failed", {
        subjectRef: "subject:1",
        claim: rejectedClaim,
      }),
    ).toEqual({
      subjectRef: "subject:1",
      claim: rejectedClaim,
    });
    expect(
      carrier.decode("example.pending", {
        subjectRef: "subject:1",
        claim: indeterminateClaim,
      }),
    ).toEqual({
      subjectRef: "subject:1",
      claim: indeterminateClaim,
    });
  });

  it("rejects invalid event payloads and claim slots", () => {
    const carrier = exampleCarrier();
    const livedClaim = carrier.settle.consumed(claim, {
      anchorId: "event:1",
    });

    expect(() => carrier.decode("example.decided", { subjectRef: "subject:1" })).toThrow(
      /payload violates schema/,
    );
    expect(() => carrier.decode("example.requested", { subjectRef: "subject:1" })).toThrow(
      /missing claim slot/,
    );
    expect(() =>
      carrier.decode("example.requested", {
        subjectRef: "subject:1",
        claim: livedClaim,
      }),
    ).toThrow(/has phase lived/);
  });

  it("rejects terminal claims outside the event-local slot vocabulary", () => {
    const carrier = defineCarrier({
      ownerId: "@agent-os/slot-vocab",
      sourcePackageName: "@agent-os/slot-vocab",
      prefix: "slot.",
      roles: ["generator", "reader"],
      events: {
        ledgered: event({
          kind: "ledgered",
          payload: Schema.Struct({ subjectRef: Schema.String }),
          claim: lived({ key: "claim", anchorKinds: ["ledger_event"] }),
        }),
        proved: event({
          kind: "proved",
          payload: Schema.Struct({ subjectRef: Schema.String }),
          claim: lived({ key: "claim", anchorKinds: ["carrier_proof"] }),
        }),
        denied: event({
          kind: "denied",
          payload: Schema.Struct({ subjectRef: Schema.String }),
          claim: rejected({ key: "claim", rejectionKinds: ["policy_denied"] }),
        }),
        failed: event({
          kind: "failed",
          payload: Schema.Struct({ subjectRef: Schema.String }),
          claim: rejected({ key: "claim", rejectionKinds: ["provider_rejected"] }),
        }),
        providerPending: event({
          kind: "provider-pending",
          payload: Schema.Struct({ subjectRef: Schema.String }),
          claim: indeterminate({ key: "claim", indeterminateKinds: ["provider_pending"] }),
        }),
        reconcileRequired: event({
          kind: "reconcile-required",
          payload: Schema.Struct({ subjectRef: Schema.String }),
          claim: indeterminate({ key: "claim", indeterminateKinds: ["reconcile_required"] }),
        }),
      },
    });

    const carrierProofClaim = carrier.settle.proved(claim, { anchorId: "proof:1" });
    const providerRejectedClaim = carrier.reject.failed(claim, {
      rejectionId: "provider:1",
      reason: "provider_rejected",
    });
    const reconcileRequiredClaim = carrier.indeterminate.reconcileRequired(claim, {
      indeterminateId: "reconcile:1",
    });

    expect(() =>
      carrier.decode("slot.ledgered", {
        subjectRef: "subject:1",
        claim: carrierProofClaim,
      }),
    ).toThrow(/outside event vocabulary/);
    expect(() =>
      carrier.decode("slot.denied", {
        subjectRef: "subject:1",
        claim: providerRejectedClaim,
      }),
    ).toThrow(/outside event vocabulary/);
    expect(() =>
      carrier.decode("slot.provider-pending", {
        subjectRef: "subject:1",
        claim: reconcileRequiredClaim,
      }),
    ).toThrow(/outside event vocabulary/);
  });

  it("rejects duplicate event kinds and claim slot schema collisions at construction", () => {
    expect(() =>
      defineCarrier({
        ownerId: "@agent-os/duplicate",
        sourcePackageName: "@agent-os/duplicate",
        prefix: "duplicate.",
        roles: ["reader"],
        events: {
          one: event({
            kind: "same",
            payload: Schema.Struct({ value: Schema.String }),
            claim: none(),
          }),
          two: event({
            kind: "same",
            payload: Schema.Struct({ value: Schema.String }),
            claim: none(),
          }),
        },
      }),
    ).toThrow(/duplicate carrier event kind/);

    expect(() =>
      defineCarrier({
        ownerId: "@agent-os/collision",
        sourcePackageName: "@agent-os/collision",
        prefix: "collision.",
        roles: ["reader"],
        events: {
          recorded: event({
            kind: "recorded",
            payload: Schema.Struct({ claim: Schema.String }),
            claim: lived({ key: "claim", anchorKinds: ["ledger_event"] }),
          }),
        },
      }),
    ).toThrow(/payload schema declares claim slot/);
  });

  it("rejects unsupported Effect Schema output at definition time", () => {
    expect(() =>
      defineCarrier({
        ownerId: "@agent-os/unsupported",
        sourcePackageName: "@agent-os/unsupported",
        prefix: "unsupported.",
        roles: ["reader"],
        events: {
          recorded: event({
            kind: "recorded",
            payload: Schema.Struct({
              value: Schema.Record(Schema.String, Schema.Unknown),
            }),
            claim: none(),
          }),
        },
      }),
    ).toThrow(/index-signature-unsupported/);
  });

  it("types terminal constructors only on matching claim slots", () => {
    const carrier = exampleCarrier();

    carrier.settle.consumed(claim, { anchorId: "event:1" });
    carrier.reject.failed(claim, { rejectionId: "policy:1" });
    carrier.indeterminate.pending(claim, { indeterminateId: "pending:1" });
    const assertTypeErrors = () => {
      // @ts-expect-error none events do not expose lived constructors.
      const noDecidedSettle = carrier.settle.decided;
      // @ts-expect-error pre events do not expose rejected constructors.
      const noRequestedReject = carrier.reject.requested;
      // @ts-expect-error terminal events do not expose indeterminate constructors.
      const noConsumedIndeterminate = carrier.indeterminate.consumed;
      // @ts-expect-error unknown handler keys are rejected.
      const noUnknownHandler = carrier.handlers({ unknown: () => undefined });
      return [noDecidedSettle, noRequestedReject, noConsumedIndeterminate, noUnknownHandler];
    };
    expect(typeof assertTypeErrors).toBe("function");
  });
});
