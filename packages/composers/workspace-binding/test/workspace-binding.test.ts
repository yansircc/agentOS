import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { ToolProjectionWaitSpec } from "@agent-os/kernel/tools";
import { createWorkspaceEnv, type WorkspaceEnvBackend } from "@agent-os/workspace-env";
import { receiptBackedToolResultFromUnknown } from "@agent-os/runtime-protocol";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  WORKSPACE_OP_PROJECTION_KIND,
  settleWorkspaceOperationCompleted,
  type WorkspaceOperationProjection,
} from "@agent-os/workspace-op";
import { bindWorkspaceToolsForRuntime, workspaceEnvMaterialRef } from "../src";

const backend: WorkspaceEnvBackend = {
  readFile: async () => "",
  readFileBuffer: async () => new Uint8Array(),
  writeFile: async () => undefined,
  stat: async () => ({ type: "other" }),
  readdir: async () => [],
  exists: async () => false,
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

const env = createWorkspaceEnv({
  cwd: "/workspace",
  domain: { kind: "workspace", ref: "workspace:test" },
  backend,
});

describe("@agent-os/workspace-binding", () => {
  it("derives the workspace material ref from the workspace env domain", () => {
    expect(workspaceEnvMaterialRef(env)).toEqual({
      kind: "external_resource",
      provider: "agent-os",
      resourceKind: "workspace-env",
      ref: "workspace:test",
    });
  });

  it("defaults to read-only submit bindings with snapshot replay law", () => {
    const bindings = bindWorkspaceToolsForRuntime({
      env,
      authority: "test.workspace",
      admit: () => Effect.succeed({ ok: true }),
    });

    expect(Object.keys(bindings.tools ?? {}).sort()).toEqual([
      "glob_files",
      "grep_files",
      "list_files",
      "read_file",
    ]);
    expect(bindings.executionDomains).toEqual([
      { domain: env.domain, replay: { access: "read", witness: "snapshot" } },
    ]);
    expect(bindings.materials?.workspace).toEqual(workspaceEnvMaterialRef(env));
    expect("resolvedMaterials" in bindings).toBe(false);
    expect(bindings.tools).toBeDefined();
    expect((bindings.tools!.read_file as { readonly execution?: unknown }).execution).toEqual({
      kind: "external",
      access: "read",
      domain: env.domain,
    });
    expect(bindings.tools!.read_file!.contract.requiredMaterials).toEqual([]);
    expect("diagnostics" in bindings).toBe(false);
    expect("pathPolicy" in bindings).toBe(false);
    expect("externalExecutor" in bindings).toBe(false);
  });

  it("keeps mutation and shell tools disabled unless receipt-backed policy is explicit", () => {
    expect(() =>
      bindWorkspaceToolsForRuntime({
        env,
        authority: "test.workspace",
        admit: () => Effect.succeed({ ok: true }),
        exposure: ["read", "mutation"],
      }),
    ).toThrow("mutationPolicy");
    expect(() =>
      bindWorkspaceToolsForRuntime({
        env,
        authority: "test.workspace",
        admit: () => Effect.succeed({ ok: true }),
        exposure: ["shell"],
      }),
    ).toThrow("shellPolicy");

    const bindings = bindWorkspaceToolsForRuntime({
      env,
      authority: "test.workspace",
      admit: () => Effect.succeed({ ok: true }),
      exposure: ["mutation"],
      mutationPolicy: "receipt-backed",
    });

    expect(Object.keys(bindings.tools ?? {}).sort()).toEqual([
      "delete_path",
      "edit_file",
      "write_file",
    ]);
    expect(bindings.executionDomains).toEqual([
      { domain: env.domain, replay: { access: "write", witness: "receipt" } },
    ]);
    expect(bindings.materials?.workspace).toEqual(workspaceEnvMaterialRef(env));
    expect(bindings.tools!.write_file!.contract.requiredMaterials).toEqual([]);
    expect("externalExecutor" in bindings).toBe(false);
    expect(bindings.toolIntents).toEqual([
      expect.objectContaining({ kind: WORKSPACE_OP_KIND.REQUESTED }),
    ]);
    expect(bindings.receiptBackedTools).toEqual({
      delete_path: { kind: "intent_projection", intentKinds: [WORKSPACE_OP_KIND.REQUESTED] },
      edit_file: { kind: "intent_projection", intentKinds: [WORKSPACE_OP_KIND.REQUESTED] },
      write_file: { kind: "intent_projection", intentKinds: [WORKSPACE_OP_KIND.REQUESTED] },
    });
  });

  it.effect("turns mutation tools into workspace-op intent/projection bridges", () =>
    Effect.gen(function* () {
      let directWriteCalled = false;
      const bridgeEnv = createWorkspaceEnv({
        cwd: "/workspace",
        domain: { kind: "workspace", ref: "workspace:bridge" },
        backend: {
          ...backend,
          writeFile: async () => {
            directWriteCalled = true;
          },
        },
      });
      const bindings = bindWorkspaceToolsForRuntime({
        env: bridgeEnv,
        authority: "test.workspace",
        admit: () => Effect.succeed({ ok: true }),
        exposure: ["mutation"],
        mutationPolicy: "receipt-backed",
      });
      const claim = makePreClaim({
        operationRef: "tool:run-1:call-1",
        scopeRef: { kind: "conversation", scopeId: "run-1" },
        effectAuthorityRef: { authorityClass: "test.workspace", authorityId: "tool:write_file" },
        originRef: { originId: "run:1", originKind: "submit" },
      });
      const completedClaim = settleWorkspaceOperationCompleted(claim, {
        requestedEventId: 99,
        idempotencyKey: claim.operationRef,
      });
      const tool = bindings.tools?.write_file;
      if (tool === undefined) expect.fail("expected write_file binding");

      const result = yield* tool.execute(
        { path: "out.txt", content: "hello" },
        {
          materials: {},
          emitIntent: (kind, payload) =>
            Effect.sync(() => {
              expect(kind).toBe(WORKSPACE_OP_KIND.REQUESTED);
              expect(payload).toMatchObject({
                requestedBy: "@agent-os/workspace-binding",
                workspaceRef: "workspace:bridge",
                toolName: "write_file",
                path: "out.txt",
                content: "hello",
              });
              return { id: 99 };
            }),
          awaitProjection: <State>(spec: ToolProjectionWaitSpec<State>) =>
            Effect.sync(() => {
              expect(spec.kind).toBe(WORKSPACE_OP_PROJECTION_KIND);
              expect(spec.effectAuthorityRef).toEqual(claim.effectAuthorityRef);
              expect(spec.factOwnerRef).toBe(WORKSPACE_OP_FACT_OWNER);
              expect(spec.identity).toEqual({ requestedEventId: 99 });
              return {
                kind: spec.kind,
                projectionKind: spec.kind,
                identityKey: "99",
                updatedEventId: 100,
                state: {
                  status: "completed",
                  requestedEventId: 99,
                  request: {} as never,
                  completed: {
                    requestedEventId: 99,
                    operationRef: claim.operationRef,
                    workspaceRef: "workspace:bridge",
                    toolName: "write_file",
                    idempotencyKey: claim.operationRef,
                    resultHash: "sha256:abc",
                    path: "out.txt",
                    bytesWritten: 5,
                    claim: completedClaim,
                  },
                  result: {
                    kind: "write_file",
                    path: "out.txt",
                    bytesWritten: 5,
                    resultHash: "sha256:abc",
                  },
                } satisfies WorkspaceOperationProjection as State,
              };
            }),
        },
      );

      expect(directWriteCalled).toBe(false);
      expect(receiptBackedToolResultFromUnknown(result)).toMatchObject({
        kind: "tool.receipt_backed_result",
        result: {
          kind: "write_file",
          path: "out.txt",
          bytesWritten: 5,
        },
        claim: completedClaim,
      });
    }),
  );
});
