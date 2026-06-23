import { describe } from "@effect/vitest";
import { registerSubmitAgentReplayCases } from "./_submit-agent-replay-cases";
import { registerSubmitAgentToolBoundaryCases } from "./_submit-agent-tool-boundary-cases";
import { registerSubmitAgentProviderHistoryCases } from "./_submit-agent-provider-history-cases";
import { registerSubmitAgentRuntimePolicyRequiredCases } from "./_submit-agent-runtime-policy-required-cases";
import { registerSubmitAgentRuntimePolicyCompleteCases } from "./_submit-agent-runtime-policy-complete-cases";
import { registerSubmitAgentRuntimeFactsCases } from "./_submit-agent-runtime-facts-cases";
import { registerSubmitAgentMaterialCases } from "./_submit-agent-material-cases";
import { registerSubmitAgentInterruptResumeCases } from "./_submit-agent-interrupt-resume-cases";

describe("submit-agent runtime event writes", () => {
  registerSubmitAgentReplayCases();
  registerSubmitAgentToolBoundaryCases();
  registerSubmitAgentProviderHistoryCases();
  registerSubmitAgentRuntimePolicyRequiredCases();
  registerSubmitAgentRuntimePolicyCompleteCases();
  registerSubmitAgentRuntimeFactsCases();
  registerSubmitAgentMaterialCases();
  registerSubmitAgentInterruptResumeCases();
});
