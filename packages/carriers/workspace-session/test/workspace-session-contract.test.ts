import { describe, expect, it } from "vite-plus/test";

import {
  WORKSPACE_SESSION_EVENTS,
  WORKSPACE_SESSION_KIND,
  projectWorkspaceSession,
  resolveWorkspaceSession,
  settleWorkspaceSessionLived,
  settleWorkspaceSessionRejected,
  workspaceSessionSettlementRef,
  workspaceSessionBoundaryPackage,
  workspaceSessionCarrier,
} from "../src";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { makeCommitters, type ExtensionCapability } from "@agent-os/kernel/extensions";
import {
  providerMaterialLeaks,
  workspaceSessionProviderMaterialNeedles,
} from "../../../../tooling/test-helpers/provider-material-sentinel";

const sessionClaim = makePreClaim({
  operationRef: "workspace-session:session-1:start",
  scopeRef: { kind: "session", scopeId: "session/1" },
  effectAuthorityRef: {
    authorityId: "@agent-os/workspace-session.start",
    authorityClass: "effect",
  },
  originRef: {
    originId: "@agent-os/workspace-session",
    originKind: "extension_package",
  },
});

const livedSessionClaim = (anchorId: string) =>
  settleWorkspaceSessionLived(sessionClaim, {
    proofRef: workspaceSessionSettlementRef(anchorId),
    carrierRef: "workspace-session",
  });

describe("@agent-os/workspace-session", () => {
  it("declares workspace_session.* as an extension-owned prefix", () => {
    expect(workspaceSessionBoundaryPackage("0.1.0")).toMatchObject({
      packageId: "@agent-os/workspace-session",
      kindPrefixes: ["workspace_session."],
      version: "0.1.0",
    });
  });

  it("resolves only ScopeRef(kind=session) to workspace roots", () => {
    expect(
      resolveWorkspaceSession(
        { kind: "session", scopeId: "session/1" },
        { carrierRef: "cf-sandbox" },
      ),
    ).toEqual({
      ok: true,
      scopeRef: { kind: "session", scopeId: "session/1" },
      carrierRef: "cf-sandbox",
      sessionRootRef: "agentos://session/session%2F1/cf-sandbox",
      workspaceRootRef: "agentos://session/session%2F1/cf-sandbox/workspace",
      backupRootRef: "agentos://session/session%2F1/cf-sandbox/backups",
      previewRootRef: "agentos://session/session%2F1/cf-sandbox/previews",
      cleanupRef: "cleanup://session/session%2F1/cf-sandbox",
    });

    expect(
      resolveWorkspaceSession(
        { kind: "conversation", scopeId: "thread/1" },
        { carrierRef: "cf-sandbox" },
      ),
    ).toEqual({
      ok: false,
      reason: "scope_kind_is_not_session",
      kind: "conversation",
    });
  });

  it("projects lifecycle, backups, previews, and destroy from ledger facts", () => {
    const startedClaim = livedSessionClaim("session://1");
    const events = [
      {
        id: 1,
        kind: WORKSPACE_SESSION_KIND.STARTED,
        payload: {
          subjectRef: "run-1",
          sessionRef: "session://1",
          workspaceRootRef: "workspace://1",
          cleanupRef: "cleanup://1",
          retention: { mode: "ephemeral", leaseRef: "lease://tmp" },
          claim: startedClaim,
        },
      },
      {
        id: 2,
        kind: WORKSPACE_SESSION_KIND.PREVIEW_ALLOCATED,
        payload: {
          subjectRef: "run-1",
          sessionRef: "session://1",
          previewRef: "preview://1:5173",
          port: 5173,
          claim: livedSessionClaim("preview://1:5173"),
        },
      },
      {
        id: 3,
        kind: WORKSPACE_SESSION_KIND.BACKED_UP,
        payload: {
          subjectRef: "run-1",
          sessionRef: "session://1",
          backupRef: "backup://1",
          expiresAt: "2026-06-03T00:00:00Z",
          claim: livedSessionClaim("backup://1"),
        },
      },
      {
        id: 4,
        kind: WORKSPACE_SESSION_KIND.DESTROYED,
        payload: {
          subjectRef: "run-1",
          sessionRef: "session://1",
          reason: "completed",
          claim: livedSessionClaim("cleanup://1"),
        },
      },
    ] as const;

    expect(projectWorkspaceSession(events, "run-1")).toEqual({
      subjectRef: "run-1",
      status: "destroyed",
      lastEventKind: WORKSPACE_SESSION_KIND.DESTROYED,
      sessionRef: "session://1",
      workspaceRootRef: "workspace://1",
      cleanupRef: "cleanup://1",
      retention: { mode: "ephemeral", leaseRef: "lease://tmp" },
      backups: [{ backupRef: "backup://1", expiresAt: "2026-06-03T00:00:00Z" }],
      previews: [
        {
          previewRef: "preview://1:5173",
          port: 5173,
        },
      ],
      failure: undefined,
    });

    expect(
      providerMaterialLeaks(
        projectWorkspaceSession(events, "run-1"),
        workspaceSessionProviderMaterialNeedles(),
      ),
    ).toEqual([]);
  });

  it("rejects preview_allocated payloads that contain provider URLs", () => {
    expect(() =>
      workspaceSessionCarrier.decode(WORKSPACE_SESSION_KIND.PREVIEW_ALLOCATED, {
        subjectRef: "run-url",
        sessionRef: "session://url",
        previewRef: "preview://url",
        port: 5173,
        url: "https://provider-url.example",
        claim: livedSessionClaim("preview://url"),
      }),
    ).toThrow();
  });

  it("resets lifecycle refs on restarted or restored sessions", () => {
    const claimFor = livedSessionClaim;
    const events = [
      {
        id: 1,
        kind: WORKSPACE_SESSION_KIND.STARTED,
        payload: {
          subjectRef: "run-reused",
          sessionRef: "session://old",
          workspaceRootRef: "workspace://old",
          cleanupRef: "cleanup://old",
          claim: claimFor("session://old"),
        },
      },
      {
        id: 2,
        kind: WORKSPACE_SESSION_KIND.BACKED_UP,
        payload: {
          subjectRef: "run-reused",
          sessionRef: "session://old",
          backupRef: "backup://old",
          claim: claimFor("backup://old"),
        },
      },
      {
        id: 3,
        kind: WORKSPACE_SESSION_KIND.PREVIEW_ALLOCATED,
        payload: {
          subjectRef: "run-reused",
          sessionRef: "session://old",
          previewRef: "preview://old",
          port: 5173,
          claim: claimFor("preview://old"),
        },
      },
      {
        id: 4,
        kind: WORKSPACE_SESSION_KIND.STARTED,
        payload: {
          subjectRef: "run-reused",
          sessionRef: "session://new",
          workspaceRootRef: "workspace://new",
          cleanupRef: "cleanup://new",
          claim: claimFor("session://new"),
        },
      },
    ] as const;

    expect(projectWorkspaceSession(events, "run-reused")).toMatchObject({
      status: "active",
      sessionRef: "session://new",
      workspaceRootRef: "workspace://new",
      cleanupRef: "cleanup://new",
      backups: [],
      previews: [],
    });

    const restoredEvents = [
      ...events,
      {
        id: 5,
        kind: WORKSPACE_SESSION_KIND.BACKED_UP,
        payload: {
          subjectRef: "run-reused",
          sessionRef: "session://new",
          backupRef: "backup://new",
          claim: claimFor("backup://new"),
        },
      },
      {
        id: 6,
        kind: WORKSPACE_SESSION_KIND.RESTORED,
        payload: {
          subjectRef: "run-reused",
          sessionRef: "session://restored",
          backupRef: "backup://new",
          workspaceRootRef: "workspace://restored",
          cleanupRef: "cleanup://restored",
          claim: claimFor("session://restored"),
        },
      },
    ] as const;

    expect(projectWorkspaceSession(restoredEvents, "run-reused")).toMatchObject({
      status: "active",
      sessionRef: "session://restored",
      workspaceRootRef: "workspace://restored",
      cleanupRef: "cleanup://restored",
      backups: [],
      previews: [],
    });
  });

  it("does not activate a session from backup without a started or restored session", () => {
    const events = [
      {
        id: 1,
        kind: WORKSPACE_SESSION_KIND.BACKED_UP,
        payload: {
          subjectRef: "run-lone-backup",
          sessionRef: "session://missing",
          backupRef: "backup://missing",
          claim: livedSessionClaim("backup://missing"),
        },
      },
    ] as const;

    expect(projectWorkspaceSession(events, "run-lone-backup")).toEqual({
      subjectRef: "run-lone-backup",
      status: "missing",
      lastEventKind: undefined,
      sessionRef: undefined,
      workspaceRootRef: undefined,
      cleanupRef: undefined,
      retention: undefined,
      backups: [],
      previews: [],
      failure: undefined,
    });
  });

  it("settles failure claims and projects workspace_session.failed", async () => {
    const rejected = settleWorkspaceSessionRejected(sessionClaim, {
      code: "ScopeNotSession",
      reason: "scope must be kind=session",
      proofRef: workspaceSessionSettlementRef("reject"),
    });
    const events = [
      {
        id: 1,
        kind: WORKSPACE_SESSION_KIND.FAILED,
        payload: {
          subjectRef: "run-2",
          step: "start",
          proofRef: workspaceSessionSettlementRef("reject"),
          reason: "scope must be kind=session",
          claim: rejected,
        },
      },
    ] as const;

    expect(projectWorkspaceSession(events, "run-2")).toEqual({
      subjectRef: "run-2",
      status: "failed",
      lastEventKind: WORKSPACE_SESSION_KIND.FAILED,
      sessionRef: undefined,
      workspaceRootRef: undefined,
      cleanupRef: undefined,
      retention: undefined,
      backups: [],
      previews: [],
      failure: {
        subjectRef: "run-2",
        step: "start",
        proofRef: workspaceSessionSettlementRef("reject"),
        reason: "scope must be kind=session",
        claim: rejected,
      },
    });

    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
      ownerId: "@agent-os/workspace-session",
      sourcePackageName: "@agent-os/workspace-session",
      packageId: "@agent-os/workspace-session",
      kindPrefixes: ["workspace_session."],
      version: "0.1.0",
      commit: async (spec) => {
        committed.push(spec);
        return { id: committed.length };
      },
      time: async (spec) => {
        committed.push(spec);
        return { id: committed.length };
      },
    };

    await expect(
      makeCommitters(WORKSPACE_SESSION_EVENTS, cap)[WORKSPACE_SESSION_KIND.FAILED]({
        subjectRef: "run-2",
        step: "start",
        proofRef: workspaceSessionSettlementRef("reject"),
        reason: "scope must be kind=session",
        claim: rejected,
      }),
    ).resolves.toEqual({ id: 1 });

    expect(committed[0]?.event).toBe(WORKSPACE_SESSION_KIND.FAILED);
    expect(committed[0]?.data).toMatchObject({
      subjectRef: "run-2",
      claim: { phase: "rejected" },
    });
  });

  it("lets backends override rejectionKind while preserving claim settlement", () => {
    const rejected = settleWorkspaceSessionRejected(sessionClaim, {
      code: "BackupFailed",
      reason: "backup_quota_exhausted",
      proofRef: workspaceSessionSettlementRef("quota"),
      rejectionKind: "resource_denied",
    });

    expect(rejected).toMatchObject({
      phase: "rejected",
      rejectionRef: {
        rejectionId: workspaceSessionSettlementRef("quota"),
        rejectionKind: "resource_denied",
        reason: "backup_quota_exhausted",
      },
    });
  });

  it("commits started facts through ExtensionCapability", async () => {
    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
      ownerId: "@agent-os/workspace-session",
      sourcePackageName: "@agent-os/workspace-session",
      packageId: "@agent-os/workspace-session",
      kindPrefixes: ["workspace_session."],
      version: "0.1.0",
      commit: async (spec) => {
        committed.push(spec);
        return { id: committed.length };
      },
      time: async (spec) => {
        committed.push(spec);
        return { id: committed.length };
      },
    };
    const claim = livedSessionClaim("session://1");

    await expect(
      makeCommitters(WORKSPACE_SESSION_EVENTS, cap)[WORKSPACE_SESSION_KIND.STARTED]({
        subjectRef: "run-1",
        sessionRef: "session://1",
        workspaceRootRef: "workspace://1",
        cleanupRef: "cleanup://1",
        retention: { mode: "persistent", leaseRef: "lease://keep" },
        claim,
      }),
    ).resolves.toEqual({ id: 1 });

    expect(committed).toEqual([
      {
        event: WORKSPACE_SESSION_KIND.STARTED,
        data: {
          subjectRef: "run-1",
          sessionRef: "session://1",
          workspaceRootRef: "workspace://1",
          cleanupRef: "cleanup://1",
          retention: { mode: "persistent", leaseRef: "lease://keep" },
          claim,
        },
      },
    ]);
  });
});
