/**
 * Provider-neutral sandbox algebra.
 *
 * v0 is bounded, stateless, synchronous exec. A sandbox run is a carrier
 * operation behind a normal agentOS Tool; it is not durable state and it does
 * not write the ledger.
 */

export {
  DEFAULT_MAX_OUTPUT_BYTES,
  SANDBOX_MAX_TIMEOUT_MS,
  SandboxFailure,
  SandboxPolicyDenied,
} from "./types";

export type {
  ArtifactRef,
  ArtifactSource,
  MakeSandboxRunToolOptions,
  SandboxBackend,
  SandboxFailureCode,
  SandboxFileContent,
  SandboxNetwork,
  SandboxPolicy,
  SandboxPolicyRequest,
  SandboxRawResult,
  SandboxResultFields,
  SandboxRunRequest,
  SandboxRunSuccess,
  SandboxToolDefinition,
  SandboxToolLike,
  SandboxToolResult,
  StaticPolicyOptions,
} from "./types";

export { measureOutputBytes, sandboxFailureFromUnknown, toSandboxToolResult } from "./output";
export { staticPolicy } from "./policy";
export { runSandbox } from "./run";
export { makeSandboxRunTool } from "./tool";
