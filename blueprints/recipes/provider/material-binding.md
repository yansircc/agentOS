---json
{
  "schemaVersion": 1,
  "id": "provider.material-binding",
  "kind": "provider",
  "title": "Provider Material Binding",
  "summary": "Bind host-owned provider material without adding runtime provider code.",
  "primaryFile": "agentos.deployment.jsonc",
  "appliesTo": ["agentos add", "agentos update"],
  "upgradeGuide": "blueprints/UPGRADE.md",
  "lifecycleOwnership": {
    "create": "app-or-generated-target",
    "reuse": "app-or-generated-target",
    "delete": "app-or-generated-target",
    "credentials": "app-owned-material",
    "network": "app-or-generated-target"
  }
}
---

# Provider Material Binding

<!-- agentos:primary-file path="agentos.deployment.jsonc" -->

## Boundary

This recipe records app-owned provider material binding. It does not add runtime
subpaths, generated target replacements, provider package code, or secret
preflight logic.

## Lifecycle Ownership

Provider resources are created, reused, deleted, credentialed, and networked in
app-owned or generated target code. Runtime exposes stable contracts and pure
adapters only; it does not own provider lifecycle policy.

## Steps

1. Declare symbolic provider bindings in the host-owned
   `agentos.deployment.jsonc`.
2. Resolve provider secrets from the deployment environment without copying
   them into ProductIntent or ProductPlan.
3. Keep provider transport wiring and lifecycle policy in app-owned or generated
   target source.

## Upgrade Guide

`blueprints/UPGRADE.md` owns cumulative migration notes for this recipe.
