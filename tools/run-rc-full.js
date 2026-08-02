import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { compareRcReportFiles } from "./compare-rc-reports.js";
import {
  rcBaselineSpec,
  rcExactSpec,
  rcNextSpec,
  rcReportDirectory,
  rcVersion
} from "./rc-constants.js";
import {
  compareRegistryEvidence,
  installAndVerifyRegistryTarget,
  installRegistryPackage
} from "./rc-registry.js";
import { createCheck, nodeMajor, statusCounts, writeJson, writeText } from "./rc-utils.js";
import { compareV3ContractEvidence, verifyV3Contract } from "./verify-v3-contract.js";

function parseArgs(argv) {
  const options = {
    outputDirectory: `${rcReportDirectory}/full`,
    requiredNodeMajor: null
  };
  const fields = new Map([
    ["--output-directory", "outputDirectory"],
    ["--require-node", "requiredNodeMajor"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) {
      throw new Error(`Invalid full RC argument: ${argv[index]}`);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  return options;
}

function runChild(cwd, packageRoot, args, logPath, temporaryRoot) {
  const run = spawnSync(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      SPECQR_CONFORMANCE_PACKAGE_ROOT: packageRoot
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  const log = [
    `$ node ${args.join(" ")}`,
    run.stdout?.trimEnd(),
    run.stderr?.trimEnd()
  ].filter(Boolean).join("\n").replaceAll(temporaryRoot, "[temporary-root]");
  return writeText(logPath, log).then(() => {
    if (run.status !== 0) {
      throw new Error(`RC child process failed with ${run.status}; see ${logPath}`);
    }
  });
}

async function readPackageVersion(packageRoot) {
  return JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version;
}

export async function runRcFull(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const actualNodeMajor = nodeMajor();
  const outputDirectory = path.resolve(cwd, options.outputDirectory ?? `${rcReportDirectory}/full`);
  const logsDirectory = path.join(outputDirectory, "logs");
  await rm(outputDirectory, { recursive: true, force: true });
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "specqr-rc-full-"));

  try {
    const baseline = await installRegistryPackage(rcBaselineSpec, { parentRoot: temporaryRoot });
    const exact = await installAndVerifyRegistryTarget(rcExactSpec, { parentRoot: temporaryRoot });
    const next = await installAndVerifyRegistryTarget(rcNextSpec, { parentRoot: temporaryRoot });
    const baselineVersion = await readPackageVersion(baseline.packageRoot);
    await writeJson(path.join(outputDirectory, "baseline-install.json"), {
      schemaVersion: 1,
      requested: rcBaselineSpec,
      resolvedVersion: baselineVersion,
      source: "npm-registry",
      status: baselineVersion === "2.4.0" ? "pass" : "blocked"
    });
    await writeJson(path.join(outputDirectory, "registry-exact.json"), exact.evidence);
    await writeJson(path.join(outputDirectory, "registry-next.json"), next.evidence);
    const registryComparison = compareRegistryEvidence(exact.evidence, next.evidence);
    await writeJson(path.join(outputDirectory, "registry-comparison.json"), registryComparison);
    await writeText(
      path.join(logsDirectory, "registry-baseline.log"),
      baseline.logs.join("\n\n").replaceAll(temporaryRoot, "[temporary-root]")
    );
    await writeText(path.join(logsDirectory, "registry-exact.log"), exact.log.replaceAll(temporaryRoot, "[temporary-root]"));
    await writeText(path.join(logsDirectory, "registry-next.log"), next.log.replaceAll(temporaryRoot, "[temporary-root]"));

    const targets = [
      { id: "baseline", requested: rcBaselineSpec, packageRoot: baseline.packageRoot },
      { id: "exact", requested: rcExactSpec, packageRoot: exact.packageRoot },
      { id: "next", requested: rcNextSpec, packageRoot: next.packageRoot }
    ];
    for (const target of targets) {
      await runChild(cwd, target.packageRoot, [
        "tools/run-rc-conformance-child.js",
        "--requested",
        target.requested,
        "--output",
        path.join(outputDirectory, `conformance-${target.id}.json`),
        "--integrity-output",
        path.join(outputDirectory, `conformance-${target.id}-integrity.json`)
      ], path.join(logsDirectory, `conformance-${target.id}.log`), temporaryRoot);
    }

    const comparisons = {};
    for (const targetId of ["exact", "next"]) {
      comparisons[targetId] = await compareRcReportFiles({
        basePath: path.join(outputDirectory, "conformance-baseline.json"),
        candidatePath: path.join(outputDirectory, `conformance-${targetId}.json`),
        jsonOutputPath: path.join(outputDirectory, `comparison-baseline-${targetId}.json`),
        markdownOutputPath: path.join(outputDirectory, `comparison-baseline-${targetId}.md`)
      });
    }
    const selectorConformance = await compareRcReportFiles({
      basePath: path.join(outputDirectory, "conformance-exact.json"),
      candidatePath: path.join(outputDirectory, "conformance-next.json"),
      jsonOutputPath: path.join(outputDirectory, "comparison-exact-next.json"),
      markdownOutputPath: path.join(outputDirectory, "comparison-exact-next.md"),
      kind: "specqr-rc-selector-conformance-comparison"
    });

    const exactContract = await verifyV3Contract({
      cwd,
      packageRoot: exact.packageRoot,
      requested: rcExactSpec,
      outputPath: path.join(outputDirectory, "v3-contract-exact.json")
    });
    const nextContract = await verifyV3Contract({
      cwd,
      packageRoot: next.packageRoot,
      requested: rcNextSpec,
      outputPath: path.join(outputDirectory, "v3-contract-next.json")
    });
    const contractComparison = compareV3ContractEvidence(exactContract, nextContract);
    await writeJson(path.join(outputDirectory, "v3-contract-comparison.json"), contractComparison);

    const integrity = {};
    for (const target of targets) {
      integrity[target.id] = JSON.parse(await readFile(
        path.join(outputDirectory, `conformance-${target.id}-integrity.json`),
        "utf8"
      ));
    }
    const checks = [
      createCheck("node-major", !options.requiredNodeMajor || actualNodeMajor === String(options.requiredNodeMajor), {
        expected: options.requiredNodeMajor ?? actualNodeMajor,
        actual: actualNodeMajor
      }),
      createCheck("baseline-version", baselineVersion === "2.4.0", { actual: baselineVersion }),
      createCheck("exact-version", exact.evidence.resolvedVersion === rcVersion, { actual: exact.evidence.resolvedVersion }),
      createCheck("next-version", next.evidence.resolvedVersion === rcVersion, { actual: next.evidence.resolvedVersion }),
      createCheck("registry-integrity", registryComparison.status === "pass"),
      createCheck("baseline-report-integrity", integrity.baseline.status === "pass"),
      createCheck("exact-report-integrity", integrity.exact.status === "pass"),
      createCheck("next-report-integrity", integrity.next.status === "pass"),
      createCheck("baseline-exact-common", comparisons.exact.status === "pass"),
      createCheck("baseline-next-common", comparisons.next.status === "pass"),
      createCheck("exact-next-common", selectorConformance.status === "pass"),
      createCheck("exact-v3-contract", exactContract.status === "pass", { requiredCheckCount: exactContract.requiredCheckCount }),
      createCheck("next-v3-contract", nextContract.status === "pass", { requiredCheckCount: nextContract.requiredCheckCount }),
      createCheck("exact-next-v3-contract", contractComparison.status === "pass")
    ];
    const summary = statusCounts(checks);
    const evidence = {
      schemaVersion: 1,
      kind: "specqr-rc-full-evidence",
      generatedAt: new Date().toISOString(),
      commit: process.env.SPECQR_EVIDENCE_COMMIT ?? process.env.GITHUB_SHA ?? null,
      runtime: {
        node: process.version,
        nodeMajor: actualNodeMajor,
        platform: process.platform,
        arch: process.arch
      },
      targets: {
        baseline: { requested: rcBaselineSpec, resolvedVersion: baselineVersion },
        exact: { requested: rcExactSpec, resolvedVersion: exact.evidence.resolvedVersion },
        next: { requested: rcNextSpec, resolvedVersion: next.evidence.resolvedVersion }
      },
      paths: {
        registryExact: "registry-exact.json",
        registryNext: "registry-next.json",
        registryComparison: "registry-comparison.json",
        baselineReport: "conformance-baseline.json",
        exactReport: "conformance-exact.json",
        nextReport: "conformance-next.json",
        comparisonExact: "comparison-baseline-exact.json",
        comparisonNext: "comparison-baseline-next.json",
        selectorComparison: "comparison-exact-next.json",
        v3Exact: "v3-contract-exact.json",
        v3Next: "v3-contract-next.json",
        v3Comparison: "v3-contract-comparison.json"
      },
      checks,
      summary,
      status: summary.failed === 0 ? "pass" : "blocked"
    };
    await writeJson(path.join(outputDirectory, "full.json"), evidence);
    return evidence;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await runRcFull(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      ok: result.status === "pass",
      runtime: result.runtime,
      targets: result.targets,
      checks: result.summary,
      status: result.status
    }, null, 2));
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
