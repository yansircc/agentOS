export const generatedCapabilityRuleFields = new Set([
  "allowedPrimitivePackages",
  "coordinationCapabilityKind",
  "coordinationPackage",
  "coverage",
  "docs",
  "invariants",
  "sourceFactOwners",
  "testEvidence",
]);

const unique = (values) => [...new Set(values)].sort((left, right) => left.localeCompare(right));

const coordinationCapabilityKinds = new Set(["composer", "facade", "profile", "projection"]);

const consumerFacingCapabilityKinds = new Set(["composer", "facade", "profile"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const stringArray = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);

const authoredCapabilityRuleSourceFields = new Set(["schemaVersion", "rules"]);

const resolvePrefixOwner = (prefix, namespaceOwners) => {
  const candidates = namespaceOwners.filter(
    (owner) => prefix.startsWith(owner.prefix) || owner.prefix.startsWith(prefix),
  );
  const owners = unique(candidates.map((candidate) => candidate.owner));
  if (owners.length !== 1) {
    return { ok: false, owners, candidates };
  }
  return {
    ok: true,
    owner: owners[0],
    declarations: candidates
      .filter((candidate) => candidate.owner === owners[0])
      .map((candidate) => ({
        prefix: candidate.prefix,
        owner: candidate.owner,
        filePath: candidate.filePath,
      })),
  };
};

const primitiveEvidence = (primitive) => {
  if (primitive.testEvidence?.tests !== undefined) {
    return {
      primitive: primitive.id,
      tests: primitive.testEvidence.tests,
    };
  }
  return {
    primitive: primitive.id,
    noTestReason: primitive.testEvidence?.noTestReason ?? "missing evidence source",
  };
};

export const buildCapabilityRouteProjection = ({
  source,
  recipes = [],
  primitives,
  invariants,
  rootScripts,
  namespaceOwners,
}) => {
  const failures = [];
  const primitiveById = new Map(primitives.map((primitive) => [primitive.id, primitive]));
  const invariantById = new Map(invariants.map((invariant) => [invariant.id, invariant]));
  const scriptNames = new Set(Object.keys(rootScripts));

  if (!isObject(source)) {
    return { failures: ["capability rules source must be an object"], routes: [] };
  }
  for (const field of Object.keys(source)) {
    if (!authoredCapabilityRuleSourceFields.has(field)) {
      failures.push(`capability rules source must not author field ${field}`);
    }
  }
  if (source.schemaVersion !== 1) failures.push("capability rules schemaVersion must be 1");
  if (!Array.isArray(source.rules)) failures.push("capability rules source must contain rules[]");

  const rules = Array.isArray(source.rules) ? source.rules : [];
  const seenPrimitives = new Set();
  const routes = [];

  for (const [index, rule] of rules.entries()) {
    const owner =
      isObject(rule) && typeof rule.primitive === "string" ? rule.primitive : `rule[${index}]`;

    if (!isObject(rule)) {
      failures.push(`${owner} must be an object`);
      continue;
    }

    for (const field of Object.keys(rule)) {
      if (generatedCapabilityRuleFields.has(field)) {
        failures.push(`${owner} must not author generated field ${field}`);
      }
    }

    const required = [
      "primitive",
      "intents",
      "sourceFactPrefixes",
      "allowedPrimitives",
      "forbiddenWrites",
      "gates",
    ];
    for (const field of required) {
      if (!(field in rule)) failures.push(`${owner} missing ${field}`);
    }

    if (typeof rule.primitive !== "string" || rule.primitive.length === 0) {
      failures.push(`${owner} primitive must be a non-empty string`);
      continue;
    }
    if (seenPrimitives.has(rule.primitive))
      failures.push(`duplicate capability rule ${rule.primitive}`);
    seenPrimitives.add(rule.primitive);

    const primitive = primitiveById.get(rule.primitive);
    if (primitive === undefined) {
      failures.push(`${rule.primitive} references unknown primitive`);
    }

    if (!stringArray(rule.intents) || rule.intents.length === 0) {
      failures.push(`${rule.primitive} intents must be a non-empty string array`);
    }
    if (!stringArray(rule.sourceFactPrefixes) || rule.sourceFactPrefixes.length === 0) {
      failures.push(`${rule.primitive} sourceFactPrefixes must be a non-empty string array`);
    }
    if (!stringArray(rule.allowedPrimitives) || rule.allowedPrimitives.length === 0) {
      failures.push(`${rule.primitive} allowedPrimitives must be a non-empty string array`);
    } else if (!rule.allowedPrimitives.includes(rule.primitive)) {
      failures.push(`${rule.primitive} allowedPrimitives must include its coordination primitive`);
    }
    if (!Array.isArray(rule.forbiddenWrites)) {
      failures.push(`${rule.primitive} forbiddenWrites must be an array`);
    }
    if (!stringArray(rule.gates) || rule.gates.length === 0) {
      failures.push(`${rule.primitive} gates must be a non-empty boundary gate array`);
    }

    const allowedPrimitives = stringArray(rule.allowedPrimitives) ? rule.allowedPrimitives : [];
    const allowedPrimitiveRecords = [];
    for (const allowedPrimitive of allowedPrimitives) {
      const record = primitiveById.get(allowedPrimitive);
      if (record === undefined) {
        failures.push(
          `${rule.primitive} allowedPrimitives references unknown primitive ${allowedPrimitive}`,
        );
      } else {
        allowedPrimitiveRecords.push(record);
      }
    }

    const sourceFactOwners = [];
    for (const prefix of stringArray(rule.sourceFactPrefixes) ? rule.sourceFactPrefixes : []) {
      const resolved = resolvePrefixOwner(prefix, namespaceOwners);
      if (!resolved.ok) {
        failures.push(
          `${rule.primitive} sourceFactPrefixes ${JSON.stringify(prefix)} must resolve to exactly one owner; observed ${JSON.stringify(resolved.owners)}`,
        );
      } else {
        sourceFactOwners.push({
          prefix,
          owner: resolved.owner,
          declarations: resolved.declarations,
        });
      }
    }

    const forbiddenWrites = Array.isArray(rule.forbiddenWrites) ? rule.forbiddenWrites : [];
    for (const [writeIndex, write] of forbiddenWrites.entries()) {
      const writeOwner = `${rule.primitive} forbiddenWrites[${writeIndex}]`;
      if (!isObject(write)) {
        failures.push(`${writeOwner} must be an object`);
        continue;
      }
      for (const field of ["actor", "action", "target", "invariant"]) {
        if (!(field in write)) failures.push(`${writeOwner} missing ${field}`);
      }
      if (typeof write.actor !== "string" || write.actor.length === 0) {
        failures.push(`${writeOwner} actor must be a non-empty string`);
      }
      if (typeof write.action !== "string" || write.action.length === 0) {
        failures.push(`${writeOwner} action must be a non-empty string`);
      }
      if (!isObject(write.target)) {
        failures.push(`${writeOwner} target must be an object`);
      } else {
        if (!["eventPrefix", "surface", "material"].includes(write.target.kind)) {
          failures.push(`${writeOwner} target.kind must be eventPrefix, surface, or material`);
        }
        if (typeof write.target.value !== "string" || write.target.value.length === 0) {
          failures.push(`${writeOwner} target.value must be a non-empty string`);
        }
        if (write.target.kind === "eventPrefix" && typeof write.target.value === "string") {
          const resolved = resolvePrefixOwner(write.target.value, namespaceOwners);
          if (!resolved.ok) {
            failures.push(
              `${writeOwner} target ${JSON.stringify(write.target.value)} must resolve to exactly one owner; observed ${JSON.stringify(resolved.owners)}`,
            );
          }
        }
      }
      if (typeof write.invariant !== "string" || !invariantById.has(write.invariant)) {
        failures.push(
          `${writeOwner} references unknown invariant ${JSON.stringify(write.invariant)}`,
        );
      }
    }

    for (const gate of stringArray(rule.gates) ? rule.gates : []) {
      if (!scriptNames.has(gate))
        failures.push(`${rule.primitive} references unknown boundary gate ${gate}`);
    }

    const sourceOwnerNames = unique(sourceFactOwners.map((entry) => entry.owner));
    if (
      sourceOwnerNames.length > 1 &&
      primitive !== undefined &&
      !coordinationCapabilityKinds.has(primitive.capabilityKind)
    ) {
      failures.push(
        `${rule.primitive} spans ${sourceOwnerNames.length} fact owners but coordination primitive kind ${JSON.stringify(
          primitive.capabilityKind,
        )} is not one of ${JSON.stringify([...coordinationCapabilityKinds])}`,
      );
    }

    if (
      primitive === undefined ||
      failures.some((failure) => failure.startsWith(`${rule.primitive} `))
    ) {
      continue;
    }

    const invariantIds = unique([
      ...allowedPrimitiveRecords.flatMap((record) => record.invariants),
      ...forbiddenWrites.flatMap((write) =>
        typeof write?.invariant === "string" && invariantById.has(write.invariant)
          ? [write.invariant]
          : [],
      ),
    ]);

    routes.push({
      primitive: rule.primitive,
      intents: rule.intents,
      coordinationPackage: primitive.package,
      coordinationCapabilityKind: primitive.capabilityKind,
      sourceFactPrefixes: rule.sourceFactPrefixes,
      sourceFactOwners,
      allowedPrimitives,
      allowedPrimitivePackages: unique(allowedPrimitiveRecords.map((record) => record.package)),
      forbiddenWrites,
      gates: rule.gates,
      invariants: invariantIds,
      docs: unique([
        ...allowedPrimitiveRecords.map((record) => record.docs),
        ...invariantIds.flatMap((id) => {
          const invariant = invariantById.get(id);
          return invariant === undefined ? [] : [invariant.docs];
        }),
      ]),
      testEvidence: allowedPrimitiveRecords.map(primitiveEvidence),
    });
  }

  const coverage = buildCapabilityRouteCoverage({ routes, recipes, primitives });
  failures.push(...coverage.failures);

  return {
    failures,
    routes:
      failures.length === 0
        ? routes.sort((left, right) => left.primitive.localeCompare(right.primitive))
        : [],
    coverage: failures.length === 0 ? coverage.summary : { recipes: [], primitives: [] },
  };
};

const routeMatchesRecipe = (route, recipe) => {
  const recipePrimitives = new Set(recipe.primitives);
  return (
    recipePrimitives.has(route.primitive) ||
    route.allowedPrimitives.some((primitive) => recipePrimitives.has(primitive))
  );
};

const routePrimitivesForRecipe = (routes, recipe) =>
  routes
    .filter((route) => routeMatchesRecipe(route, recipe))
    .map((route) => route.primitive)
    .sort((left, right) => left.localeCompare(right));

const buildCapabilityRouteCoverage = ({ routes, recipes, primitives }) => {
  const failures = [];
  const coveredPrimitiveIds = new Set(
    routes.flatMap((route) => [route.primitive, ...route.allowedPrimitives]),
  );
  const recipeCoverage = recipes.map((recipe) => {
    const routePrimitives = routePrimitivesForRecipe(routes, recipe);
    const noRouteReason =
      typeof recipe.noRouteReason === "string" ? recipe.noRouteReason.trim() : undefined;
    if (routePrimitives.length === 0 && noRouteReason === undefined) {
      failures.push(`${recipe.id} must have a capability route or noRouteReason`);
    }
    if (routePrimitives.length > 0 && noRouteReason !== undefined) {
      failures.push(`${recipe.id} has both route coverage and noRouteReason`);
    }
    return {
      id: recipe.id,
      routePrimitives,
      ...(noRouteReason === undefined ? {} : { noRouteReason }),
    };
  });

  const primitiveCoverage = primitives
    .filter((primitive) => consumerFacingCapabilityKinds.has(primitive.capabilityKind))
    .map((primitive) => {
      const routePrimitives = routes
        .filter(
          (route) =>
            route.primitive === primitive.id || route.allowedPrimitives.includes(primitive.id),
        )
        .map((route) => route.primitive)
        .sort((left, right) => left.localeCompare(right));
      const noRouteReason =
        typeof primitive.noRouteReason === "string" ? primitive.noRouteReason.trim() : undefined;
      if (!coveredPrimitiveIds.has(primitive.id) && noRouteReason === undefined) {
        failures.push(`${primitive.id} must have a capability route or noRouteReason`);
      }
      if (coveredPrimitiveIds.has(primitive.id) && noRouteReason !== undefined) {
        failures.push(`${primitive.id} has both route coverage and noRouteReason`);
      }
      return {
        id: primitive.id,
        capabilityKind: primitive.capabilityKind,
        routePrimitives,
        ...(noRouteReason === undefined ? {} : { noRouteReason }),
      };
    });

  return {
    failures,
    summary: {
      recipes: recipeCoverage,
      primitives: primitiveCoverage,
    },
  };
};
