#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

const reportPath = ".agentos-audits/value-domains.json";
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".md", ".json"]);
const skippedPrefixes = [
  ".cst/",
  ".parallel/",
  ".wrangler/",
  "dist/",
  "node_modules/",
  "tooling/docs-site/src/content/",
];

const patterns = [
  {
    id: "value-domain-token",
    reason: "Authored/Recorded/Live vocabulary should be source-owned, not free prose or ad hoc aliases.",
    regex: /\b(?:Authored|Recorded|Live)(?:<|\b)/gu,
  },
  {
    id: "recorded-payload-token",
    reason: "RecordedPayload must stay independent from browser-safe projection payloads.",
    regex: /\bRecordedPayload(?:Value)?\b/gu,
  },
  {
    id: "safe-ledger-projection-token",
    reason: "SafeLedgerPayload is a browser-safe projection, not the Recorded payload base.",
    regex: /\bSafeLedgerPayload\b/gu,
  },
  {
    id: "live-material-token",
    reason: "Resolved material, credentials, secrets, and env reads belong at Live adapter/driver edges.",
    regex: /\b(?:ResolvedMaterial|credential|credentials|secret|secrets|process\.env)\b/giu,
  },
  {
    id: "runtime-fact-in-intent-token",
    reason: "Continuation refs, snapshots, and trigger time are runtime facts, not authored intent.",
    regex: /\b(?:ContinuationRef|snapshot|snapshotRef|triggerTime|hasRun)\b/gu,
  },
];

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .filter((file) => sourceExtensions.has(extname(file)))
  .filter((file) => !skippedPrefixes.some((prefix) => file.startsWith(prefix)));

const lineNumberAt = (source, index) => source.slice(0, index).split("\n").length;

const suspects = [];

for (const file of trackedFiles) {
  const source = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern.regex)) {
      suspects.push({
        file,
        line: lineNumberAt(source, match.index ?? 0),
        pattern: pattern.id,
        token: match[0],
        reason: pattern.reason,
      });
    }
  }
}

suspects.sort((left, right) =>
  left.file.localeCompare(right.file) ||
  left.line - right.line ||
  left.pattern.localeCompare(right.pattern) ||
  left.token.localeCompare(right.token),
);

const report = {
  kind: "agentos.value_domain_suspect_audit",
  mode: "suspect_only",
  generatedAt: new Date().toISOString(),
  scannedFiles: trackedFiles.length,
  suspectCount: suspects.length,
  reportPath,
  note:
    "Diagnostic only. This report is not a baseline, allowlist, root check, or positive boundary contract.",
  suspects,
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `value-domain suspect audit wrote ${join(process.cwd(), reportPath)} (${suspects.length} suspects)`,
);
