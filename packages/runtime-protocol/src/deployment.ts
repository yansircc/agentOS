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
import {
  EXECUTION_IDENTITY_VERSION,
  executionIdentityFromUnknown,
  type ExecutionIdentity,
  type ExecutionIdentityDeployment,
  type ExecutionIdentityManifest,
} from "./execution-identity";

export const INSTALLATION_RECEIPT_EVENT_KIND = "agent.installation.receipt" as const;
export const INSTALLATION_INTENT_VERSION = "agent-installation-intent-v1" as const;
export const INSTALLATION_OBSERVATION_VERSION = "agent-installation-observation-v1" as const;
export const INSTALLATION_RECEIPT_VERSION = "agent-installation-receipt-v1" as const;

export interface DeploymentSpec<M extends AgentManifest = AgentManifest> {
  readonly deploymentId: string;
  readonly manifest: M;
  readonly backend: string;
  readonly adapter: string;
  readonly codec: string;
  readonly providerStrategy?: string;
}

export interface InstallationIntent {
  readonly version: typeof INSTALLATION_INTENT_VERSION;
  readonly deploymentId: string;
  readonly agentId: string;
  readonly agentVersion?: string;
  readonly backend: string;
  readonly adapter: string;
  readonly codec: string;
  readonly providerStrategy?: string;
  readonly truthIdentity: LedgerTruthIdentity;
  readonly executionIdentity: ExecutionIdentity;
}

export interface InstallationBootCheck {
  readonly name: string;
  readonly status: "passed";
  readonly observedValue?: string;
}

export interface InstallationObservation {
  readonly version: typeof INSTALLATION_OBSERVATION_VERSION;
  readonly intent: InstallationIntent;
  readonly observedAtMs: number;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
  readonly artifactDigest?: string;
  readonly bootChecks: ReadonlyArray<InstallationBootCheck>;
}

export interface InstallationReceipt {
  readonly version: typeof INSTALLATION_RECEIPT_VERSION;
  readonly intent: InstallationIntent;
  readonly observation: Omit<InstallationObservation, "intent">;
}

type InstallationObservationPayload = Omit<InstallationObservation, "intent">;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const requireDeploymentField = (label: string, value: string): string => {
  if (isNonEmptyString(value)) return value;
  return Option.getOrThrowWith(
    Option.none(),
    () => new TypeError(`DeploymentSpec.${label} must be non-empty`),
  );
};

const requireNonNegativeInteger = (label: string, value: number): number => {
  if (isNonNegativeInteger(value)) return value;
  return Option.getOrThrowWith(
    Option.none(),
    () => new TypeError(`${label} must be a non-negative integer`),
  );
};

const requireBootChecks = (
  label: string,
  value: ReadonlyArray<InstallationBootCheck>,
): ReadonlyArray<InstallationBootCheck> => {
  if (value.length === 0) {
    return Option.getOrThrowWith(
      Option.none(),
      () => new TypeError(`${label} must contain at least one passed check`),
    );
  }
  value.forEach((check, index) => {
    if (!isNonEmptyString(check.name)) {
      return Option.getOrThrowWith(
        Option.none(),
        () => new TypeError(`${label}[${index}].name must be non-empty`),
      );
    }
    if (check.status !== "passed") {
      return Option.getOrThrowWith(
        Option.none(),
        () => new TypeError(`${label}[${index}].status must be "passed"`),
      );
    }
    if (check.observedValue !== undefined && !isNonEmptyString(check.observedValue)) {
      return Option.getOrThrowWith(
        Option.none(),
        () => new TypeError(`${label}[${index}].observedValue must be non-empty`),
      );
    }
  });
  return value;
};

const executionIdentityManifestFromDeployment = (
  spec: DeploymentSpec,
): ExecutionIdentityManifest => ({
  agentId: requireDeploymentField("manifest.agentId", spec.manifest.agentId),
  ...(spec.manifest.version === undefined ? {} : { version: spec.manifest.version }),
  ...(spec.manifest.outputSchema === undefined
    ? {}
    : { outputSchemaFingerprint: spec.manifest.outputSchema.fingerprint }),
});

const executionIdentityDeploymentFromDeployment = (
  spec: DeploymentSpec,
): ExecutionIdentityDeployment => ({
  deploymentId: requireDeploymentField("deploymentId", spec.deploymentId),
  backend: requireDeploymentField("backend", spec.backend),
  adapter: requireDeploymentField("adapter", spec.adapter),
  codec: requireDeploymentField("codec", spec.codec),
  ...(spec.providerStrategy === undefined
    ? {}
    : { providerStrategy: requireDeploymentField("providerStrategy", spec.providerStrategy) }),
});

/**
 * Derive execution provenance from the deployment surface without changing the
 * ledger truth key. This records which linked program ran; it does not grant
 * authority.
 *
 * @public
 */
export const executionIdentityFromDeployment = (spec: DeploymentSpec): ExecutionIdentity => ({
  version: EXECUTION_IDENTITY_VERSION,
  manifest: executionIdentityManifestFromDeployment(spec),
  deployment: executionIdentityDeploymentFromDeployment(spec),
});

/**
 * Build-time installation intent derived from deployment declarations. This is
 * not proof that the target module booted; it is the intended installation
 * surface that a host later observes.
 *
 * @public
 */
export const installationIntentFromDeployment = (spec: DeploymentSpec): InstallationIntent => {
  const truthIdentity = manifestTruthIdentity(spec.manifest);
  const executionIdentity = executionIdentityFromDeployment(spec);
  return {
    version: INSTALLATION_INTENT_VERSION,
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
    executionIdentity,
  };
};

export interface InstallationObservationInput {
  readonly intent: InstallationIntent;
  readonly observedAtMs: number;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
  readonly artifactDigest?: string;
  readonly bootChecks: ReadonlyArray<InstallationBootCheck>;
}

/**
 * Boot-time observation supplied by a concrete host after module load and boot
 * checks. All checks are positive passed checks; failed boots do not mint an
 * InstallationReceipt.
 *
 * @public
 */
export const installationObservation = (
  input: InstallationObservationInput,
): InstallationObservation => ({
  version: INSTALLATION_OBSERVATION_VERSION,
  intent: input.intent,
  observedAtMs: requireNonNegativeInteger(
    "InstallationObservation.observedAtMs",
    input.observedAtMs,
  ),
  runtimeVersion: requireDeploymentField(
    "InstallationObservation.runtimeVersion",
    input.runtimeVersion,
  ),
  adapterVersion: requireDeploymentField(
    "InstallationObservation.adapterVersion",
    input.adapterVersion,
  ),
  ...(input.artifactDigest === undefined
    ? {}
    : {
        artifactDigest: requireDeploymentField(
          "InstallationObservation.artifactDigest",
          input.artifactDigest,
        ),
      }),
  bootChecks: requireBootChecks("InstallationObservation.bootChecks", input.bootChecks),
});

export const installationReceiptFromObservation = (
  observation: InstallationObservation,
): InstallationReceipt => {
  const { intent, ...observed } = observation;
  return {
    version: INSTALLATION_RECEIPT_VERSION,
    intent,
    observation: observed,
  };
};

export const installationReceiptEvent = (
  observation: InstallationObservation,
): LedgerCommitEventSpec => {
  const receipt = installationReceiptFromObservation(observation);
  return {
    kind: INSTALLATION_RECEIPT_EVENT_KIND,
    scopeRef: receipt.intent.truthIdentity.scopeRef,
    effectAuthorityRef: receipt.intent.truthIdentity.effectAuthorityRef,
    payload: receipt,
  };
};

const installationIntentFromPayload = (value: unknown): InstallationIntent | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== INSTALLATION_INTENT_VERSION) return null;
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
  const executionIdentity = record.executionIdentity;
  if (
    typeof executionIdentity !== "object" ||
    executionIdentity === null ||
    Array.isArray(executionIdentity)
  ) {
    return null;
  }
  const parsedExecutionIdentity = executionIdentityFromUnknown(executionIdentity);
  if (parsedExecutionIdentity === null) return null;
  const truthIdentity = record.truthIdentity;
  if (typeof truthIdentity !== "object" || truthIdentity === null || Array.isArray(truthIdentity)) {
    return null;
  }
  const identityRecord = truthIdentity as Record<string, unknown>;
  if (!isScopeRef(identityRecord.scopeRef) || !isAuthorityRef(identityRecord.effectAuthorityRef)) {
    return null;
  }
  return {
    version: INSTALLATION_INTENT_VERSION,
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
    executionIdentity: parsedExecutionIdentity,
  };
};

const bootChecksFromPayload = (value: unknown): ReadonlyArray<InstallationBootCheck> | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const checks: InstallationBootCheck[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (!isNonEmptyString(record.name) || record.status !== "passed") return null;
    if (record.observedValue !== undefined && !isNonEmptyString(record.observedValue)) return null;
    checks.push({
      name: record.name,
      status: "passed",
      ...(record.observedValue === undefined ? {} : { observedValue: record.observedValue }),
    });
  }
  return checks;
};

const installationObservationFromPayload = (
  value: unknown,
): InstallationObservationPayload | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== INSTALLATION_OBSERVATION_VERSION) return null;
  const observedAtMs = record.observedAtMs;
  if (!isNonNegativeInteger(observedAtMs)) return null;
  if (!isNonEmptyString(record.runtimeVersion) || !isNonEmptyString(record.adapterVersion)) {
    return null;
  }
  if (record.artifactDigest !== undefined && !isNonEmptyString(record.artifactDigest)) {
    return null;
  }
  const bootChecks = bootChecksFromPayload(record.bootChecks);
  if (bootChecks === null) return null;
  return {
    version: INSTALLATION_OBSERVATION_VERSION,
    observedAtMs,
    runtimeVersion: record.runtimeVersion,
    adapterVersion: record.adapterVersion,
    ...(record.artifactDigest === undefined ? {} : { artifactDigest: record.artifactDigest }),
    bootChecks,
  };
};

const installationReceiptFromPayload = (value: unknown): InstallationReceipt | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== INSTALLATION_RECEIPT_VERSION) return null;
  const intent = installationIntentFromPayload(record.intent);
  if (intent === null) return null;
  const observation = installationObservationFromPayload(record.observation);
  if (observation === null) return null;
  return {
    version: INSTALLATION_RECEIPT_VERSION,
    intent,
    observation,
  };
};

export const installationReceiptFromLedgerEvent = (
  event: RecordedLedgerEvent,
): InstallationReceipt | null => {
  if (event.kind !== INSTALLATION_RECEIPT_EVENT_KIND) return null;
  const receipt = installationReceiptFromPayload(event.payload);
  if (receipt === null) return null;
  if (scopeRefKey(event.scopeRef) !== scopeRefKey(receipt.intent.truthIdentity.scopeRef)) {
    return null;
  }
  if (
    authorityRefKey(event.effectAuthorityRef) !==
    authorityRefKey(receipt.intent.truthIdentity.effectAuthorityRef)
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
    if (receipt !== null && receipt.intent.deploymentId === deploymentId) {
      current = receipt;
    }
  }
  return current;
};
