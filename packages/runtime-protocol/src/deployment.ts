import type { RecordedLedgerEvent } from "@agent-os/kernel/types";
import {
  authorityRefKey,
  isAuthorityRef,
  isScopeRef,
  scopeRefKey,
} from "@agent-os/kernel/effect-claim";
import type { AgentManifest } from "./manifest";
import { manifestTruthIdentity } from "./manifest";
import type { LedgerCommitEventSpec, LedgerTruthIdentity } from "./ledger";
import { Option } from "effect";

export const INSTALLATION_RECEIPT_EVENT_KIND = "agent.installation.receipt" as const;
export const INSTALLATION_RECEIPT_VERSION = "agent-installation-receipt-v1" as const;

export interface DeploymentSpec<M extends AgentManifest = AgentManifest> {
  readonly deploymentId: string;
  readonly manifest: M;
  readonly backend: string;
  readonly adapter: string;
  readonly codec: string;
  readonly providerStrategy?: string;
}

export interface InstallationReceipt {
  readonly version: typeof INSTALLATION_RECEIPT_VERSION;
  readonly deploymentId: string;
  readonly agentId: string;
  readonly agentVersion?: string;
  readonly backend: string;
  readonly adapter: string;
  readonly codec: string;
  readonly providerStrategy?: string;
  readonly truthIdentity: LedgerTruthIdentity;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const requireDeploymentField = (label: string, value: string): string => {
  if (isNonEmptyString(value)) return value;
  return Option.getOrThrowWith(
    Option.none(),
    () => new TypeError(`DeploymentSpec.${label} must be non-empty`),
  );
};

export const installationReceiptFromDeployment = (spec: DeploymentSpec): InstallationReceipt => {
  const truthIdentity = manifestTruthIdentity(spec.manifest);
  return {
    version: INSTALLATION_RECEIPT_VERSION,
    deploymentId: requireDeploymentField("deploymentId", spec.deploymentId),
    agentId: requireDeploymentField("manifest.agentId", spec.manifest.agentId),
    ...(spec.manifest.version === undefined ? {} : { agentVersion: spec.manifest.version }),
    backend: requireDeploymentField("backend", spec.backend),
    adapter: requireDeploymentField("adapter", spec.adapter),
    codec: requireDeploymentField("codec", spec.codec),
    ...(spec.providerStrategy === undefined
      ? {}
      : { providerStrategy: requireDeploymentField("providerStrategy", spec.providerStrategy) }),
    truthIdentity,
  };
};

export const installationReceiptEvent = (spec: DeploymentSpec): LedgerCommitEventSpec => {
  const receipt = installationReceiptFromDeployment(spec);
  return {
    kind: INSTALLATION_RECEIPT_EVENT_KIND,
    scopeRef: receipt.truthIdentity.scopeRef,
    effectAuthorityRef: receipt.truthIdentity.effectAuthorityRef,
    payload: receipt,
  };
};

const installationReceiptFromPayload = (value: unknown): InstallationReceipt | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== INSTALLATION_RECEIPT_VERSION) return null;
  if (
    !isNonEmptyString(record.deploymentId) ||
    !isNonEmptyString(record.agentId) ||
    !isNonEmptyString(record.backend) ||
    !isNonEmptyString(record.adapter) ||
    !isNonEmptyString(record.codec)
  ) {
    return null;
  }
  if (record.agentVersion !== undefined && !isNonEmptyString(record.agentVersion)) return null;
  if (record.providerStrategy !== undefined && !isNonEmptyString(record.providerStrategy)) {
    return null;
  }
  const truthIdentity = record.truthIdentity;
  if (typeof truthIdentity !== "object" || truthIdentity === null || Array.isArray(truthIdentity)) {
    return null;
  }
  const identityRecord = truthIdentity as Record<string, unknown>;
  if (!isScopeRef(identityRecord.scopeRef) || !isAuthorityRef(identityRecord.effectAuthorityRef)) {
    return null;
  }
  return {
    version: INSTALLATION_RECEIPT_VERSION,
    deploymentId: record.deploymentId,
    agentId: record.agentId,
    ...(record.agentVersion === undefined ? {} : { agentVersion: record.agentVersion }),
    backend: record.backend,
    adapter: record.adapter,
    codec: record.codec,
    ...(record.providerStrategy === undefined ? {} : { providerStrategy: record.providerStrategy }),
    truthIdentity: {
      scopeRef: identityRecord.scopeRef,
      effectAuthorityRef: identityRecord.effectAuthorityRef,
    },
  };
};

export const installationReceiptFromLedgerEvent = (
  event: RecordedLedgerEvent,
): InstallationReceipt | null => {
  if (event.kind !== INSTALLATION_RECEIPT_EVENT_KIND) return null;
  const receipt = installationReceiptFromPayload(event.payload);
  if (receipt === null) return null;
  if (scopeRefKey(event.scopeRef) !== scopeRefKey(receipt.truthIdentity.scopeRef)) return null;
  if (
    authorityRefKey(event.effectAuthorityRef) !==
    authorityRefKey(receipt.truthIdentity.effectAuthorityRef)
  ) {
    return null;
  }
  return receipt;
};

export const projectInstallationReceipt = (
  events: Iterable<RecordedLedgerEvent>,
  deploymentId: string,
): InstallationReceipt | null => {
  let current: InstallationReceipt | null = null;
  for (const event of events) {
    const receipt = installationReceiptFromLedgerEvent(event);
    if (receipt !== null && receipt.deploymentId === deploymentId) {
      current = receipt;
    }
  }
  return current;
};
