# @agent-os/skill-registry

## Purpose

Install-time skill manifest validation and registration into core tools.

## Invariant

Skill is install-time identity, not runtime identity. After registration,
submit, admitters, and ledger readers only see core `Tool` entries. This
package exports no ledger events, projections, install audit facts, discovery
policy, zip install policy, or MCP transport.

## Minimal Usage

Pass a `SkillManifest` to `registerSkill`. The package constructs registered
tools through core tool contracts; it does not accept hand-built branded
contracts.

```ts
import { registerSkill } from "@agent-os/skill-registry";
```

## Verification

```sh
cd packages/skill-registry
vp test run
```
