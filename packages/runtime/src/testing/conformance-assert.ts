const MATCHER = Symbol("agentos.backend-conformance.matcher");

type Matcher = {
  readonly [MATCHER]: (value: unknown) => boolean;
  readonly description: string;
};

const matcher = (description: string, predicate: (value: unknown) => boolean): Matcher => ({
  [MATCHER]: predicate,
  description,
});

const isMatcher = (value: unknown): value is Matcher =>
  typeof value === "object" && value !== null && MATCHER in value;

const format = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const deepEqual = (actual: unknown, expected: unknown): boolean => {
  if (isMatcher(expected)) return expected[MATCHER](actual);
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length &&
      actual.every((value, index) => deepEqual(value, expected[index]))
    );
  }
  if (
    typeof actual === "object" &&
    actual !== null &&
    typeof expected === "object" &&
    expected !== null
  ) {
    const actualRecord = actual as Readonly<Record<string, unknown>>;
    const expectedRecord = expected as Readonly<Record<string, unknown>>;
    const actualKeys = Object.keys(actualRecord);
    const expectedKeys = Object.keys(expectedRecord);
    return (
      actualKeys.length === expectedKeys.length &&
      expectedKeys.every(
        (key) =>
          Object.hasOwn(actualRecord, key) && deepEqual(actualRecord[key], expectedRecord[key]),
      )
    );
  }
  return false;
};

const matchesObject = (actual: unknown, expected: unknown): boolean => {
  if (isMatcher(expected)) return expected[MATCHER](actual);
  if (typeof expected !== "object" || expected === null) return deepEqual(actual, expected);
  if (typeof actual !== "object" || actual === null) return false;
  if (Array.isArray(expected)) return deepEqual(actual, expected);
  const actualRecord = actual as Readonly<Record<string, unknown>>;
  return Object.entries(expected).every(
    ([key, value]) => key in actualRecord && matchesObject(actualRecord[key], value),
  );
};

const fail = (message: string): never => {
  throw new Error(message);
};

const assertions = (actual: unknown, negated = false) => {
  const verify = (pass: boolean, label: string, expected?: unknown): void => {
    const accepted = negated ? !pass : pass;
    if (!accepted) {
      fail(
        `backend conformance assertion failed: ${negated ? "not " : ""}${label}; actual=${format(actual)}${
          expected === undefined ? "" : `; expected=${format(expected)}`
        }`,
      );
    }
  };
  return {
    toBe: (expected: unknown) => verify(Object.is(actual, expected), "toBe", expected),
    toEqual: (expected: unknown) => verify(deepEqual(actual, expected), "toEqual", expected),
    toMatchObject: (expected: unknown) =>
      verify(matchesObject(actual, expected), "toMatchObject", expected),
    toHaveLength: (expected: number) =>
      verify(
        (typeof actual === "string" || Array.isArray(actual)) && actual.length === expected,
        "toHaveLength",
        expected,
      ),
    toBeDefined: () => verify(actual !== undefined, "toBeDefined"),
    toBeUndefined: () => verify(actual === undefined, "toBeUndefined"),
    toBeTruthy: () => verify(Boolean(actual), "toBeTruthy"),
    toBeGreaterThan: (expected: number) =>
      verify(typeof actual === "number" && actual > expected, "toBeGreaterThan", expected),
    toBeLessThan: (expected: number) =>
      verify(typeof actual === "number" && actual < expected, "toBeLessThan", expected),
    toContain: (expected: unknown) =>
      verify(
        (typeof actual === "string" && typeof expected === "string" && actual.includes(expected)) ||
          (Array.isArray(actual) && actual.some((value) => deepEqual(value, expected))),
        "toContain",
        expected,
      ),
    toHaveProperty: (key: string) =>
      verify(
        typeof actual === "object" && actual !== null && Object.hasOwn(actual, key),
        "toHaveProperty",
        key,
      ),
  };
};

const rejectedAssertions = (input: Promise<unknown>) => ({
  toMatchObject: async (expected: unknown): Promise<void> => {
    try {
      await input;
    } catch (error) {
      assertions(error).toMatchObject(expected);
      return;
    }
    fail("backend conformance assertion failed: expected promise rejection");
  },
  toBeTruthy: async (): Promise<void> => {
    try {
      await input;
    } catch (error) {
      assertions(error).toBeTruthy();
      return;
    }
    fail("backend conformance assertion failed: expected promise rejection");
  },
});

const expectValue = (actual: unknown) => ({
  ...assertions(actual),
  not: assertions(actual, true),
  rejects: rejectedAssertions(Promise.resolve(actual)),
});

export const expectConformance = Object.assign(expectValue, {
  any: (constructor: NumberConstructor | StringConstructor) =>
    matcher(constructor.name, (value) =>
      constructor === Number ? typeof value === "number" : typeof value === "string",
    ),
  stringMatching: (pattern: string | RegExp) => {
    const expression = typeof pattern === "string" ? new RegExp(pattern) : pattern;
    return matcher(
      `stringMatching(${expression})`,
      (value) => typeof value === "string" && expression.test(value),
    );
  },
  stringContaining: (part: string) =>
    matcher(
      `stringContaining(${part})`,
      (value) => typeof value === "string" && value.includes(part),
    ),
});
