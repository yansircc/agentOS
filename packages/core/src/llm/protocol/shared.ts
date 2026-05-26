/**
 * Cross-wire helpers shared by all `LlmProtocolAdapter<K>` implementations.
 *
 * Leaf module: must not import from `./protocol-adapter` or any wire file.
 * Holds the version + forced-tool-name constants and the two pure error
 * helpers so that wire files can read them at module-init time without
 * entering a cycle with the registry built in `./protocol-adapter`.
 *
 * `validateAgainstSchema` lives next to the JSON Schema type union in
 * `../admission/json-schema` (which is itself a leaf — no admission
 * sibling imports). Wire files reach it directly via that path; reaching
 * through the admission barrel would walk back into protocol/ and trip
 * the registry cycle.
 */

import { Effect, Stream } from "effect";
import { UpstreamFailure } from "../../errors";
import type { Outcome } from "../../admission/lease";

/** Single coherence dial for an adapter's complete behavior. Bumping the
 *  major invalidates structured-output lease evidence (spec-25 §9). Any
 *  observable change to encode/decode/classify on EITHER half (turn or
 *  structured) requires a major bump (spec-27 §5). */
export const ADAPTER_VERSION = "1.0.0";

/** Synthesized tool name used by every structured-output adapter to force
 *  the model into emitting a single tool call whose arguments ARE the
 *  result. Identical across wires by design — the substrate uses one
 *  symbolic name so admission.ts can fold all three protocols through a
 *  single decode invariant. */
export const CHAT_COMPLETIONS_FORCED_TOOL_NAME = "_submit_structured";

/** Unwrap a tagged-error / wrapped error one level to surface the real
 *  upstream Error message. `dispatchProvider` always wraps fetch failures
 *  as `UpstreamFailure{cause: Error("HTTP N ...")}`; without this unwrap
 *  classify would see only the tag name ("UpstreamFailure") and route
 *  everything to the default ProviderRejected branch. */
export const unwrapErrorMessage = (error: unknown): string => {
  if (error !== null && typeof error === "object" && "cause" in error) {
    const inner = (error as { cause: unknown }).cause;
    if (inner instanceof Error) return inner.message;
    if (typeof inner === "string") return inner;
    if (inner !== null && inner !== undefined) return String(inner);
  }
  return error instanceof Error ? error.message : String(error);
};

export const parseHttpStatus = (msg: string): number | undefined => {
  const m = /HTTP\s+(\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : undefined;
};

export type SseEvent =
  | { readonly kind: "data"; readonly data: string }
  | { readonly kind: "end" };

type SseInput =
  | { readonly kind: "chunk"; readonly value: Uint8Array }
  | { readonly kind: "end" };

interface SseState {
  readonly buffer: string;
  readonly decoder: TextDecoder;
}

const dataOf = (raw: string): string | undefined => {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data.length > 0 ? data : undefined;
};

const drainCompleteEvents = (
  buffer: string,
): { readonly buffer: string; readonly events: ReadonlyArray<SseEvent> } => {
  let rest = buffer;
  const events: SseEvent[] = [];
  let boundary = rest.indexOf("\n\n");
  while (boundary >= 0) {
    const data = dataOf(rest.slice(0, boundary));
    if (data !== undefined) {
      events.push({ kind: "data", data });
    }
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf("\n\n");
  }
  return { buffer: rest, events };
};

/** Decode Server-Sent Events into non-empty `data:` payload events.
 *
 * OpenAI Chat Completions, Anthropic Messages, and Gemini
 * streamGenerateContent all use SSE framing but differ in the JSON
 * payload. Keep frame splitting here so each wire adapter owns only
 * its protocol JSON algebra.
 */
export const decodeSseEvents = (
  stream: ReadableStream<Uint8Array>,
): Stream.Stream<SseEvent, UpstreamFailure> => {
  const initial: SseState = { buffer: "", decoder: new TextDecoder() };
  return Stream.fromReadableStream(
    () => stream,
    (cause) => new UpstreamFailure({ cause }),
  ).pipe(
    Stream.map((value): SseInput => ({ kind: "chunk", value })),
    Stream.concat(Stream.succeed({ kind: "end" as const })),
    Stream.mapAccum(initial, (state, input) => {
      if (input.kind === "end") {
        const flushed = state.decoder.decode().replace(/\r\n/g, "\n");
        const drained = drainCompleteEvents(state.buffer + flushed);
        const tail = drained.buffer.trim();
        const tailData = tail.length > 0 ? dataOf(tail) : undefined;
        return [
          { ...state, buffer: "" },
          [
            ...drained.events,
            ...(tailData === undefined
              ? []
              : [{ kind: "data" as const, data: tailData }]),
            { kind: "end" as const },
          ],
        ] as const;
      }
      const nextBuffer =
        state.buffer +
        state.decoder
          .decode(input.value, { stream: true })
          .replace(/\r\n/g, "\n");
      const drained = drainCompleteEvents(nextBuffer);
      return [{ ...state, buffer: drained.buffer }, drained.events] as const;
    }),
    Stream.mapConcat((events) => events),
  );
};

export const parseSseJson = <A>(
  data: string,
): Effect.Effect<A, UpstreamFailure> =>
  Effect.try({
    try: () => JSON.parse(data) as A,
    catch: (cause) => new UpstreamFailure({ cause }),
  });

// Re-export Outcome (sourced from admission/lease.ts — leaf, no cycle)
// so wire files can name it without a second import statement.
export type { Outcome };
