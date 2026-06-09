import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PostgresRuntimeHarness {
  readonly databaseUrl: string;
  readonly cleanup: () => Promise<void>;
}

const dockerImage = process.env.AGENTOS_NODE_POSTGRES_IMAGE ?? "postgres:16-alpine";

const exec = async (
  command: string,
  args: ReadonlyArray<string>,
  timeout = 120_000,
): Promise<void> => {
  await execFileAsync(command, [...args], { timeout, maxBuffer: 1024 * 1024 });
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) {
          resolve(address.port);
          return;
        }
        reject(new Error("free port unavailable"));
      });
    });
  });

const waitForPostgres = async (databaseUrl: string): Promise<void> => {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await execFileAsync("psql", [databaseUrl, "-X", "-q", "-t", "-A", "-c", "SELECT 1"], {
        timeout: 5_000,
      });
      return;
    } catch (cause) {
      lastError = cause;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("postgres did not become ready");
};

export const startPostgresRuntimeHarness = async (): Promise<PostgresRuntimeHarness> => {
  const configured = process.env.AGENTOS_NODE_POSTGRES_DATABASE_URL;
  if (configured !== undefined && configured.length > 0) {
    await waitForPostgres(configured);
    return {
      databaseUrl: configured,
      cleanup: async () => undefined,
    };
  }

  const port = await freePort();
  const name = `agentos-node-postgres-${process.pid}-${Date.now()}`;
  await exec("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_DB=agentos",
    "-p",
    `127.0.0.1:${port}:5432`,
    dockerImage,
  ]);
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/agentos`;
  try {
    await waitForPostgres(databaseUrl);
  } catch (cause) {
    await exec("docker", ["rm", "-f", name]).catch(() => undefined);
    throw cause;
  }
  return {
    databaseUrl,
    cleanup: async () => {
      await exec("docker", ["rm", "-f", name]).catch(() => undefined);
    },
  };
};
