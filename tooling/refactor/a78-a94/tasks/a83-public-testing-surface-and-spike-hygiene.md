# a83: Public Testing Surface + Spike Hygiene

## Summary

stable axis: public API docs describe production substrate; test-only controls are not public product contracts.  
change axis: Cloudflare testing export and tracked spike files.  
invariant: test seams are explicit repo-local fixtures, not public package API.

Current failures:

- `@agent-os/backend-cloudflare-do/testing` is exported and documented as public surface.
- `spikes/vibe-like-agent-app` is tracked despite repo guidance that spikes are local pressure tests unless explicitly promoted.

## Key Changes

- Remove the public `./testing` export from `@agent-os/backend-cloudflare-do`.
- Move testing drain helpers under package-internal test fixtures or a repo-only tooling path that is not published and not listed in public API docs.
- Update runtime tests to import the internal fixture path directly.
- Public docs should mention alarm-owned production drain only; deterministic drain remains test harness implementation detail.
- Delete tracked `spikes/vibe-like-agent-app` from repo source. Preserve no compatibility shim or docs projection for it.
- Keep only `spikes/_active/.gitkeep` as the tracked placeholder unless a future task explicitly promotes an active spike registry.
- Add a repo check that fails if tracked `spikes/*` files exist outside `spikes/_active/.gitkeep`.

## Tests

- Public API check no longer lists `@agent-os/backend-cloudflare-do/testing`.
- Distribution check proves no testing drain helper is packaged.
- Backend runtime tests still have deterministic drain via internal fixture.
- Spike hygiene check fails with any tracked spike fixture outside `spikes/_active/.gitkeep`.

## Gates

Full root gates plus:

```sh
bun run check:public-api
bun run check:distribution
git ls-files spikes
```

`git ls-files spikes` must return only `spikes/_active/.gitkeep`.

## Assumptions

- No external user compatibility is required.
- Production apps must not call deterministic drain helpers.
