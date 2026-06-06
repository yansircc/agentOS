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
  readonly contentBytes: number;
  readonly truncated: boolean;
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

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_COMMAND_CHARS = 2_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16_384;
const DEFAULT_MAX_SEARCH_MATCHES = 100;
const DEFAULT_MAX_BYTES_PER_MATCH = 4_096;

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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const utf8Bytes = (value: string | Uint8Array): number =>
  value instanceof Uint8Array ? value.byteLength : textEncoder.encode(value).byteLength;

const truncateUtf8 = (
  value: string,
  maxBytes: number,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } => {
  let text = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = utf8Bytes(char);
    if (bytes + charBytes > maxBytes) {
      return { text, bytes, truncated: true };
    }
    text += char;
    bytes += charBytes;
  }
  return { text, bytes, truncated: false };
};

const requirePositiveInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value <= 0 || !Number.isFinite(value)) {
    return failInput(`${label} must be a finite positive integer`);
  }
  return value;
};

const normalizedRelativePath = (
  input: string,
  label: string,
  options: { readonly allowRoot?: boolean } = {},
): string => {
  const trimmed = input.trim().replaceAll("\\", "/");
  if (trimmed.length === 0) return failInput(`${label} required`);
  if (trimmed.includes("\0")) return failInput(`${label} cannot contain NUL`);
  if (trimmed.startsWith("/")) return failInput(`${label} must be relative`);
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") return failInput(`${label} cannot escape root`);
    parts.push(part);
  }
  if (parts.length === 0) {
    return options.allowRoot === true ? "." : failInput(`${label} cannot be workspace root`);
  }
  return parts.join("/");
};

const hiddenPath = (path: string): boolean =>
  path !== "." && path.split("/").some((part) => part.startsWith("."));

const validDirectoryEntry = (entry: string): string => {
  if (
    entry.length === 0 ||
    entry === "." ||
    entry === ".." ||
    entry.includes("/") ||
    entry.includes("\\") ||
    entry.includes("\0")
  ) {
    return failInput(`workspace provider returned invalid directory entry: ${entry}`);
  }
  return entry;
};

const joinAbsolutePath = (directory: string, entry: string): string =>
  directory === "/" ? `/${entry}` : `${directory}/${entry}`;

const snapshotFor = (path: string, stat: WorkspaceFileStat): WorkspaceFileSnapshot => ({
  path,
  ...(stat.size === undefined ? {} : { size: stat.size }),
  ...(stat.mtimeMs === undefined ? {} : { mtimeMs: stat.mtimeMs }),
});

const rootRelativePath = (env: WorkspaceEnv, root: string, path: string): string => {
  const rootRelative = relativePath(env.cwd, root);
  if (rootRelative === ".") return path;
  if (path === rootRelative) {
    const parts = path.split("/");
    return parts[parts.length - 1] ?? path;
  }
  return path.slice(rootRelative.length + 1);
};

const normalizeGlobPattern = (pattern: string): ReadonlyArray<string> => {
  const normalized = pattern
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (normalized.length === 0) return failInput("glob pattern required");
  if (normalized.includes("\0")) return failInput("glob pattern cannot contain NUL");
  if (normalized.startsWith("/")) return failInput("glob pattern must be relative");
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return failInput("glob pattern required");
  if (segments.some((segment) => segment === "..")) {
    return failInput("glob pattern cannot escape root");
  }
  return segments;
};

const regexEscape = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const globSegmentMatches = (pattern: string, segment: string): boolean => {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else regex += regexEscape(char);
  }
  regex += "$";
  return new RegExp(regex).test(segment);
};

const globMatches = (
  patternSegments: ReadonlyArray<string>,
  pathSegments: ReadonlyArray<string>,
): boolean => {
  const matchFrom = (patternIndex: number, pathIndex: number): boolean => {
    if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
    const pattern = patternSegments[patternIndex];
    if (pattern === "**") {
      if (patternIndex === patternSegments.length - 1) return true;
      for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex++) {
        if (matchFrom(patternIndex + 1, nextPathIndex)) return true;
      }
      return false;
    }
    if (pathIndex >= pathSegments.length) return false;
    return (
      globSegmentMatches(pattern, pathSegments[pathIndex]) &&
      matchFrom(patternIndex + 1, pathIndex + 1)
    );
  };
  return matchFrom(0, 0);
};

const regexpForGrep = (pattern: string): RegExp => {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch (cause) {
    return failInput(
      `invalid regex pattern: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (regex.exec("")?.[0] === "") {
    return failInput("regex pattern cannot match empty text");
  }
  return regex;
};

const containsNulByte = (bytes: Uint8Array): boolean => bytes.includes(0);

export const walkWorkspaceFiles = async (
  env: WorkspaceEnv,
  options: WalkWorkspaceFilesOptions = {},
): Promise<ReadonlyArray<WorkspaceFileSnapshot>> => {
  const root = env.resolvePath(options.root ?? ".");
  const recursive = options.recursive ?? true;
  const includeHidden = options.includeHidden ?? false;
  const snapshots: WorkspaceFileSnapshot[] = [];

  const visit = async (path: string): Promise<void> => {
    checkSignal(options.signal);
    const rel = relativePath(env.cwd, path);
    if (!includeHidden && hiddenPath(rel)) return;
    const stat = await env.stat(path, { signal: options.signal });
    checkSignal(options.signal);
    if (stat.type === "file") {
      snapshots.push(snapshotFor(rel, stat));
      return;
    }
    if (stat.type !== "directory") return;

    const entries = [...(await env.readdir(path, { signal: options.signal }))]
      .map(validDirectoryEntry)
      .sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      const child = joinAbsolutePath(path, entry);
      const childRel = relativePath(env.cwd, child);
      if (!includeHidden && hiddenPath(childRel)) continue;
      const childStat = await env.stat(child, { signal: options.signal });
      checkSignal(options.signal);
      if (childStat.type === "file") {
        snapshots.push(snapshotFor(childRel, childStat));
      } else if (childStat.type === "directory" && recursive) {
        await visit(child);
      }
    }
  };

  await visit(root);
  return snapshots.sort((a, b) => a.path.localeCompare(b.path));
};

export const diffWorkspaceFiles = (
  previousPaths: ReadonlyArray<string>,
  currentFiles: ReadonlyArray<WorkspaceFileSnapshot>,
): WorkspaceFilesDiff => {
  const previous = new Set(
    previousPaths.map((path) => normalizedRelativePath(path, "previous workspace path")),
  );
  const seenCurrent = new Set<string>();
  const observedFiles = currentFiles
    .map((file) => {
      const path = normalizedRelativePath(file.path, "current workspace path");
      if (seenCurrent.has(path)) return failInput(`duplicate current workspace path: ${path}`);
      seenCurrent.add(path);
      return {
        path,
        ...(file.size === undefined ? {} : { size: file.size }),
        ...(file.mtimeMs === undefined ? {} : { mtimeMs: file.mtimeMs }),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const removedPaths = [...previous]
    .filter((path) => !seenCurrent.has(path))
    .sort((a, b) => a.localeCompare(b));
  return { observedFiles, removedPaths };
};

export const editWorkspaceFile = async (
  env: WorkspaceEnv,
  options: EditWorkspaceFileOptions,
): Promise<WorkspaceEditFileResult> => {
  if (options.oldString.length === 0) return failInput("oldString must be non-empty");
  const expectCount = requirePositiveInteger(options.expectCount ?? 1, "expectCount");
  const path = env.resolvePath(options.path);
  const content = await env.readFile(path, { signal: options.signal });
  const pieces = content.split(options.oldString);
  const replacementCount = pieces.length - 1;
  if (replacementCount !== expectCount) {
    return failInput(`expected ${expectCount} replacement(s), found ${replacementCount}`);
  }
  const next = pieces.join(options.newString);
  const bytes = utf8Bytes(next);
  if (options.maxFileBytes !== undefined && bytes > options.maxFileBytes) {
    return failInput(`file exceeds ${options.maxFileBytes} byte workspace tool limit`);
  }
  await env.writeFile(path, next, { signal: options.signal });
  return { path: relativePath(env.cwd, path), replacementCount, bytesWritten: bytes };
};

export const globWorkspaceFiles = async (
  env: WorkspaceEnv,
  options: GlobWorkspaceFilesOptions,
): Promise<WorkspaceGlobFilesResult> => {
  const root = env.resolvePath(options.root ?? ".");
  const maxMatches = requirePositiveInteger(
    options.maxMatches ?? DEFAULT_MAX_SEARCH_MATCHES,
    "maxMatches",
  );
  const patternSegments = normalizeGlobPattern(options.pattern);
  const files = await walkWorkspaceFiles(env, {
    root,
    recursive: true,
    includeHidden: options.includeHidden ?? false,
    signal: options.signal,
  });
  const matches: string[] = [];
  let truncated = false;
  for (const file of files) {
    const matchPath = rootRelativePath(env, root, file.path);
    if (!globMatches(patternSegments, matchPath.split("/"))) continue;
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    matches.push(file.path);
  }
  return {
    root: relativePath(env.cwd, root),
    pattern: options.pattern,
    matches,
    truncated,
    maxMatches,
  };
};

export const grepWorkspaceFiles = async (
  env: WorkspaceEnv,
  options: GrepWorkspaceFilesOptions,
): Promise<WorkspaceGrepFilesResult> => {
  const root = env.resolvePath(options.root ?? ".");
  const mode = options.mode ?? "literal";
  if (mode !== "literal" && mode !== "regex")
    return failInput("grep mode must be literal or regex");
  if (options.pattern.length === 0) return failInput("grep pattern required");
  const maxMatches = requirePositiveInteger(
    options.maxMatches ?? DEFAULT_MAX_SEARCH_MATCHES,
    "maxMatches",
  );
  const maxBytesPerMatch = requirePositiveInteger(
    options.maxBytesPerMatch ?? DEFAULT_MAX_BYTES_PER_MATCH,
    "maxBytesPerMatch",
  );
  const regex = mode === "regex" ? regexpForGrep(options.pattern) : undefined;
  const files = await walkWorkspaceFiles(env, {
    root,
    recursive: true,
    includeHidden: options.includeHidden ?? false,
    signal: options.signal,
  });
  const matches: WorkspaceGrepMatch[] = [];
  const skippedBinaryPaths: string[] = [];
  let truncated = false;

  const pushMatch = (
    path: string,
    line: string,
    lineNumber: number,
    index: number,
    matchText: string,
  ): boolean => {
    if (matches.length >= maxMatches) {
      truncated = true;
      return false;
    }
    const linePreview = truncateUtf8(line, maxBytesPerMatch);
    const matchPreview = truncateUtf8(matchText, maxBytesPerMatch);
    matches.push({
      path,
      lineNumber,
      columnNumber: index + 1,
      lineText: linePreview.text,
      lineTextBytes: linePreview.bytes,
      lineTextTruncated: linePreview.truncated,
      matchText: matchPreview.text,
      matchTextBytes: matchPreview.bytes,
      matchTextTruncated: matchPreview.truncated,
    });
    return true;
  };

  for (const file of files) {
    checkSignal(options.signal);
    const bytes = await env.readFileBuffer(file.path, { signal: options.signal });
    if (containsNulByte(bytes)) {
      skippedBinaryPaths.push(file.path);
      continue;
    }
    const content = textDecoder.decode(bytes);
    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? "";
      if (mode === "literal") {
        let index = line.indexOf(options.pattern);
        while (index >= 0) {
          if (!pushMatch(file.path, line, lineIndex + 1, index, options.pattern)) break;
          index = line.indexOf(options.pattern, index + options.pattern.length);
        }
      } else if (regex !== undefined) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
          const matchText = match[0];
          if (matchText.length === 0) return failInput("regex pattern cannot match empty text");
          if (!pushMatch(file.path, line, lineIndex + 1, match.index, matchText)) break;
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  return {
    root: relativePath(env.cwd, root),
    pattern: options.pattern,
    mode,
    matches,
    skippedBinaryPaths,
    truncated,
    maxMatches,
    maxBytesPerMatch,
  };
};

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
        const bytes = await env.readFileBuffer(path, { signal: ctx.signal });
        const preview = truncateUtf8(textDecoder.decode(bytes), maxFileBytes);
        return {
          path: relativePath(env.cwd, path),
          content: preview.text,
          encoding: "utf-8",
          size: bytes.byteLength,
          contentBytes: preview.bytes,
          truncated: preview.truncated,
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
    edit_file: defineTool({
      name: "edit_file",
      description:
        "Replace exact UTF-8 text in one workspace file with explicit match-count semantics.",
      args: Schema.Struct({
        path: Schema.String,
        oldString: Schema.String,
        newString: Schema.String,
        expectCount: Schema.optional(Schema.Number),
      }),
      ...common,
      execute: async (args, ctx): Promise<WorkspaceEditFileResult> => {
        const result = await editWorkspaceFile(env, {
          path: args.path,
          oldString: args.oldString,
          newString: args.newString,
          expectCount: args.expectCount,
          maxFileBytes,
          signal: ctx.signal,
        });
        await options.hooks?.onAfterWrite?.({ path: result.path, bytes: result.bytesWritten });
        return result;
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
    glob_files: defineTool({
      name: "glob_files",
      description: "Find workspace files by deterministic slash-separated glob pattern.",
      args: Schema.Struct({
        pattern: Schema.String,
        root: Schema.optional(Schema.String),
        includeHidden: Schema.optional(Schema.Boolean),
        maxMatches: Schema.optional(Schema.Number),
      }),
      ...common,
      execute: (args, ctx): Promise<WorkspaceGlobFilesResult> =>
        globWorkspaceFiles(env, {
          pattern: args.pattern,
          root: args.root,
          includeHidden: args.includeHidden,
          maxMatches: args.maxMatches,
          signal: ctx.signal,
        }),
    }),
    grep_files: defineTool({
      name: "grep_files",
      description: "Search UTF-8 workspace files by literal text or JavaScript regular expression.",
      args: Schema.Struct({
        pattern: Schema.String,
        root: Schema.optional(Schema.String),
        includeHidden: Schema.optional(Schema.Boolean),
        mode: Schema.optional(Schema.Literal("literal", "regex")),
        maxMatches: Schema.optional(Schema.Number),
        maxBytesPerMatch: Schema.optional(Schema.Number),
      }),
      ...common,
      execute: (args, ctx): Promise<WorkspaceGrepFilesResult> =>
        grepWorkspaceFiles(env, {
          pattern: args.pattern,
          root: args.root,
          includeHidden: args.includeHidden,
          mode: args.mode,
          maxMatches: args.maxMatches,
          maxBytesPerMatch: args.maxBytesPerMatch,
          signal: ctx.signal,
        }),
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
