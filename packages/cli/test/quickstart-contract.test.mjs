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
const quickstart = () => fs.readFileSync(path.join(root, "docs/guides/quickstart-node.md"), "utf8");

test("canonical ask quickstart satisfies the positive contract", () => {
  const result = verifyQuickstartContract({ root });
  assert.equal(result.contractId, "agentos-ask-quickstart-v1");
  assert.deepEqual(result.files, ["agent/instructions.md", "agent/agent.json"]);
  assert.deepEqual(result.commands, ["install", "ask"]);
});

test("quickstart parser rejects a missing required authored file", () => {
  const markdown = quickstart().replace(
    /^```agentos-file path=agent\/agent\.json\n[\s\S]*?^```\s*$/mu,
    "",
  );
  assert.throws(
    () => verifyQuickstartContract({ root, markdown }),
    /file blocks must be exactly agent\/instructions\.md, agent\/agent\.json/u,
  );
});

test("quickstart contract rejects an extra authored file", () => {
  const markdown = `${quickstart()}\n\`\`\`agentos-file path=agent/custom.ts\nimport { Ledger } from "@yansirplus/runtime";\nvoid Ledger;\n\`\`\`\n`;
  assert.throws(
    () => verifyQuickstartContract({ root, markdown }),
    /file blocks must be exactly agent\/instructions\.md, agent\/agent\.json/u,
  );
});

test("quickstart contract rejects legacy product intent fields", () => {
  const markdown = quickstart().replace(
    '  "kind": "workspace"',
    '  "kind": "workspace",\n  "scope": { "kind": "session" }',
  );
  assert.throws(
    () => verifyQuickstartContract({ root, markdown }),
    /agent\/agent\.json fields must be exactly agentId, kind/u,
  );
});

test("quickstart contract rejects a non-workspace product intent", () => {
  const markdown = quickstart().replace('"kind": "workspace"', '"kind": "chat"');
  assert.throws(
    () => verifyQuickstartContract({ root, markdown }),
    /agent\/agent\.json kind must be workspace/u,
  );
});

test("quickstart contract rejects command drift", () => {
  const markdown = quickstart().replace("pnpm exec agentos ask", "bun run agentos ask");
  assert.throws(
    () => verifyQuickstartContract({ root, markdown }),
    /ask command must be pnpm exec agentos ask/u,
  );
});

test("marked blocks have unique stable identities", () => {
  const blocks = parseQuickstartBlocks(quickstart());
  assert.deepEqual([...blocks.files.keys()], ["agent/instructions.md", "agent/agent.json"]);
  assert.deepEqual([...blocks.commands.keys()], ["install", "ask"]);
});
