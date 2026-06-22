---
name: agentos-release
description: Use when bumping, packing, publishing, resuming, or verifying agentOS internal npm distribution packages under the public @yansirplus scope.
---

# agentOS Release

Use this skill in the agentOS repo when publishing the internal npm
distribution.

## Invariant

```text
stable axis: npm registry package versions are the release fact
change axis: repo release version, generated tarballs, publish completion
invariant: package lists and tarball paths come from agentOS distribution projection, not hand-maintained release state
```

## Workflow

1. Inspect the repo state and current registry version:

   ```sh
   git status --short --branch
   npm view @yansirplus/runtime version versions --json
   ```

2. Run the release script. It can bump package versions, run the release gate,
   pack the distribution, skip already-published packages, publish the missing
   tarballs, and verify the registry result.

   ```sh
   node skills/agentos-release/scripts/bump-and-publish.mjs --version 0.3.0 --otp "$NPM_CONFIG_OTP"
   ```

3. If `bun run check:full` already passed for the exact dirty tree, resume only:

   ```sh
   node skills/agentos-release/scripts/bump-and-publish.mjs --skip-gates --skip-pack --otp "$NPM_CONFIG_OTP"
   ```

4. If npm returns `EOTP`, get a fresh one-time password and rerun the same
   command. The script queries npm before publishing each package, so a rerun
   resumes safely.

5. After success, verify the key consumer packages:

   ```sh
   npm view @yansirplus/core version versions --json
   npm view @yansirplus/runtime version versions --json
   npm view @yansirplus/client version versions --json
   npm view @yansirplus/cli version versions --json
   ```

6. Commit only after the registry verifies the target version:

   ```sh
   git add package.json packages/*/*/package.json packages/*/package.json tooling/*/package.json skills/agentos-release
   git commit -m "chore(release): bump agentOS packages to 0.3.0"
   ```

## Rules

- Do not hand-publish a manually assembled package list.
- Do not edit `dist/internal-npm/install-manifest.json`; regenerate it through
  `tooling/distribution/distribution.mjs`.
- Do not treat `effect-skill-scan` as release proof. It is one mechanical gate;
  the registry verify step is the release fact.
- Never print or store the OTP. Pass it through `--otp` or `NPM_CONFIG_OTP`.
