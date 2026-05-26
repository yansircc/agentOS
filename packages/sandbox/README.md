# @agent-os/sandbox

Provider-neutral sandbox carrier algebra.

v0 is intentionally narrow:

- bounded synchronous exec only;
- stateless per call;
- no durable sandbox filesystem contract;
- no ArtifactStore;
- no secret injection;
- no core changes.

Use `makeSandboxRunTool()` to expose one sandbox run as a normal agentOS Tool.
The tool returns a ledger-safe `SandboxToolResult` with byte-capped stdout and
stderr.

