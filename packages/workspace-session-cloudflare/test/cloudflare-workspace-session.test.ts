import { Cause, Effect, Exit, Option } from "effect";
import { makePreClaim } from "@agent-os/core/effect-claim";
import {
  makeCloudflareWorkspaceSessionProvider,
  makeCloudflareWorkspaceSessionCarrier,
  type CloudflareWorkspaceSessionClient,
  type CloudflareWorkspaceSessionNamespace,
  type CloudflareWorkspaceSessionProvider,
} from "../src";

const expectFailure = <A>(exit: Exit.Exit<unknown, A>): A => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      return failure.value;
    }
  }
  throw new Error("expected failed exit");
};

const sessionClaim = makePreClaim({
  operationRef: "workspace-session:run-1:start",
  scopeRef: { kind: "session", scopeId: "session/run-1" },
  authorityRef: {
    authorityId: "@agent-os/workspace-session.start",
    authorityClass: "effect",
  },
  originRef: {
    originId: "@agent-os/workspace-session-cloudflare",
    originKind: "extension_package",
  },
});

const artifactClaim = makePreClaim({
  operationRef: "workspace-session:artifact:start",
  scopeRef: { kind: "artifact", scopeId: "artifact/run-1" },
  authorityRef: {
    authorityId: "@agent-os/workspace-session.start",
    authorityClass: "effect",
  },
  originRef: {
    originId: "@agent-os/workspace-session-cloudflare",
    originKind: "extension_package",
  },
});

const provider = (overrides: Partial<CloudflareWorkspaceSessionProvider> = {}) =>
  ({
    start: async () => ({
      sessionRef: "cf-session-1",
      workspaceRootRef: "cf-workspace-1",
      cleanupRef: "cf-cleanup-1",
    }),
    restore: async () => ({
      sessionRef: "cf-session-restore",
      workspaceRootRef: "cf-workspace-restored",
      cleanupRef: "cf-cleanup-restored",
    }),
    backup: async () => ({ backupRef: "cf-backup-1" }),
    preview: async () => ({ previewRef: "cf-preview-1", url: "https://preview.example" }),
    destroy: async () => ({ proofRef: "cf-destroy-1" }),
    ...overrides,
  }) satisfies CloudflareWorkspaceSessionProvider;

describe("@agent-os/workspace-session-cloudflare", () => {
  it("starts a Cloudflare workspace session with resolved roots and a lived claim", async () => {
    const carrier = makeCloudflareWorkspaceSessionCarrier({ provider: provider() });

    await expect(
      Effect.runPromise(
        carrier.start({
          claim: sessionClaim,
          subjectRef: "run-1",
          retention: { mode: "persistent", leaseRef: "lease/run-1" },
        }),
      ),
    ).resolves.toEqual({
      subjectRef: "run-1",
      sessionRef: "cf-session-1",
      workspaceRootRef: "cf-workspace-1",
      cleanupRef: "cf-cleanup-1",
      retention: { mode: "persistent", leaseRef: "lease/run-1" },
      claim: {
        phase: "lived",
        operationRef: "workspace-session:run-1:start",
        scopeRef: { kind: "session", scopeId: "session/run-1" },
        authorityRef: {
          authorityId: "@agent-os/workspace-session.start",
          authorityClass: "effect",
        },
        originRef: {
          originId: "@agent-os/workspace-session-cloudflare",
          originKind: "extension_package",
        },
        anchorRef: {
          anchorId: "cf-session-1",
          anchorKind: "carrier_proof",
          carrierRef: "cloudflare-sandbox",
        },
      },
    });
  });

  it("allocates previews and backups without writing live provider handles", async () => {
    const carrier = makeCloudflareWorkspaceSessionCarrier({
      carrierRef: "cf-sandbox-prod",
      provider: provider(),
    });

    await expect(
      Effect.runPromise(
        carrier.backup({
          claim: sessionClaim,
          subjectRef: "run-1",
          sessionRef: "cf-session-1",
          expiresAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
    ).resolves.toMatchObject({
      subjectRef: "run-1",
      sessionRef: "cf-session-1",
      backupRef: "cf-backup-1",
      expiresAt: "2026-06-01T00:00:00.000Z",
      claim: {
        phase: "lived",
        anchorRef: {
          anchorId: "cf-backup-1",
          anchorKind: "carrier_proof",
          carrierRef: "cf-sandbox-prod",
        },
      },
    });

    await expect(
      Effect.runPromise(
        carrier.allocatePreview({
          claim: sessionClaim,
          subjectRef: "run-1",
          sessionRef: "cf-session-1",
          port: 8787,
        }),
      ),
    ).resolves.toMatchObject({
      subjectRef: "run-1",
      sessionRef: "cf-session-1",
      previewRef: "cf-preview-1",
      port: 8787,
      url: "https://preview.example",
      claim: {
        phase: "lived",
        anchorRef: {
          anchorId: "cf-preview-1",
          anchorKind: "carrier_proof",
          carrierRef: "cf-sandbox-prod",
        },
      },
    });
  });

  it("rejects non-session claim scopes before calling the provider", async () => {
    let called = false;
    const carrier = makeCloudflareWorkspaceSessionCarrier({
      provider: provider({
        start: async () => {
          called = true;
          return {
            sessionRef: "should-not-be-used",
            workspaceRootRef: "should-not-be-used",
            cleanupRef: "should-not-be-used",
          };
        },
      }),
    });

    const failure = expectFailure(
      await Effect.runPromiseExit(
        carrier.start({
          claim: artifactClaim,
          subjectRef: "run-1",
        }),
      ),
    );
    expect(failure).toMatchObject({
      code: "ScopeNotSession",
      step: "start",
      claim: {
        phase: "rejected",
        rejectionRef: {
          rejectionKind: "unsupported",
          reason: "workspace session claim scope is not session",
        },
      },
    });
    expect(called).toBe(false);
  });

  it("settles provider failures as rejected claims", async () => {
    const carrier = makeCloudflareWorkspaceSessionCarrier({
      provider: provider({
        preview: async () => {
          throw { code: "PolicyDenied", reason: "preview denied by policy" };
        },
      }),
    });

    const failure = expectFailure(
      await Effect.runPromiseExit(
        carrier.allocatePreview({
          claim: sessionClaim,
          subjectRef: "run-1",
          sessionRef: "cf-session-1",
          port: 3000,
        }),
      ),
    );
    expect(failure).toMatchObject({
      code: "PolicyDenied",
      step: "preview",
      reason: "preview denied by policy",
      claim: {
        phase: "rejected",
        rejectionRef: {
          rejectionKind: "policy_denied",
          reason: "preview denied by policy",
        },
      },
    });
  });

  it("maps a structural Cloudflare namespace into the provider contract", async () => {
    const calls: string[] = [];
    const client = (id: string): CloudflareWorkspaceSessionClient => ({
      id,
      workspaceRootRef: `workspace://${id}`,
      cleanupRef: `cleanup://${id}`,
      backup: async () => {
        calls.push(`backup:${id}`);
        return { id: `backup://${id}` };
      },
      preview: async () => {
        calls.push(`preview:${id}`);
        return { id: `preview://${id}`, url: `https://${id}.example` };
      },
      destroy: async () => {
        calls.push(`destroy:${id}`);
        return { id: `destroy://${id}` };
      },
    });
    const namespace: CloudflareWorkspaceSessionNamespace = {
      start: async () => {
        calls.push("start");
        return client("session-started");
      },
      restore: async () => {
        calls.push("restore");
        return client("session-restored");
      },
      get: async (sessionRef) => {
        calls.push(`get:${sessionRef}`);
        return client(sessionRef);
      },
    };
    const liveProvider = makeCloudflareWorkspaceSessionProvider({ namespace });

    await expect(liveProvider.start({ claim: sessionClaim, subjectRef: "run-1" })).resolves.toEqual(
      {
        sessionRef: "session-started",
        workspaceRootRef: "workspace://session-started",
        cleanupRef: "cleanup://session-started",
      },
    );
    await expect(
      liveProvider.restore({ claim: sessionClaim, subjectRef: "run-1", backupRef: "backup://1" }),
    ).resolves.toEqual({
      sessionRef: "session-restored",
      workspaceRootRef: "workspace://session-restored",
      cleanupRef: "cleanup://session-restored",
    });
    await expect(
      liveProvider.backup({
        claim: sessionClaim,
        subjectRef: "run-1",
        sessionRef: "session-live",
      }),
    ).resolves.toEqual({ backupRef: "backup://session-live" });
    await expect(
      liveProvider.preview({
        claim: sessionClaim,
        subjectRef: "run-1",
        sessionRef: "session-live",
        port: 8787,
      }),
    ).resolves.toEqual({
      previewRef: "preview://session-live",
      url: "https://session-live.example",
    });
    await expect(
      liveProvider.destroy({
        claim: sessionClaim,
        subjectRef: "run-1",
        sessionRef: "session-live",
        reason: "completed",
      }),
    ).resolves.toEqual({ proofRef: "destroy://session-live" });
    expect(calls).toEqual([
      "start",
      "restore",
      "get:session-live",
      "backup:session-live",
      "get:session-live",
      "preview:session-live",
      "get:session-live",
      "destroy:session-live",
    ]);
  });

  it("fails closed when live provider structural refs are missing", async () => {
    const carrier = makeCloudflareWorkspaceSessionCarrier({
      provider: makeCloudflareWorkspaceSessionProvider({
        namespace: {
          start: async () =>
            ({
              id: "",
              workspaceRootRef: "workspace://missing",
              cleanupRef: "cleanup://missing",
              backup: async () => ({ id: "backup://unused" }),
              preview: async () => ({ id: "preview://unused" }),
              destroy: async () => ({ id: "destroy://unused" }),
            }) satisfies CloudflareWorkspaceSessionClient,
          restore: async () => {
            throw new Error("unused");
          },
          get: async () => {
            throw new Error("unused");
          },
        },
      }),
    });

    const failure = expectFailure(
      await Effect.runPromiseExit(
        carrier.start({
          claim: sessionClaim,
          subjectRef: "run-1",
        }),
      ),
    );

    expect(failure).toMatchObject({
      code: "ProviderFailure",
      step: "start",
      reason: "Cloudflare workspace session start missing required refs",
      claim: {
        phase: "rejected",
        rejectionRef: {
          rejectionKind: "provider_rejected",
          reason: "Cloudflare workspace session start missing required refs",
        },
      },
    });
  });
});
