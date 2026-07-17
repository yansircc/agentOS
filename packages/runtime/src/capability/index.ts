import { Effect } from "effect";
import {
  runDynamicCapabilityResolversEffect,
  type DynamicCapabilityResolverServiceInput,
  type DynamicCapabilityResolverServiceResult,
} from "./dynamic-resolver";

export {
  defineCapability,
  type CapabilityEventHandlerContext,
  type CapabilityRuntimeHandle,
  type CapabilityContract,
  type CapabilityInstallation,
  type CapabilityInstallContext,
  type DefineCapabilitySpec,
} from "./contract";
export {
  defineHost,
  type HostProfile,
  type HostProvidedFact,
  type ResolvedHostFacts,
  type DefineHostSpec,
} from "./host";
export {
  workspaceOperations,
  WORKSPACE_OPERATION_HOST_FACT,
  type WorkspaceOperationsOptions,
  type WorkspaceOperationEnvResolver,
  type WorkspaceOperationEnvResolverInput,
  type WorkspaceOperationHostFacts,
  type WorkspaceOperationBindingEnvResolverInput,
  type WorkspaceOperationRequestedEnvResolverInput,
} from "./workspace-operations";
export {
  resolveRuntimeInstallGraph,
  type ResolvedCapabilityInstallGraph,
  type ResolvedCapabilityEventHandlerFactory,
  type ResolveRuntimeInstallGraphOptions,
  type ResolveRuntimeInstallGraphResult,
  type PreflightDiagnostic,
} from "./resolve";
export {
  makeDynamicCapabilityContext,
  type DynamicCapabilityResolverDefinition,
  type DynamicCapabilityResolverServiceInput,
  type DynamicCapabilityResolverServiceIssue,
  type DynamicCapabilityResolverServiceResult,
} from "./dynamic-resolver";

type DynamicCapabilityResolverRunner = (
  input: DynamicCapabilityResolverServiceInput,
) => Promise<DynamicCapabilityResolverServiceResult>;

/**
 * Lowers the Effect-native dynamic capability resolver into the public Promise facade.
 * @public
 */
export const createCapabilityResolverRuntime = (): Readonly<{
  runDynamicCapabilityResolvers: DynamicCapabilityResolverRunner;
}> => {
  const runDynamicCapabilityResolvers: DynamicCapabilityResolverRunner = (input) =>
    Effect.runPromise(runDynamicCapabilityResolversEffect(input));
  return { runDynamicCapabilityResolvers };
};

const capabilityResolverRuntime = createCapabilityResolverRuntime();

export const runDynamicCapabilityResolvers: DynamicCapabilityResolverRunner =
  capabilityResolverRuntime.runDynamicCapabilityResolvers;
export { nodeHost } from "./hosts";
export type {
  CapabilityRequirement,
  CapabilityRequirements,
  CapabilityHostFactRequirement,
  CapabilityPeerRequirement,
  CapabilityConfigRequirement,
  CapabilitySecretRequirement,
} from "./requirements";
export type { PreflightDiagnosticSink } from "../runtime-diagnostic-carrier";
