import { Clock, Effect } from "effect";

import { failureToToolResult, toDynamicWorkerToolResult } from "./output";
import { runDynamicWorker } from "./run";
import {
  DEFAULT_MAX_BODY_BYTES,
  type DynamicWorkerEgress,
  type DynamicWorkerHttpRequest,
  type DynamicWorkerLimits,
  type DynamicWorkerRunRequest,
  type DynamicWorkerToolLike,
  type MakeDynamicWorkerToolOptions,
} from "./types";

const toolParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string" },
    codeRef: { type: "string" },
    url: { type: "string" },
    method: { type: "string" },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    body: { type: "string" },
  },
  required: ["code", "url"],
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringRecord = (value: unknown): Readonly<Record<string, string>> | undefined => {
  const input = record(value);
  const entries = Object.entries(input).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

const coerceToolArgs = (
  value: unknown,
  defaults: Required<Pick<MakeDynamicWorkerToolOptions, "timeoutMs" | "maxBodyBytes">> & {
    readonly egress: DynamicWorkerEgress;
    readonly limits?: DynamicWorkerLimits;
  },
): DynamicWorkerRunRequest => {
  const input = record(value);
  const request: DynamicWorkerHttpRequest = {
    url: typeof input.url === "string" ? input.url : "",
    ...(typeof input.method === "string" ? { method: input.method } : {}),
    ...(typeof input.body === "string" ? { body: input.body } : {}),
    ...(stringRecord(input.headers) ? { headers: stringRecord(input.headers) } : {}),
  };
  return {
    code: typeof input.code === "string" ? input.code : "",
    ...(typeof input.codeRef === "string" ? { codeRef: input.codeRef } : {}),
    request,
    timeoutMs: defaults.timeoutMs,
    maxBodyBytes: defaults.maxBodyBytes,
    egress: defaults.egress,
    ...(defaults.limits === undefined ? {} : { limits: defaults.limits }),
  };
};

export const makeDynamicWorkerTool = (
  options: MakeDynamicWorkerToolOptions,
): DynamicWorkerToolLike => {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const egress = options.egress ?? { mode: "none" as const };
  const limits = options.limits;
  return {
    definition: {
      type: "function",
      function: {
        name: options.name ?? "dynamic_worker_run",
        description:
          options.description ?? "Run one bounded stateless Worker-compatible code request.",
        parameters: toolParameters,
      },
    },
    execute: (args) => {
      const request = coerceToolArgs(args, {
        timeoutMs,
        maxBodyBytes,
        egress,
        limits,
      });
      const program = Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const result = yield* runDynamicWorker(options.backend, options.policy, request).pipe(
          Effect.either,
        );
        const ended = yield* Clock.currentTimeMillis;
        if (result._tag === "Left") {
          return failureToToolResult(result.left, ended - started, maxBodyBytes);
        }
        return toDynamicWorkerToolResult(result.right, maxBodyBytes);
      });
      return Effect.runPromise(program);
    },
  };
};
