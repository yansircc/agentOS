import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { LedgerEvent, LedgerEventRpc } from "@agent-os/kernel/types";
import type { ExtensionCapability } from "@agent-os/kernel/extensions";
import { agentRunStartedEvent } from "@agent-os/runtime-protocol";
import { createSseHttpTextResponse, decodeSseHttpEvents } from "@agent-os/sse-http";
import { WORKSPACE_OP_FACT_OWNER, WORKSPACE_OP_KIND } from "@agent-os/workspace-op";
import type { WorkspaceJobProjection } from "@agent-os/workspace-job";
import {
  createCloudflareLedgerAgUiHistorySseResponse,
  createCloudflareLedgerAgUiSseResponse,
} from "../src/ag-ui-sse";
import { createCloudflareWorkspaceJobResponse } from "../src/workspace-job-facade";
import {
  createCloudflareSandboxWorkspaceEnvResolver,
  createCloudflareWorkspaceEnvResolver,
} from "../src/workspace-env";
import { installCloudflareWorkspaceOperationProvider } from "../src/workspace-op";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const collectAsync = async <A>(source: AsyncIterable<A>): Promise<ReadonlyArray<A>> => {
  const values: A[] = [];
  for await (const value of source) values.push(value);
  return values;
};

const chunksOf = async function* (value: string): AsyncGenerator<string> {
  yield value;
};

const ledgerEvent = (): LedgerEvent => {
  const event = agentRunStartedEvent({
    scopeRef: { kind: "conversation", scopeId: "cloudflare-ag-ui" },
    effectAuthorityRef: { authorityClass: "test", authorityId: "cloudflare-ag-ui" },
    intent: "render history",
  });
  return {
    id: 1,
    ts: 10,
    kind: event.kind,
    scopeRef: event.scopeRef,
    effectAuthorityRef: event.effectAuthorityRef,
    factOwnerRef: "@agent-os/runtime",
    payload: event.payload,
  };
};

const eventData = async (
  response: Response,
): Promise<ReadonlyArray<{ event?: string; data: string }>> =>
  collectAsync(decodeSseHttpEvents(chunksOf(await response.text())));

const workspaceJobProjection = (
  status: WorkspaceJobProjection["status"],
  runId = "run-1",
): WorkspaceJobProjection =>
  ({
    status,
    runId,
    requestedEventId: 1,
    request: {
      runId,
      idempotencyKey: "idem-1",
      requestedBy: "test",
      terminalSchemaId: "schema:test",
      claim: makePreClaim({
        operationRef: `workspace_job:${runId}`,
        scopeRef: { kind: "conversation", scopeId: "workspace-job-helper" },
        effectAuthorityRef: { authorityClass: "workspace", authorityId: "job" },
        originRef: { originId: "idem-1", originKind: "workspace_job" },
      }),
    },
  }) as WorkspaceJobProjection;

describe("Cloudflare DO workspace host helpers", () => {
  it("keeps sse-http generic while host helper materializes AG-UI SSE responses", async () => {
    const sseHttpSource = fs.readFileSync(
      path.join(repoRoot, "packages/transports/sse-http/src/index.ts"),
      "utf8",
    );
    const agUiSource = fs.readFileSync(
      path.join(repoRoot, "packages/wire-adapters/ag-ui/src/index.ts"),
      "utf8",
    );
    expect(sseHttpSource).not.toContain("@agent-os/ag-ui");
    expect(agUiSource).toContain("encodeAgUiLedgerEventEnvelopeSse");
    expect(agUiSource).toContain("projectLedgerSseToAgUiSse");

    const history = createCloudflareLedgerAgUiHistorySseResponse([ledgerEvent()]);
    expect(history.headers.get("content-type")).toContain("text/event-stream");
    const historyEvents = await eventData(history);
    expect(historyEvents).toHaveLength(1);
    expect(historyEvents[0]).toMatchObject({ event: "ag_ui" });

    const ledgerSse = ["event: ledger", `data: ${JSON.stringify(ledgerEvent())}`, "", ""].join(
      "\n",
    );
    const live = createCloudflareLedgerAgUiSseResponse(chunksOf(ledgerSse));
    const liveEvents = await eventData(live);
    expect(liveEvents).toHaveLength(1);
    expect(liveEvents[0]).toMatchObject({ event: "ag_ui" });

    const liveFromResponse = createCloudflareLedgerAgUiSseResponse(
      createSseHttpTextResponse(ledgerSse),
    );
    const liveResponseEvents = await eventData(liveFromResponse);
    expect(liveResponseEvents).toHaveLength(1);
    expect(liveResponseEvents[0]).toMatchObject({ event: "ag_ui" });
  });

  it("creates workspace-job responses only from the projection reader", async () => {
    const readRunIds: string[] = [];
    const response = await createCloudflareWorkspaceJobResponse({
      request: { headers: new Headers() },
      runId: "run-verified",
      submit: () => Promise.resolve(workspaceJobProjection("failed", "wrong-run")),
      waitUntil: () => undefined,
      quickWaitForSubmission: () => Promise.resolve("submitted"),
      readProjection: ({ runId }) => {
        readRunIds.push(runId);
        return Promise.resolve(workspaceJobProjection("verified", runId));
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projection: { status: "verified", runId: "run-verified" },
    });
    expect(readRunIds).toEqual(["run-verified"]);
  });

  it("renders workspace-job projections through a host wire-shape callback", async () => {
    const response = await createCloudflareWorkspaceJobResponse({
      request: { headers: new Headers() },
      runId: "run-wire",
      submit: () => Promise.resolve(workspaceJobProjection("verified", "wrong-run")),
      waitUntil: () => undefined,
      quickWaitForSubmission: () => Promise.resolve("submitted"),
      readProjection: ({ runId }) => Promise.resolve(workspaceJobProjection("verified", runId)),
      renderProjection: ({ projection, status, headers }) => {
        headers.set("x-rendered", "agent-run-projection");
        return new Response(
          JSON.stringify({
            runId: projection.runId,
            status: projection.status === "verified" ? "completed" : projection.status,
          }),
          { status, headers },
        );
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-rendered")).toBe("agent-run-projection");
    await expect(response.json()).resolves.toEqual({
      runId: "run-wire",
      status: "completed",
    });
  });

  it("honors Prefer respond-async and detaches submission through waitUntil", async () => {
    const waited: Promise<unknown>[] = [];
    const running = new Promise(() => undefined);
    const response = await createCloudflareWorkspaceJobResponse({
      request: { headers: new Headers({ prefer: "respond-async" }) },
      runId: "run-async",
      statusUrl: "https://test.local/jobs/run-async",
      submit: () => running,
      waitUntil: (promise) => {
        waited.push(promise);
      },
      quickWaitForSubmission: () => Promise.resolve("timeout"),
      readProjection: ({ runId }) => Promise.resolve(workspaceJobProjection("running", runId)),
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("preference-applied")).toBe("respond-async");
    expect(response.headers.get("location")).toBe("https://test.local/jobs/run-async");
    expect(waited).toEqual([running]);
    await expect(response.json()).resolves.toMatchObject({
      projection: { status: "running", runId: "run-async" },
    });
  });

  it("quick-wait timeouts return the current projection and keep the job alive", async () => {
    const waited: Promise<unknown>[] = [];
    const running = new Promise(() => undefined);
    const response = await createCloudflareWorkspaceJobResponse({
      request: { headers: new Headers() },
      runId: "run-timeout",
      quickWaitMs: 0,
      submit: () => running,
      waitUntil: (promise) => {
        waited.push(promise);
      },
      quickWaitForSubmission: () => Promise.resolve("timeout"),
      readProjection: ({ runId }) => Promise.resolve(workspaceJobProjection("running", runId)),
    });

    expect(response.status).toBe(202);
    expect(waited).toEqual([running]);
    await expect(response.json()).resolves.toMatchObject({
      projection: { status: "running", runId: "run-timeout" },
    });
  });

  it("resolves one Cloudflare WorkspaceEnv lease per scope/run and validates bindings", async () => {
    const sandboxIds: string[] = [];
    const cleaned: string[] = [];
    const resolver = createCloudflareWorkspaceEnvResolver({
      binding: {
        getSandbox: (sandboxId) => {
          sandboxIds.push(sandboxId);
          return {
            id: sandboxId,
            exec: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
          };
        },
      },
      cleanup: (_env, input) => {
        cleaned.push(input.runId);
      },
    });

    const first = await resolver.resolve({ scope: "scope-1", runId: "run-1" });
    const second = await resolver.resolve({ scope: "scope-1", runId: "run-1" });
    const third = await resolver.resolve({ scope: "scope-1", runId: "run-2" });

    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(sandboxIds).toEqual(["workspace-job:scope-1:run-1", "workspace-job:scope-1:run-2"]);
    expect(first.env.domain.ref).toBe("cloudflare-sandbox:scope-1:run-1");

    await first.cleanup();
    const afterCleanup = await resolver.resolve({ scope: "scope-1", runId: "run-1" });
    expect(afterCleanup).not.toBe(first);
    expect(cleaned).toEqual(["run-1"]);
    expect(sandboxIds).toEqual([
      "workspace-job:scope-1:run-1",
      "workspace-job:scope-1:run-2",
      "workspace-job:scope-1:run-1",
    ]);

    const invalid = createCloudflareWorkspaceEnvResolver({
      binding: {
        getSandbox: () => ({}) as never,
      },
    });
    await expect(invalid.resolve({ scope: "scope-1", runId: "bad" })).rejects.toThrow(
      "Cloudflare workspace client missing exec",
    );
  });

  it("resolves Cloudflare Sandbox bindings with run-scoped leases and sessionless transport", async () => {
    const requestedIds: string[] = [];
    const sandboxNames: Array<{ name: string; normalizeId: boolean | undefined }> = [];
    const transports: string[] = [];
    const execCalls: Array<{ command: string; token: string; cwd: string | undefined }> = [];
    const cleaned: string[] = [];
    const stub = {
      setSandboxName: async (name: string, normalizeId?: boolean) => {
        sandboxNames.push({ name, normalizeId });
      },
      setTransport: async (transport: string) => {
        transports.push(transport);
      },
      execWithSessionToken: async (
        command: string,
        token: string,
        options?: { readonly cwd?: string },
      ) => {
        execCalls.push({ command, token, cwd: options?.cwd });
        return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
      },
    };
    const namespace = {
      idFromName: (name: string) => {
        requestedIds.push(name);
        return { name } as unknown as DurableObjectId;
      },
      get: (id: DurableObjectId) => {
        expect(id).toMatchObject({ name: requestedIds.at(-1) });
        return stub;
      },
    } as unknown as DurableObjectNamespace<never>;
    const resolver = createCloudflareSandboxWorkspaceEnvResolver({
      binding: namespace as unknown as Parameters<
        typeof createCloudflareSandboxWorkspaceEnvResolver
      >[0]["binding"],
      cwd: "/workspace",
      scopePrefix: "ZeroY",
      transport: "rpc",
      cleanup: ({ runId, sandboxId, workspaceRef }) => {
        cleaned.push(`${runId}:${sandboxId}:${workspaceRef}`);
      },
    });

    const first = await resolver.resolve({ scope: "Customer Site", runId: "Run-ABC-123" });
    const second = await resolver.resolve({ scope: "Customer Site", runId: "Run-ABC-123" });
    const third = await resolver.resolve({ scope: "Customer Site", runId: "Run-DEF-456" });

    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(first.sandboxId).toMatch(/^zeroy-wj-run-abc-123-[a-z0-9]+$/);
    expect(first.sandboxId).not.toContain(":");
    expect(first.sandboxId.length).toBeLessThanOrEqual(63);
    expect(first.workspaceRef).toBe("ZeroY:cloudflare-sandbox:Customer Site:Run-ABC-123");
    expect(first.env.domain.ref).toBe("ZeroY:cloudflare-sandbox:Customer Site:Run-ABC-123");
    expect(requestedIds).toEqual([first.sandboxId, third.sandboxId]);
    expect(sandboxNames).toEqual([
      { name: first.sandboxId, normalizeId: true },
      { name: third.sandboxId, normalizeId: true },
    ]);
    expect(transports).toEqual(["rpc", "rpc"]);

    await first.env.exec("pwd", { timeoutMs: 100 });
    expect(execCalls).toEqual([
      { command: "pwd", token: "__DISABLE_SESSION__", cwd: "/workspace" },
    ]);

    await first.cleanup();
    const afterCleanup = await resolver.resolve({ scope: "Customer Site", runId: "Run-ABC-123" });
    expect(afterCleanup).not.toBe(first);
    expect(cleaned).toEqual([
      `Run-ABC-123:${first.sandboxId}:ZeroY:cloudflare-sandbox:Customer Site:Run-ABC-123`,
    ]);
    expect(requestedIds).toEqual([first.sandboxId, third.sandboxId, afterCleanup.sandboxId]);

    const invalid = createCloudflareSandboxWorkspaceEnvResolver({
      binding: {} as never,
    });
    await expect(invalid.resolve({ scope: "scope", runId: "run" })).rejects.toThrow(
      "Cloudflare Sandbox binding missing Durable Object namespace methods",
    );
  });

  it("allows hosts to declare the WorkspaceEnv ref carried by workspace operations", async () => {
    const requestedIds: string[] = [];
    const stub = {
      setSandboxName: async () => undefined,
      setTransport: async () => undefined,
      execWithSessionToken: async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 1,
      }),
    };
    const namespace = {
      idFromName: (name: string) => {
        requestedIds.push(name);
        return { name } as unknown as DurableObjectId;
      },
      get: () => stub,
    } as unknown as DurableObjectNamespace<never>;
    const resolver = createCloudflareSandboxWorkspaceEnvResolver({
      binding: namespace as unknown as Parameters<
        typeof createCloudflareSandboxWorkspaceEnvResolver
      >[0]["binding"],
      scopePrefix: "ZeroY",
      workspaceRef: ({ runId }) => runId,
    });

    const lease = await resolver.resolve({ scope: "Customer Site", runId: "Run-ABC-123" });

    expect(lease.sandboxId).toMatch(/^zeroy-wj-run-abc-123-[a-z0-9]+$/);
    expect(requestedIds).toEqual([lease.sandboxId]);
    expect(lease.workspaceRef).toBe("Run-ABC-123");
    expect(lease.env.domain.ref).toBe("Run-ABC-123");
  });

  it("installs workspace-op provider handlers that commit only through boundary capability", async () => {
    let written: { path: string; content: string | Uint8Array } | null = null;
    const install = installCloudflareWorkspaceOperationProvider({
      env: {
        domain: { kind: "sandbox", ref: "workspace:test" },
        cwd: "/workspace",
        resolvePath: (targetPath) => targetPath,
        readFile: async () => "",
        readFileBuffer: async () => new Uint8Array(),
        writeFile: async (targetPath, content) => {
          written = { path: targetPath, content };
        },
        stat: async () => ({ type: "file" }),
        readdir: async () => [],
        exists: async () => true,
        mkdir: async () => undefined,
        rm: async () => undefined,
        exec: async () => ({
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
    expect(install.extensions[0]).toMatchObject({
      packageId: WORKSPACE_OP_FACT_OWNER,
      kindPrefixes: ["workspace_op."],
    });
    expect(install.declaredIntents).toEqual([
      { kind: WORKSPACE_OP_KIND.REQUESTED, boundaryPackageId: WORKSPACE_OP_FACT_OWNER },
    ]);

    const committed: Array<{ event: string; data: unknown }> = [];
    const capability: ExtensionCapability = {
      packageId: WORKSPACE_OP_FACT_OWNER,
      kindPrefixes: ["workspace_op."],
      version: "0.2.9",
      commit: async (spec) => {
        committed.push(spec);
        return { id: committed.length + 10 };
      },
      time: async () => ({ id: 0 }),
    };
    const [registration] = [
      ...install.eventHandlers({ capabilities: new Map([[WORKSPACE_OP_FACT_OWNER, capability]]) }),
    ];
    expect(registration?.kind).toBe(WORKSPACE_OP_KIND.REQUESTED);

    const claim = makePreClaim({
      operationRef: "tool:workspace:test:call-1",
      scopeRef: { kind: "conversation", scopeId: "workspace-op-helper" },
      effectAuthorityRef: { authorityClass: "workspace", authorityId: "write_file" },
      originRef: { originId: "run:1", originKind: "submit" },
    });
    const event: LedgerEventRpc = {
      id: 7,
      ts: 70,
      kind: WORKSPACE_OP_KIND.REQUESTED,
      scopeRef: claim.scopeRef,
      effectAuthorityRef: claim.effectAuthorityRef,
      factOwnerRef: WORKSPACE_OP_FACT_OWNER,
      payload: {
        requestedBy: "@agent-os/workspace-binding",
        workspaceRef: "workspace:test",
        toolName: "write_file",
        path: "result.txt",
        content: "done",
        claim,
      },
    };
    await registration!.handler(event);

    expect(written).toEqual({ path: "result.txt", content: "done" });
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      event: WORKSPACE_OP_KIND.COMPLETED,
      data: {
        requestedEventId: 7,
        operationRef: claim.operationRef,
        workspaceRef: "workspace:test",
        toolName: "write_file",
        path: "result.txt",
        bytesWritten: 4,
      },
    });

    const rejectedClaim = makePreClaim({
      operationRef: "tool:workspace:test:call-2",
      scopeRef: { kind: "conversation", scopeId: "workspace-op-helper" },
      effectAuthorityRef: { authorityClass: "workspace", authorityId: "write_file" },
      originRef: { originId: "run:1", originKind: "submit" },
    });
    await registration!.handler({
      id: 8,
      ts: 80,
      kind: WORKSPACE_OP_KIND.REQUESTED,
      scopeRef: rejectedClaim.scopeRef,
      effectAuthorityRef: rejectedClaim.effectAuthorityRef,
      factOwnerRef: WORKSPACE_OP_FACT_OWNER,
      payload: {
        requestedBy: "@agent-os/workspace-binding",
        workspaceRef: "workspace:test",
        toolName: "write_file",
        path: "missing-content.txt",
        claim: rejectedClaim,
      },
    });

    expect(committed).toHaveLength(2);
    expect(committed[1]).toMatchObject({
      event: WORKSPACE_OP_KIND.REJECTED,
      data: {
        requestedEventId: 8,
        operationRef: rejectedClaim.operationRef,
        workspaceRef: "workspace:test",
        toolName: "write_file",
        reason: "write_file requires content",
      },
    });
  });

  it("resolves workspace-op env per requested workspace/run instead of install time", async () => {
    const resolved: string[] = [];
    const writes: string[] = [];
    const install = installCloudflareWorkspaceOperationProvider({
      env: ({ workspaceRef, runId }) => {
        resolved.push(`${workspaceRef}:${runId ?? "none"}`);
        return {
          domain: { kind: "sandbox", ref: workspaceRef },
          cwd: "/workspace",
          resolvePath: (targetPath) => targetPath,
          readFile: async () => "",
          readFileBuffer: async () => new Uint8Array(),
          writeFile: async (targetPath, content) => {
            const text = typeof content === "string" ? content : new TextDecoder().decode(content);
            writes.push(`${workspaceRef}:${targetPath}:${text}`);
          },
          stat: async () => ({ type: "file" }),
          readdir: async () => [],
          exists: async () => true,
          mkdir: async () => undefined,
          rm: async () => undefined,
          exec: async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
            stdoutBytes: 0,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 0,
          }),
        };
      },
    });
    const capability: ExtensionCapability = {
      packageId: WORKSPACE_OP_FACT_OWNER,
      kindPrefixes: ["workspace_op."],
      version: "0.2.9",
      commit: async () => ({ id: 1 }),
      time: async () => ({ id: 0 }),
    };
    const [registration] = [
      ...install.eventHandlers({ capabilities: new Map([[WORKSPACE_OP_FACT_OWNER, capability]]) }),
    ];
    const eventFor = (id: number, runId: string): LedgerEventRpc => {
      const claim = makePreClaim({
        operationRef: `tool:workspace:test:call-${id}`,
        scopeRef: { kind: "conversation", scopeId: "workspace-op-helper" },
        effectAuthorityRef: { authorityClass: "workspace", authorityId: "write_file" },
        originRef: { originId: `run:${runId}`, originKind: "submit" },
      });
      return {
        id,
        ts: id * 10,
        kind: WORKSPACE_OP_KIND.REQUESTED,
        scopeRef: claim.scopeRef,
        effectAuthorityRef: claim.effectAuthorityRef,
        factOwnerRef: WORKSPACE_OP_FACT_OWNER,
        payload: {
          requestedBy: "@agent-os/workspace-binding",
          workspaceRef: "workspace:dynamic",
          toolName: "write_file",
          path: `result-${id}.txt`,
          content: `done-${id}`,
          claim,
        },
      };
    };

    await registration!.handler(eventFor(10, "1"));
    await registration!.handler(eventFor(11, "1"));
    await registration!.handler(eventFor(12, "2"));

    expect(resolved).toEqual(["workspace:dynamic:1", "workspace:dynamic:2"]);
    expect(writes).toEqual([
      "workspace:dynamic:result-10.txt:done-10",
      "workspace:dynamic:result-11.txt:done-11",
      "workspace:dynamic:result-12.txt:done-12",
    ]);
  });
});
