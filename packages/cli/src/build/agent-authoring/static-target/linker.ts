import type { StaticTargetLinkResult, StaticTargetPlanResult } from "./model";
import { renderStaticTargetPlan } from "./artifacts";

/** Convert one closed plan result to one rendered residual program. */
export const linkStaticTargetPlan = (planned: StaticTargetPlanResult): StaticTargetLinkResult =>
  planned.ok ? { ok: true, value: renderStaticTargetPlan(planned.value) } : planned;
