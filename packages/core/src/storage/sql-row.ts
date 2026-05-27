export const sqlText = (value: unknown, column: string): string => {
  if (typeof value === "string") return value;
  throw new TypeError(`expected SQLite TEXT column '${column}'`);
};
