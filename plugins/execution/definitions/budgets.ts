import type { JsonSchema } from "../../../packages/abi/src/index.js";
import { error, object, objectRef } from "./schemas.js";

const string = { type: "string", minLength: 1 };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export const budgetSchemas: Readonly<Record<string, JsonSchema>> = {
  BudgetScope: object({
    budgetId: string,
    parentId: { type: ["string", "null"] },
    spec: object({
      unit: string,
      limit: integer,
      maxSteps: integer,
      maxDepth: integer,
      maxConcurrentEffects: integer,
    }),
    entries: {
      type: "array",
      items: object({ reservation: objectRef, attempt: objectRef }),
      maxItems: 10000,
    },
    stepIds: { type: "array", items: string, uniqueItems: true, maxItems: 10000 },
    blockedError: { anyOf: [error, { type: "null" }] },
  }),
  UsageAnomaly: object({ reservation: objectRef, actual: {}, evidence: {}, error }),
};
