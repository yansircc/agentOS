import type { WorkspaceJobProjection } from "@agent-os/workspace-job";

export type CloudflareWorkspaceJobResponseProjection = Pick<
  WorkspaceJobProjection,
  "runId" | "status"
>;

export interface CloudflareWorkspaceJobProjectionReader<
  Projection extends CloudflareWorkspaceJobResponseProjection = WorkspaceJobProjection,
> {
  readonly readProjection: (input: { readonly runId: string }) => Promise<Projection>;
}

export interface CloudflareWorkspaceJobResponseOptions<
  Projection extends CloudflareWorkspaceJobResponseProjection = WorkspaceJobProjection,
> extends CloudflareWorkspaceJobProjectionReader<Projection> {
  readonly request: Pick<Request, "headers">;
  readonly runId: string;
  readonly submit: () => Promise<unknown>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly quickWaitForSubmission: (input: {
    readonly submitted: Promise<unknown>;
    readonly quickWaitMs: number;
  }) => Promise<"submitted" | "timeout">;
  readonly quickWaitMs?: number;
  readonly statusUrl?: string | URL;
  readonly statusForProjection?: (projection: Projection) => number;
  readonly renderProjection?: (input: {
    readonly projection: Projection;
    readonly status: number;
    readonly headers: Headers;
  }) => Response | Promise<Response>;
}

const DEFAULT_WORKSPACE_JOB_QUICK_WAIT_MS = 1_500;

const prefersRespondAsync = (headers: Headers): boolean =>
  headers
    .get("prefer")
    ?.split(",")
    .map((value) => value.trim().toLowerCase())
    .includes("respond-async") ?? false;

const defaultStatusForProjection = (
  projection: CloudflareWorkspaceJobResponseProjection,
): number => {
  switch (projection.status) {
    case "verified":
    case "verifier_rejected":
      return 200;
    case "failed":
      return 500;
    case "reconcile_required":
    case "missing":
    case "running":
      return 202;
  }
};

const projectionResponse = <Projection extends CloudflareWorkspaceJobResponseProjection>(
  projection: Projection,
  options: {
    readonly statusForProjection?: (projection: Projection) => number;
    readonly preferenceApplied?: boolean;
    readonly statusUrl?: string | URL;
    readonly renderProjection?: CloudflareWorkspaceJobResponseOptions<Projection>["renderProjection"];
  },
): Response | Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.preferenceApplied === true) {
    headers.set("preference-applied", "respond-async");
  }
  if (options.statusUrl !== undefined) {
    headers.set("location", String(options.statusUrl));
  }
  const status =
    options.statusForProjection?.(projection) ?? defaultStatusForProjection(projection);
  if (options.renderProjection !== undefined) {
    return options.renderProjection({ projection, status, headers });
  }
  return new Response(JSON.stringify({ projection }), { status, headers });
};

/**
 * Cloudflare host response facade for workspace jobs.
 *
 * The helper owns only HTTP timing semantics: `Prefer: respond-async`, quick
 * wait, and JSON response materialization. It never stores results or
 * idempotency state; response bodies are read from the supplied
 * `workspace_job.result` projection reader. The host supplies the quick-wait
 * clock port because this package's shared helper must not own timer runtime.
 *
 * @agentosPrimitive primitive.cloudflare-do.createCloudflareWorkspaceJobResponse
 * @agentosInvariant invariant.workspace-job.verified-terminal
 * @agentosDocs docs/packages/runtime.md
 * @public
 */
export const createCloudflareWorkspaceJobResponse = <
  Projection extends CloudflareWorkspaceJobResponseProjection = WorkspaceJobProjection,
>(
  options: CloudflareWorkspaceJobResponseOptions<Projection>,
): Promise<Response> => {
  const running = options.submit();
  const respondAsync = prefersRespondAsync(options.request.headers);
  if (respondAsync) {
    options.waitUntil(running);
    return options.readProjection({ runId: options.runId }).then((projection) =>
      projectionResponse(projection, {
        statusForProjection: options.statusForProjection,
        preferenceApplied: true,
        statusUrl: options.statusUrl,
        renderProjection: options.renderProjection,
      }),
    );
  }

  const quickWaitMs = options.quickWaitMs ?? DEFAULT_WORKSPACE_JOB_QUICK_WAIT_MS;
  return options
    .quickWaitForSubmission({ submitted: running, quickWaitMs })
    .then((result) => {
      if (result === "timeout") {
        options.waitUntil(running);
      }
      return options.readProjection({ runId: options.runId });
    })
    .then((projection) =>
      projectionResponse(projection, {
        statusForProjection: options.statusForProjection,
        statusUrl: options.statusUrl,
        renderProjection: options.renderProjection,
      }),
    );
};
