---
name: count-effective-code
description: Measure effective repository code size from a git tree with generated/docs/vendor exclusions, source/test/tooling buckets, base-ref deltas, churn, hotspots, and test-to-source ratios. Use when Codex needs to answer codebase size, effective LOC/SLOC, maintenance surface, growth trend, hotspot, test debt, or convergence/refactor sizing questions.
---

# Count Effective Code

Use this skill to produce a reproducible code-size census instead of an ad hoc
`find | wc -l` count.

## Workflow

1. Bind the counting invariant before reporting:

   ```text
   stable axis: code-size census is a projection of one git tree and one inclusion policy
   change axis: repo language/layout and user-selected reporting buckets
   invariant: one filter owns the measured file set; reports separate source, tests, tooling, and generated/docs/vendor exclusions
   ```

2. Count the tracked git tree by default. Do not blend untracked files or dirty
   worktree state into a `HEAD` answer unless the user asks for worktree size.

3. Run the bundled script from the target repo root:

   ```sh
   python3 skills/count-effective-code/scripts/effective_code_census.py --repo . --ref HEAD --top 15
   ```

   For the community-style report, add an explicit base ref and churn window:

   ```sh
   python3 skills/count-effective-code/scripts/effective_code_census.py --repo . --ref HEAD --base-ref origin/main --churn-since YYYY-MM-DD --top 15
   ```

   For machine-readable output:

   ```sh
   python3 skills/count-effective-code/scripts/effective_code_census.py --repo . --ref HEAD --json
   ```

4. Report both totals and the useful denominator:
   - `total` effective code includes production source, tests, tooling, scripts,
     and code-like config that passed the filter;
   - `package-source` or `source` is the production-source denominator;
   - `package-tests` or `tests` is the test maintenance surface;
   - `tooling` is not product code, but may be relevant for maintenance.

5. Treat SLOC as the denominator, not the conclusion. Prefer these derived
   tables when the inputs are available:
   - bucket deltas against `--base-ref`;
   - top largest files;
   - package test/source ratios;
   - package source/test deltas against `--base-ref`;
   - top churn files from `--churn-since`;
   - hotspots ranked by `current code SLOC * churn`.

6. State the policy, not only the number. Name the ref, counter, excluded
   classes, and whether generated/docs/vendor/build artifacts were excluded.

7. If the repo has unusual source roots or checked-in generated code, inspect
   the largest files and excluded counts. Adjust the script policy only when the
   repo's source-of-truth boundary requires it; do not hand-delete individual
   files from the result.

## Script Contract

`effective_code_census.py` materializes each requested git ref with `git archive`,
filters tracked paths once per ref with the same policy, then counts with
`tokei` or `cloc`. Churn is read from `git log --numstat` and projected onto the
current ref's counted files; it does not expand the measured file set. It fails
closed if neither counter is installed. Prefer the `tokei` result when
available; `cloc` is a fallback or cross-check and may recognize a slightly
different file set.

Fallback model: use `cloc` only when the machine lacks `tokei` or when a
cross-check is explicitly useful. The skill does not vendor a multilingual
comment parser. If the repo standardizes `tokei` as an available dependency,
remove the `cloc` fallback.

Default exclusions cover docs/prose, generated directories/files, lockfiles,
package/generated API docs, dependency directories, build outputs, caches, and
vendored code. The script treats those exclusions as a measurement policy, not
as proof that a repo has no generated source.
