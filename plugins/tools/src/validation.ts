import { Ajv2020 } from "ajv/dist/2020.js";
import { toolSchemas } from "../definitions/manifest.js";

const ajv = new Ajv2020({ strict: true });
const schemas = new Map(
  Object.entries(toolSchemas).map(([name, schema]) => [name, ajv.compile(schema)]),
);
export function validateToolShape(name: string, value: unknown, code: string): void {
  if (!schemas.get(name)?.(value)) throw Object.assign(new Error(code), { code });
}
