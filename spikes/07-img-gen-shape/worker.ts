/**
 * Spike 07 — img-gen substrate shape audit.
 *
 * This is not an img-gen refactor. It is a minimal happy path that tries to
 * express img-gen's pipeline using only public agentOS primitives. Comments
 * marked GAP-Cn are the places where the app must forge substrate semantics.
 */

import {
  AgentDOBase,
  type DispatchTargetRegistry,
  type AgentDOEnv,
  type ImageArtifact,
  type ImageRoute,
  type LedgerEventRpc,
  type LlmRoute,
  type ProviderRegistryConfig,
} from "@agent-os/core";
import { PLAN_SCHEMA, type ImagePlan, type PlanJob } from "./schemas";

interface Env extends AgentDOEnv {
  readonly SESSION_DO: DurableObjectNamespace<SessionDO>;
  readonly USER_DO: DurableObjectNamespace<UserDO>;
  readonly CONSUMER_DO: DurableObjectNamespace<ConsumerDO>;
  readonly ARTIFACTS: R2Bucket;
  readonly OPENROUTER_KEY: string;
}

const PLAN_ROUTE: LlmRoute = {
  kind: "openai-chat-compatible",
  endpointRef: "openrouter",
  credentialRef: "OPENROUTER_KEY",
  modelId: "openai/gpt-4.1",
};

const IMAGE_ROUTE: ImageRoute = {
  kind: "openai-chat-compatible-image",
  endpointRef: "openrouter",
  credentialRef: "OPENROUTER_KEY",
  modelId: "google/gemini-2.5-flash-image",
};

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...(init.headers ?? {}),
    },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    const url = new URL(req.url);
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(
        [
          "agentOS spike-07 img-gen shape audit",
          "POST /request {sessionId,userId,prompt,nImages}",
          "GET /events/session/:id",
          "GET /events/user/:id",
          "GET /events/job/:id",
        ].join("\n"),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    if (url.pathname === "/request" && req.method === "POST") {
      const body = (await req.json()) as {
        sessionId?: unknown;
        userId?: unknown;
        prompt?: unknown;
        nImages?: unknown;
      };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        return json({ error: "sessionId required" }, { status: 400 });
      }
      if (typeof body.userId !== "string" || body.userId.length === 0) {
        return json({ error: "userId required" }, { status: 400 });
      }
      if (typeof body.prompt !== "string" || body.prompt.length === 0) {
        return json({ error: "prompt required" }, { status: 400 });
      }
      const nImages =
        typeof body.nImages === "number" && body.nImages > 0
          ? Math.min(3, Math.floor(body.nImages))
          : 1;
      const sessionScope = `session/${body.sessionId}`;
      const userScope = `user/${body.userId}`;
      const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionScope));
      const { id } = await stub.emitEvent({
        event: "image.request.created",
        data: { userScope, prompt: body.prompt, nImages },
      });
      return json({ ok: true, eventId: id, sessionScope, userScope });
    }

    const eventsMatch = url.pathname.match(/^\/events\/(session|user|job)\/(.+)$/);
    if (eventsMatch && req.method === "GET") {
      const [, kind, rawId] = eventsMatch;
      const scope = `${kind}/${decodeURIComponent(rawId)}`;
      const namespace =
        kind === "session" ? env.SESSION_DO : kind === "user" ? env.USER_DO : env.CONSUMER_DO;
      const events = await namespace.get(namespace.idFromName(scope)).events();
      return json(events);
    }

    return new Response("not found", { status: 404 });
  },
};

interface RequestCreated {
  readonly userScope: string;
  readonly prompt: string;
  readonly nImages: number;
}

interface CreditReserved {
  readonly userScope: string;
  readonly reservationId: string;
  readonly jobs: ReadonlyArray<PlanJob>;
}

interface CreditReserveRequested {
  readonly sessionScope: string;
  readonly userScope: string;
  readonly jobs: ReadonlyArray<PlanJob>;
  readonly idempotencyKey: string;
}

interface JobQueued {
  readonly sessionScope: string;
  readonly userScope: string;
  readonly reservationId: string;
  readonly jobIndex: number;
  readonly job: PlanJob;
}

interface ImageDelivered {
  readonly userScope: string;
  readonly reservationId: string;
  readonly jobScope: string;
  readonly artifactRef: {
    readonly key: string;
    readonly contentType: string;
    readonly byteSize: number;
  };
}

export class SessionDO extends AgentDOBase<Env> {
  protected override provideRegistry(): ProviderRegistryConfig {
    return {
      endpoints: { openrouter: "https://openrouter.ai/api/v1" },
      credentials: { OPENROUTER_KEY: this.env.OPENROUTER_KEY },
    };
  }

  protected override provideDispatchTargets(): DispatchTargetRegistry {
    return {
      user: this.env.USER_DO,
      consumer: this.env.CONSUMER_DO,
    };
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.on("image.request.created", async (event) => this.plan(event));
    this.on("image.plan.ready", async (event) => this.reserveCredit(event));
    this.on("image.credit.reserved", async (event) => this.dispatchJobs(event));
    this.on("image.delivered", async (event) => this.consumeCredit(event));
  }

  private async plan(event: LedgerEventRpc): Promise<void> {
    const payload = event.payload as RequestCreated;
    await this.submit({
      intent: `Create an image generation plan with exactly ${payload.nImages} job(s). Each job must use size 1024x1024 and credits 1. User prompt: ${payload.prompt}`,
      context: { prompt: payload.prompt, nImages: payload.nImages },
      route: PLAN_ROUTE,
      tools: {},
      outputSchema: PLAN_SCHEMA,
      budget: { tokens: 4000, maxTurns: 1, toolRetries: 0 },
      deliver: { event: "image.plan.ready" },
    });
  }

  private async reserveCredit(event: LedgerEventRpc): Promise<void> {
    const request = findRequest(await this.events());
    if (request === null) return;
    const plan = event.payload as ImagePlan;

    await this.dispatchToScope({
      target: { bindingRef: "user", scope: request.userScope },
      event: "credit.reserve.requested",
      data: {
        sessionScope: this.scopeName(),
        userScope: request.userScope,
        jobs: plan.jobs,
        idempotencyKey: `reserve:${event.id}`,
      } satisfies CreditReserveRequested,
      idempotencyKey: `reserve:${event.id}`,
    });
  }

  private async dispatchJobs(event: LedgerEventRpc): Promise<void> {
    const payload = event.payload as CreditReserved;
    await Promise.all(
      payload.jobs.map(async (job, jobIndex) => {
        const jobScope = `job/${payload.reservationId}-${jobIndex}`;

        await this.dispatchToScope({
          target: { bindingRef: "consumer", scope: jobScope },
          event: "image.job.queued",
          data: {
            sessionScope: this.scopeName(),
            userScope: payload.userScope,
            reservationId: payload.reservationId,
            jobIndex,
            job,
          } satisfies JobQueued,
          idempotencyKey: `job:${payload.reservationId}:${jobIndex}`,
        });
      }),
    );
  }

  private async consumeCredit(event: LedgerEventRpc): Promise<void> {
    const delivered = event.payload as ImageDelivered;

    await this.dispatchToScope({
      target: { bindingRef: "user", scope: delivered.userScope },
      event: "credit.consume.requested",
      data: {
        sessionScope: this.scopeName(),
        reservationId: delivered.reservationId,
        jobScope: delivered.jobScope,
      },
      idempotencyKey: `consume:${delivered.reservationId}:${delivered.jobScope}`,
    });
  }

  private scopeName(): string {
    return this.ctx.id.name!;
  }
}

export class UserDO extends AgentDOBase<Env> {
  protected override provideDispatchTargets(): DispatchTargetRegistry {
    return {
      session: this.env.SESSION_DO,
    };
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.on("credit.reserve.requested", async (event) => this.reserve(event));
    this.on("credit.consume.requested", async (event) => this.consume(event));
  }

  private async reserve(event: LedgerEventRpc): Promise<void> {
    const payload = event.payload as CreditReserveRequested;
    const credits = payload.jobs.reduce((sum, job) => sum + job.credits, 0);

    if (!hasResourceGrant(await this.events(), "credit")) {
      await this.grantResource({
        key: "credit",
        amount: 100,
        ref: "spike-seed",
      });
    }

    const { reservationId } = await this.reserveResource({
      key: "credit",
      amount: credits,
      ref: payload.idempotencyKey,
      idempotencyKey: payload.idempotencyKey,
    });

    await this.dispatchToScope({
      target: { bindingRef: "session", scope: payload.sessionScope },
      event: "image.credit.reserved",
      data: {
        userScope: payload.userScope,
        reservationId,
        jobs: payload.jobs,
      } satisfies CreditReserved,
      idempotencyKey: `reserved:${reservationId}`,
    });
  }

  private async consume(event: LedgerEventRpc): Promise<void> {
    const payload = event.payload as {
      readonly reservationId: string;
      readonly jobScope: string;
    };
    await this.consumeResource({
      reservationId: payload.reservationId,
      ref: payload.jobScope,
    });
  }
}

export class ConsumerDO extends AgentDOBase<Env> {
  protected override provideRegistry(): ProviderRegistryConfig {
    return {
      endpoints: { openrouter: "https://openrouter.ai/api/v1" },
      credentials: { OPENROUTER_KEY: this.env.OPENROUTER_KEY },
    };
  }

  protected override provideDispatchTargets(): DispatchTargetRegistry {
    return {
      session: this.env.SESSION_DO,
    };
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.on("image.job.queued", async (event) => this.runJob(event));
  }

  private async runJob(event: LedgerEventRpc): Promise<void> {
    const payload = event.payload as JobQueued;

    const generated = await this.generateImage({
      route: IMAGE_ROUTE,
      prompt: payload.job.prompt,
      aspectRatio: "1:1",
    });
    const image = await materializeArtifact(generated.artifacts[0]);
    const key = `spike-07/${this.scopeName()}/output-${payload.jobIndex}.png`;

    // C4 resolved as not-a-gap in this spike: R2 is a carrier. The app can
    // write bytes externally and record only an artifact ref in the ledger
    // without duplicating SSoT, as long as it owns key containment + cleanup.
    await this.env.ARTIFACTS.put(key, image, {
      httpMetadata: { contentType: "image/png" },
    });

    const artifactRef = {
      key,
      contentType: "image/png",
      byteSize: image.byteLength,
    };
    await this.emitEvent({
      event: "image.artifact.written",
      data: { artifactRef, prompt: payload.job.prompt },
    });

    await this.dispatchToScope({
      target: { bindingRef: "session", scope: payload.sessionScope },
      event: "image.delivered",
      data: {
        userScope: payload.userScope,
        reservationId: payload.reservationId,
        jobScope: this.scopeName(),
        artifactRef,
      } satisfies ImageDelivered,
      idempotencyKey: `delivered:${payload.reservationId}:${this.scopeName()}`,
    });
  }

  private scopeName(): string {
    return this.ctx.id.name!;
  }
}

function findRequest(events: ReadonlyArray<LedgerEventRpc>): RequestCreated | null {
  for (const event of events) {
    if (event.kind === "image.request.created") {
      const payload = event.payload as Partial<RequestCreated>;
      if (
        typeof payload.userScope === "string" &&
        typeof payload.prompt === "string" &&
        typeof payload.nImages === "number"
      ) {
        return {
          userScope: payload.userScope,
          prompt: payload.prompt,
          nImages: payload.nImages,
        };
      }
    }
  }
  return null;
}

function hasResourceGrant(
  events: ReadonlyArray<LedgerEventRpc>,
  key: string,
): boolean {
  return events.some((event) => {
    if (event.kind !== "resource.granted") return false;
    const payload = event.payload as Partial<{ key: string }>;
    return payload.key === key;
  });
}

async function materializeArtifact(
  artifact: ImageArtifact | undefined,
): Promise<ArrayBuffer> {
  if (artifact === undefined) {
    throw new Error("generateImage returned no artifacts");
  }
  if (artifact.kind === "bytes") {
    const copy = new Uint8Array(artifact.bytes.byteLength);
    copy.set(artifact.bytes);
    return copy.buffer;
  }
  if (artifact.kind === "data-url") {
    const comma = artifact.dataUrl.indexOf(",");
    if (comma < 0) {
      throw new Error("invalid image data URL");
    }
    const encoded = artifact.dataUrl.slice(comma + 1);
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  const response = await fetch(artifact.url);
  if (!response.ok) {
    throw new Error(`image artifact fetch failed: ${response.status}`);
  }
  return await response.arrayBuffer();
}
