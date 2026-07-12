import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { cloudflareDefaultTruthIdentityFromRoutingScope } from "../../src/cloudflare/ledger/identity";

describe("Cloudflare submit-scope identity", () => {
  it.effect("derives scope and authority from the authenticated routing scope", () =>
    Effect.sync(() => {
      expect(cloudflareDefaultTruthIdentityFromRoutingScope("installation-42", "session")).toEqual({
        scopeRef: { kind: "session", scopeId: "installation-42" },
        effectAuthorityRef: { authorityClass: "effect", authorityId: "installation-42" },
      });
    }),
  );
});
