// Function-bearing values cannot cross Durable Object RPC by structured clone.
// This helper is intentionally type-level only; runtime validation remains app-owned.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any;

export type FunctionFree<T> = T extends AnyFunction
  ? never
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

export type DurableObjectRpcClient<Client> = {
  readonly [K in keyof Client as Client[K] extends AnyFunction ? K : never]: Client[K] extends (
    ...args: infer Args
  ) => infer Result
    ? (...args: FunctionFreeArgs<Args>) => Promise<Awaited<Result>>
    : never;
};

export const durableObjectRpcClient = <Client>(
  namespace: DurableObjectNamespace,
  name: string,
): DurableObjectRpcClient<Client> =>
  namespace.get(namespace.idFromName(name)) as unknown as DurableObjectRpcClient<Client>;
