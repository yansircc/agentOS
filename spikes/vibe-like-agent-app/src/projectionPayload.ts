export const payload = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export const stringField = (value: Record<string, unknown>, key: string, fallback = ""): string => {
  const field = value[key];
  return typeof field === "string" ? field : fallback;
};

export const numberField = (value: Record<string, unknown>, key: string, fallback = 0): number => {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : fallback;
};

export const booleanField = (
  value: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean => {
  const field = value[key];
  return typeof field === "boolean" ? field : fallback;
};

export const recordField = (
  value: Record<string, unknown>,
  key: string,
): Readonly<Record<string, string | number | boolean>> => {
  const field = value[key];
  if (field === null || typeof field !== "object" || Array.isArray(field)) return {};
  const entries = Object.entries(field as Record<string, unknown>).filter(
    ([, entryValue]) =>
      typeof entryValue === "string" ||
      typeof entryValue === "number" ||
      typeof entryValue === "boolean",
  );
  return Object.fromEntries(entries) as Readonly<Record<string, string | number | boolean>>;
};
