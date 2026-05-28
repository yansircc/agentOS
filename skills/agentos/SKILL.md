---
name: agentos
description: Use when integrating, migrating to, or reviewing agentOS in an application repo, especially to replace custom agent loops, tool gates, ledgers, material resolvers, Cloudflare resource wiring, LLM token streams, or skill/tool registration with agentOS primitives.
---

# agentOS

Use this skill to integrate agentOS without re-inventing its substrate.

## Workflow

1. Inspect the target repo before editing:
   - installed `@agent-os/*` packages;
   - local agent loop, tool gate, ledger, scheduler, material resolver, and
     streaming code;
   - package READMEs and `PUBLIC_API.md` files for exact installed exports.

2. State the boundary before changes:

   ```text
   stable axis:
   change axis:
   invariant:
   ```

3. Prefer the agentOS primitive:
   - agent run loop -> Cloudflare backend `submit`;
   - tool identity/admission -> `defineRegisteredTool` and `ToolContract`;
   - durable truth -> ledger events and projections;
   - execution means -> `MaterialRef` and `RefResolver`;
   - token progress -> `@agent-os/turn-stream`;
   - consumer run stream -> `@agent-os/run-stream`;
   - resource facts -> `@agent-os/resource-carrier`;
   - Cloudflare resource materialization -> `@agent-os/resource-cloudflare`;
   - install-time tool bundles -> `@agent-os/skill-registry`.

4. Keep the core invariant:
   - `PreClaim` names effect identity only:
     `operationRef / scopeRef / authorityRef / originRef`;
   - `MaterialRef` names execution means;
   - cleanup/proof refs name release and verification vocabulary;
   - resolved material never enters ledger, projections, run-stream frames, or
     error payloads;
   - skill identity stops at registration; runtime sees tools.

5. Fail closed. Do not add env fallback, inferred credentials, shadow state,
   duplicate run truth, or product vocabulary to agentOS-owned logic.

6. Verify the class, not just the instance:
   - typecheck and tests for touched packages;
   - redaction scans for provider material;
   - ledger/projection assertions proving no second truth.

## References

- Read `references/integration-checklist.md` when planning a migration.
- Read `references/package-map.md` when choosing packages.
- In an agentOS repo checkout, prefer `docs/`, `docs/api/*.md`, and package
  `PUBLIC_API.md` over this skill for exact API details.
