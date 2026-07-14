import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const quickstartDocument = "docs/guides/quickstart-node.md";

const fail = (message) => {
  throw new Error(`quickstart contract: ${message}`);
};

const singleAttribute = (rawAttributes, expectedName) => {
  const entries = rawAttributes.trim().split(/\s+/u).filter(Boolean);
  if (entries.length !== 1) {
    fail(`blocks require exactly one ${expectedName} attribute`);
  }
  const separator = entries[0].indexOf("=");
  if (separator <= 0 || separator === entries[0].length - 1) {
    fail(`invalid block attribute ${entries[0]}`);
  }
  const name = entries[0].slice(0, separator);
  const value = entries[0].slice(separator + 1);
  if (name !== expectedName) {
    fail(`expected ${expectedName} attribute, received ${name}`);
  }
  return value;
};

const safeDocumentPath = (value) => {
  if (
    !/^[0-9A-Za-z._/-]+$/u.test(value) ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    fail(`file block path must be a safe relative POSIX path: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`file block path must be normalized: ${value}`);
  }
  return value;
};

const commandId = (value) => {
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) {
    fail(`command id must match [a-z][a-z0-9-]*: ${value}`);
  }
  return value;
};

export const parseQuickstartBlocks = (markdown) => {
  const blocks = [];
  const filePaths = new Set();
  const commandIds = new Set();
  const markerCount = [...markdown.matchAll(/^```agentos-[^\r\n]*/gmu)].length;
  const pattern = /^```agentos-(file|command)([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*$/gmu;

  for (const match of markdown.matchAll(pattern)) {
    const [, kind, rawAttributes, body] = match;
    if (kind === "file") {
      const filePath = safeDocumentPath(singleAttribute(rawAttributes, "path"));
      if (filePaths.has(filePath)) fail(`duplicate file block ${filePath}`);
      filePaths.add(filePath);
      blocks.push({ kind, path: filePath, body });
      continue;
    }
    const id = commandId(singleAttribute(rawAttributes, "id"));
    if (commandIds.has(id)) fail(`duplicate command block ${id}`);
    commandIds.add(id);
    blocks.push({ kind, id, body });
  }

  if (blocks.length !== markerCount) fail("document contains an invalid marked quickstart block");
  if (blocks.length === 0) fail("document has no marked quickstart blocks");
  return blocks;
};

export const readQuickstartBlocks = ({ root = repoRoot } = {}) =>
  parseQuickstartBlocks(fs.readFileSync(path.join(root, quickstartDocument), "utf8"));

const materializedPath = (root, filePath) => {
  const target = path.resolve(root, ...filePath.split("/"));
  const relative = path.relative(path.resolve(root), target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`file block escapes the consumer root: ${filePath}`);
  }
  return target;
};

const receiptFor = (filePath, bytes) => ({
  path: filePath,
  byteLength: bytes.byteLength,
  sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
});

export const verifyMaterializedQuickstartFiles = ({ root, blocks }) =>
  blocks
    .filter((block) => block.kind === "file")
    .map((block) => {
      const expected = Buffer.from(block.body, "utf8");
      const target = materializedPath(root, block.path);
      if (!fs.existsSync(target)) fail(`materialized file is missing: ${block.path}`);
      const actual = fs.readFileSync(target);
      if (!actual.equals(expected)) fail(`materialized file byte readback mismatch: ${block.path}`);
      return receiptFor(block.path, actual);
    });

export const materializeQuickstartFiles = ({ root, blocks }) => {
  fs.mkdirSync(root, { recursive: true });
  for (const block of blocks) {
    if (block.kind !== "file") continue;
    const target = materializedPath(root, block.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(block.body, "utf8"));
  }
  return verifyMaterializedQuickstartFiles({ root, blocks });
};
