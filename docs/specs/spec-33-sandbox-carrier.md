# Spec 33: Sandbox Carrier

Status: v0 implementation target

## 1. Boundary

Sandbox is a carrier package, not a core primitive.

Core owns ledger, dispatch, scheduling, resources, LLM routes, tool loop,
stream finality, and abort taxonomy. Sandbox owns bounded external execution:
processes, files, stdout/stderr, backend sandbox ids, and backend-specific
eviction/error classification.

The v0 package shape is:

```text
packages/sandbox             provider-neutral algebra
packages/sandbox-cloudflare  Cloudflare Sandbox SDK-compatible backend
```

`packages/core` is unchanged. Apps attach sandbox through a normal Tool.

## 2. v0 Contract

v0 is **bounded synchronous process exec**.

This package is not the default carrier for Worker-compatible generated code.
Stateless code-as-function belongs to
[spec-35 Dynamic Worker Carrier](./spec-35-dynamic-worker-carrier.md). Sandbox
exists when the job needs Linux process semantics: command execution,
filesystem materialization, dependency install/build/test, large file IO,
background service preview, or provider snapshot/restore.

Required constraints:

- One call is one bounded run.
- Hard timeout is finite and capped by the package.
- Algebra timeout returns typed `Timeout`; backends wrapping cancellable
  provider calls must wire Effect interruption into the provider cancellation
  surface. For Cloudflare this means passing `AbortSignal` to `exec`.
- The caller must provide every file required for that run, unless a future
  stateful workspace-session carrier owns the file tree explicitly.
- Sandbox filesystem state is not durable truth.
- Backend reuse is an implementation detail; apps cannot observe or depend on
  reuse.
- If eviction happens before user code starts, a backend may rebuild and run.
- If eviction happens after user code starts, the result is typed
  `SandboxEvicted`.
- The package never writes the ledger.
- The package never receives ambient secrets automatically.

## 3. Policy

Policy is a function, not a record:

```ts
type SandboxPolicy = (request: SandboxPolicyRequest) => Effect.Effect<void, SandboxPolicyDenied>;
```

Record helpers such as `staticPolicy({ allowNetwork })` are sugar that produce
the function. The function is the public contract because real policy often
depends on scope, user role, quota, or environment.

## 4. Tool Result Shape

The tool helper returns a closed ledger-safe result shape. It does not throw on
sandbox execution failure because current core stringifies `ToolError.cause` in
the abort event; a returned failure result preserves structured `failureCode`
inside `tool.executed.payload.result`.

```ts
type SandboxToolResult =
  | {
      ok: true;
      exitCode: number;
      stdoutHead: string;
      stderrHead: string;
      stdoutBytes: number;
      stderrBytes: number;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      artifacts: ArtifactRef[];
      durationMs: number;
      sandboxId: string;
    }
  | {
      ok: false;
      failureCode:
        | "SandboxEvicted"
        | "PolicyDenied"
        | "Timeout"
        | "OOM"
        | "NetworkBlocked"
        | "ProviderFailure";
      reason: string;
      stdoutHead: string;
      stderrHead: string;
      stdoutBytes: number;
      stderrBytes: number;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      artifacts: ArtifactRef[];
      durationMs: number;
      sandboxId: string;
    };
```

`stdoutHead` / `stderrHead` are byte-capped. Bytes never enter the ledger as
artifacts. Apps materialize artifact bytes/streams elsewhere, then write refs.

## 5. Artifacts

Sandbox providers may return `ArtifactSource` values:

```ts
type ArtifactSource =
  | { kind: "url"; url: string; contentType?: string; name?: string }
  | { kind: "data"; bytes: Uint8Array; contentType: string; name?: string }
  | { kind: "stream"; stream: ReadableStream<Uint8Array>; contentType?: string; name?: string };
```

The tool result contains only `ArtifactRef[]`. v0 does not include an
`ArtifactStore`; apps decide whether to write R2, S3, local files, or discard.

## 6. Backend Classifier Fragility

Cloudflare v0 eviction classification is string-based because the current SDK
surface used by this package does not expose stable typed errors for sandbox
eviction / missing-session failures.

The classifier may inspect substrings such as `not found`, `404`, `evict`, or
`destroy`. This proves only the normalized package behavior for known observed
messages, not semantic stability of future SDK wording. When the SDK exposes
typed errors, backend instance checks must be added before string matching.

## 7. Explicitly Not In v0

- Dynamic Workers / Code Mode (see spec-35)
- long-running sandbox jobs
- background processes or services
- persistent sandbox sessions
- sandbox filesystem as durable state
- `ArtifactStore`
- multi-tenant sandbox sharing
- automatic secret injection
- automatic retry / re-warm for stateful sessions
- new core event prefixes such as `sandbox.*`
- new core error classes

## 8. Verification Matrix

Contract tests must cover:

- `exec("ls")` minimal round trip.
- provider eviction becomes `SandboxEvicted`.
- policy denial becomes `PolicyDenied`.
- allowlist policy rejects a non-allowed host.
- backend non-completion before `timeoutMs` becomes typed `Timeout`.
- Cloudflare backend passes cancellation signal to provider `exec`.
- huge stdout/stderr are byte-capped with explicit byte counts and
  `truncated:true`.
- retry/freshness is app/tool-loop policy; the sandbox package exposes one run
  per call and keeps no durable session state.
