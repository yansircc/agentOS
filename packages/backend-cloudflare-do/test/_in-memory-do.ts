/**
 * Test-only Durable Object storage subset.
 *
 * This is not a runtime adapter. It models the narrow DO SQLite contract that
 * projection tests need: synchronous `transactionSync`, atomic rollback on
 * thrown errors, monotonically increasing event ids, and deterministic SQL
 * reads over the `events` ledger.
 */

type Row = Record<string, unknown>;

interface Table {
  nextId: number;
  rows: Row[];
}

interface InMemoryStorage {
  readonly sql: SqlStorage;
  readonly transactionSync: <T>(callback: () => T) => T;
  readonly getAlarm: () => Promise<number | null>;
  readonly setAlarm: (scheduledTime: number | Date) => Promise<void>;
  readonly deleteAlarm: () => Promise<void>;
}

const normalizeSql = (sql: string): string => sql.trim().replace(/\s+/g, " ");

const cloneRow = (row: Row): Row => ({ ...row });

const cloneTable = (table: Table): Table => ({
  nextId: table.nextId,
  rows: table.rows.map(cloneRow),
});

const splitComma = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

class InMemorySqlCursor {
  readonly columnNames: string[];

  constructor(private readonly rows: Row[]) {
    this.columnNames = rows[0] === undefined ? [] : Object.keys(rows[0]);
  }

  toArray(): Row[] {
    return this.rows.map(cloneRow);
  }

  one(): Row {
    const row = this.rows[0];
    if (row === undefined) {
      throw new TypeError("in-memory sql cursor expected one row");
    }
    return cloneRow(row);
  }

  *raw(): IterableIterator<unknown[]> {
    for (const row of this.rows) {
      yield this.columnNames.map((column) => row[column]);
    }
  }
}

export class InMemoryDurableObjectStorage implements InMemoryStorage {
  readonly sql: SqlStorage;

  private readonly tables = new Map<string, Table>();
  private alarm: number | null = null;
  private inTransaction = false;

  constructor() {
    this.sql = {
      exec: (sql: string, ...args: unknown[]) => this.exec(sql, args),
    } as unknown as SqlStorage;
  }

  transactionSync<T>(callback: () => T): T {
    if (this.inTransaction) {
      throw new TypeError("nested transactionSync is not supported");
    }
    const snapshot = this.snapshot();
    this.inTransaction = true;
    try {
      const result = callback();
      if (isPromiseLike(result)) {
        throw new TypeError("transactionSync callback must return synchronously");
      }
      return result;
    } catch (cause) {
      this.restore(snapshot);
      throw cause;
    } finally {
      this.inTransaction = false;
    }
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }

  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : Number(scheduledTime);
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarm = null;
    return Promise.resolve();
  }

  private exec(sql: string, args: readonly unknown[]): InMemorySqlCursor {
    const normalized = normalizeSql(sql);
    if (/^CREATE (TABLE|INDEX) IF NOT EXISTS /i.test(normalized)) {
      const tableMatch = /^CREATE TABLE IF NOT EXISTS ([a-z_]+)/i.exec(normalized);
      if (tableMatch !== null) this.table(tableMatch[1]!);
      return new InMemorySqlCursor([]);
    }
    if (/^INSERT INTO /i.test(normalized)) {
      return this.insert(normalized, args);
    }
    if (/^UPDATE /i.test(normalized)) {
      return this.update(normalized, args);
    }
    if (/^SELECT /i.test(normalized)) {
      return this.select(normalized, args);
    }
    throw new TypeError(`unsupported in-memory sql: ${normalized}`);
  }

  private table(name: string): Table {
    const existing = this.tables.get(name);
    if (existing !== undefined) return existing;
    const table = { nextId: 1, rows: [] };
    this.tables.set(name, table);
    return table;
  }

  private insert(sql: string, args: readonly unknown[]): InMemorySqlCursor {
    const match = /^INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES \(([^)]+)\)( RETURNING id)?$/i.exec(
      sql,
    );
    if (match === null) {
      throw new TypeError(`unsupported in-memory insert: ${sql}`);
    }
    const tableName = match[1]!;
    const columns = splitComma(match[2]!);
    if (columns.length !== args.length) {
      throw new TypeError("insert placeholder count does not match args");
    }

    const table = this.table(tableName);
    const row: Row = {};
    for (let i = 0; i < columns.length; i += 1) {
      row[columns[i]!] = args[i];
    }
    this.applyDefaults(tableName, row);
    if (row.id === undefined && hasAutoincrementId(tableName)) {
      row.id = table.nextId;
      table.nextId += 1;
    }
    table.rows.push(row);
    return new InMemorySqlCursor(match[4] === undefined ? [] : [{ id: row.id }]);
  }

  private update(sql: string, args: readonly unknown[]): InMemorySqlCursor {
    const match = /^UPDATE ([a-z_]+) SET (.+) WHERE (.+)$/i.exec(sql);
    if (match === null) {
      throw new TypeError(`unsupported in-memory update: ${sql}`);
    }
    const assignments = splitComma(match[2]!);
    const updates: Row = {};
    let argIndex = 0;
    for (const assignment of assignments) {
      const assignmentMatch = /^([a-z_]+) = \?$/i.exec(assignment);
      if (assignmentMatch === null) {
        throw new TypeError(`unsupported in-memory update set: ${assignment}`);
      }
      updates[assignmentMatch[1]!] = args[argIndex];
      argIndex += 1;
    }

    const predicate = compileWhere(match[3]!, args.slice(argIndex));
    for (const row of this.table(match[1]!).rows) {
      if (predicate(row)) {
        Object.assign(row, updates);
      }
    }
    return new InMemorySqlCursor([]);
  }

  private select(sql: string, args: readonly unknown[]): InMemorySqlCursor {
    const minMatch = /^SELECT MIN\(([a-z_]+)\) AS ([a-z_]+) FROM ([a-z_]+)(?: WHERE (.+))?$/i.exec(
      sql,
    );
    if (minMatch !== null) {
      const column = minMatch[1]!;
      const alias = minMatch[2]!;
      const rows = this.filteredRows(minMatch[3]!, minMatch[4], args);
      const values = rows
        .map((row) => row[column])
        .filter((value): value is number => typeof value === "number");
      return new InMemorySqlCursor([{ [alias]: values.length === 0 ? null : Math.min(...values) }]);
    }

    const match =
      /^SELECT (.+?) FROM ([a-z_]+)(?: WHERE (.*?))?(?: ORDER BY (.*?))?(?: LIMIT \?)?$/i.exec(sql);
    if (match === null) {
      throw new TypeError(`unsupported in-memory select: ${sql}`);
    }
    const hasLimit = / LIMIT \?$/i.test(sql);
    const whereArgs = hasLimit ? args.slice(0, -1) : args;
    const limit = hasLimit ? Number(args[args.length - 1]) : undefined;
    const rows = this.filteredRows(match[2]!, match[3], whereArgs);
    const ordered = orderRows(rows, match[4]);
    const limited = limit === undefined ? ordered : ordered.slice(0, limit);
    return new InMemorySqlCursor(limited.map((row) => projectColumns(row, match[1]!)));
  }

  private filteredRows(
    tableName: string,
    where: string | undefined,
    args: readonly unknown[],
  ): Row[] {
    const predicate = where === undefined ? () => true : compileWhere(where, args);
    return this.table(tableName).rows.filter(predicate).map(cloneRow);
  }

  private applyDefaults(tableName: string, row: Row): void {
    if (tableName === "dispatch_outbox") {
      if (row.delivered_event_id === undefined) row.delivered_event_id = null;
      if (row.attempts === undefined) row.attempts = 0;
      if (row.last_error === undefined) row.last_error = null;
    }
    if (tableName === "scheduled_events" && row.fired_event_id === undefined) {
      row.fired_event_id = null;
    }
  }

  private snapshot(): Map<string, Table> {
    return new Map(Array.from(this.tables.entries(), ([name, table]) => [name, cloneTable(table)]));
  }

  private restore(snapshot: Map<string, Table>): void {
    this.tables.clear();
    for (const [name, table] of snapshot) {
      this.tables.set(name, cloneTable(table));
    }
  }
}

export const makeInMemoryDurableObjectState = (): DurableObjectState =>
  ({
    storage: new InMemoryDurableObjectStorage(),
  }) as unknown as DurableObjectState;

const hasAutoincrementId = (tableName: string): boolean =>
  tableName === "events" || tableName === "scheduled_events";

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof (value as { readonly then?: unknown }).then === "function";

const compileWhere = (where: string, args: readonly unknown[]): ((row: Row) => boolean) => {
  let argIndex = 0;
  const predicates = where
    .split(/\s+AND\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const orParts = stripParens(part)
        .split(/\s+OR\s+/i)
        .map((orPart) => compileCondition(stripParens(orPart), args, argIndex));
      argIndex += orParts.reduce((sum, part) => sum + part.argsUsed, 0);
      return (row: Row) => orParts.some((part) => part.predicate(row));
    });
  if (argIndex !== args.length) {
    throw new TypeError("where placeholder count does not match args");
  }
  return (row) => predicates.every((predicate) => predicate(row));
};

const compileCondition = (
  condition: string,
  args: readonly unknown[],
  startIndex: number,
): { readonly argsUsed: number; readonly predicate: (row: Row) => boolean } => {
  const isNullMatch = /^([a-z_]+) IS NULL$/i.exec(condition);
  if (isNullMatch !== null) {
    const column = isNullMatch[1]!;
    return {
      argsUsed: 0,
      predicate: (row) => row[column] === null || row[column] === undefined,
    };
  }

  const likeMatch = /^([a-z_]+) LIKE '([^']+)'$/i.exec(condition);
  if (likeMatch !== null) {
    const column = likeMatch[1]!;
    const pattern = likeMatch[2]!;
    const prefix = pattern.endsWith("%") ? pattern.slice(0, -1) : pattern;
    return {
      argsUsed: 0,
      predicate: (row) => String(row[column]).startsWith(prefix),
    };
  }

  const literalMatch = /^([a-z_]+) = '([^']+)'$/i.exec(condition);
  if (literalMatch !== null) {
    const column = literalMatch[1]!;
    const expected = literalMatch[2]!;
    return {
      argsUsed: 0,
      predicate: (row) => row[column] === expected,
    };
  }

  const inMatch = /^([a-z_]+) IN \((.+)\)$/i.exec(condition);
  if (inMatch !== null) {
    const column = inMatch[1]!;
    const placeholders = splitComma(inMatch[2]!);
    const values = args.slice(startIndex, startIndex + placeholders.length);
    return {
      argsUsed: placeholders.length,
      predicate: (row) => values.includes(row[column]),
    };
  }

  const compareMatch = /^([a-z_]+) (=|>|>=|<=) \?$/i.exec(condition);
  if (compareMatch !== null) {
    const column = compareMatch[1]!;
    const op = compareMatch[2]!;
    const expected = args[startIndex];
    return {
      argsUsed: 1,
      predicate: (row) => compare(row[column], op, expected),
    };
  }

  throw new TypeError(`unsupported in-memory where condition: ${condition}`);
};

const compare = (actual: unknown, op: string, expected: unknown): boolean => {
  switch (op) {
    case "=":
      return actual === expected;
    case ">":
      return Number(actual) > Number(expected);
    case ">=":
      return Number(actual) >= Number(expected);
    case "<=":
      return Number(actual) <= Number(expected);
    default:
      throw new TypeError(`unsupported comparison operator: ${op}`);
  }
};

const stripParens = (value: string): string => {
  let out = value.trim();
  while (out.startsWith("(") && out.endsWith(")")) {
    out = out.slice(1, -1).trim();
  }
  return out;
};

const orderRows = (rows: ReadonlyArray<Row>, orderBy: string | undefined): Row[] => {
  const out = rows.map(cloneRow);
  if (orderBy === undefined) return out;
  const clauses = splitComma(orderBy).map((clause) => {
    const [column, direction] = clause.split(/\s+/);
    return {
      column: column!,
      desc: direction?.toUpperCase() === "DESC",
    };
  });
  out.sort((a, b) => {
    for (const clause of clauses) {
      const av = a[clause.column];
      const bv = b[clause.column];
      if (av === bv) continue;
      const result = Number(av) < Number(bv) ? -1 : 1;
      return clause.desc ? -result : result;
    }
    return 0;
  });
  return out;
};

const projectColumns = (row: Row, selectList: string): Row => {
  if (selectList === "*") return cloneRow(row);
  const projected: Row = {};
  for (const part of splitComma(selectList)) {
    const match = /^([a-z_]+)(?: AS ([a-z_]+))?$/i.exec(part);
    if (match === null) {
      throw new TypeError(`unsupported in-memory select column: ${part}`);
    }
    const source = match[1]!;
    const target = match[2] ?? source;
    projected[target] = row[source];
  }
  return projected;
};
