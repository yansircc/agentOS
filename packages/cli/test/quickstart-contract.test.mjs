import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseQuickstartBlocks,
  verifyQuickstartContract,
} from "../../../tooling/distribution/quickstart-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const contractPath = path.join(
  "/Users/yansir/code/52/agentOS",
  ".cst/artifacts/quickstart-contract-v1/contract.json",
);
const quickstart = () => fs.readFileSync(path.join(root, "docs/guides/quickstart-node.md"), "utf8");

test("executable quickstart satisfies the frozen contract", () => {
  const result = verifyQuickstartContract({ root, contractPath });
  assert.equal(result.contractId, "agentos-node-quickstart-v1");
  assert.deepEqual(result.commands, ["build", "install", "read_projection", "serve", "submit"]);
});

test("quickstart parser rejects a missing required authored file", () => {
  const markdown = quickstart().replace(
    /^```agentos-file path=agent\/agent\.json\n[\s\S]*?^```\s*$/mu,
    "",
  );
  assert.throws(
    () => verifyQuickstartContract({ root, contractPath, markdown }),
    /missing authored files: agent\/agent\.json/u,
  );
});

test("quickstart parser rejects manual advanced imports", () => {
  const markdown = `${quickstart()}\n\`\`\`agentos-file path=agent/custom.ts\nimport { Ledger } from "@yansirplus/runtime";\nvoid Ledger;\n\`\`\`\n`;
  assert.throws(
    () => verifyQuickstartContract({ root, contractPath, markdown }),
    /manually imports non-default surface @yansirplus\/runtime/u,
  );
});

test("quickstart parser rejects non-canonical package runners", () => {
  const markdown = quickstart().replace("pnpm exec agentos build", "bun run agentos build");
  assert.throws(
    () => verifyQuickstartContract({ root, contractPath, markdown }),
    /build must use pnpm/u,
  );
});

test("marked blocks have unique stable identities", () => {
  const blocks = parseQuickstartBlocks(quickstart());
  assert.equal(blocks.files.size, 3);
  assert.equal(blocks.commands.size, 5);
});
