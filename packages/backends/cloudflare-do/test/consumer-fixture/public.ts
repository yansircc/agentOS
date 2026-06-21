/// <reference types="@cloudflare/workers-types" />

import {
  createCloudflareLedgerAgUiHistorySseResponse,
  createCloudflareSandboxWorkspaceEnvResolver,
  createCloudflareWorkspaceJobResponse,
  createCloudflareWorkspaceEnvResolver,
  createAgentDurableObject,
  installCloudflareWorkspaceJobProfile,
  installCloudflareWorkspaceOperationProvider,
  type CloudflareAgentEnv,
} from "@agent-os/backend-cloudflare-do";
import {
  durableObjectRpcClient,
  type DurableObjectRpcClient,
} from "@agent-os/backend-cloudflare-do/do-rpc";
import { defineAgentBindings, defineAgentManifest } from "@agent-os/runtime-protocol";
import { triggerParseOk, type TriggerTx } from "@agent-os/runtime";
import { Effect } from "effect";
import { ToolError } from "@agent-os/kernel/errors";
import type { LedgerEventRpc } from "@agent-os/kernel/types";

interface Intent {
  readonly ok: true;
}

const trigger = {
  kind: "fixture.trigger",
  intentEventKind: "fixture.trigger.requested",
  cancellation: "cooperative" as const,
  parseIntent: () => triggerParseOk<Intent>({ ok: true }),
  acquire: (intent: Intent) =>
    Effect.withSpan("agentos.test.consumer_fixture.trigger_acquire")(Effect.succeed(intent)),
  commit: (outcome: Intent, tx: TriggerTx) => {
    tx.insertEvent({ kind: "fixture.trigger.done", payload: outcome });
  },
  commitCancelled: () => undefined,
};

export const FixtureDO = createAgentDurableObject<CloudflareAgentEnv>({
  manifest: defineAgentManifest({
    agentId: "fixture.cloudflare-do",
    scope: { kind: "conversation", idSource: "submit_scope" },
    effectAuthorityRef: { authorityClass: "agent", authorityId: "fixture.cloudflare-do" },
    handlers: [] as const,
  }),
  agentBindings: defineAgentBindings<never>({
    handlers: {},
  }),
  triggers: [trigger],
});

interface FixtureRpcProtocol {
  readonly ping: (input: { readonly value: string }) => Promise<string>;
}

export const fixtureRpcClient = (
  namespace: DurableObjectNamespace,
): DurableObjectRpcClient<FixtureRpcProtocol> =>
  durableObjectRpcClient<FixtureRpcProtocol>(namespace, "fixture");

export const firstKind = (events: ReadonlyArray<LedgerEventRpc>): string | null =>
  events[0]?.kind ?? null;

export const fixtureToolError = new ToolError({
  toolName: "fixture",
  cause: "consumer-visible constructor",
});

export const fixtureAgUiHistoryResponse = createCloudflareLedgerAgUiHistorySseResponse([]);

export const fixtureWorkspaceJobResponse = createCloudflareWorkspaceJobResponse({
  request: { headers: new Headers() },
  runId: "fixture-run",
  submit: () => Promise.resolve(),
  waitUntil: () => undefined,
  quickWaitForSubmission: () => Promise.resolve("submitted"),
  readProjection: ({ runId }) =>
    Promise.resolve({
      status: "missing",
      runId,
    }),
});

export const fixtureWorkspaceResolver = createCloudflareWorkspaceEnvResolver({
  binding: {
    getSandbox: () => ({
      exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    }),
  },
});

const fixtureSandboxNamespace = {
  idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
  get: () => ({
    setSandboxName: () => Promise.resolve(),
    setTransport: () => Promise.resolve(),
    execWithSessionToken: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  }),
} as unknown as Parameters<typeof createCloudflareSandboxWorkspaceEnvResolver>[0]["binding"];

export const fixtureSandboxWorkspaceResolver = createCloudflareSandboxWorkspaceEnvResolver({
  binding: fixtureSandboxNamespace,
});

export const fixtureWorkspaceOpInstall = installCloudflareWorkspaceOperationProvider({
  env: {
    domain: { kind: "sandbox", ref: "fixture" },
    cwd: "/workspace",
    resolvePath: (path: string): string => path,
    readFile: () => Promise.resolve(""),
    readFileBuffer: () => Promise.resolve(new Uint8Array()),
    writeFile: () => Promise.resolve(),
    stat: () => Promise.resolve({ type: "file" }),
    readdir: () => Promise.resolve([]),
    exists: () => Promise.resolve(true),
    mkdir: () => Promise.resolve(),
    rm: () => Promise.resolve(),
    exec: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0,
      }),
  },
});

export const fixtureWorkspaceJobProfile = installCloudflareWorkspaceJobProfile({
  workspaceResolver: fixtureSandboxWorkspaceResolver,
  readProjection: ({ runId }) =>
    Promise.resolve({
      status: "missing",
      runId,
    }),
});
