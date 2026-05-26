/**
 * submitTextStream — text-only streaming submit.
 *
 * Token deltas are ephemeral SSE frames. The ledger SSoT is still the final
 * turn: chat.ingested -> llm.response -> deliver event. No tools, no
 * outputSchema, no token rows.
 *
 * Spec: docs/specs/spec-31-text-streaming-capability.md
 */

import { Effect } from "effect";
import {
  ABORT,
  JsonStringifyError,
  SqlError,
  UpstreamFailure,
} from "./errors";
import {
  AiBinding,
  dispatchProviderStream,
  type LlmRoute,
  type LlmUsage,
} from "./llm";
import { getProtocolAdapter } from "./llm/protocol/protocol-adapter";
import { Ledger } from "./ledger";
import {
  CredentialNotFound,
  EndpointNotFound,
  ProviderRegistry,
} from "./provider-registry";
import {
  buildInitialMessages,
  turnRefOf,
  type TurnRef,
} from "./submit-agent";

export interface SubmitTextStreamSpec {
  readonly intent: string;
  readonly context: Record<string, unknown>;
  readonly system?: string;
  readonly route: LlmRoute;
  readonly deliver: { readonly event: string };
}

export interface InternalSubmitTextStreamSpec
  extends Omit<SubmitTextStreamSpec, "deliver"> {
  readonly deliver: { readonly scope: string; readonly event: string };
}

export type SubmitTextStreamFrame =
  | { readonly event: "token"; readonly data: { readonly delta: string } }
  | { readonly event: "usage"; readonly data: LlmUsage }
  | {
      readonly event: "done";
      readonly data: {
        readonly turnId: number;
        readonly llmResponseId: number;
        readonly deliveredId: number;
      };
    }
  | {
      readonly event: "aborted";
      readonly data: {
        readonly turnId: number;
        readonly code:
          | "client_disconnect"
          | "upstream_failure"
          | "unsupported";
        readonly reason: string;
      };
    };

export type SubmitTextStreamEmit = (frame: SubmitTextStreamFrame) => void;
export type SubmitTextStreamTurnId = (turnId: number) => void;

const zeroUsage: LlmUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

const reasonText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const logAbort = (
  kind: typeof ABORT.CLIENT_DISCONNECT | typeof ABORT.UPSTREAM_FAILURE,
  scope: string,
  turnId: number,
  payload: object,
): Effect.Effect<void, SqlError | JsonStringifyError, Ledger> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    yield* ledger.log(kind, { turnId, ...payload }, scope);
  });

export const logTextStreamClientDisconnectEffect = (
  scope: string,
  turnId: number,
  reason: string,
): Effect.Effect<void, SqlError | JsonStringifyError, Ledger> =>
  logAbort(ABORT.CLIENT_DISCONNECT, scope, turnId, { reason });

export const submitTextStreamEffect = (
  spec: InternalSubmitTextStreamSpec,
  signal: AbortSignal,
  emit: SubmitTextStreamEmit,
  onTurnId: SubmitTextStreamTurnId = () => undefined,
): Effect.Effect<
  void,
  SqlError | JsonStringifyError | EndpointNotFound | CredentialNotFound,
  Ledger | AiBinding | ProviderRegistry
> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const scope = spec.deliver.scope;
    const ingest = yield* ledger.log(
      "chat.ingested",
      { intent: spec.intent, context: spec.context },
      scope,
    );
    const turn: TurnRef = turnRefOf(ingest.id, 0);
    yield* Effect.sync(() => onTurnId(turn.id));

    if (signal.aborted) {
      return;
    }

    const adapter = getProtocolAdapter(spec.route.kind);
    const textStream = adapter.textStream;
    if (textStream.supported === false) {
      yield* logAbort(ABORT.UPSTREAM_FAILURE, scope, turn.id, {
        reason: "text_stream_unsupported",
        routeKind: spec.route.kind,
        detail: textStream.reason,
      });
      yield* Effect.sync(() =>
        emit({
          event: "aborted",
          data: {
            turnId: turn.id,
            code: "unsupported",
            reason: textStream.reason,
          },
        }),
      );
      return;
    }

    const messages = yield* buildInitialMessages({
      system: spec.system,
      intent: spec.intent,
      context: spec.context,
    });
    const body = textStream.encode(spec.route as never, { messages });
    const streamResult = yield* dispatchProviderStream(
      spec.route,
      body,
      signal,
    ).pipe(Effect.either);

    if (streamResult._tag === "Left") {
      if (signal.aborted) {
        return;
      }
      const reason = reasonText(streamResult.left.cause);
      yield* logAbort(ABORT.UPSTREAM_FAILURE, scope, turn.id, {
        cause: reason,
      });
      yield* Effect.sync(() =>
        emit({
          event: "aborted",
          data: { turnId: turn.id, code: "upstream_failure", reason },
        }),
      );
      return;
    }

    const stream = streamResult.right;

    let text = "";
    let usage = zeroUsage;

    const result = yield* Effect.tryPromise({
      try: async () => {
        for await (const frame of textStream.decodeFrames(stream)) {
          if (signal.aborted) {
            throw new UpstreamFailure({ cause: "client_disconnect" });
          }
          if (frame.type === "token") {
            text += frame.delta;
            emit({ event: "token", data: { delta: frame.delta } });
          } else if (frame.type === "usage") {
            usage = frame.usage;
            emit({ event: "usage", data: frame.usage });
          } else {
            return "done" as const;
          }
        }
        throw new Error("text stream ended without done frame");
      },
      catch: (cause) => new UpstreamFailure({ cause }),
    }).pipe(Effect.either);

    if (result._tag === "Left") {
      if (signal.aborted) {
        return;
      }
      const reason = reasonText(result.left.cause);
      yield* logAbort(ABORT.UPSTREAM_FAILURE, scope, turn.id, {
        cause: reason,
      });
      yield* Effect.sync(() =>
        emit({
          event: "aborted",
          data: { turnId: turn.id, code: "upstream_failure", reason },
        }),
      );
      return;
    }

    if (signal.aborted) {
      return;
    }

    const llmResponse = yield* ledger.log(
      "llm.response",
      { turn, text, toolCalls: [], usage },
      scope,
    );
    const delivered = yield* ledger.log(
      spec.deliver.event,
      { final: text, turn },
      scope,
    );
    yield* Effect.sync(() =>
      emit({
        event: "done",
        data: {
          turnId: turn.id,
          llmResponseId: llmResponse.id,
          deliveredId: delivered.id,
        },
      }),
    );
  });
