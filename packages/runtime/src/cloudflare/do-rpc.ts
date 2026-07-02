// Function-bearing values cannot cross Durable Object RPC by structured clone.
// This helper is intentionally type-level only; runtime validation remains app-owned.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any;
type Primitive = string | number | boolean | bigint | symbol | null | undefined;

const RPC_ERROR_VERSION = "agentos-do-rpc-error-v1";
export const DURABLE_OBJECT_RPC_INVOKE = "__agentOSRpcInvoke";

export type FunctionFree<T> = T extends AnyFunction
  ? never
  : T extends Primitive
    ? T
    : T extends readonly [infer Head, ...infer Tail]
      ? readonly [FunctionFree<Head>, ...FunctionFree<Tail>]
      : T extends ReadonlyArray<infer Item>
        ? ReadonlyArray<FunctionFree<Item>>
        : T extends object
          ? { readonly [K in keyof T]: FunctionFree<T[K]> }
          : T;

type FunctionFreeArgs<Args extends ReadonlyArray<unknown>> = {
  readonly [K in keyof Args]: FunctionFree<Args[K]>;
};

export interface DurableObjectRpcErrorV1 {
  readonly version: typeof RPC_ERROR_VERSION;
  readonly tag: string;
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type DurableObjectRpcResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: DurableObjectRpcErrorV1 };

export interface DurableObjectRpcServer {
  readonly [DURABLE_OBJECT_RPC_INVOKE]: (
    method: string,
    args: ReadonlyArray<unknown>,
  ) => Promise<DurableObjectRpcResult<unknown>>;
}

export type DurableObjectRpcClient<Client> = {
  readonly [K in keyof Client as Client[K] extends AnyFunction ? K : never]: Client[K] extends (
    ...args: infer Args
  ) => infer Result
    ? (...args: FunctionFreeArgs<Args>) => Promise<Awaited<Result>>
    : never;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const jsonSafeValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonSafeValue(item, seen));
  if (!isRecord(value)) return undefined;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    const safe = jsonSafeValue(value[key], seen);
    if (safe !== undefined) out[key] = safe;
  }
  seen.delete(value);
  return out;
};

const jsonSafeRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  const safe = jsonSafeValue(value, new WeakSet());
  return isRecord(safe) ? safe : {};
};

const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
};

const rpcErrorFromCause = (cause: unknown): DurableObjectRpcErrorV1 => {
  const details = jsonSafeRecord(cause);
  const tag = typeof details._tag === "string" ? details._tag : "agent_os.rpc_untyped_error";
  const code = typeof details.code === "string" ? details.code : tag;
  return {
    version: RPC_ERROR_VERSION,
    tag,
    code,
    message: errorMessage(cause),
    details,
  };
};

export class DurableObjectRpcRejected extends Error {
  readonly _tag: string;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(error: DurableObjectRpcErrorV1) {
    super(error.message);
    this.name = "DurableObjectRpcRejected";
    this._tag = error.tag;
    this.code = error.code;
    this.details = error.details;
    Object.assign(this, error.details);
  }
}

export function durableObjectRpcInvoke(
  target: Readonly<Record<string, unknown>>,
  method: string,
  args: ReadonlyArray<unknown>,
): Promise<DurableObjectRpcResult<unknown>> {
  const fn = target[method];
  if (typeof fn !== "function") {
    return Promise.resolve<DurableObjectRpcResult<unknown>>({
      ok: false,
      error: rpcErrorFromCause({
        _tag: "agent_os.rpc_method_missing",
        code: "agent_os.rpc_method_missing",
        message: `unsupported Durable Object RPC method: ${method}`,
        method,
      }),
    });
  }
  try {
    return Promise.resolve(fn.apply(target, args)).then(
      (value): DurableObjectRpcResult<unknown> => ({ ok: true, value }),
      (cause): DurableObjectRpcResult<unknown> => ({
        ok: false,
        error: rpcErrorFromCause(cause),
      }),
    );
  } catch (cause) {
    return Promise.resolve<DurableObjectRpcResult<unknown>>({
      ok: false,
      error: rpcErrorFromCause(cause),
    });
  }
}

const unwrapRpcResult = <Value>(result: DurableObjectRpcResult<Value>): Value => {
  if (result.ok) return result.value;
  throw new DurableObjectRpcRejected(result.error);
};

export const durableObjectRpcClient = <Client>(
  namespace: DurableObjectNamespace,
  name: string,
): DurableObjectRpcClient<Client> => {
  const server = namespace.get(namespace.idFromName(name)) as unknown as DurableObjectRpcServer;
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string" || property === "then") return undefined;
        return (...args: ReadonlyArray<unknown>) =>
          server[DURABLE_OBJECT_RPC_INVOKE](property, args).then(unwrapRpcResult);
      },
    },
  ) as DurableObjectRpcClient<Client>;
};
