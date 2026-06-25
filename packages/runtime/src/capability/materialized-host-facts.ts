import type { ResolvedHostFacts } from "./host";
import type { HostProvidedFact } from "./requirements";

export const WORKSPACE_OPERATION_HOST_FACT = "fs.workspace" as const;

export interface MaterializedHostFactContract {
  readonly fact: HostProvidedFact;
  readonly expected: string;
  readonly accepts: (value: unknown) => boolean;
}

const materializedHostFactContracts = [
  {
    fact: WORKSPACE_OPERATION_HOST_FACT,
    expected: "WorkspaceOperationEnvResolver",
    accepts: (value: unknown): boolean => typeof value === "function",
  },
] as const satisfies ReadonlyArray<MaterializedHostFactContract>;

export const allMaterializedHostFactContracts = (): ReadonlyArray<MaterializedHostFactContract> =>
  materializedHostFactContracts;

export const hasResolvedHostFact = (facts: ResolvedHostFacts, fact: HostProvidedFact): boolean =>
  Object.prototype.hasOwnProperty.call(facts, fact);
