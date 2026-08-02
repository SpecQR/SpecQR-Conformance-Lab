import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  rcExpandedSha256,
  rcExpectedDeltaCount,
  rcExpectedDeltaPolicyPath,
  rcExpectedDeltaPolicySchemaPath,
  rcExpectedDeltaPolicySchemaSha256,
  rcExpectedDeltaPolicySha256,
  rcFileCount,
  rcRequiredNodeMajors,
  rcTarballSha256,
  rcVersion
} from "./rc-constants.js";
import {
  adjudicateExpectedDeltas,
  compareExpectedDeltaAdjudications,
  loadExpectedDeltaPolicy
} from "./rc-expected-delta.js";
import { createCheck, deepEqual, readJson, sha256, stableStringify, statusCounts } from "./rc-utils.js";
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

export async function validateArtifactEvidence(report, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const files = report.artifacts?.files;
  const errors = [];
  const seen = new Set();

  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, fileCount: 0, errors: [{ path: "$.artifacts.files", message: "must contain evidence files" }] };
  }

  for (const [index, file] of files.entries()) {
    const reportPath = file?.path;
    if (typeof reportPath !== "string" || path.isAbsolute(reportPath)) {
      errors.push({ path: `$.artifacts.files[${index}].path`, message: "must be a safe relative path" });
      continue;
    }
    const absolutePath = path.resolve(cwd, reportPath);
    if (!absolutePath.startsWith(`${cwd}${path.sep}`)) {
      errors.push({ path: `$.artifacts.files[${index}].path`, message: "escapes the validation root" });
      continue;
    }
    if (seen.has(absolutePath)) {
      errors.push({ path: `$.artifacts.files[${index}].path`, message: "duplicates an evidence path" });
      continue;
    }
    seen.add(absolutePath);

    try {
      const metadata = await lstat(absolutePath);
      if (!metadata.isFile()) {
        errors.push({ path: reportPath, message: "is not a regular file" });
        continue;
      }
      const contents = await readFile(absolutePath);
      if (metadata.size !== file.size) {
        errors.push({ path: reportPath, message: "size does not match", expected: file.size, actual: metadata.size });
      }
      const actualSha256 = sha256(contents);
      if (actualSha256 !== file.sha256) {
        errors.push({ path: reportPath, message: "SHA-256 does not match", expected: file.sha256, actual: actualSha256 });
      }
    } catch (error) {
      errors.push({ path: reportPath, message: `cannot read evidence file: ${error.message}` });
    }
  }

  const actualArtifactSetSha256 = sha256(`${stableStringify(files)}\n`);
  if (actualArtifactSetSha256 !== report.artifacts?.artifactSetSha256) {
    errors.push({
      path: "$.artifacts.artifactSetSha256",
      message: "artifact set SHA-256 does not match",
      expected: report.artifacts?.artifactSetSha256,
      actual: actualArtifactSetSha256
    });
  }

  return { ok: errors.length === 0, fileCount: files.length, actualArtifactSetSha256, errors };
}

export async function validateRcReadiness(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const report = await readJson(path.resolve(cwd, options.reportPath ?? "reports/rc/readiness.json"));
  const schema = await readJson(path.resolve(cwd, "schemas/rc-readiness-v1.schema.json"));
  const schemaResult = validateSchemaValue(report, schema);
  const artifactResult = await validateArtifactEvidence(report, { cwd });
  const fullDirectory = path.resolve(cwd, "reports/rc/full");
  const [
    full,
    registryExact,
    registryNext,
    registryComparison,
    baselineReport,
    exactReport,
    nextReport,
    rawExact,
    rawNext,
    rawSelector,
    storedAdjudicationExact,
    storedAdjudicationNext,
    storedAdjudicationComparison,
    v3Exact,
    v3Next,
    v3Comparison,
    canonicalPolicyContext,
    snapshotPolicyContext
  ] = await Promise.all([
    readJson(path.join(fullDirectory, "full.json")),
    readJson(path.join(fullDirectory, "registry-exact.json")),
    readJson(path.join(fullDirectory, "registry-next.json")),
    readJson(path.join(fullDirectory, "registry-comparison.json")),
    readJson(path.join(fullDirectory, "conformance-baseline.json")),
    readJson(path.join(fullDirectory, "conformance-exact.json")),
    readJson(path.join(fullDirectory, "conformance-next.json")),
    readJson(path.join(fullDirectory, "comparison-baseline-exact.json")),
    readJson(path.join(fullDirectory, "comparison-baseline-next.json")),
    readJson(path.join(fullDirectory, "comparison-exact-next.json")),
    readJson(path.join(fullDirectory, "expected-delta-exact.json")),
    readJson(path.join(fullDirectory, "expected-delta-next.json")),
    readJson(path.join(fullDirectory, "expected-delta-comparison.json")),
    readJson(path.join(fullDirectory, "v3-contract-exact.json")),
    readJson(path.join(fullDirectory, "v3-contract-next.json")),
    readJson(path.join(fullDirectory, "v3-contract-comparison.json")),
    loadExpectedDeltaPolicy({ cwd }),
    loadExpectedDeltaPolicy({
      cwd,
      policyReadPath: "reports/rc/full/expected-delta-policy.json",
      schemaReadPath: "reports/rc/full/expected-delta-policy.schema.json"
    })
  ]);
  const surfaces = await Promise.all(rcRequiredNodeMajors.map((major) => {
    return readJson(path.resolve(cwd, `reports/rc/package-surface-node-${major}.json`));
  }));
  const evidenceFiles = (targetId) => ({
    baselineReport: "conformance-baseline.json",
    candidateReport: `conformance-${targetId}.json`,
    rawComparison: `comparison-baseline-${targetId}.json`,
    policySnapshot: "expected-delta-policy.json",
    policySchemaSnapshot: "expected-delta-policy.schema.json"
  });
  const recomputedAdjudicationExact = adjudicateExpectedDeltas({
    baseReport: baselineReport,
    candidateReport: exactReport,
    rawComparison: rawExact,
    policyContext: snapshotPolicyContext,
    expectedRequested: "specqr@3.0.0-rc.2",
    evidenceFiles: evidenceFiles("exact")
  });
  const recomputedAdjudicationNext = adjudicateExpectedDeltas({
    baseReport: baselineReport,
    candidateReport: nextReport,
    rawComparison: rawNext,
    policyContext: snapshotPolicyContext,
    expectedRequested: "specqr@next",
    evidenceFiles: evidenceFiles("next")
  });
  const recomputedAdjudicationComparison = compareExpectedDeltaAdjudications(
    recomputedAdjudicationExact,
    recomputedAdjudicationNext
  );
  const expectedArtifactPaths = [
    "reports/rc/full/expected-delta-policy.json",
    "reports/rc/full/expected-delta-policy.schema.json",
    "reports/rc/full/expected-delta-exact.json",
    "reports/rc/full/expected-delta-next.json",
    "reports/rc/full/expected-delta-comparison.json",
    "reports/rc/full/comparison-baseline-exact.json",
    "reports/rc/full/comparison-baseline-next.json",
    "reports/rc/full/comparison-exact-next.json"
  ];
  const artifactPaths = new Set(report.artifacts?.files?.map((file) => file.path));
  const reportExpectedDelta = report.expectedDelta;
  const checks = [
    createCheck("schema", schemaResult.ok, { errors: schemaResult.errors }),
    createCheck("technical-status", report.technicalStatus === "pass", { actual: report.technicalStatus }),
    createCheck("observation-status-boundary", report.observationStatus === "pending", { actual: report.observationStatus }),
    createCheck("release-version", report.release?.version === rcVersion, { actual: report.release?.version }),
    createCheck("target-resolution", report.targets?.baseline?.resolvedVersion === "2.4.0" && report.targets?.exact?.resolvedVersion === rcVersion && report.targets?.next?.resolvedVersion === rcVersion),
    createCheck("registry-evidence", registryExact.status === "pass" && registryNext.status === "pass" &&
      registryComparison.status === "pass" && registryExact.resolvedVersion === rcVersion &&
      registryNext.resolvedVersion === rcVersion && registryExact.manifest.length === rcFileCount &&
      registryNext.manifest.length === rcFileCount && registryExact.runtimeDependencyCount === 0 &&
      registryNext.runtimeDependencyCount === 0),
    createCheck("tarball-sha256", registryExact.hashes?.tarballSha256 === rcTarballSha256 &&
      registryNext.hashes?.tarballSha256 === rcTarballSha256 &&
      report.registryIntegrity?.exact?.hashes?.tarballSha256 === rcTarballSha256),
    createCheck("expanded-sha256", registryExact.hashes?.expandedSha256 === rcExpandedSha256 &&
      registryNext.hashes?.expandedSha256 === rcExpandedSha256 &&
      report.registryIntegrity?.exact?.hashes?.expandedSha256 === rcExpandedSha256),
    createCheck("selector-hashes", deepEqual(registryExact.hashes, registryNext.hashes) &&
      deepEqual(report.registryIntegrity?.exact?.hashes, report.registryIntegrity?.next?.hashes)),
    createCheck("selector-runtime", registryComparison.status === "pass" &&
      report.registryIntegrity?.selectorComparison?.status === "pass"),
    createCheck("conformance-coverage", [baselineReport, exactReport, nextReport].every((candidate) => {
      return candidate.summary?.totalVectors === 91 && candidate.summary?.totalResults === 455 &&
        candidate.summary?.failed === 0 && candidate.summary?.error === 0;
    })),
    createCheck("raw-strict-comparison", rawExact.status === "blocked" && rawNext.status === "blocked" &&
      rawSelector.status === "pass" && rawExact.changes.length === rcExpectedDeltaCount &&
      rawNext.changes.length === rcExpectedDeltaCount &&
      rawExact.blockingRegressions.length === rcExpectedDeltaCount &&
      rawNext.blockingRegressions.length === rcExpectedDeltaCount &&
      rawSelector.changes.length === 0 && rawSelector.blockingRegressions.length === 0 &&
      report.conformance?.common?.exact?.status === "blocked" &&
      report.conformance?.common?.next?.status === "blocked" &&
      report.conformance?.common?.selector?.status === "pass"),
    createCheck("policy-integrity", canonicalPolicyContext.status === "pass" &&
      snapshotPolicyContext.status === "pass" &&
      canonicalPolicyContext.source.sha256 === rcExpectedDeltaPolicySha256 &&
      snapshotPolicyContext.source.sha256 === rcExpectedDeltaPolicySha256 &&
      canonicalPolicyContext.source.schemaSha256 === rcExpectedDeltaPolicySchemaSha256 &&
      snapshotPolicyContext.source.schemaSha256 === rcExpectedDeltaPolicySchemaSha256 &&
      deepEqual(canonicalPolicyContext.policy, snapshotPolicyContext.policy) &&
      deepEqual(canonicalPolicyContext.schema, snapshotPolicyContext.schema) &&
      reportExpectedDelta?.policy?.path === rcExpectedDeltaPolicyPath &&
      reportExpectedDelta?.policy?.schemaPath === rcExpectedDeltaPolicySchemaPath &&
      reportExpectedDelta?.policy?.sha256 === rcExpectedDeltaPolicySha256 &&
      reportExpectedDelta?.policy?.schemaSha256 === rcExpectedDeltaPolicySchemaSha256),
    createCheck("expected-delta-recomputed", recomputedAdjudicationExact.status === "pass" &&
      recomputedAdjudicationNext.status === "pass" && recomputedAdjudicationComparison.status === "pass" &&
      deepEqual(storedAdjudicationExact, recomputedAdjudicationExact) &&
      deepEqual(storedAdjudicationNext, recomputedAdjudicationNext) &&
      deepEqual(storedAdjudicationComparison, recomputedAdjudicationComparison)),
    createCheck("expected-delta-counts", [storedAdjudicationExact, storedAdjudicationNext].every((adjudication) => {
      return adjudication.rawDeltaCount === rcExpectedDeltaCount &&
        adjudication.rawBlockingRegressionCount === rcExpectedDeltaCount &&
        adjudication.matchedExpected === rcExpectedDeltaCount &&
        adjudication.missingExpected.length === 0 && adjudication.unexpected.length === 0 &&
        adjudication.control.status === "pass";
    }) && reportExpectedDelta?.exact?.matchedExpected === rcExpectedDeltaCount &&
      reportExpectedDelta?.next?.matchedExpected === rcExpectedDeltaCount &&
      reportExpectedDelta?.exact?.missingExpected === 0 && reportExpectedDelta?.next?.missingExpected === 0 &&
      reportExpectedDelta?.exact?.unexpected === 0 && reportExpectedDelta?.next?.unexpected === 0),
    createCheck("full-node-22", full.runtime?.nodeMajor === "22" && full.status === "pass" &&
      report.toolchain?.full?.nodeMajor === "22" && report.toolchain?.full?.status === "pass"),
    createCheck("node-matrix", deepEqual(surfaces.map((surface) => surface.runtime?.nodeMajor), rcRequiredNodeMajors) &&
      surfaces.every((surface) => surface.status === "pass" && surface.commit === report.commit) &&
      deepEqual(report.toolchain?.packageSurface?.map((entry) => entry.nodeMajor), rcRequiredNodeMajors) &&
      report.toolchain.packageSurface.every((entry) => entry.status === "pass")),
    createCheck("v3-contract", v3Exact.status === "pass" && v3Next.status === "pass" &&
      v3Exact.requiredCheckCount === 35 && v3Next.requiredCheckCount === 35 &&
      v3Comparison.status === "pass" && report.v3Contract?.exact?.requiredCheckCount === 35 &&
      report.v3Contract?.next?.requiredCheckCount === 35 && report.v3Contract?.selectorComparison?.status === "pass"),
    createCheck("required-artifact-set", expectedArtifactPaths.every((filePath) => artifactPaths.has(filePath)), {
      expected: expectedArtifactPaths,
      missing: expectedArtifactPaths.filter((filePath) => !artifactPaths.has(filePath))
    }),
    createCheck("assembled-checks", report.summary?.failed === 0 &&
      report.checks?.every((check) => check.status === "passed")),
    createCheck("artifacts", artifactResult.ok, artifactResult)
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
