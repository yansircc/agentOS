import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { constants as fsConstants } from "node:fs";
import process from "node:process";
import {
  createWorkspaceEnv,
  type WorkspaceEnv,
  type WorkspaceEnvBackend,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceFileStat,
} from "../workspace-env-core";
import {
  abortErrorFor,
  checkSignal,
  normalizeAbsolutePath,
  truncateUtf8,
} from "../workspace-env-core/path-policy";

export interface CreateLocalWorkspaceEnvOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inheritEnv?: boolean;
}

export class LocalWorkspaceEnvError extends Error {
  override readonly name = "LocalWorkspaceEnvError";
}

const textEncoder = new TextEncoder();

const utf8ByteLength = (value: string): number => textEncoder.encode(value).byteLength;

const cleanEnv = (
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
};

const processEnvFor = (options: CreateLocalWorkspaceEnvOptions): Record<string, string> => ({
  ...(options.inheritEnv === true ? cleanEnv(process.env) : {}),
  ...(options.env === undefined ? {} : cleanEnv(options.env)),
});

const fileStatFor = (stat: Awaited<ReturnType<typeof fs.stat>>): WorkspaceFileStat => ({
  type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
  size: Number(stat.size),
  mtimeMs: Number(stat.mtimeMs),
});

const missingPath = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const rejectSymbolicRefs = (options: WorkspaceExecOptions): void => {
  if (options.envRefs !== undefined && Object.keys(options.envRefs).length > 0) {
    throw new LocalWorkspaceEnvError("local workspace env cannot resolve symbolic env refs");
  }
  if (options.materialRefs !== undefined && options.materialRefs.length > 0) {
    throw new LocalWorkspaceEnvError("local workspace env cannot resolve symbolic material refs");
  }
};

const appendOutput = (
  previous: string,
  chunk: string,
  maxBytes: number | undefined,
): { readonly text: string; readonly truncated: boolean } => {
  const next = `${previous}${chunk}`;
  if (maxBytes === undefined) return { text: next, truncated: false };
  const truncated = truncateUtf8(next, maxBytes);
  return { text: truncated.text, truncated: truncated.truncated };
};

const execLocalCommand = (
  command: string,
  options: WorkspaceExecOptions,
  env: Record<string, string>,
): Promise<WorkspaceExecResult> =>
  new Promise((resolve, reject) => {
    rejectSymbolicRefs(options);
    checkSignal(options.signal);
    const started = Date.now();
    const child = spawn(command, {
      cwd: options.cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      finish();
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
      settle(() => reject(abortErrorFor(options.signal!)));
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() =>
        reject(
          new LocalWorkspaceEnvError(
            `local workspace command timed out after ${options.timeoutMs}ms`,
          ),
        ),
      );
    }, options.timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += utf8ByteLength(chunk);
      const appended = appendOutput(stdout, chunk, options.maxOutputBytes);
      stdout = appended.text;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += utf8ByteLength(chunk);
      const appended = appendOutput(stderr, chunk, options.maxOutputBytes);
      stderr = appended.text;
      stderrTruncated ||= appended.truncated;
    });
    child.on("error", (cause) => {
      settle(() => reject(new LocalWorkspaceEnvError(String(cause))));
    });
    child.on("close", (code) => {
      settle(() =>
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          stdoutBytes,
          stderrBytes,
          stdoutTruncated,
          stderrTruncated,
          durationMs: Date.now() - started,
        }),
      );
    });
  });

const localWorkspaceBackend = (
  options: CreateLocalWorkspaceEnvOptions,
): WorkspaceEnvBackend => {
  const env = processEnvFor(options);
  return {
    readFile: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fs.readFile(path, "utf8");
    },
    readFileBuffer: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return new Uint8Array(await fs.readFile(path));
    },
    writeFile: (path, content, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fs.writeFile(path, content);
    },
    stat: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fileStatFor(await fs.stat(path));
    },
    readdir: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fs.readdir(path);
    },
    exists: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      try {
        await fs.access(path, fsConstants.F_OK);
        return true;
      } catch (cause) {
        if (missingPath(cause)) return false;
        throw cause;
      }
    },
    mkdir: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fs.mkdir(path, { recursive: operationOptions?.recursive }).then(() => undefined);
    },
    rm: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fs.rm(path, {
        recursive: operationOptions?.recursive,
        force: operationOptions?.force,
      });
    },
    exec: (command, execOptions) => execLocalCommand(command, execOptions, env),
  };
};

/**
 * Creates a Node/Bun local filesystem workspace environment.
 *
 * Path confinement is owned by the shared `createWorkspaceEnv` contract; this
 * backend only executes operations on paths it receives from that contract.
 *
 * @public
 */
export const createLocalWorkspaceEnv = (
  options: CreateLocalWorkspaceEnvOptions,
): WorkspaceEnv => {
  const cwd = normalizeAbsolutePath(options.cwd);
  return createWorkspaceEnv({
    domain: { kind: "workspace", ref: cwd },
    cwd,
    backend: localWorkspaceBackend(options),
  });
};
