export const countTokens = (): number => 0;

export const getTokenizer = (): {
  readonly encode: () => ReadonlyArray<number>;
  readonly free: () => void;
} => ({
  encode: () => [],
  free: () => undefined,
});
