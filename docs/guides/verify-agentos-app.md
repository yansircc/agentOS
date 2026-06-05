# Verify An agentOS App

## Outcome

You can prove an agentOS app is using the substrate boundary without relying on
review-only checks.

## Prerequisites

- [Durable truth](../concepts/durable-truth.md)
- [Distribution boundary](../concepts/distribution-boundary.md)
- [Verification](../verification.md)

## Steps

1. Run package or app unit tests first.
2. Run TypeScript under the app resolver.
3. Run consumer or distribution fixtures when npm packages changed.
4. Run runtime harnesses for Durable Object, storage, or facade changes.
5. Run whitespace and Effect scanner checks before commit.

## Consumer Gates

For product apps that consume internal agentOS packages:

1. Pin every consumed `@agent-os/*` package to the current internal tarball
   manifest produced by `bun run pack:internal`.
2. Run the product package install from a fresh lockfile when tarball hashes or
   transitive agentOS dependencies changed.
3. Assert the product has no raw JSON Schema source for agentOS-owned tools.
   Workspace tools should come from `@agent-os/workspace-env`.
4. Assert the product has no runtime-event fallback parser for agentOS-owned
   payloads. Use `decodeRuntimeLedgerEvent`, `projectRunTrace`, `projectRunsPage`,
   or an AG-UI frame projection.
5. Assert product HTTP/SSE surfaces expose redacted run projections or redacted
   AG-UI frames, not raw ledger payload rows.
6. Keep product-owned event vocabularies product-owned. A single consumer proof
   must not promote `workspace.file.*` into substrate packages or docs.
7. Add a golden frame mapping for any AG-UI run stream the product renders.
   React products use `@agent-os/ag-ui-react`; Svelte products use
   `@agent-os/ag-ui-svelte`. Both bindings consume the same core frame grammar.
8. Run a UI render smoke that proves one run detail can render from typed runtime
   projection or AG-UI frames.
9. Run a redaction sentinel over product API JSON and UI frames. It must fail if
   provider URLs, credentials, tokens, resolved material values, full file bytes,
   or non-allowlisted provider metadata appear.
10. For workspace products, run one natural-language loop:
    inspect -> glob/grep -> edit/write -> verify -> terminal UI. Record the run
    id, terminal event id, workspace diff, and package tarball hash.

## References

- [Verification](../verification.md)
- [Boundary contract](../boundary-contract.md)
