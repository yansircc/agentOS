import type { AgentBindings } from "./bindings";
import {
  BUILTIN_HANDLER_KINDS,
  type AgentDefinitionExtension,
  type AgentManifest,
  type HandlerKind,
} from "./manifest";

export interface AgentMountPort {
  readonly backend?: unknown;
  readonly transport?: unknown;
  readonly providers?: unknown;
}

export type AgentMountIssue =
  | {
      readonly kind: "function_in_manifest";
      readonly path: string;
    }
  | {
      readonly kind: "unknown_handler_kind";
      readonly handlerKind: string;
    }
  | {
      readonly kind: "extension_handler_prefix_mismatch";
      readonly extensionId: string;
      readonly handlerKind: string;
    }
  | {
      readonly kind: "missing_handler_binding";
      readonly handlerKind: string;
    };

export type AgentMountWarning = {
  readonly kind: "dead_handler_binding";
  readonly handlerKind: string;
};

export type AgentMountValidation =
  | {
      readonly ok: true;
      readonly warnings: ReadonlyArray<AgentMountWarning>;
    }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<AgentMountIssue>;
      readonly warnings: ReadonlyArray<AgentMountWarning>;
    };

export interface MountedAgent<
  K extends HandlerKind = HandlerKind,
  P extends AgentMountPort = AgentMountPort,
> {
  readonly manifest: AgentManifest<K>;
  readonly bindings: AgentBindings<K>;
  readonly port: P;
  readonly warnings: ReadonlyArray<AgentMountWarning>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const findFunctionPaths = (
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): ReadonlyArray<string> => {
  if (typeof value === "function") return [path];
  if (!isRecord(value)) return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    paths.push(...findFunctionPaths(child, `${path}.${key}`, seen));
  }
  return paths;
};

const extensionHandlerKinds = (
  extensions: ReadonlyArray<AgentDefinitionExtension> | undefined,
): ReadonlySet<string> => {
  const kinds = new Set<string>();
  for (const extension of extensions ?? []) {
    for (const handlerKind of extension.handlerKinds) {
      kinds.add(handlerKind);
    }
  }
  return kinds;
};

const extensionPrefixIssues = (
  extensions: ReadonlyArray<AgentDefinitionExtension> | undefined,
): ReadonlyArray<AgentMountIssue> => {
  const issues: AgentMountIssue[] = [];
  for (const extension of extensions ?? []) {
    const prefix = `${extension.extensionId}.`;
    for (const handlerKind of extension.handlerKinds) {
      if (!handlerKind.startsWith(prefix)) {
        issues.push({
          kind: "extension_handler_prefix_mismatch",
          extensionId: extension.extensionId,
          handlerKind,
        });
      }
    }
  }
  return issues;
};

export const validateAgentMount = <K extends HandlerKind>(
  manifest: AgentManifest<K>,
  bindings: AgentBindings<K>,
): AgentMountValidation => {
  const issues: AgentMountIssue[] = [];
  const warnings: AgentMountWarning[] = [];
  for (const path of findFunctionPaths(manifest, "manifest", new WeakSet())) {
    issues.push({ kind: "function_in_manifest", path });
  }
  issues.push(...extensionPrefixIssues(manifest.extensions));

  const builtins = new Set<string>(BUILTIN_HANDLER_KINDS);
  const extensions = extensionHandlerKinds(manifest.extensions);
  const declaredHandlers = new Set<string>();

  for (const handlerKind of manifest.handlers) {
    declaredHandlers.add(handlerKind);
    if (!builtins.has(handlerKind) && !extensions.has(handlerKind)) {
      issues.push({ kind: "unknown_handler_kind", handlerKind });
    }
    if (bindings.handlers[handlerKind] === undefined) {
      issues.push({ kind: "missing_handler_binding", handlerKind });
    }
  }

  for (const handlerKind of Object.keys(bindings.handlers)) {
    if (!declaredHandlers.has(handlerKind)) {
      warnings.push({ kind: "dead_handler_binding", handlerKind });
    }
  }

  return issues.length === 0 ? { ok: true, warnings } : { ok: false, issues, warnings };
};

export const mountAgent = <K extends HandlerKind, P extends AgentMountPort>(
  manifest: AgentManifest<K>,
  bindings: AgentBindings<K>,
  port: P,
): MountedAgent<K, P> => {
  const validation = validateAgentMount(manifest, bindings);
  if (!validation.ok) {
    throw new TypeError(`agent mount invalid: ${JSON.stringify(validation.issues)}`);
  }
  return { manifest, bindings, port, warnings: validation.warnings };
};
