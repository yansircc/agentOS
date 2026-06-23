import type {
  NormalizeWorkspaceToolPathOptions,
  WorkspaceEnv,
  WorkspaceFileSnapshot,
  WorkspaceFileStat,
  WorkspaceOperationOptions,
  WorkspaceReadFileLineRange,
} from "../workspace-env-core";

export class WorkspaceEnvInputError extends Error {
  override readonly name = "WorkspaceEnvInputError";
}

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_MAX_COMMAND_CHARS = 2_000;
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 16_384;
export const DEFAULT_MAX_SEARCH_MATCHES = 100;
export const DEFAULT_MAX_BYTES_PER_MATCH = 4_096;

export const abortErrorFor = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? "workspace operation aborted" : String(reason));
  error.name = "AbortError";
  return error;
};

export const checkSignal = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw abortErrorFor(signal);
  }
};

export const failInput = (message: string): never => {
  throw new WorkspaceEnvInputError(message);
};

export const normalizeAbsolutePath = (input: string): string => {
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

export const isInside = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}/`);

export const parentDir = (root: string, path: string): string => {
  const index = path.lastIndexOf("/");
  if (index <= root.length) return root;
  return path.slice(0, index);
};

export const relativePath = (root: string, path: string): string =>
  path === root ? "." : path.slice(root.length + 1);

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export const utf8Bytes = (value: string | Uint8Array): number =>
  value instanceof Uint8Array ? value.byteLength : textEncoder.encode(value).byteLength;

export const truncateUtf8 = (
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

export interface ResolvedReadFileLineRange extends WorkspaceReadFileLineRange {
  readonly startOffset: number;
  readonly endOffset: number;
}

export const requirePositiveInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value <= 0 || !Number.isFinite(value)) {
    return failInput(`${label} must be a finite positive integer`);
  }
  return value;
};

export const resolveReadFileLineRange = (
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
): ResolvedReadFileLineRange | undefined => {
  if (startLine === undefined && endLine === undefined) return undefined;

  const lineStarts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n" && index + 1 < content.length) {
      lineStarts.push(index + 1);
    }
  }
  const totalLines = Math.max(1, lineStarts.length);
  const start = startLine === undefined ? 1 : requirePositiveInteger(startLine, "startLine");
  const requestedEnd =
    endLine === undefined ? totalLines : requirePositiveInteger(endLine, "endLine");
  if (requestedEnd < start) return failInput("endLine must be greater than or equal to startLine");
  if (start > totalLines) return failInput("startLine exceeds file line count");

  const effectiveEnd = Math.min(requestedEnd, totalLines);
  return {
    startLine: start,
    endLine: effectiveEnd,
    totalLines,
    startOffset: lineStarts[start - 1] ?? content.length,
    endOffset:
      effectiveEnd >= totalLines ? content.length : (lineStarts[effectiveEnd] ?? content.length),
  };
};

export const normalizedRelativePath = (
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

/**
 * Normalizes agent-facing workspace tool paths.
 *
 * Tool paths are workspace-virtual: `src/a.ts`, `./src/a.ts`, and
 * `/src/a.ts` all name the same workspace path. When an environment exposes a
 * concrete cwd such as `/workspace`, paths under that cwd name the same
 * workspace-relative files.
 */
export const normalizeWorkspaceToolPath = (
  input: string,
  options: NormalizeWorkspaceToolPathOptions = {},
): string => {
  const label = options.label ?? "workspace path";
  const trimmed = input.trim().replaceAll("\\", "/");
  if (trimmed.length === 0) return failInput(`${label} required`);
  if (trimmed.includes("\0")) return failInput(`${label} cannot contain NUL`);

  let normalized = trimmed.replace(/^\.\/+/, "");
  if (normalized.startsWith("/")) {
    const absolute = normalizeAbsolutePath(normalized);
    if (options.cwd !== undefined) {
      const cwd = normalizeAbsolutePath(options.cwd);
      if (absolute === cwd || isInside(cwd, absolute)) {
        normalized = absolute === cwd ? "." : absolute.slice(cwd.length + 1);
        return normalizedRelativePath(normalized, label, { allowRoot: options.allowRoot });
      }
    }
    normalized = absolute === "/" ? "." : absolute.slice(1);
  }

  return normalizedRelativePath(normalized, label, { allowRoot: options.allowRoot });
};

export const normalizeToolPathForEnv = (
  env: WorkspaceEnv,
  input: string,
  label: string,
  options: { readonly allowRoot?: boolean } = {},
): string => normalizeWorkspaceToolPath(input, { ...options, cwd: env.cwd, label });

export const resolveWorkspaceToolPath = (
  env: WorkspaceEnv,
  input: string,
  label: string,
  options: { readonly allowRoot?: boolean } = {},
): string => env.resolvePath(normalizeToolPathForEnv(env, input, label, options));

export const hiddenPath = (path: string): boolean =>
  path !== "." && path.split("/").some((part) => part.startsWith("."));

export const validDirectoryEntry = (entry: string): string => {
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

export const joinAbsolutePath = (directory: string, entry: string): string =>
  directory === "/" ? `/${entry}` : `${directory}/${entry}`;

export const snapshotFor = (path: string, stat: WorkspaceFileStat): WorkspaceFileSnapshot => ({
  path,
  ...(stat.size === undefined ? {} : { size: stat.size }),
  ...(stat.mtimeMs === undefined ? {} : { mtimeMs: stat.mtimeMs }),
});

export const rootRelativePath = (env: WorkspaceEnv, root: string, path: string): string => {
  const rootRelative = relativePath(env.cwd, root);
  if (rootRelative === ".") return path;
  if (path === rootRelative) {
    const parts = path.split("/");
    return parts[parts.length - 1] ?? path;
  }
  return path.slice(rootRelative.length + 1);
};

export const normalizeGlobPattern = (pattern: string): ReadonlyArray<string> => {
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

export const normalizeGlobPatternForRoot = (
  env: WorkspaceEnv,
  pattern: string,
  root: string,
): ReadonlyArray<string> => {
  const trimmed = pattern.trim().replaceAll("\\", "/");
  if (!trimmed.startsWith("/")) return normalizeGlobPattern(pattern);

  const workspacePattern = normalizeWorkspaceToolPath(trimmed, {
    cwd: env.cwd,
    label: "glob pattern",
  });
  const rootRelative = relativePath(env.cwd, root);
  const patternForRoot =
    rootRelative === "."
      ? workspacePattern
      : workspacePattern === rootRelative
        ? "."
        : workspacePattern.startsWith(`${rootRelative}/`)
          ? workspacePattern.slice(rootRelative.length + 1)
          : failInput("glob pattern must be inside root");
  return normalizeGlobPattern(patternForRoot);
};

export const resolveWorkspaceSearchRoot = (env: WorkspaceEnv, root: string | undefined): string =>
  root === undefined
    ? env.resolvePath(".")
    : resolveWorkspaceToolPath(env, root, "root", {
        allowRoot: true,
      });

export const regexEscape = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

export const globSegmentMatches = (pattern: string, segment: string): boolean => {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else regex += regexEscape(char);
  }
  regex += "$";
  return new RegExp(regex).test(segment);
};

export const globMatches = (
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

export const regexpForGrep = (pattern: string): RegExp => {
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

export const containsNulByte = (bytes: Uint8Array): boolean => bytes.includes(0);

export interface WalkResolvedWorkspaceFilesOptions extends WorkspaceOperationOptions {
  readonly root: string;
  readonly recursive?: boolean;
  readonly includeHidden?: boolean;
}

export const walkResolvedWorkspaceFiles = async (
  env: WorkspaceEnv,
  options: WalkResolvedWorkspaceFilesOptions,
): Promise<ReadonlyArray<WorkspaceFileSnapshot>> => {
  const root = options.root;
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
