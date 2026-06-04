import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkspaceEnv,
  type WorkspaceEnv,
  type WorkspaceEnvBackend,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceFileStat,
} from "@agent-os/workspace-env";

export interface LocalWorkspaceEnvOptions {
  readonly rootDir: string;
  readonly cwd?: string;
  readonly workspaceRef?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly envAllowlist?: ReadonlyArray<string>;
}

export interface TemporaryLocalWorkspaceEnvOptions {
  readonly prefix?: string;
  readonly cwd?: string;
  readonly workspaceRef?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly envAllowlist?: ReadonlyArray<string>;
}

export interface LocalWorkspaceEnvWithRoot {
  readonly env: WorkspaceEnv;
  readonly rootDir: string;
}

export class LocalWorkspaceEnvError extends Error {
  override readonly name = "LocalWorkspaceEnvError";
}

const DEFAULT_CWD = "/workspace";
const TIMEOUT_EXIT_CODE = 124;

const localError = (message: string): LocalWorkspaceEnvError => new LocalWorkspaceEnvError(message);

const abortErrorFor = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? "workspace operation aborted" : String(reason));
  error.name = "AbortError";
  return error;
};

const checkSignal = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortErrorFor(signal);
};

const normalizeRootDir = (rootDir: string): string => {
  const resolved = path.resolve(rootDir);
  if (resolved.length === path.parse(resolved).root.length) {
    throw localError("local workspace root cannot be filesystem root");
  }
  return resolved;
};

const relativeVirtualPath = (cwd: string, virtualPath: string): string => {
  if (virtualPath === cwd) return "";
  if (!virtualPath.startsWith(`${cwd}/`)) {
    throw localError("workspace path is outside local workspace root");
  }
  return virtualPath.slice(cwd.length + 1);
};

const hostPathFor = (rootDir: string, cwd: string, virtualPath: string): string => {
  const hostPath = path.resolve(rootDir, relativeVirtualPath(cwd, virtualPath));
  if (hostPath !== rootDir && !hostPath.startsWith(`${rootDir}${path.sep}`)) {
    throw localError("workspace path escapes local root");
  }
  return hostPath;
};

const statType = (stat: {
  isFile: () => boolean;
  isDirectory: () => boolean;
}): WorkspaceFileStat["type"] =>
  stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";

const fileStat = async (hostPath: string): Promise<WorkspaceFileStat> => {
  const stat = await fs.stat(hostPath);
  return {
    type: statType(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
};

const truncateUtf8 = (
  bytes: Uint8Array,
  maxOutputBytes: number | undefined,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } => {
  if (maxOutputBytes === undefined || bytes.byteLength <= maxOutputBytes) {
    return { text: new TextDecoder().decode(bytes), bytes: bytes.byteLength, truncated: false };
  }
  return {
    text: new TextDecoder().decode(bytes.slice(0, maxOutputBytes)),
    bytes: bytes.byteLength,
    truncated: true,
  };
};

const appendChunk = (chunks: Uint8Array[], chunk: string | Uint8Array): void => {
  chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
};

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const allowedEnv = (
  source: Readonly<Record<string, string | undefined>>,
  allowlist: ReadonlyArray<string>,
): Record<string, string> => {
  const entries: Array<[string, string]> = [];
  for (const name of allowlist) {
    const value = source[name];
    if (value !== undefined) entries.push([name, value]);
  }
  return Object.fromEntries(entries);
};

const signalAbortPromise = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(abortErrorFor(signal));
      return;
    }
    signal.addEventListener("abort", () => reject(abortErrorFor(signal)), { once: true });
  });

const runLocalCommand = async (
  command: string,
  hostCwd: string,
  sourceEnv: Readonly<Record<string, string | undefined>>,
  envAllowlist: ReadonlyArray<string>,
  options: WorkspaceExecOptions,
): Promise<WorkspaceExecResult> => {
  if (options.envRefs !== undefined && Object.keys(options.envRefs).length > 0) {
    throw localError("local WorkspaceEnv does not resolve symbolic envRefs");
  }
  if (options.materialRefs !== undefined && options.materialRefs.length > 0) {
    throw localError("local WorkspaceEnv does not resolve symbolic materialRefs");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw localError("local WorkspaceEnv exec requires a positive finite timeoutMs");
  }
  checkSignal(options.signal);

  const started = Date.now();
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let timedOut = false;
  let externalAbort = false;

  const child = spawn(command, {
    cwd: hostCwd,
    env: allowedEnv(sourceEnv, envAllowlist),
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const kill = (): void => {
    if (!child.killed) child.kill("SIGTERM");
  };
  const abortListener = (): void => {
    externalAbort = true;
    kill();
  };
  options.signal?.addEventListener("abort", abortListener, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);

  try {
    const result = await Promise.race([
      new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.stdout?.on("data", (chunk: Uint8Array) => appendChunk(stdoutChunks, chunk));
          child.stderr?.on("data", (chunk: Uint8Array) => appendChunk(stderrChunks, chunk));
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      ),
      signalAbortPromise(options.signal),
    ]);
    if (externalAbort) throw abortErrorFor(options.signal!);
    const stdout = truncateUtf8(concatChunks(stdoutChunks), options.maxOutputBytes);
    const stderrBytes = concatChunks(stderrChunks);
    const timeoutMessage = timedOut
      ? new TextEncoder().encode(
          `${stderrBytes.byteLength === 0 ? "" : "\n"}Command timed out after ${options.timeoutMs}ms`,
        )
      : new Uint8Array();
    const stderr = truncateUtf8(
      timeoutMessage.byteLength === 0 ? stderrBytes : concatChunks([stderrBytes, timeoutMessage]),
      options.maxOutputBytes,
    );
    return {
      exitCode: timedOut ? TIMEOUT_EXIT_CODE : (result.code ?? (result.signal === null ? 1 : 128)),
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortListener);
  }
};

const localBackend = (
  rootDir: string,
  cwd: string,
  sourceEnv: Readonly<Record<string, string | undefined>>,
  envAllowlist: ReadonlyArray<string>,
): WorkspaceEnvBackend => ({
  readFile: async (virtualPath, options) => {
    checkSignal(options?.signal);
    const content = await fs.readFile(hostPathFor(rootDir, cwd, virtualPath), "utf8");
    checkSignal(options?.signal);
    return content;
  },
  readFileBuffer: async (virtualPath, options) => {
    checkSignal(options?.signal);
    const content = await fs.readFile(hostPathFor(rootDir, cwd, virtualPath));
    checkSignal(options?.signal);
    return content;
  },
  writeFile: async (virtualPath, content, options) => {
    checkSignal(options?.signal);
    await fs.writeFile(hostPathFor(rootDir, cwd, virtualPath), content);
    checkSignal(options?.signal);
  },
  stat: async (virtualPath, options) => {
    checkSignal(options?.signal);
    const stat = await fileStat(hostPathFor(rootDir, cwd, virtualPath));
    checkSignal(options?.signal);
    return stat;
  },
  readdir: async (virtualPath, options) => {
    checkSignal(options?.signal);
    const entries = await fs.readdir(hostPathFor(rootDir, cwd, virtualPath));
    checkSignal(options?.signal);
    return entries.sort();
  },
  exists: async (virtualPath, options) => {
    checkSignal(options?.signal);
    try {
      await fs.access(hostPathFor(rootDir, cwd, virtualPath));
      checkSignal(options?.signal);
      return true;
    } catch {
      checkSignal(options?.signal);
      return false;
    }
  },
  mkdir: async (virtualPath, options) => {
    checkSignal(options?.signal);
    await fs.mkdir(hostPathFor(rootDir, cwd, virtualPath), {
      recursive: options?.recursive ?? false,
    });
    checkSignal(options?.signal);
  },
  rm: async (virtualPath, options) => {
    checkSignal(options?.signal);
    await fs.rm(hostPathFor(rootDir, cwd, virtualPath), {
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    });
    checkSignal(options?.signal);
  },
  exec: async (command, options) => {
    const hostCwd = hostPathFor(rootDir, cwd, options.cwd ?? cwd);
    await fs.mkdir(hostCwd, { recursive: true });
    return runLocalCommand(command, hostCwd, sourceEnv, envAllowlist, options);
  },
});

export const makeLocalWorkspaceEnv = (options: LocalWorkspaceEnvOptions): WorkspaceEnv => {
  const rootDir = normalizeRootDir(options.rootDir);
  const cwd = options.cwd ?? DEFAULT_CWD;
  const envAllowlist = options.envAllowlist ?? [];
  return createWorkspaceEnv({
    cwd,
    domain: {
      kind: "host",
      ref: options.workspaceRef ?? `local:${rootDir}`,
      envAllowlist,
    },
    backend: localBackend(rootDir, cwd, options.env ?? process.env, envAllowlist),
  });
};

export const makeTemporaryLocalWorkspaceEnv = async (
  options: TemporaryLocalWorkspaceEnvOptions = {},
): Promise<LocalWorkspaceEnvWithRoot> => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix ?? "agent-os-workspace-"));
  return {
    rootDir,
    env: makeLocalWorkspaceEnv({
      rootDir,
      cwd: options.cwd,
      workspaceRef: options.workspaceRef,
      env: options.env,
      envAllowlist: options.envAllowlist,
    }),
  };
};
