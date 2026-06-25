---json
{
  "schemaVersion": 1,
  "id": "sandbox.lifecycle-boundary",
  "kind": "sandbox",
  "title": "Sandbox Lifecycle Boundary",
  "summary": "Keep sandbox lifecycle, credentials, and network policy outside runtime public API.",
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

# Sandbox Lifecycle Boundary

<!-- agentos:primary-file path="agentos.config.jsonc" -->

## Boundary

This recipe records sandbox lifecycle ownership for app-owned or generated target
code. It does not add runtime subpaths, provider resource constructors, cleanup
helpers, credential loaders, or network policy code.

## Lifecycle Ownership

Sandbox resources are created, reused, deleted, credentialed, and networked in
app-owned or generated target code. Runtime exposes stable contracts and pure
adapters only; it does not own sandbox lifecycle policy.

## Steps

1. Declare the sandbox material or host requirement in the app-owned
   `agentos.config.jsonc`.
2. Bind credentials through product-owned material refs.
3. Implement create, reuse, delete, and network policy in app-owned or generated
   target source.
4. Consume runtime stable contracts or pure adapters only through declared
   public entrypoints.

## Upgrade Guide

`blueprints/UPGRADE.md` owns cumulative migration notes for this recipe.
