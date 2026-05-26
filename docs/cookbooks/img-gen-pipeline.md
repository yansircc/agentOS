# Img-Gen Pipeline

This cookbook records the img-gen substrate audit after the runnable spike was
retired. It is the shape to use when pressure-testing image-generation apps
against core primitives.

## Invariant

Each durable state transition has one owner:

- session scope owns request, plan, job delivery, and user-visible artifact refs
- user scope owns credit/resource grants, reservations, consume, and release
- consumer/job scope owns provider call and artifact materialization
- R2 owns bytes as an INV-9 carrier; ledgers store refs only

## Happy Path

```text
POST /request
  -> session.emitEvent("img.request.created", { prompt, nImages })

session.on("img.request.created")
  -> submit({ outputSchema: PlanSchema, route: textRoute, tools: {} })
  -> img.plan.ready

session.on("img.plan.ready")
  -> dispatchToScope(userScope, "credit.reserve.requested", {
       key: "image-credit",
       amount,
       idempotencyKey,
     })

user.on("credit.reserve.requested")
  -> reserveResource({ key: "image-credit", amount, idempotencyKey })
  -> dispatchToScope(sessionScope, "credit.reserved", { reservationId })

session.on("credit.reserved")
  -> dispatchToScope(consumerScope, "img.job.requested", {
       prompt,
       reservationId,
     })

consumer.on("img.job.requested")
  -> @agent-os/image generateImageEffect({ route: imageRoute, prompt, aspectRatio })
  -> R2.put(bytes)
  -> dispatchToScope(sessionScope, "img.delivered", { artifactRef })

session.on("img.delivered")
  -> dispatchToScope(userScope, "credit.consume.requested", { reservationId })

user.on("credit.consume.requested")
  -> consumeResource({ reservationId })
```

## Gap Verdict

| Candidate | Verdict | Primitive / boundary |
|---|---|---|
| C1 cross-DO durable delivery | resolved | `dispatchToScope` sends app events between `AgentDOBase` scopes with sender outbox + receiver ledger ingest. |
| C2 transactional outbox | collapsed into C1 | `dispatch_outbox` is the sender pending buffer behind `dispatchToScope`, not a public primitive. |
| C3 quota refund/release | resolved | `grantResource`, `reserveResource`, `consumeResource`, `releaseResource` model business resources without conflating them with carrier quota. |
| C4 R2 blob carrier | not a gap | R2 is an INV-9 carrier. The app owns key containment and cleanup; the ledger stores artifact refs. |
| C5 image-output route | resolved | `@agent-os/image` uses image route adapters; binary materialization remains app/carrier code. |

## Public Surface Used

```ts
await session.emitEvent({ event: "img.request.created", data });

await session.submit({
  outputSchema: PlanSchema,
  route: textRoute,
  tools: {},
  deliver: { event: "img.plan.ready" },
  // system / intent / context / budget omitted here
});

await session.dispatchToScope({
  target: { bindingRef: "USER_DO", scope: userScope },
  event: "credit.reserve.requested",
  data,
  idempotencyKey,
  traceContext,
});

const reservation = await user.reserveResource({
  key: "image-credit",
  amount,
  ref,
  idempotencyKey,
});

// imageRuntime is app-owned and provides ImageAiBinding + ImageRefResolverLive.
const image = await imageRuntime.runPromise(
  generateImageEffect({
    route: {
      kind: "openai-chat-compatible-image",
      endpointRef: "openrouter",
      credentialRef: "OPENROUTER_KEY",
      modelId: "google/gemini-2.5-flash-image",
    },
    prompt,
    aspectRatio: "16:9",
  }),
);
```

## Boundary

`generateImageEffect` returns image artifacts. Writing bytes to R2 and
constructing public URLs stay app-owned because the bucket, key policy,
retention, and CDN rules are carrier-specific.

`image.*` is package-owned, not core-reserved. A DO that wants the negative
write gate returns `imageExtensionPackage(version)` from `registerExtensions()`;
app-visible workflow facts in this cookbook use `img.*` to avoid forging image
job projections.
