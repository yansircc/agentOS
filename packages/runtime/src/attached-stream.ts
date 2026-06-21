import { Cause, Context, Effect, Exit } from "effect";
import type {
  AttachedStreamInboundFrame,
  AttachedStreamMode,
  AttachedStreamOutboundBody,
  AttachedStreamOutboundFrame,
} from "@agent-os/attached-stream";
import { attachedStreamOutboundFrame } from "@agent-os/attached-stream";
import type { JsonStringifyError } from "@agent-os/core";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/core/types";
import type { TriggerEventSpec } from "./trigger";
import type { RuntimeStorageError } from "./ledger";

export type AttachedStreamCancellationMode = "cooperative" | "ignored";
export type AttachedStreamDetachMode = "abort" | "continue";

export type AttachedStreamParseResult<Start> =
  | { readonly ok: true; readonly start: Start }
  | { readonly ok: false; readonly reason: string };

export const attachedStreamParseOk = <Start>(start: Start): AttachedStreamParseResult<Start> => ({
  ok: true,
  start,
});

export const attachedStreamParseFail = <Start = never>(
  reason: string,
): AttachedStreamParseResult<Start> => ({
  ok: false,
  reason,
});

export interface AttachedStreamCtx {
  readonly scope: string;
  readonly streamRef: string;
  readonly now: number;
  readonly signal: AbortSignal;
}

export interface AttachedStreamTx extends AttachedStreamCtx {
  readonly events: (
    opts?: Pick<EventQueryOptions, "afterId" | "kinds">,
  ) => ReadonlyArray<LedgerEvent>;
  readonly insertEvent: (spec: TriggerEventSpec) => LedgerEvent;
}

export type AttachedStreamTerminal<Terminal = unknown> =
  | { readonly kind: "completed"; readonly terminal: Terminal }
  | { readonly kind: "failed"; readonly reason: string; readonly terminal?: Terminal }
  | { readonly kind: "cancelled"; readonly reason?: string; readonly terminal?: Terminal };

export type AttachedStreamHandlerOutput<Terminal = unknown> =
  | Extract<AttachedStreamOutboundBody, { readonly kind: "output" | "progress" }>
  | AttachedStreamTerminal<Terminal>;

export type AttachedStreamOutputSource<Terminal = unknown> =
  | AsyncIterable<AttachedStreamHandlerOutput<Terminal>>
  | Iterable<AttachedStreamHandlerOutput<Terminal>>
  | PromiseLike<
      | AsyncIterable<AttachedStreamHandlerOutput<Terminal>>
      | Iterable<AttachedStreamHandlerOutput<Terminal>>
    >;

export type AttachedStreamServiceError = string | JsonStringifyError | RuntimeStorageError;

export interface AttachedStreamHandler<Start, Terminal = unknown> {
  readonly kind: string;
  readonly mode: AttachedStreamMode;
  readonly cancellation: AttachedStreamCancellationMode;
  readonly onDetach: AttachedStreamDetachMode;
  readonly parseStart: (raw: unknown) => AttachedStreamParseResult<Start>;
  readonly run: (
    start: Start,
    input: AsyncIterable<AttachedStreamInboundFrame>,
    ctx: AttachedStreamCtx,
  ) => AttachedStreamOutputSource<Terminal>;
  readonly commitTerminal: (
    terminal: AttachedStreamTerminal<Terminal>,
    tx: AttachedStreamTx,
  ) => void;
}

// Heterogeneous registries erase handler-local start/terminal types. Runtime
// safety is owned by parseStart before run starts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAttachedStreamHandler = AttachedStreamHandler<any, any>;

export type AttachedStreamRegistryMap = ReadonlyMap<string, AnyAttachedStreamHandler>;

export class AttachedStreamRegistry extends Context.Service<
  AttachedStreamRegistry,
  AttachedStreamRegistryMap
>()("@agent-os/AttachedStreamRegistry") {}

export interface MakeAttachedStreamRegistryOptions {
  readonly reservedKinds?: Iterable<string>;
}

const requiredAttachedStreamField = (
  handler: AnyAttachedStreamHandler,
): "mode" | "cancellation" | "onDetach" | "parseStart" | "run" | "commitTerminal" | null => {
  if (handler.mode !== "bidi" && handler.mode !== "output_only") return "mode";
  if (handler.cancellation !== "cooperative" && handler.cancellation !== "ignored") {
    return "cancellation";
  }
  if (handler.onDetach !== "abort" && handler.onDetach !== "continue") return "onDetach";
  if (typeof handler.parseStart !== "function") return "parseStart";
  if (typeof handler.run !== "function") return "run";
  if (typeof handler.commitTerminal !== "function") return "commitTerminal";
  return null;
};

export const makeAttachedStreamRegistry = (
  handlers: Iterable<AnyAttachedStreamHandler>,
  options: MakeAttachedStreamRegistryOptions = {},
): Effect.Effect<AttachedStreamRegistryMap, string> =>
  Effect.withSpan("agentos.runtime.attached_stream.make_registry")(
    Effect.gen(function* () {
      const reserved = new Set(options.reservedKinds ?? []);
      const registry = new Map<string, AnyAttachedStreamHandler>();
      for (const handler of handlers) {
        const missing = requiredAttachedStreamField(handler);
        if (missing !== null) {
          return yield* Effect.fail(`attached stream ${handler.kind} missing ${missing}`);
        }
        if (reserved.has(handler.kind)) {
          return yield* Effect.fail(
            `attached stream kind conflicts with durable trigger: ${handler.kind}`,
          );
        }
        if (registry.has(handler.kind)) {
          return yield* Effect.fail(`duplicate attached stream kind: ${handler.kind}`);
        }
        registry.set(handler.kind, handler);
      }
      return registry;
    }),
  );

export const getAttachedStreamHandler = (
  registry: AttachedStreamRegistryMap,
  kind: string,
): Effect.Effect<AnyAttachedStreamHandler, string> => {
  const handler = registry.get(kind);
  return handler === undefined
    ? Effect.fail(`unregistered attached stream kind: ${kind}`)
    : Effect.succeed(handler);
};

const isThenable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { readonly then?: unknown }).then === "function";

export const runSynchronousAttachedStreamCommit = (
  scope: string,
  kind: string,
  commit: () => unknown,
): string | null => {
  const result = commit();
  return isThenable(result)
    ? `attached stream ${kind} in ${scope} returned a thenable from commitTerminal`
    : null;
};

export interface AttachedStreamStartSpec {
  readonly kind: string;
  readonly payload: unknown;
  readonly ts?: number;
}

export interface AttachedStreamSendSpec {
  readonly streamRef: string;
  readonly frame: AttachedStreamInboundFrame;
}

export interface AttachedStreamCancelSpec {
  readonly streamRef: string;
  readonly reason?: string;
}

export type AttachedStreamSendResult =
  | { readonly status: "accepted" }
  | { readonly status: "requested" }
  | { readonly status: "ignored" }
  | { readonly status: "not_found" }
  | { readonly status: "already_terminal" }
  | { readonly status: "closed" };

export type AttachedStreamCancelResult =
  | { readonly status: "requested" }
  | { readonly status: "ignored" }
  | { readonly status: "not_found" }
  | { readonly status: "already_terminal" };

export interface AttachedStreamSession {
  readonly streamRef: string;
  readonly kind: string;
  readonly mode: AttachedStreamMode;
  readonly output: AsyncIterable<AttachedStreamOutboundFrame>;
  readonly send: (
    frame: AttachedStreamInboundFrame,
  ) => Effect.Effect<AttachedStreamSendResult, AttachedStreamServiceError>;
  readonly cancel: (
    reason?: string,
  ) => Effect.Effect<AttachedStreamCancelResult, AttachedStreamServiceError>;
  readonly detach: () => Effect.Effect<void>;
}

export interface AttachedStreamsService {
  readonly attach: (
    spec: AttachedStreamStartSpec,
  ) => Effect.Effect<AttachedStreamSession, AttachedStreamServiceError>;
  readonly cancelStream: (
    spec: AttachedStreamCancelSpec,
  ) => Effect.Effect<AttachedStreamCancelResult, AttachedStreamServiceError>;
}

export class AttachedStreams extends Context.Service<AttachedStreams, AttachedStreamsService>()(
  "@agent-os/AttachedStreams",
) {}

export interface AttachedStreamQueue<T> extends AsyncIterable<T> {
  readonly push: (value: T) => void;
  readonly close: () => void;
}

export const createAttachedStreamQueue = <T>(): AttachedStreamQueue<T> => {
  const values: T[] = [];
  const waiters: Array<(value: IteratorResult<T>) => void> = [];
  let closed = false;
  return {
    push: (value) => {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter({ done: false, value });
        return;
      }
      values.push(value);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined });
      }
    },
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
      },
    }),
  };
};

const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { readonly then?: unknown }).then === "function";

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
    "function";

const isIterable = <T>(value: unknown): value is Iterable<T> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";

type ResolvedAttachedStreamOutputSource =
  | AsyncIterable<AttachedStreamHandlerOutput>
  | Iterable<AttachedStreamHandlerOutput>;

const resolveOutputSource = (
  source: AttachedStreamOutputSource,
): Effect.Effect<ResolvedAttachedStreamOutputSource, string> =>
  isPromiseLike<ResolvedAttachedStreamOutputSource>(source)
    ? Effect.tryPromise({
        try: () => Promise.resolve(source),
        catch: (cause) => String(cause),
      })
    : Effect.succeed(source);

export interface AttachedStreamTerminalCommitSpec<Terminal = unknown> {
  readonly handler: AnyAttachedStreamHandler;
  readonly ctx: AttachedStreamCtx;
  readonly terminal: AttachedStreamTerminal<Terminal>;
}

export interface AttachedStreamTerminalCommitAck {
  readonly eventIds: ReadonlyArray<number>;
}

export interface MakeAttachedStreamServiceSpec {
  readonly registry: AttachedStreamRegistryMap;
  readonly scope: string;
  readonly now: () => Effect.Effect<number, AttachedStreamServiceError>;
  readonly makeStreamRef: () => string;
  readonly commitTerminal: (
    spec: AttachedStreamTerminalCommitSpec,
  ) => Effect.Effect<AttachedStreamTerminalCommitAck, AttachedStreamServiceError>;
}

interface AttachedStreamActiveRecord {
  readonly session: AttachedStreamSession;
  readonly input: AttachedStreamQueue<AttachedStreamInboundFrame>;
  readonly output: AttachedStreamQueue<AttachedStreamOutboundFrame>;
  readonly controller: AbortController;
  readonly emit: (body: AttachedStreamOutboundBody) => AttachedStreamOutboundFrame;
  detached: boolean;
  detachedAbort: boolean;
  terminal: boolean;
}

export const makeAttachedStreamService = (
  spec: MakeAttachedStreamServiceSpec,
): AttachedStreamsService => {
  const active = new Map<string, AttachedStreamActiveRecord>();

  const cancel = (
    streamRef: string,
    reason?: string,
  ): Effect.Effect<AttachedStreamCancelResult, AttachedStreamServiceError> =>
    Effect.sync(() => {
      const record = active.get(streamRef);
      if (record === undefined) return { status: "not_found" as const };
      if (record.terminal) return { status: "already_terminal" as const };
      const handler = spec.registry.get(record.session.kind);
      if (handler === undefined) return { status: "not_found" as const };
      if (handler.cancellation === "ignored") {
        if (!record.detached) {
          record.output.push(
            record.emit({
              kind: "cancel_ignored",
              ...(reason === undefined ? {} : { reason }),
            }),
          );
        }
        return { status: "ignored" as const };
      }
      record.controller.abort(reason ?? "attached stream cancelled");
      record.input.close();
      return { status: "requested" as const };
    });

  const send = (
    streamRef: string,
    frame: AttachedStreamInboundFrame,
  ): Effect.Effect<AttachedStreamSendResult, AttachedStreamServiceError> =>
    frame.kind === "cancel"
      ? cancel(streamRef, frame.reason)
      : Effect.sync(() => {
          const record = active.get(streamRef);
          if (record === undefined) return { status: "not_found" as const };
          if (record.terminal || record.detached) return { status: "closed" as const };
          if (frame.streamRef !== streamRef) return { status: "not_found" as const };
          if (record.session.mode === "output_only") return { status: "closed" as const };
          record.input.push(frame);
          return { status: "accepted" as const };
        });

  const detach = (streamRef: string): Effect.Effect<void> =>
    Effect.sync(() => {
      const record = active.get(streamRef);
      if (record === undefined) return;
      const handler = spec.registry.get(record.session.kind);
      record.detached = true;
      record.output.close();
      if (handler?.onDetach === "abort") {
        record.detachedAbort = true;
        record.controller.abort("attached stream detached");
        record.input.close();
        active.delete(streamRef);
      }
    });

  const closeRecord = (record: AttachedStreamActiveRecord): void => {
    record.output.close();
    record.input.close();
  };

  const terminalFromOutputBody = (
    body: AttachedStreamHandlerOutput,
  ): AttachedStreamTerminal | null => {
    switch (body.kind) {
      case "completed":
        return { kind: "completed", terminal: body.terminal };
      case "failed":
        return {
          kind: "failed",
          reason: body.reason,
          ...(body.terminal === undefined ? {} : { terminal: body.terminal }),
        };
      case "cancelled":
        return {
          kind: "cancelled",
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          ...(body.terminal === undefined ? {} : { terminal: body.terminal }),
        };
      case "output":
      case "progress":
        return null;
    }
  };

  const settleTerminal = (
    record: AttachedStreamActiveRecord,
    handler: AnyAttachedStreamHandler,
    ctx: AttachedStreamCtx,
    body: AttachedStreamHandlerOutput,
    terminal: AttachedStreamTerminal,
  ): Effect.Effect<boolean, AttachedStreamServiceError> =>
    Effect.gen(function* () {
      record.terminal = true;
      active.delete(record.session.streamRef);
      if (!record.detachedAbort) {
        const exit = yield* Effect.exit(spec.commitTerminal({ handler, ctx, terminal }));
        if (!record.detached) {
          record.output.push(
            Exit.isSuccess(exit)
              ? record.emit(body)
              : record.emit({
                  kind: "failed",
                  reason: Cause.pretty(exit.cause),
                }),
          );
        }
      }
      closeRecord(record);
      return false;
    });

  const handleOutputBody = (
    record: AttachedStreamActiveRecord,
    handler: AnyAttachedStreamHandler,
    ctx: AttachedStreamCtx,
    body: AttachedStreamHandlerOutput,
  ): Effect.Effect<boolean, AttachedStreamServiceError> => {
    const terminal = terminalFromOutputBody(body);
    if (terminal !== null) return settleTerminal(record, handler, ctx, body, terminal);
    const frame = record.emit(body);
    if (!record.detached) record.output.push(frame);
    return Effect.succeed(true);
  };

  const pullAsyncOutput = (
    record: AttachedStreamActiveRecord,
    handler: AnyAttachedStreamHandler,
    ctx: AttachedStreamCtx,
    iterator: AsyncIterator<AttachedStreamHandlerOutput>,
  ): Effect.Effect<void, AttachedStreamServiceError> =>
    Effect.tryPromise({
      try: () => iterator.next(),
      catch: (cause) => String(cause),
    }).pipe(
      Effect.flatMap((next) => {
        if (next.done === true) return Effect.void;
        return handleOutputBody(record, handler, ctx, next.value).pipe(
          Effect.flatMap((keepPulling) =>
            keepPulling ? pullAsyncOutput(record, handler, ctx, iterator) : Effect.void,
          ),
        );
      }),
    );

  const pullSyncOutput = (
    record: AttachedStreamActiveRecord,
    handler: AnyAttachedStreamHandler,
    ctx: AttachedStreamCtx,
    iterator: Iterator<AttachedStreamHandlerOutput>,
  ): Effect.Effect<void, AttachedStreamServiceError> =>
    Effect.try({
      try: () => iterator.next(),
      catch: (cause) => String(cause),
    }).pipe(
      Effect.flatMap((next) => {
        if (next.done === true) return Effect.void;
        return handleOutputBody(record, handler, ctx, next.value).pipe(
          Effect.flatMap((keepPulling) =>
            keepPulling ? pullSyncOutput(record, handler, ctx, iterator) : Effect.void,
          ),
        );
      }),
    );

  const handleRunFailure = (
    record: AttachedStreamActiveRecord,
    handler: AnyAttachedStreamHandler,
    ctx: AttachedStreamCtx,
    cause: AttachedStreamServiceError,
  ): Effect.Effect<void, AttachedStreamServiceError> => {
    const body = { kind: "failed", reason: String(cause) } as const;
    const terminal = terminalFromOutputBody(body);
    if (terminal === null) return Effect.void;
    return settleTerminal(record, handler, ctx, body, terminal).pipe(Effect.asVoid);
  };

  const driveHandler = (
    record: AttachedStreamActiveRecord,
    handler: AnyAttachedStreamHandler,
    start: unknown,
    ctx: AttachedStreamCtx,
  ): Effect.Effect<void> =>
    Effect.try({
      try: () => handler.run(start, record.input, ctx),
      catch: (cause) => String(cause),
    }).pipe(
      Effect.flatMap(resolveOutputSource),
      Effect.flatMap((source) => {
        if (isAsyncIterable<AttachedStreamHandlerOutput>(source)) {
          return pullAsyncOutput(record, handler, ctx, source[Symbol.asyncIterator]());
        }
        if (isIterable<AttachedStreamHandlerOutput>(source)) {
          return pullSyncOutput(record, handler, ctx, source[Symbol.iterator]());
        }
        return Effect.fail(`attached stream ${handler.kind} returned non-iterable output`);
      }),
      Effect.catchIf(
        (_cause: AttachedStreamServiceError): _cause is AttachedStreamServiceError => true,
        (cause) =>
          handleRunFailure(record, handler, ctx, cause).pipe(
            Effect.catchIf(
              (
                _settlementCause: AttachedStreamServiceError,
              ): _settlementCause is AttachedStreamServiceError => true,
              () =>
                Effect.sync(() => {
                  active.delete(record.session.streamRef);
                  closeRecord(record);
                }),
            ),
          ),
      ),
    );

  return {
    attach: (startSpec) =>
      Effect.withSpan("agentos.runtime.attached_stream.attach")(
        Effect.gen(function* () {
          const handler = yield* getAttachedStreamHandler(spec.registry, startSpec.kind);
          const parsed = handler.parseStart(startSpec.payload);
          if (!parsed.ok) return yield* Effect.fail(parsed.reason);
          const now = startSpec.ts ?? (yield* spec.now());
          const streamRef = spec.makeStreamRef();
          const input = createAttachedStreamQueue<AttachedStreamInboundFrame>();
          const output = createAttachedStreamQueue<AttachedStreamOutboundFrame>();
          const controller = new AbortController();
          let outSeq = 0;
          const emit = (body: AttachedStreamOutboundBody): AttachedStreamOutboundFrame => {
            const frame = attachedStreamOutboundFrame(streamRef, outSeq, body);
            outSeq += 1;
            return frame;
          };
          const session: AttachedStreamSession = {
            streamRef,
            kind: handler.kind,
            mode: handler.mode,
            output,
            send: (frame) => send(streamRef, frame),
            cancel: (reason) => cancel(streamRef, reason),
            detach: () => detach(streamRef),
          };
          const record = {
            session,
            input,
            output,
            controller,
            emit,
            detached: false,
            detachedAbort: false,
            terminal: false,
          };
          active.set(streamRef, record);
          output.push(emit({ kind: "opened", mode: handler.mode }));

          const ctx = { scope: spec.scope, streamRef, now, signal: controller.signal };
          yield* Effect.forkDetach(driveHandler(record, handler, parsed.start, ctx));

          return session;
        }),
      ),
    cancelStream: (cancelSpec) => cancel(cancelSpec.streamRef, cancelSpec.reason),
  };
};
