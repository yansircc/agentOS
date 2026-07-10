/**
 * Read-only inspection projection over existing compile, resolve, and runtime facts.
 *
 * The snapshot is a projection, not a registry. Capability ownership comes from
 * resolver-owned registrations and tool authority comes from tool contracts.
 *
 * @public
 */

import type { AuthorityRef } from "@agent-os/core/effect-claim";
import type {
  AgentSubmitBindings,
  SubmitReceiptBackedToolBinding,
  SubmitToolIntent,
} from "@agent-os/core/runtime-protocol";
import type {
  ExecutionDomain,
  ExecutionDomainDeclaration,
  ToolAccess,
  ToolExecution,
  ToolReplayWitness,
} from "@agent-os/core/tools";
import type { TelemetryFanoutDiagnostic } from "@agent-os/core/telemetry-protocol";
import type { LedgerEvent } from "@agent-os/core/types";
import type {
  CapabilityContract,
  CapabilityHostFactRequirement,
  HostProfile,
  HostProvidedFact,
  ResolvedRuntime,
} from "./capability";

export interface InspectionUnavailableSection {
  readonly status: "unavailable";
  readonly reason: string;
}

export interface InspectionManifestSummary {
  readonly host: string;
  readonly capabilities: ReadonlyArray<string>;
}

export interface InspectionCompileSection {
  readonly status: "available";
  readonly target: string;
  readonly manifest: InspectionManifestSummary;
}

export interface InspectionGraphRegistration {
  readonly kind: string;
  readonly capabilityId: string;
}

export interface InspectionHostFactStatus {
  readonly fact: HostProvidedFact;
  readonly status: "provided" | "missing";
  readonly requiredBy: ReadonlyArray<string>;
  readonly optionalFor: ReadonlyArray<string>;
}

export interface InspectionExecutionDomain {
  readonly kind: ExecutionDomain["kind"];
  readonly ref: string;
  readonly envAllowlist?: ReadonlyArray<string>;
}

export interface InspectionToolExecutionDeterministic {
  readonly kind: "deterministic";
}

export interface InspectionToolExecutionExternal {
  readonly kind: "external";
  readonly access: ToolAccess;
  readonly domain: InspectionExecutionDomain;
}

export type InspectionToolExecution =
  | InspectionToolExecutionDeterministic
  | InspectionToolExecutionExternal;

export interface InspectionToolAuthority {
  readonly authorityClass: string;
  readonly authorityId: string;
  readonly version?: string;
}

export interface InspectionToolBinding {
  readonly name: string;
  readonly toolId: string;
  readonly authority: InspectionToolAuthority;
  readonly execution: InspectionToolExecution;
  readonly receiptBackedIntentKinds: ReadonlyArray<string>;
}

export interface InspectionNamedBinding {
  readonly name: string;
}

export interface InspectionExecutionDomainReplayLaw {
  readonly access: ToolAccess;
  readonly witness: ToolReplayWitness;
}

export interface InspectionExecutionDomainBinding {
  readonly domain: InspectionExecutionDomain;
  readonly replay: InspectionExecutionDomainReplayLaw;
  readonly broker?: {
    readonly mode: "trusted_substitution";
    readonly materialKinds: ReadonlyArray<string>;
    readonly outboundBoundary: "domain-owner-defined";
  };
}

export interface InspectionToolIntentBinding {
  readonly kind: string;
  readonly boundaryOwnerId: string;
  readonly boundaryVersion: string;
}

export interface InspectionReceiptBackedToolBinding {
  readonly name: string;
  readonly kind: SubmitReceiptBackedToolBinding["kind"];
  readonly intentKinds: ReadonlyArray<string>;
}

export interface InspectionBindingSummary {
  readonly tools: ReadonlyArray<InspectionToolBinding>;
  readonly llmRoutes: ReadonlyArray<InspectionNamedBinding>;
  readonly materials: ReadonlyArray<InspectionNamedBinding>;
  readonly executionDomains: ReadonlyArray<InspectionExecutionDomainBinding>;
  readonly toolIntents: ReadonlyArray<InspectionToolIntentBinding>;
  readonly receiptBackedTools: ReadonlyArray<InspectionReceiptBackedToolBinding>;
}

export interface InspectionResolveSection {
  readonly status: "available";
  readonly hostFacts: ReadonlyArray<InspectionHostFactStatus>;
  readonly graph: {
    readonly handlers: ReadonlyArray<InspectionGraphRegistration>;
    readonly projections: ReadonlyArray<InspectionGraphRegistration>;
  };
  readonly bindings: InspectionBindingSummary;
}

export interface InspectionRuntimeSection {
  readonly status: "available";
  readonly events: ReadonlyArray<LedgerEvent>;
  readonly diagnostics: ReadonlyArray<TelemetryFanoutDiagnostic>;
}

export interface InspectionSnapshot {
  readonly compile: InspectionCompileSection | InspectionUnavailableSection;
  readonly resolve: InspectionResolveSection | InspectionUnavailableSection;
  readonly runtime: InspectionRuntimeSection | InspectionUnavailableSection;
}

export interface ProjectInspectionSnapshotInput {
  readonly resolved: ResolvedRuntime;
  readonly host: HostProfile;
  readonly capabilities: ReadonlyArray<CapabilityContract>;
  readonly runtime?: InspectionRuntimeSection;
}

const byString =
  <Value>(select: (value: Value) => string) =>
  (left: Value, right: Value): number =>
    select(left).localeCompare(select(right));

const sortedStrings = (values: Iterable<string>): ReadonlyArray<string> =>
  Array.from(values).sort((left, right) => left.localeCompare(right));

const cloneAuthority = (authority: AuthorityRef): InspectionToolAuthority => ({
  authorityClass: authority.authorityClass,
  authorityId: authority.authorityId,
  ...(authority.version === undefined ? {} : { version: authority.version }),
});

const cloneDomain = (domain: ExecutionDomain): InspectionExecutionDomain => ({
  kind: domain.kind,
  ref: domain.ref,
  ...(domain.envAllowlist === undefined ? {} : { envAllowlist: [...domain.envAllowlist] }),
});

const cloneExecution = (execution: ToolExecution): InspectionToolExecution =>
  execution.kind === "deterministic"
    ? { kind: "deterministic" }
    : {
        kind: "external",
        access: execution.access,
        domain: cloneDomain(execution.domain),
      };

const normalizeHostFactRequirement = (
  requirement: HostProvidedFact | CapabilityHostFactRequirement,
): CapabilityHostFactRequirement =>
  typeof requirement === "string" ? { fact: requirement, optional: false } : requirement;

const hostFactStatuses = (
  host: HostProfile,
  capabilities: ReadonlyArray<CapabilityContract>,
): ReadonlyArray<InspectionHostFactStatus> => {
  const records = new Map<
    HostProvidedFact,
    {
      readonly fact: HostProvidedFact;
      readonly requiredBy: Set<string>;
      readonly optionalFor: Set<string>;
    }
  >();
  const ensure = (fact: HostProvidedFact) => {
    const existing = records.get(fact);
    if (existing !== undefined) return existing;
    const created = { fact, requiredBy: new Set<string>(), optionalFor: new Set<string>() };
    records.set(fact, created);
    return created;
  };

  for (const fact of host.provides) {
    ensure(fact);
  }
  for (const capability of capabilities) {
    for (const requirement of capability.requires.hostFacts ?? []) {
      const normalized = normalizeHostFactRequirement(requirement);
      const record = ensure(normalized.fact);
      if (normalized.optional === true) {
        record.optionalFor.add(capability.capabilityId);
      } else {
        record.requiredBy.add(capability.capabilityId);
      }
    }
  }

  return Array.from(records.values())
    .map((record) => ({
      fact: record.fact,
      status: host.provides.has(record.fact) ? ("provided" as const) : ("missing" as const),
      requiredBy: sortedStrings(record.requiredBy),
      optionalFor: sortedStrings(record.optionalFor),
    }))
    .sort(byString((record) => record.fact));
};

const graphRegistrations = (
  registrations: ReadonlyMap<string, InspectionGraphRegistration>,
): ReadonlyArray<InspectionGraphRegistration> =>
  Array.from(registrations.values())
    .map((registration) => ({
      kind: registration.kind,
      capabilityId: registration.capabilityId,
    }))
    .sort(byString((registration) => registration.kind));

const namedBindings = (record: Readonly<Record<string, unknown>> | undefined) =>
  Object.keys(record ?? {})
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name }));

const receiptBackedIntentKinds = (
  receiptBackedTools: AgentSubmitBindings["receiptBackedTools"],
  name: string,
): ReadonlyArray<string> => sortedStrings(receiptBackedTools?.[name]?.intentKinds ?? []);

const toolBindings = (bindings: AgentSubmitBindings): ReadonlyArray<InspectionToolBinding> =>
  Object.entries(bindings.tools ?? {})
    .map(([name, tool]) => ({
      name,
      toolId: tool.contract.toolId,
      authority: cloneAuthority(tool.contract.effectAuthorityRef),
      execution: cloneExecution(tool.execution),
      receiptBackedIntentKinds: receiptBackedIntentKinds(bindings.receiptBackedTools, name),
    }))
    .sort(byString((binding) => binding.name));

const executionDomainBindings = (
  domains: ReadonlyArray<ExecutionDomainDeclaration> | undefined,
): ReadonlyArray<InspectionExecutionDomainBinding> =>
  [...(domains ?? [])]
    .map((declaration) => ({
      domain: cloneDomain(declaration.domain),
      replay: {
        access: declaration.replay.access,
        witness: declaration.replay.witness,
      },
      ...(declaration.broker === undefined
        ? {}
        : {
            broker: {
              mode: declaration.broker.mode,
              materialKinds: [...declaration.broker.materialKinds],
              outboundBoundary: declaration.broker.outboundBoundary,
            },
          }),
    }))
    .sort(
      byString(
        (binding) => `${binding.domain.kind}:${binding.domain.ref}:${binding.replay.access}`,
      ),
    );

const toolIntentBindings = (
  intents: ReadonlyArray<SubmitToolIntent> | undefined,
): ReadonlyArray<InspectionToolIntentBinding> =>
  [...(intents ?? [])]
    .map((intent) => ({
      kind: intent.kind,
      boundaryOwnerId: intent.boundaryModule.manifest.ownerId,
      boundaryVersion: intent.boundaryModule.manifest.version,
    }))
    .sort(byString((intent) => intent.kind));

const receiptBackedToolBindings = (
  tools: AgentSubmitBindings["receiptBackedTools"],
): ReadonlyArray<InspectionReceiptBackedToolBinding> =>
  Object.entries(tools ?? {})
    .map(([name, binding]) => ({
      name,
      kind: binding.kind,
      intentKinds: sortedStrings(binding.intentKinds),
    }))
    .sort(byString((binding) => binding.name));

const bindingSummary = (bindings: AgentSubmitBindings): InspectionBindingSummary => ({
  tools: toolBindings(bindings),
  llmRoutes: namedBindings(bindings.llmRoutes),
  materials: namedBindings(bindings.materials),
  executionDomains: executionDomainBindings(bindings.executionDomains),
  toolIntents: toolIntentBindings(bindings.toolIntents),
  receiptBackedTools: receiptBackedToolBindings(bindings.receiptBackedTools),
});

export const projectInspectionSnapshot = (
  input: ProjectInspectionSnapshotInput,
): InspectionSnapshot => {
  const manifest: InspectionManifestSummary = {
    host: input.resolved.manifest.host,
    capabilities: [...input.resolved.manifest.capabilities],
  };
  return {
    compile: {
      status: "available",
      target: input.resolved.manifest.host,
      manifest,
    },
    resolve: {
      status: "available",
      hostFacts: hostFactStatuses(input.host, input.capabilities),
      graph: {
        handlers: graphRegistrations(input.resolved.installGraph.graphStatus.handlers),
        projections: graphRegistrations(input.resolved.installGraph.graphStatus.projections),
      },
      bindings: bindingSummary(input.resolved.bindings),
    },
    runtime: input.runtime ?? {
      status: "unavailable",
      reason: "runtime inspection was not requested",
    },
  };
};
