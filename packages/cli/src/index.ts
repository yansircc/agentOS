import {
  compileProductPlan as compileProductPlanImpl,
  linkStaticTarget as linkStaticTargetImpl,
} from "./build/agent-authoring";

/**
 * Compile closed authored product facts into one backend-neutral ProductPlan.
 *
 * @agentosPrimitive primitive.agent-authoring.compileProductPlan
 * @agentosInvariant invariant.docs.agent-projection
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/guides/quickstart-node.md
 * @public
 */
export const compileProductPlan = compileProductPlanImpl;

/**
 * Bind one ProductPlan to an explicit local host or deployment intent and
 * render the resulting closed static target.
 *
 * @agentosPrimitive primitive.agent-authoring.linkStaticTarget
 * @agentosInvariant invariant.docs.agent-projection
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/guides/quickstart-node.md
 * @public
 */
export const linkStaticTarget = linkStaticTargetImpl;
