import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { rcExactSpec, rcNextSpec, rcVersion } from "./rc-constants.js";
import { compareRegistryEvidence, installAndVerifyRegistryTarget } from "./rc-registry.js";
import { runV3TypescriptConsumers } from "./rc-typescript.js";
import { createCheck, deepEqual, nodeMajor, statusCounts, writeJson, writeText } from "./rc-utils.js";

function sanitizedLog(value, temporaryRoot) {
  return String(value).replaceAll(temporaryRoot, "[temporary-root]");
}

function parseArgs(argv) {
  const options = {
    outputPath: `reports/rc/package-surface-node-${nodeMajor()}.json`,
    logPath: `reports/rc/logs/package-surface-node-${nodeMajor()}.log`,
    expectedNodeMajor: null
  };
  const fields = new Map([
    ["--output", "outputPath"],
    ["--log", "logPath"],
    ["--node-major", "expectedNodeMajor"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) {
      throw new Error(`Invalid package-surface argument: ${argv[index]}`);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  return options;
}

export async function runRcPackageSurface(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const actualNodeMajor = nodeMajor();
  const outputPath = path.resolve(cwd, options.outputPath ?? `reports/rc/package-surface-node-${actualNodeMajor}.json`);
  const logPath = path.resolve(cwd, options.logPath ?? `reports/rc/logs/package-surface-node-${actualNodeMajor}.log`);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "specqr-rc-surface-"));

  try {
    const exact = await installAndVerifyRegistryTarget(rcExactSpec, { parentRoot: temporaryRoot });
    const next = await installAndVerifyRegistryTarget(rcNextSpec, { parentRoot: temporaryRoot });
    const exactTypes = await runV3TypescriptConsumers(exact.packageRoot, { cwd });
    const nextTypes = await runV3TypescriptConsumers(next.packageRoot, { cwd });
    const registryComparison = compareRegistryEvidence(exact.evidence, next.evidence);
    const checks = [
      createCheck("node-major", !options.expectedNodeMajor || actualNodeMajor === String(options.expectedNodeMajor), {
        expected: options.expectedNodeMajor ?? actualNodeMajor,
        actual: actualNodeMajor
      }),
      createCheck("exact-registry-integrity", exact.evidence.status === "pass"),
      createCheck("next-registry-integrity", next.evidence.status === "pass"),
      createCheck("exact-next-registry-equivalence", registryComparison.status === "pass"),
      createCheck("exact-types", exactTypes.every((check) => check.status === "passed"), {
        checkCount: exactTypes.length
      }),
      createCheck("next-types", nextTypes.every((check) => check.status === "passed"), {
        checkCount: nextTypes.length
      }),
      createCheck("exact-next-types-equivalence", deepEqual(exactTypes, nextTypes)),
      createCheck("resolved-version", exact.evidence.resolvedVersion === rcVersion && next.evidence.resolvedVersion === rcVersion)
    ];
    const summary = statusCounts(checks);
    const evidence = {
      schemaVersion: 1,
      kind: "specqr-rc-package-surface",
      generatedAt: new Date().toISOString(),
      commit: process.env.SPECQR_EVIDENCE_COMMIT ?? process.env.GITHUB_SHA ?? null,
      runtime: {
        node: process.version,
        nodeMajor: actualNodeMajor,
        platform: process.platform,
        arch: process.arch
      },
      targets: {
        exact: {
          registry: exact.evidence,
          typescript: exactTypes
        },
        next: {
          registry: next.evidence,
          typescript: nextTypes
        }
      },
      selectorComparison: registryComparison,
      checks,
      summary,
      status: summary.failed === 0 ? "pass" : "blocked"
    };
    await writeJson(outputPath, evidence);
    await writeText(logPath, [
      `Node ${process.version}`,
      "",
      "## exact",
      sanitizedLog(exact.log, temporaryRoot),
      "",
      "## next",
      sanitizedLog(next.log, temporaryRoot)
    ].join("\n"));
    return evidence;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await runRcPackageSurface(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      ok: result.status === "pass",
      node: result.runtime.node,
      exact: result.targets.exact.registry.resolvedVersion,
      next: result.targets.next.registry.resolvedVersion,
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
