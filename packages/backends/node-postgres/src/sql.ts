import { spawn } from "node:child_process";
import { SqlError } from "@agent-os/kernel/errors";

export interface PsqlCliOptions {
  readonly databaseUrl: string;
  readonly schema: string;
  readonly psqlPath?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export const quoteIdentifier = (value: string): string => {
  return `"${value.replace(/"/g, '""')}"`;
};

export const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export const sqlNumber = (value: number): string => String(value);

export const sqlJson = (value: unknown): string => `${sqlString(JSON.stringify(value))}::jsonb`;

const psqlArgs = (databaseUrl: string): ReadonlyArray<string> => [
  databaseUrl,
  "-X",
  "--quiet",
  "--no-align",
  "--tuples-only",
  "--set",
  "ON_ERROR_STOP=1",
];

export class PsqlCli {
  readonly #databaseUrl: string;
  readonly #schema: string;
  readonly #psqlPath: string;
  readonly #timeoutMs: number;

  constructor(options: PsqlCliOptions) {
    this.#databaseUrl = options.databaseUrl;
    this.#schema = options.schema;
    this.#psqlPath = options.psqlPath ?? "psql";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async exec(script: string): Promise<void> {
    await this.#run(script);
  }

  async json<T>(selectSql: string): Promise<ReadonlyArray<T>> {
    const rows = await this.jsonValue<ReadonlyArray<T>>(`
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM (${selectSql}) AS agentos_json_rows
    `);
    return rows;
  }

  async jsonArrayStatement<T>(statementSql: string): Promise<ReadonlyArray<T>> {
    return this.jsonValue<ReadonlyArray<T>>(statementSql);
  }

  async jsonValue<T>(selectSql: string): Promise<T> {
    const stdout = await this.#run(`${selectSql};`);
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const last = lines.at(-1);
    if (last === undefined) {
      throw new SqlError({ cause: new TypeError("psql returned no JSON row") });
    }
    try {
      return JSON.parse(last) as T;
    } catch (cause) {
      throw new SqlError({ cause });
    }
  }

  #run(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#psqlPath, psqlArgs(this.#databaseUrl), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new SqlError({ cause: new Error(`psql timed out after ${this.#timeoutMs}ms`) }));
      }, this.#timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (cause) => {
        clearTimeout(timeout);
        reject(new SqlError({ cause }));
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new SqlError({ cause: stderr.trim() || `psql exited ${code}` }));
      });

      child.stdin.end(`
        SET search_path TO ${quoteIdentifier(this.#schema)}, public;
        ${script}
      `);
    });
  }
}
