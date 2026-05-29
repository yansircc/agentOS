import { describe, expect, it } from "vite-plus/test";

import { makeOperationRef, makePreClaim, validateEffectClaim } from "../src/effect-claim";

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
    const lived = {
      ...pre,
      phase: "lived" as const,
      anchorRef: {
        anchorId: "thread/t1:7",
        anchorKind: "ledger_event" as const,
        carrierRef: "dispatch:peer",
      },
    };
    const rejected = {
      ...pre,
      phase: "rejected" as const,
      rejectionRef: {
        rejectionId: "policy/1",
        rejectionKind: "policy_denied" as const,
      },
    };

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
