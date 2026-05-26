# Happy Project Batch

This file defines the first parallel-agent comfort-zone batch. Each project is
a pressure test for current public surface. The output is a report, not a
tracked app.

Run each project in its own worktree via
`scripts/parallel-dev/create-agent.sh`.

## Shared Rules

- Implementation path: `spikes/_active/<agent-id>-<case>/`
- All scopes and fixture keys start with `$SCOPE_PREFIX`
- Servers bind to `$PORT_BASE`
- Live provider calls require `LIVE_LLM=1` or explicit task assignment
- Do not modify `packages/core` unless the task is escalated from pressure test
  to substrate fix
- Report with the format in root `AGENTS.md`

## H1 — Customer Support Chatbot

**Surface**: `emitEvent`, `on`, `submit`, tools, `streamEvents`.

Flow:

```text
POST /message
  -> emitEvent("support.message.received")
  -> on("support.message.received")
  -> submit({ system, intent, context, tools, route, deliver })
  -> support.message.delivered
GET /events
  -> streamEvents()
```

Acceptance:

- one user message produces one delivered assistant event
- tool execution, if used, appears as `tool.executed`
- SSE stream emits `event: ledger`
- app events do not use reserved substrate prefixes such as `chat.*`

Expected comfort level: very high.

## H2 — Structured Form Summarizer

**Surface**: `submit({ outputSchema, tools: {} })`, admission evidence.

Flow:

```text
POST /summarize { text }
  -> emitEvent("form.submitted")
  -> submit({ outputSchema: SummarySchema, tools: {}, deliver })
  -> form.summary.ready
```

Acceptance:

- summary event payload conforms to schema
- `llm.structured.evidence` appears in ledger
- second identical call should not require app-owned capability table

Expected comfort level: high.

## H3 — Timed Follow-Up Bot

**Surface**: `scheduleEvent`, `alarm`, `on`, `events`.

Flow:

```text
POST /lead
  -> emitEvent("lead.created")
  -> scheduleEvent("lead.followup_due", at = now + short delay)
on("lead.followup_due")
  -> submit(...)
  -> lead.followup.ready
```

Acceptance:

- scheduled row fires once
- follow-up event is in ledger
- test does not depend on a global fixed scope

Expected comfort level: high.

## H4 — Approval Race

**Surface**: `emitEvent`, `scheduleEvent`, `events` projection.

Flow:

```text
approval.requested
approval.decided OR approval.timeout
winner = first ledger id for same requestId
```

Acceptance:

- decision-before-timeout chooses decision
- timeout-before-decision chooses timeout
- no in-memory waiter table

Expected comfort level: medium-high. Main friction likely projection ergonomics.

## H5 — Image Prompt Bot

**Surface**: `generateImage`, image route, carrier boundary.

Flow:

```text
POST /image { prompt }
  -> emitEvent("img.request.created")
  -> generateImage({ route, prompt })
  -> app stores artifact ref
  -> img.ready
```

Acceptance:

- image route returns an `ImageResult`
- ledger stores ref/metadata, not bytes
- R2 or local file storage remains app/carrier code

Expected comfort level: medium. Live image cost means this may run with a stub
unless explicitly approved.

## H6 — Two-Scope Credit Reservation Toy

**Surface**: `dispatchToScope`, `grantResource`, `reserveResource`,
`consumeResource`, `releaseResource`.

Flow:

```text
session -> user: credit.reserve.requested
user reserves resource
user -> session: credit.reserved
session completes toy work
session -> user: credit.consume.requested
```

Acceptance:

- sender and receiver ledgers both show dispatch bookkeeping
- duplicate reserve request is idempotent by app idempotency key
- no mutable app-owned account table

Expected comfort level: medium. This is the first cross-scope pressure test.
