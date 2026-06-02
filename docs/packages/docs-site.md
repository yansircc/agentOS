# @agent-os/docs-site

## Purpose

Private Astro Starlight documentation site for agentOS. It renders projected
content from `docs/**`; it is not a source of documentation facts.

## Invariant

The docs site is a generated projection. Authors edit `docs/**`, not
`tooling/docs-site/src/content/docs/**`. The package is internal-only and
must remain `published: false` in `docs/surface.json`.

## Minimal Usage

Run the generated site locally from the repo root:

```sh
bun run docs:site:dev
```

## Verification

```sh
bun run docs:site:build
```
