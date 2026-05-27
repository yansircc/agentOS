import { describe, expect, it } from "vite-plus/test";

import {
  makeOperationRef,
  makePreClaim,
  scopeRefFromLegacyScope,
  settleLivedClaim,
  settleRejectedClaim,
  validateEffectClaim,
} from "../src/effect-claim";

describe("EffectClaim calculus", () => {
  const pre = makePreClaim({
    operationRef: makeOperationRef("dispatch", ["source/a", "peer", "thread/t1", "intent 1"]),
    scopeRef: { kind: "conversation", scopeId: "thread/t1" },
    authorityRef: {
      authorityId: "cap_dispatch",
      authorityClass: "effect",
    },
    originRef: {
      originId: "source/a",
      originKind: "agent_do",
    },
  });

  it("canonicalizes operation refs without using trace coordinates", () => {
    expect(pre.operationRef).toBe("dispatch:source%2Fa:peer:thread%2Ft1:intent%201");
  });

  it("keeps terminal phase in the type instead of optional anchor state", () => {
    expect(validateEffectClaim(pre)).toEqual({ ok: true, claim: pre });
    expect(
      validateEffectClaim({
        ...pre,
        anchorRef: {
          anchorId: "1",
          anchorKind: "ledger_event",
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["pre_claim_has_terminal_ref"],
    });
  });

  it("settles lived and rejected claims as disjoint terminal states", () => {
    const lived = settleLivedClaim(pre, {
      anchorId: "thread/t1:7",
      anchorKind: "ledger_event",
      carrierRef: "dispatch:peer",
    });
    const rejected = settleRejectedClaim(pre, {
      rejectionId: "policy/1",
      rejectionKind: "policy_denied",
    });

    expect(validateEffectClaim(lived)).toEqual({ ok: true, claim: lived });
    expect(validateEffectClaim(rejected)).toEqual({
      ok: true,
      claim: rejected,
    });
    expect(
      validateEffectClaim({
        ...lived,
        rejectionRef: rejected.rejectionRef,
      }),
    ).toEqual({
      ok: false,
      issues: ["lived_claim_has_rejection"],
    });
  });

  it("maps legacy scope strings into the five typed ScopeRef kinds", () => {
    expect(scopeRefFromLegacyScope("user/u1")).toEqual({
      kind: "realm",
      scopeId: "user/u1",
    });
    expect(scopeRefFromLegacyScope("org/o1")).toEqual({
      kind: "realm",
      scopeId: "org/o1",
    });
    expect(scopeRefFromLegacyScope("thread/t1")).toEqual({
      kind: "conversation",
      scopeId: "thread/t1",
    });
    expect(scopeRefFromLegacyScope("session/s1")).toEqual({
      kind: "session",
      scopeId: "session/s1",
    });
    expect(scopeRefFromLegacyScope("wp/plugin@example.com")).toEqual({
      kind: "external",
      scopeId: "wp/plugin@example.com",
      systemRef: "wordpress",
    });
    expect(scopeRefFromLegacyScope("agent/name/item")).toBeNull();
    expect(scopeRefFromLegacyScope("custom-scope")).toBeNull();
  });

  it("rejects nullable scope/session and missing external systemRef shapes", () => {
    expect(
      validateEffectClaim({
        ...pre,
        scopeRef: {
          kind: "external",
          scopeId: "site/acme",
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["scope_ref_invalid"],
    });
    expect(
      validateEffectClaim({
        ...pre,
        scopeRef: {
          kind: "session",
          scopeId: "session/s1",
          sessionId: "shadow",
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["scope_ref_invalid"],
    });
  });

  it("rejects retention policy as ScopeRef kind or inline scope state", () => {
    for (const kind of ["ephemeral", "persistent"]) {
      expect(
        validateEffectClaim({
          ...pre,
          scopeRef: {
            kind,
            scopeId: "session/s1",
          },
        }),
      ).toEqual({
        ok: false,
        issues: ["scope_ref_invalid"],
      });
    }

    expect(
      validateEffectClaim({
        ...pre,
        scopeRef: {
          kind: "session",
          scopeId: "session/s1",
          retention: "persistent",
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["scope_ref_invalid"],
    });
  });
});
