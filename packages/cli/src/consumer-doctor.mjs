import { releaseStatusData } from "./release-status.mjs";
import { resolveConsumerRoot } from "./consumer-overlay.mjs";

const doctorSchemaVersion = 1;

const parseArgs = (args) => {
  const parsed = { _: [] };
  const booleanKeys = new Set(["json", "check-npm"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      parsed[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (booleanKeys.has(key)) {
      parsed[key] = true;
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
};

const boolArg = (args, name) => args[name] === true || args[name] === "true";

const doctorGate = (releaseGate) => ({
  status: releaseGate.hardFailures.length > 0 ? "fail" : "pass",
  hardFailures: releaseGate.hardFailures,
  signals: releaseGate.signals,
  owner: "releaseGate + consumer check hard failures",
});

const privateImportProjection = () => ({
  status: "not_checked",
  owner: "installed package.json#exports",
  reason:
    "consumer import graph evidence is unavailable; doctor does not use private path blacklists",
});

export const consumerDoctorData = (input = {}) => {
  const release = releaseStatusData({
    context: input.context,
    consumerRoot: input.consumerRoot,
    checkNpm: input.checkNpm,
    registry: input.registry,
  });
  return {
    schemaVersion: doctorSchemaVersion,
    consumerRoot: input.consumerRoot,
    release,
    consumer: release.consumer,
    projections: {
      source: release.source,
      artifacts: release.artifacts,
      exportEquivalence: release.exportEquivalence,
      npm: release.npm,
      workspaceOverlay: release.consumer?.workspaceOverlay,
      packageIntegrity: release.consumer?.packageIntegrity,
      sourceFreshness: release.consumer?.sourceFreshness,
      privateImports: privateImportProjection(),
    },
    gate: doctorGate(release.gate),
  };
};

const printDoctor = (doctor) => {
  console.log(`doctor: ${doctor.consumerRoot}`);
  console.log(`release version: ${doctor.release.release.version}`);
  console.log(`truth mode: ${doctor.consumer?.truthMode ?? "unknown"}`);
  console.log(`export equivalence: ${doctor.projections.exportEquivalence.status}`);
  console.log(
    `workspace overlay: ${doctor.projections.workspaceOverlay?.status ?? "not_workspace"}`,
  );
  console.log(`private imports: ${doctor.projections.privateImports.status}`);
  console.log(`gate: ${doctor.gate.status}`);
  for (const failure of doctor.gate.hardFailures) {
    console.log(`failure ${failure.code}: ${failure.message}`);
  }
  for (const signal of doctor.gate.signals) {
    console.log(`signal ${signal.code}: ${signal.message}`);
  }
};

export const consumerDoctor = (rawArgs, context = {}) => {
  const args = parseArgs(rawArgs);
  const positional = args._ ?? [];
  if (positional.length !== 1) {
    throw new Error("agentos consumer doctor: expected /path/to/consumer");
  }
  const consumerRoot = resolveConsumerRoot(positional[0]);
  const doctor = consumerDoctorData({
    context,
    consumerRoot,
    checkNpm: boolArg(args, "check-npm"),
    registry: typeof args.registry === "string" ? args.registry : undefined,
  });
  if (boolArg(args, "json")) {
    console.log(JSON.stringify(doctor, null, 2));
  } else {
    printDoctor(doctor);
  }
};
