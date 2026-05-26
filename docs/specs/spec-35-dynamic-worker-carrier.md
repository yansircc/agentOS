# Spec 35: Dynamic Worker Carrier

Status: v0 implementation target

## 1. Boundary

Dynamic Worker is a carrier package, not a core primitive.

Core owns ledger, dispatch, scheduling, resources, LLM routes, tool loop,
stream finality, and abort taxonomy. Dynamic Worker owns one bounded execution
of Worker-compatible generated code with explicit bindings, egress policy, and
resource limits.

The package shape is:

```text
packages/dynamic-worker  provider-neutral algebra
```

A Cloudflare backend may adapt this algebra to Dynamic Workers / Code Mode, but
the provider SDK is not part of the core package.

## 2. Generator

Agent-produced code has two execution classes:

```text
Worker-compatible stateless code  -> dynamic-worker
Linux/workspace/process work       -> sandbox / workspace-session
```

The split is semantic, not cost-based:

- Dynamic Worker executes a request against generated Worker code.
- Sandbox executes commands and manages process/file behavior.

Putting stateless Worker-compatible code into Sandbox leaks container concerns
into the light path. Putting builds, tests, Git, package installs, previews, or
backup/restore into Dynamic Worker pretends a request isolate is a workspace.

## 3. v0 Contract

v0 is **bounded stateless Worker request execution**.

Required constraints:

- One call is one bounded request against one generated Worker module.
- No durable isolate identity. Backend isolate caching is unobservable.
- No filesystem, shell, package install, or background process contract.
- No preview ports or long-running services.
- The generated code receives only explicit bindings supplied by the caller.
- Egress defaults to closed and is policy-mediated.
- CPU/subrequest/timeout limits are request policy, not app heuristics.
- The package never writes the ledger.
- The package never receives ambient secrets automatically.

## 4. Request Shape

```ts
interface DynamicWorkerRunRequest {
  code: string
  codeRef?: string
  compatibilityDate?: string
  request: {
    method?: string
    url: string
    headers?: Record<string, string>
    body?: string | Uint8Array
  }
  bindings?: DynamicWorkerBinding[]
  egress?: { mode: "none" } | { mode: "allowlist"; hosts: string[] }
  limits?: { cpuMs?: number; subrequests?: number }
  timeoutMs: number
  maxBodyBytes?: number
}
```

`codeRef` is audit metadata. The bytes live in the caller/carrier, not in the
ledger.

## 5. Tool Result Shape

The tool helper returns a closed ledger-safe result:

```ts
type DynamicWorkerToolResult = {
  ok: boolean
  status?: number
  headers?: Record<string, string>
  bodyHead: string
  bodyBytes: number
  bodyTruncated: boolean
  durationMs: number
  workerId: string
  failureCode?:
    | "PolicyDenied"
    | "Timeout"
    | "CompileError"
    | "RuntimeError"
    | "ResourceLimitExceeded"
    | "NetworkBlocked"
    | "ProviderFailure"
  reason?: string
}
```

Full response bodies do not enter the ledger. Apps materialize large outputs
elsewhere and store refs.

## 6. Explicitly Not In v0

- Git / workspace sessions
- background processes or services
- preview ports
- package install / build / test command runners
- provider snapshot / restore
- artifact store
- automatic secret injection
- package-owned `dynamic_worker.*` ledger vocabulary
- dynamic-worker registry or deployment promotion

## 7. Verification Matrix

Contract tests must cover:

- minimal request round trip through a backend;
- egress denied by default;
- timeout normalized as typed `Timeout`;
- body truncation reports byte counts and `bodyTruncated:true`;
- malformed requests fail closed through the policy channel.
