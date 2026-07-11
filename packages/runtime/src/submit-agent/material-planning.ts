import { Effect } from "effect";
import { ToolError } from "@agent-os/core/errors";
import {
  isMaterialRef,
  materialRefKey,
  materialRefSatisfiesRequirement,
  type MaterialRef,
} from "@agent-os/core/material-ref";
import { openLive } from "@agent-os/core/live-edge";
import type {
  RefResolutionFailed,
  MaterialResolutionReceipt,
  MaterialResolutionRequest,
  ResolvedMaterial,
  ResolvedMaterialService,
} from "@agent-os/core/ref-resolver";
import {
  planMaterialBrokerSubstitution,
  type MaterialBrokerReceipt,
  type MaterialBrokerSubstitutionIssue,
  type ResolvedToolExecution,
  type ResolvedToolMaterials,
  type Tool,
} from "@agent-os/core/tools";
import type { RejectionRef } from "@agent-os/core/effect-claim";
import type { InternalSubmitSpec } from "../internal-submit";

export const materialRejection = (
  claim: { readonly operationRef: string },
  reason: string,
  kind: RejectionRef["rejectionKind"] = "resource_denied",
): RejectionRef => ({
  rejectionId: claim.operationRef,
  rejectionKind: kind,
  reason,
});

export interface LocalToolMaterialRef {
  readonly slot: string;
  readonly ref: MaterialRef;
}

export interface RuntimeToolMaterialPlan {
  readonly materials: ResolvedToolMaterials;
  readonly localRefs: ReadonlyArray<LocalToolMaterialRef>;
  readonly brokerReceipts: ReadonlyArray<MaterialBrokerReceipt>;
}

export const materialBrokerIssueLabel = (issue: MaterialBrokerSubstitutionIssue): string => {
  switch (issue.kind) {
    case "invalid_registry":
      return "invalid_registry";
    case "invalid_material_ref":
      return "invalid_material_ref";
    case "invalid_material_requirement":
      return "invalid_material_requirement";
    case "missing_broker_declaration":
      return `missing_broker:${issue.domain.kind}:${issue.domain.ref}`;
    case "unsupported_material_kind":
      return `unsupported_kind:${issue.materialKind}`;
    case "requirement_mismatch":
      return `requirement_mismatch:${materialRefKey(issue.materialRef)}`;
  }
};

export const planToolMaterials = (
  spec: InternalSubmitSpec,
  tool: Tool,
  claim: { readonly operationRef: string },
  resolvedExecution: ResolvedToolExecution,
):
  | {
      readonly ok: true;
      readonly plan: RuntimeToolMaterialPlan;
    }
  | {
      readonly ok: false;
      readonly rejectionRef: RejectionRef;
    } => {
  const materials: Record<string, ResolvedMaterial> = {};
  const localRefs: LocalToolMaterialRef[] = [];
  const brokerReceipts: MaterialBrokerReceipt[] = [];

  for (const requirement of tool.contract.requiredMaterials) {
    const ref = spec.materials?.[requirement.slot];
    if (ref === undefined) {
      if (requirement.required) {
        return {
          ok: false,
          rejectionRef: materialRejection(
            claim,
            `material_missing:${requirement.slot}`,
            "resource_denied",
          ),
        };
      }
      continue;
    }
    if (!isMaterialRef(ref)) {
      return {
        ok: false,
        rejectionRef: materialRejection(
          claim,
          `material_invalid:${requirement.slot}`,
          "validation_failed",
        ),
      };
    }
    if (!materialRefSatisfiesRequirement(ref, requirement)) {
      return {
        ok: false,
        rejectionRef: materialRejection(
          claim,
          `material_invalid:${requirement.slot}:${materialRefKey(ref)}`,
          "validation_failed",
        ),
      };
    }
    if (resolvedExecution.kind === "external") {
      const brokerPlan = planMaterialBrokerSubstitution({
        registry: { domains: spec.executionDomains ?? [] },
        domain: resolvedExecution.execution.domain,
        materialRef: ref,
        requirement,
      });
      if (!brokerPlan.ok) {
        return {
          ok: false,
          rejectionRef: materialRejection(
            claim,
            `material_broker_unavailable:${requirement.slot}:${brokerPlan.issues.map(materialBrokerIssueLabel).join(",")}`,
            "resource_denied",
          ),
        };
      }
      materials[requirement.slot] = brokerPlan.plan.placeholder;
      brokerReceipts.push(brokerPlan.plan.receipt);
    } else {
      localRefs.push({ slot: requirement.slot, ref });
    }
  }
  return { ok: true, plan: { materials, localRefs, brokerReceipts } };
};

export const materialResolutionToolError = (
  toolName: string,
  material: LocalToolMaterialRef,
  failure: RefResolutionFailed,
): ToolError =>
  new ToolError({
    toolName,
    cause: {
      reason:
        failure.reason === "resolver_failed" ? "material_resolution_failed" : "material_unresolved",
      slot: material.slot,
      ref: materialRefKey(material.ref),
    },
  });

export const withLocalResolvedToolMaterials = <A, E, R, E2, R2>(
  refs: ResolvedMaterialService,
  resolution: {
    readonly request: (ref: MaterialRef) => MaterialResolutionRequest;
    readonly onResolved: (receipt: MaterialResolutionReceipt) => Effect.Effect<void, E2, R2>;
  },
  toolName: string,
  localRefs: ReadonlyArray<LocalToolMaterialRef>,
  use: (materials: ResolvedToolMaterials) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | E2 | ToolError, R | R2> => {
  const loop = (
    index: number,
    materials: Record<string, ResolvedMaterial>,
  ): Effect.Effect<A, E | E2 | ToolError, R | R2> => {
    const local = localRefs[index];
    if (local === undefined) return use(materials);
    return Effect.acquireUseRelease(
      refs.material(resolution.request(local.ref)).pipe(
        Effect.mapError((failure) => materialResolutionToolError(toolName, local, failure)),
        Effect.tap((handle) =>
          resolution.onResolved({ materialRef: handle.ref, version: handle.version }),
        ),
      ),
      (handle) => loop(index + 1, { ...materials, [local.slot]: openLive(handle.value) }),
      (handle) => handle.dispose(),
    );
  };
  return loop(0, {});
};
