import { describe, expect, it } from "@effect/vitest";
import { decodeRecordedLedgerEvent } from "@agent-os/core/types";
import {
  defineAgentManifest,
  EXECUTION_IDENTITY_VERSION,
  executionIdentityFromDeployment,
  installationIntentFromDeployment,
  installationObservation,
  installationReceiptEvent,
  installationReceiptFromLedgerEvent,
  installationReceiptFromObservation,
  INSTALLATION_INTENT_VERSION,
  INSTALLATION_OBSERVATION_VERSION,
  INSTALLATION_RECEIPT_EVENT_KIND,
  INSTALLATION_RECEIPT_VERSION,
  projectInstallationReceipt,
  RUNTIME_FACT_OWNER,
} from "../../src/runtime-protocol";

const manifest = defineAgentManifest({
  agentId: "agent.deployment-test",
  version: "1.0.0",
  scope: { kind: "session", idSource: "manifest", stableScopeId: "deploy-session" },
  effectAuthorityRef: {
    authorityClass: "agent",
    authorityId: "deployment-test",
  },
  handlers: ["user_message"] as const,
});

const deployment = {
  deploymentId: "deployment:worker:test",
  manifest,
  backend: "cloudflare-do",
  adapter: "sse-http",
  codec: "ledger-v1",
  providerStrategy: "effect-ai",
};

const observedInstallation = (override: Partial<ReturnType<typeof installationObservation>> = {}) =>
  installationObservation({
    intent: installationIntentFromDeployment(deployment),
    observedAtMs: 1_700_000_000_000,
    runtimeVersion: "runtime-protocol-test",
    adapterVersion: "cloudflare-do-test",
    artifactDigest: "sha256:test-worker",
    bootChecks: [
      { name: "target_module_loaded", status: "passed", observedValue: "AgentOS" },
      { name: "adapter_versions_observed", status: "passed" },
    ],
    ...override,
  });

describe("DeploymentSpec installation intent and receipt", () => {
  it("derives installation intent from deployment declarations without minting a receipt", () => {
    const intent = installationIntentFromDeployment(deployment);

    expect(intent).toEqual({
      version: INSTALLATION_INTENT_VERSION,
      deploymentId: "deployment:worker:test",
      agentId: "agent.deployment-test",
      agentVersion: "1.0.0",
      backend: "cloudflare-do",
      adapter: "sse-http",
      codec: "ledger-v1",
      providerStrategy: "effect-ai",
      truthIdentity: {
        scopeRef: { kind: "session", scopeId: "deploy-session" },
        effectAuthorityRef: { authorityClass: "agent", authorityId: "deployment-test" },
      },
      executionIdentity: {
        version: EXECUTION_IDENTITY_VERSION,
        manifest: { agentId: "agent.deployment-test", version: "1.0.0" },
        deployment: {
          deploymentId: "deployment:worker:test",
          backend: "cloudflare-do",
          adapter: "sse-http",
          codec: "ledger-v1",
          providerStrategy: "effect-ai",
        },
      },
    });
    expect(JSON.stringify(intent)).not.toContain("secret");
    expect(JSON.stringify(intent)).not.toContain("https://");
  });

  it("derives a receipt append spec only from boot-time observation", () => {
    const observation = observedInstallation();
    const event = installationReceiptEvent(observation);

    expect(event).toMatchObject({
      kind: INSTALLATION_RECEIPT_EVENT_KIND,
      scopeRef: { kind: "session", scopeId: "deploy-session" },
      effectAuthorityRef: { authorityClass: "agent", authorityId: "deployment-test" },
      payload: {
        version: INSTALLATION_RECEIPT_VERSION,
        intent: { version: INSTALLATION_INTENT_VERSION, deploymentId: "deployment:worker:test" },
        observation: {
          version: INSTALLATION_OBSERVATION_VERSION,
          observedAtMs: 1_700_000_000_000,
          runtimeVersion: "runtime-protocol-test",
          adapterVersion: "cloudflare-do-test",
          artifactDigest: "sha256:test-worker",
          bootChecks: [
            { name: "target_module_loaded", status: "passed", observedValue: "AgentOS" },
            { name: "adapter_versions_observed", status: "passed" },
          ],
        },
      },
    });
    expect(event).not.toHaveProperty("factOwnerRef");
  });

  it("does not accept a deployment spec as receipt event input", () => {
    const preBootReceipt = () => {
      // @ts-expect-error build-time DeploymentSpec cannot mint InstallationReceipt.
      installationReceiptEvent(deployment);
    };

    expect(preBootReceipt).toBeDefined();
  });

  it("keeps ledger truth key stable when deployment provenance changes", () => {
    const changed = {
      ...deployment,
      deploymentId: "deployment:worker:test-v2",
      adapter: "sse-http-v2",
      codec: "ledger-v2",
      providerStrategy: "effect-ai-structured",
    };

    const baseIntent = installationIntentFromDeployment(deployment);
    const changedIntent = installationIntentFromDeployment(changed);

    expect(changedIntent.truthIdentity).toEqual(baseIntent.truthIdentity);
    expect(executionIdentityFromDeployment(changed)).not.toEqual(
      executionIdentityFromDeployment(deployment),
    );
  });

  it("rejects observations without positive boot checks", () => {
    expect(() =>
      installationObservation({
        intent: installationIntentFromDeployment(deployment),
        observedAtMs: 1_700_000_000_000,
        runtimeVersion: "runtime-protocol-test",
        adapterVersion: "cloudflare-do-test",
        bootChecks: [],
      }),
    ).toThrow(/bootChecks/);
  });

  it("reads the latest matching receipt from recorded ledger events", () => {
    const observation = observedInstallation();
    const event = installationReceiptEvent(observation);
    const receipt = installationReceiptFromObservation(observation);
    const recorded = decodeRecordedLedgerEvent({
      id: 2,
      ts: 1_700_000_000_000,
      kind: event.kind,
      scopeRef: event.scopeRef,
      effectAuthorityRef: event.effectAuthorityRef,
      factOwnerRef: RUNTIME_FACT_OWNER,
      payload: event.payload,
    });
    const otherObservation = observedInstallation({
      intent: {
        ...installationIntentFromDeployment(deployment),
        deploymentId: "deployment:worker:other",
      },
    });
    const otherEvent = installationReceiptEvent(otherObservation);
    const other = decodeRecordedLedgerEvent({
      id: 1,
      ts: 1_700_000_000_000,
      kind: otherEvent.kind,
      scopeRef: otherEvent.scopeRef,
      effectAuthorityRef: otherEvent.effectAuthorityRef,
      factOwnerRef: RUNTIME_FACT_OWNER,
      payload: otherEvent.payload,
    });

    expect(installationReceiptFromLedgerEvent(recorded)).toEqual(receipt);
    expect(projectInstallationReceipt([other, recorded], "deployment:worker:test")).toEqual(
      receipt,
    );
  });

  it("fails closed when the receipt payload identity does not match the ledger row", () => {
    const event = installationReceiptEvent(observedInstallation());
    const recorded = decodeRecordedLedgerEvent({
      id: 1,
      ts: 1_700_000_000_000,
      kind: event.kind,
      scopeRef: event.scopeRef,
      effectAuthorityRef: { authorityClass: "agent", authorityId: "other" },
      factOwnerRef: RUNTIME_FACT_OWNER,
      payload: event.payload,
    });

    expect(installationReceiptFromLedgerEvent(recorded)).toBeNull();
    expect(projectInstallationReceipt([recorded], "deployment:worker:test")).toBeNull();
  });

  it("fails closed when execution identity or boot checks are malformed", () => {
    const observation = observedInstallation();
    const event = installationReceiptEvent(observation);
    const receipt = installationReceiptFromObservation(observation);
    const malformedExecutionIdentity = decodeRecordedLedgerEvent({
      id: 1,
      ts: 1_700_000_000_000,
      kind: event.kind,
      scopeRef: event.scopeRef,
      effectAuthorityRef: event.effectAuthorityRef,
      factOwnerRef: RUNTIME_FACT_OWNER,
      payload: {
        ...receipt,
        intent: {
          ...receipt.intent,
          executionIdentity: {
            ...receipt.intent.executionIdentity,
            deployment: { ...receipt.intent.executionIdentity.deployment, codec: "" },
          },
        },
      },
    });
    const malformedBootChecks = decodeRecordedLedgerEvent({
      id: 2,
      ts: 1_700_000_000_000,
      kind: event.kind,
      scopeRef: event.scopeRef,
      effectAuthorityRef: event.effectAuthorityRef,
      factOwnerRef: RUNTIME_FACT_OWNER,
      payload: {
        ...receipt,
        observation: { ...receipt.observation, bootChecks: [] },
      },
    });

    expect(installationReceiptFromLedgerEvent(malformedExecutionIdentity)).toBeNull();
    expect(installationReceiptFromLedgerEvent(malformedBootChecks)).toBeNull();
  });
});
