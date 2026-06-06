import {
  createWorkspaceEnv,
  type WorkspaceEnv,
  type WorkspaceEnvBackend,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceFileStat,
  type WorkspaceOperationOptions,
} from "@agent-os/workspace-env";

/**
 * Structured-clone-safe subset passed to Cloudflare Sandbox `exec`.
 *
 * This intentionally does not include `AbortSignal`. In-flight `exec`
 * cancellation is non-cooperative for this adapter: caller signals are checked
 * before and after the provider call, while provider interruption must come
 * from Cloudflare timeout/session/process controls.
 */
export interface CloudflareWorkspaceEnvExecOptions {
  readonly cwd?: string;
  readonly timeout?: number;
  readonly timeoutMs?: number;
}

export interface CloudflareWorkspaceEnvExecRawResult {
  readonly exitCode?: number;
  readonly code?: number;
  readonly success?: boolean;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly output?: unknown;
  readonly duration?: number;
  readonly durationMs?: number;
  readonly timestamp?: unknown;
  readonly command?: unknown;
}

export interface CloudflareWorkspaceEnvFileResult {
  readonly content?: unknown;
  readonly text?: unknown;
  readonly data?: unknown;
  readonly bytes?: unknown;
  readonly size?: unknown;
}

export interface CloudflareWorkspaceEnvStatResult {
  readonly type?: unknown;
  readonly isDirectory?: unknown;
  readonly isFile?: unknown;
  readonly size?: unknown;
  readonly mtimeMs?: unknown;
}

export interface CloudflareWorkspaceEnvFileInfo {
  readonly name?: unknown;
  readonly absolutePath?: unknown;
  readonly relativePath?: unknown;
  readonly path?: unknown;
}

export interface CloudflareWorkspaceEnvListFilesResult {
  readonly files?: unknown;
}

export interface CloudflareWorkspaceEnvExistsResult {
  readonly exists?: unknown;
}

export interface CloudflareWorkspaceEnvClient {
  readonly id?: string;
  readonly exec: (
    command: string,
    options?: CloudflareWorkspaceEnvExecOptions,
  ) => Promise<CloudflareWorkspaceEnvExecRawResult>;
  readonly readFile?: (
    path: string,
    options?: { readonly encoding?: "utf-8"; readonly sessionId?: string },
  ) => Promise<CloudflareWorkspaceEnvFileResult | string>;
  readonly readFileBuffer?: (
    path: string,
    options?: { readonly sessionId?: string },
  ) => Promise<Uint8Array>;
  readonly writeFile?: (
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { readonly encoding?: "utf-8"; readonly sessionId?: string },
  ) => Promise<unknown>;
  readonly mkdir?: (
    path: string,
    options?: { readonly recursive?: boolean; readonly sessionId?: string },
  ) => Promise<unknown>;
  readonly rm?: (
    path: string,
    options?: {
      readonly recursive?: boolean;
      readonly force?: boolean;
      readonly sessionId?: string;
    },
  ) => Promise<unknown>;
  readonly deleteFile?: (path: string, sessionId?: string) => Promise<unknown>;
  readonly readdir?: (
    path: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ReadonlyArray<string>>;
  readonly listFiles?: (
    path: string,
    options?: { readonly recursive?: boolean; readonly includeHidden?: boolean },
  ) => Promise<ReadonlyArray<string> | CloudflareWorkspaceEnvListFilesResult>;
  readonly exists?: (
    path: string,
    sessionId?: string,
  ) => Promise<boolean | CloudflareWorkspaceEnvExistsResult>;
  readonly stat?: (
    path: string,
    options?: { readonly sessionId?: string },
  ) => Promise<CloudflareWorkspaceEnvStatResult>;
}

export interface CloudflareWorkspaceEnvOptions {
  readonly client: CloudflareWorkspaceEnvClient;
  readonly cwd?: string;
  readonly workspaceRef?: string;
}

export class CloudflareWorkspaceEnvError extends Error {
  override readonly name = "CloudflareWorkspaceEnvError";
}

const DEFAULT_CWD = "/workspace";

const workspaceError = (message: string): CloudflareWorkspaceEnvError =>
  new CloudflareWorkspaceEnvError(message);

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

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) return "";
  return Object.prototype.toString.call(value);
};

const truncateUtf8 = (
  text: string,
  maxOutputBytes: number | undefined,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } => {
  const bytes = new TextEncoder().encode(text);
  if (maxOutputBytes === undefined || bytes.byteLength <= maxOutputBytes) {
    return { text, bytes: bytes.byteLength, truncated: false };
  }
  return {
    text: new TextDecoder().decode(bytes.slice(0, maxOutputBytes)),
    bytes: bytes.byteLength,
    truncated: true,
  };
};

const normalizeExecResult = (
  raw: CloudflareWorkspaceEnvExecRawResult,
  durationMs: number,
  maxOutputBytes: number | undefined,
): WorkspaceExecResult => {
  const stdoutText = raw.stdout === undefined ? textOf(raw.output) : textOf(raw.stdout);
  const stderrText = textOf(raw.stderr);
  const stdout = truncateUtf8(stdoutText, maxOutputBytes);
  const stderr = truncateUtf8(stderrText, maxOutputBytes);
  return {
    exitCode: raw.exitCode ?? raw.code ?? (raw.success === false ? 1 : 0),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : (raw.duration ?? durationMs),
  };
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const execOrFail = async (
  client: CloudflareWorkspaceEnvClient,
  command: string,
  options: WorkspaceExecOptions,
): Promise<WorkspaceExecResult> => {
  checkSignal(options.signal);
  const started = Date.now();
  const raw = await client.exec(command, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    timeoutMs: options.timeoutMs,
  });
  checkSignal(options.signal);
  return normalizeExecResult(raw, Date.now() - started, options.maxOutputBytes);
};

const readFileResultText = (result: CloudflareWorkspaceEnvFileResult | string): string => {
  if (typeof result === "string") return result;
  return textOf(result.content ?? result.text ?? result.data ?? result.bytes);
};

const providerFileContent = (content: string | Uint8Array): string | ReadableStream<Uint8Array> =>
  content instanceof Uint8Array
    ? new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(content);
          controller.close();
        },
      })
    : content;

const nameOfFileInfo = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return null;
  const file = value as CloudflareWorkspaceEnvFileInfo;
  for (const candidate of [file.name, file.relativePath, file.path, file.absolutePath]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
};

const normalizeListFiles = (
  result: ReadonlyArray<string> | CloudflareWorkspaceEnvListFilesResult,
): ReadonlyArray<string> => {
  const files: unknown = Array.isArray(result)
    ? result
    : (result as CloudflareWorkspaceEnvListFilesResult).files;
  if (!Array.isArray(files)) return [];
  return files
    .map(nameOfFileInfo)
    .filter((entry): entry is string => entry !== null)
    .sort();
};

const normalizeExists = (result: boolean | CloudflareWorkspaceEnvExistsResult): boolean =>
  typeof result === "boolean" ? result : result.exists === true;

const shellStat = async (
  client: CloudflareWorkspaceEnvClient,
  path: string,
  options?: WorkspaceOperationOptions,
): Promise<WorkspaceFileStat> => {
  const result = await execOrFail(
    client,
    [
      `if [ -d ${shellQuote(path)} ]; then`,
      "  echo directory;",
      `elif [ -f ${shellQuote(path)} ]; then`,
      `  size=$(stat -c '%s' ${shellQuote(path)} 2>/dev/null || wc -c < ${shellQuote(
        path,
      )} | tr -d '[:space:]');`,
      `  mtime=$(stat -c '%Y' ${shellQuote(path)} 2>/dev/null || echo);`,
      `  printf 'file\\t%s\\t%s\\n' "$size" "$mtime";`,
      "else",
      "  echo other;",
      "fi",
    ].join(" "),
    {
      timeoutMs: 5_000,
      signal: options?.signal,
      maxOutputBytes: 128,
    },
  );
  const [type, sizeText, mtimeText] = result.stdout.trim().split(/\s+/);
  if (type === "directory") return { type };
  if (type !== "file") return { type: "other" };
  const size = Number(sizeText);
  const mtimeSeconds = Number(mtimeText);
  return {
    type: "file",
    ...(Number.isFinite(size) ? { size } : {}),
    ...(Number.isFinite(mtimeSeconds) ? { mtimeMs: mtimeSeconds * 1000 } : {}),
  };
};

const cloudflareBackend = (client: CloudflareWorkspaceEnvClient): WorkspaceEnvBackend => ({
  readFile: async (path, options) => {
    checkSignal(options?.signal);
    if (client.readFile === undefined) {
      throw workspaceError("Cloudflare workspace client does not expose readFile");
    }
    const result = await client.readFile(path, { encoding: "utf-8" });
    checkSignal(options?.signal);
    return readFileResultText(result);
  },
  readFileBuffer: async (path, options) => {
    checkSignal(options?.signal);
    if (client.readFile === undefined) {
      throw workspaceError("Cloudflare workspace client does not expose readFileBuffer");
    }
    const result = await client.readFile(path, { encoding: "utf-8" });
    checkSignal(options?.signal);
    return new TextEncoder().encode(readFileResultText(result));
  },
  writeFile: async (path, content, options) => {
    checkSignal(options?.signal);
    if (client.writeFile === undefined) {
      throw workspaceError("Cloudflare workspace client does not expose writeFile");
    }
    await client.writeFile(path, providerFileContent(content), { encoding: "utf-8" });
    checkSignal(options?.signal);
  },
  stat: async (path, options) => {
    checkSignal(options?.signal);
    return shellStat(client, path, options);
  },
  readdir: async (path, options) => {
    checkSignal(options?.signal);
    if (client.listFiles !== undefined) {
      const result = await client.listFiles(path);
      checkSignal(options?.signal);
      return normalizeListFiles(result);
    }
    if (client.readdir !== undefined) {
      const result = await client.readdir(path);
      checkSignal(options?.signal);
      return normalizeListFiles(result);
    }
    const result = await execOrFail(
      client,
      `find ${shellQuote(path)} -maxdepth 1 -mindepth 1 -printf '%f\\n'`,
      {
        timeoutMs: 5_000,
        signal: options?.signal,
        maxOutputBytes: 16_384,
      },
    );
    return result.stdout
      .split("\n")
      .filter((entry) => entry.length > 0)
      .sort();
  },
  exists: async (path, options) => {
    checkSignal(options?.signal);
    if (client.exists !== undefined) {
      const result = await client.exists(path);
      checkSignal(options?.signal);
      return normalizeExists(result);
    }
    const result = await execOrFail(client, `test -e ${shellQuote(path)}`, {
      timeoutMs: 5_000,
      signal: options?.signal,
      maxOutputBytes: 128,
    });
    return result.exitCode === 0;
  },
  mkdir: async (path, options) => {
    checkSignal(options?.signal);
    if (client.mkdir !== undefined) {
      await client.mkdir(path, { recursive: options?.recursive });
      checkSignal(options?.signal);
      return;
    }
    await execOrFail(
      client,
      `${options?.recursive === false ? "mkdir" : "mkdir -p"} ${shellQuote(path)}`,
      {
        timeoutMs: 5_000,
        signal: options?.signal,
        maxOutputBytes: 128,
      },
    );
  },
  rm: async (path, options) => {
    checkSignal(options?.signal);
    if (client.rm !== undefined) {
      await client.rm(path, {
        recursive: options?.recursive,
        force: options?.force,
      });
      checkSignal(options?.signal);
      return;
    }
    if (client.deleteFile !== undefined && options?.recursive !== true) {
      await client.deleteFile(path);
      checkSignal(options?.signal);
      return;
    }
    const flags = `${options?.force === true ? "f" : ""}${options?.recursive === true ? "r" : ""}`;
    await execOrFail(client, `rm ${flags.length > 0 ? `-${flags} ` : ""}${shellQuote(path)}`, {
      timeoutMs: 5_000,
      signal: options?.signal,
      maxOutputBytes: 128,
    });
  },
  exec: (command, options) => execOrFail(client, command, options),
});

export const makeCloudflareWorkspaceEnv = (options: CloudflareWorkspaceEnvOptions): WorkspaceEnv =>
  createWorkspaceEnv({
    cwd: options.cwd ?? DEFAULT_CWD,
    domain: {
      kind: "sandbox",
      ref: options.workspaceRef ?? options.client.id ?? "cloudflare-workspace",
    },
    backend: cloudflareBackend(options.client),
  });
