import { Ajv2020 } from "ajv/dist/2020.js";
import { modelSchemas } from "../definitions/manifest.js";

const ajv = new Ajv2020({ strict: true, allErrors: false });
const schemas = new Map(
  Object.entries(modelSchemas).map(([name, schema]) => [name, ajv.compile(schema)]),
);
export function validateModelShape(name: string, value: unknown, code: string): void {
  if (!schemas.get(name)?.(value)) throw Object.assign(new Error(code), { code });
}
