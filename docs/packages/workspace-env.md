# @agent-os/workspace-env

## Purpose

Runtime-neutral workspace fs+exec actuator plus standard workspace tools.

## Invariant

WorkspaceEnv owns path normalization, fs+exec method shape, and standard tool
generation. The provider adapter owns the concrete execution domain: local host,
Cloudflare Sandbox, or another explicit domain. WorkspaceEnv does not own ledger
facts, workspace projections, product workflow vocabulary, or workspace-session
lifecycle.

## Minimal Usage

Construct a `WorkspaceEnv` from a provider adapter, then pass it to
`createWorkspaceTools`. Product code may attach observation hooks for local
projections, but hook failure fails the tool instead of silently drifting.

`WORKSPACE_TOOL_DEFAULT_DECLARATIONS` is the single catalog for the standard
workspace tool declarations consumed by `workspace@1` authoring and runtime
binding. `shell` is a mutation subclass with a stricter interaction floor.

## File Tools

`write_file` creates or overwrites one complete UTF-8 file. It is the tool for
whole-file replacement and returns the workspace-relative path plus the number
of bytes written.

`edit_file` performs exact string replacement inside one UTF-8 file. By default,
`oldString` must occur exactly once. `expectCount` may set another finite
positive expected count. Zero matches, multiple matches without an explicit
count, non-finite counts, and output above the configured file byte limit fail
before writing.

`glob_files` and `grep_files` search the current workspace state through
`WorkspaceEnv`; they do not shell out and they do not emit ledger facts.

Search paths are slash-normalized workspace-relative paths. `root` defaults to
`.` and is resolved through `WorkspaceEnv`, so root escapes fail through the
same path validation as file reads and writes. Hidden paths are excluded by
default; `includeHidden: true` includes any path with a segment beginning with
`.`.

Glob grammar is segment based. `*` matches zero or more characters within one
path segment, `?` matches one character within one segment, and `**` as a full
segment matches zero or more path segments. Patterns are matched relative to
`root`; returned paths remain relative to the workspace root. Results are sorted
by path and bounded by `maxMatches` with `truncated: true` when additional
matches exist.

`grep_files` defaults to `mode: "literal"`. `mode: "regex"` uses a JavaScript
regular expression without flags and rejects expressions that produce empty
matches. Search is line-oriented. Matches are ordered by path, line, then
column. Files containing a NUL byte are treated as binary, skipped for text
matching, and reported in `skippedBinaryPaths`. `maxBytesPerMatch` bounds the
returned line and match text previews; truncated previews carry explicit
`lineTextTruncated` and `matchTextTruncated` booleans.

## Verification

```sh
cd packages/execution-domains/workspace-env
vp test run
```
