import type {
  EditWorkspaceFileOptions,
  GlobWorkspaceFilesOptions,
  GrepWorkspaceFilesOptions,
  WorkspaceEditFileResult,
  WorkspaceEnv,
  WorkspaceFileSnapshot,
  WorkspaceFilesDiff,
  WorkspaceGlobFilesResult,
  WorkspaceGrepFilesResult,
  WorkspaceGrepMatch,
  WalkWorkspaceFilesOptions,
} from "../workspace-env-core";
import {
  DEFAULT_MAX_BYTES_PER_MATCH,
  DEFAULT_MAX_SEARCH_MATCHES,
  checkSignal,
  containsNulByte,
  failInput,
  globMatches,
  normalizeGlobPatternForRoot,
  normalizedRelativePath,
  regexpForGrep,
  relativePath,
  requirePositiveInteger,
  resolveWorkspaceSearchRoot,
  resolveWorkspaceToolPath,
  rootRelativePath,
  textDecoder,
  truncateUtf8,
  utf8Bytes,
  walkResolvedWorkspaceFiles,
} from "./path-policy";

export const walkWorkspaceFiles = async (
  env: WorkspaceEnv,
  options: WalkWorkspaceFilesOptions = {},
): Promise<ReadonlyArray<WorkspaceFileSnapshot>> =>
  walkResolvedWorkspaceFiles(env, {
    root: resolveWorkspaceSearchRoot(env, options.root),
    recursive: options.recursive,
    includeHidden: options.includeHidden,
    signal: options.signal,
  });

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
  const path = resolveWorkspaceToolPath(env, options.path, "path");
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
  const root = resolveWorkspaceSearchRoot(env, options.root);
  const maxMatches = requirePositiveInteger(
    options.maxMatches ?? DEFAULT_MAX_SEARCH_MATCHES,
    "maxMatches",
  );
  const patternSegments = normalizeGlobPatternForRoot(env, options.pattern, root);
  const files = await walkResolvedWorkspaceFiles(env, {
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
  const root = resolveWorkspaceSearchRoot(env, options.root);
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
  const files = await walkResolvedWorkspaceFiles(env, {
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
