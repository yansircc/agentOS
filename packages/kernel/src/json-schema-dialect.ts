/**
 * Closed JSON Schema dialect + validator.
 *
 * Kernel owns the dialect because app-authored tools live in kernel and must
 * derive OpenAI tool parameters without depending on runtime. Runtime imports
 * this module for structured-output validation and fingerprinting.
 */

import { Option, Predicate } from "effect";

export type JsonSchemaObject = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean;
};

export type JsonSchemaNode =
  | { readonly type: "string"; readonly enum?: ReadonlyArray<string>; readonly pattern?: string }
  | { readonly type: "number" }
  | { readonly type: "boolean" }
  | { readonly type: "array"; readonly items: JsonSchemaNode }
  | { readonly anyOf: ReadonlyArray<JsonSchemaNode> }
  | JsonSchemaObject;

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

export type JsonSchemaDialectIssue = {
  readonly path: string;
  readonly issue: string;
};

export type JsonSchemaResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly issues: ReadonlyArray<JsonSchemaDialectIssue> };

const reject = (path: string, issue: string): never =>
  Option.getOrThrowWith(Option.none(), () => new JsonSchemaDialectError(path, issue));

const ANNOTATION_KEYS = new Set(["title", "description", "default", "examples", "$comment"]);
const ROOT_ANNOTATION_KEYS = new Set([...ANNOTATION_KEYS, "$schema", "$id"]);

const ok = <A>(value: A): JsonSchemaResult<A> => ({ ok: true, value });

const fail = <A>(path: string, issue: string): JsonSchemaResult<A> => ({
  ok: false,
  issues: [{ path, issue }],
});

const failFrom = <A>(
  result: Extract<JsonSchemaResult<unknown>, { ok: false }>,
): JsonSchemaResult<A> => result;

const firstUnsupportedKey = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): JsonSchemaDialectIssue | undefined => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && !key.startsWith("x-")) {
      return { path: `${path}.${key}`, issue: "unsupported-key" };
    }
  }
  return undefined;
};

const optionalStringArray = (
  value: unknown,
  path: string,
): JsonSchemaResult<ReadonlyArray<string> | undefined> => {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return fail(path, "expected-string-array");
  }
  return ok(value as ReadonlyArray<string>);
};

export const parseDialectNodeResult = (
  value: unknown,
  path = "$",
): JsonSchemaResult<JsonSchemaNode> => {
  const schema = Predicate.isRecord(value) ? value : undefined;
  if (schema === undefined) return fail(path, "expected-object");
  if (schema.anyOf !== undefined) {
    const unsupportedKey = firstUnsupportedKey(
      schema,
      new Set(["anyOf", ...(path === "$" ? ROOT_ANNOTATION_KEYS : ANNOTATION_KEYS)]),
      path,
    );
    if (unsupportedKey !== undefined) return { ok: false, issues: [unsupportedKey] };
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      return fail(`${path}.anyOf`, "expected-non-empty-array");
    }
    const variants: JsonSchemaNode[] = [];
    for (const [index, variant] of schema.anyOf.entries()) {
      const closedVariant = parseDialectNodeResult(variant, `${path}.anyOf.${index}`);
      if (!closedVariant.ok) return failFrom(closedVariant);
      variants.push(closedVariant.value);
    }
    return ok({ anyOf: variants });
  }
  const type = schema.type;
  switch (type) {
    case "object": {
      const unsupportedKey = firstUnsupportedKey(
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
      if (unsupportedKey !== undefined) return { ok: false, issues: [unsupportedKey] };
      const rawProperties = schema.properties;
      if (!Predicate.isRecord(rawProperties)) return fail(`${path}.properties`, "expected-object");
      const properties: Record<string, JsonSchemaNode> = {};
      for (const [key, node] of Object.entries(rawProperties)) {
        const property = parseDialectNodeResult(node, `${path}.properties.${key}`);
        if (!property.ok) return failFrom(property);
        properties[key] = property.value;
      }
      const required = optionalStringArray(schema.required, `${path}.required`);
      if (!required.ok) return failFrom(required);
      const rawAdditionalProperties = schema.additionalProperties;
      if (rawAdditionalProperties !== undefined && typeof rawAdditionalProperties !== "boolean") {
        return fail(`${path}.additionalProperties`, "expected-boolean");
      }
      const additionalProperties = rawAdditionalProperties as boolean | undefined;
      const objectNode: JsonSchemaObject = {
        type: "object",
        properties,
        ...(required.value === undefined ? {} : { required: required.value }),
        ...(additionalProperties === undefined ? {} : { additionalProperties }),
      };
      return ok(objectNode);
    }
    case "array": {
      const unsupportedKey = firstUnsupportedKey(
        schema,
        new Set(["type", "items", ...ANNOTATION_KEYS]),
        path,
      );
      if (unsupportedKey !== undefined) return { ok: false, issues: [unsupportedKey] };
      if (schema.items === undefined) return fail(`${path}.items`, "missing");
      const items = parseDialectNodeResult(schema.items, `${path}.items`);
      if (!items.ok) return failFrom(items);
      return ok({ type: "array", items: items.value });
    }
    case "string": {
      const unsupportedKey = firstUnsupportedKey(
        schema,
        new Set(["type", "enum", "pattern", ...ANNOTATION_KEYS]),
        path,
      );
      if (unsupportedKey !== undefined) return { ok: false, issues: [unsupportedKey] };
      const enumeration = optionalStringArray(schema.enum, `${path}.enum`);
      if (!enumeration.ok) return failFrom(enumeration);
      const pattern = schema.pattern;
      if (pattern !== undefined) {
        if (typeof pattern !== "string") return fail(`${path}.pattern`, "expected-string");
        try {
          new RegExp(pattern);
        } catch {
          return fail(`${path}.pattern`, "invalid-regex");
        }
      }
      return ok({
        type: "string",
        ...(enumeration.value === undefined ? {} : { enum: enumeration.value }),
        ...(pattern === undefined ? {} : { pattern }),
      });
    }
    case "number": {
      const unsupportedKey = firstUnsupportedKey(
        schema,
        new Set(["type", ...ANNOTATION_KEYS]),
        path,
      );
      if (unsupportedKey !== undefined) return { ok: false, issues: [unsupportedKey] };
      return ok({ type: "number" });
    }
    case "boolean": {
      const unsupportedKey = firstUnsupportedKey(
        schema,
        new Set(["type", ...ANNOTATION_KEYS]),
        path,
      );
      if (unsupportedKey !== undefined) return { ok: false, issues: [unsupportedKey] };
      return ok({ type: "boolean" });
    }
    default:
      return fail(`${path}.type`, "unsupported");
  }
};

export const parseDialectNode = (value: unknown, path = "$"): JsonSchemaNode => {
  const result = parseDialectNodeResult(value, path);
  if (!result.ok) {
    const issue = result.issues[0] ?? { path, issue: "invalid" };
    return reject(issue.path, issue.issue);
  }
  return result.value;
};

export const parseDialectObjectResult = (value: unknown): JsonSchemaResult<JsonSchemaObject> => {
  const result = parseDialectNodeResult(value);
  if (!result.ok) return failFrom(result);
  if (!("type" in result.value) || result.value.type !== "object") {
    return fail("$.type", "root-must-be-object");
  }
  return ok(result.value as JsonSchemaObject);
};

export const parseDialectObject = (value: unknown): JsonSchemaObject => {
  const result = parseDialectObjectResult(value);
  if (!result.ok) {
    const issue = result.issues[0] ?? { path: "$", issue: "invalid" };
    return reject(issue.path, issue.issue);
  }
  return result.value;
};

export const validateAgainstSchema = (value: unknown, schema: JsonSchemaNode): string[] => {
  const violations: string[] = [];
  const walk = (v: unknown, s: JsonSchemaNode, path: string): void => {
    if ("anyOf" in s) {
      const matched = s.anyOf.some((variant) => {
        const nested: string[] = [];
        const previousLength = violations.length;
        walk(v, variant, path);
        nested.push(...violations.splice(previousLength));
        return nested.length === 0;
      });
      if (!matched) violations.push(`${path}:not-any-of`);
    } else if (s.type === "object") {
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
      else {
        if (s.pattern !== undefined && !new RegExp(s.pattern).test(v)) {
          violations.push(`${path}:pattern`);
        }
        if (s.enum && !s.enum.includes(v)) violations.push(`${path}:not-in-enum`);
      }
    } else if (s.type === "number") {
      if (typeof v !== "number") violations.push(`${path}:not-number`);
    } else if (s.type === "boolean") {
      if (typeof v !== "boolean") violations.push(`${path}:not-boolean`);
    }
  };
  walk(value, schema, "$");
  return violations;
};
