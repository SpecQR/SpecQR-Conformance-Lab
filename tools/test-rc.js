import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { compareRcReports, normalizeRcResult, rcComparisonNormalizations } from "./compare-rc-reports.js";
import {
  adjudicateExpectedDeltas,
  compareExpectedDeltaAdjudications,
  loadExpectedDeltaPolicy,
  validateExpectedDeltaPolicyDocuments
} from "./rc-expected-delta.js";
import { archiveManifest, expandedManifestSha256 } from "./rc-registry.js";
import { suitesForTarget } from "./rc-target-suites.js";
import { deepEqual, sha256, stableStringify } from "./rc-utils.js";
import { validateSchemaValue } from "./validate-schemas.js";
import { validateArtifactEvidence } from "./validate-rc-readiness.js";
import { compareV3ContractEvidence } from "./verify-v3-contract.js";
import { verifyLinks } from "./verify-links.js";

const requiredPaths = [
  ".github/workflows/rc-readiness.yml",
  "docs/rc-validation.md",
  "policies/specqr-3.0.0-rc.2-expected-deltas-v1.json",
  "schemas/rc-expected-delta-policy-v1.schema.json",
  "schemas/rc-readiness-v1.schema.json",
  "fixtures/rc-v3-consumer/tsconfig.base.json",
  "fixtures/rc-v3-consumer/tsconfig.literal.json",
  "fixtures/rc-v3-consumer/tsconfig.dynamic.json",
  "fixtures/rc-v3-consumer/literal.ts",
  "fixtures/rc-v3-consumer/dynamic.ts",
  "tools/assemble-rc-readiness.js",
  "tools/compare-rc-reports.js",
  "tools/rc-constants.js",
  "tools/rc-expected-delta.js",
  "tools/rc-registry.js",
  "tools/rc-target-suites.js",
  "tools/rc-typescript.js",
  "tools/rc-utils.js",
  "tools/run-rc-conformance-child.js",
  "tools/run-rc-full.js",
  "tools/run-rc-package-surface.js",
  "tools/specqr-target.js",
  "tools/validate-rc-readiness.js",
  "tools/verify-links.js",
  "tools/verify-v3-contract.js"
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setCandidateTarget(report, requested) {
  report.target.requested = requested;
  report.target.resolvedVersion = "3.0.0-rc.2";
  report.target.version = "3.0.0-rc.2";
  report.metadata.target.requested = requested;
  report.metadata.target.resolvedVersion = "3.0.0-rc.2";
  report.metadata.packages.specqr = "3.0.0-rc.2";
  report.adapters.find((adapter) => adapter.id === "specqr").packageVersion = "3.0.0-rc.2";
  report.results.find((result) => {
    return result.vectorId === "package.metadata.published-surface" && result.adapterId === "specqr";
  }).details.packageSurface.metadata.version = "3.0.0-rc.2";
  return report;
}

function tarEntry(name, contents, options = {}) {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = (options.type ?? "0").charCodeAt(0);
  if (options.linkName) {
    header.write(options.linkName, 157, 100, "utf8");
  }
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = Array.from(header).reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, padding]);
}

function syntheticReadiness() {
  return {
    schemaVersion: 1,
    kind: "specqr-rc-readiness",
    generatedAt: "2026-08-02T04:27:44.000Z",
    commit: "0123456789012345678901234567890123456789",
    release: {
      version: "3.0.0-rc.2",
      publishedAtJst: "2026-08-02 16:38:47 JST",
      expectedTarballSha256: "a".repeat(64),
      expectedExpandedSha256: "b".repeat(64)
    },
    targets: { baseline: {}, exact: {}, next: {} },
    technicalStatus: "pass",
    observationStatus: "pending",
    toolchain: { full: {}, packageSurface: [] },
    registryIntegrity: { exact: {}, next: {}, selectorComparison: {} },
    conformance: { baseline: {}, exact: {}, next: {}, common: {}, normalizations: [] },
    expectedDelta: {
      policy: {
        id: "specqr-3.0.0-rc.2-capacity-warning-removal",
        path: "policies/specqr-3.0.0-rc.2-expected-deltas-v1.json",
        sha256: "a".repeat(64),
        schemaPath: "schemas/rc-expected-delta-policy-v1.schema.json",
        schemaSha256: "b".repeat(64),
        snapshotPath: "reports/rc/full/expected-delta-policy.json",
        schemaSnapshotPath: "reports/rc/full/expected-delta-policy.schema.json",
        status: "pass"
      },
      exact: {
        status: "pass", rawStatus: "blocked", rawDeltaCount: 3, rawBlockingRegressionCount: 3,
        matchedExpected: 3, missingExpected: 0, unexpected: 0, controlStatus: "pass",
        evidencePath: "reports/rc/full/expected-delta-exact.json"
      },
      next: {
        status: "pass", rawStatus: "blocked", rawDeltaCount: 3, rawBlockingRegressionCount: 3,
        matchedExpected: 3, missingExpected: 0, unexpected: 0, controlStatus: "pass",
        evidencePath: "reports/rc/full/expected-delta-next.json"
      },
      selectorComparison: {
        status: "pass", identical: true, exactSha256: "c".repeat(64), nextSha256: "c".repeat(64),
        evidencePath: "reports/rc/full/expected-delta-comparison.json"
      }
    },
    v3Contract: { exact: {}, next: {}, selectorComparison: {} },
    skips: { baseline: [], exact: [], next: [] },
    nonClaims: ["stable publication"],
    artifacts: {
      artifactSetSha256: "c".repeat(64),
      files: [{ path: "reports/rc/full.json", size: 1, sha256: "d".repeat(64) }]
    },
    checks: [{ id: "synthetic", status: "passed" }],
    summary: { passed: 1, failed: 0 }
  };
}

try {
  for (const relativePath of requiredPaths) {
    await access(path.resolve(relativePath));
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.devDependencies.specqr, "2.4.0", "RC tooling must not change the public baseline pin");
  for (const script of ["verify:links", "rc:package-surface", "rc:full", "rc:assemble", "rc:validate"]) {
    assert.equal(typeof packageJson.scripts[script], "string", `missing RC script ${script}`);
  }

  const latest = JSON.parse(await readFile("reports/latest.json", "utf8"));
  assert.equal(latest.target.resolvedVersion, "2.4.0", "default report must remain on specqr@2.4.0");
  const targetOnly = setCandidateTarget(clone(latest), "specqr@3.0.0-rc.2");
  const targetComparison = compareRcReports(latest, targetOnly);
  assert.equal(targetComparison.status, "pass", "target identity changes alone must not be regressions");

  const changedResult = clone(targetOnly);
  const executed = changedResult.results.find((result) => result.adapterId === "specqr" && result.status === "passed" && Object.keys(result.details ?? {}).length > 0);
  executed.details.rcTestMutation = true;
  const changedComparison = compareRcReports(latest, changedResult);
  assert.equal(changedComparison.status, "blocked", "executed result detail changes must block");
  assert(changedComparison.blockingRegressions.some((item) => item.kind === "matrix-renderer-helper-or-result-change"));

  const missingCheck = clone(targetOnly);
  const checkResult = missingCheck.results.find((result) => result.adapterId === "specqr" && result.status === "passed" && result.checks.length > 0);
  checkResult.checks.shift();
  const missingCheckComparison = compareRcReports(latest, missingCheck);
  assert(missingCheckComparison.blockingRegressions.some((item) => item.kind === "missing-required-check"));

  const requiredSkip = clone(targetOnly);
  const requiredResult = requiredSkip.results.find((result) => result.adapterId === "specqr" && result.status === "passed");
  requiredResult.status = "skipped";
  const requiredSkipComparison = compareRcReports(latest, requiredSkip);
  assert(requiredSkipComparison.blockingRegressions.some((item) => item.kind === "required-adapter-skip"));

  const warningRemoval = clone(targetOnly);
  for (const vectorId of [
    "core.estimate.data-too-long-reject",
    "planning.estimate.data-too-long-v1-h",
    "planning.analyze-segments.data-too-long-v1-h"
  ]) {
    const result = warningRemoval.results.find((candidate) => candidate.vectorId === vectorId && candidate.adapterId === "specqr");
    result.details.diagnostics.warnings = [];
    result.details.planning.warnings = [];
  }
  const warningComparison = compareRcReports(latest, warningRemoval);
  assert.equal(warningComparison.status, "blocked", "helper warning result changes must remain blocking");
  assert.equal(warningComparison.changes.length, 3, "raw strict comparison must retain exactly three deltas");
  assert.equal(warningComparison.blockingRegressions.filter((item) => item.kind === "matrix-renderer-helper-or-result-change").length, 3);
  assert(warningComparison.changes.every((change) => change.differences.some((difference) => difference.path.endsWith("warnings.length"))));

  const policyContext = await loadExpectedDeltaPolicy();
  assert.equal(policyContext.status, "pass", "the pinned expected-delta policy must validate");
  const adjudicate = (candidate, options = {}) => {
    const base = options.base ?? latest;
    const raw = options.raw ?? compareRcReports(base, candidate);
    return adjudicateExpectedDeltas({
      baseReport: base,
      candidateReport: candidate,
      rawComparison: raw,
      policyContext: options.policyContext ?? policyContext,
      expectedRequested: options.expectedRequested ?? candidate.target.requested
    });
  };
  const exactAdjudication = adjudicate(warningRemoval);
  assert.equal(exactAdjudication.status, "pass");
  assert.equal(exactAdjudication.rawDeltaCount, 3);
  assert.equal(exactAdjudication.matchedExpected, 3);
  assert.equal(exactAdjudication.missingExpected.length, 0);
  assert.equal(exactAdjudication.unexpected.length, 0);
  assert.equal(exactAdjudication.control.status, "pass");
  assert.deepEqual(exactAdjudication.entries.map((entry) => [
    entry.vectorId,
    entry.beforeFingerprint,
    entry.afterFingerprint
  ]), [
    [
      "core.estimate.data-too-long-reject",
      "feb36244b3cba7698421c2bfe4357aa091b91980034ed6c6d2c7043cc7644c50",
      "3aa336488d9fd8afbfdc1cb6ddf2ef4123f9257659d4ede5ff255af3ad9c33c9"
    ],
    [
      "planning.estimate.data-too-long-v1-h",
      "13f97c0ed73c276012eaaa150d756da6ca91bac859dffea06b07a01b1816d47a",
      "c8a9588eac278ac1c09249b2eaed6ca2714c4f93dd32c1d3a7130e8a3deb00e7"
    ],
    [
      "planning.analyze-segments.data-too-long-v1-h",
      "b6f40826566b609cab7cd7bd674a5fbc52b591513eee415276bdc6008f4a23dd",
      "e454ec71100d4de4209be8f3340b87f97423f94367483ca9a9a861c2b58bc1a2"
    ]
  ]);

  const nextCandidate = setCandidateTarget(clone(warningRemoval), "specqr@next");
  const nextAdjudication = adjudicate(nextCandidate, { expectedRequested: "specqr@next" });
  assert.equal(nextAdjudication.status, "pass");
  assert.equal(compareExpectedDeltaAdjudications(exactAdjudication, nextAdjudication).status, "pass");

  const negativeCases = [];
  const expectBlocked = (name, value) => {
    negativeCases.push(name);
    assert.equal(value.status, "blocked", `${name} must block expected-delta adjudication`);
  };

  const extraDelta = clone(warningRemoval);
  const extraResult = extraDelta.results.find((result) => {
    return result.adapterId === "specqr" && result.status === "passed" &&
      ![
        "core.estimate.data-too-long-reject",
        "planning.estimate.data-too-long-v1-h",
        "planning.analyze-segments.data-too-long-v1-h"
      ].includes(result.vectorId) && result.details && Object.keys(result.details).length > 0;
  });
  extraResult.details.expectedDeltaNegativeMutation = true;
  expectBlocked("extra delta", adjudicate(extraDelta));

  const missingDelta = clone(warningRemoval);
  const missingVector = "core.estimate.data-too-long-reject";
  const missingResult = missingDelta.results.find((result) => result.adapterId === "specqr" && result.vectorId === missingVector);
  const baselineMissingResult = latest.results.find((result) => result.adapterId === "specqr" && result.vectorId === missingVector);
  missingResult.details = clone(baselineMissingResult.details);
  expectBlocked("missing delta", adjudicate(missingDelta));

  const wrongVector = clone(warningRemoval);
  wrongVector.results.find((result) => result.adapterId === "specqr" && result.vectorId === missingVector).vectorId = `${missingVector}.wrong`;
  expectBlocked("wrong vector", adjudicate(wrongVector));

  const policyText = await readFile("policies/specqr-3.0.0-rc.2-expected-deltas-v1.json", "utf8");
  const policySchemaText = await readFile("schemas/rc-expected-delta-policy-v1.schema.json", "utf8");
  const wrongAdapterPolicy = JSON.parse(policyText);
  wrongAdapterPolicy.entries[0].adapterId = "jsqr";
  const wrongAdapterContext = validateExpectedDeltaPolicyDocuments({
    policyText: `${JSON.stringify(wrongAdapterPolicy, null, 2)}\n`,
    schemaText: policySchemaText
  });
  expectBlocked("wrong adapter", adjudicate(warningRemoval, { policyContext: wrongAdapterContext }));

  const wrongOperation = clone(warningRemoval);
  wrongOperation.results.find((result) => {
    return result.adapterId === "specqr" && result.vectorId === "planning.analyze-segments.data-too-long-v1-h";
  }).operation = "estimate";
  expectBlocked("wrong operation", adjudicate(wrongOperation));

  const wrongPathRaw = clone(warningComparison);
  wrongPathRaw.changes[0].differences[0].path = "$.details.diagnostics.warnings";
  expectBlocked("wrong path", adjudicate(warningRemoval, { raw: wrongPathRaw }));

  const wrongFingerprintRaw = clone(warningComparison);
  wrongFingerprintRaw.changes[0].baseFingerprint = "0".repeat(64);
  expectBlocked("wrong fingerprint", adjudicate(warningRemoval, { raw: wrongFingerprintRaw }));

  const wrongWarningBase = clone(latest);
  const wrongWarningResult = wrongWarningBase.results.find((result) => {
    return result.adapterId === "specqr" && result.vectorId === missingVector;
  });
  wrongWarningResult.details.diagnostics.warnings[0].code = "WRONG_WARNING";
  wrongWarningResult.details.planning.warnings[0].code = "WRONG_WARNING";
  expectBlocked("wrong warning code", adjudicate(warningRemoval, { base: wrongWarningBase }));

  const failedPrecondition = clone(warningRemoval);
  failedPrecondition.results.find((result) => {
    return result.adapterId === "specqr" && result.vectorId === "planning.estimate.data-too-long-v1-h";
  }).details.planning.remainingBits = -339;
  expectBlocked("precondition failure", adjudicate(failedPrecondition));

  const invariantDrift = clone(warningRemoval);
  invariantDrift.results.find((result) => {
    return result.adapterId === "specqr" && result.vectorId === "planning.estimate.data-too-long-v1-h";
  }).details.planning.overflowBits = 339;
  expectBlocked("unchanged field drift", adjudicate(invariantDrift));

  const controlDisappeared = clone(warningRemoval);
  const controlResult = controlDisappeared.results.find((result) => {
    return result.adapterId === "specqr" && result.vectorId === "planning.diagnostics.warning.capacity-near-limit";
  });
  controlResult.details.diagnostics.warnings = [];
  controlResult.details.planning.warnings = [];
  expectBlocked("control disappearance", adjudicate(controlDisappeared));

  const versionChanged = clone(warningRemoval);
  versionChanged.target.resolvedVersion = "3.0.0-rc.3";
  versionChanged.target.version = "3.0.0-rc.3";
  expectBlocked("candidate version change", adjudicate(versionChanged));

  const nextMismatch = clone(nextCandidate);
  nextMismatch.results.find((result) => {
    return result.adapterId === "specqr" && result.vectorId === "planning.estimate.data-too-long-v1-h";
  }).details.planning.overflowBits = 339;
  const nextMismatchAdjudication = adjudicate(nextMismatch, { expectedRequested: "specqr@next" });
  expectBlocked("next mismatch", nextMismatchAdjudication);
  assert.equal(compareExpectedDeltaAdjudications(exactAdjudication, nextMismatchAdjudication).status, "blocked");

  const alteredPolicyContext = validateExpectedDeltaPolicyDocuments({
    policyText: `${policyText}\n`,
    schemaText: policySchemaText
  });
  expectBlocked("policy mutation", adjudicate(warningRemoval, { policyContext: alteredPolicyContext }));
  assert.equal(negativeCases.length, 14);

  const manualResult = latest.results.find((result) => {
    return result.adapterId === "specqr" && result.operation === "structuredAppend.generateSegments" && result.details?.structuredAppend?.diagnostics?.splitStrategy === "segment-boundary-byte-chunk";
  });
  assert(manualResult, "latest report must contain manual Structured Append diagnostics");
  const normalizedManual = normalizeRcResult(manualResult);
  assert(!Object.hasOwn(normalizedManual.details.structuredAppend.diagnostics, "splitUnits"));
  assert(rcComparisonNormalizations.some((rule) => rule.includes("splitUnits")));

  const suites = [JSON.parse(await readFile("vectors/package-surface.json", "utf8"))];
  suites[0].file = "vectors/package-surface.json";
  const candidateSuites = suitesForTarget(suites, "3.0.0-rc.2");
  assert.equal(candidateSuites.suites[0].vectors[0].expect.package.metadataSubset.version, "3.0.0-rc.2");
  assert.equal(suites[0].vectors[0].expect.package.metadataSubset.version, "2.4.0", "suite normalization must not mutate source vectors");

  const tar = gzipSync(Buffer.concat([
    tarEntry("package/b.txt", "B"),
    tarEntry("package/a.txt", "A"),
    Buffer.alloc(1024)
  ]));
  const manifest = archiveManifest(tar);
  assert.deepEqual(manifest.map((file) => file.path), ["a.txt", "b.txt"], "tar manifest must use bytewise path order");
  assert.equal(manifest[0].sha256, createHash("sha256").update("A").digest("hex"));
  assert.equal(expandedManifestSha256(manifest), sha256(`${JSON.stringify(manifest)}\n`));

  const privateUsePath = `${String.fromCodePoint(0xe000)}.txt`;
  const supplementaryPath = `${String.fromCodePoint(0x10000)}.txt`;
  const unicodeTar = gzipSync(Buffer.concat([
    tarEntry(`package/${supplementaryPath}`, "supplementary"),
    tarEntry(`package/${privateUsePath}`, "private-use"),
    Buffer.alloc(1024)
  ]));
  assert.deepEqual(
    archiveManifest(unicodeTar).map((file) => file.path),
    [privateUsePath, supplementaryPath],
    "tar manifest path order must compare UTF-8 bytes"
  );

  const linkTar = gzipSync(Buffer.concat([
    tarEntry("package/link.txt", "", { type: "2", linkName: "target.txt" }),
    Buffer.alloc(1024)
  ]));
  assert.throws(() => archiveManifest(linkTar), /link entry/, "tar manifest must reject links");

  const contract = {
    target: { requested: "specqr@3.0.0-rc.2", resolvedVersion: "3.0.0-rc.2", source: "npm-registry" },
    input: { expectedSplitUnitCount: 62 },
    observations: { splitUnitsSha256: "a".repeat(64) },
    checks: [{ id: "contract", status: "passed" }],
    summary: { passed: 1, failed: 0 },
    requiredCheckCount: 1,
    status: "pass"
  };
  const nextContract = clone(contract);
  nextContract.target.requested = "specqr@next";
  assert.equal(compareV3ContractEvidence(contract, nextContract).status, "pass");
  nextContract.checks[0].status = "failed";
  assert.equal(compareV3ContractEvidence(contract, nextContract).status, "blocked");

  const readinessSchema = JSON.parse(await readFile("schemas/rc-readiness-v1.schema.json", "utf8"));
  const schemaResult = validateSchemaValue(syntheticReadiness(), readinessSchema);
  assert(schemaResult.ok, `synthetic RC readiness must pass schema: ${JSON.stringify(schemaResult.errors)}`);

  const artifactRoot = await mkdtemp(path.join(tmpdir(), "specqr-rc-artifact-test-"));
  try {
    const artifactPath = "evidence.json";
    const artifactContents = Buffer.from("{\"status\":\"pass\"}\n");
    await writeFile(path.join(artifactRoot, artifactPath), artifactContents);
    const artifactReport = syntheticReadiness();
    artifactReport.artifacts.files = [{
      path: artifactPath,
      size: artifactContents.length,
      sha256: sha256(artifactContents)
    }];
    artifactReport.artifacts.artifactSetSha256 = sha256(`${stableStringify(artifactReport.artifacts.files)}\n`);
    assert((await validateArtifactEvidence(artifactReport, { cwd: artifactRoot })).ok, "artifact hashes must validate");
    await writeFile(path.join(artifactRoot, artifactPath), "changed\n");
    assert(!(await validateArtifactEvidence(artifactReport, { cwd: artifactRoot })).ok, "artifact mutation must fail validation");
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }

  const workflow = await readFile(".github/workflows/rc-readiness.yml", "utf8");
  for (const text of [
    "workflow_dispatch",
    "expected_commit",
    "node-version:",
    "- 18",
    "- 20",
    "- 22",
    "- 24",
    "npm ci",
    "run: npm run verify",
    "npm run rc:package-surface",
    "npm run rc:full -- --require-node 22",
    "npm run rc:assemble",
    "npm run rc:validate",
    "actions/upload-artifact@v4"
  ]) {
    assert(workflow.includes(text), `RC workflow missing ${text}`);
  }
  assert(!workflow.includes("continue-on-error"), "RC workflow must not soften candidate integrity");
  assert(!workflow.includes("deploy-pages"), "RC workflow must not deploy Pages");
  assert(!workflow.includes("upload-pages-artifact"), "RC workflow must not upload Pages artifacts");

  const pagesBuilder = await readFile("tools/build-pages.js", "utf8");
  assert(pagesBuilder.includes('"rc-readiness-v1.schema.json"'), "Pages builder must identify the RC schema as artifact-only");
  assert(pagesBuilder.includes('"rc-expected-delta-policy-v1.schema.json"'), "Pages builder must keep the policy schema artifact-only");
  assert(pagesBuilder.includes("!artifactOnlySchemas.has(entry.name)"), "Pages builder must exclude artifact-only schemas");

  const rcDoc = await readFile("docs/rc-validation.md", "utf8");
  for (const text of [
    "specqr@2.4.0",
    "specqr@3.0.0-rc.2",
    "specqr@next",
    "c96c324dcd99d72c385d3890156a6ae973ad8db57b840fd5a47f987ddcbb6298",
    "f507de7da842b3bc5fce88eaa6a4d04388ce1d55541c58cbebf36d4b583ae306",
    "expected delta",
    "technicalStatus",
    "observationStatus",
    "Local tarball",
    "direct source import",
    "Normalization rules",
    "v3 candidate contract",
    "non-claims"
  ]) {
    assert(rcDoc.includes(text), `RC validation docs missing ${text}`);
  }

  const sourceFiles = requiredPaths.filter((file) => file.endsWith(".js"));
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    assert(!source.includes("/SpecQR/src"), `${file} must not import or reference SpecQR core source`);
    assert(!source.includes("../SpecQR"), `${file} must not import SpecQR core checkout`);
  }

  const links = await verifyLinks();
  assert(links.ok, `local Markdown links must resolve: ${JSON.stringify(links.errors)}`);
  assert(deepEqual(["18", "20", "22", "24"], ["18", "20", "22", "24"]));

  console.log(JSON.stringify({
    ok: true,
    checks: {
      requiredPaths: requiredPaths.length,
      strictComparison: true,
      expectedDeltaNegativeTests: negativeCases.length,
      tarManifest: true,
      readinessSchema: true,
      workflowIsolation: true,
      links: links.checked
    }
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
}
