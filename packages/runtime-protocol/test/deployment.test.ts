import { describe, expect, it } from "@effect/vitest";
import { decodeRecordedLedgerEvent } from "@agent-os/kernel/types";
import {
  defineAgentManifest,
  EXECUTION_IDENTITY_VERSION,
  executionIdentityFromDeployment,
  installationReceiptEvent,
  installationReceiptFromDeployment,
  installationReceiptFromLedgerEvent,
  INSTALLATION_RECEIPT_EVENT_KIND,
  INSTALLATION_RECEIPT_VERSION,
  projectInstallationReceipt,
  RUNTIME_FACT_OWNER,
} from "../src";

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

describe("DeploymentSpec installation receipt", () => {
  it("derives a ledger append spec from manifest truth identity plus execution identity", () => {
    const event = installationReceiptEvent(deployment);

    expect(event).toMatchObject({
      kind: INSTALLATION_RECEIPT_EVENT_KIND,
      scopeRef: { kind: "session", scopeId: "deploy-session" },
      payload: {
        version: INSTALLATION_RECEIPT_VERSION,
        deploymentId: "deployment:worker:test",
        agentId: "agent.deployment-test",
        agentVersion: "1.0.0",
        backend: "cloudflare-do",
        adapter: "sse-http",
        codec: "ledger-v1",
        providerStrategy: "effect-ai",
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
      },
    });
    expect(event.effectAuthorityRef).toEqual({
      authorityClass: "agent",
      authorityId: "deployment-test",
    });
    expect(event).not.toHaveProperty("factOwnerRef");
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("https://");
  });

  it("keeps ledger truth key stable when deployment provenance changes", () => {
    const changed = {
      ...deployment,
      deploymentId: "deployment:worker:test-v2",
      adapter: "sse-http-v2",
      codec: "ledger-v2",
      providerStrategy: "effect-ai-structured",
    };

    const baseEvent = installationReceiptEvent(deployment);
    const changedEvent = installationReceiptEvent(changed);

    expect({
      scopeRef: changedEvent.scopeRef,
      effectAuthorityRef: changedEvent.effectAuthorityRef,
    }).toEqual({
      scopeRef: baseEvent.scopeRef,
      effectAuthorityRef: baseEvent.effectAuthorityRef,
    });
    expect(executionIdentityFromDeployment(changed)).not.toEqual(
      executionIdentityFromDeployment(deployment),
    );
  });

  it("reads the latest matching receipt from recorded ledger events", () => {
    const event = installationReceiptEvent(deployment);
    const recorded = decodeRecordedLedgerEvent({
      id: 2,
      ts: 1_700_000_000_000,
      kind: event.kind,
      scopeRef: event.scopeRef,
      effectAuthorityRef: event.effectAuthorityRef,
      factOwnerRef: RUNTIME_FACT_OWNER,
      payload: event.payload,
    });
    const other = decodeRecordedLedgerEvent({
      id: 1,
      ts: 1_700_000_000_000,
      kind: event.kind,
      scopeRef: event.scopeRef,
      effectAuthorityRef: event.effectAuthorityRef,
      factOwnerRef: RUNTIME_FACT_OWNER,
      payload: {
        ...installationReceiptFromDeployment(deployment),
        deploymentId: "deployment:worker:other",
      },
    });

    expect(installationReceiptFromLedgerEvent(recorded)).toEqual(
      installationReceiptFromDeployment(deployment),
    );
    expect(projectInstallationReceipt([other, recorded], "deployment:worker:test")).toEqual(
      installationReceiptFromDeployment(deployment),
    );
  });

  it("fails closed when the receipt payload identity does not match the ledger row", () => {
    const event = installationReceiptEvent(deployment);
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

  it("fails closed when execution identity is malformed", () => {
    const event = installationReceiptEvent(deployment);
    const receipt = installationReceiptFromDeployment(deployment);
    const recorded = decodeRecordedLedgerEvent({
      id: 1,
      ts: 1_700_000_000_000,
      kind: event.kind,
      scopeRef: event.scopeRef,
      effectAuthorityRef: event.effectAuthorityRef,
      factOwnerRef: RUNTIME_FACT_OWNER,
      payload: {
        ...receipt,
        executionIdentity: {
          ...receipt.executionIdentity,
          deployment: { ...receipt.executionIdentity.deployment, codec: "" },
        },
      },
    });

    expect(installationReceiptFromLedgerEvent(recorded)).toBeNull();
  });
});
