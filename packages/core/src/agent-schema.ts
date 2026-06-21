import { Effect, Schema, SchemaAST } from "effect";

import {
  parseDialectObject,
  validateAgainstSchema,
  type JsonSchemaNode,
  type JsonSchemaObject,
} from "./json-schema-dialect";
import { authoredValue } from "./value-brands";
import type { Authored } from "./value-brands";

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

/**
 * Agent-facing schema wrapper derived from one Effect Schema source.
 *
 * @agentosPrimitive primitive.kernel.AgentSchema
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/concepts/agent-schema.md
 * @public
 */
export type AgentSchema<A = unknown> = {
  readonly [AGENT_SCHEMA_BRAND]: true;
  readonly source: AgentSchemaDecoder<unknown>;
  readonly jsonSchema: JsonSchemaObject;
  readonly fingerprint: Effect.Effect<string>;
  readonly decode: (value: unknown) => A;
  readonly projections: AgentSchemaProjections;
};

export type AnyAgentSchema = AgentSchema<unknown>;
export type AgentSchemaDecoder<A = unknown> = Schema.Decoder<A, never>;

export type AgentSchemaSource<A = unknown> = AgentSchema<A> | AgentSchemaDecoder<A>;

export type AnyAgentSchemaSource = AnyAgentSchema | AgentSchemaDecoder<unknown>;

export type AgentSchemaSpec<A = unknown> = {
  readonly agentSchema: AgentSchema<A>;
  readonly fingerprint: string;
};

/**
 * Schema projections derived from AgentSchema.
 *
 * @agentosPrimitive primitive.kernel.AgentSchemaProjections
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/concepts/agent-schema.md
 * @public
 */
export type AgentSchemaProjections = {
  readonly canonical: JsonSchemaObject;
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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SUPPORTED_STRING_REFINEMENT_KEYS = new Set(["pattern", "minLength", "maxLength"]);

type AstWithBase = SchemaAST.AST & {
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly checks?: ReadonlyArray<AstCheck>;
  readonly context?: {
    readonly isOptional?: boolean;
    readonly defaultValue?: unknown;
  };
  readonly encoding?: unknown;
};

type AstCheck = {
  readonly _tag: string;
  readonly checks?: ReadonlyArray<AstCheck>;
  readonly annotations?: {
    readonly meta?: unknown;
  };
};

const collectChecks = (checks: ReadonlyArray<AstCheck> | undefined): ReadonlyArray<AstCheck> => {
  if (checks === undefined) return [];
  return checks.flatMap((check) =>
    check._tag === "FilterGroup" ? collectChecks(check.checks) : [check],
  );
};

const stringCheckSemantic = (
  check: AstCheck,
):
  | { readonly key: "pattern"; readonly value: string }
  | {
      readonly key: "minLength" | "maxLength";
      readonly value: number;
    }
  | undefined => {
  const meta = check.annotations?.meta;
  if (!isRecord(meta) || typeof meta._tag !== "string") return undefined;
  if (meta._tag === "isPattern" && meta.regExp instanceof RegExp) {
    return { key: "pattern", value: meta.regExp.source };
  }
  if (
    meta._tag === "isMinLength" &&
    typeof meta.minLength === "number" &&
    Number.isInteger(meta.minLength) &&
    meta.minLength >= 0
  ) {
    return { key: "minLength", value: meta.minLength };
  }
  if (
    meta._tag === "isMaxLength" &&
    typeof meta.maxLength === "number" &&
    Number.isInteger(meta.maxLength) &&
    meta.maxLength >= 0
  ) {
    return { key: "maxLength", value: meta.maxLength };
  }
  return undefined;
};

const stringCheckIssues = (ast: AstWithBase, path: string): ReadonlyArray<AgentSchemaIssue> => {
  const issues: AgentSchemaIssue[] = [];
  for (const check of collectChecks(ast.checks)) {
    if (stringCheckSemantic(check) === undefined) {
      issues.push({ path, issue: "refinement-unsupported" });
    }
  }
  return issues;
};

const annotationIssues = (ast: SchemaAST.AST, path: string): ReadonlyArray<AgentSchemaIssue> => {
  const node = ast as AstWithBase;
  const issues: AgentSchemaIssue[] = [];
  if (node.encoding !== undefined) {
    issues.push({ path, issue: "transformation-unsupported" });
  }
  if (node.context?.defaultValue !== undefined) {
    issues.push({ path, issue: "default-unsupported" });
  }
  if (Array.isArray(node.annotations?.brands) && node.annotations.brands.length > 0) {
    issues.push({ path, issue: "brand-unsupported" });
  }
  if (node._tag !== "String" && collectChecks(node.checks).length > 0) {
    issues.push({ path, issue: "refinement-unsupported" });
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
  if (!isOptionalAst(property.type)) return inspectAst(property.type, path);
  const issues: AgentSchemaIssue[] = [...annotationIssues(property.type, path)];
  if (property.type._tag !== "Union") return inspectAst(property.type, path);
  const concreteTypes = property.type.types.filter((member) => member._tag !== "Undefined");
  if (concreteTypes.length === 0) return [...issues, { path, issue: "optional-type-missing" }];
  issues.push(
    ...concreteTypes.flatMap((member, index) =>
      inspectAst(member, concreteTypes.length === 1 ? path : `${path}.union${index}`),
    ),
  );
  return issues;
};

const inspectAst = (ast: SchemaAST.AST, path: string): ReadonlyArray<AgentSchemaIssue> => {
  const issues: AgentSchemaIssue[] = [...annotationIssues(ast, path)];
  switch (ast._tag) {
    case "String":
      return [...issues, ...stringCheckIssues(ast as AstWithBase, path)];
    case "Number":
    case "Boolean":
      return issues;
    case "Literal": {
      const issue = literalIssue(ast.literal);
      return issue === undefined ? issues : [...issues, { path, issue }];
    }
    case "Objects": {
      if (ast.indexSignatures.length > 0) {
        issues.push({ path, issue: "index-signature-unsupported" });
      }
      for (const property of ast.propertySignatures) {
        const key = property.name;
        if (typeof key !== "string") {
          issues.push({ path, issue: "non-string-property-unsupported" });
          continue;
        }
        issues.push(...inspectPropertyType(property, `${path}.${key}`));
      }
      return issues;
    }
    case "Arrays": {
      if (ast.elements.length > 0 || ast.rest.length !== 1) {
        return [...issues, { path, issue: "tuple-unsupported" }];
      }
      const rest = ast.rest[0];
      return rest === undefined
        ? [...issues, { path, issue: "array-item-missing" }]
        : [...issues, ...inspectAst(rest, `${path}[]`)];
    }
    case "Union": {
      if (ast.types.length === 0) return [...issues, { path, issue: "empty-union-unsupported" }];
      for (const [index, member] of ast.types.entries()) {
        issues.push(...inspectAst(member, `${path}.union${index}`));
      }
      return issues;
    }
    case "Suspend":
      return [...issues, { path, issue: "recursive-schema-unsupported" }];
    case "TemplateLiteral":
      return [...issues, { path, issue: "template-literal-unsupported" }];
    case "Declaration":
      return [...issues, { path, issue: "declaration-schema-unsupported" }];
    case "Null":
      return [...issues, { path, issue: "null-literal-unsupported" }];
    case "UniqueSymbol":
    case "Undefined":
    case "Void":
    case "Never":
    case "Unknown":
    case "Any":
    case "BigInt":
    case "Symbol":
    case "ObjectKeyword":
      return [...issues, { path, issue: `${ast._tag}-unsupported` }];
    default:
      return [...issues, { path, issue: `${ast._tag}-unsupported` }];
  }
};

export const inspectAgentSchemaProfile = (
  schema: AgentSchemaDecoder<unknown>,
): ReadonlyArray<AgentSchemaIssue> => {
  const rootIssues =
    schema.ast._tag === "Objects" ? [] : [{ path: "$", issue: "root-object-required" }];
  return [...rootIssues, ...inspectAst(schema.ast, "$")];
};

export const assertAgentSchemaProfile = (schema: AgentSchemaDecoder<unknown>): void => {
  const issues = inspectAgentSchemaProfile(schema);
  if (issues.length > 0) throw new AgentSchemaProfileError(issues);
};

const agentSchemaToDialectSchema = (schema: AgentSchemaDecoder<unknown>): JsonSchemaObject => {
  assertAgentSchemaProfile(schema);
  return effectSchemaToDialectSchema(schema);
};

const isOptionalAst = (ast: SchemaAST.AST): boolean =>
  ((ast as AstWithBase).context?.isOptional ?? false) === true;

const withoutUndefined = (members: ReadonlyArray<SchemaAST.AST>): ReadonlyArray<SchemaAST.AST> =>
  members.filter((member) => member._tag !== "Undefined");

const stringConstraints = (
  ast: AstWithBase,
): Partial<Extract<JsonSchemaNode, { type: "string" }>> => {
  const out: Record<string, string | number> = {};
  for (const check of collectChecks(ast.checks)) {
    const semantic = stringCheckSemantic(check);
    if (semantic !== undefined && SUPPORTED_STRING_REFINEMENT_KEYS.has(semantic.key)) {
      out[semantic.key] = semantic.value;
    }
  }
  return out;
};

const astToDialectNode = (ast: SchemaAST.AST): JsonSchemaObject["properties"][string] => {
  switch (ast._tag) {
    case "String":
      return { type: "string", ...stringConstraints(ast as AstWithBase) };
    case "Number":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "Literal":
      return { type: "string", enum: [ast.literal as string] };
    case "Objects": {
      const properties: Record<string, JsonSchemaObject["properties"][string]> = {};
      const required: string[] = [];
      for (const property of ast.propertySignatures) {
        if (typeof property.name !== "string") continue;
        const members =
          property.type._tag === "Union" && isOptionalAst(property.type)
            ? withoutUndefined(property.type.types)
            : [property.type];
        const node =
          members.length === 1
            ? astToDialectNode(members[0]!)
            : { anyOf: members.map((member) => astToDialectNode(member)) };
        properties[property.name] = node;
        if (!isOptionalAst(property.type)) required.push(property.name);
      }
      return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      };
    }
    case "Arrays":
      return { type: "array", items: astToDialectNode(ast.rest[0]!) };
    case "Union": {
      const members = withoutUndefined(ast.types);
      const literals = members.filter((member) => member._tag === "Literal");
      if (literals.length === members.length) {
        return {
          type: "string",
          enum: literals.map((member) => (member as SchemaAST.Literal).literal as string),
        };
      }
      return { anyOf: members.map((member) => astToDialectNode(member)) };
    }
    default:
      throw new AgentSchemaProfileError([{ path: "$", issue: `${ast._tag}-unsupported` }]);
  }
};

const effectSchemaToDialectSchema = (schema: AgentSchemaDecoder<unknown>): JsonSchemaObject => {
  return parseDialectObject(astToDialectNode(schema.ast));
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

/**
 * Derives schema projections from one canonical schema.
 *
 * @agentosPrimitive primitive.kernel.projectAgentSchema
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/concepts/agent-schema.md
 * @public
 */
export const projectAgentSchema = (schema: JsonSchemaObject): AgentSchemaProjections => ({
  canonical: schema,
});

export const defineAgentSchema = <S extends AgentSchemaDecoder<unknown>>(
  schema: S,
): AgentSchema<S["Type"]> & Authored<AgentSchema<S["Type"]>> => {
  const jsonSchema = agentSchemaToDialectSchema(schema);
  const decodeEffectSchema = Schema.decodeUnknownSync(schema);
  return authoredValue({
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
  });
};

export const isAgentSchema = (value: unknown): value is AnyAgentSchema =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly [AGENT_SCHEMA_BRAND]?: unknown })[AGENT_SCHEMA_BRAND] === true;

export function ensureAgentSchema<A>(schema: AgentSchema<A>): AgentSchema<A>;
export function ensureAgentSchema<S extends AgentSchemaDecoder<unknown>>(
  schema: S,
): AgentSchema<S["Type"]>;
export function ensureAgentSchema<A>(
  schema: AgentSchema<A> | AgentSchemaDecoder<A>,
): AgentSchema<A> {
  return isAgentSchema(schema as unknown)
    ? (schema as AgentSchema<A>)
    : (defineAgentSchema(schema as AgentSchemaDecoder<A>) as AgentSchema<A>);
}

export const makeAgentSchemaSpec = <A>(schema: AgentSchema<A>): Effect.Effect<AgentSchemaSpec<A>> =>
  schema.fingerprint.pipe(
    Effect.map((fingerprint) => ({
      agentSchema: schema,
      fingerprint,
    })),
  );
