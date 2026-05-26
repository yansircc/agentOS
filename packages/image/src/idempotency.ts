import type { ImageRoute } from "./types";

type StableJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<StableJson>
  | { readonly [key: string]: StableJson | undefined };

const stableStringify = (value: StableJson): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter((entry): entry is [string, StableJson] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
};

const fnv1a64 = (text: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
};

export interface ImageJobIdentity {
  readonly sourceScope: string;
  readonly intentId: string;
  readonly route: ImageRoute;
  readonly prompt: string;
  readonly aspectRatio?: string;
  readonly seed?: string | number;
}

export const imageJobIdempotencyKey = (
  identity: ImageJobIdentity,
): string =>
  `image.job.${fnv1a64(stableStringify(identity as unknown as StableJson))}`;
