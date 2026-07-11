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
  columns: string[];
  rows: Row[];
  createSql: string | null;
}

interface InMemoryStorage {
  readonly sql: SqlStorage;
  readonly transactionSync: <T>(callback: () => T) => T;
  readonly getAlarm: () => Promise<number | null>;
  readonly setAlarm: (scheduledTime: number | Date) => Promise<void>;
  readonly deleteAlarm: () => Promise<void>;
}

export interface InMemoryDurableObjectStateOptions {
  readonly setAlarm?: (scheduledTime: number) => Promise<void> | void;
}

const normalizeSql = (sql: string): string => sql.trim().replace(/\s+/g, " ");

const cloneRow = (row: Row): Row => ({ ...row });

const cloneTable = (table: Table): Table => ({
  nextId: table.nextId,
  columns: [...table.columns],
  rows: table.rows.map(cloneRow),
  createSql: table.createSql,
});

const splitComma = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const splitTopLevelComma = (value: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      out.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter((part) => part.length > 0);
};

const parseCreateTableColumns = (body: string): string[] =>
  splitTopLevelComma(body).flatMap((part) => {
    const match = /^([a-z_]+)\b/i.exec(part);
    if (match === null) return [];
    const name = match[1]!;
    return /^(primary|unique|foreign|constraint|check)$/i.test(name) ? [] : [name];
  });

const finiteDueWorkColumns = (createSql: string): ReadonlyArray<string> => {
  const constraint =
    /CONSTRAINT due_work_finite_timestamps CHECK \((.*?)\), CONSTRAINT due_work_claim_tuple/iu.exec(
      createSql,
    )?.[1];
  if (constraint === undefined) {
    throw new TypeError("due_work finite timestamp constraint is not parseable");
  }
  const columns = Array.from(
    constraint.matchAll(
      /\b([a-z_]+) BETWEEN -1\.7976931348623157e308 AND 1\.7976931348623157e308/giu,
    ),
    (match) => match[1]!,
  );
  if (columns.length === 0 || new Set(columns).size !== columns.length) {
    throw new TypeError("due_work finite timestamp constraint has invalid columns");
  }
  return columns;
};

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

  constructor(private readonly options: InMemoryDurableObjectStateOptions = {}) {
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
    const at = scheduledTime instanceof Date ? scheduledTime.getTime() : Number(scheduledTime);
    return Promise.resolve(this.options.setAlarm?.(at)).then(() => {
      this.alarm = at;
    });
  }

  deleteAlarm(): Promise<void> {
    this.alarm = null;
    return Promise.resolve();
  }

  private exec(sql: string, args: readonly unknown[]): InMemorySqlCursor {
    const normalized = normalizeSql(sql);
    const pragmaTableInfo = /^PRAGMA table_info\(([a-z_]+)\)$/i.exec(normalized);
    if (pragmaTableInfo !== null) {
      const table = this.tables.get(pragmaTableInfo[1]!);
      return new InMemorySqlCursor(
        table === undefined
          ? []
          : table.columns.map((name, cid) => ({
              cid,
              name,
              type: "",
              notnull: 0,
              dflt_value: null,
              pk: name === "id" ? 1 : 0,
            })),
      );
    }
    const alterAddColumn = /^ALTER TABLE ([a-z_]+) ADD COLUMN ([a-z_]+)/i.exec(normalized);
    if (alterAddColumn !== null) {
      this.addColumn(alterAddColumn[1]!, alterAddColumn[2]!);
      return new InMemorySqlCursor([]);
    }
    if (/^CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS /i.test(normalized)) {
      const tableMatch = /^CREATE TABLE IF NOT EXISTS ([a-z_]+) \((.*)\)$/i.exec(normalized);
      if (tableMatch !== null) this.defineTable(tableMatch[1]!, tableMatch[2]!, normalized);
      return new InMemorySqlCursor([]);
    }
    if (/^INSERT INTO /i.test(normalized)) {
      return this.insert(normalized, args);
    }
    if (/^UPDATE /i.test(normalized)) {
      return this.update(normalized, args);
    }
    if (/^DELETE FROM /i.test(normalized)) {
      return this.delete(normalized, args);
    }
    if (/^SELECT /i.test(normalized)) {
      return this.select(normalized, args);
    }
    throw new TypeError(`unsupported in-memory sql: ${normalized}`);
  }

  private table(name: string): Table {
    const existing = this.tables.get(name);
    if (existing !== undefined) return existing;
    const table = { nextId: 1, columns: [], rows: [], createSql: null };
    this.tables.set(name, table);
    return table;
  }

  private defineTable(name: string, body: string, createSql: string): Table {
    const existing = this.tables.get(name);
    if (existing !== undefined) return existing;
    const table = this.table(name);
    table.createSql = createSql;
    for (const column of parseCreateTableColumns(body)) this.addColumn(name, column);
    return table;
  }

  private addColumn(tableName: string, column: string): void {
    const table = this.table(tableName);
    if (!table.columns.includes(column)) table.columns.push(column);
  }

  private insert(sql: string, args: readonly unknown[]): InMemorySqlCursor {
    if (/^INSERT INTO materialized_projection_rows /i.test(sql) && / ON CONFLICT/i.test(sql)) {
      const [
        projectionKey,
        scopeRef,
        scopeKey,
        factOwnerRef,
        factOwnerKey,
        effectAuthorityRef,
        effectAuthorityKey,
        eventIdentityKey,
        kind,
        identityKey,
        identityJson,
        stateJson,
        version,
        updatedEventId,
        updatedAt,
      ] = args;
      const table = this.table("materialized_projection_rows");
      const row = table.rows.find((candidate) => candidate.projection_key === projectionKey);
      const values = {
        projection_key: projectionKey,
        scope_ref: scopeRef,
        scope_key: scopeKey,
        fact_owner_ref: factOwnerRef,
        fact_owner_key: factOwnerKey,
        effect_authority_ref: effectAuthorityRef,
        effect_authority_key: effectAuthorityKey,
        event_identity_key: eventIdentityKey,
        kind,
        identity_key: identityKey,
        identity_json: identityJson,
        state_json: stateJson,
        version,
        updated_event_id: updatedEventId,
        updated_at: updatedAt,
      };
      if (row === undefined) table.rows.push(values);
      else Object.assign(row, values);
      return new InMemorySqlCursor([]);
    }

    if (/^INSERT INTO materialized_projection_meta /i.test(sql) && / ON CONFLICT/i.test(sql)) {
      const [
        eventIdentityKey,
        scopeRef,
        scopeKey,
        factOwnerRef,
        factOwnerKey,
        effectAuthorityRef,
        effectAuthorityKey,
        kind,
        version,
        lastAppliedEventId,
        updatedAt,
      ] = args;
      const table = this.table("materialized_projection_meta");
      const row = table.rows.find(
        (candidate) => candidate.event_identity_key === eventIdentityKey && candidate.kind === kind,
      );
      const values = {
        event_identity_key: eventIdentityKey,
        scope_ref: scopeRef,
        scope_key: scopeKey,
        fact_owner_ref: factOwnerRef,
        fact_owner_key: factOwnerKey,
        effect_authority_ref: effectAuthorityRef,
        effect_authority_key: effectAuthorityKey,
        kind,
        version,
        status: "current",
        last_applied_event_id: lastAppliedEventId,
        last_rebuilt_event_id: null,
        updated_at: updatedAt,
      };
      if (row === undefined) table.rows.push(values);
      else Object.assign(row, values);
      return new InMemorySqlCursor([]);
    }

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
    this.assertRowConstraints(tableName, row);
    if (row.id === undefined && hasAutoincrementId(tableName)) {
      row.id = table.nextId;
      table.nextId += 1;
    }
    table.rows.push(row);
    return new InMemorySqlCursor(match[4] === undefined ? [] : [{ id: row.id }]);
  }

  private delete(sql: string, args: readonly unknown[]): InMemorySqlCursor {
    const match = /^DELETE FROM ([a-z_]+)(?: WHERE (.+))?$/i.exec(sql);
    if (match === null) {
      throw new TypeError(`unsupported in-memory delete: ${sql}`);
    }
    const table = this.table(match[1]!);
    const predicate = match[2] === undefined ? () => true : compileWhere(match[2], args);
    table.rows = table.rows.filter((row) => !predicate(row));
    return new InMemorySqlCursor([]);
  }

  private update(sql: string, args: readonly unknown[]): InMemorySqlCursor {
    const dueWorkClaim =
      /^UPDATE due_work SET claimed_at = \?, claim_token = \?, claim_deadline_at = \?, redrive_count = redrive_count \+ CASE WHEN claim_token IS NULL THEN 0 ELSE 1 END WHERE id = \? AND completed_at IS NULL AND fire_at <= \? AND \( claim_token IS NULL OR claim_deadline_at <= \? \) RETURNING /i;
    if (dueWorkClaim.test(sql)) {
      const [claimedAt, token, deadlineAt, id, now, claimableAt] = args;
      const row = this.table("due_work").rows.find(
        (candidate) =>
          candidate.id === id &&
          candidate.completed_at === null &&
          Number(candidate.fire_at) <= Number(now) &&
          (candidate.claim_token === null ||
            candidate.claim_token === undefined ||
            Number(candidate.claim_deadline_at) <= Number(claimableAt)),
      );
      if (row === undefined) return new InMemorySqlCursor([]);
      const redrive = row.claim_token !== null && row.claim_token !== undefined;
      this.assignRow("due_work", row, {
        claimed_at: claimedAt,
        claim_token: token,
        claim_deadline_at: deadlineAt,
        redrive_count: Number(row.redrive_count ?? 0) + (redrive ? 1 : 0),
      });
      return new InMemorySqlCursor([cloneRow(row)]);
    }

    const dueWorkCompleteClaimed =
      /^UPDATE due_work SET completed_at = \? WHERE id = \? AND claim_token = \? AND completed_at IS NULL RETURNING id$/i;
    if (dueWorkCompleteClaimed.test(sql)) {
      const [completedAt, id, token] = args;
      const row = this.table("due_work").rows.find(
        (candidate) =>
          candidate.id === id && candidate.claim_token === token && candidate.completed_at === null,
      );
      if (row === undefined) return new InMemorySqlCursor([]);
      this.assignRow("due_work", row, { completed_at: completedAt });
      return new InMemorySqlCursor([{ id }]);
    }

    if (/^UPDATE due_work SET cancel_requested_at = COALESCE/i.test(sql)) {
      return this.updateDueWorkCancellation(sql, args);
    }

    const match = /^UPDATE ([a-z_]+) SET (.+) WHERE (.+)$/i.exec(sql);
    if (match === null) {
      throw new TypeError(`unsupported in-memory update: ${sql}`);
    }
    const assignments = splitComma(match[2]!);
    const updates: Row = {};
    let argIndex = 0;
    for (const assignment of assignments) {
      const placeholderMatch = /^([a-z_]+) = \?$/i.exec(assignment);
      if (placeholderMatch !== null) {
        updates[placeholderMatch[1]!] = args[argIndex];
        argIndex += 1;
        continue;
      }
      const nullMatch = /^([a-z_]+) = NULL$/i.exec(assignment);
      if (nullMatch !== null) {
        updates[nullMatch[1]!] = null;
        continue;
      }
      {
        throw new TypeError(`unsupported in-memory update set: ${assignment}`);
      }
    }

    const predicate = compileWhere(match[3]!, args.slice(argIndex));
    for (const row of this.table(match[1]!).rows) {
      if (predicate(row)) {
        this.assignRow(match[1]!, row, updates);
      }
    }
    return new InMemorySqlCursor([]);
  }

  private updateDueWorkCancellation(sql: string, args: readonly unknown[]): InMemorySqlCursor {
    if (/RETURNING id$/i.test(sql)) {
      const [requestedAt, reason, deadlineIfNull, deadlineThreshold, deadline, id] = args;
      const row = this.table("due_work").rows.find(
        (candidate) => candidate.id === id && candidate.completed_at === null,
      );
      if (row === undefined) return new InMemorySqlCursor([]);
      const updates: Row = {
        cancel_requested_at: row.cancel_requested_at ?? requestedAt,
        cancel_reason: row.cancel_reason ?? reason ?? null,
      };
      if (row.claim_token !== null && row.claim_token !== undefined) {
        if (row.claim_deadline_at === null || row.claim_deadline_at === undefined) {
          updates.claim_deadline_at = deadlineIfNull;
        } else if (Number(row.claim_deadline_at) > Number(deadlineThreshold)) {
          updates.claim_deadline_at = deadline;
        }
      }
      this.assignRow("due_work", row, updates);
      return new InMemorySqlCursor([{ id }]);
    }

    const [requestedAt, reason, cancelledAt, completedAt, id, token] = args;
    const row = this.table("due_work").rows.find((candidate) => {
      if (candidate.id !== id || candidate.completed_at !== null) return false;
      if (/AND claim_token = \?/i.test(sql)) return candidate.claim_token === token;
      if (/AND claim_token IS NULL/i.test(sql)) {
        return candidate.claim_token === null || candidate.claim_token === undefined;
      }
      return true;
    });
    if (row === undefined) return new InMemorySqlCursor([]);
    this.assignRow("due_work", row, {
      cancel_requested_at: row.cancel_requested_at ?? requestedAt,
      cancel_reason: row.cancel_reason ?? reason ?? null,
      cancelled_at: cancelledAt,
      completed_at: completedAt,
    });
    return new InMemorySqlCursor([]);
  }

  private select(sql: string, args: readonly unknown[]): InMemorySqlCursor {
    if (/^SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'due_work'$/i.test(sql)) {
      const createSql = this.tables.get("due_work")?.createSql;
      return new InMemorySqlCursor(createSql === undefined ? [] : [{ sql: createSql }]);
    }
    if (/^SELECT MIN\(next_at\) AS m FROM \( SELECT fire_at AS next_at FROM due_work /i.test(sql)) {
      const values = this.table("due_work")
        .rows.filter((row) => row.completed_at === null)
        .map((row) =>
          row.claim_token === null || row.claim_token === undefined
            ? row.fire_at
            : row.claim_deadline_at,
        )
        .filter((value): value is number => typeof value === "number");
      return new InMemorySqlCursor([{ m: values.length === 0 ? null : Math.min(...values) }]);
    }

    const maxMatch = /^SELECT COALESCE\(MAX\(([a-z_]+)\), 0\) AS ([a-z_]+) FROM ([a-z_]+)$/i.exec(
      sql,
    );
    if (maxMatch !== null) {
      const column = maxMatch[1]!;
      const alias = maxMatch[2]!;
      const values = this.table(maxMatch[3]!)
        .rows.map((row) => row[column])
        .filter((value): value is number => typeof value === "number");
      return new InMemorySqlCursor([{ [alias]: values.length === 0 ? 0 : Math.max(...values) }]);
    }

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
    if (tableName === "due_work" && row.completed_at === undefined) {
      row.completed_at = null;
    }
    if (tableName === "due_work") {
      row.claimed_at ??= null;
      row.claim_token ??= null;
      row.claim_deadline_at ??= null;
      row.redrive_count ??= 0;
      row.cancel_requested_at ??= null;
      row.cancel_reason ??= null;
      row.cancelled_at ??= null;
    }
  }

  private assignRow(tableName: string, row: Row, updates: Row): void {
    const candidate = { ...row, ...updates };
    this.assertRowConstraints(tableName, candidate);
    Object.assign(row, candidate);
  }

  private assertRowConstraints(tableName: string, row: Row): void {
    const createSql = this.tables.get(tableName)?.createSql;
    if (
      tableName !== "due_work" ||
      createSql === null ||
      createSql === undefined ||
      !createSql.includes("due_work_claim_tuple")
    ) {
      return;
    }
    if (typeof row.kind !== "string" || row.kind.length === 0) {
      throw new TypeError("due_work kind constraint failed");
    }
    for (const field of finiteDueWorkColumns(createSql)) {
      const value = row[field];
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new TypeError(`due_work ${field} finite constraint failed`);
      }
    }
    const claimFieldCount = [row.claimed_at, row.claim_token, row.claim_deadline_at].filter(
      (value) => value !== null,
    ).length;
    if (
      (claimFieldCount !== 0 && claimFieldCount !== 3) ||
      (row.claim_token !== null &&
        (typeof row.claim_token !== "string" || row.claim_token.length === 0))
    ) {
      throw new TypeError("due_work claim tuple constraint failed");
    }
    if (!Number.isInteger(row.redrive_count) || Number(row.redrive_count) < 0) {
      throw new TypeError("due_work redrive count constraint failed");
    }
    if (Number(row.redrive_count) > 0 && row.claim_token === null) {
      throw new TypeError("due_work redrive claim constraint failed");
    }
    if (row.cancel_reason !== null && row.cancel_requested_at === null) {
      throw new TypeError("due_work cancel reason constraint failed");
    }
    if (
      row.cancelled_at !== null &&
      (row.completed_at === null ||
        row.cancel_requested_at === null ||
        row.cancelled_at !== row.completed_at)
    ) {
      throw new TypeError("due_work cancelled terminal constraint failed");
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

export const makeInMemoryDurableObjectState = (
  options: InMemoryDurableObjectStateOptions = {},
): DurableObjectState =>
  ({
    storage: new InMemoryDurableObjectStorage(options),
  }) as unknown as DurableObjectState;

const hasAutoincrementId = (tableName: string): boolean => tableName === "due_work";

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

  const isNotNullMatch = /^([a-z_]+) IS NOT NULL$/i.exec(condition);
  if (isNotNullMatch !== null) {
    const column = isNotNullMatch[1]!;
    return {
      argsUsed: 0,
      predicate: (row) => row[column] !== null && row[column] !== undefined,
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
