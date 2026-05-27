import { describe, expect, it } from "vite-plus/test";

import {
  WORKSPACE_SESSION_EVENTS,
  commitWorkspaceSessionFailed,
  commitWorkspaceSessionStarted,
  projectWorkspaceSession,
  resolveWorkspaceSession,
  settleWorkspaceSessionRejected,
  workspaceSessionExtensionPackage,
} from "../src";
import { makePreClaim, settleLivedClaim } from "@agent-os/core/effect-claim";
import type { ExtensionCapability } from "@agent-os/core/extensions";

const sessionClaim = makePreClaim({
  operationRef: "workspace-session:session-1:start",
  scopeRef: { kind: "session", scopeId: "session/1" },
  authorityRef: {
    authorityId: "@agent-os/workspace-session.start",
    authorityClass: "effect",
  },
  originRef: {
    originId: "@agent-os/workspace-session",
    originKind: "extension_package",
  },
});

describe("@agent-os/workspace-session", () => {
  it("declares workspace_session.* as an extension-owned prefix", () => {
    expect(workspaceSessionExtensionPackage("0.1.0")).toEqual({
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
    const startedClaim = settleLivedClaim(sessionClaim, {
      anchorId: "session://1",
      anchorKind: "carrier_proof",
      carrierRef: "workspace-session",
    });
    const events = [
      {
        id: 1,
        kind: WORKSPACE_SESSION_EVENTS.STARTED,
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
        kind: WORKSPACE_SESSION_EVENTS.PREVIEW_ALLOCATED,
        payload: {
          subjectRef: "run-1",
          sessionRef: "session://1",
          previewRef: "preview://1:5173",
          port: 5173,
          url: "https://preview.example",
          claim: settleLivedClaim(sessionClaim, {
            anchorId: "preview://1:5173",
            anchorKind: "carrier_proof",
            carrierRef: "workspace-session",
          }),
        },
      },
      {
        id: 3,
        kind: WORKSPACE_SESSION_EVENTS.BACKED_UP,
        payload: {
          subjectRef: "run-1",
          sessionRef: "session://1",
          backupRef: "backup://1",
          expiresAt: "2026-06-03T00:00:00Z",
          claim: settleLivedClaim(sessionClaim, {
            anchorId: "backup://1",
            anchorKind: "carrier_proof",
            carrierRef: "workspace-session",
          }),
        },
      },
      {
        id: 4,
        kind: WORKSPACE_SESSION_EVENTS.DESTROYED,
        payload: {
          subjectRef: "run-1",
          sessionRef: "session://1",
          reason: "completed",
          claim: settleLivedClaim(sessionClaim, {
            anchorId: "cleanup://1",
            anchorKind: "carrier_proof",
            carrierRef: "workspace-session",
          }),
        },
      },
    ] as const;

    expect(projectWorkspaceSession(events, "run-1")).toEqual({
      subjectRef: "run-1",
      status: "destroyed",
      lastEventKind: WORKSPACE_SESSION_EVENTS.DESTROYED,
      sessionRef: "session://1",
      workspaceRootRef: "workspace://1",
      cleanupRef: "cleanup://1",
      retention: { mode: "ephemeral", leaseRef: "lease://tmp" },
      backups: [{ backupRef: "backup://1", expiresAt: "2026-06-03T00:00:00Z" }],
      previews: [
        {
          previewRef: "preview://1:5173",
          port: 5173,
          url: "https://preview.example",
        },
      ],
      failure: undefined,
    });
  });

  it("resets lifecycle refs on restarted or restored sessions", () => {
    const claimFor = (anchorId: string) =>
      settleLivedClaim(sessionClaim, {
        anchorId,
        anchorKind: "carrier_proof",
        carrierRef: "workspace-session",
      });
    const events = [
      {
        id: 1,
        kind: WORKSPACE_SESSION_EVENTS.STARTED,
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
        kind: WORKSPACE_SESSION_EVENTS.BACKED_UP,
        payload: {
          subjectRef: "run-reused",
          sessionRef: "session://old",
          backupRef: "backup://old",
          claim: claimFor("backup://old"),
        },
      },
      {
        id: 3,
        kind: WORKSPACE_SESSION_EVENTS.PREVIEW_ALLOCATED,
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
        kind: WORKSPACE_SESSION_EVENTS.STARTED,
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
        kind: WORKSPACE_SESSION_EVENTS.BACKED_UP,
        payload: {
          subjectRef: "run-reused",
          sessionRef: "session://new",
          backupRef: "backup://new",
          claim: claimFor("backup://new"),
        },
      },
      {
        id: 6,
        kind: WORKSPACE_SESSION_EVENTS.RESTORED,
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

  it("settles failure claims and projects workspace_session.failed", async () => {
    const rejected = settleWorkspaceSessionRejected(sessionClaim, {
      code: "ScopeNotSession",
      reason: "scope must be kind=session",
      proofRef: "proof://reject",
    });
    const events = [
      {
        id: 1,
        kind: WORKSPACE_SESSION_EVENTS.FAILED,
        payload: {
          subjectRef: "run-2",
          step: "start",
          proofRef: "proof://reject",
          reason: "scope must be kind=session",
          claim: rejected,
        },
      },
    ] as const;

    expect(projectWorkspaceSession(events, "run-2")).toEqual({
      subjectRef: "run-2",
      status: "failed",
      lastEventKind: WORKSPACE_SESSION_EVENTS.FAILED,
      sessionRef: undefined,
      workspaceRootRef: undefined,
      cleanupRef: undefined,
      retention: undefined,
      backups: [],
      previews: [],
      failure: {
        subjectRef: "run-2",
        step: "start",
        proofRef: "proof://reject",
        reason: "scope must be kind=session",
        claim: rejected,
      },
    });

    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
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
      commitWorkspaceSessionFailed(cap, {
        subjectRef: "run-2",
        step: "start",
        proofRef: "proof://reject",
        reason: "scope must be kind=session",
        claim: rejected,
      }),
    ).resolves.toEqual({ id: 1 });

    expect(committed[0]?.event).toBe(WORKSPACE_SESSION_EVENTS.FAILED);
    expect(committed[0]?.data).toMatchObject({
      subjectRef: "run-2",
      claim: { phase: "rejected" },
    });
  });

  it("lets backends override rejectionKind while preserving claim settlement", () => {
    const rejected = settleWorkspaceSessionRejected(sessionClaim, {
      code: "BackupFailed",
      reason: "backup quota exhausted",
      proofRef: "proof://quota",
      rejectionKind: "resource_denied",
    });

    expect(rejected).toMatchObject({
      phase: "rejected",
      rejectionRef: {
        rejectionId: "proof://quota",
        rejectionKind: "resource_denied",
        reason: "backup quota exhausted",
      },
    });
  });

  it("commits started facts through ExtensionCapability", async () => {
    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
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
    const claim = settleLivedClaim(sessionClaim, {
      anchorId: "session://1",
      anchorKind: "carrier_proof",
      carrierRef: "workspace-session",
    });

    await expect(
      commitWorkspaceSessionStarted(cap, {
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
        event: WORKSPACE_SESSION_EVENTS.STARTED,
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
