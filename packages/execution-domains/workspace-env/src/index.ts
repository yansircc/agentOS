import { Schema } from "effect";
import {
  defineTool,
  effectfulToolExecution,
  materialRequirement,
  validateToolRegistry,
  type ExecutionDomain,
  type MaterialRequirement,
  type Tool,
  type ToolAdmitter,
} from "@agent-os/kernel";

export class WorkspaceEnvInputError extends Error {
  override readonly name = "WorkspaceEnvInputError";
}

export interface WorkspaceFileStat {
  readonly type: "file" | "directory" | "other";
  readonly size?: number;
  readonly mtimeMs?: number;
}

export interface WorkspaceExecOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly envRefs?: Readonly<Record<string, string>>;
  readonly materialRefs?: ReadonlyArray<string>;
}

export interface WorkspaceToolEnvRef {
  readonly name: string;
  readonly ref: string;
}

export interface WorkspaceExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

export interface WorkspaceOperationOptions {
  readonly signal?: AbortSignal;
}

export interface WorkspaceEnv {
  readonly domain: ExecutionDomain;
  readonly cwd: string;
  readonly resolvePath: (path: string) => string;
  readonly readFile: (path: string, options?: WorkspaceOperationOptions) => Promise<string>;
  readonly readFileBuffer: (
    path: string,
    options?: WorkspaceOperationOptions,
  ) => Promise<Uint8Array>;
  readonly writeFile: (
    path: string,
    content: string | Uint8Array,
    options?: WorkspaceOperationOptions,
  ) => Promise<void>;
  readonly stat: (path: string, options?: WorkspaceOperationOptions) => Promise<WorkspaceFileStat>;
  readonly readdir: (
    path: string,
    options?: WorkspaceOperationOptions,
  ) => Promise<ReadonlyArray<string>>;
  readonly exists: (path: string, options?: WorkspaceOperationOptions) => Promise<boolean>;
  readonly mkdir: (
    path: string,
    options?: WorkspaceOperationOptions & { readonly recursive?: boolean },
  ) => Promise<void>;
  readonly rm: (
    path: string,
    options?: WorkspaceOperationOptions & {
      readonly recursive?: boolean;
      readonly force?: boolean;
    },
  ) => Promise<void>;
  readonly exec: (command: string, options: WorkspaceExecOptions) => Promise<WorkspaceExecResult>;
}

export interface WorkspaceEnvBackend {
  readonly readFile: (path: string, options?: WorkspaceOperationOptions) => Promise<string>;
  readonly readFileBuffer: (
    path: string,
    options?: WorkspaceOperationOptions,
  ) => Promise<Uint8Array>;
  readonly writeFile: (
    path: string,
    content: string | Uint8Array,
    options?: WorkspaceOperationOptions,
  ) => Promise<void>;
  readonly stat: (path: string, options?: WorkspaceOperationOptions) => Promise<WorkspaceFileStat>;
  readonly readdir: (
    path: string,
    options?: WorkspaceOperationOptions,
  ) => Promise<ReadonlyArray<string>>;
  readonly exists: (path: string, options?: WorkspaceOperationOptions) => Promise<boolean>;
  readonly mkdir: (
    path: string,
    options?: WorkspaceOperationOptions & { readonly recursive?: boolean },
  ) => Promise<void>;
  readonly rm: (
    path: string,
    options?: WorkspaceOperationOptions & {
      readonly recursive?: boolean;
      readonly force?: boolean;
    },
  ) => Promise<void>;
  readonly exec: (command: string, options: WorkspaceExecOptions) => Promise<WorkspaceExecResult>;
}

export interface CreateWorkspaceEnvOptions {
  readonly domain: ExecutionDomain;
  readonly cwd: string;
  readonly backend: WorkspaceEnvBackend;
}

export interface WorkspaceToolWriteHookInput {
  readonly path: string;
  readonly bytes: number;
}

export interface WorkspaceToolDeleteHookInput {
  readonly path: string;
}

export interface WorkspaceToolExecHookInput {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly durationMs: number;
}

export interface WorkspaceToolHooks {
  readonly onAfterWrite?: (input: WorkspaceToolWriteHookInput) => void | Promise<void>;
  readonly onAfterDelete?: (input: WorkspaceToolDeleteHookInput) => void | Promise<void>;
  readonly onAfterExec?: (input: WorkspaceToolExecHookInput) => void | Promise<void>;
}

export interface CreateWorkspaceToolsOptions {
  readonly authority: string;
  readonly admit: ToolAdmitter<unknown>;
  readonly authorityId?: string;
  readonly authorityVersion?: string;
  readonly requiredMaterials?: ReadonlyArray<MaterialRequirement>;
  readonly maxFileBytes?: number;
  readonly maxCommandChars?: number;
  readonly execTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly hooks?: WorkspaceToolHooks;
}

export interface WorkspaceReadFileResult {
  readonly path: string;
  readonly content: string;
  readonly encoding: "utf-8";
  readonly size: number;
}

export interface WorkspaceWriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
}

export interface WorkspaceListFilesResult {
  readonly path: string;
  readonly entries: ReadonlyArray<string>;
}

export interface WorkspaceDeletePathResult {
  readonly path: string;
  readonly deleted: true;
}

export interface WorkspaceRunShellResult extends WorkspaceExecResult {
  readonly command: string;
  readonly cwd: string;
}

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_COMMAND_CHARS = 2_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16_384;

const workspaceMaterial = materialRequirement({
  slot: "workspace",
  kind: "external_resource",
  provider: "agent-os",
  resourceKind: "workspace-env",
});

const abortErrorFor = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? "workspace operation aborted" : String(reason));
  error.name = "AbortError";
  return error;
};

const checkSignal = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw abortErrorFor(signal);
  }
};

const failInput = (message: string): never => {
  throw new WorkspaceEnvInputError(message);
};

const normalizeAbsolutePath = (input: string): string => {
  const trimmed = input.trim().replaceAll("\\", "/");
  if (!trimmed.startsWith("/")) {
    return failInput("absolute workspace path required");
  }
  if (trimmed.includes("\0")) {
    return failInput("workspace path cannot contain NUL");
  }
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      return failInput("workspace path cannot escape root");
    }
    parts.push(part);
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
};

const isInside = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}/`);

const parentDir = (root: string, path: string): string => {
  const index = path.lastIndexOf("/");
  if (index <= root.length) return root;
  return path.slice(0, index);
};

const relativePath = (root: string, path: string): string =>
  path === root ? "." : path.slice(root.length + 1);

const utf8Bytes = (value: string | Uint8Array): number =>
  value instanceof Uint8Array ? value.byteLength : new TextEncoder().encode(value).byteLength;

export const createWorkspaceEnv = (options: CreateWorkspaceEnvOptions): WorkspaceEnv => {
  const cwd = normalizeAbsolutePath(options.cwd);
  const resolvePath = (input: string): string => {
    const normalized = input.trim().replaceAll("\\", "/");
    if (normalized.length === 0) return failInput("workspace path required");
    if (normalized.includes("\0")) return failInput("workspace path cannot contain NUL");
    if (normalized === "." || normalized === "./") return cwd;
    if (normalized.startsWith("/")) {
      const absolute = normalizeAbsolutePath(normalized);
      return isInside(cwd, absolute) ? absolute : failInput("workspace path cannot escape root");
    }
    const parts = normalized.replace(/^\.\/+/, "").split("/");
    if (parts.some((part) => part === "..")) {
      return failInput("workspace path cannot escape root");
    }
    const relative = parts.filter((part) => part.length > 0 && part !== ".").join("/");
    return relative.length === 0 ? cwd : `${cwd}/${relative}`;
  };

  return {
    domain: options.domain,
    cwd,
    resolvePath,
    readFile: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return options.backend.readFile(resolvePath(path), operationOptions);
    },
    readFileBuffer: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return options.backend.readFileBuffer(resolvePath(path), operationOptions);
    },
    writeFile: async (path, content, operationOptions) => {
      checkSignal(operationOptions?.signal);
      const resolved = resolvePath(path);
      await options.backend.mkdir(parentDir(cwd, resolved), {
        recursive: true,
        signal: operationOptions?.signal,
      });
      checkSignal(operationOptions?.signal);
      await options.backend.writeFile(resolved, content, operationOptions);
      checkSignal(operationOptions?.signal);
    },
    stat: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return options.backend.stat(resolvePath(path), operationOptions);
    },
    readdir: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return options.backend.readdir(resolvePath(path), operationOptions);
    },
    exists: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return options.backend.exists(resolvePath(path), operationOptions);
    },
    mkdir: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return options.backend.mkdir(resolvePath(path), operationOptions);
    },
    rm: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      await options.backend.rm(resolvePath(path), operationOptions);
      checkSignal(operationOptions?.signal);
    },
    exec: async (command, execOptions) => {
      checkSignal(execOptions.signal);
      const cwdPath = execOptions.cwd === undefined ? cwd : resolvePath(execOptions.cwd);
      const result = await options.backend.exec(command, { ...execOptions, cwd: cwdPath });
      checkSignal(execOptions.signal);
      return result;
    },
  };
};

export const createWorkspaceTools = (
  env: WorkspaceEnv,
  options: CreateWorkspaceToolsOptions,
): Record<string, Tool> => {
  const requiredMaterials = options.requiredMaterials ?? [workspaceMaterial];
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxCommandChars = options.maxCommandChars ?? DEFAULT_MAX_COMMAND_CHARS;
  const execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const execution = effectfulToolExecution(env.domain);
  const common = {
    authority: options.authority,
    ...(options.authorityId === undefined ? {} : { authorityId: options.authorityId }),
    ...(options.authorityVersion === undefined
      ? {}
      : { authorityVersion: options.authorityVersion }),
    requiredMaterials,
    admit: options.admit,
    execution,
  } as const;

  const tools: Record<string, Tool> = {
    read_file: defineTool({
      name: "read_file",
      description: "Read one UTF-8 file from the workspace.",
      args: Schema.Struct({ path: Schema.String }),
      ...common,
      execute: async (args, ctx): Promise<WorkspaceReadFileResult> => {
        const path = env.resolvePath(args.path);
        const content = await env.readFile(path, { signal: ctx.signal });
        return {
          path: relativePath(env.cwd, path),
          content,
          encoding: "utf-8",
          size: utf8Bytes(content),
        };
      },
    }),
    write_file: defineTool({
      name: "write_file",
      description: "Create or overwrite one UTF-8 workspace file with complete content.",
      args: Schema.Struct({ path: Schema.String, content: Schema.String }),
      ...common,
      execute: async (args, ctx): Promise<WorkspaceWriteFileResult> => {
        const path = env.resolvePath(args.path);
        const bytes = utf8Bytes(args.content);
        if (bytes > maxFileBytes) {
          return failInput(`file exceeds ${maxFileBytes} byte workspace tool limit`);
        }
        await env.writeFile(path, args.content, { signal: ctx.signal });
        await options.hooks?.onAfterWrite?.({ path: relativePath(env.cwd, path), bytes });
        return { path: relativePath(env.cwd, path), bytesWritten: bytes };
      },
    }),
    list_files: defineTool({
      name: "list_files",
      description: "List immediate entries in one workspace directory.",
      args: Schema.Struct({ path: Schema.optional(Schema.String) }),
      ...common,
      execute: async (args, ctx): Promise<WorkspaceListFilesResult> => {
        const path = env.resolvePath(args.path ?? ".");
        const entries = await env.readdir(path, { signal: ctx.signal });
        return { path: relativePath(env.cwd, path), entries };
      },
    }),
    delete_path: defineTool({
      name: "delete_path",
      description: "Delete one workspace path.",
      args: Schema.Struct({
        path: Schema.String,
        recursive: Schema.optional(Schema.Boolean),
        force: Schema.optional(Schema.Boolean),
      }),
      ...common,
      execute: async (args, ctx): Promise<WorkspaceDeletePathResult> => {
        const path = env.resolvePath(args.path);
        await env.rm(path, {
          recursive: args.recursive ?? false,
          force: args.force ?? false,
          signal: ctx.signal,
        });
        await options.hooks?.onAfterDelete?.({ path: relativePath(env.cwd, path) });
        return { path: relativePath(env.cwd, path), deleted: true };
      },
    }),
    run_shell: defineTool({
      name: "run_shell",
      description: "Run one finite shell command in the workspace.",
      args: Schema.Struct({
        command: Schema.String,
        cwd: Schema.optional(Schema.String),
        timeoutMs: Schema.optional(Schema.Number),
        envRefs: Schema.optional(
          Schema.Array(Schema.Struct({ name: Schema.String, ref: Schema.String })),
        ),
        materialRefs: Schema.optional(Schema.Array(Schema.String)),
      }),
      ...common,
      execute: async (args, ctx): Promise<WorkspaceRunShellResult> => {
        const command = args.command.trim();
        if (command.length === 0) return failInput("command required");
        if (command.length > maxCommandChars) {
          return failInput(`command exceeds ${maxCommandChars} character workspace tool limit`);
        }
        const result = await env.exec(command, {
          cwd: args.cwd,
          timeoutMs: args.timeoutMs ?? execTimeoutMs,
          maxOutputBytes,
          signal: ctx.signal,
          envRefs:
            args.envRefs === undefined
              ? undefined
              : Object.fromEntries(args.envRefs.map((entry) => [entry.name, entry.ref])),
          materialRefs: args.materialRefs,
        });
        const cwd = args.cwd === undefined ? env.cwd : env.resolvePath(args.cwd);
        await options.hooks?.onAfterExec?.({
          command,
          cwd: relativePath(env.cwd, cwd),
          exitCode: result.exitCode,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          durationMs: result.durationMs,
        });
        return { ...result, command, cwd: relativePath(env.cwd, cwd) };
      },
    }),
  };

  const validation = validateToolRegistry(tools);
  if (!validation.ok) {
    throw new TypeError(`workspace tool registry invalid: ${JSON.stringify(validation.issues)}`);
  }
  return tools;
};
