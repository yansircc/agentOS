import {
  createWorkspaceEnv,
  type WorkspaceEnv,
  type WorkspaceEnvBackend,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceFileStat,
} from "../workspace-env-core";
import {
  checkSignal,
  isInside,
  normalizeAbsolutePath,
  parentDir,
  relativePath,
  textDecoder,
  textEncoder,
  truncateUtf8,
  utf8Bytes,
} from "../workspace-env-core/path-policy";

/**
 * Scripted result for one exact in-memory workspace command.
 *
 * @public
 */
export interface InMemoryWorkspaceExecScript {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number;
}

/**
 * Options for `createInMemoryWorkspaceEnv`.
 *
 * @public
 */
export interface CreateInMemoryWorkspaceEnvOptions {
  readonly cwd?: string;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly scripts?: Readonly<Record<string, InMemoryWorkspaceExecScript>>;
}

/**
 * Error raised by the deterministic in-memory workspace environment.
 *
 * @public
 */
export class InMemoryWorkspaceEnvError extends Error {
  override readonly name = "InMemoryWorkspaceEnvError";
}

interface InMemoryWorkspaceBackend extends WorkspaceEnvBackend {
  readonly seedFile: (path: string, content: string | Uint8Array) => void;
}

const bytesFor = (content: string | Uint8Array): Uint8Array =>
  content instanceof Uint8Array ? new Uint8Array(content) : textEncoder.encode(content);

const copyBytes = (content: Uint8Array): Uint8Array => new Uint8Array(content);

const childPrefix = (path: string): string => (path === "/" ? "/" : `${path}/`);

const compareCodepoint = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const inMemoryPathLabel = (root: string, path: string): string =>
  path === root ? "." : relativePath(root, path);

const missingPathError = (root: string, path: string): InMemoryWorkspaceEnvError =>
  new InMemoryWorkspaceEnvError(
    `in-memory workspace path not found: ${inMemoryPathLabel(root, path)}`,
  );

const assertInsideRoot = (root: string, path: string): void => {
  if (path !== root && !isInside(root, path)) {
    throw new InMemoryWorkspaceEnvError("in-memory workspace path escaped root");
  }
};

const rejectSymbolicRefs = (options: WorkspaceExecOptions): void => {
  if (options.envRefs !== undefined && Object.keys(options.envRefs).length > 0) {
    throw new InMemoryWorkspaceEnvError("in-memory workspace env cannot resolve symbolic env refs");
  }
  if (options.materialRefs !== undefined && options.materialRefs.length > 0) {
    throw new InMemoryWorkspaceEnvError(
      "in-memory workspace env cannot resolve symbolic material refs",
    );
  }
};

const truncatedOutput = (
  text: string,
  maxOutputBytes: number | undefined,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } => {
  const bytes = utf8Bytes(text);
  if (maxOutputBytes === undefined) return { text, bytes, truncated: false };
  const truncated = truncateUtf8(text, maxOutputBytes);
  return { text: truncated.text, bytes, truncated: truncated.truncated };
};

const createInMemoryWorkspaceBackend = (
  root: string,
  scripts: Readonly<Record<string, InMemoryWorkspaceExecScript>>,
): InMemoryWorkspaceBackend => {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>([root]);

  const assertManagedPath = (path: string): void => {
    assertInsideRoot(root, path);
  };

  const pathExists = (path: string): boolean => files.has(path) || directories.has(path);

  const childPaths = (path: string): ReadonlyArray<string> => {
    const prefix = childPrefix(path);
    return [
      ...[...files.keys()].filter((filePath) => filePath.startsWith(prefix)),
      ...[...directories].filter(
        (directoryPath) => directoryPath !== path && directoryPath.startsWith(prefix),
      ),
    ];
  };

  const addDirectory = (path: string, recursive: boolean): void => {
    assertManagedPath(path);
    if (files.has(path)) {
      throw new InMemoryWorkspaceEnvError(
        `in-memory workspace path is a file: ${inMemoryPathLabel(root, path)}`,
      );
    }
    if (directories.has(path)) return;
    const parent = parentDir(root, path);
    if (!directories.has(parent)) {
      if (!recursive) throw missingPathError(root, parent);
      addDirectory(parent, true);
    }
    directories.add(path);
  };

  const ensureParentDirectory = (path: string): void => {
    const parent = parentDir(root, path);
    if (!directories.has(parent)) throw missingPathError(root, parent);
  };

  const writeResolvedFile = (path: string, content: string | Uint8Array): void => {
    assertManagedPath(path);
    if (directories.has(path)) {
      throw new InMemoryWorkspaceEnvError(
        `in-memory workspace path is a directory: ${inMemoryPathLabel(root, path)}`,
      );
    }
    ensureParentDirectory(path);
    files.set(path, bytesFor(content));
  };

  const removeDirectory = (path: string, recursive: boolean): void => {
    const children = childPaths(path);
    if (children.length > 0 && !recursive) {
      throw new InMemoryWorkspaceEnvError(
        `in-memory workspace directory is not empty: ${inMemoryPathLabel(root, path)}`,
      );
    }
    const filePaths = Array.from(files.keys());
    for (const filePath of filePaths) {
      if (filePath === path || filePath.startsWith(childPrefix(path))) files.delete(filePath);
    }
    const directoryPaths = Array.from(directories);
    for (const directoryPath of directoryPaths) {
      if (
        directoryPath !== root &&
        (directoryPath === path || directoryPath.startsWith(childPrefix(path)))
      ) {
        directories.delete(directoryPath);
      }
    }
    if (path === root) directories.add(root);
  };

  const statFor = (path: string): WorkspaceFileStat => {
    const file = files.get(path);
    if (file !== undefined) return { type: "file", size: file.byteLength, mtimeMs: 0 };
    if (directories.has(path)) return { type: "directory", mtimeMs: 0 };
    throw missingPathError(root, path);
  };

  return {
    seedFile: (path, content) => {
      assertManagedPath(path);
      addDirectory(parentDir(root, path), true);
      writeResolvedFile(path, content);
    },
    readFile: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      const file = files.get(path);
      if (file === undefined) throw missingPathError(root, path);
      return textDecoder.decode(file);
    },
    readFileBuffer: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      const file = files.get(path);
      if (file === undefined) throw missingPathError(root, path);
      return copyBytes(file);
    },
    writeFile: async (path, content, operationOptions) => {
      checkSignal(operationOptions?.signal);
      writeResolvedFile(path, content);
    },
    stat: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      return statFor(path);
    },
    readdir: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      if (!directories.has(path)) throw missingPathError(root, path);
      const prefix = childPrefix(path);
      const entries = new Set<string>();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const [entry] = filePath.slice(prefix.length).split("/");
        if (entry !== undefined && entry.length > 0) entries.add(entry);
      }
      for (const directoryPath of directories) {
        if (directoryPath === path || !directoryPath.startsWith(prefix)) continue;
        const [entry] = directoryPath.slice(prefix.length).split("/");
        if (entry !== undefined && entry.length > 0) entries.add(entry);
      }
      return [...entries].sort(compareCodepoint);
    },
    exists: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      return pathExists(path);
    },
    mkdir: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      addDirectory(path, operationOptions?.recursive === true);
    },
    rm: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      assertManagedPath(path);
      if (!pathExists(path)) {
        if (operationOptions?.force === true) return;
        throw missingPathError(root, path);
      }
      if (files.delete(path)) return;
      removeDirectory(path, operationOptions?.recursive === true);
    },
    exec: async (command, options) => {
      checkSignal(options.signal);
      rejectSymbolicRefs(options);
      const cwd = options.cwd ?? root;
      assertManagedPath(cwd);
      if (!directories.has(cwd)) {
        throw new InMemoryWorkspaceEnvError(
          `in-memory workspace exec cwd is not a directory: ${inMemoryPathLabel(root, cwd)}`,
        );
      }
      const script = scripts[command];
      if (script === undefined) {
        throw new InMemoryWorkspaceEnvError(
          `in-memory workspace exec has no script for command: ${command}`,
        );
      }
      const stdout = truncatedOutput(script.stdout ?? "", options.maxOutputBytes);
      const stderr = truncatedOutput(script.stderr ?? "", options.maxOutputBytes);
      const result: WorkspaceExecResult = {
        exitCode: script.exitCode ?? 0,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: script.durationMs ?? 0,
      };
      checkSignal(options.signal);
      return result;
    },
  };
};

/**
 * Creates a deterministic in-memory workspace environment for consumer tests.
 *
 * Path confinement is owned by the shared `createWorkspaceEnv` contract. The
 * backend only stores in-memory files and returns exact scripted command
 * results; it does not read host files, host environment variables, or symbolic
 * refs.
 *
 * @public
 */
export const createInMemoryWorkspaceEnv = (
  options: CreateInMemoryWorkspaceEnvOptions = {},
): WorkspaceEnv => {
  const cwd = normalizeAbsolutePath(options.cwd ?? "/workspace");
  const backend = createInMemoryWorkspaceBackend(cwd, options.scripts ?? {});
  const env = createWorkspaceEnv({
    domain: { kind: "workspace", ref: cwd },
    cwd,
    backend,
  });

  for (const [path, content] of Object.entries(options.files ?? {})) {
    backend.seedFile(env.resolvePath(path), content);
  }

  return env;
};
