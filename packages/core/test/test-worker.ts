/**
 * Test worker entry — exposes two DO classes:
 *
 *   TestAgentDO  — raw DurableObject. Quota contract tests bypass
 *                  AgentDOBase entirely and compose Layers manually inside
 *                  runInDurableObject(stub, (instance, state) => { ... })
 *                  so they can stub the AiBinding deterministically.
 *
 *   EmitTestDO   — extends AgentDOBase. emitEvent contract tests exercise
 *                  the public surface directly (stub.emitEvent(...)) and
 *                  verify the reactive triad: now-write commits a ledger
 *                  row AND fires registered on() handlers in the same DO
 *                  invocation. The constructor wires one handler whose
 *                  side-effect is itself an emitEvent — proving handler →
 *                  handler chaining via the ledger.
 *
 *   DispatchTestDO — extends AgentDOBase. dispatch contract tests use it
 *                    on both sender and receiver sides to validate
 *                    cross-scope delivery without app-level RPC.
 *
 *   StreamTestDO — extends AgentDOBase. event-stream contract tests use it
 *                  to validate streamEvents, events(opts), and worker-layer
 *                  Last-Event-ID parsing.
 *
 * The fetch handler exists only to satisfy the Workers runtime
 * requirement that a worker has a default export.
 */

import { DurableObject } from "cloudflare:workers";
import {
  AgentDOBase,
  type AgentDOEnv,
  type DispatchTargetNamespace,
  type DispatchTargetRegistry,
  type LedgerEventRpc,
  type LlmRoute,
  type ProviderRegistryConfig,
} from "../src";

export class TestAgentDO extends DurableObject {}

export class EmitTestDO extends AgentDOBase<AgentDOEnv> {
  constructor(ctx: DurableObjectState, env: AgentDOEnv) {
    super(ctx, env);
    // Chain validation: emitting "interview.answer" triggers a handler
    // that emits "interview.followup". The contract test asserts both
    // rows appear in the ledger after one external emitEvent call.
    this.on("interview.answer", (event) =>
      this.emitEvent({
        event: "interview.followup",
        data: { sourceId: event.id, sourcePayload: event.payload },
      }).then(() => undefined),
    );
  }
}

interface DispatchEnv extends AgentDOEnv {
  readonly DISPATCH_DO: DurableObjectNamespace<DispatchTestDO>;
}

const DEAD_TARGET: DispatchTargetNamespace = {
  idFromName: (_name) => ({}) as DurableObjectId,
  get: (_id) => ({
    __agentosReceiveDispatch: () => Promise.reject("dead dispatch target"),
  }),
};

export class DispatchTestDO extends AgentDOBase<DispatchEnv> {
  constructor(ctx: DurableObjectState, env: DispatchEnv) {
    super(ctx, env);
    this.on("dispatch.inbound.accepted", () =>
      this.emitEvent({
        event: "dispatch.inbound.handler_fired",
        data: {},
      }).then(() => undefined),
    );
    this.on("test.delivered", (event) =>
      this.emitEvent({
        event: "test.followup",
        data: { sourceId: event.id, sourcePayload: event.payload },
      }).then(() => undefined),
    );
  }

  protected override provideDispatchTargets(): DispatchTargetRegistry {
    return {
      peer: this.env.DISPATCH_DO,
      dead: DEAD_TARGET,
    };
  }
}

export class StreamTestDO extends AgentDOBase<AgentDOEnv> {
  constructor(ctx: DurableObjectState, env: AgentDOEnv) {
    super(ctx, env);
    this.on("stream.slow", () => scheduler.wait(1_000));
  }
}

interface TextStreamEnv extends AgentDOEnv {
  readonly TEXT_STREAM_KEY?: string;
}

const openAiTextStreamRoute = {
  kind: "openai-chat-compatible",
  endpointRef: "openai-text-stream-endpoint",
  credentialRef: "TEXT_STREAM_KEY",
  modelId: "text-stream-model",
} satisfies LlmRoute;

export class TextStreamTestDO extends AgentDOBase<TextStreamEnv> {
  protected override provideRegistry(): ProviderRegistryConfig {
    return {
      endpoints: {
        "openai-text-stream-endpoint": "https://text-stream.test/v1",
        "anthropic-text-stream-endpoint": "https://anthropic-stream.test",
        "gemini-text-stream-endpoint": "https://gemini-stream.test",
      },
      credentials: { TEXT_STREAM_KEY: this.env.TEXT_STREAM_KEY ?? "test-key" },
    };
  }

  submitText(): Response {
    return this.submitTextStream({
      intent: "Stream a greeting.",
      context: { source: "contract" },
      route: openAiTextStreamRoute,
      deliver: { event: "text.done" },
    });
  }

  submitAnthropicText(): Response {
    return this.submitTextStream({
      intent: "Stream a greeting through Anthropic.",
      context: { source: "contract" },
      route: {
        kind: "anthropic-messages",
        endpointRef: "anthropic-text-stream-endpoint",
        credentialRef: "TEXT_STREAM_KEY",
        modelId: "claude-test",
      },
      deliver: { event: "text.done" },
    });
  }

  submitGeminiText(): Response {
    return this.submitTextStream({
      intent: "Stream a greeting through Gemini.",
      context: { source: "contract" },
      route: {
        kind: "gemini-generate-content",
        endpointRef: "gemini-text-stream-endpoint",
        credentialRef: "TEXT_STREAM_KEY",
        modelId: "gemini-test",
      },
      deliver: { event: "text.done" },
    });
  }

  async cancelTextAfterFirstChunkForTest(): Promise<LedgerEventRpc[]> {
    const response = this.submitText();
    if (response.body === null) throw new Error("missing stream body");
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();

    const deadline = Date.now() + 1_000;
    let rows: LedgerEventRpc[] = [];
    while (Date.now() < deadline) {
      rows = await this.events();
      if (rows.some((row) => row.kind === "agent.aborted.client_disconnect")) {
        return rows;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return rows;
  }
}

interface WorkerEnv extends AgentDOEnv {
  readonly STREAM_DO: DurableObjectNamespace<StreamTestDO>;
  readonly TEXT_STREAM_DO: DurableObjectNamespace<TextStreamTestDO>;
}

const parseLastEventId = (value: string | null): number => {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/stream\/([^/]+)$/);
    if (match !== null) {
      const scope = decodeURIComponent(match[1] ?? "");
      const stub = env.STREAM_DO.get(env.STREAM_DO.idFromName(scope));
      return stub.streamEvents({
        afterId: parseLastEventId(req.headers.get("Last-Event-ID")),
      });
    }
    const textStreamMatch = url.pathname.match(/^\/text-stream\/([^/]+)$/);
    if (textStreamMatch !== null) {
      const scope = decodeURIComponent(textStreamMatch[1] ?? "");
      const stub = env.TEXT_STREAM_DO.get(
        env.TEXT_STREAM_DO.idFromName(scope),
      );
      return stub.submitText();
    }
    return new Response("@agent-os/core test worker (not for direct use)");
  },
};
