---json
{
  "schemaVersion": 1,
  "id": "provider.material-binding",
  "kind": "provider",
  "title": "Provider Material Binding",
  "summary": "Bind product-owned provider material without adding runtime provider code.",
  "primaryFile": "agentos.config.jsonc",
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

<!-- agentos:primary-file path="agentos.config.jsonc" -->

## Boundary

This recipe records app-owned provider material binding. It does not add runtime
subpaths, generated target replacements, provider package code, or secret
preflight logic.

## Lifecycle Ownership

Provider resources are created, reused, deleted, credentialed, and networked in
app-owned or generated target code. Runtime exposes stable contracts and pure
adapters only; it does not own provider lifecycle policy.

## Steps

1. Declare the provider material requirement in the app-owned
   `agentos.config.jsonc`.
2. Map provider secrets through product-owned material refs.
3. Keep provider transport wiring and lifecycle policy in app-owned or generated
   target source.

## Upgrade Guide

`blueprints/UPGRADE.md` owns cumulative migration notes for this recipe.
