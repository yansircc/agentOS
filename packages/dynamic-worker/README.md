# @agent-os/dynamic-worker

Provider-neutral Dynamic Worker carrier algebra.

Use this carrier when agent-produced code is Worker-compatible and should run as
one bounded stateless request. It is the light path for code-as-function.

It is intentionally not a workspace:

- no filesystem contract;
- no background processes or preview ports;
- no durable isolate identity;
- no package install/build shell;
- no automatic secrets;
- no ledger writes.

Use `@agent-os/sandbox` when the job needs Linux process semantics, a file tree,
Git, build/test commands, long-running services, or preview servers.
