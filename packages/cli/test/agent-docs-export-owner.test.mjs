import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const exportedReference = (primitive) => {
  const separator = primitive.exportKey.lastIndexOf(":");
  const subpath = primitive.exportKey.slice(0, separator);
  const symbol = primitive.exportKey.slice(separator + 1);
  const specifier =
    subpath === "." ? primitive.package : `${primitive.package}/${subpath.slice(2)}`;
  return `${specifier}:${symbol}`;
};

void test("agent primitive markdown renders the exact exportKey owner", () => {
  const model = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "docs/agent/primitives.json"), "utf8"),
  );
  const markdown = fs.readFileSync(path.join(repoRoot, "docs/agent/primitives.md"), "utf8");
  const rows = new Map(
    markdown
      .split("\n")
      .filter((line) => line.startsWith("| `primitive."))
      .map((line) => {
        const cells = line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
        return [cells[0].slice(1, -1), cells[2].slice(1, -1)];
      }),
  );

  assert.equal(rows.size, model.primitives.length);
  for (const primitive of model.primitives) {
    assert.equal(rows.get(primitive.id), exportedReference(primitive), primitive.id);
  }
});
