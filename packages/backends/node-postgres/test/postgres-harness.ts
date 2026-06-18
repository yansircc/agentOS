import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { Clock, Config, Data, Duration, Effect } from "effect";

const execFileAsync = promisify(execFile);

export interface PostgresRuntimeHarness {
  readonly databaseUrl: string;
  readonly cleanup: Effect.Effect<void, PostgresHarnessError>;
}

export class PostgresHarnessError extends Data.TaggedError("agent_os.postgres_harness_error")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const readConfig = (name: string, fallback: string): Effect.Effect<string, PostgresHarnessError> =>
  Config.string(name).pipe(
    Config.withDefault(fallback),
    Effect.mapError((cause) => new PostgresHarnessError({ operation: `config:${name}`, cause })),
  );

const exec = (
  command: string,
  args: ReadonlyArray<string>,
  timeout = 120_000,
): Effect.Effect<void, PostgresHarnessError> =>
  Effect.tryPromise({
    try: () =>
      execFileAsync(command, [...args], { timeout, maxBuffer: 1024 * 1024 }).then(() => undefined),
    catch: (cause) => new PostgresHarnessError({ operation: command, cause }),
  });

const freePort = (): Effect.Effect<number, PostgresHarnessError> =>
  Effect.callback<number, PostgresHarnessError>((resume) => {
    const server = createServer();
    server.on("error", (cause) => {
      resume(Effect.fail(new PostgresHarnessError({ operation: "free_port", cause })));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) {
          resume(Effect.succeed(address.port));
          return;
        }
        resume(
          Effect.fail(
            new PostgresHarnessError({ operation: "free_port", cause: "address unavailable" }),
          ),
        );
      });
    });
  });

const psqlReady = (databaseUrl: string): Effect.Effect<void, PostgresHarnessError> =>
  Effect.tryPromise({
    try: () =>
      execFileAsync("psql", [databaseUrl, "-X", "-q", "-t", "-A", "-c", "SELECT 1"], {
        timeout: 5_000,
      }).then(() => undefined),
    catch: (cause) => new PostgresHarnessError({ operation: "psql_ready", cause }),
  });

const waitForPostgres = (databaseUrl: string): Effect.Effect<void, PostgresHarnessError> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 60_000;
    const loop = (
      lastCause: unknown = "postgres did not become ready",
    ): Effect.Effect<void, PostgresHarnessError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now >= deadline) {
          return yield* new PostgresHarnessError({
            operation: "wait_for_postgres",
            cause: lastCause,
          });
        }
        const ready = yield* Effect.result(psqlReady(databaseUrl));
        if (ready._tag === "Success") return;
        yield* Effect.sleep(Duration.millis(500));
        return yield* loop(ready.failure);
      });
    yield* loop();
  });

export const startPostgresRuntimeHarnessEffect: Effect.Effect<
  PostgresRuntimeHarness,
  PostgresHarnessError
> = Effect.gen(function* () {
  const configured = yield* readConfig("AGENTOS_NODE_POSTGRES_DATABASE_URL", "");
  if (configured.length > 0) {
    yield* waitForPostgres(configured);
    return {
      databaseUrl: configured,
      cleanup: Effect.void,
    };
  }

  const dockerImage = yield* readConfig("AGENTOS_NODE_POSTGRES_IMAGE", "postgres:16-alpine");
  const port = yield* freePort();
  const now = yield* Clock.currentTimeMillis;
  const name = `agentos-node-postgres-${process.pid}-${now}`;
  yield* exec("docker", [
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
  const ready = yield* Effect.result(waitForPostgres(databaseUrl));
  if (ready._tag === "Failure") {
    yield* exec("docker", ["rm", "-f", name]).pipe(Effect.ignore);
    return yield* ready.failure;
  }
  return {
    databaseUrl,
    cleanup: exec("docker", ["rm", "-f", name]).pipe(Effect.ignore),
  };
});
