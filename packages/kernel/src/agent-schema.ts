import { Effect, JSONSchema, Option, Schema, SchemaAST } from "effect";

import {
  parseDialectObject,
  validateAgainstSchema,
  type JsonSchemaNode,
  type JsonSchemaObject,
} from "./json-schema-dialect";

export const AGENT_SCHEMA_FINGERPRINT_VERSION = "agent-schema-v1";
const AGENT_SCHEMA_BRAND = Symbol("@agent-os/kernel/AgentSchema");

export type AgentSchemaIssue = {
  readonly path: string;
  readonly issue: string;
};

export class AgentSchemaProfileError extends Error {
  readonly issues: ReadonlyArray<AgentSchemaIssue>;

  constructor(issues: ReadonlyArray<AgentSchemaIssue>) {
    super(issues.map((issue) => `${issue.path}:${issue.issue}`).join(", "));
    this.name = "AgentSchemaProfileError";
    this.issues = issues;
  }
}

class AgentSchemaDecodeError extends Error {
  readonly issues: ReadonlyArray<AgentSchemaIssue>;

  constructor(issues: ReadonlyArray<AgentSchemaIssue>) {
    super(issues.map((issue) => `${issue.path}:${issue.issue}`).join(", "));
    this.name = "AgentSchemaDecodeError";
    this.issues = issues;
  }
}

export type AgentSchema<A = unknown> = {
  readonly [AGENT_SCHEMA_BRAND]: true;
  readonly source: Schema.Schema.AnyNoContext;
  readonly jsonSchema: JsonSchemaObject;
  readonly fingerprint: Effect.Effect<string>;
  readonly decode: (value: unknown) => A;
  readonly projections: AgentSchemaProjections;
};

export type AnyAgentSchema = AgentSchema<unknown>;

export type AgentSchemaSource<A = unknown, I = unknown> =
  | AgentSchema<A>
  | Schema.Schema<A, I, never>;

export type AnyAgentSchemaSource = AnyAgentSchema | Schema.Schema.AnyNoContext;

export type AgentSchemaSpec<A = unknown> = {
  readonly agentSchema: AgentSchema<A>;
  readonly fingerprint: string;
};

export type AgentSchemaProjections = {
  readonly canonical: JsonSchemaObject;
  readonly openai: JsonSchemaObject;
  readonly anthropic: JsonSchemaObject;
  readonly gemini: JsonSchemaObject;
  readonly agUi: JsonSchemaObject;
};

const SET_SEMANTICS_ARRAYS = new Set(["required", "enum"]);
const STRIP_FINGERPRINT_KEYS = new Set([
  "$schema",
  "title",
  "description",
  "examples",
  "default",
  "$comment",
]);
const GEMINI_STRIPPED_SCHEMA_FIELDS = new Set(["additionalProperties", "$schema", "$id", "$ref"]);

const unsupportedAnnotationIds = [
  { id: SchemaAST.BrandAnnotationId, issue: "brand-unsupported" },
  { id: SchemaAST.DefaultAnnotationId, issue: "default-unsupported" },
  { id: SchemaAST.JSONSchemaAnnotationId, issue: "raw-json-schema-annotation-unsupported" },
  { id: SchemaAST.DecodingFallbackAnnotationId, issue: "decoding-fallback-unsupported" },
] as const;

const hasAnnotation = (ast: SchemaAST.Annotated, id: symbol): boolean =>
  Option.isSome(SchemaAST.getAnnotation(ast, id));

const annotationIssues = (
  ast: SchemaAST.Annotated,
  path: string,
): ReadonlyArray<AgentSchemaIssue> => {
  const issues: AgentSchemaIssue[] = [];
  for (const annotation of unsupportedAnnotationIds) {
    if (hasAnnotation(ast, annotation.id)) {
      issues.push({ path, issue: annotation.issue });
    }
  }
  return issues;
};

const literalIssue = (literal: SchemaAST.LiteralValue): string | undefined => {
  if (typeof literal === "string") return undefined;
  if (literal === null) return "null-literal-unsupported";
  return "non-string-literal-unsupported";
};

const inspectPropertyType = (
  property: SchemaAST.PropertySignature,
  path: string,
): ReadonlyArray<AgentSchemaIssue> => {
  if (!property.isOptional) return inspectAst(property.type, path);
  if (property.type._tag !== "Union") return inspectAst(property.type, path);
  const concreteTypes = property.type.types.filter((member) => member._tag !== "UndefinedKeyword");
  if (concreteTypes.length === 0) return [{ path, issue: "optional-type-missing" }];
  return concreteTypes.flatMap((member, index) =>
    inspectAst(member, concreteTypes.length === 1 ? path : `${path}.union${index}`),
  );
};

const inspectAst = (ast: SchemaAST.AST, path: string): ReadonlyArray<AgentSchemaIssue> => {
  const issues: AgentSchemaIssue[] = [...annotationIssues(ast, path)];
  switch (ast._tag) {
    case "StringKeyword":
    case "NumberKeyword":
    case "BooleanKeyword":
      return issues;
    case "Literal": {
      const issue = literalIssue(ast.literal);
      return issue === undefined ? issues : [...issues, { path, issue }];
    }
    case "TypeLiteral": {
      if (ast.indexSignatures.length > 0) {
        issues.push({ path, issue: "index-signature-unsupported" });
      }
      for (const property of ast.propertySignatures) {
        const key = property.name;
        if (typeof key !== "string") {
          issues.push({ path, issue: "non-string-property-unsupported" });
          continue;
        }
        issues.push(...annotationIssues(property, `${path}.${key}`));
        issues.push(...inspectPropertyType(property, `${path}.${key}`));
      }
      return issues;
    }
    case "TupleType": {
      if (ast.elements.length > 0 || ast.rest.length !== 1) {
        return [...issues, { path, issue: "tuple-unsupported" }];
      }
      const rest = ast.rest[0];
      return rest === undefined
        ? [...issues, { path, issue: "array-item-missing" }]
        : [
            ...issues,
            ...annotationIssues(rest, `${path}[]`),
            ...inspectAst(rest.type, `${path}[]`),
          ];
    }
    case "Union": {
      if (ast.types.length === 0) return [...issues, { path, issue: "empty-union-unsupported" }];
      for (const [index, member] of ast.types.entries()) {
        issues.push(...inspectAst(member, `${path}.union${index}`));
      }
      return issues;
    }
    case "Refinement":
      return [...issues, { path, issue: "refinement-unsupported" }];
    case "Transformation":
      return [...issues, { path, issue: "transformation-unsupported" }];
    case "Suspend":
      return [...issues, { path, issue: "recursive-schema-unsupported" }];
    case "TemplateLiteral":
      return [...issues, { path, issue: "template-literal-unsupported" }];
    case "Declaration":
      return [...issues, { path, issue: "declaration-schema-unsupported" }];
    case "UniqueSymbol":
    case "UndefinedKeyword":
    case "VoidKeyword":
    case "NeverKeyword":
    case "UnknownKeyword":
    case "AnyKeyword":
    case "BigIntKeyword":
    case "SymbolKeyword":
    case "ObjectKeyword":
    case "Enums":
      return [...issues, { path, issue: `${ast._tag}-unsupported` }];
  }
};

export const inspectAgentSchemaProfile = (
  schema: Schema.Schema.AnyNoContext,
): ReadonlyArray<AgentSchemaIssue> => {
  const rootIssues =
    schema.ast._tag === "TypeLiteral" ? [] : [{ path: "$", issue: "root-object-required" }];
  return [...rootIssues, ...inspectAst(schema.ast, "$")];
};

export const assertAgentSchemaProfile = (schema: Schema.Schema.AnyNoContext): void => {
  const issues = inspectAgentSchemaProfile(schema);
  if (issues.length > 0) throw new AgentSchemaProfileError(issues);
};

const agentSchemaToDialectSchema = (schema: Schema.Schema.AnyNoContext): JsonSchemaObject => {
  assertAgentSchemaProfile(schema);
  return effectSchemaToDialectSchema(schema);
};

const effectSchemaToDialectSchema = (schema: Schema.Schema.AnyNoContext): JsonSchemaObject => {
  if (
    schema.ast._tag === "TypeLiteral" &&
    schema.ast.propertySignatures.length === 0 &&
    schema.ast.indexSignatures.length === 0
  ) {
    return { type: "object", properties: {}, required: [], additionalProperties: false };
  }
  return parseDialectObject(JSONSchema.make(schema));
};

const canonicalize = (node: unknown, parentKey?: string): unknown => {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    const mapped = node.map((item) => canonicalize(item));
    if (parentKey !== undefined && SET_SEMANTICS_ARRAYS.has(parentKey)) {
      return [...mapped].sort((left, right) => {
        const a = typeof left === "string" ? left : JSON.stringify(left);
        const b = typeof right === "string" ? right : JSON.stringify(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
    }
    return mapped;
  }
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)
    .filter((key) => !STRIP_FINGERPRINT_KEYS.has(key) && !key.startsWith("x-"))
    .sort()) {
    out[key] = canonicalize(obj[key], key);
  }
  return out;
};

export const canonicalAgentSchemaJson = (schema: JsonSchemaObject): string =>
  JSON.stringify(canonicalize(schema));

const sha256Hex = (input: string): Effect.Effect<string> => {
  const bytes = new TextEncoder().encode(input);
  return Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((buffer) =>
      Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    ),
  );
};

export const fingerprintAgentSchema = (schema: JsonSchemaObject): Effect.Effect<string> =>
  sha256Hex(canonicalAgentSchemaJson(schema)).pipe(
    Effect.map((hash) => `${AGENT_SCHEMA_FINGERPRINT_VERSION}:sha256:${hash}`),
  );

const sanitizeForGemini = (node: JsonSchemaNode): JsonSchemaNode => {
  if ("anyOf" in node) return { anyOf: node.anyOf.map(sanitizeForGemini) };
  if (node.type === "array") return { type: "array", items: sanitizeForGemini(node.items) };
  if (node.type !== "object") return node;
  const properties: Record<string, JsonSchemaNode> = {};
  for (const [key, value] of Object.entries(node.properties)) {
    properties[key] = sanitizeForGemini(value);
  }
  const out: Record<string, unknown> = {
    type: "object",
    properties,
    ...(node.required === undefined ? {} : { required: node.required }),
  };
  for (const key of Object.keys(out)) {
    if (GEMINI_STRIPPED_SCHEMA_FIELDS.has(key)) delete out[key];
  }
  return out as unknown as JsonSchemaObject;
};

export const projectAgentSchema = (schema: JsonSchemaObject): AgentSchemaProjections => ({
  canonical: schema,
  openai: schema,
  anthropic: schema,
  gemini: sanitizeForGemini(schema) as JsonSchemaObject,
  agUi: schema,
});

export const defineAgentSchema = <A, I>(schema: Schema.Schema<A, I, never>): AgentSchema<A> => {
  const jsonSchema = agentSchemaToDialectSchema(schema);
  const decodeEffectSchema = Schema.decodeUnknownSync(schema);
  return {
    [AGENT_SCHEMA_BRAND]: true,
    source: schema,
    jsonSchema,
    fingerprint: fingerprintAgentSchema(jsonSchema),
    decode: (value) => {
      const violations = validateAgainstSchema(value, jsonSchema);
      if (violations.length > 0) {
        throw new AgentSchemaDecodeError(
          violations.map((violation) => {
            const separator = violation.lastIndexOf(":");
            return separator === -1
              ? { path: "$", issue: violation }
              : {
                  path: violation.slice(0, separator),
                  issue: violation.slice(separator + 1),
                };
          }),
        );
      }
      return decodeEffectSchema(value);
    },
    projections: projectAgentSchema(jsonSchema),
  };
};

export const isAgentSchema = (value: unknown): value is AnyAgentSchema =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly [AGENT_SCHEMA_BRAND]?: unknown })[AGENT_SCHEMA_BRAND] === true;

export function ensureAgentSchema<A>(schema: AgentSchema<A>): AgentSchema<A>;
export function ensureAgentSchema<A, I>(schema: Schema.Schema<A, I, never>): AgentSchema<A>;
export function ensureAgentSchema<A, I>(
  schema: AgentSchema<A> | Schema.Schema<A, I, never>,
): AgentSchema<A> {
  return isAgentSchema(schema as unknown)
    ? (schema as AgentSchema<A>)
    : defineAgentSchema(schema as Schema.Schema<A, I, never>);
}

export const makeAgentSchemaSpec = <A>(schema: AgentSchema<A>): Effect.Effect<AgentSchemaSpec<A>> =>
  schema.fingerprint.pipe(
    Effect.map((fingerprint) => ({
      agentSchema: schema,
      fingerprint,
    })),
  );
