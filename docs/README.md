# agentOS Docs

What do you need?

- First time with agentOS: [hello ledger event](tutorials/hello-ledger-event.md).
- Build a coding app: [vibe-like app guide](guides/build-vibe-like-coding-app.md).
- Build a workspace agent: [natural-language workspace agent](guides/build-natural-language-workspace-agent.md).
- Add a capability: [guides](guides/add-attached-stream.md).
- Understand the model: [concepts](concepts/durable-truth.md).
- Check package intent: [runtime packages](runtime-packages.md).
- Check TypeScript exports: [runtime exports](api/runtime.md).
- Check carrier schemas: [carrier reference](reference/carriers.md).
- Consume npm packages: [internal npm distribution](distribution.md).

Public documentation facts live in `docs/**`; package README, `PUBLIC_API.md`,
and the docs site are projections.

## Governance

Already-clear algebra must become type-proof or boot-proof. Runtime validation
is only for unknown external input, not internally constructed states. Every
ledger fact has one commit primitive as its source generator. Every algebra has
one code source. Breaking refactors may fix concept placement; they do not
authorize untriggered capabilities.

Deferred triggers: `WorkspaceFs + OverlayFs` starts on real multi-file
trial/rollback pressure, whole-workspace rollback need, or repeated staging-dir
rollback logic. `defineBoundary()` starts after a second concrete boundary
matches a64/a69 direction, shape, policy, discoverability, and adaptation locus.
Durable reconnect/resume starts only when product UX requires it.
