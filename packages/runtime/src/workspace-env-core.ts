import { Effect, Schema } from "effect";
import {
  defineTool,
  externalToolExecution,
  materialRequirement,
  ToolError,
  validateToolRegistry,
  withToolReadRequirement,
  withToolWriteRequirement,
  type ExecutionDomain,
  type MaterialRequirement,
  type Tool,
  type ToolAccess,
  type ToolAdmitter,
} from "@agent-os/core";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_COMMAND_CHARS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  checkSignal,
  failInput,
  isInside,
  normalizeAbsolutePath,
  normalizeToolPathForEnv,
  parentDir,
  relativePath,
  resolveReadFileLineRange,
  textDecoder,
  truncateUtf8,
  utf8Bytes,
} from "./workspace-env-core/path-policy";
import { globWorkspaceFiles, grepWorkspaceFiles } from "./workspace-env-core/file-ops";
export {
  WorkspaceEnvInputError,
  normalizeWorkspaceToolPath,
} from "./workspace-env-core/path-policy";
export {
  diffWorkspaceFiles,
  editWorkspaceFile,
  globWorkspaceFiles,
  grepWorkspaceFiles,
  walkWorkspaceFiles,
} from "./workspace-env-core/file-ops";

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

export type WorkspaceToolCategory = "read" | "mutation" | "shell";

export type WorkspaceToolName = "bash" | "glob" | "grep" | "read_file" | "write_file";

export interface WorkspaceToolSpec {
  readonly name: WorkspaceToolName;
  readonly category: WorkspaceToolCategory;
  readonly access: ToolAccess;
  readonly description: string;
}

export type WorkspaceToolInteractionFloor = "never" | "approval";
export type WorkspaceToolReceiptPolicy = "workspace.snapshot" | "workspace-op.receipt";
export type WorkspaceToolEffect = "workspace_read" | "workspace_mutation";

export interface WorkspaceToolDefaultDeclaration extends WorkspaceToolSpec {
  readonly executionDomain: "workspace";
  readonly interaction: WorkspaceToolInteractionFloor;
  readonly materialRefs: readonly ["workspace"];
  readonly effects: readonly [WorkspaceToolEffect];
  readonly receiptPolicy: WorkspaceToolReceiptPolicy;
}

export type WorkspaceTools = Readonly<Record<WorkspaceToolName, Tool>>;

export interface NormalizeWorkspaceToolPathOptions {
  readonly allowRoot?: boolean;
  readonly cwd?: string;
  readonly label?: string;
}

export interface WorkspaceReadFileResult {
  readonly path: string;
  readonly content: string;
  readonly encoding: "utf-8";
  readonly size: number;
  readonly contentBytes: number;
  readonly truncated: boolean;
  readonly range?: WorkspaceReadFileLineRange;
}

export interface WorkspaceWriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
}

export interface WorkspaceReadFileLineRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
}

export interface WorkspaceBashResult extends WorkspaceExecResult {
  readonly command: string;
  readonly cwd: string;
}

export interface WorkspaceFileSnapshot {
  readonly path: string;
  readonly size?: number;
  readonly mtimeMs?: number;
}

export interface WalkWorkspaceFilesOptions extends WorkspaceOperationOptions {
  readonly root?: string;
  readonly recursive?: boolean;
  readonly includeHidden?: boolean;
}

export interface WorkspaceFilesDiff {
  readonly observedFiles: ReadonlyArray<WorkspaceFileSnapshot>;
  readonly removedPaths: ReadonlyArray<string>;
}

export interface EditWorkspaceFileOptions extends WorkspaceOperationOptions {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
  readonly expectCount?: number;
  readonly maxFileBytes?: number;
}

export interface WorkspaceEditFileResult {
  readonly path: string;
  readonly replacementCount: number;
  readonly bytesWritten: number;
}

export interface GlobWorkspaceFilesOptions extends WorkspaceOperationOptions {
  readonly pattern: string;
  readonly root?: string;
  readonly includeHidden?: boolean;
  readonly maxMatches?: number;
}

export interface WorkspaceGlobFilesResult {
  readonly root: string;
  readonly pattern: string;
  readonly matches: ReadonlyArray<string>;
  readonly truncated: boolean;
  readonly maxMatches: number;
}

export type WorkspaceGrepMode = "literal" | "regex";

export interface GrepWorkspaceFilesOptions extends WorkspaceOperationOptions {
  readonly pattern: string;
  readonly root?: string;
  readonly includeHidden?: boolean;
  readonly mode?: WorkspaceGrepMode;
  readonly maxMatches?: number;
  readonly maxBytesPerMatch?: number;
}

export interface WorkspaceGrepMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
  readonly lineText: string;
  readonly lineTextBytes: number;
  readonly lineTextTruncated: boolean;
  readonly matchText: string;
  readonly matchTextBytes: number;
  readonly matchTextTruncated: boolean;
}

export interface WorkspaceGrepFilesResult {
  readonly root: string;
  readonly pattern: string;
  readonly mode: WorkspaceGrepMode;
  readonly matches: ReadonlyArray<WorkspaceGrepMatch>;
  readonly skippedBinaryPaths: ReadonlyArray<string>;
  readonly truncated: boolean;
  readonly maxMatches: number;
  readonly maxBytesPerMatch: number;
}

const workspaceMaterial = materialRequirement({
  slot: "workspace",
  kind: "external_resource",
  provider: "agent-os",
  resourceKind: "workspace-env",
});

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

const workspaceToolPromise = <A>(
  toolName: string,
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ToolError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ToolError({ toolName, cause }),
  });

interface WorkspaceToolFactoryContext {
  readonly env: WorkspaceEnv;
  readonly common: {
    readonly authority: string;
    readonly authorityId?: string;
    readonly authorityVersion?: string;
    readonly requiredMaterials: ReadonlyArray<MaterialRequirement>;
    readonly admit: ToolAdmitter<unknown>;
  };
  readonly readExecution: ReturnType<typeof externalToolExecution<"read">>;
  readonly writeExecution: ReturnType<typeof externalToolExecution<"write">>;
  readonly maxFileBytes: number;
  readonly maxCommandChars: number;
  readonly execTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly hooks?: WorkspaceToolHooks;
}

interface WorkspaceToolDefinition extends WorkspaceToolSpec {
  readonly define: (context: WorkspaceToolFactoryContext, spec: WorkspaceToolSpec) => Tool;
}

const workspaceToolDefinitions = [
  {
    name: "bash",
    category: "shell",
    access: "write",
    description: "Run one finite shell command in the workspace.",
    define: (
      { env, common, writeExecution, maxCommandChars, execTimeoutMs, maxOutputBytes, hooks },
      spec,
    ) =>
      defineTool({
        name: spec.name,
        description: spec.description,
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
        execution: writeExecution,
        execute: (args) =>
          withToolWriteRequirement(
            workspaceToolPromise(spec.name, async (signal) => {
              const command = args.command.trim();
              if (command.length === 0) return failInput("command required");
              if (command.length > maxCommandChars) {
                return failInput(
                  `command exceeds ${maxCommandChars} character workspace tool limit`,
                );
              }
              const result = await env.exec(command, {
                cwd:
                  args.cwd === undefined
                    ? undefined
                    : normalizeToolPathForEnv(env, args.cwd, "cwd", { allowRoot: true }),
                timeoutMs: args.timeoutMs ?? execTimeoutMs,
                maxOutputBytes,
                signal,
                envRefs:
                  args.envRefs === undefined
                    ? undefined
                    : Object.fromEntries(args.envRefs.map((entry) => [entry.name, entry.ref])),
                materialRefs: args.materialRefs,
              });
              const cwd =
                args.cwd === undefined
                  ? env.cwd
                  : env.resolvePath(
                      normalizeToolPathForEnv(env, args.cwd, "cwd", { allowRoot: true }),
                    );
              await hooks?.onAfterExec?.({
                command,
                cwd: relativePath(env.cwd, cwd),
                exitCode: result.exitCode,
                stdoutBytes: result.stdoutBytes,
                stderrBytes: result.stderrBytes,
                durationMs: result.durationMs,
              });
              return { ...result, command, cwd: relativePath(env.cwd, cwd) };
            }),
          ),
      }),
  },
  {
    name: "glob",
    category: "read",
    access: "read",
    description: "Find workspace files by deterministic slash-separated glob pattern.",
    define: ({ env, common, readExecution }, spec) =>
      defineTool({
        name: spec.name,
        description: spec.description,
        args: Schema.Struct({
          pattern: Schema.String,
          root: Schema.optional(Schema.String),
          includeHidden: Schema.optional(Schema.Boolean),
          maxMatches: Schema.optional(Schema.Number),
        }),
        ...common,
        execution: readExecution,
        execute: (args) =>
          withToolReadRequirement(
            workspaceToolPromise(spec.name, (signal) => {
              return globWorkspaceFiles(env, {
                pattern: args.pattern,
                root:
                  args.root === undefined
                    ? undefined
                    : normalizeToolPathForEnv(env, args.root, "root", { allowRoot: true }),
                includeHidden: args.includeHidden,
                maxMatches: args.maxMatches,
                signal,
              });
            }),
          ),
      }),
  },
  {
    name: "grep",
    category: "read",
    access: "read",
    description: "Search UTF-8 workspace files by literal text or JavaScript regular expression.",
    define: ({ env, common, readExecution }, spec) =>
      defineTool({
        name: spec.name,
        description: spec.description,
        args: Schema.Struct({
          pattern: Schema.String,
          root: Schema.optional(Schema.String),
          includeHidden: Schema.optional(Schema.Boolean),
          mode: Schema.optional(Schema.Literals(["literal", "regex"])),
          maxMatches: Schema.optional(Schema.Number),
          maxBytesPerMatch: Schema.optional(Schema.Number),
        }),
        ...common,
        execution: readExecution,
        execute: (args) =>
          withToolReadRequirement(
            workspaceToolPromise(spec.name, (signal) => {
              return grepWorkspaceFiles(env, {
                pattern: args.pattern,
                root:
                  args.root === undefined
                    ? undefined
                    : normalizeToolPathForEnv(env, args.root, "root", { allowRoot: true }),
                includeHidden: args.includeHidden,
                mode: args.mode,
                maxMatches: args.maxMatches,
                maxBytesPerMatch: args.maxBytesPerMatch,
                signal,
              });
            }),
          ),
      }),
  },
  {
    name: "read_file",
    category: "read",
    access: "read",
    description:
      "Read one UTF-8 file or 1-based line range from the workspace. Path is workspace-relative or workspace-virtual absolute; do not include the host workspace root.",
    define: ({ env, common, readExecution, maxFileBytes }, spec) =>
      defineTool({
        name: spec.name,
        description: spec.description,
        args: Schema.Struct({
          path: Schema.String,
          startLine: Schema.optional(Schema.Number),
          endLine: Schema.optional(Schema.Number),
        }),
        ...common,
        execution: readExecution,
        execute: (args) =>
          withToolReadRequirement(
            workspaceToolPromise(spec.name, async (signal) => {
              const path = env.resolvePath(normalizeToolPathForEnv(env, args.path, "path"));
              const bytes = await env.readFileBuffer(path, { signal });
              const content = textDecoder.decode(bytes);
              const range = resolveReadFileLineRange(content, args.startLine, args.endLine);
              const selected =
                range === undefined ? content : content.slice(range.startOffset, range.endOffset);
              const preview = truncateUtf8(selected, maxFileBytes);
              return {
                path: relativePath(env.cwd, path),
                content: preview.text,
                encoding: "utf-8",
                size: bytes.byteLength,
                contentBytes: preview.bytes,
                truncated: preview.truncated,
                ...(range === undefined
                  ? {}
                  : {
                      range: {
                        startLine: range.startLine,
                        endLine: range.endLine,
                        totalLines: range.totalLines,
                      },
                    }),
              };
            }),
          ),
      }),
  },
  {
    name: "write_file",
    category: "mutation",
    access: "write",
    description:
      "Create or overwrite one UTF-8 workspace file with complete content. Path is workspace-relative or workspace-virtual absolute; do not include the host workspace root.",
    define: ({ env, common, writeExecution, maxFileBytes, hooks }, spec) =>
      defineTool({
        name: spec.name,
        description: spec.description,
        args: Schema.Struct({ path: Schema.String, content: Schema.String }),
        ...common,
        execution: writeExecution,
        execute: (args) =>
          withToolWriteRequirement(
            workspaceToolPromise(spec.name, async (signal) => {
              const path = env.resolvePath(normalizeToolPathForEnv(env, args.path, "path"));
              const bytes = utf8Bytes(args.content);
              if (bytes > maxFileBytes) {
                return failInput(`file exceeds ${maxFileBytes} byte workspace tool limit`);
              }
              await env.writeFile(path, args.content, { signal });
              await hooks?.onAfterWrite?.({ path: relativePath(env.cwd, path), bytes });
              return { path: relativePath(env.cwd, path), bytesWritten: bytes };
            }),
          ),
      }),
  },
] as const satisfies ReadonlyArray<WorkspaceToolDefinition>;

export const WORKSPACE_TOOL_SPECS: ReadonlyArray<WorkspaceToolSpec> = workspaceToolDefinitions.map(
  ({ name, category, access, description }) => ({
    name,
    category,
    access,
    description,
  }),
);

const workspaceToolEffectFor = (category: WorkspaceToolCategory): WorkspaceToolEffect =>
  category === "read" ? "workspace_read" : "workspace_mutation";

const workspaceToolReceiptPolicyFor = (
  category: WorkspaceToolCategory,
): WorkspaceToolReceiptPolicy =>
  category === "read" ? "workspace.snapshot" : "workspace-op.receipt";

const workspaceToolInteractionFloorFor = (
  _category: WorkspaceToolCategory,
): WorkspaceToolInteractionFloor => "never";

export const WORKSPACE_TOOL_DEFAULT_DECLARATIONS: ReadonlyArray<WorkspaceToolDefaultDeclaration> =
  WORKSPACE_TOOL_SPECS.map((spec) => ({
    ...spec,
    executionDomain: "workspace",
    interaction: workspaceToolInteractionFloorFor(spec.category),
    materialRefs: ["workspace"],
    effects: [workspaceToolEffectFor(spec.category)],
    receiptPolicy: workspaceToolReceiptPolicyFor(spec.category),
  }));

export const WORKSPACE_TOOL_NAMES: ReadonlyArray<WorkspaceToolName> =
  WORKSPACE_TOOL_DEFAULT_DECLARATIONS.map((tool) => tool.name);

export const WORKSPACE_TOOL_EXPOSURE_PROFILES: Readonly<
  Record<WorkspaceToolCategory, ReadonlyArray<WorkspaceToolName>>
> = {
  read: WORKSPACE_TOOL_DEFAULT_DECLARATIONS.filter((tool) => tool.category === "read").map(
    (tool) => tool.name,
  ),
  mutation: WORKSPACE_TOOL_DEFAULT_DECLARATIONS.filter((tool) => tool.category === "mutation").map(
    (tool) => tool.name,
  ),
  shell: WORKSPACE_TOOL_DEFAULT_DECLARATIONS.filter((tool) => tool.category === "shell").map(
    (tool) => tool.name,
  ),
};

export const createWorkspaceTools = (
  env: WorkspaceEnv,
  options: CreateWorkspaceToolsOptions,
): WorkspaceTools => {
  const requiredMaterials = options.requiredMaterials ?? [workspaceMaterial];
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxCommandChars = options.maxCommandChars ?? DEFAULT_MAX_COMMAND_CHARS;
  const execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const readExecution = externalToolExecution("read", env.domain);
  const writeExecution = externalToolExecution("write", env.domain);
  const common = {
    authority: options.authority,
    ...(options.authorityId === undefined ? {} : { authorityId: options.authorityId }),
    ...(options.authorityVersion === undefined
      ? {}
      : { authorityVersion: options.authorityVersion }),
    requiredMaterials,
    admit: options.admit,
  } as const;

  const context = {
    env,
    common,
    readExecution,
    writeExecution,
    maxFileBytes,
    maxCommandChars,
    execTimeoutMs,
    maxOutputBytes,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  } satisfies WorkspaceToolFactoryContext;

  const tools = Object.fromEntries(
    workspaceToolDefinitions.map((definition) => [
      definition.name,
      definition.define(context, definition),
    ]),
  ) as Record<WorkspaceToolName, Tool>;

  const validation = validateToolRegistry(tools);
  if (!validation.ok) {
    throw new TypeError(`workspace tool registry invalid: ${JSON.stringify(validation.issues)}`);
  }
  return tools;
};
