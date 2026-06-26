import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  HttpClient as HttpClientTag,
  type HttpClient as HttpClientService,
} from "effect/unstable/http/HttpClient";
import type { HttpClientRequest } from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import {
  DYNAMIC_CAPABILITY_EVENT,
  DYNAMIC_CAPABILITY_PROJECTION_VERSION,
  DYNAMIC_CAPABILITY_VISIBILITY,
  RUNTIME_EVENT_KIND,
} from "@agent-os/core/runtime-protocol";
import type { LlmRequest } from "@agent-os/core/llm-protocol";
import {
  createLocalAgentRuntime,
  createLocalWorkspaceEnv,
  LocalAgentRuntimeResolveError,
  lowerLocalAgentRuntime,
} from "@agent-os/runtime/local";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  WORKSPACE_OP_PROJECTION_KIND,
} from "../../src/workspace-op-carrier";
import {
  makeOpenAiCompatibleLlmTransportLayer,
  preflightOpenAiCompatibleProviderMaterial,
} from "../../src/llm-effect-ai/openai-compatible";

const withTempWorkspace = async <A>(
  run: (root: string, base: string) => Promise<A>,
): Promise<A> => {
  const base = await mkdtemp(path.join(tmpdir(), "agentos-local-workspace-"));
  const root = path.join(base, "workspace");
  await mkdir(root);
  try {
    return await run(root, base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
};

const nodeCommand = (script: string): string =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

const httpResponse = (status: number, body: unknown): HttpClientResponse =>
  ({
    status,
    json: Effect.succeed(body),
    text: Effect.succeed(JSON.stringify(body)),
  }) as unknown as HttpClientResponse;

const fakeHttpClient = (
  execute: (request: HttpClientRequest) => Effect.Effect<HttpClientResponse>,
): HttpClientService =>
  ({
    execute,
  }) as unknown as HttpClientService;

const httpClientLive = (client: HttpClientService) => Layer.succeed(HttpClientTag, client);

describe("createLocalWorkspaceEnv", () => {
  it("wraps local filesystem operations in the shared workspace root contract", async () => {
    await withTempWorkspace(async (root, base) => {
      const env = createLocalWorkspaceEnv({ cwd: root });

      await env.writeFile("nested/result.txt", "done");

      await expect(env.readFile("./nested/result.txt")).resolves.toBe("done");
      await expect(env.exists("nested/result.txt")).resolves.toBe(true);
      await expect(env.stat("nested")).resolves.toMatchObject({ type: "directory" });
      await expect(env.readdir(".")).resolves.toEqual(["nested"]);
      await expect(env.writeFile("../outside.txt", "escape")).rejects.toThrow("escape root");
      await expect(readFile(path.join(base, "outside.txt"), "utf8")).rejects.toThrow();
    });
  });

  it("runs commands with explicit env only unless inheritEnv is enabled", async () => {
    await withTempWorkspace(async (root) => {
      const env = createLocalWorkspaceEnv({
        cwd: root,
        env: { AGENTOS_LOCAL_ONLY: "set" },
        inheritEnv: false,
      });

      const result = await env.exec(
        nodeCommand(
          [
            "process.stdout.write(process.env.AGENTOS_LOCAL_ONLY ?? 'missing');",
            "process.stderr.write(process.env.PATH === undefined ? 'no-path' : 'path');",
          ].join(""),
        ),
        { timeoutMs: 5_000 },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("set");
      expect(result.stderr).toBe("no-path");
    });
  });

  it("fails closed for symbolic env and material refs", async () => {
    await withTempWorkspace(async (root) => {
      const env = createLocalWorkspaceEnv({ cwd: root });

      await expect(
        env.exec("echo no-env-ref-resolution", {
          timeoutMs: 5_000,
          envRefs: { API_KEY: "secret:api-key" },
        }),
      ).rejects.toThrow("symbolic env refs");
      await expect(
        env.exec("echo no-material-ref-resolution", {
          timeoutMs: 5_000,
          materialRefs: ["material:workspace"],
        }),
      ).rejects.toThrow("symbolic material refs");
    });
  });

  it("reports bytes and truncation for command output", async () => {
    await withTempWorkspace(async (root) => {
      const env = createLocalWorkspaceEnv({ cwd: root });

      const result = await env.exec(nodeCommand("process.stdout.write('abcdef');"), {
        timeoutMs: 5_000,
        maxOutputBytes: 3,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("abc");
      expect(result.stdoutBytes).toBe(6);
      expect(result.stdoutTruncated).toBe(true);
    });
  });

  it("creates a local agent runtime over resolveRuntime and private submitAgentEffect", async () => {
    await withTempWorkspace(async (root) => {
      const runtime = await createLocalAgentRuntime({
        identity: "local-runtime",
        cwd: root,
        llm: {
          kind: "test",
          responses: [
            {
              items: [{ type: "message", text: "local done" }],
              usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
            },
          ],
        },
      });

      expect(Object.keys(runtime).sort()).toEqual(["diagnostics", "events", "inspect", "submit"]);
      const initialInspection = runtime.inspect();
      expect(initialInspection.compile).toEqual({
        status: "available",
        target: "local@1",
        manifest: expect.objectContaining({ host: "local@1" }),
      });
      expect(initialInspection.resolve.status).toBe("available");
      if (initialInspection.resolve.status !== "available") return;
      expect(initialInspection.resolve.hostFacts).toContainEqual({
        fact: "fs.workspace",
        status: "provided",
        requiredBy: [WORKSPACE_OP_FACT_OWNER],
        optionalFor: [],
      });
      expect(initialInspection.resolve.graph.handlers).toEqual(
        expect.arrayContaining([
          {
            kind: WORKSPACE_OP_KIND.REQUESTED,
            capabilityId: WORKSPACE_OP_FACT_OWNER,
          },
        ]),
      );
      expect(initialInspection.resolve.bindings.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "write_file",
            authority: expect.objectContaining({
              authorityClass: "agentos.workspace.capability",
            }),
            receiptBackedIntentKinds: [WORKSPACE_OP_KIND.REQUESTED],
          }),
        ]),
      );
      expect(initialInspection.runtime).toEqual({
        status: "available",
        events: [],
        diagnostics: [],
      });
      const result = await runtime.submit({ intent: "finish locally" });

      expect(result).toMatchObject({
        ok: true,
        status: "delivered",
        final: "local done",
        tokensUsed: 3,
      });
      expect(runtime.diagnostics()).toEqual([]);
      expect(runtime.events().map((event) => event.kind)).toEqual(
        expect.arrayContaining([
          RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
          RUNTIME_EVENT_KIND.LLM_REQUESTED,
          RUNTIME_EVENT_KIND.LLM_RESPONSE,
          RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
        ]),
      );
      const inspectionAfterSubmit = runtime.inspect();
      expect(inspectionAfterSubmit.runtime.status).toBe("available");
      if (inspectionAfterSubmit.runtime.status !== "available") return;
      expect(inspectionAfterSubmit.runtime.diagnostics).toEqual([]);
      expect(inspectionAfterSubmit.runtime.events.map((event) => event.kind)).toEqual(
        expect.arrayContaining([
          RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
          RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
        ]),
      );
    });
  });

  it("carries dynamic projection and instruction fragments through local submit assembly", async () => {
    await withTempWorkspace(async (root) => {
      let observedRequest: LlmRequest | undefined;
      const runtime = await createLocalAgentRuntime({
        identity: "local-dynamic-assembly",
        cwd: root,
        llm: {
          kind: "test",
          handler: (request) => {
            observedRequest = request;
            return {
              items: [{ type: "message", text: "dynamic done" }],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            };
          },
        },
      });

      const result = await runtime.submit({
        intent: "finish with dynamic prompt",
        dynamicCapabilityProjection: {
          version: DYNAMIC_CAPABILITY_PROJECTION_VERSION,
          event: { name: DYNAMIC_CAPABILITY_EVENT.TURN_STARTED },
          tools: [],
          skills: [],
          instructions: [
            {
              id: "tone",
              digest: "fnv1a32:tone",
              visible: true,
              decision: DYNAMIC_CAPABILITY_VISIBILITY.ALLOWED,
              provenance: [],
            },
            {
              id: "hidden",
              digest: "fnv1a32:hidden",
              visible: false,
              decision: DYNAMIC_CAPABILITY_VISIBILITY.DENIED,
              provenance: [],
            },
          ],
          provenance: [],
        },
        instructionFragments: [
          { id: "hidden", digest: "fnv1a32:hidden", text: "Hidden fragment." },
          { id: "tone", digest: "fnv1a32:tone", text: "Use a dynamic tone." },
        ],
      });

      expect(result).toMatchObject({ ok: true, final: "dynamic done" });
      const systemMessage = observedRequest?.messages[0]?.content ?? "";
      expect(systemMessage).toContain("Use a dynamic tone.");
      expect(systemMessage).not.toContain("Hidden fragment.");
    });
  });

  it("installs an OpenAI-compatible local transport without product-side llm handler glue", async () => {
    await withTempWorkspace(async (root) => {
      let providerCalls = 0;
      const client = fakeHttpClient(() => {
        providerCalls += 1;
        return Effect.succeed(
          httpResponse(200, {
            choices: [{ message: { content: "provider done" } }],
            usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
          }),
        );
      });

      const runtime = await createLocalAgentRuntime({
        identity: "local-openai-compatible",
        cwd: root,
        llm: {
          kind: "transport",
          route: {
            kind: "openai-chat-compatible",
            endpointRef: "openai",
            credentialRef: "openai-key",
            modelId: "gpt-test",
          },
          refResolver: {
            material: (ref) => {
              if (ref.kind === "endpoint" && ref.ref === "openai") {
                return "https://provider.example/v1";
              }
              if (ref.kind === "credential" && ref.ref === "openai-key") {
                return "sk-test";
              }
              return null;
            },
          },
          transport: makeOpenAiCompatibleLlmTransportLayer().pipe(
            Layer.provide(httpClientLive(client)),
          ),
          preflight: preflightOpenAiCompatibleProviderMaterial,
        },
      });

      const result = await runtime.submit({ intent: "use configured provider route" });

      expect(providerCalls).toBe(1);
      expect(result).toMatchObject({
        ok: true,
        status: "delivered",
        final: "provider done",
        tokensUsed: 9,
      });
      expect(runtime.diagnostics()).toEqual([]);
      expect(runtime.inspect().resolve.status).toBe("available");
    });
  });

  it("rejects missing local OpenAI-compatible provider material before provider execution", async () => {
    await withTempWorkspace(async (root) => {
      let providerCalls = 0;
      const client = fakeHttpClient(() => {
        providerCalls += 1;
        return Effect.succeed(httpResponse(200, {}));
      });

      let thrown: unknown;
      try {
        await createLocalAgentRuntime({
          identity: "local-openai-compatible-missing-material",
          cwd: root,
          llm: {
            kind: "transport",
            route: {
              kind: "openai-chat-compatible",
              endpointRef: "openai",
              credentialRef: "openai-key",
              modelId: "gpt-test",
            },
            refResolver: {
              material: (ref) => (ref.kind === "credential" ? "sk-secret" : null),
            },
            transport: makeOpenAiCompatibleLlmTransportLayer().pipe(
              Layer.provide(httpClientLive(client)),
            ),
            preflight: preflightOpenAiCompatibleProviderMaterial,
          },
        });
      } catch (cause) {
        thrown = cause;
      }

      expect(thrown).toBeInstanceOf(LocalAgentRuntimeResolveError);
      const diagnostics = (thrown as LocalAgentRuntimeResolveError).diagnostics;
      expect(diagnostics).toEqual([
        expect.objectContaining({
          pass: "provider_material",
          reason: "OpenAI-compatible provider material preflight failed",
        }),
      ]);
      const detail = JSON.parse(diagnostics[0]?.detail ?? "{}");
      expect(detail).toMatchObject({
        kind: "provider_material_preflight",
        provider: "openai-compatible",
        routeKind: "openai-chat-compatible",
        routeStatus: "present",
        materials: expect.arrayContaining([
          { kind: "endpoint", ref: "openai", status: "missing" },
          { kind: "credential", ref: "openai-key", status: "present" },
          { kind: "model", ref: "modelId", status: "present" },
        ]),
      });
      expect(JSON.stringify(diagnostics)).not.toContain("sk-secret");
      expect(providerCalls).toBe(0);
    });
  });

  it("lowers local runtimes with explicit target identity", async () => {
    await withTempWorkspace(async (root) => {
      const localLowered = await lowerLocalAgentRuntime({
        target: "local@1",
        identity: "local-target-runtime",
        cwd: root,
        llm: {
          kind: "test",
          responses: [
            {
              items: [{ type: "message", text: "local target done" }],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
          ],
        },
      });
      const lowered = await lowerLocalAgentRuntime({
        target: "node@1",
        identity: "node-target-runtime",
        cwd: root,
        llm: {
          kind: "test",
          responses: [
            {
              items: [{ type: "message", text: "node target done" }],
              usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
            },
          ],
        },
      });

      expect(localLowered.target).toBe("local@1");
      expect(localLowered.manifest.host).toBe("local@1");
      expect(lowered.target).toBe("node@1");
      expect(lowered.manifest.host).toBe("node@1");
      expect(Object.keys(lowered.runtime).sort()).toEqual([
        "diagnostics",
        "events",
        "inspect",
        "submit",
      ]);
      expect(localLowered.runtime.inspect().compile).toEqual({
        status: "available",
        target: "local@1",
        manifest: expect.objectContaining({ host: "local@1" }),
      });
      expect(lowered.runtime.inspect().compile).toEqual({
        status: "available",
        target: "node@1",
        manifest: expect.objectContaining({ host: "node@1" }),
      });

      const result = await lowered.runtime.submit({ intent: "finish with node target" });

      expect(result).toMatchObject({
        ok: true,
        status: "delivered",
        final: "node target done",
        tokensUsed: 4,
      });
      expect(lowered.runtime.diagnostics()).toEqual([]);
      const nodeInspection = lowered.runtime.inspect();
      expect(nodeInspection.runtime.status).toBe("available");
      if (nodeInspection.runtime.status !== "available") return;
      expect(nodeInspection.runtime.events.map((event) => event.kind)).toEqual(
        expect.arrayContaining([RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED]),
      );
    });
  });

  it("runs write_file through host-owned node@1 workspace operations and inspects live rows", async () => {
    await withTempWorkspace(async (root) => {
      const lowered = await lowerLocalAgentRuntime({
        target: "node@1",
        identity: "local-runtime-write-file",
        cwd: root,
        llm: {
          kind: "test",
          responses: [
            {
              items: [
                {
                  type: "tool_call",
                  call: {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "nested/local-result.txt",
                        content: "written by local workspace op",
                      }),
                    },
                  },
                },
              ],
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            },
          ],
        },
      });
      const runtime = lowered.runtime;

      const initialInspection = runtime.inspect();
      expect(initialInspection.compile).toEqual({
        status: "available",
        target: "node@1",
        manifest: expect.objectContaining({
          host: "node@1",
          capabilities: expect.arrayContaining([WORKSPACE_OP_FACT_OWNER]),
        }),
      });
      expect(initialInspection.resolve.status).toBe("available");
      if (initialInspection.resolve.status !== "available") return;
      expect(initialInspection.resolve.graph.handlers).toEqual(
        expect.arrayContaining([
          {
            kind: WORKSPACE_OP_KIND.REQUESTED,
            capabilityId: WORKSPACE_OP_FACT_OWNER,
          },
        ]),
      );
      expect(initialInspection.resolve.graph.projections).toEqual(
        expect.arrayContaining([
          {
            kind: WORKSPACE_OP_PROJECTION_KIND,
            capabilityId: WORKSPACE_OP_FACT_OWNER,
          },
        ]),
      );
      expect(initialInspection.resolve.bindings.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "write_file",
            authority: expect.objectContaining({
              authorityClass: "agentos.workspace.capability",
            }),
            receiptBackedIntentKinds: [WORKSPACE_OP_KIND.REQUESTED],
          }),
        ]),
      );

      const result = await runtime.submit({
        intent: "write a local file",
        toolPolicy: {
          completeAfterToolsExecuted: {
            toolNames: ["write_file"],
            finalMessage: "local workspace write complete",
          },
        },
      });

      expect(result).toMatchObject({
        ok: true,
        status: "delivered",
        final: "local workspace write complete",
        tokensUsed: 5,
      });
      await expect(readFile(path.join(root, "nested/local-result.txt"), "utf8")).resolves.toBe(
        "written by local workspace op",
      );
      const events = runtime.events();
      expect(events.map((event) => event.kind)).toEqual(
        expect.arrayContaining([
          RUNTIME_EVENT_KIND.TOOL_EXECUTED,
          RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
        ]),
      );
      expect(
        events.find((event) => event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED)?.payload,
      ).toMatchObject({
        name: "write_file",
        result: {
          kind: "write_file",
          path: "nested/local-result.txt",
          bytesWritten: 29,
        },
        claim: {
          phase: "lived",
          anchorRef: { anchorKind: "external_receipt" },
        },
      });
      const inspectionAfterWrite = runtime.inspect();
      expect(inspectionAfterWrite.runtime.status).toBe("available");
      if (inspectionAfterWrite.runtime.status !== "available") return;
      expect(inspectionAfterWrite.runtime.diagnostics).toEqual([]);
      const workspaceRows = inspectionAfterWrite.runtime.events.filter(
        (event) => event.factOwnerRef === WORKSPACE_OP_FACT_OWNER,
      );
      expect(workspaceRows.map((event) => event.kind)).toEqual([
        WORKSPACE_OP_KIND.REQUESTED,
        WORKSPACE_OP_KIND.COMPLETED,
      ]);
      expect(workspaceRows.at(-1)).toMatchObject({
        kind: WORKSPACE_OP_KIND.COMPLETED,
        factOwnerRef: WORKSPACE_OP_FACT_OWNER,
        payload: {
          toolName: "write_file",
          path: "nested/local-result.txt",
          bytesWritten: 29,
        },
      });
    });
  });
});
