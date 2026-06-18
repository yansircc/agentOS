import { ManagedRuntime } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  AttachedStreams,
  Ledger,
  attachedStreamParseOk,
  type AttachedStreamHandler,
} from "@agent-os/runtime";
import { createInMemoryRuntimeBackend, type InMemoryRuntimeLayerOptions } from "../src";
import { truthIdentity } from "./identity";

const delay = () => new Promise((resolve) => setTimeout(resolve, 0));

const waitForAbortSignal = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

const waitFor = async (assertion: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await assertion()) return;
    await delay();
  }
  throw new Error("condition not reached");
};

const makeRuntime = (
  scope: string,
  options: Omit<InMemoryRuntimeLayerOptions, "identity" | "scope">,
) => {
  const backend = createInMemoryRuntimeBackend({ ...options, identity: truthIdentity(scope) });
  const runtime = ManagedRuntime.make(backend.layer);
  return { backend, runtime };
};

const rawCanonicalPayload = () => {
  const payload = {
    visible: "raw",
    toJSON: () => ({ visible: "stored" }),
  };
  Object.defineProperty(payload, "secret", {
    value: "not-recorded",
    enumerable: false,
  });
  return payload;
};

const payloadObservation = (payload: unknown) => ({
  visible:
    typeof payload === "object" && payload !== null
      ? (payload as { readonly visible?: unknown }).visible
      : undefined,
  hasSecret: typeof payload === "object" && payload !== null && "secret" in payload,
});

describe("in-memory attached streams", () => {
  it("exposes canonical payloads through attached-stream tx pending surfaces", async () => {
    let observed:
      | {
          readonly inserted: ReturnType<typeof payloadObservation>;
          readonly seen: ReturnType<typeof payloadObservation> | undefined;
        }
      | undefined;
    const handler = {
      kind: "test.canonical_tx",
      mode: "output_only",
      cancellation: "cooperative",
      onDetach: "abort",
      parseStart: (raw) => attachedStreamParseOk(raw),
      run: async function* () {
        yield { kind: "completed", terminal: { ok: true } };
      },
      commitTerminal: (_terminal, tx) => {
        const inserted = tx.insertEvent({
          kind: "test.canonical_tx.completed",
          payload: rawCanonicalPayload(),
        });
        const seen = tx.events({ kinds: ["test.canonical_tx.completed"] })[0];
        observed = {
          inserted: payloadObservation(inserted.payload),
          seen: seen === undefined ? undefined : payloadObservation(seen.payload),
        };
      },
    } satisfies AttachedStreamHandler<unknown, unknown>;

    const { runtime } = makeRuntime("stream-canonical-tx", { streams: [handler] });
    try {
      const streams = await runtime.runPromise(AttachedStreams);
      const ledger = await runtime.runPromise(Ledger);
      const session = await runtime.runPromise(
        streams.attach({ kind: "test.canonical_tx", payload: {} }),
      );
      await expect(session.output[Symbol.asyncIterator]().next()).resolves.toMatchObject({
        value: { kind: "opened" },
      });
      await waitFor(async () => observed !== undefined);
      expect(observed).toEqual({
        inserted: { visible: "stored", hasSecret: false },
        seen: { visible: "stored", hasSecret: false },
      });
      const events = await runtime.runPromise(ledger.events(truthIdentity("stream-canonical-tx")));
      expect(events[0]?.payload).toEqual({ visible: "stored" });
    } finally {
      await runtime.dispose();
    }
  });

  it("accepts bidi input and commits terminal facts explicitly", async () => {
    const echo = {
      kind: "test.echo",
      mode: "bidi",
      cancellation: "cooperative",
      onDetach: "abort",
      parseStart: (raw) => attachedStreamParseOk(raw),
      run: async function* (_start, input) {
        for await (const frame of input) {
          if (frame.kind !== "input") continue;
          yield { kind: "output", channel: "stdout", payload: frame.payload };
          yield { kind: "completed", terminal: { echoed: frame.payload } };
          return;
        }
      },
      commitTerminal: (terminal, tx) => {
        tx.insertEvent({ kind: "test.echo.completed", payload: terminal });
      },
    } satisfies AttachedStreamHandler<unknown, unknown>;

    const { runtime } = makeRuntime("stream-scope", { streams: [echo] });
    try {
      const streams = await runtime.runPromise(AttachedStreams);
      const ledger = await runtime.runPromise(Ledger);
      const session = await runtime.runPromise(
        streams.attach({ kind: "test.echo", payload: { started: true }, ts: 10 }),
      );
      const output = session.output[Symbol.asyncIterator]();

      await expect(output.next()).resolves.toMatchObject({
        value: { kind: "opened", streamRef: session.streamRef, seq: 0, mode: "bidi" },
      });
      await expect(
        runtime.runPromise(
          session.send({
            kind: "input",
            streamRef: session.streamRef,
            seq: 0,
            payload: "hello",
          }),
        ),
      ).resolves.toEqual({ status: "accepted" });
      await expect(output.next()).resolves.toMatchObject({
        value: { kind: "output", seq: 1, channel: "stdout", payload: "hello" },
      });
      await expect(output.next()).resolves.toMatchObject({
        value: { kind: "completed", seq: 2, terminal: { echoed: "hello" } },
      });
      await waitFor(
        async () =>
          (await runtime.runPromise(ledger.events(truthIdentity("stream-scope")))).length > 0,
      );
      const events = await runtime.runPromise(ledger.events(truthIdentity("stream-scope")));
      expect(events.map((event) => event.kind)).toEqual(["test.echo.completed"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("emits cancel_ignored without aborting ignored handlers", async () => {
    let aborted = false;
    const ignored = {
      kind: "test.ignored",
      mode: "output_only",
      cancellation: "ignored",
      onDetach: "abort",
      parseStart: (raw) => attachedStreamParseOk(raw),
      run: async function* (_start, _input, ctx) {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        yield { kind: "progress", payload: { running: true } };
        await new Promise(() => undefined);
      },
      commitTerminal: () => undefined,
    } satisfies AttachedStreamHandler<unknown, unknown>;

    const { runtime } = makeRuntime("ignored-scope", { streams: [ignored] });
    try {
      const streams = await runtime.runPromise(AttachedStreams);
      const session = await runtime.runPromise(
        streams.attach({ kind: "test.ignored", payload: {} }),
      );
      const output = session.output[Symbol.asyncIterator]();

      await output.next();
      await output.next();
      await expect(
        runtime.runPromise(streams.cancelStream({ streamRef: session.streamRef, reason: "user" })),
      ).resolves.toEqual({
        status: "ignored",
      });
      await expect(output.next()).resolves.toMatchObject({
        value: { kind: "cancel_ignored", reason: "user" },
      });
      expect(aborted).toBe(false);
      await runtime.runPromise(session.detach());
    } finally {
      await runtime.dispose();
    }
  });

  it("aborts on explicit cancel but lets a signal-ignoring handler complete", async () => {
    const stubborn = {
      kind: "test.stubborn",
      mode: "output_only",
      cancellation: "cooperative",
      onDetach: "abort",
      parseStart: (raw) => attachedStreamParseOk(raw),
      run: async function* (_start, _input, ctx) {
        await waitForAbortSignal(ctx.signal);
        yield { kind: "completed", terminal: { ignoredAbort: true } };
      },
      commitTerminal: (terminal, tx) => {
        tx.insertEvent({ kind: "test.stubborn.completed", payload: terminal });
      },
    } satisfies AttachedStreamHandler<unknown, unknown>;

    const { runtime } = makeRuntime("stubborn-scope", { streams: [stubborn] });
    try {
      const streams = await runtime.runPromise(AttachedStreams);
      const ledger = await runtime.runPromise(Ledger);
      const session = await runtime.runPromise(
        streams.attach({ kind: "test.stubborn", payload: {} }),
      );
      const output = session.output[Symbol.asyncIterator]();

      await output.next();
      await expect(runtime.runPromise(session.cancel("user"))).resolves.toEqual({
        status: "requested",
      });
      await expect(output.next()).resolves.toMatchObject({
        value: { kind: "completed", terminal: { ignoredAbort: true } },
      });
      await waitFor(
        async () =>
          (await runtime.runPromise(ledger.events(truthIdentity("stubborn-scope")))).length > 0,
      );
      const events = await runtime.runPromise(ledger.events(truthIdentity("stubborn-scope")));
      expect(events.map((event) => event.kind)).toEqual(["test.stubborn.completed"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("detach aborts abort-on-detach handlers without terminal settlement", async () => {
    let aborted = false;
    const aborting = {
      kind: "test.detach_abort",
      mode: "output_only",
      cancellation: "cooperative",
      onDetach: "abort",
      parseStart: (raw) => attachedStreamParseOk(raw),
      run: async function* (_start, _input, ctx) {
        await waitForAbortSignal(ctx.signal);
        aborted = true;
        yield { kind: "cancelled", reason: "detached" };
      },
      commitTerminal: (terminal, tx) => {
        tx.insertEvent({ kind: "test.detach_abort.terminal", payload: terminal });
      },
    } satisfies AttachedStreamHandler<unknown, unknown>;

    const { runtime } = makeRuntime("detach-abort-scope", { streams: [aborting] });
    try {
      const streams = await runtime.runPromise(AttachedStreams);
      const ledger = await runtime.runPromise(Ledger);
      const session = await runtime.runPromise(
        streams.attach({ kind: "test.detach_abort", payload: {} }),
      );
      await session.output[Symbol.asyncIterator]().next();
      await runtime.runPromise(session.detach());
      await waitFor(() => aborted);
      const events = await runtime.runPromise(ledger.events(truthIdentity("detach-abort-scope")));
      expect(events).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("detach continue drops output but allows terminal settlement", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const continuing = {
      kind: "test.detach_continue",
      mode: "output_only",
      cancellation: "cooperative",
      onDetach: "continue",
      parseStart: (raw) => attachedStreamParseOk(raw),
      run: async function* () {
        yield { kind: "progress", payload: { visible: true } };
        await released;
        yield { kind: "completed", terminal: { continued: true } };
      },
      commitTerminal: (terminal, tx) => {
        tx.insertEvent({ kind: "test.detach_continue.completed", payload: terminal });
      },
    } satisfies AttachedStreamHandler<unknown, unknown>;

    const { runtime } = makeRuntime("detach-continue-scope", { streams: [continuing] });
    try {
      const streams = await runtime.runPromise(AttachedStreams);
      const ledger = await runtime.runPromise(Ledger);
      const session = await runtime.runPromise(
        streams.attach({ kind: "test.detach_continue", payload: {} }),
      );
      const output = session.output[Symbol.asyncIterator]();
      await output.next();
      await output.next();
      await runtime.runPromise(session.detach());
      release();
      await waitFor(
        async () =>
          (await runtime.runPromise(ledger.events(truthIdentity("detach-continue-scope")))).length >
          0,
      );
      const events = await runtime.runPromise(
        ledger.events(truthIdentity("detach-continue-scope")),
      );
      expect(events.map((event) => event.kind)).toEqual(["test.detach_continue.completed"]);
      await expect(output.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      await runtime.dispose();
    }
  });
});
