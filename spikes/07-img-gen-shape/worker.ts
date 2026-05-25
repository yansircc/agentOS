/**
 * Spike 07 — img-gen substrate shape audit.
 *
 * This is not an img-gen refactor. It is a minimal happy path that tries to
 * express img-gen's pipeline using only public agentOS primitives. Comments
 * marked GAP-Cn are the places where the app must forge substrate semantics.
 */

import {
  AgentDOBase,
  type AgentDOEnv,
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
    const reservationId = crypto.randomUUID();
    const user = this.env.USER_DO.get(this.env.USER_DO.idFromName(request.userScope));

    // GAP-C1/C2: no dispatchToScope primitive. This remote DO call is not
    // atomic with this session ledger's image.plan.ready row and has no
    // sender-owned durable outbox / receiver-owned idempotent ingest contract.
    await user.emitEvent({
      event: "credit.reserve.requested",
      data: {
        sessionScope: this.scopeName(),
        userScope: request.userScope,
        reservationId,
        jobs: plan.jobs,
      },
    });
  }

  private async dispatchJobs(event: LedgerEventRpc): Promise<void> {
    const payload = event.payload as CreditReserved;
    await Promise.all(
      payload.jobs.map(async (job, jobIndex) => {
        const jobScope = `job/${payload.reservationId}-${jobIndex}`;
        const consumer = this.env.CONSUMER_DO.get(this.env.CONSUMER_DO.idFromName(jobScope));

        // GAP-C1/C2: this is the same cross-ledger forge as credit reserve,
        // now for session -> consumer job dispatch. It is not a substrate
        // durable delivery fact; it is app glue over a DO namespace.
        await consumer.emitEvent({
          event: "image.job.queued",
          data: {
            sessionScope: this.scopeName(),
            userScope: payload.userScope,
            reservationId: payload.reservationId,
            jobIndex,
            job,
          } satisfies JobQueued,
        });
      }),
    );
  }

  private async consumeCredit(event: LedgerEventRpc): Promise<void> {
    const delivered = event.payload as ImageDelivered;
    const user = this.env.USER_DO.get(this.env.USER_DO.idFromName(delivered.userScope));

    // GAP-C1/C3: settlement is a cross-scope business resource transition.
    // agentOS Quota supports pre-consume for tool dispatch only; no public
    // reserve/consume/release primitive exists for app resources.
    await user.emitEvent({
      event: "credit.consume.requested",
      data: {
        sessionScope: this.scopeName(),
        reservationId: delivered.reservationId,
        jobScope: delivered.jobScope,
      },
    });
  }

  private scopeName(): string {
    return this.ctx.id.name!;
  }
}

export class UserDO extends AgentDOBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.on("credit.reserve.requested", async (event) => this.reserve(event));
    this.on("credit.consume.requested", async (event) => this.consume(event));
  }

  private async reserve(event: LedgerEventRpc): Promise<void> {
    const payload = event.payload as {
      readonly sessionScope: string;
      readonly userScope: string;
      readonly reservationId: string;
      readonly jobs: ReadonlyArray<PlanJob>;
    };
    const credits = payload.jobs.reduce((sum, job) => sum + job.credits, 0);

    // GAP-C3: reservation is a hand-rolled ledger protocol. Existing
    // withQuota cannot express reserve-now, consume-later, release-on-failure
    // for a business resource in this user scope.
    await this.emitEvent({
      event: "credit.reserved",
      data: {
        reservationId: payload.reservationId,
        credits,
        jobs: payload.jobs,
      },
    });

    const session = this.env.SESSION_DO.get(this.env.SESSION_DO.idFromName(payload.sessionScope));
    // GAP-C1/C2: reverse delivery to the session ledger is app-level RPC,
    // not a substrate dispatch fact.
    await session.emitEvent({
      event: "image.credit.reserved",
      data: {
        userScope: payload.userScope,
        reservationId: payload.reservationId,
        jobs: payload.jobs,
      } satisfies CreditReserved,
    });
  }

  private async consume(event: LedgerEventRpc): Promise<void> {
    const payload = event.payload as {
      readonly reservationId: string;
      readonly jobScope: string;
    };
    await this.emitEvent({
      event: "credit.consumed",
      data: {
        reservationId: payload.reservationId,
        jobScope: payload.jobScope,
      },
    });
  }
}

export class ConsumerDO extends AgentDOBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.on("image.job.queued", async (event) => this.runJob(event));
  }

  private async runJob(event: LedgerEventRpc): Promise<void> {
    const payload = event.payload as JobQueued;

    // GAP-C5: image generation is a route capability, but agentOS currently
    // has only chat-compatible LlmRoute variants. The spike must call a
    // local image-provider shim instead of dispatching through route evidence.
    const image = fakeImageProvider(payload.job.prompt);
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

    const session = this.env.SESSION_DO.get(this.env.SESSION_DO.idFromName(payload.sessionScope));
    // GAP-C1/C2: consumer -> session completion delivery repeats the same
    // missing cross-ledger durable delivery primitive.
    await session.emitEvent({
      event: "image.delivered",
      data: {
        userScope: payload.userScope,
        reservationId: payload.reservationId,
        jobScope: this.scopeName(),
        artifactRef,
      } satisfies ImageDelivered,
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

function fakeImageProvider(prompt: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(`not-a-real-png:${prompt}`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
