import type {
  WorkspaceEnvBackend,
  WorkspaceExecOptions,
  WorkspaceExecResult,
  WorkspaceOperationOptions,
} from "../workspace-env-core";
import { checkSignal, parentDir } from "./path-policy";

export const writeWorkspaceFile = async (
  backend: WorkspaceEnvBackend,
  cwd: string,
  resolvePath: () => string,
  content: string | Uint8Array,
  options?: WorkspaceOperationOptions,
): Promise<void> => {
  const path = resolvePath();
  checkSignal(options?.signal);
  await backend.mkdir(parentDir(cwd, path), {
    recursive: true,
    signal: options?.signal,
  });
  checkSignal(options?.signal);
  await backend.writeFile(path, content, options);
  checkSignal(options?.signal);
};

export const removeWorkspacePath = async (
  backend: WorkspaceEnvBackend,
  resolvePath: () => string,
  options?: WorkspaceOperationOptions & {
    readonly recursive?: boolean;
    readonly force?: boolean;
  },
): Promise<void> => {
  const path = resolvePath();
  checkSignal(options?.signal);
  await backend.rm(path, options);
  checkSignal(options?.signal);
};

export const executeWorkspaceCommand = async (
  backend: WorkspaceEnvBackend,
  command: string,
  resolveOptions: () => WorkspaceExecOptions,
): Promise<WorkspaceExecResult> => {
  const options = resolveOptions();
  checkSignal(options.signal);
  const result = await backend.exec(command, options);
  checkSignal(options.signal);
  return result;
};
