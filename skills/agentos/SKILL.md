---
name: agentos
description: Use when integrating, migrating to, or reviewing agentOS in an application repo, especially to replace custom agent loops, tool gates, ledgers, material resolvers, Cloudflare resource wiring, LLM token streams, or skill/tool registration with agentOS primitives.
---

# agentOS

Use this skill to integrate agentOS without re-inventing its substrate.

## Workflow

1. Route the request before editing:
   - in an agentOS checkout, read `docs/agent/decision-graph.md` or
     `docs/agent/decision-graph.json` first;
   - map the natural-language request to one route's `intents`;
   - use only that route's allowed primitives, source fact owners, forbidden
     writes, and gates as the initial substrate motion;
   - if no route fits but an existing coordination primitive fits, add or update
     `docs/agent/capability-rules.source.json`, then run
     `bun run docs:generate` and `bun run check:agent-routes`;
   - if no existing coordination primitive fits, report a substrate gap instead
     of adding glue code or a docs-only route.

2. Inspect the target repo before editing:
   - installed `@yansirplus/{core,runtime,client,cli}` packages;
   - local agent loop, tool gate, ledger, scheduler, material resolver, and
     streaming code;
   - package READMEs and `PUBLIC_API.md` files for exact installed exports.

3. State the boundary before changes:

   ```text
   stable axis:
   change axis:
   invariant:
   ```

4. Prefer the agentOS primitive:
   - agent run loop -> Cloudflare backend `submit`;
   - tool identity/admission -> `defineTool`, AgentSchema arguments, and
     `ToolContract`;
   - durable truth -> ledger events and projections;
   - execution means -> facade `bindings` backed by `MaterialRef`;
   - token progress and run projections -> `@agent-os/runtime`;
   - consumer run stream -> `@agent-os/client` or `@agent-os/runtime/ag-ui`;
   - resource facts -> `@agent-os/core` boundary contracts plus `@agent-os/runtime`;
   - Cloudflare resource materialization -> `@agent-os/runtime/cloudflare`;

5. Keep the core invariant:
   - `PreClaim` names effect identity only:
     `operationRef / scopeRef / authorityRef / originRef`;
   - `MaterialRef` names execution means;
   - cleanup/proof refs name release and verification vocabulary;
   - resolved material never enters ledger, projections, run-stream frames, or
     error payloads;
   - skill identity stops at registration; runtime sees tools.

6. Fail closed. Do not add env fallback, inferred credentials, shadow state,
   duplicate run truth, or product vocabulary to agentOS-owned logic.

7. Verify the class, not just the instance:
   - typecheck and tests for touched packages;
   - redaction scans for provider material;
   - ledger/projection assertions proving no second truth.

## References

- Read `references/integration-checklist.md` when planning a migration.
- Read `references/package-map.md` when choosing packages.
- In an agentOS repo checkout, prefer `docs/`, `docs/api/*.md`, and package
  `PUBLIC_API.md` over this skill for exact API details.
