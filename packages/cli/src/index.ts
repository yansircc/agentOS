import {
  compileAgentTree as compileAgentTreeImpl,
  linkWorkspaceStaticTarget as linkWorkspaceStaticTargetImpl,
} from "./build/agent-authoring";

/**
 * Compile an authored `agent/` tree into one normalized manifest plus
 * provenance. Runtime facts and provider material are rejected before they can
 * become manifest truth.
 *
 * @agentosPrimitive primitive.agent-authoring.compileAgentTree
 * @agentosInvariant invariant.docs.agent-projection
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/guides/build-natural-language-workspace-agent.md
 * @public
 */
export const compileAgentTree = compileAgentTreeImpl;

/**
 * Link normalized workspace authoring intent to a closed-target residual
 * program. Implementation wiring is static imports and factory composition;
 * manifest and deployment JSON remain semantic/provenance data only.
 *
 * @agentosPrimitive primitive.agent-authoring.linkWorkspaceStaticTarget
 * @agentosInvariant invariant.docs.agent-projection
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/guides/build-natural-language-workspace-agent.md
 * @public
 */
export const linkWorkspaceStaticTarget = linkWorkspaceStaticTargetImpl;
