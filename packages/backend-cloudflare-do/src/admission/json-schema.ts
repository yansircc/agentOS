/**
 * JSON Schema types + local validator.
 *
 * Leaf module: imports nothing from `../admission` (sibling files) or
 * `../protocol`. Both the protocol wire adapters (decodeStructured) and
 * admission's fingerprint algebra reach into this file directly:
 *   - protocol/shared.ts → validateAgainstSchema (value)
 *   - admission/fingerprint.ts → JsonSchemaObject (type)
 *   - admission/index.ts → re-exports the type surface for apps
 *
 * Why types AND validator co-live: the validator's closed-dialect walk
 * is a 1:1 implementation of the closed JsonSchemaNode union. Splitting
 * them invites drift — adding a new node kind to the union would no
 * longer light up the validator at compile time.
 */

export type JsonSchemaObject = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean;
};

export type JsonSchemaNode =
  | { readonly type: "string"; readonly enum?: ReadonlyArray<string> }
  | { readonly type: "number" }
  | { readonly type: "boolean" }
  | { readonly type: "array"; readonly items: JsonSchemaNode }
  | JsonSchemaObject;

export type SchemaContract = {
  readonly schema: JsonSchemaObject;
  readonly fingerprint: string; // §4.1: "<algoVer>:sha256:<hex>"
};

/** Local JSON Schema validator. Closed-dialect subset matching the
 *  `JsonSchemaNode` union: object (with required/additionalProperties),
 *  array (with items), string (with enum), number, boolean. Used by every
 *  wire adapter's `decodeStructured` to enforce the schema after the
 *  model's tool-call arguments parse. Adapters apply wire-specific
 *  stripping when ENCODING (e.g. Gemini strips `additionalProperties`),
 *  but DECODING validates the FULL schema locally so apps still get the
 *  contract they declared. */
export const validateAgainstSchema = (value: unknown, schema: JsonSchemaNode): string[] => {
  const violations: string[] = [];
  const walk = (v: unknown, s: JsonSchemaNode, path: string): void => {
    if (s.type === "object") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        violations.push(`${path}:not-object`);
        return;
      }
      const obj = v as Record<string, unknown>;
      for (const req of s.required ?? []) {
        if (!(req in obj)) violations.push(`${path}.${req}:missing`);
      }
      if (s.additionalProperties === false) {
        for (const k of Object.keys(obj)) {
          if (!(k in s.properties)) {
            violations.push(`${path}.${k}:unknown-property`);
          }
        }
      }
      for (const [k, sub] of Object.entries(s.properties)) {
        if (k in obj) walk(obj[k], sub, `${path}.${k}`);
      }
    } else if (s.type === "array") {
      if (!Array.isArray(v)) {
        violations.push(`${path}:not-array`);
        return;
      }
      v.forEach((item, i) => walk(item, s.items, `${path}[${i}]`));
    } else if (s.type === "string") {
      if (typeof v !== "string") violations.push(`${path}:not-string`);
      else if (s.enum && !s.enum.includes(v)) violations.push(`${path}:not-in-enum`);
    } else if (s.type === "number") {
      if (typeof v !== "number") violations.push(`${path}:not-number`);
    } else if (s.type === "boolean") {
      if (typeof v !== "boolean") violations.push(`${path}:not-boolean`);
    }
  };
  walk(value, schema, "$");
  return violations;
};
