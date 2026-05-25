import type { JsonSchemaObject } from "@agent-os/core";

export const PLAN_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["jobs"],
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["prompt", "size", "credits"],
        properties: {
          prompt: { type: "string" },
          size: { type: "string", enum: ["1024x1024"] },
          credits: { type: "number" },
        },
      },
    },
  },
};

export interface PlanJob {
  readonly prompt: string;
  readonly size: "1024x1024";
  readonly credits: number;
}

export interface ImagePlan {
  readonly jobs: ReadonlyArray<PlanJob>;
}
