import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  packageRootOwnerFailures,
  rootExportRecordsFromSource,
} from "../src/check/algorithmic/root-owner-checks.mjs";
import {
  parseApiIntentSource,
  publicApiIntentSections,
} from "../src/check/algorithmic/public-api-intent.mjs";

const packagePath = "packages/pkg";
const packageName = "@fixture/pkg";

const withFixture = (run) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-root-owner-"));
  const write = (relativePath, content) => {
    const file = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const writeJson = (relativePath, value) => write(relativePath, `${JSON.stringify(value)}\n`);
  try {
    return run({ repoRoot, write, writeJson });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
};

const positiveRoot = [
  'export { makeThing, Widget as RenamedWidget } from "./owner";',
  'export type { Shape, TypeWidget as WidgetShape } from "./owner";',
  "",
].join("\n");

const positiveOwner = [
  'export { makeThing, Widget } from "./leaf";',
  'export type { Shape, TypeWidget } from "./leaf";',
  "",
].join("\n");

const positiveLeaf = [
  "export const makeThing = () => 1;",
  "export class Widget {}",
  "export interface Shape { readonly kind: string }",
  "export class TypeWidget {}",
  "",
].join("\n");

const positiveIntents = [
  "# Fixture API",
  "",
  "## Public exports",
  "",
  "- `.:makeThing`",
  "- `.:RenamedWidget`",
  "- `.:Shape`",
  "- `.:WidgetShape`",
  "- `./owner:makeThing`",
  "- `./owner:Widget`",
  "- `./owner:Shape`",
  "- `./owner:TypeWidget`",
  "",
].join("\n");

const seed = (
  { write, writeJson },
  {
    root = positiveRoot,
    owner = positiveOwner,
    leaf = positiveLeaf,
    intents = positiveIntents,
    exports = {
      ".": { types: "./src/index.ts", default: "./src/index.ts" },
      "./owner": { types: "./src/owner.ts", default: "./src/owner.ts" },
    },
    rootAudiences = ["advanced"],
    ownerAudiences = ["advanced", "generated-only"],
    compilerOptions = {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    prepare,
  } = {},
) => {
  writeJson(`${packagePath}/package.json`, { name: packageName, exports });
  writeJson(`${packagePath}/tsconfig.json`, {
    compilerOptions,
    include: ["src/**/*"],
  });
  write(`${packagePath}/src/index.ts`, root);
  write(`${packagePath}/src/owner.ts`, owner);
  write(`${packagePath}/src/leaf.ts`, leaf);
  write("docs/api/pkg.md", intents);
  prepare?.({ write, writeJson });
  return {
    name: packageName,
    apiSource: "docs/api/pkg.md",
    entrypoints: [
      { subpath: ".", audiences: rootAudiences },
      { subpath: "./owner", audiences: ownerAudiences },
    ],
  };
};

const failuresFor = (fixture, options) => {
  const surfacePackage = seed(fixture, options);
  return packageRootOwnerFailures({
    fs,
    path,
    ts,
    repoRoot: fixture.repoRoot,
    packagePath,
    surfacePackage,
  });
};

void test("root export records preserve aliases, source names, and requested kinds", () => {
  assert.deepEqual(
    rootExportRecordsFromSource({ ts, file: "index.ts", source: positiveRoot }).records.map(
      ({ publicName, sourceModule, sourceName, exportKind }) => ({
        publicName,
        sourceModule,
        sourceName,
        exportKind,
      }),
    ),
    [
      {
        publicName: "makeThing",
        sourceModule: "./owner",
        sourceName: "makeThing",
        exportKind: "value",
      },
      {
        publicName: "RenamedWidget",
        sourceModule: "./owner",
        sourceName: "Widget",
        exportKind: "value",
      },
      {
        publicName: "Shape",
        sourceModule: "./owner",
        sourceName: "Shape",
        exportKind: "type",
      },
      {
        publicName: "WidgetShape",
        sourceModule: "./owner",
        sourceName: "TypeWidget",
        exportKind: "type",
      },
    ],
  );
});

void test("public API intent parser accepts only complete governed-section grammar", () => {
  const valid = parseApiIntentSource({
    file: "docs/api/fixture.md",
    sections: publicApiIntentSections,
    source: [
      "## Public exports",
      "",
      "- `.:makeThing`",
      "- `./owner:makeThing` - generated summary",
      "",
      "## Notes",
      "This prose is outside the governed section.",
      "",
    ].join("\n"),
  });

  assert.deepEqual(valid.failures, []);
  assert.deepEqual(
    valid.entries.map(({ name, section, line }) => ({ name, section, line })),
    [
      { name: ".:makeThing", section: "Public exports", line: 3 },
      { name: "./owner:makeThing", section: "Public exports", line: 4 },
    ],
  );

  for (const [name, body, marker] of [
    ["prose", ["This example mentions `.:ignored`."], "accepts only explicit"],
    ["fence", ["```md", "- `.:fenced`", "```"], "accepts only explicit"],
    ["comment", ["<!--", "- `.:commented`", "-->"], "accepts only explicit"],
    ["raw HTML", ["<pre>", "- `.:html`", "</pre>"], "raw HTML is outside"],
  ]) {
    const invalid = parseApiIntentSource({
      file: "docs/api/fixture.md",
      sections: publicApiIntentSections,
      source: ["## Public exports", "", ...body, ""].join("\n"),
    });
    assert.deepEqual(invalid.entries, [], name);
    assert.ok(
      invalid.failures.some((failure) => failure.includes(marker)),
      name,
    );
  }

  const empty = parseApiIntentSource({
    file: "docs/api/fixture.md",
    sections: publicApiIntentSections,
    source: ["## Public exports", "", "None.", "- `.:notEmpty`", "", "## Public exports", ""].join(
      "\n",
    ),
  });
  assert.deepEqual(empty.entries, []);
  assert.ok(empty.failures.some((failure) => failure.includes("cannot combine")));
  assert.ok(empty.failures.some((failure) => failure.includes("duplicate governed")));
});

void test("public API intent parser ignores governed-looking lines inside outer fences and comments", () => {
  const parsed = parseApiIntentSource({
    file: "docs/api/fixture.md",
    sections: publicApiIntentSections,
    source: [
      "```md",
      "## Public exports",
      "- `.:fenced`",
      "```",
      "<!--",
      "## Public exports",
      "- `.:commented`",
      "-->",
      "## Public exports",
      "",
      "- `.:real`",
      "",
    ].join("\n"),
  });
  assert.deepEqual(parsed.failures, []);
  assert.deepEqual(
    parsed.entries.map(({ name }) => name),
    [".:real"],
  );
});

void test("public API intent parser rejects raw HTML anywhere in the contract source", () => {
  for (const [name, prefix] of [
    ["ordinary", ""],
    ["UTF-8 BOM", "\uFEFF"],
  ]) {
    const parsed = parseApiIntentSource({
      file: "docs/api/fixture.md",
      sections: publicApiIntentSections,
      source: `${prefix}${[
        "<pre>",
        "## Public exports",
        "- `.:fake`",
        "</pre>",
        "## Public exports",
        "- `.:real`",
        "",
      ].join("\n")}`,
    });
    assert.deepEqual(parsed.entries, [], name);
    assert.ok(
      parsed.failures.some((failure) => failure.includes("raw HTML is outside")),
      name,
    );
  }
});

void test("root syntax rejects star, namespace, default, local, declaration, and workspace exports", () => {
  const cases = [
    ['export * from "./owner";\n', "export-star"],
    ['export * as owner from "./owner";\n', "namespace export"],
    ['export { default as owner } from "./owner";\n', "default export"],
    ["const owner = 1;\nexport { owner };\n", "permits only source-bearing"],
    ["export const owner = 1;\n", "permits only source-bearing"],
    ['export { owner } from "@agent-os/other";\n', "external/workspace re-export"],
    [
      '/// <reference path="./owner.ts" />\nexport { owner } from "./owner";\n',
      "triple-slash path",
    ],
    ['/// <reference types="node" />\nexport { owner } from "./owner";\n', "triple-slash types"],
    ['/// <reference lib="es2022" />\nexport { owner } from "./owner";\n', "triple-slash lib"],
    [
      '/// <reference no-default-lib="true" />\nexport { owner } from "./owner";\n',
      "triple-slash no-default-lib",
    ],
    [
      '/// <amd-dependency path="legacy" />\nexport { owner } from "./owner";\n',
      "triple-slash amd-dependency",
    ],
    [
      '/// <amd-module name="legacy" />\nexport { owner } from "./owner";\n',
      "triple-slash amd-module",
    ],
  ];
  for (const [source, marker] of cases) {
    const result = rootExportRecordsFromSource({ ts, file: "index.ts", source });
    assert.ok(
      result.failures.some((failure) => failure.includes(marker)),
      marker,
    );
  }
});

void test("root owner proof accepts rename aliases and compatible class/type capabilities", () =>
  withFixture((fixture) => {
    assert.deepEqual(failuresFor(fixture), []);
  }));

void test("root owner proof rejects a value request for a type-only owner symbol", () =>
  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      root: 'export { Shape } from "./owner";\n',
      intents: ["## Public exports", "", "- `.:Shape`", "- `./owner:Shape`", ""].join("\n"),
    });
    assert.ok(
      failures.some(
        (failure) =>
          failure.includes("root Shape requests value") &&
          failure.includes("capabilities are type"),
      ),
    );
  }));

void test("root owner proof preserves type-only provenance across star re-exports", () => {
  const root = 'export { Widget } from "./owner";\n';
  const intents = ["## Public exports", "", "- `.:Widget`", "- `./owner:Widget`", ""].join("\n");

  withFixture((fixture) => {
    assert.deepEqual(
      failuresFor(fixture, {
        root,
        owner: 'export * from "./leaf";\n',
        intents,
      }),
      [],
    );
  });

  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      root,
      owner: 'export type * from "./leaf";\n',
      intents,
    });
    assert.ok(
      failures.some(
        (failure) =>
          failure.includes("root Widget requests value") &&
          failure.includes("capabilities are type"),
      ),
    );
  });

  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      root: 'export { ns } from "./owner";\n',
      owner: 'export type * as ns from "./leaf";\n',
      intents: ["## Public exports", "", "- `.:ns`", "- `./owner:ns`", ""].join("\n"),
    });
    assert.ok(
      failures.some(
        (failure) =>
          failure.includes("root ns requests value") && !failure.includes("capabilities are value"),
      ),
    );
  });

  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      root: 'export type { ns } from "./owner";\n',
      owner: 'export type * as ns from "./leaf";\n',
      intents: ["## Public exports", "", "- `.:ns`", "- `./owner:ns`", ""].join("\n"),
    });
    assert.ok(
      failures.some(
        (failure) =>
          failure.includes("root ns requests type") && failure.includes("capabilities are none"),
      ),
    );
  });
});

void test("root owner proof rejects ambiguous and suppressed export contributions", () => {
  const cases = [
    {
      name: "direct star conflict",
      owner: ['export * from "./leaf";', 'export * from "./other";', ""].join("\n"),
      extra: { "other.ts": "export class Widget {}\n" },
      marker: "owner export closure is semantically invalid",
    },
    {
      name: "transitive star conflict",
      owner: 'export * from "./mid";\n',
      extra: {
        "mid.ts": ['export * from "./leaf";', 'export * from "./other";', ""].join("\n"),
        "other.ts": "export class Widget {}\n",
      },
      marker: "owner export closure is semantically invalid",
    },
    {
      name: "explicit duplicate re-export",
      owner: ['export { Widget } from "./leaf";', 'export { Widget } from "./other";', ""].join(
        "\n",
      ),
      extra: { "other.ts": "export class Widget {}\n" },
      marker: "owner export closure is semantically invalid",
    },
    {
      name: "duplicate exported declarations",
      owner: "export class Widget {}\nexport class Widget {}\n",
      marker: "owner export closure is semantically invalid",
    },
    {
      name: "duplicate local declarations",
      owner: "class Widget {}\nclass Widget {}\nexport { Widget };\n",
      marker: "owner export closure is semantically invalid",
    },
    {
      name: "invalid owner syntax",
      owner: "export class Widget {\n",
      marker: "owner export closure is syntactically invalid",
    },
    {
      name: "invalid exported value",
      owner: "export const Widget = missingValue;\n",
      marker: "owner export closure is semantically invalid",
    },
    {
      name: "invalid exported signature",
      owner: "export declare function Widget(): MissingType;\n",
      marker: "owner export closure is semantically invalid",
    },
    {
      name: "invalid exported type",
      root: 'export type { Widget } from "./owner";\n',
      owner: "export interface Widget { readonly missing: MissingType }\n",
      marker: "owner export closure is semantically invalid",
    },
    {
      name: "invalid imported type dependency",
      root: 'export type { Widget } from "./owner";\n',
      owner: 'import type { Internal } from "./internal";\nexport type Widget = Internal;\n',
      extra: {
        "internal.ts": "export interface Internal { readonly missing: MissingType }\n",
      },
      marker: "owner export closure is semantically invalid",
    },
    {
      name: "owner triple-slash ambient injection",
      root: 'export type { Widget } from "./owner";\n',
      owner:
        '/// <reference path="./ambient.d.ts" />\nexport interface Widget extends AmbientShape {}\n',
      extra: { "ambient.d.ts": "interface AmbientShape { readonly ambient: true }\n" },
      marker: "owner export closure triple-slash path directive is forbidden",
    },
    {
      name: "ts-nocheck suppression",
      owner: "// @ts-nocheck\nexport class Widget {}\nexport class Widget {}\n",
      marker: "owner export closure forbids @ts-nocheck",
    },
    {
      name: "ts-ignore suppression",
      owner: ['export * from "./leaf";', "// @ts-ignore", 'export * from "./other";', ""].join(
        "\n",
      ),
      extra: { "other.ts": "export class Widget {}\n" },
      marker: "forbids TypeScript diagnostic suppression directives",
    },
    {
      name: "ts-expect-error suppression",
      owner: [
        'export * from "./leaf";',
        "// @ts-expect-error intentional red fixture",
        'export * from "./other";',
        "",
      ].join("\n"),
      extra: { "other.ts": "export class Widget {}\n" },
      marker: "forbids TypeScript diagnostic suppression directives",
    },
    {
      name: "root ts-nocheck suppression",
      root: '// @ts-nocheck\nexport { Widget } from "./owner";\n',
      owner: 'export { Widget } from "./leaf";\n',
      marker: "owner export closure forbids @ts-nocheck",
    },
  ];

  for (const {
    name,
    root = 'export { Widget } from "./owner";\n',
    owner,
    extra = {},
    marker,
  } of cases) {
    withFixture((fixture) => {
      const failures = failuresFor(fixture, {
        root,
        owner,
        intents: ["## Public exports", "", "- `.:Widget`", "- `./owner:Widget`", ""].join("\n"),
        prepare: ({ write }) => {
          for (const [file, content] of Object.entries(extra)) {
            write(`${packagePath}/src/${file}`, content);
          }
        },
      });
      assert.ok(
        failures.some((failure) => failure.includes(marker)),
        name,
      );
    });
  }
});

void test("root owner proof owns diagnostics independently of package suppression", () => {
  const compilerOptions = {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noEmit: true,
    noCheck: true,
    skipLibCheck: true,
  };
  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      root: 'export type { Widget } from "./owner";\n',
      owner: "export interface Widget { readonly missing: MissingRootOwnerType }\n",
      intents: ["## Public exports", "", "- `.:Widget`", "- `./owner:Widget`", ""].join("\n"),
      compilerOptions,
    });
    assert.ok(
      failures.some((failure) => failure.includes("owner export closure is semantically invalid")),
    );
  });

  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      root: 'export type { Widget } from "./owner";\n',
      owner: 'export type { Widget } from "./declared";\n',
      intents: ["## Public exports", "", "- `.:Widget`", "- `./owner:Widget`", ""].join("\n"),
      compilerOptions,
      prepare: ({ write }) =>
        write(
          `${packagePath}/src/declared.d.ts`,
          "export interface Widget { readonly missing: MissingDeclaredType }\n",
        ),
    });
    assert.ok(
      failures.some((failure) => failure.includes("owner export closure is semantically invalid")),
    );
  });
});

void test("root owner proof rejects zero and ambiguous package owners", () => {
  for (const [exports, observed] of [
    [{ ".": "./src/index.ts" }, "observed 0"],
    [
      {
        ".": "./src/index.ts",
        "./owner": "./src/owner.ts",
        "./owner-alias": "./src/owner.ts",
      },
      "observed 2",
    ],
  ]) {
    withFixture((fixture) => {
      const failures = failuresFor(fixture, { exports });
      assert.ok(
        failures.some(
          (failure) =>
            failure.includes("exactly one non-root package owner") && failure.includes(observed),
        ),
        observed,
      );
    });
  }

  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      exports: {
        ".": "./src/index.ts",
        "./owner": {
          types: "./src/owner.ts",
          default: "./src/leaf.ts",
        },
      },
    });
    assert.ok(
      failures.some((failure) =>
        failure.includes(
          "package owner ./owner conditions must converge to exactly one source module",
        ),
      ),
    );
  });

  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      exports: {
        ".": "./src/index.ts",
        "./owner": {
          types: "./src/owner.ts",
          default: "../outside.ts",
        },
      },
    });
    assert.ok(
      failures.some((failure) =>
        failure.includes("package owner ./owner target escapes its package"),
      ),
    );
  });

  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      exports: {
        ".": "./src/index.ts",
        "./owner": {
          types: "./src/owner.ts",
          browser: null,
          default: "./src/owner.ts",
        },
      },
    });
    assert.ok(
      failures.some((failure) =>
        failure.includes("package owner ./owner conditions contain 1 non-source target"),
      ),
    );
  });
});

void test("root owner proof canonicalizes package source identity", () => {
  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      exports: {
        ".": "./../../shared-index.ts",
        "./owner": "./src/owner.ts",
      },
      prepare: ({ write }) => write("shared-index.ts", positiveRoot),
    });
    assert.ok(failures.some((failure) => failure.includes("package root target escapes")));
  });

  withFixture((fixture) => {
    const ownerLink = path.join(fixture.repoRoot, packagePath, "src/owner-link.ts");
    const failures = failuresFor(fixture, {
      exports: {
        ".": "./src/index.ts",
        "./owner": "./src/owner-link.ts",
      },
      prepare: ({ write }) => {
        write("shared/owner.ts", positiveOwner);
        fs.symlinkSync(path.join(fixture.repoRoot, "shared/owner.ts"), ownerLink);
      },
    });
    assert.ok(
      failures.some((failure) =>
        failure.includes("package owner ./owner source resolves outside its package"),
      ),
    );
  });

  withFixture((fixture) => {
    const ownerLink = path.join(fixture.repoRoot, packagePath, "src/owner-link.ts");
    const failures = failuresFor(fixture, {
      exports: {
        ".": "./src/index.ts",
        "./owner": "./src/owner.ts",
        "./owner-alias": "./src/owner-link.ts",
      },
      prepare: () => fs.symlinkSync("owner.ts", ownerLink),
    });
    assert.ok(
      failures.some((failure) =>
        failure.includes("exactly one non-root package owner; observed 2"),
      ),
    );
  });

  for (const [name, owner] of [
    ["symlink", 'export { Widget } from "./leaf-link";\n'],
    ["relative escape", 'export { Widget } from "../../../shared/leaf";\n'],
  ]) {
    withFixture((fixture) => {
      const failures = failuresFor(fixture, {
        root: 'export { Widget } from "./owner";\n',
        owner,
        intents: ["## Public exports", "", "- `.:Widget`", "- `./owner:Widget`", ""].join("\n"),
        prepare: ({ write }) => {
          write("shared/leaf.ts", "export class Widget {}\n");
          if (name === "symlink") {
            fs.symlinkSync(
              path.join(fixture.repoRoot, "shared/leaf.ts"),
              path.join(fixture.repoRoot, packagePath, "src/leaf-link.ts"),
            );
          }
        },
      });
      assert.ok(
        failures.some((failure) => failure.includes("resolves outside its package")),
        name,
      );
    });
  }

  for (const [name, root, owner, leaf] of [
    [
      "value dependency",
      'export { Widget } from "./owner";\n',
      'import { internal } from "../../../shared/leaf";\nexport const Widget = internal;\n',
      "export const internal = {};\n",
    ],
    [
      "type dependency",
      'export type { Widget } from "./owner";\n',
      'import type { Internal } from "../../../shared/leaf";\nexport type Widget = Internal;\n',
      "export interface Internal { readonly ok: true }\n",
    ],
  ]) {
    withFixture((fixture) => {
      const failures = failuresFor(fixture, {
        root,
        owner,
        intents: ["## Public exports", "", "- `.:Widget`", "- `./owner:Widget`", ""].join("\n"),
        prepare: ({ write }) => write("shared/leaf.ts", leaf),
      });
      assert.ok(
        failures.some((failure) => failure.includes("relative dependency escapes its package")),
        name,
      );
    });
  }

  for (const [name, specifier] of [
    ["posix absolute", undefined],
    ["windows absolute", "C:\\shared\\leaf"],
  ]) {
    withFixture((fixture) => {
      const absoluteSpecifier = specifier ?? path.join(fixture.repoRoot, "shared/leaf");
      const failures = failuresFor(fixture, {
        root: 'export { Widget } from "./owner";\n',
        owner: `import { internal } from ${JSON.stringify(absoluteSpecifier)};\nexport const Widget = internal;\n`,
        intents: ["## Public exports", "", "- `.:Widget`", "- `./owner:Widget`", ""].join("\n"),
        prepare: ({ write }) => write("shared/leaf.ts", "export const internal = {};\n"),
      });
      assert.ok(
        failures.some((failure) => failure.includes("absolute source dependency is forbidden")),
        name,
      );
    });
  }
});

void test("root owner proof follows TypeScript extensionless module resolution", () => {
  withFixture((fixture) => {
    const ownerFile = path.join(fixture.repoRoot, packagePath, "src/owner.ts");
    const failures = failuresFor(fixture, {
      owner: positiveOwner.replaceAll('"./leaf"', '"../leaf"'),
      exports: {
        ".": "./src/index.ts",
        "./owner": "./src/owner/index.ts",
      },
      prepare: ({ write }) => {
        fs.rmSync(ownerFile);
        write(
          `${packagePath}/src/owner/index.ts`,
          positiveOwner.replaceAll('"./leaf"', '"../leaf"'),
        );
      },
    });
    assert.deepEqual(failures, []);
  });

  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      exports: {
        ".": "./src/index.ts",
        "./owner": "./src/owner/index.ts",
      },
      prepare: ({ write }) =>
        write(
          `${packagePath}/src/owner/index.ts`,
          positiveOwner.replaceAll('"./leaf"', '"../leaf"'),
        ),
    });
    assert.ok(
      failures.some((failure) =>
        failure.includes("exactly one non-root package owner; observed 0"),
      ),
    );
  });
});

void test("root owner proof requires unique root and owner API intents", () => {
  for (const [intents, marker] of [
    ["## Public exports\n\n- `./owner:makeThing`\n", "root aggregation intent .:makeThing"],
    ["## Public exports\n\n- `.:makeThing`\n", "owner intent ./owner:makeThing"],
    [
      "## Public exports\n\n- `.:makeThing`\n- `.:makeThing`\n- `./owner:makeThing`\n",
      "root aggregation intent .:makeThing; observed 2",
    ],
  ]) {
    withFixture((fixture) => {
      const failures = failuresFor(fixture, {
        root: 'export { makeThing } from "./owner";\n',
        intents,
      });
      assert.ok(
        failures.some((failure) => failure.includes(marker)),
        marker,
      );
    });
  }

  withFixture((fixture) => {
    const failures = failuresFor(fixture, {
      root: 'export { makeThing } from "./owner";\n',
      intents: [
        "## Public exports",
        "",
        "This example mentions `.:makeThing` and `./owner:makeThing`, but declares nothing.",
        "",
      ].join("\n"),
    });
    assert.ok(
      failures.some((failure) =>
        failure.includes("root aggregation intent .:makeThing; observed 0"),
      ),
    );
    assert.ok(
      failures.some((failure) => failure.includes("owner intent ./owner:makeThing; observed 0")),
    );
  });
});

void test("root owner proof requires root audiences to be owned by the subpath", () =>
  withFixture((fixture) => {
    const failures = failuresFor(fixture, { ownerAudiences: ["generated-only"] });
    assert.ok(
      failures.some(
        (failure) =>
          failure.includes("root audiences [advanced]") && failure.includes("missing advanced"),
      ),
    );
  }));

void test("root owner proof rejects missing owner symbols and duplicate root aggregation", () => {
  withFixture((fixture) => {
    const missing = failuresFor(fixture, {
      root: 'export { Missing } from "./owner";\n',
      intents: "## Public exports\n\n- `.:Missing`\n- `./owner:Missing`\n",
    });
    assert.ok(missing.some((failure) => failure.includes("actually export exactly one Missing")));
  });

  withFixture((fixture) => {
    const duplicate = failuresFor(fixture, {
      root: 'export { makeThing as first, makeThing as second } from "./owner";\n',
      intents: [
        "## Public exports",
        "",
        "- `.:first`",
        "- `.:second`",
        "- `./owner:makeThing`",
        "",
      ].join("\n"),
    });
    assert.ok(
      duplicate.some((failure) =>
        failure.includes("owner source symbol ./owner:makeThing maps to multiple root names"),
      ),
    );
  });

  withFixture((fixture) => {
    const duplicateAlias = failuresFor(fixture, {
      root: 'export { Widget, WidgetAlias } from "./owner";\n',
      owner: 'export { Widget, Widget as WidgetAlias } from "./leaf";\n',
      intents: [
        "## Public exports",
        "",
        "- `.:Widget`",
        "- `.:WidgetAlias`",
        "- `./owner:Widget`",
        "- `./owner:WidgetAlias`",
        "",
      ].join("\n"),
    });
    assert.ok(
      duplicateAlias.some((failure) =>
        failure.includes("owner source symbol ./owner:Widget maps to multiple root names"),
      ),
    );
  });
});
