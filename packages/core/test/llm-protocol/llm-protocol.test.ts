import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { ensureAgentSchema } from "@agent-os/core/agent-schema";
import { captureLive } from "@agent-os/core/live-edge";

import {
  canonicalLlmWireDescriptorJson,
  drainLlmStream,
  llmCallSnapshotFromResponse,
  LlmProviderContinuationMarkerSchema,
  llmSnapshotRequestFingerprint,
  llmWireDescriptorFingerprint,
  llmRouteMaterialRefs,
  llmStreamDeltaFrame,
  llmStreamTerminalFrame,
  markerFromProviderContinuation,
  replayLlmResponseFromSnapshot,
  textFromLlmOutputItems,
  validateProviderContinuationBinding,
  type LlmProviderContinuationBinding,
  type LlmRequest,
  type LlmResponse,
  type LlmWireDescriptor,
} from "../../src/llm-protocol/index";

const continuationBinding: LlmProviderContinuationBinding = {
  adapterId: "openai-chat-compatible@v1",
  adapterVersion: "v1",
  routeFingerprint: "route-v1",
  modelFingerprint: "model-v1",
  truthIdentityFingerprint: "tenant-a",
  sourceTurn: { id: 7, index: 0 },
  successorTurn: { id: 7, index: 1 },
};

describe("@agent-os/llm-protocol", () => {
  it("derives material refs from route material handles without provider vocabulary", () => {
    expect(llmRouteMaterialRefs({ endpointRef: "llm", credentialRef: "llm-key" })).toEqual([
      { kind: "endpoint", ref: "llm" },
      { kind: "credential", ref: "llm-key" },
    ]);
  });

  it("canonicalizes wire descriptors without header order sensitivity", () => {
    const left = canonicalLlmWireDescriptorJson({
      method: "POST",
      url: "https://llm.example/v1",
      headers: [
        ["x-z", "2"],
        ["x-a", "1"],
      ],
    });
    const right = canonicalLlmWireDescriptorJson({
      method: "POST",
      url: "https://llm.example/v1",
      headers: [
        ["x-a", "1"],
        ["x-z", "2"],
      ],
    });
    expect(left).toBe(right);
  });

  it("fingerprints only provider-neutral wire descriptor shape", () => {
    const descriptor: LlmWireDescriptor = {
      method: "POST" as const,
      url: "https://llm.example/v1",
      headers: [
        ["Authorization", "Bearer ${credential:llm-key}"],
        ["Content-Type", "application/json"],
      ],
      bodySchema: {
        type: "object" as const,
        properties: { model: { type: "string" as const } },
        required: ["model"],
        additionalProperties: true,
      },
    };
    expect(llmWireDescriptorFingerprint(descriptor)).toBe(
      `llm-wire-descriptor-v1:${canonicalLlmWireDescriptorJson(descriptor)}`,
    );
    expect(llmWireDescriptorFingerprint(descriptor)).toContain("authorization");
  });

  it("keeps distinct resolved wire bodies distinct without provider route fields", () => {
    const descriptor = (modelId: string): LlmWireDescriptor => ({
      method: "POST" as const,
      url: "https://llm.example/v1/chat",
      headers: [
        ["Authorization", "Bearer ${credential:primary}"],
        ["Content-Type", "application/json"],
      ],
      bodySchema: {
        type: "object" as const,
        properties: {
          model: { type: "string" as const, enum: [modelId] },
          messages: {
            type: "array" as const,
            items: { type: "object" as const, properties: {}, additionalProperties: true },
          },
        },
        required: ["model", "messages"],
        additionalProperties: true,
      },
    });
    expect(llmWireDescriptorFingerprint(descriptor("model-a"))).not.toBe(
      llmWireDescriptorFingerprint(descriptor("model-b")),
    );
  });

  it("snapshots an LLM call without route fields and replays the response", () => {
    const descriptor: LlmWireDescriptor = {
      method: "POST" as const,
      url: "https://llm.example/v1/chat",
      headers: [
        ["Content-Type", "application/json"],
        ["Authorization", "Bearer ${credential:primary}"],
      ],
      bodySchema: {
        type: "object" as const,
        properties: {
          model: { type: "string" as const, enum: ["model-a"] },
          messages: {
            type: "array" as const,
            items: { type: "object" as const, properties: {}, additionalProperties: true },
          },
        },
        required: ["model", "messages"],
        additionalProperties: true,
      },
    };
    const request: LlmRequest = {
      route: {
        kind: "test-route",
        endpointRef: "llm",
        credentialRef: "llm-key",
        modelId: "model-a",
      },
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a value.",
            parameters: ensureAgentSchema(Schema.Struct({ q: Schema.String })),
          },
        },
      ],
    };
    const response: LlmResponse = {
      items: [{ type: "message", text: "done" }],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    };

    const snapshot = llmCallSnapshotFromResponse({ wireDescriptor: descriptor, request, response });

    expect(snapshot.kind).toBe("llm.call");
    expect(snapshot.wireDescriptorFingerprint).toBe(llmWireDescriptorFingerprint(descriptor));
    expect(snapshot.requestFingerprint).toBe(llmSnapshotRequestFingerprint(snapshot.request));
    expect(snapshot.request).toMatchObject({
      messages: request.messages,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a value.",
            parameters: {
              type: "object",
              required: ["q"],
            },
          },
        },
      ],
    });
    expect(JSON.stringify(snapshot.request)).not.toContain("test-route");
    expect(JSON.stringify(snapshot.request)).not.toContain("parse");
    expect(replayLlmResponseFromSnapshot(snapshot)).toEqual(response);
  });

  it("records only the continuation marker in call snapshots", () => {
    const continuation = {
      kind: "live" as const,
      binding: continuationBinding,
      payload: captureLive({
        reasoning_content: "private-reasoning",
        encrypted_content: "private-encrypted-token",
      }),
    };
    const marker = markerFromProviderContinuation(continuation);
    const snapshot = llmCallSnapshotFromResponse({
      wireDescriptor: {
        method: "POST",
        url: "https://llm.example/v1/chat",
        headers: [["Content-Type", "application/json"]],
      },
      request: {
        route: { kind: "test-route" },
        messages: [{ role: "assistant", content: "", continuation }],
      },
      response: {
        items: [{ type: "message", text: "done" }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        continuation: { kind: "available", value: continuation },
      },
    });

    expect(snapshot.request.messages).toEqual([{ role: "assistant", content: "" }]);
    expect(snapshot.response.continuationMarker).toEqual(marker);
    expect(replayLlmResponseFromSnapshot(snapshot)).toEqual({
      items: [{ type: "message", text: "done" }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      continuation: { kind: "recorded", marker },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-reasoning");
    expect(JSON.stringify(snapshot)).not.toContain("private-encrypted-token");
  });

  it("roundtrips the positive continuation marker contract", () => {
    const marker = {
      required: true as const,
      binding: continuationBinding,
      sealedRef: "sealed/continuation-7-0",
    };
    const decoded = Schema.decodeUnknownSync(LlmProviderContinuationMarkerSchema)(
      JSON.parse(JSON.stringify(marker)),
    );

    expect(decoded).toEqual(marker);
  });

  it("rejects continuation reuse across every bound identity axis", () => {
    const mismatchCases: ReadonlyArray<readonly [LlmProviderContinuationBinding, string]> = [
      [{ ...continuationBinding, adapterId: "other-adapter" }, "adapter_mismatch"],
      [{ ...continuationBinding, routeFingerprint: "other-route" }, "route_mismatch"],
      [{ ...continuationBinding, modelFingerprint: "other-model" }, "model_mismatch"],
      [{ ...continuationBinding, truthIdentityFingerprint: "tenant-b" }, "truth_identity_mismatch"],
      [{ ...continuationBinding, sourceTurn: { id: 7, index: 2 } }, "source_turn_mismatch"],
      [{ ...continuationBinding, successorTurn: { id: 7, index: 2 } }, "successor_turn_mismatch"],
    ];

    for (const [actual, reason] of mismatchCases) {
      expect(validateProviderContinuationBinding(actual, continuationBinding)?.reason).toBe(reason);
    }
    expect(
      validateProviderContinuationBinding(continuationBinding, continuationBinding),
    ).toBeNull();
  });

  it("replay mode live LLM provider adapter not called when call snapshot is present", () => {
    let liveLlmProviderAdapterCalled = false;
    const liveProviderAdapter = {
      call: () => {
        liveLlmProviderAdapterCalled = true;
        throw new Error("live LLM provider adapter should not be called in replay");
      },
    };
    const replayed = replayLlmResponseFromSnapshot({
      kind: "llm.call",
      wireDescriptor: {
        method: "POST",
        url: "https://llm.example/v1/chat",
        headers: [["Content-Type", "application/json"]],
      },
      wireDescriptorFingerprint: "llm-wire-descriptor-v1:{}",
      request: { messages: [{ role: "user", content: "hello" }] },
      requestFingerprint: "llm-call-snapshot-v1:request:{}",
      response: {
        items: [{ type: "message", text: "from-snapshot" }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });

    expect(replayed.items).toEqual([{ type: "message", text: "from-snapshot" }]);
    expect(liveLlmProviderAdapterCalled).toBe(false);
    expect(liveProviderAdapter.call).toBeDefined();
  });

  it("projects message text from output items", () => {
    expect(
      textFromLlmOutputItems([
        { type: "message", text: "a" },
        { type: "reasoning", summaryRef: "s" },
        { type: "message", text: "b" },
      ]),
    ).toBe("ab");
  });

  it.effect("drains one ordered stream to its sole terminal response", () =>
    Effect.gen(function* () {
      const response: LlmResponse = {
        items: [{ type: "message", text: "done" }],
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      };
      const terminal = yield* llmStreamTerminalFrame(3, response);
      const drained = yield* drainLlmStream(
        Stream.fromIterable([
          llmStreamDeltaFrame(0, { type: "text_start", id: "text-1" }),
          llmStreamDeltaFrame(1, { type: "text_delta", id: "text-1", text: "done" }),
          llmStreamDeltaFrame(2, { type: "text_end", id: "text-1" }),
          terminal,
        ]),
      );
      expect(drained).toEqual(response);
    }),
  );

  it.effect("rejects sequence gaps and close-before-terminal", () =>
    Effect.gen(function* () {
      let observed = 0;
      const gap = yield* Effect.result(
        drainLlmStream(
          Stream.fromIterable([
            llmStreamDeltaFrame(1, { type: "text_delta", id: "text-1", text: "x" }),
          ]),
          () =>
            Effect.sync(() => {
              observed += 1;
            }),
        ),
      );
      const incomplete = yield* Effect.result(
        drainLlmStream(
          Stream.fromIterable([
            llmStreamDeltaFrame(0, { type: "text_delta", id: "text-1", text: "x" }),
          ]),
        ),
      );
      expect(gap._tag).toBe("Failure");
      expect(observed).toBe(0);
      expect(incomplete._tag).toBe("Failure");
    }),
  );
});
