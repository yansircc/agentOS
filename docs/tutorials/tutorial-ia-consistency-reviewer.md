# Tutorial IA And Consistency Reviewer

## Goal

Review the tutorial ladder as one information architecture, not fourteen
independent pages.

## What You Build

A reviewer checklist that keeps beginner tutorials ordered, non-duplicative,
and honest about which checkpoints are local proofs versus live smokes.

## Prerequisites

- [Full small agent app](full-small-agent-app.md)
- [Verification](../verification.md)
- [Usage surfaces](../usage-surfaces.md)

## Steps

1. Check the sidebar source of truth:

   ```sh
   jq -r '.tutorials[].label' docs/tutorials/sidebar.json
   ```

2. Confirm every tutorial file appears exactly once in that list:

   ```sh
   pnpm run docs:check
   ```

3. Review each page for the required tutorial headings:

   ```text
   Goal
   What You Build
   Prerequisites
   Steps
   Checkpoint
   Next
   ```

4. Enforce proof language:

   ```text
   local proof       typecheck, unit test, fake provider, bundle build
   live smoke        opt-in provider/deploy run with credentials
   not proven        anything not executed by the tutorial evidence
   ```

5. Reject source-shape drift:

   ```text
   no deep /src imports from private source packages
   no workspace: or file: consumer install path
   no raw provider URL or token in docs examples
   no duplicate kill criterion in package docs
   ```

## Checkpoint

The ladder reads in this order:

```text
A1 durable fact
A2 tool loop
A3 tool contract
A4 projection
A5 background work
A6 output stream
A7 bidirectional stream
A8 Cloudflare app
A9 provider material
A10 npm consumption
A11 ops
A12 deploy
A13 full app
A14 review
```

The sidebar must match the same order. If a future tutorial appears in
`docs/tutorials/*.md` but not in `docs/tutorials/sidebar.json`, `docs:check`
must fail.

## Next

Use the ladder as the starting point for the next real agent app tutorial.
