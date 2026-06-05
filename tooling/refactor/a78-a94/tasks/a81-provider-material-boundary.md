# a81: Provider Material Boundary Hardening

## Summary

stable axis: ledger, claims, projections, docs examples, and stream frames contain symbolic refs only.  
change axis: provider return values and carrier payload shapes.  
invariant: resolved provider material never becomes durable substrate truth.

Current failure:

- `workspace_session.preview_allocated` payload includes optional `url`.
- Workspace session projection stores preview URLs.
- Cloudflare workspace-session provider can encode URL into `previewRef`.

## Key Changes

- Remove `url` from `workspace_session.preview_allocated` schema, payload type, projection state, docs, and tests.
- `WorkspaceSessionPreviewRef` contains only `{ previewRef, port }`.
- `previewRef` must be symbolic and must not encode `https://`, raw hostnames, tokens, or provider URLs.
- Cloudflare workspace-session preview allocation may return a raw URL to the immediate caller only as provider-local material, but ledger/projection commit payload writes only symbolic `previewRef`.
- Do not add a durable URL resolver in this task. If a product later needs stable preview URL readback, it must go through a provider/resolver-side API that does not write the URL to ledger/projection.
- Add a shared test helper that serializes claim-bearing payloads and projection states and rejects provider URL patterns for workspace-session.
- Generalize the sentinel across UI/API surfaces: provider URLs, credentials,
  file bytes, resolved material values, and provider-native metadata outside the
  allowlist must be absent from ledger-visible payloads, projections, AG-UI
  frames, and product API JSON.
- Audit deploy/staging examples touched by this task and keep provider material out of ledger-visible payloads.

## Tests

- `workspace_session.preview_allocated` decode rejects `url`.
- Projection output for previews never contains `url`.
- Cloudflare provider test proves `previewRef` does not contain `https://` and ledger-visible output does not contain the preview URL.
- Docs/API generated output has no `url` field for workspace-session preview payload/projection.
- Provider-local preview implementation may receive `url`, but the carrier `allocatePreview` result no longer includes it.
- Redaction sentinel fails if provider URLs, credentials, file bytes, resolved
  material values, or provider-native metadata outside the allowlist appear in
  ledger-visible payloads, projections, AG-UI frames, or product API JSON.

## Gates

Full root gates plus:

```sh
git grep "workspace_session.preview_allocated.*url\\|preview_allocated.*url" docs packages
git grep "https://preview" packages/carriers packages/providers/workspace-session-cloudflare docs
```

The first grep must return zero. The second may only match provider-local tests that assert URLs are not ledger-visible.

## Assumptions

- No backwards compatibility for URL-bearing workspace-session facts.
- URL lookup is provider material resolution, not projection state.
