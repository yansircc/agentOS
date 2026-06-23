import { WORKSPACE_TOOL_NAMES, type WorkspaceToolName } from "@agent-os/runtime";

export const AUTHORING_DEFAULTS_VERSION = "framework-defaults@agentos/v1" as const;
export const GENERATED_LOAD_SKILL_TOOL_NAME = "load_skill" as const;

export type JsonRecord = Readonly<Record<string, unknown>>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const hasFunction = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasFunction(item, seen));
  return Object.values(value as JsonRecord).some((item) => hasFunction(item, seen));
};

export const findFunctionPath = (
  value: unknown,
  path: string,
  seen = new Set<object>(),
): string | null => {
  if (typeof value === "function") return path;
  if (typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findFunctionPath(value[index], `${path}[${index}]`, seen);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    const found = findFunctionPath(child, `${path}.${key}`, seen);
    if (found !== null) return found;
  }
  return null;
};

export const digestText = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${text.length}`;
};

export const digestHex64 = (text: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

const workspaceToolNames = new Set<WorkspaceToolName>(WORKSPACE_TOOL_NAMES);

export const isWorkspaceToolName = (name: string): name is WorkspaceToolName =>
  workspaceToolNames.has(name as WorkspaceToolName);
