import type { WorkspaceTopology } from "@agent-os/core/runtime-protocol";
import { WORKSPACE_TOPOLOGY } from "@agent-os/core/runtime-protocol";
import { isNonEmptyString, isRecord, type JsonRecord } from "./shared";

export const DEPLOYMENT_TARGET_KIND = {
  NODE: "node",
  CLOUDFLARE_DO: "cloudflare-do",
} as const;

export type DeploymentTargetKind =
  (typeof DEPLOYMENT_TARGET_KIND)[keyof typeof DEPLOYMENT_TARGET_KIND];

export const DEPLOYMENT_TRANSPORT = {
  DIRECT: "direct",
  SVELTE_KIT_REMOTE: "svelte-kit-remote",
} as const;

export type DeploymentTransport = (typeof DEPLOYMENT_TRANSPORT)[keyof typeof DEPLOYMENT_TRANSPORT];

export const PROVIDER_PROTOCOL = {
  OPENAI_CHAT_COMPATIBLE: "openai-chat-compatible",
} as const;

export interface DeploymentReleaseIntent {
  readonly id: string;
  readonly version: string;
}

export interface NodeDeploymentTargetIntent {
  readonly kind: typeof DEPLOYMENT_TARGET_KIND.NODE;
}

export interface CloudflareDoDeploymentTargetIntent {
  readonly kind: typeof DEPLOYMENT_TARGET_KIND.CLOUDFLARE_DO;
  readonly className: string;
  readonly binding: string;
  readonly materialResolver: string;
}

export type DeploymentTargetIntent =
  | NodeDeploymentTargetIntent
  | CloudflareDoDeploymentTargetIntent;

export interface ProviderBindingIntent {
  readonly protocol: typeof PROVIDER_PROTOCOL.OPENAI_CHAT_COMPATIBLE;
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelRef: string;
}

export interface DeploymentWorkspaceIntent {
  readonly binding: string;
  readonly root: string;
  readonly topology?: WorkspaceTopology;
}

export interface DeploymentIntent {
  readonly kind: "deployment";
  readonly release: DeploymentReleaseIntent;
  readonly target: DeploymentTargetIntent;
  readonly transport: DeploymentTransport;
  readonly providers: Readonly<Record<string, ProviderBindingIntent>>;
  readonly workspace?: DeploymentWorkspaceIntent;
}

export interface LocalHost {
  readonly kind: "local";
  readonly mode: "ask" | "dev";
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type StaticTargetBinding = LocalHost | DeploymentIntent;

export type DeploymentIntentIssue =
  | { readonly kind: "deployment_not_object"; readonly path: "agentos.deployment.jsonc" }
  | { readonly kind: "unknown_field"; readonly path: string; readonly field: string }
  | {
      readonly kind: "invalid_deployment_value";
      readonly path: string;
      readonly field: string;
      readonly reason: string;
    };

export type DecodeDeploymentIntentResult =
  | { readonly ok: true; readonly value: DeploymentIntent }
  | { readonly ok: false; readonly issues: ReadonlyArray<DeploymentIntentIssue> };

const rootFields = new Set(["kind", "release", "target", "transport", "providers", "workspace"]);
const releaseFields = new Set(["id", "version"]);
const nodeTargetFields = new Set(["kind"]);
const cloudflareTargetFields = new Set(["kind", "className", "binding", "materialResolver"]);
const providerFields = new Set(["protocol", "endpointRef", "credentialRef", "modelRef"]);
const workspaceFields = new Set(["binding", "root", "topology"]);
const topologyFields = new Set(["kind", "allocator"]);
const logicalIdPattern = /^[a-z][a-z0-9._-]*$/u;

const unknownFields = (
  issues: DeploymentIntentIssue[],
  path: string,
  value: JsonRecord,
  allowed: ReadonlySet<string>,
): void => {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) issues.push({ kind: "unknown_field", path, field });
  }
};

const invalid = (
  issues: DeploymentIntentIssue[],
  path: string,
  field: string,
  reason: string,
): void => {
  issues.push({ kind: "invalid_deployment_value", path, field, reason });
};

const requiredRecord = (
  issues: DeploymentIntentIssue[],
  path: string,
  field: string,
  value: unknown,
): JsonRecord | null => {
  if (isRecord(value)) return value;
  invalid(issues, path, field, "object_required");
  return null;
};

const requiredString = (
  issues: DeploymentIntentIssue[],
  path: string,
  field: string,
  value: unknown,
): string | null => {
  if (isNonEmptyString(value)) return value;
  invalid(issues, path, field, "non_empty_string_required");
  return null;
};

const decodeRelease = (
  issues: DeploymentIntentIssue[],
  value: unknown,
): DeploymentReleaseIntent | null => {
  const path = "/release";
  const record = requiredRecord(issues, "agentos.deployment.jsonc", path, value);
  if (record === null) return null;
  unknownFields(issues, path, record, releaseFields);
  const id = requiredString(issues, path, "/release/id", record.id);
  const version = requiredString(issues, path, "/release/version", record.version);
  return id === null || version === null ? null : { id, version };
};

const decodeTarget = (
  issues: DeploymentIntentIssue[],
  value: unknown,
): DeploymentTargetIntent | null => {
  const path = "/target";
  const record = requiredRecord(issues, "agentos.deployment.jsonc", path, value);
  if (record === null) return null;
  if (record.kind === DEPLOYMENT_TARGET_KIND.NODE) {
    unknownFields(issues, path, record, nodeTargetFields);
    return { kind: DEPLOYMENT_TARGET_KIND.NODE };
  }
  if (record.kind === DEPLOYMENT_TARGET_KIND.CLOUDFLARE_DO) {
    unknownFields(issues, path, record, cloudflareTargetFields);
    const className = requiredString(issues, path, "/target/className", record.className);
    const binding = requiredString(issues, path, "/target/binding", record.binding);
    const materialResolver = requiredString(
      issues,
      path,
      "/target/materialResolver",
      record.materialResolver,
    );
    return className === null || binding === null || materialResolver === null
      ? null
      : {
          kind: DEPLOYMENT_TARGET_KIND.CLOUDFLARE_DO,
          className,
          binding,
          materialResolver,
        };
  }
  invalid(issues, path, "/target/kind", "target_kind_invalid");
  return null;
};

const decodeProvider = (
  issues: DeploymentIntentIssue[],
  path: string,
  value: unknown,
): ProviderBindingIntent | null => {
  const record = requiredRecord(issues, path, path, value);
  if (record === null) return null;
  unknownFields(issues, path, record, providerFields);
  if (record.protocol !== PROVIDER_PROTOCOL.OPENAI_CHAT_COMPATIBLE) {
    invalid(issues, path, `${path}/protocol`, "provider_protocol_invalid");
  }
  const endpointRef = requiredString(issues, path, `${path}/endpointRef`, record.endpointRef);
  const credentialRef = requiredString(issues, path, `${path}/credentialRef`, record.credentialRef);
  const modelRef = requiredString(issues, path, `${path}/modelRef`, record.modelRef);
  return record.protocol !== PROVIDER_PROTOCOL.OPENAI_CHAT_COMPATIBLE ||
    endpointRef === null ||
    credentialRef === null ||
    modelRef === null
    ? null
    : {
        protocol: PROVIDER_PROTOCOL.OPENAI_CHAT_COMPATIBLE,
        endpointRef,
        credentialRef,
        modelRef,
      };
};

const decodeProviders = (
  issues: DeploymentIntentIssue[],
  value: unknown,
): Readonly<Record<string, ProviderBindingIntent>> | null => {
  const record = requiredRecord(issues, "agentos.deployment.jsonc", "/providers", value);
  if (record === null) return null;
  const providers: Record<string, ProviderBindingIntent> = {};
  for (const [logicalId, child] of Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!logicalIdPattern.test(logicalId)) {
      invalid(issues, "/providers", `/providers/${logicalId}`, "logical_id_invalid");
      continue;
    }
    const provider = decodeProvider(issues, `/providers/${logicalId}`, child);
    if (provider !== null) providers[logicalId] = provider;
  }
  if (Object.keys(providers).length === 0) {
    invalid(issues, "/providers", "/providers", "non_empty_provider_map_required");
  }
  return Object.keys(providers).length === 0 ? null : providers;
};

const decodeTopology = (
  issues: DeploymentIntentIssue[],
  value: unknown,
): WorkspaceTopology | null => {
  const path = "/workspace/topology";
  const record = requiredRecord(issues, "/workspace", path, value);
  if (record === null) return null;
  unknownFields(issues, path, record, topologyFields);
  if (record.kind !== WORKSPACE_TOPOLOGY.PER_SCOPE) {
    invalid(issues, path, `${path}/kind`, "workspace_topology_kind_invalid");
  }
  const allocator = requiredString(issues, path, `${path}/allocator`, record.allocator);
  return record.kind === WORKSPACE_TOPOLOGY.PER_SCOPE && allocator !== null
    ? { kind: WORKSPACE_TOPOLOGY.PER_SCOPE, allocator }
    : null;
};

const decodeWorkspace = (
  issues: DeploymentIntentIssue[],
  value: unknown,
): DeploymentWorkspaceIntent | null => {
  const path = "/workspace";
  const record = requiredRecord(issues, "agentos.deployment.jsonc", path, value);
  if (record === null) return null;
  unknownFields(issues, path, record, workspaceFields);
  const binding = requiredString(issues, path, "/workspace/binding", record.binding);
  const root = requiredString(issues, path, "/workspace/root", record.root);
  const topology =
    record.topology === undefined ? undefined : decodeTopology(issues, record.topology);
  return binding === null || root === null || topology === null
    ? null
    : { binding, root, ...(topology === undefined ? {} : { topology }) };
};

export const decodeDeploymentIntent = (value: unknown): DecodeDeploymentIntentResult => {
  const issues: DeploymentIntentIssue[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ kind: "deployment_not_object", path: "agentos.deployment.jsonc" }],
    };
  }
  unknownFields(issues, "agentos.deployment.jsonc", value, rootFields);
  if (value.kind !== "deployment") {
    invalid(issues, "agentos.deployment.jsonc", "/kind", "deployment_kind_required");
  }
  const release = decodeRelease(issues, value.release);
  const target = decodeTarget(issues, value.target);
  const transport =
    value.transport === DEPLOYMENT_TRANSPORT.DIRECT ||
    value.transport === DEPLOYMENT_TRANSPORT.SVELTE_KIT_REMOTE
      ? value.transport
      : null;
  if (transport === null) {
    invalid(issues, "agentos.deployment.jsonc", "/transport", "transport_invalid");
  }
  const providers = decodeProviders(issues, value.providers);
  const workspace =
    value.workspace === undefined ? undefined : decodeWorkspace(issues, value.workspace);
  if (
    issues.length > 0 ||
    value.kind !== "deployment" ||
    release === null ||
    target === null ||
    transport === null ||
    providers === null ||
    workspace === null
  ) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      kind: "deployment",
      release,
      target,
      transport,
      providers,
      ...(workspace === undefined ? {} : { workspace }),
    },
  };
};

export const localHost = (
  mode: LocalHost["mode"],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): LocalHost => ({ kind: "local", mode, cwd, env });
