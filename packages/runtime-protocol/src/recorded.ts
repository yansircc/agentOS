import type { Recorded } from "@agent-os/kernel";

export type RuntimeProtocolRecorded<T extends object> = T & Recorded<T>;

export const recordRuntimeProtocolValue = <T extends object>(
  value: T,
): RuntimeProtocolRecorded<T> => {
  const recorded = { ...value } as T & { readonly value: T };
  Object.defineProperty(recorded, "value", {
    value,
    enumerable: false,
  });
  return recorded as RuntimeProtocolRecorded<T>;
};
