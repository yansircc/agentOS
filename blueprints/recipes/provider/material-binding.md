---json
{
  "schemaVersion": 1,
  "id": "provider.material-binding",
  "kind": "provider",
  "title": "Provider Material Binding",
  "summary": "Bind product-owned provider material without adding runtime provider code.",
  "primaryFile": "agentos.config.jsonc",
  "appliesTo": ["agentos add", "agentos update"],
  "upgradeGuide": "blueprints/UPGRADE.md"
}
---

# Provider Material Binding

<!-- agentos:primary-file path="agentos.config.jsonc" -->

## Boundary

This recipe records app-owned provider material binding. It does not add runtime
subpaths, generated target replacements, provider package code, or secret
preflight logic.

## Steps

1. Declare the provider material requirement in the app-owned
   `agentos.config.jsonc`.
2. Map provider secrets through product-owned material refs.
3. Keep provider SDK imports and transport-specific wiring in app-owned source.

## Upgrade Guide

`blueprints/UPGRADE.md` owns cumulative migration notes for this recipe.
