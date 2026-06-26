---json
{
  "schemaVersion": 1,
  "id": "schedule.time-ingress",
  "kind": "schedule",
  "title": "Schedule Time Ingress",
  "summary": "Author time ingress under agent/schedules without moving cron evaluation or external side effects into runtime.",
  "primaryFile": "agent/schedules/<id>.ts",
  "appliesTo": ["agentos add", "agentos update"],
  "upgradeGuide": "blueprints/UPGRADE.md",
  "scheduleBoundary": {
    "identity": "agent/schedules/<id>.ts",
    "timeAuthority": "provider-scheduled-metadata",
    "fireIdentity": "stable-app-principal-schedule-id-utc-minute",
    "productIngress": "sessions-or-workflows",
    "externalSideEffects": "app-owned",
    "historyProjection": "schedule-fire-events-plus-linked-product-projections"
  }
}
---

# Schedule Time Ingress

<!-- agentos:primary-file path="agent/schedules/<id>.ts" -->

## Boundary

This recipe records the authored time-ingress boundary. A schedule is a provider
time signal handled by a declaration under `agent/schedules/<id>.ts`; the path
stem is the schedule identity. The generated target owns provider metadata
routing and passes only a restricted schedule context to the declaration.

## Schedule Boundary

Schedule cron declarations are five-field UTC minute expressions. A schedule
fire identity is derived from the stable app principal, schedule id, and
cron-scheduled UTC minute; it must not use deployment instance identity or wall
clock arrival time.

The schedule context may submit one session turn or one workflow run. Product
ingress owns idempotency by the fire identity. Schedule fire events record only
the handoff request and handoff outcome; running or terminal product status is
read from the linked session, workflow, and runtime projections.

External side effects stay in app-owned code reached by the submitted session or
workflow. Schedule declarations must not create provider lifecycle, durable
deduplication, or outbound side-effect helper surfaces in runtime.

## Steps

1. Add `agent/schedules/<id>.ts`.
2. Export a `defineSchedule` declaration with a UTC five-field cron expression.
3. In the handler, submit exactly one session turn or workflow run.
4. Use the generated local `schedules.trigger` surface for explicit dev/test
   fires.
5. Read `schedules.history` for schedule fire handoff history and follow the
   linked product projection for downstream status.

## Upgrade Guide

`blueprints/UPGRADE.md` owns cumulative migration notes for this recipe.
