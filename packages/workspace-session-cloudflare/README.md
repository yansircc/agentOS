# @agent-os/workspace-session-cloudflare

Cloudflare Sandbox-compatible backend for `@agent-os/workspace-session`.

The package uses structural SDK types instead of importing a Cloudflare SDK
package. Apps provide the live namespace/client from their Worker environment.

## Invariant

The workspace-session carrier owns session lifecycle facts. The Cloudflare
backend supplies concrete session, workspace root, cleanup, backup, preview,
and destroy proof refs. It must not derive missing refs from `ScopeRef`, and it
must not write sandbox handles or client objects into ledger-visible payloads.

## Provider Shape

`makeCloudflareWorkspaceSessionProvider` adapts a structural namespace:

```ts
interface CloudflareWorkspaceSessionNamespace {
  start(request): Promise<CloudflareWorkspaceSessionClient>;
  restore(request): Promise<CloudflareWorkspaceSessionClient>;
  get(sessionRef: string): Promise<CloudflareWorkspaceSessionClient>;
}
```

`start` and `restore` allocate or rehydrate a client. `backup`, `preview`, and
`destroy` reacquire the client with `get(sessionRef)`. Reusing `restore` as a
session lookup is not allowed because backup refs and session refs are distinct
materials.

`makeCloudflareWorkspaceSessionLiveProvider` adapts a structural Cloudflare
Sandbox client shape. It calls `createSession`, `restoreBackup`,
`createBackup`, `exposePort`, and `destroy`, then converts successful SDK
operations into carrier-owned refs:

- `cloudflare-sandbox-session:*`
- `cloudflare-sandbox-workspace:*`
- `cloudflare-sandbox-backup:*`
- `cloudflare-sandbox-preview:*`
- `cloudflare-sandbox-destroy:*`

Those refs are proofs/handles for the workspace-session carrier. The SDK
client, namespace binding, preview token, backup handle object, and sandbox
objects are never written to ledger-visible payloads.

## Fast-Fail Rules

The provider must return non-empty:

- `sessionRef`;
- `workspaceRootRef`;
- `cleanupRef`;
- `backupRef`;
- `previewRef`;
- destroy `proofRef`.

Missing refs settle a `RejectedClaim` with `ProviderFailure`. There is no
fallback to resolver-derived roots, request session refs, or ambient provider
state.

## Live Evidence

Unit tests use structural namespace/client stubs. A real Cloudflare Sandbox
smoke requires an app-supplied namespace binding and prefixed `TEST_RUN_ID` /
`SCOPE_PREFIX` resources; that live evidence is not part of default CI until a
sandboxed account/binding is assigned.
