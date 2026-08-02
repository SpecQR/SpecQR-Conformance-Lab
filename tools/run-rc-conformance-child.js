import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { activeAdapters, readSuites, runConformance } from "./run-conformance.js";
import { suitesForTarget } from "./rc-target-suites.js";
import { writeJson } from "./rc-utils.js";
import { verifyReportObject } from "./verify-report.js";

function parseArgs(argv) {
  const options = {};
  const fields = new Map([
    ["--requested", "requested"],
    ["--output", "output"],
    ["--integrity-output", "integrityOutput"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) {
      throw new Error(`Invalid RC conformance argument: ${argv[index]}`);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  for (const field of fields.values()) {
    if (!options[field]) {
      throw new Error(`RC conformance requires ${field}`);
    }
  }
  return options;
}

export async function runRcConformanceChild(options) {
  const cwd = options.cwd ?? process.cwd();
  const packageRoot = process.env.SPECQR_CONFORMANCE_PACKAGE_ROOT;
  if (!packageRoot || !path.isAbsolute(packageRoot)) {
    throw new Error("SPECQR_CONFORMANCE_PACKAGE_ROOT must be an absolute temporary install path");
  }

  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name !== "specqr" || typeof packageJson.version !== "string") {
    throw new Error("Temporary install is not a published specqr package");
  }
  const targetSuites = suitesForTarget(await readSuites({ cwd }), packageJson.version);
  const result = await runConformance({
    cwd,
    suites: targetSuites.suites,
    adapters: activeAdapters,
    outputPath: options.output,
    metadataOptions: {
      cwd,
      targetRequested: options.requested,
      targetSource: "npm-registry",
      packageRoots: {
        specqr: packageRoot
      }
    }
  });
  const integrity = await verifyReportObject(result.report, {
    cwd,
    suites: targetSuites.suites,
    adapters: activeAdapters
  });
  const failedOrError = result.report.summary.failed + result.report.summary.error;
  const evidence = {
    schemaVersion: 1,
    kind: "specqr-rc-conformance-integrity",
    requested: options.requested,
    resolvedVersion: packageJson.version,
    report: path.relative(cwd, path.resolve(cwd, options.output)),
    normalizations: targetSuites.normalizations,
    reportIntegrity: integrity,
    requiredOutcome: {
      failed: result.report.summary.failed,
      error: result.report.summary.error
    },
    status: integrity.ok && failedOrError === 0 ? "pass" : "blocked"
  };
  await writeJson(path.resolve(cwd, options.integrityOutput), evidence);
  return evidence;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await runRcConformanceChild(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
