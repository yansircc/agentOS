# a79: Workspace Tool Baseline + DO RPC Return Typing

## Summary

stable axis: `WorkspaceEnv` is an actuator, not a projection owner.  
change axis: reusable workspace fs/search helpers, standard workspace tool set, and Durable Object RPC type shape.  
invariant: actuator reads/mutates current workspace state; pure helpers compare state; product code emits product facts.

Do not add `WorkspaceEnv.observeChanges(existingPaths)`.

## Key Changes

- Add `walkWorkspaceFiles(env, opts)` to `@agent-os/workspace-env`.
  - It returns deterministic relative file snapshots under a root.
  - It uses `WorkspaceEnv` methods only and writes no ledger facts.
  - It supports recursive/non-recursive walking and hidden-file inclusion.
- Add `diffWorkspaceFiles(previousPaths, currentFiles)`.
  - It is pure.
  - It returns current observed files and removed paths.
  - It does not know event names, projection kinds, or ledger APIs.
- Add deterministic file edit helpers:
  - `editWorkspaceFile(env, { path, oldString, newString, expectCount? })`.
  - `createWorkspaceTools` exposes `edit_file`.
  - Default edit behavior requires exactly one match. `expectCount` explicitly allows a different finite positive count.
  - The implementation is read + deterministic transform + write through existing `WorkspaceEnv`; do not add `WorkspaceEnvBackend.editFile`.
- Define model-facing write semantics:
  - `write_file` creates or overwrites complete file content;
  - `edit_file` performs deterministic exact replacement with match-count
    semantics;
  - both may be model-facing, but prompts/docs must state when each is used.
- Add typed search helpers and tools:
  - `globWorkspaceFiles(env, { pattern, root?, includeHidden?, maxMatches? })`.
  - `grepWorkspaceFiles(env, { pattern, root?, includeHidden?, maxMatches?, maxBytesPerMatch? })`.
  - `createWorkspaceTools` exposes `glob_files` and `grep_files`.
  - Implement in TypeScript over `walkWorkspaceFiles`; do not shell out to `find`, `grep`, or platform-specific commands.
- Define search semantics before implementation:
  - glob grammar and path normalization;
  - grep regex vs literal mode;
  - hidden-file default;
  - binary-file behavior;
  - truncation fields and byte limits;
  - deterministic max-match ordering;
  - root escape rejection.
- Keep product-owned `workspace.file.*` projection/event vocabulary outside agentOS.
- Tighten `durableObjectRpcClient` return typing so method calls return `Promise<Awaited<Result>>` while preserving function-bearing argument rejection.
- Update web-cursor to remove direct scan/diff boilerplate and remove `streamEvents as unknown` casts.
- Add or update `docs/packages/workspace-env.md` with the exact
  `write_file`, `edit_file`, `glob_files`, and `grep_files` semantics.

## Tests

- `walkWorkspaceFiles` normalizes relative paths, sorts output, respects root, and rejects escape paths through existing `WorkspaceEnv` validation.
- Recursive and non-recursive modes are covered.
- Hidden files are included only when requested.
- `diffWorkspaceFiles` reports observed and removed paths deterministically.
- `editWorkspaceFile` fails on zero matches, multiple matches, non-finite `expectCount`, and oversized resulting content.
- `edit_file` tool returns path, replacement count, and bytes written.
- `globWorkspaceFiles` and `grepWorkspaceFiles` produce deterministic sorted bounded output and respect hidden-file controls.
- Glob/grep fixtures cover hidden files, binary files, root escape attempts,
  large files, many matches, truncation metadata, regex mode, and literal mode.
- Search helpers are platform-independent and never invoke shell commands.
- RPC typing test shows a `Response`-returning DO method is callable without `unknown` casts.
- web-cursor `bun run check` passes after consuming repacked internal packages.

## Gates

Same root gates as a78, plus web-cursor consumer check after `pack:internal`.

## Assumptions

- No workspace projection base lands in this task.
- Digest strategy, source labels, and removed semantics remain product choices.
- Long-running process/port preview tools remain deferred lifecycle-carrier work.
