import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  rcBaselineSpec,
  rcExactSpec,
  rcExpandedSha256,
  rcExpectedDeltaCount,
  rcExpectedDeltaPolicyPath,
  rcExpectedDeltaPolicySchemaPath,
  rcExpectedDeltaPolicySchemaSha256,
  rcExpectedDeltaPolicySha256,
  rcFileCount,
  rcNextSpec,
  rcNonClaims,
  rcPublishedAtJst,
  rcRequiredNodeMajors,
  rcTarballSha256,
  rcVersion
} from "./rc-constants.js";
import { createCheck, deepEqual, readJson, sha256, stableStringify, statusCounts, writeJson, writeText } from "./rc-utils.js";

function parseArgs(argv) {
  const options = {
    inputDirectory: "reports/rc",
    outputJson: "reports/rc/readiness.json",
    outputMarkdown: "reports/rc/readiness.md",
    expectedCommit: null
  };
  const fields = new Map([
    ["--input-directory", "inputDirectory"],
    ["--json-output", "outputJson"],
    ["--markdown-output", "outputMarkdown"],
    ["--expected-commit", "expectedCommit"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) {
      throw new Error(`Invalid readiness assembly argument: ${argv[index]}`);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  return options;
}

async function recursiveFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.isFile()) {
        files.push(filePath);
      }
    }
  }
  await walk(directory);
  return files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function reportSummary(report) {
  return {
    target: report.target,
    vectors: report.summary.totalVectors,
    results: report.summary.totalResults,
    passed: report.summary.passed,
    skipped: report.summary.skipped,
    failed: report.summary.failed,
    error: report.summary.error,
    adapters: Object.values(report.summary.adapterSummary)
  };
}

function comparisonSummary(comparison) {
  return {
    status: comparison.status,
    commonResultCount: comparison.commonResultCount,
    blockingRegressionCount: comparison.blockingRegressions.length,
    changes: comparison.changes.length
  };
}

function registrySummary(evidence) {
  return {
    requested: evidence.requested,
    resolvedVersion: evidence.resolvedVersion,
    status: evidence.status,
    publication: evidence.publication,
    hashes: evidence.hashes,
    fileCount: evidence.manifest.length,
    runtimeDependencyCount: evidence.runtimeDependencyCount,
    exportsFingerprint: sha256(stableStringify(evidence.runtime.exports)),
    runtimeFingerprint: sha256(stableStringify(evidence.runtime.smoke))
  };
}

function adjudicationSummary(adjudication, evidencePath) {
  return {
    status: adjudication.status,
    rawStatus: adjudication.rawStatus,
    rawDeltaCount: adjudication.rawDeltaCount,
    rawBlockingRegressionCount: adjudication.rawBlockingRegressionCount,
    matchedExpected: adjudication.matchedExpected,
    missingExpected: adjudication.missingExpected.length,
    unexpected: adjudication.unexpected.length,
    controlStatus: adjudication.control.status,
    evidencePath
  };
}

function markdownTable(headers, rows) {
  const render = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `| ${headers.map(render).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(render).join(" | ")} |`)
  ].join("\n");
}

export function renderReadinessMarkdown(report) {
  const adapterRows = ["baseline", "exact", "next"].flatMap((target) => {
    return report.conformance[target].adapters.map((adapter) => [
      target,
      adapter.id,
      adapter.passed,
      adapter.skipped,
      adapter.failed,
      adapter.error
    ]);
  });
  const nodeRows = report.toolchain.packageSurface.map((entry) => [
    entry.nodeMajor,
    entry.node,
    entry.status,
    `${entry.summary.passed}/${entry.summary.passed + entry.summary.failed}`
  ]);
  const artifactRows = report.artifacts.files.map((file) => [file.path, file.size, file.sha256]);
  return `# SpecQR 3.0.0-rc.2 Readiness Evidence

- Commit: \`${report.commit}\`
- RC publication: ${report.release.publishedAtJst}
- Technical status: **${report.technicalStatus}**
- Observation status: **${report.observationStatus}**
- Baseline: \`${report.targets.baseline.requested}\`
- Candidate exact: \`${report.targets.exact.requested}\`
- Candidate dist-tag: \`${report.targets.next.requested}\`

## Registry integrity

- exact / next resolved: \`${report.registryIntegrity.exact.resolvedVersion}\`
- tarball SHA-256: \`${report.registryIntegrity.exact.hashes.tarballSha256}\`
- expanded SHA-256: \`${report.registryIntegrity.exact.hashes.expandedSha256}\`
- files: ${report.registryIntegrity.exact.fileCount}
- runtime dependencies: ${report.registryIntegrity.exact.runtimeDependencyCount}
- exact / next status: **${report.registryIntegrity.selectorComparison.status}**

## Common conformance

- baseline / exact raw strict: **${report.conformance.common.exact.status}**, blocking regressions ${report.conformance.common.exact.blockingRegressionCount}
- baseline / next raw strict: **${report.conformance.common.next.status}**, blocking regressions ${report.conformance.common.next.blockingRegressionCount}
- exact / next: **${report.conformance.common.selector.status}**, blocking regressions ${report.conformance.common.selector.blockingRegressionCount}

${markdownTable(["Target", "Adapter", "Pass", "Skip", "Fail", "Error"], adapterRows)}

## Expected delta adjudication

- Policy: \`${report.expectedDelta.policy.path}\`
- Policy SHA-256: \`${report.expectedDelta.policy.sha256}\`
- exact: **${report.expectedDelta.exact.status}**, raw ${report.expectedDelta.exact.rawDeltaCount}, matched ${report.expectedDelta.exact.matchedExpected}, missing ${report.expectedDelta.exact.missingExpected}, unexpected ${report.expectedDelta.exact.unexpected}
- next: **${report.expectedDelta.next.status}**, raw ${report.expectedDelta.next.rawDeltaCount}, matched ${report.expectedDelta.next.matchedExpected}, missing ${report.expectedDelta.next.missingExpected}, unexpected ${report.expectedDelta.next.unexpected}
- exact / next identical: **${report.expectedDelta.selectorComparison.identical}**

## v3 candidate contract

- exact: **${report.v3Contract.exact.status}**, ${report.v3Contract.exact.requiredCheckCount} required checks
- next: **${report.v3Contract.next.status}**, ${report.v3Contract.next.requiredCheckCount} required checks
- exact / next identical: **${report.v3Contract.selectorComparison.identical}**

## Toolchain

- Full suite: Node ${report.toolchain.full.nodeMajor} (${report.toolchain.full.node}), **${report.toolchain.full.status}**

${markdownTable(["Node", "Runtime", "Status", "Checks"], nodeRows)}

## Normalization

${report.conformance.normalizations.map((item) => `- ${item}`).join("\n")}

## Stable boundary and non-claims

Technical readiness and usage observation are independent. This report keeps \`observationStatus: "pending"\`; it does not promote the RC, move an npm dist-tag, create a GitHub Release, update Pages, or change the public \`2.4.0\` report.

${report.nonClaims.map((item) => `- ${item}`).join("\n")}

## Artifact hashes

- Artifact set SHA-256: \`${report.artifacts.artifactSetSha256}\`

${markdownTable(["Path", "Bytes", "SHA-256"], artifactRows)}
`;
}

export async function assembleRcReadiness(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const inputDirectory = path.resolve(cwd, options.inputDirectory ?? "reports/rc");
  const fullDirectory = path.join(inputDirectory, "full");
  const outputJson = path.resolve(cwd, options.outputJson ?? "reports/rc/readiness.json");
  const outputMarkdown = path.resolve(cwd, options.outputMarkdown ?? "reports/rc/readiness.md");
  const full = await readJson(path.join(fullDirectory, "full.json"));
  const surfaceFileNames = (await readdir(inputDirectory))
    .filter((name) => /^package-surface-node-(?:18|20|22|24)\.json$/.test(name))
    .sort();
  const surfaces = await Promise.all(surfaceFileNames.map((name) => readJson(path.join(inputDirectory, name))));
  surfaces.sort((left, right) => Number(left.runtime.nodeMajor) - Number(right.runtime.nodeMajor));

  const registryExact = await readJson(path.join(fullDirectory, "registry-exact.json"));
  const registryNext = await readJson(path.join(fullDirectory, "registry-next.json"));
  const registryComparison = await readJson(path.join(fullDirectory, "registry-comparison.json"));
  const baselineReport = await readJson(path.join(fullDirectory, "conformance-baseline.json"));
  const exactReport = await readJson(path.join(fullDirectory, "conformance-exact.json"));
  const nextReport = await readJson(path.join(fullDirectory, "conformance-next.json"));
  const comparisonExact = await readJson(path.join(fullDirectory, "comparison-baseline-exact.json"));
  const comparisonNext = await readJson(path.join(fullDirectory, "comparison-baseline-next.json"));
  const selectorComparison = await readJson(path.join(fullDirectory, "comparison-exact-next.json"));
  const expectedDeltaExact = await readJson(path.join(fullDirectory, "expected-delta-exact.json"));
  const expectedDeltaNext = await readJson(path.join(fullDirectory, "expected-delta-next.json"));
  const expectedDeltaComparison = await readJson(path.join(fullDirectory, "expected-delta-comparison.json"));
  const v3Exact = await readJson(path.join(fullDirectory, "v3-contract-exact.json"));
  const v3Next = await readJson(path.join(fullDirectory, "v3-contract-next.json"));
  const v3Comparison = await readJson(path.join(fullDirectory, "v3-contract-comparison.json"));

  const expectedCommit = options.expectedCommit ?? process.env.SPECQR_EXPECTED_COMMIT ?? null;
  const commitEvidence = [full.commit, ...surfaces.map((surface) => surface.commit)].filter(Boolean);
  const checks = [
    createCheck("expected-commit", !expectedCommit || (commitEvidence.length === surfaces.length + 1 && commitEvidence.every((commit) => commit === expectedCommit)), {
      expected: expectedCommit,
      actual: Array.from(new Set(commitEvidence))
    }),
    createCheck("full-node-22", full.runtime.nodeMajor === "22", { actual: full.runtime.nodeMajor }),
    createCheck("full-status", full.status === "pass"),
    createCheck("surface-node-matrix", deepEqual(surfaces.map((surface) => surface.runtime.nodeMajor), rcRequiredNodeMajors), {
      expected: rcRequiredNodeMajors,
      actual: surfaces.map((surface) => surface.runtime.nodeMajor)
    }),
    createCheck("surface-status", surfaces.every((surface) => surface.status === "pass")),
    createCheck("registry-integrity", registryComparison.status === "pass" &&
      registryExact.manifest.length === rcFileCount && registryNext.manifest.length === rcFileCount),
    createCheck("conformance-coverage", [baselineReport, exactReport, nextReport].every((report) => {
      return report.summary.totalVectors === 91 && report.summary.totalResults === 455;
    })),
    createCheck("raw-strict-comparison", comparisonExact.status === "blocked" &&
      comparisonNext.status === "blocked" && selectorComparison.status === "pass" &&
      comparisonExact.changes.length === rcExpectedDeltaCount &&
      comparisonNext.changes.length === rcExpectedDeltaCount &&
      comparisonExact.blockingRegressions.length === rcExpectedDeltaCount &&
      comparisonNext.blockingRegressions.length === rcExpectedDeltaCount &&
      selectorComparison.changes.length === 0 && selectorComparison.blockingRegressions.length === 0),
    createCheck("expected-delta", expectedDeltaExact.status === "pass" &&
      expectedDeltaNext.status === "pass" && expectedDeltaComparison.status === "pass" &&
      [expectedDeltaExact, expectedDeltaNext].every((adjudication) => {
        return adjudication.rawDeltaCount === rcExpectedDeltaCount &&
          adjudication.matchedExpected === rcExpectedDeltaCount &&
          adjudication.missingExpected.length === 0 && adjudication.unexpected.length === 0;
      })),
    createCheck("v3-contract", v3Exact.status === "pass" && v3Next.status === "pass" &&
      v3Comparison.status === "pass" && v3Exact.requiredCheckCount === 35 && v3Next.requiredCheckCount === 35)
  ];
  const checkSummary = statusCounts(checks);

  const excluded = new Set([outputJson, outputMarkdown]);
  const artifactFiles = [];
  for (const filePath of await recursiveFiles(inputDirectory)) {
    if (excluded.has(filePath)) {
      continue;
    }
    const contents = await readFile(filePath);
    artifactFiles.push({
      path: path.relative(cwd, filePath),
      size: (await stat(filePath)).size,
      sha256: sha256(contents)
    });
  }
  const artifactSetSha256 = sha256(`${stableStringify(artifactFiles)}\n`);
  const technicalStatus = checkSummary.failed === 0 ? "pass" : "blocked";
  const report = {
    schemaVersion: 1,
    kind: "specqr-rc-readiness",
    generatedAt: new Date().toISOString(),
    commit: expectedCommit ?? full.commit,
    release: {
      version: rcVersion,
      publishedAtJst: rcPublishedAtJst,
      expectedTarballSha256: rcTarballSha256,
      expectedExpandedSha256: rcExpandedSha256
    },
    targets: {
      baseline: { requested: rcBaselineSpec, resolvedVersion: baselineReport.target.resolvedVersion },
      exact: { requested: rcExactSpec, resolvedVersion: exactReport.target.resolvedVersion },
      next: { requested: rcNextSpec, resolvedVersion: nextReport.target.resolvedVersion }
    },
    technicalStatus,
    observationStatus: "pending",
    toolchain: {
      full: {
        node: full.runtime.node,
        nodeMajor: full.runtime.nodeMajor,
        platform: full.runtime.platform,
        arch: full.runtime.arch,
        status: full.status
      },
      packageSurface: surfaces.map((surface) => ({
        node: surface.runtime.node,
        nodeMajor: surface.runtime.nodeMajor,
        platform: surface.runtime.platform,
        arch: surface.runtime.arch,
        status: surface.status,
        summary: surface.summary
      }))
    },
    registryIntegrity: {
      exact: registrySummary(registryExact),
      next: registrySummary(registryNext),
      selectorComparison: registryComparison
    },
    conformance: {
      baseline: reportSummary(baselineReport),
      exact: reportSummary(exactReport),
      next: reportSummary(nextReport),
      common: {
        exact: comparisonSummary(comparisonExact),
        next: comparisonSummary(comparisonNext),
        selector: comparisonSummary(selectorComparison)
      },
      normalizations: comparisonExact.normalizations
    },
    expectedDelta: {
      policy: {
        id: expectedDeltaExact.policy.id,
        path: rcExpectedDeltaPolicyPath,
        sha256: rcExpectedDeltaPolicySha256,
        schemaPath: rcExpectedDeltaPolicySchemaPath,
        schemaSha256: rcExpectedDeltaPolicySchemaSha256,
        snapshotPath: "reports/rc/full/expected-delta-policy.json",
        schemaSnapshotPath: "reports/rc/full/expected-delta-policy.schema.json",
        status: expectedDeltaExact.policy.status
      },
      exact: adjudicationSummary(expectedDeltaExact, "reports/rc/full/expected-delta-exact.json"),
      next: adjudicationSummary(expectedDeltaNext, "reports/rc/full/expected-delta-next.json"),
      selectorComparison: {
        status: expectedDeltaComparison.status,
        identical: expectedDeltaComparison.identical,
        exactSha256: expectedDeltaComparison.exactSha256,
        nextSha256: expectedDeltaComparison.nextSha256,
        evidencePath: "reports/rc/full/expected-delta-comparison.json"
      }
    },
    v3Contract: {
      exact: {
        status: v3Exact.status,
        requiredCheckCount: v3Exact.requiredCheckCount,
        passed: v3Exact.summary.passed,
        failed: v3Exact.summary.failed
      },
      next: {
        status: v3Next.status,
        requiredCheckCount: v3Next.requiredCheckCount,
        passed: v3Next.summary.passed,
        failed: v3Next.summary.failed
      },
      selectorComparison: v3Comparison
    },
    skips: {
      baseline: reportSummary(baselineReport).adapters.map((adapter) => ({ id: adapter.id, skipped: adapter.skipped })),
      exact: reportSummary(exactReport).adapters.map((adapter) => ({ id: adapter.id, skipped: adapter.skipped })),
      next: reportSummary(nextReport).adapters.map((adapter) => ({ id: adapter.id, skipped: adapter.skipped }))
    },
    nonClaims: rcNonClaims,
    artifacts: {
      artifactSetSha256,
      files: artifactFiles
    },
    checks,
    summary: checkSummary
  };
  await writeJson(outputJson, report);
  await writeText(outputMarkdown, renderReadinessMarkdown(report));
  return report;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await assembleRcReadiness(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      ok: result.technicalStatus === "pass",
      technicalStatus: result.technicalStatus,
      observationStatus: result.observationStatus,
      artifactSetSha256: result.artifacts.artifactSetSha256,
      checks: result.summary
    }, null, 2));
    if (result.technicalStatus !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
