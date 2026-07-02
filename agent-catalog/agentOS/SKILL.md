---
name: agentOS
description: Generated installed catalog for agentOS 0.5.24 public packages, API intent, agent navigation, invariants, errors, and provenance.
---

# agentOS

This catalog is generated for `@yansirplus/cli` 0.5.24. Treat files under `references/` as installed-version facts; do not infer future API from chat context, archived CST events, or source checkouts.

## Routes

- Package ownership and entrypoints: `references/package-map.md`
- Exact public API intent: `references/public-api/*.md`
- Agent route from intent to primitive: `references/agent/start-here.md`
- Machine-readable recipes, primitives, decision graph, errors, and invariants: `references/agent/*.json`
- Source and output hashes: `references/provenance.json`

## Boundaries

- `SKILL.md` is only a router; large facts live in `references/`.
- `catalog.source.json` is not a valid source of truth.
- Channel, schedule, lifecycle, package, API, error, and invariant facts come from the referenced generated projections and source manifests listed in provenance.
