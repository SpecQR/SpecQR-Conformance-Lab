import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  rcExpandedSha256,
  rcRequiredNodeMajors,
  rcTarballSha256,
  rcVersion
} from "./rc-constants.js";
import { createCheck, deepEqual, readJson, statusCounts } from "./rc-utils.js";
import { validateSchemaValue } from "./validate-schemas.js";

function parseArgs(argv) {
  const options = { reportPath: "reports/rc/readiness.json" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--report" || !argv[index + 1]) {
      throw new Error(`Invalid RC readiness validation argument: ${argv[index]}`);
    }
    options.reportPath = argv[index + 1];
    index += 1;
  }
  return options;
}

export async function validateRcReadiness(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const report = await readJson(path.resolve(cwd, options.reportPath ?? "reports/rc/readiness.json"));
  const schema = await readJson(path.resolve(cwd, "schemas/rc-readiness-v1.schema.json"));
  const schemaResult = validateSchemaValue(report, schema);
  const checks = [
    createCheck("schema", schemaResult.ok, { errors: schemaResult.errors }),
    createCheck("technical-status", report.technicalStatus === "pass", { actual: report.technicalStatus }),
    createCheck("observation-status-boundary", report.observationStatus === "pending", { actual: report.observationStatus }),
    createCheck("release-version", report.release?.version === rcVersion, { actual: report.release?.version }),
    createCheck("target-resolution", report.targets?.baseline?.resolvedVersion === "2.4.0" && report.targets?.exact?.resolvedVersion === rcVersion && report.targets?.next?.resolvedVersion === rcVersion),
    createCheck("tarball-sha256", report.registryIntegrity?.exact?.hashes?.tarballSha256 === rcTarballSha256),
    createCheck("expanded-sha256", report.registryIntegrity?.exact?.hashes?.expandedSha256 === rcExpandedSha256),
    createCheck("selector-hashes", deepEqual(report.registryIntegrity?.exact?.hashes, report.registryIntegrity?.next?.hashes)),
    createCheck("selector-runtime", report.registryIntegrity?.exact?.exportsFingerprint === report.registryIntegrity?.next?.exportsFingerprint && report.registryIntegrity?.exact?.runtimeFingerprint === report.registryIntegrity?.next?.runtimeFingerprint && report.registryIntegrity?.selectorComparison?.status === "pass"),
    createCheck("runtime-dependencies-zero", report.registryIntegrity?.exact?.runtimeDependencyCount === 0 && report.registryIntegrity?.next?.runtimeDependencyCount === 0),
    createCheck("full-node-22", report.toolchain?.full?.nodeMajor === "22" && report.toolchain?.full?.status === "pass"),
    createCheck("node-matrix", deepEqual(report.toolchain?.packageSurface?.map((entry) => entry.nodeMajor), rcRequiredNodeMajors) && report.toolchain.packageSurface.every((entry) => entry.status === "pass")),
    createCheck("common-regression", ["exact", "next", "selector"].every((key) => {
      const result = report.conformance?.common?.[key];
      return result?.status === "pass" && result.blockingRegressionCount === 0;
    })),
    createCheck("v3-contract", report.v3Contract?.exact?.status === "pass" && report.v3Contract?.next?.status === "pass" && report.v3Contract?.exact?.requiredCheckCount > 0 && report.v3Contract?.exact?.requiredCheckCount === report.v3Contract?.next?.requiredCheckCount && report.v3Contract?.selectorComparison?.status === "pass"),
    createCheck("artifacts", report.artifacts?.files?.length > 0)
  ];
  const summary = statusCounts(checks);
  return {
    ok: summary.failed === 0,
    report: options.reportPath ?? "reports/rc/readiness.json",
    checks,
    summary
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await validateRcReadiness(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
