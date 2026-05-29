/**
 * Closed JSON Schema dialect + validator.
 *
 * Kernel owns the dialect because app-authored tools live in kernel and must
 * derive OpenAI tool parameters without depending on runtime. Runtime imports
 * this module for structured-output validation and fingerprinting.
 */

import { Option } from "effect";

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
  readonly fingerprint: string;
};

export class JsonSchemaDialectError extends Error {
  readonly path: string;
  readonly issue: string;

  constructor(path: string, issue: string) {
    super(`${path}:${issue}`);
    this.name = "JsonSchemaDialectError";
    this.path = path;
    this.issue = issue;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const reject = (path: string, issue: string): never =>
  Option.getOrThrowWith(Option.none(), () => new JsonSchemaDialectError(path, issue));

const ANNOTATION_KEYS = new Set(["title", "description", "default", "examples", "$comment"]);
const ROOT_ANNOTATION_KEYS = new Set([...ANNOTATION_KEYS, "$schema"]);

const assertAllowedKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && !key.startsWith("x-")) {
      reject(`${path}.${key}`, "unsupported-key");
    }
  }
};

const optionalStringArray = (value: unknown, path: string): ReadonlyArray<string> | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    reject(path, "expected-string-array");
  }
  return value as ReadonlyArray<string>;
};

export const toClosedJsonSchemaNode = (value: unknown, path = "$"): JsonSchemaNode => {
  const schema = isRecord(value) ? value : reject(path, "expected-object");
  const type = schema.type;
  switch (type) {
    case "object": {
      assertAllowedKeys(
        schema,
        new Set([
          "type",
          "properties",
          "required",
          "additionalProperties",
          ...(path === "$" ? ROOT_ANNOTATION_KEYS : ANNOTATION_KEYS),
        ]),
        path,
      );
      const rawProperties = schema.properties;
      const propertiesRecord = isRecord(rawProperties)
        ? rawProperties
        : reject(`${path}.properties`, "expected-object");
      const properties: Record<string, JsonSchemaNode> = {};
      for (const [key, node] of Object.entries(propertiesRecord)) {
        properties[key] = toClosedJsonSchemaNode(node, `${path}.properties.${key}`);
      }
      const required = optionalStringArray(schema.required, `${path}.required`);
      const rawAdditionalProperties = schema.additionalProperties;
      if (rawAdditionalProperties !== undefined && typeof rawAdditionalProperties !== "boolean") {
        reject(`${path}.additionalProperties`, "expected-boolean");
      }
      const additionalProperties = rawAdditionalProperties as boolean | undefined;
      const objectNode: JsonSchemaObject = {
        type: "object",
        properties,
        ...(required === undefined ? {} : { required }),
        ...(additionalProperties === undefined ? {} : { additionalProperties }),
      };
      return objectNode;
    }
    case "array":
      assertAllowedKeys(schema, new Set(["type", "items", ...ANNOTATION_KEYS]), path);
      if (schema.items === undefined) reject(`${path}.items`, "missing");
      return { type: "array", items: toClosedJsonSchemaNode(schema.items, `${path}.items`) };
    case "string": {
      assertAllowedKeys(schema, new Set(["type", "enum", ...ANNOTATION_KEYS]), path);
      const enumeration = optionalStringArray(schema.enum, `${path}.enum`);
      return { type: "string", ...(enumeration === undefined ? {} : { enum: enumeration }) };
    }
    case "number":
      assertAllowedKeys(schema, new Set(["type", ...ANNOTATION_KEYS]), path);
      return { type: "number" };
    case "boolean":
      assertAllowedKeys(schema, new Set(["type", ...ANNOTATION_KEYS]), path);
      return { type: "boolean" };
    default:
      return reject(`${path}.type`, "unsupported");
  }
};

export const toClosedJsonSchemaObject = (value: unknown): JsonSchemaObject => {
  const node = toClosedJsonSchemaNode(value);
  if (node.type !== "object") {
    reject("$.type", "root-must-be-object");
  }
  return node as JsonSchemaObject;
};

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
