import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  materializeQuickstartFiles,
  parseQuickstartBlocks,
  verifyMaterializedQuickstartFiles,
} from "../../../tooling/distribution/quickstart-contract.mjs";
import { packedPnpmArgsFor } from "../../../tooling/distribution/consumer.mjs";

const arbitraryQuickstart = [
  "intro",
  "",
  "```agentos-command id=prepare",
  "printf 'ready\\n'",
  "```",
  "",
  "```agentos-file path=agent/z.txt",
  "first  ",
  "",
  "```",
  "",
  "```agentos-file path=agent/a.json",
  '{"ok":true}',
  "```",
  "",
  "```agentos-command id=run-proof",
  "node proof.mjs  ",
  "```",
  "",
].join("\n");

test("quickstart grammar preserves encounter order and exact body bytes", () => {
  const blocks = parseQuickstartBlocks(arbitraryQuickstart);
  assert.deepEqual(
    blocks.map((block) =>
      block.kind === "file" ? `${block.kind}:${block.path}` : `${block.kind}:${block.id}`,
    ),
    ["command:prepare", "file:agent/z.txt", "file:agent/a.json", "command:run-proof"],
  );
  assert.equal(blocks[0].body, "printf 'ready\\n'\n");
  assert.equal(blocks[1].body, "first  \n\n");
  assert.equal(blocks[2].body, '{"ok":true}\n');
  assert.equal(blocks[3].body, "node proof.mjs  \n");
});

test("materializer writes and reads back the parsed file bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-quickstart-materialize-"));
  try {
    const blocks = parseQuickstartBlocks(arbitraryQuickstart);
    const receipts = materializeQuickstartFiles({ root, blocks });
    assert.deepEqual(
      receipts.map((receipt) => receipt.path),
      ["agent/z.txt", "agent/a.json"],
    );
    assert.equal(fs.readFileSync(path.join(root, "agent/z.txt"), "utf8"), "first  \n\n");
    assert.equal(fs.readFileSync(path.join(root, "agent/a.json"), "utf8"), '{"ok":true}\n');
    assert.deepEqual(verifyMaterializedQuickstartFiles({ root, blocks }), receipts);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("byte readback rejects post-materialization drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-quickstart-tamper-"));
  try {
    const blocks = parseQuickstartBlocks(arbitraryQuickstart);
    materializeQuickstartFiles({ root, blocks });
    fs.appendFileSync(path.join(root, "agent/a.json"), " ");
    assert.throws(
      () => verifyMaterializedQuickstartFiles({ root, blocks }),
      /materialized file byte readback mismatch: agent\/a\.json/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("grammar rejects duplicate file and command identities", () => {
  assert.throws(
    () =>
      parseQuickstartBlocks(
        "```agentos-file path=agent/a.txt\na\n```\n```agentos-file path=agent/a.txt\nb\n```\n",
      ),
    /duplicate file block agent\/a\.txt/u,
  );
  assert.throws(
    () =>
      parseQuickstartBlocks(
        "```agentos-command id=run\ntrue\n```\n```agentos-command id=run\ntrue\n```\n",
      ),
    /duplicate command block run/u,
  );
});

test("grammar rejects paths outside the normalized relative POSIX algebra", () => {
  for (const filePath of [
    "/absolute",
    "../escape",
    "agent/../escape",
    "agent\\escape",
    "agent//x",
  ]) {
    assert.throws(
      () => parseQuickstartBlocks(`\`\`\`agentos-file path=${filePath}\nx\n\`\`\`\n`),
      /file block path must be/u,
    );
  }
});

test("grammar rejects malformed marked blocks instead of ignoring them", () => {
  assert.throws(
    () => parseQuickstartBlocks("```agentos-file path=a.txt extra=yes\nx\n```\n"),
    /exactly one path attribute/u,
  );
  assert.throws(
    () => parseQuickstartBlocks("```agentos-command id=UPPER\ntrue\n```\n"),
    /command id must match/u,
  );
  assert.throws(
    () => parseQuickstartBlocks("```agentos-result id=run\nok\n```\n"),
    /invalid marked quickstart block/u,
  );
});

test("packed resolution changes all and only install package arguments", () => {
  const resolutions = [
    ["@example/alpha", "/tmp/alpha.tgz"],
    ["@example/beta", "/tmp/beta.tgz"],
  ];
  assert.deepEqual(
    packedPnpmArgsFor(
      ["add", "@example/alpha", "@example/beta@1.0.0", "external", "--save-exact"],
      resolutions,
    ),
    [
      "add",
      "@example/alpha@file:/tmp/alpha.tgz",
      "@example/beta@file:/tmp/beta.tgz",
      "external",
      "--save-exact",
    ],
  );
  assert.deepEqual(packedPnpmArgsFor(["exec", "tool", "@example/alpha"], resolutions), [
    "exec",
    "tool",
    "@example/alpha",
  ]);
});
