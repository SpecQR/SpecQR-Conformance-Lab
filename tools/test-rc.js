import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { compareRcReports, normalizeRcResult, rcComparisonNormalizations } from "./compare-rc-reports.js";
import { archiveManifest, expandedManifestSha256 } from "./rc-registry.js";
import { suitesForTarget } from "./rc-target-suites.js";
import { deepEqual, sha256 } from "./rc-utils.js";
import { validateSchemaValue } from "./validate-schemas.js";
import { compareV3ContractEvidence } from "./verify-v3-contract.js";
import { verifyLinks } from "./verify-links.js";

const requiredPaths = [
  ".github/workflows/rc-readiness.yml",
  "docs/rc-validation.md",
  "schemas/rc-readiness-v1.schema.json",
  "fixtures/rc-v3-consumer/tsconfig.base.json",
  "fixtures/rc-v3-consumer/tsconfig.literal.json",
  "fixtures/rc-v3-consumer/tsconfig.dynamic.json",
  "fixtures/rc-v3-consumer/literal.ts",
  "fixtures/rc-v3-consumer/dynamic.ts",
  "tools/assemble-rc-readiness.js",
  "tools/compare-rc-reports.js",
  "tools/rc-constants.js",
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

function tarEntry(name, contents) {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
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
      version: "3.0.0-rc.1",
      publishedAtJst: "2026-08-02 13:27:44 JST",
      expectedTarballSha256: "a".repeat(64),
      expectedExpandedSha256: "b".repeat(64)
    },
    targets: { baseline: {}, exact: {}, next: {} },
    technicalStatus: "pass",
    observationStatus: "pending",
    toolchain: { full: {}, packageSurface: [] },
    registryIntegrity: { exact: {}, next: {}, selectorComparison: {} },
    conformance: { baseline: {}, exact: {}, next: {}, common: {}, normalizations: [] },
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
  const targetOnly = clone(latest);
  targetOnly.target.requested = "specqr@3.0.0-rc.1";
  targetOnly.target.resolvedVersion = "3.0.0-rc.1";
  targetOnly.target.version = "3.0.0-rc.1";
  targetOnly.metadata.target.requested = "specqr@3.0.0-rc.1";
  targetOnly.metadata.target.resolvedVersion = "3.0.0-rc.1";
  targetOnly.metadata.packages.specqr = "3.0.0-rc.1";
  const specqrAdapter = targetOnly.adapters.find((adapter) => adapter.id === "specqr");
  specqrAdapter.packageVersion = "3.0.0-rc.1";
  const metadataResult = targetOnly.results.find((result) => result.vectorId === "package.metadata.published-surface" && result.adapterId === "specqr");
  metadataResult.details.packageSurface.metadata.version = "3.0.0-rc.1";
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
  assert.equal(warningComparison.blockingRegressions.filter((item) => item.kind === "matrix-renderer-helper-or-result-change").length, 3);
  assert(warningComparison.changes.every((change) => change.differences.some((difference) => difference.path.endsWith("warnings.length"))));

  const manualResult = latest.results.find((result) => {
    return result.adapterId === "specqr" && result.operation === "structuredAppend.generateSegments" && result.details?.structuredAppend?.diagnostics?.splitStrategy === "segment-boundary-byte-chunk";
  });
  assert(manualResult, "latest report must contain manual Structured Append diagnostics");
  const normalizedManual = normalizeRcResult(manualResult);
  assert(!Object.hasOwn(normalizedManual.details.structuredAppend.diagnostics, "splitUnits"));
  assert(rcComparisonNormalizations.some((rule) => rule.includes("splitUnits")));

  const suites = [JSON.parse(await readFile("vectors/package-surface.json", "utf8"))];
  suites[0].file = "vectors/package-surface.json";
  const candidateSuites = suitesForTarget(suites, "3.0.0-rc.1");
  assert.equal(candidateSuites.suites[0].vectors[0].expect.package.metadataSubset.version, "3.0.0-rc.1");
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

  const contract = {
    target: { requested: "specqr@3.0.0-rc.1", resolvedVersion: "3.0.0-rc.1", source: "npm-registry" },
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
  assert(pagesBuilder.includes("!artifactOnlySchemas.has(entry.name)"), "Pages builder must exclude artifact-only schemas");

  const rcDoc = await readFile("docs/rc-validation.md", "utf8");
  for (const text of [
    "specqr@2.4.0",
    "specqr@3.0.0-rc.1",
    "specqr@next",
    "ad1c384475ff09cc27fcbb5479d2a230431dab43d403b86deba13b1005530f04",
    "b8f906d95076316c7de97a3a4f376dfbea70e4aef2e19dbeb6dbbfde96b577d4",
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
