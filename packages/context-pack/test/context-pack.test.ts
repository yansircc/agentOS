import { buildContextPack, type ContextFact } from "../src";

const facts: ReadonlyArray<ContextFact> = [
  {
    ref: "ledger/run",
    kind: "ledger",
    priority: 10,
    tokenCount: 4,
    text: "run delivered",
  },
  {
    ref: "secret/fact",
    kind: "transcript",
    priority: 8,
    tokenCount: 5,
    text: "api key sk-123 should not leak",
    redactions: [{ start: 8, end: 14, label: "secret" }],
  },
  {
    ref: "artifact/large",
    kind: "artifact",
    priority: 1,
    tokenCount: 20,
    text: "large artifact",
  },
];

describe("@agent-os/context-pack", () => {
  it("packs facts deterministically by priority and records included refs", () => {
    expect(buildContextPack(facts).text).toBe(
      "run delivered\n\napi key [redacted:secret] should not leak\n\nlarge artifact",
    );
    expect(buildContextPack(facts).includedRefs).toEqual([
      "ledger/run",
      "secret/fact",
      "artifact/large",
    ]);
  });

  it("applies explicit span redaction without pattern heuristics", () => {
    const pack = buildContextPack([facts[1] as ContextFact]);

    expect(pack.items[0]?.text).toBe("api key [redacted:secret] should not leak");
    expect(pack.text).not.toContain("sk-123");
  });

  it("reports exact omission reasons for kind and budget filters", () => {
    const pack = buildContextPack(facts, {
      includeKinds: ["ledger", "transcript", "artifact"],
      excludeKinds: ["artifact"],
      maxItems: 1,
    });

    expect(pack.includedRefs).toEqual(["ledger/run"]);
    expect(pack.omittedRefs).toEqual([
      { ref: "secret/fact", reason: "item_budget" },
      { ref: "artifact/large", reason: "kind_excluded" },
    ]);
  });

  it("does not estimate missing token counts when a token budget is requested", () => {
    const pack = buildContextPack(
      [
        { ref: "with/tokens", kind: "ledger", tokenCount: 5, text: "known" },
        { ref: "without/tokens", kind: "ledger", text: "unknown" },
      ],
      { maxTokens: 10 },
    );

    expect(pack.includedRefs).toEqual(["with/tokens"]);
    expect(pack.omittedRefs).toEqual([{ ref: "without/tokens", reason: "missing_token_count" }]);
    expect(pack.stats).toEqual({ itemCount: 1, charCount: 5, tokenCount: 5 });
  });

  it("rejects invalid redaction spans instead of emitting partial text", () => {
    const pack = buildContextPack([
      {
        ref: "bad/redaction",
        kind: "transcript",
        text: "short",
        redactions: [{ start: 0, end: 100, label: "bad" }],
      },
    ]);

    expect(pack.items).toEqual([]);
    expect(pack.omittedRefs).toEqual([{ ref: "bad/redaction", reason: "invalid_redaction" }]);
  });
});
