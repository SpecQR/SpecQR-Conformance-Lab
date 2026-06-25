import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generate } from "specqr";
import jsqrAdapter from "../adapters/jsqr.js";
import nayukiAdapter, { compareMatrixRows, matrixRows, matrixSha256 } from "../adapters/nayuki.js";
import specqrAdapter, { binaryHexToBytes, deepSubsetMatch } from "../adapters/specqr.js";
import zbarAdapter, { parseZbarOutput } from "../adapters/zbar.js";
import zxingCliAdapter, { parseZxingOutput } from "../adapters/zxing-cli.js";
import { buildPages } from "./build-pages.js";
import { compareReportFiles, compareReports, renderComparisonMarkdown } from "./compare-reports.js";
import { pngToRgba } from "./png-rgba.js";
import { createReportMetadata, readInstalledPackageMetadata } from "./report-metadata.js";
import { badgeFileNames, createBadge, createBadgeSet, summarizeStatus } from "./report-utils.js";
import { activeAdapters, createConformanceReport } from "./run-conformance.js";
import { loadSchemas, schemaFiles, validateAllSchemas, validateSchemaValue } from "./validate-schemas.js";
import { verifyReportObject } from "./verify-report.js";
import { verifySpecqrTarget } from "./verify-specqr-target.js";
import { renderGithubSummary, writeGithubSummary } from "./write-github-summary.js";

const requiredPaths = [
  "package.json",
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/vector-schema.md",
  "docs/report-format.md",
  "docs/adapter-contract.md",
  "docs/known-limits.md",
  "docs/development-policy.md",
  "docs/release-readiness.md",
  "docs/dependency-policy.md",
  "docs/maintenance.md",
  "schemas/vector-suite-v1.schema.json",
  "schemas/conformance-report-v1.schema.json",
  "schemas/badge-v1.schema.json",
  "schemas/report-comparison-v1.schema.json",
  "vectors/schema.example.json",
  "vectors/core.json",
  "vectors/reference-nayuki.json",
  "vectors/gs1-digital-link.json",
  "vectors/structured-append.json",
  "vectors/planning-diagnostics.json",
  "vectors/kanji-eci-binary.json",
  "adapters/README.md",
  "adapters/specqr.js",
  "adapters/jsqr.js",
  "adapters/nayuki.js",
  "adapters/cli-decoder.js",
  "adapters/zbar.js",
  "adapters/zxing-cli.js",
  "tools/validate-vectors.js",
  "tools/validate-schemas.js",
  "tools/compare-reports.js",
  "tools/run-conformance.js",
  "tools/report.js",
  "tools/report-metadata.js",
  "tools/report-utils.js",
  "tools/verify-report.js",
  "tools/verify-specqr-target.js",
  "tools/write-github-summary.js",
  "tools/build-pages.js",
  "tools/png-rgba.js",
  ".github/workflows/verify.yml",
  ".github/workflows/pages.yml",
  ".github/workflows/conformance-filtered.yml",
  ".github/workflows/specqr-target.yml",
  ".github/ISSUE_TEMPLATE/vector-request.yml",
  ".github/ISSUE_TEMPLATE/adapter-request.yml",
  ".github/ISSUE_TEMPLATE/report-problem.yml",
  ".github/dependabot.yml"
];

const requiredScripts = ["test", "validate:vectors", "conformance", "report", "verify:report", "verify:target", "validate:schemas", "compare:reports", "summary", "pages:build", "verify"];
const allowedOperations = [
  "generate",
  "generateSegments",
  "estimate",
  "analyzeSegments",
  "getCapacity",
  "gs1.createElementString",
  "gs1.validateElementString",
  "gs1.createDigitalLink",
  "gs1.validateDigitalLink",
  "gs1.normalizeDigitalLink",
  "structuredAppend.generate",
  "structuredAppend.generateSegments",
  "structuredAppend.mergeParts"
];

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
}

function requireText(source, text, label) {
  if (!source.includes(text)) {
    throw new Error(`${label} missing required text: ${text}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function adjustStatusCounts(counts, fromStatus, toStatus) {
  counts[fromStatus] = (counts[fromStatus] ?? 0) - 1;
  counts[toStatus] = (counts[toStatus] ?? 0) + 1;
  if (fromStatus === "skipped" && toStatus !== "skipped") {
    counts.executed = (counts.executed ?? 0) + 1;
  } else if (fromStatus !== "skipped" && toStatus === "skipped") {
    counts.executed = (counts.executed ?? 0) - 1;
  }
}

function changeReportResultStatus(report, predicate, toStatus) {
  const result = report.results.find(predicate);
  assert(result, "test fixture result must exist");
  const fromStatus = result.status;
  result.status = toStatus;
  if (Array.isArray(result.checks) && result.checks.length > 0) {
    result.checks[0].status = toStatus;
  }
  adjustStatusCounts(report.summary, fromStatus, toStatus);
  adjustStatusCounts(report.summary.adapterSummary[result.adapterId], fromStatus, toStatus);
  return result;
}

async function fileExists(relativePath) {
  try {
    await access(path.resolve(relativePath));
    return true;
  } catch {
    return false;
  }
}

async function collectPublicFacingFiles() {
  const files = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "adapters/README.md",
    "docs/vector-schema.md",
    "docs/report-format.md",
    "docs/adapter-contract.md",
    "docs/known-limits.md",
    "docs/development-policy.md",
    "docs/release-readiness.md",
    "docs/dependency-policy.md",
    "docs/maintenance.md",
    ".github/ISSUE_TEMPLATE/vector-request.yml",
    ".github/ISSUE_TEMPLATE/adapter-request.yml",
    ".github/ISSUE_TEMPLATE/report-problem.yml",
    "reports/latest.json",
    "reports/latest.html"
  ];

  for (const relativePath of [
    "public/index.html",
    "public/reports/latest.json",
    "public/reports/latest.html"
  ]) {
    if (await fileExists(relativePath)) {
      files.push(relativePath);
    }
  }

  if (await fileExists("public/badges")) {
    const publicBadges = await readdir("public/badges");
    for (const fileName of publicBadges) {
      if (fileName.endsWith(".json")) {
        files.push(path.join("public/badges", fileName));
      }
    }
  }

  if (await fileExists("public/schemas")) {
    const publicSchemas = await readdir("public/schemas");
    for (const fileName of publicSchemas) {
      if (fileName.endsWith(".schema.json")) {
        files.push(path.join("public/schemas", fileName));
      }
    }
  }

  return files;
}

function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match) {
      specifiers.push(match[1]);
      match = pattern.exec(source);
    }
  }

  return specifiers;
}

function isSpecqrCoreSourceSpecifier(specifier) {
  return /(^|[\\/])SpecQR[\\/]src([\\/]|$)/.test(specifier);
}

try {
  for (const relativePath of requiredPaths) {
    await access(path.resolve(relativePath));
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  if (packageJson.name !== "@specqr/conformance-lab") {
    throw new Error("package name must be @specqr/conformance-lab");
  }

  if (packageJson.type !== "module") {
    throw new Error("package type must be module");
  }

  if (packageJson.engines?.node !== ">=18") {
    throw new Error("node engine must be >=18");
  }

  if (packageJson.devDependencies?.specqr !== "2.4.0") {
    throw new Error("SpecQR target must be published package specqr@2.4.0");
  }
  const installedSpecqrVersion = (await readInstalledPackageMetadata("specqr")).version;

  if (packageJson.devDependencies?.jsqr !== "1.4.0") {
    throw new Error("jsQR decoder target must be exact devDependency jsqr@1.4.0");
  }

  if (packageJson.devDependencies?.["nayuki-qr-code-generator"] !== "1.8.0") {
    throw new Error("Nayuki reference target must be exact devDependency nayuki-qr-code-generator@1.8.0");
  }

  for (const script of requiredScripts) {
    if (typeof packageJson.scripts?.[script] !== "string") {
      throw new Error(`missing npm script ${script}`);
    }
  }

  const readme = await readFile("README.md", "utf8");
  for (const text of [
    "外部から検証",
    "外部からブラックボックス検証",
    "npm に公開された `specqr@2.4.0`",
    "SpecQR core repository の source tree や local checkout には依存しません",
    "検証対象の SpecQR 実装を変更せず",
    "full QR reader",
    "Micro QR / rMQR",
    "GS1",
    "SpecQR",
    "jsQR",
    "Nayuki",
    "zbarimg",
    "ZXing CLI",
    "Kanji / ECI / binary suite",
    "Kanji mode、ECI UTF-8、raw binary payload",
    "missing `zbarimg` / ZXing CLI は CI failure ではありません",
    "reports/latest.json",
    "reports/latest.html",
    "badges/overall.json",
    "npm run summary",
    "npm run verify:target",
    "npm run compare:reports",
    "reports/baseline.json",
    "reports/candidate.json",
    "reports/comparison.json",
    "reports/comparison.md",
    "schemas/vector-suite-v1.schema.json",
    "schemas/conformance-report-v1.schema.json",
    "schemas/badge-v1.schema.json",
    "schemas/report-comparison-v1.schema.json",
    "npm run validate:schemas",
    "public/schemas/",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "docs/release-readiness.md",
    "docs/dependency-policy.md",
    "docs/maintenance.md",
    ".github/ISSUE_TEMPLATE/vector-request.yml",
    ".github/ISSUE_TEMPLATE/adapter-request.yml",
    ".github/ISSUE_TEMPLATE/report-problem.yml",
    "npm run conformance -- --list-suites",
    "npm run conformance -- --suite kanji-eci-binary",
    "npm run conformance -- --adapter specqr",
    "npm run conformance -- --vector core.generate.byte-text",
    "npm run verify:report",
    "npm run pages:build",
    "public/",
    "GitHub Step Summary",
    "conformance-report-node-22",
    ".github/workflows/conformance-filtered.yml",
    ".github/workflows/specqr-target.yml",
    "target.requested",
    "target.resolvedVersion",
    "比較 artifact",
    "調査 workflow",
    "investigation artifact",
    "release claim",
    "公開 Pages report",
    "docs/development-policy.md",
    ".github/workflows/pages.yml"
  ]) {
    requireText(readme, text, "README.md");
  }

  const contributing = await readFile("CONTRIBUTING.md", "utf8");
  for (const text of [
    "Japanese-main",
    "Add vectors",
    "Add adapters",
    "npm run validate:vectors",
    "npm run verify",
    "expected skip",
    "failure semantics",
    "SpecQR core source",
    "SpecQR <285361393+SpecQR@users.noreply.github.com>"
  ]) {
    requireText(contributing, text, "CONTRIBUTING.md");
  }

  const security = await readFile("SECURITY.md", "utf8");
  for (const text of [
    "Reporting a security issue",
    "conformance / report / comparison infrastructure",
    "QR generation core",
    "workflow",
    "auth token",
    "dependency",
    "report publishing",
    "private token",
    "local machine path"
  ]) {
    requireText(security, text, "SECURITY.md");
  }

  const filteredWorkflow = await readFile(".github/workflows/conformance-filtered.yml", "utf8");
  for (const text of [
    "workflow_dispatch",
    "FILTER_SUITE",
    "FILTER_CATEGORY",
    "FILTER_ADAPTER",
    "FILTER_VECTOR",
    "node --input-type=module",
    "spawnSync(process.execPath, args, { stdio: \"inherit\" })",
    "args.push(flag, value.trim())",
    "npm run verify:report -- --report reports/latest.json"
  ]) {
    requireText(filteredWorkflow, text, ".github/workflows/conformance-filtered.yml");
  }
  assert(!filteredWorkflow.includes("eval "), "filtered workflow must not use eval");
  assert(!filteredWorkflow.includes("bash -c"), "filtered workflow must not pass filter input through bash -c");

  const targetWorkflow = await readFile(".github/workflows/specqr-target.yml", "utf8");
  for (const text of [
    "workflow_dispatch",
    "package_spec",
    "default: specqr@2.4.0",
    "node_version",
    "default: \"22\"",
    "SPECQR_TARGET_REQUESTED",
    "SPECQR_TARGET_SOURCE",
    "npm ci",
    "node tools/run-conformance.js --output reports/baseline.json",
    "npm run verify:report -- --report reports/baseline.json",
    "npm install --no-save --package-lock=false \"$PACKAGE_SPEC\"",
    "git diff --exit-code -- package.json package-lock.json",
    "npm run verify:target",
    "npm run validate:vectors",
    "npm test",
    "node tools/run-conformance.js --output reports/candidate.json",
    "npm run verify:report -- --report reports/candidate.json",
    "continue-on-error: true",
    "npm run compare:reports --",
    "--base reports/baseline.json",
    "--candidate reports/candidate.json",
    "--json-output reports/comparison.json",
    "--markdown-output reports/comparison.md",
    "cat reports/comparison.md >> \"$GITHUB_STEP_SUMMARY\"",
    "actions/upload-artifact@v4"
  ]) {
    requireText(targetWorkflow, text, ".github/workflows/specqr-target.yml");
  }
  assert(!targetWorkflow.includes("deploy-pages"), "target workflow must not deploy Pages");
  assert(!targetWorkflow.includes("upload-pages-artifact"), "target workflow must not upload Pages artifacts");

  const knownLimits = await readFile("docs/known-limits.md", "utf8");
  for (const text of [
    "何を検証していないか: Micro QR",
    "何を検証していないか: rMQR",
    "何を検証していないか: full GS1 catalog",
    "何を検証していないか: full QR reader",
    "何を検証していないか: scanner metadata merge support",
    "何を検証していないか: logo/styled QR",
    "zbarimg adapter",
    "ZXing CLI adapter",
    "output format",
    "ECI assignment",
    "decode.binaryHex"
  ]) {
    requireText(knownLimits, text, "docs/known-limits.md");
  }

  const schemaDoc = await readFile("docs/vector-schema.md", "utf8");
  for (const text of [
    "Vector Schema v1",
    "Suite Format",
    "Vector Format",
    "binaryHex",
    "decode",
    "matrixHash",
    "diagnostics",
    "referenceMatrix",
    "planning",
    "Planning / Diagnostics",
    "GS1",
    "Digital Link",
    "Structured Append",
    "ECI assignment",
    "expect.rejects",
    "expect.validation"
  ]) {
    requireText(schemaDoc, text, "docs/vector-schema.md");
  }

  const reportFormatDoc = await readFile("docs/report-format.md", "utf8");
  for (const text of [
    "Report Format",
    "JSON Schema",
    "conformance-report-v1.schema.json",
    "badge-v1.schema.json",
    "report-comparison-v1.schema.json",
    "run.mode: \"filtered\"",
    "Compatibility policy",
    "additive field"
  ]) {
    requireText(reportFormatDoc, text, "docs/report-format.md");
  }

  const releaseReadiness = await readFile("docs/release-readiness.md", "utf8");
  for (const text of [
    "現時点では release",
    "Verify workflow",
    "Pages workflow",
    "reports/latest.json",
    "schemas/vector-suite-v1.schema.json",
    "failed` / `error",
    "expected skip",
    "\"private\": true",
    "tag / GitHub release / npm publish",
    "https://github.com/SpecQR/SpecQR"
  ]) {
    requireText(releaseReadiness, text, "docs/release-readiness.md");
  }

  const dependencyPolicy = await readFile("docs/dependency-policy.md", "utf8");
  for (const text of [
    "specqr",
    "exact pin",
    "specqr@latest",
    "specqr@next",
    "manual target workflow",
    "automatic dependency bump",
    "zbarimg",
    "ZXing CLI",
    "optional decoder lane",
    "Adding dependencies",
    "Dependabot",
    "GitHub Actions"
  ]) {
    requireText(dependencyPolicy, text, "docs/dependency-policy.md");
  }

  const maintenance = await readFile("docs/maintenance.md", "utf8");
  for (const text of [
    "Routine checks",
    "Before changing workflows",
    "Before adding adapters",
    "SpecQR core source import"
  ]) {
    requireText(maintenance, text, "docs/maintenance.md");
  }

  const developmentPolicy = await readFile("docs/development-policy.md", "utf8");
  for (const text of [
    "filtered conformance run",
    "full `npm run verify`",
    "npm run verify:report"
  ]) {
    requireText(developmentPolicy, text, "docs/development-policy.md");
  }

  for (const operation of allowedOperations) {
    requireText(schemaDoc, operation, "docs/vector-schema.md");
  }

  const validator = await readFile("tools/validate-vectors.js", "utf8");
  for (const operation of allowedOperations) {
    requireText(validator, `"${operation}"`, "tools/validate-vectors.js");
  }

  const publicLeakTerms = [
    { text: "/Users/", label: "absolute user path" },
    { text: "kifu", label: "local user name", caseInsensitive: true },
    { text: "Codex", label: "implementation environment name" },
    { text: "/SpecQR/src", label: "local SpecQR source path" },
    { text: "this goal", label: "implementation-thread wording", caseInsensitive: true },
    { text: "この goal", label: "implementation-thread wording" }
  ];
  for (const relativePath of await collectPublicFacingFiles()) {
    const text = await readFile(relativePath, "utf8");
    for (const term of publicLeakTerms) {
      const haystack = term.caseInsensitive ? text.toLowerCase() : text;
      const needle = term.caseInsensitive ? term.text.toLowerCase() : term.text;
      if (haystack.includes(needle)) {
        throw new Error(`${relativePath} contains ${term.label}: ${term.text}`);
      }
    }
  }

  const dependabot = await readFile(".github/dependabot.yml", "utf8");
  for (const text of [
    "package-ecosystem: \"github-actions\"",
    "interval: \"weekly\""
  ]) {
    requireText(dependabot, text, ".github/dependabot.yml");
  }
  assert(!dependabot.includes("package-ecosystem: \"npm\""), "Dependabot must not auto-update npm dependencies");
  assert(!dependabot.includes("specqr"), "Dependabot must not mention or auto-update the pinned specqr baseline");

  const issueTemplateChecks = [
    [".github/ISSUE_TEMPLATE/vector-request.yml", ["Vector request", "目的", "期待値"]],
    [".github/ISSUE_TEMPLATE/adapter-request.yml", ["Adapter request", "対象 scope", "skip / failure 方針"]],
    [".github/ISSUE_TEMPLATE/report-problem.yml", ["Report problem", "token や private path は書かないでください"]]
  ];
  for (const [templatePath, texts] of issueTemplateChecks) {
    const template = await readFile(templatePath, "utf8");
    for (const text of texts) {
      requireText(template, text, templatePath);
    }
  }

  const sourceLikeFiles = requiredPaths.filter((relativePath) => {
    return relativePath.endsWith(".js") || relativePath === "package.json";
  });
  const filesToInspect = await Promise.all(sourceLikeFiles.map(async (relativePath) => {
    return [relativePath, await readFile(relativePath, "utf8")];
  }));

  for (const [relativePath, text] of filesToInspect) {
    for (const specifier of importSpecifiers(text)) {
      if (isSpecqrCoreSourceSpecifier(specifier)) {
        throw new Error(`${relativePath} imports SpecQR core source: ${specifier}`);
      }
    }
  }

  const listSuitesRun = spawnSync(process.execPath, ["tools/run-conformance.js", "--list-suites"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert(listSuitesRun.status === 0, "--list-suites must exit successfully");
  const listedSuites = JSON.parse(listSuitesRun.stdout);
  assert(
    listedSuites.suites.some((suite) => suite.id === "kanji-eci-binary"),
    "--list-suites must include kanji-eci-binary"
  );

  const listAdaptersRun = spawnSync(process.execPath, ["tools/run-conformance.js", "--list-adapters"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert(listAdaptersRun.status === 0, "--list-adapters must exit successfully");
  const listedAdapters = JSON.parse(listAdaptersRun.stdout);
  assert(
    listedAdapters.adapters.map((adapter) => adapter.id).join(",") === activeAdapters.map((adapter) => adapter.id).join(","),
    "--list-adapters must include active adapters in runner order"
  );

  const suiteFilteredReport = await createConformanceReport({
    filters: {
      suites: ["kanji-eci-binary"],
      adapters: ["specqr"]
    }
  });
  assert(suiteFilteredReport.report.run.mode === "filtered", "suite filtered run must record filtered mode");
  assert(suiteFilteredReport.report.summary.totalVectors === 12, "suite filter must select only kanji-eci-binary vectors");
  assert(
    suiteFilteredReport.report.results.every((result) => result.suiteId === "kanji-eci-binary"),
    "suite filter must return only that suite's vectors"
  );

  const adapterFilteredReport = await createConformanceReport({
    filters: {
      suites: ["core"],
      adapters: ["specqr"]
    }
  });
  assert(adapterFilteredReport.report.adapters.length === 1, "adapter filter must select one adapter");
  assert(adapterFilteredReport.report.adapters[0].id === "specqr", "adapter filter must select specqr");
  assert(
    adapterFilteredReport.report.results.every((result) => result.adapterId === "specqr"),
    "adapter filter must return only that adapter's results"
  );

  const vectorFilteredReport = await createConformanceReport({
    filters: {
      vectors: ["core.generate.byte-text"]
    }
  });
  assert(vectorFilteredReport.report.summary.totalVectors === 1, "vector filter must select one vector");
  assert(vectorFilteredReport.report.summary.totalResults === activeAdapters.length, "vector filter must run selected vector across adapters");
  assert(
    vectorFilteredReport.report.results.every((result) => result.vectorId === "core.generate.byte-text"),
    "vector filter must return expected single-vector results"
  );

  const fullReportForIntegrity = await createConformanceReport({
    metadataOptions: {
      env: {}
    }
  });
  assert(fullReportForIntegrity.report.target.requested === "specqr@2.4.0", "default report target must request pinned specqr@2.4.0");
  assert(fullReportForIntegrity.report.target.resolvedVersion === installedSpecqrVersion, "report target must include resolved SpecQR version");
  assert(fullReportForIntegrity.report.target.version === fullReportForIntegrity.report.target.resolvedVersion, "legacy target.version must remain resolved version");
  assert(fullReportForIntegrity.report.target.source === "npm", "default report target source must be npm");
  const validIntegrity = await verifyReportObject(fullReportForIntegrity.report);
  assert(validIntegrity.ok, "valid full report must pass integrity check");
  const legacyCompatibleReport = JSON.parse(JSON.stringify(fullReportForIntegrity.report));
  delete legacyCompatibleReport.target.requested;
  delete legacyCompatibleReport.target.resolvedVersion;
  const legacyCompatibleIntegrity = await verifyReportObject(legacyCompatibleReport);
  assert(legacyCompatibleIntegrity.ok, "legacy target.version report must remain integrity-compatible");
  const mismatchedReport = JSON.parse(JSON.stringify(fullReportForIntegrity.report));
  mismatchedReport.summary.totalResults += 1;
  const mismatchedIntegrity = await verifyReportObject(mismatchedReport);
  assert(!mismatchedIntegrity.ok, "report integrity checker must catch mismatched summary counts");
  assert(
    mismatchedIntegrity.errors.some((error) => error.label === "summary"),
    "mismatched summary count must be reported as a summary integrity error"
  );

  const schemas = await loadSchemas();
  const coreSuiteForSchema = JSON.parse(await readFile("vectors/core.json", "utf8"));
  const validVectorSchemaResult = validateSchemaValue(coreSuiteForSchema, schemas.vectorSuite);
  assert(validVectorSchemaResult.ok, "valid vector suite must pass JSON Schema validation");
  const invalidVectorSuite = cloneJson(coreSuiteForSchema);
  delete invalidVectorSuite.vectors[0].id;
  const invalidVectorSchemaResult = validateSchemaValue(invalidVectorSuite, schemas.vectorSuite);
  assert(!invalidVectorSchemaResult.ok, "invalid vector suite must fail JSON Schema validation");
  assert(
    invalidVectorSchemaResult.errors.some((schemaError) => schemaError.path === "$.vectors[0].id"),
    "invalid vector suite error must include a clear vector id path"
  );

  const reportSchemaResult = validateSchemaValue(fullReportForIntegrity.report, schemas.conformanceReport);
  assert(reportSchemaResult.ok, "latest report shape must pass JSON Schema validation");
  const allSchemaValidation = await validateAllSchemas();
  assert(allSchemaValidation.ok, "current vectors, latest report, badges, and self-comparison must pass schema validation");
  assert(
    allSchemaValidation.validated.filter((entry) => entry.schema === schemaFiles.badge).length >= badgeFileNames.length,
    "current badge files must pass schema validation"
  );
  assert(
    allSchemaValidation.validated.some((entry) => entry.file === "self-comparison:reports/latest.json"),
    "schema validation must include a report self-comparison"
  );

  const identicalComparison = compareReports(fullReportForIntegrity.report, cloneJson(fullReportForIntegrity.report), {
    now: new Date("2026-01-01T00:00:00.000Z")
  });
  assert(!identicalComparison.hasChanges, "identical reports must produce a no-op comparison");
  assert(!identicalComparison.hasRegression, "identical reports must not report regressions");
  assert(identicalComparison.resultStatusChanges.length === 0, "identical reports must not report status changes");
  assert(identicalComparison.checkStatusChanges.length === 0, "identical reports must not report check changes");
  const comparisonSchemaResult = validateSchemaValue(identicalComparison, schemas.reportComparison);
  assert(comparisonSchemaResult.ok, "comparison output must pass JSON Schema validation");

  const failingCandidateReport = cloneJson(fullReportForIntegrity.report);
  failingCandidateReport.target.requested = "specqr@next";
  failingCandidateReport.target.resolvedVersion = "2.5.0";
  failingCandidateReport.target.version = "2.5.0";
  failingCandidateReport.metadata.target.requested = "specqr@next";
  failingCandidateReport.metadata.target.resolvedVersion = "2.5.0";
  failingCandidateReport.metadata.packages.specqr = "2.5.0";
  const failedResult = changeReportResultStatus(
    failingCandidateReport,
    (result) => result.adapterId === "specqr" && result.status === "passed",
    "failed"
  );
  const failingComparison = compareReports(fullReportForIntegrity.report, failingCandidateReport, {
    now: new Date("2026-01-01T00:00:00.000Z")
  });
  assert(failingComparison.hasChanges, "candidate failure must produce comparison changes");
  assert(failingComparison.hasRegression, "candidate new required failure must be detected as regression");
  assert(
    failingComparison.resultStatusChanges.some((change) => {
      return change.vectorId === failedResult.vectorId && change.adapterId === "specqr" && change.regression;
    }),
    "candidate new required failure must be present in result status changes"
  );
  assert(
    failingComparison.checkStatusChanges.some((change) => {
      return change.vectorId === failedResult.vectorId && change.adapterId === "specqr" && change.regression;
    }),
    "candidate new required check failure must be present in check status changes"
  );
  const failingMarkdown = renderComparisonMarkdown(failingComparison);
  assert(failingMarkdown.includes("Base requested: `specqr@2.4.0`"), "comparison markdown must include base requested target");
  assert(failingMarkdown.includes("Candidate requested: `specqr@next`"), "comparison markdown must include candidate requested target");
  assert(failingMarkdown.includes("resolved: `specqr@2.5.0`"), "comparison markdown must include candidate resolved target");
  assert(failingMarkdown.includes("| specqr |"), "comparison markdown must include adapter changes");

  const optionalSkipCandidateReport = cloneJson(fullReportForIntegrity.report);
  changeReportResultStatus(
    optionalSkipCandidateReport,
    (result) => result.adapterId === "zbarimg" && result.status === "skipped",
    "passed"
  );
  const optionalSkipComparison = compareReports(fullReportForIntegrity.report, optionalSkipCandidateReport, {
    now: new Date("2026-01-01T00:00:00.000Z")
  });
  assert(optionalSkipComparison.hasChanges, "optional skip changes must be reported");
  assert(!optionalSkipComparison.hasRegression, "optional skip improvement must not be a regression");
  assert(
    optionalSkipComparison.resultStatusChanges.some((change) => change.adapterId === "zbarimg" && !change.regression),
    "optional skip change must be visible as a non-regression status change"
  );

  const compareTmpRoot = await mkdtemp(path.join(tmpdir(), "specqr-compare-test-"));
  try {
    const baseReportPath = path.join(compareTmpRoot, "base.json");
    const failingCandidatePath = path.join(compareTmpRoot, "candidate-failing.json");
    const optionalCandidatePath = path.join(compareTmpRoot, "candidate-optional.json");
    const comparisonJsonPath = path.join(compareTmpRoot, "comparison.json");
    const comparisonMarkdownPath = path.join(compareTmpRoot, "comparison.md");
    await writeFile(baseReportPath, `${JSON.stringify(fullReportForIntegrity.report, null, 2)}\n`, "utf8");
    await writeFile(failingCandidatePath, `${JSON.stringify(failingCandidateReport, null, 2)}\n`, "utf8");
    await writeFile(optionalCandidatePath, `${JSON.stringify(optionalSkipCandidateReport, null, 2)}\n`, "utf8");

    const optionalCliRun = spawnSync(process.execPath, [
      "tools/compare-reports.js",
      "--base",
      baseReportPath,
      "--candidate",
      optionalCandidatePath
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert(optionalCliRun.status === 0, "compare CLI must not fail by default for non-regression count/status changes");

    const failingCliRun = spawnSync(process.execPath, [
      "tools/compare-reports.js",
      "--base",
      baseReportPath,
      "--candidate",
      failingCandidatePath,
      "--fail-on-regression"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert(failingCliRun.status !== 0, "compare CLI --fail-on-regression must fail on new required failures");

    const fileComparison = await compareReportFiles({
      basePath: baseReportPath,
      candidatePath: optionalCandidatePath,
      jsonOutputPath: comparisonJsonPath,
      markdownOutputPath: comparisonMarkdownPath
    });
    assert(fileComparison.ok, "compareReportFiles must succeed without fail-on-regression");
    await access(comparisonJsonPath);
    await access(comparisonMarkdownPath);
    const comparisonMarkdown = await readFile(comparisonMarkdownPath, "utf8");
    assert(comparisonMarkdown.includes("SpecQR Conformance Comparison"), "comparison markdown file must include title");
  } finally {
    await rm(compareTmpRoot, { recursive: true, force: true });
  }

  const summaryMarkdown = renderGithubSummary(fullReportForIntegrity.report);
  const specqrCounts = fullReportForIntegrity.report.summary.adapterSummary.specqr;
  assert(summaryMarkdown.includes("# SpecQR Conformance Summary"), "summary markdown must include title");
  assert(summaryMarkdown.includes("- 対象 requested: `specqr@2.4.0`"), "summary markdown must include requested target");
  assert(summaryMarkdown.includes(`- 対象 resolved: \`specqr@${installedSpecqrVersion}\` (\`npm\`)`), "summary markdown must include resolved target");
  assert(
    summaryMarkdown.includes(`| specqr | required | active | ${specqrCounts.total} | ${specqrCounts.executed} | ${specqrCounts.passed} | ${specqrCounts.failed} | ${specqrCounts.error} | ${specqrCounts.skipped} |`),
    "summary markdown must include SpecQR adapter counts"
  );
  assert(summaryMarkdown.includes("GS1 / DL"), "summary markdown must include GS1 / DL scope");
  assert(summaryMarkdown.includes("Structured Append"), "summary markdown must include Structured Append scope");
  assert(summaryMarkdown.includes("Planning / Diagnostics"), "summary markdown must include Planning / Diagnostics scope");
  assert(summaryMarkdown.includes("Kanji / ECI / binary"), "summary markdown must include Kanji / ECI / binary scope");

  const optionalUnavailableReport = JSON.parse(JSON.stringify(fullReportForIntegrity.report));
  optionalUnavailableReport.adapters.push({
    id: "optional-demo",
    name: "Optional demo decoder",
    required: false,
    status: "optional",
    lane: "optional-decode-readability",
    commandCandidates: ["optional-demo"]
  });
  optionalUnavailableReport.summary.adapterSummary["optional-demo"] = {
    id: "optional-demo",
    name: "Optional demo decoder",
    status: "optional",
    total: 1,
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 1,
    error: 0
  };
  optionalUnavailableReport.results.push({
    suiteId: "test",
    vectorId: "test.optional-demo.unavailable",
    title: "Optional demo unavailable",
    adapterId: "optional-demo",
    category: "test",
    operation: "generate",
    status: "skipped",
    checks: [
      {
        name: "availability",
        status: "skipped",
        reason: "optional-demo not available"
      }
    ],
    reason: "optional-demo not available"
  });
  const optionalSummaryMarkdown = renderGithubSummary(optionalUnavailableReport);
  assert(optionalSummaryMarkdown.includes("optional-demo"), "summary markdown must include optional decoder id");
  assert(optionalSummaryMarkdown.includes("Availability skips"), "summary markdown must describe availability skips");
  assert(
    optionalSummaryMarkdown.includes("| optional-demo | optional-demo | 1 | 1 | 0 |"),
    "summary markdown must count optional decoder availability skips"
  );

  const summaryTmpRoot = await mkdtemp(path.join(tmpdir(), "specqr-summary-test-"));
  try {
    const summaryReportPath = path.join(summaryTmpRoot, "latest.json");
    await writeFile(summaryReportPath, `${JSON.stringify(fullReportForIntegrity.report, null, 2)}\n`, "utf8");
    let summaryStdout = "";
    await writeGithubSummary({
      reportPath: summaryReportPath,
      env: {},
      stdout: {
        write(chunk) {
          summaryStdout += chunk;
        }
      }
    });
    assert(summaryStdout.includes("# SpecQR Conformance Summary"), "summary must write to stdout without GITHUB_STEP_SUMMARY");
  } finally {
    await rm(summaryTmpRoot, { recursive: true, force: true });
  }

  const targetOverrideReport = await createConformanceReport({
    filters: {
      vectors: ["core.generate.byte-text"],
      adapters: ["specqr"]
    },
    metadataOptions: {
      env: {
        SPECQR_TARGET_REQUESTED: "specqr@next",
        SPECQR_TARGET_SOURCE: "npm"
      }
    }
  });
  assert(targetOverrideReport.report.target.requested === "specqr@next", "env requested target must appear in report target");
  assert(targetOverrideReport.report.target.resolvedVersion === installedSpecqrVersion, "env target report must still use installed SpecQR version");
  assert(targetOverrideReport.report.metadata.target.requested === "specqr@next", "env requested target must appear in report metadata");
  const overrideSummary = renderGithubSummary(targetOverrideReport.report);
  assert(overrideSummary.includes("- 対象 requested: `specqr@next`"), "summary must include overridden requested target");
  assert(overrideSummary.includes(`- 対象 resolved: \`specqr@${installedSpecqrVersion}\` (\`npm\`)`), "summary must include installed resolved target");

  const installedTarget = await verifySpecqrTarget({
    env: {
      SPECQR_TARGET_REQUESTED: "specqr@2.4.0",
      SPECQR_TARGET_SOURCE: "npm"
    }
  });
  assert(installedTarget.ok, "verifySpecqrTarget must succeed for installed specqr package");
  assert(installedTarget.target.requested === "specqr@2.4.0", "verifySpecqrTarget must echo requested target");
  assert(installedTarget.target.resolvedVersion === installedSpecqrVersion, "verifySpecqrTarget must read installed SpecQR version");

  const missingTargetTmpRoot = await mkdtemp(path.join(tmpdir(), "specqr-missing-target-test-"));
  try {
    let missingError = null;
    try {
      await readInstalledPackageMetadata("specqr", { cwd: missingTargetTmpRoot });
    } catch (error) {
      missingError = error;
    }
    assert(missingError, "missing SpecQR package metadata must fail");
    assert(
      /Unable to read installed package metadata for specqr/.test(missingError.message),
      "missing SpecQR package metadata must fail clearly"
    );
  } finally {
    await rm(missingTargetTmpRoot, { recursive: true, force: true });
  }

  const passingWithScopeSkipsBadge = createBadge("overall", {
    executed: 12,
    passed: 12,
    failed: 0,
    skipped: 24,
    error: 0
  });
  assert(passingWithScopeSkipsBadge.color === "green", "expected scope skips must not make overall badge red");

  const skippedOnlyBadge = createBadge("scope", {
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 5,
    error: 0
  });
  assert(skippedOnlyBadge.color === "yellow", "skipped-only badge must be yellow");
  assert(summarizeStatus({ executed: 0, skipped: 5 }).key === "skipped", "skipped-only status must be explicit");

  const failingBadge = createBadge("scope", {
    executed: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    error: 0
  });
  assert(failingBadge.color === "red", "failing badge must be red");

  const passingCounts = {
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    error: 0
  };
  const badgeSet = createBadgeSet({
    ...passingCounts,
    skipped: 42,
    adapterSummary: {
      specqr: passingCounts,
      jsqr: passingCounts,
      nayuki: passingCounts,
      zbarimg: {
        executed: 0,
        passed: 0,
        failed: 0,
        skipped: 3,
        error: 0
      },
      "zxing-cli": {
        executed: 0,
        passed: 0,
        failed: 0,
        skipped: 3,
        error: 0
      }
    },
    gs1DigitalLink: passingCounts,
    kanjiEciBinary: passingCounts,
    structuredAppend: {
      executed: 0,
      passed: 0,
      failed: 0,
      skipped: 3,
      error: 0
    },
    planningDiagnostics: passingCounts
  });
  for (const fileName of badgeFileNames) {
    assert(badgeSet[fileName]?.schemaVersion === 1, `${fileName} must be Shields-compatible badge JSON`);
    const badgeSchemaResult = validateSchemaValue(badgeSet[fileName], schemas.badge);
    assert(badgeSchemaResult.ok, `${fileName} must pass badge JSON Schema validation`);
  }
  assert(badgeSet["overall.json"].color === "green", "overall badge with expected skips must stay green");
  assert(badgeSet["kanji-eci-binary.json"].color === "green", "Kanji / ECI / binary passing scope badge must be green");
  assert(badgeSet["structured-append.json"].color === "yellow", "skipped-only scope badge must be yellow");
  assert(badgeSet["zbarimg.json"].color === "yellow", "missing optional zbarimg lane badge must be yellow");
  assert(badgeSet["zxing-cli.json"].color === "yellow", "missing optional ZXing lane badge must be yellow");

  const metadata = await createReportMetadata({
    now: new Date("2026-01-01T00:00:00.000Z"),
    env: {}
  });
  assert(metadata.generatedAt === "2026-01-01T00:00:00.000Z", "report metadata must include generatedAt");
  assert(metadata.runtime.node === process.version, "report metadata must include Node version");
  assert(typeof metadata.runtime.platform === "string" && metadata.runtime.platform.length > 0, "report metadata must include platform");
  assert(typeof metadata.runtime.arch === "string" && metadata.runtime.arch.length > 0, "report metadata must include arch");
  assert(metadata.packages.specqr === installedSpecqrVersion, "report metadata must include specqr package version");
  assert(metadata.target.packageName === "specqr", "report metadata must include target package name");
  assert(metadata.target.requested === "specqr@2.4.0", "report metadata must include default requested target");
  assert(metadata.target.resolvedVersion === metadata.packages.specqr, "report metadata target must use installed SpecQR version");
  assert(metadata.target.source === "npm", "report metadata target source must default to npm");
  assert(metadata.packages.jsqr === "1.4.0", "report metadata must include jsqr package version");
  assert(
    metadata.packages["nayuki-qr-code-generator"] === "1.8.0",
    "report metadata must include Nayuki package version"
  );

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "specqr-pages-test-"));
  try {
    await mkdir(path.join(tmpRoot, "reports"), { recursive: true });
    await mkdir(path.join(tmpRoot, "badges"), { recursive: true });
    await mkdir(path.join(tmpRoot, "schemas"), { recursive: true });
    await writeFile(path.join(tmpRoot, "reports/latest.html"), "<!doctype html><title>report</title>", "utf8");
    await writeFile(path.join(tmpRoot, "reports/latest.json"), `${JSON.stringify({ schemaVersion: 1 })}\n`, "utf8");
    for (const [fileName, badge] of Object.entries(badgeSet)) {
      await writeFile(path.join(tmpRoot, "badges", fileName), `${JSON.stringify(badge)}\n`, "utf8");
    }
    for (const fileName of Object.values(schemaFiles).map((schemaPath) => path.basename(schemaPath))) {
      await writeFile(path.join(tmpRoot, "schemas", fileName), `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema" })}\n`, "utf8");
    }

    const pagesResult = await buildPages({ cwd: tmpRoot });
    assert(pagesResult.files.includes("index.html"), "Pages artifact must include index.html");
    assert(pagesResult.files.includes("reports/latest.json"), "Pages artifact must include reports/latest.json");
    assert(
      pagesResult.files.includes("schemas/vector-suite-v1.schema.json"),
      "Pages artifact must include public schema files"
    );
    await access(path.join(tmpRoot, "public/index.html"));
    await access(path.join(tmpRoot, "public/reports/latest.json"));
    await access(path.join(tmpRoot, "public/schemas/vector-suite-v1.schema.json"));
    for (const fileName of badgeFileNames) {
      await access(path.join(tmpRoot, "public/badges", fileName));
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const bytes = binaryHexToBytes("00ff");
  assert(bytes instanceof Uint8Array, "binaryHexToBytes must return Uint8Array");
  assert(bytes.length === 2 && bytes[0] === 0x00 && bytes[1] === 0xff, "binaryHexToBytes must decode 00ff");

  assert(
    deepSubsetMatch({ a: { b: 1 }, c: [true] }, { a: { b: 1, extra: 2 }, c: [true, false] }).ok,
    "deepSubsetMatch must pass nested subset matches"
  );
  assert(
    !deepSubsetMatch({ a: { b: 2 } }, { a: { b: 1 } }).ok,
    "deepSubsetMatch must fail nested mismatches"
  );

  const coreSuite = JSON.parse(await readFile("vectors/core.json", "utf8"));
  const dataTooLongVector = coreSuite.vectors.find((vector) => vector.id === "core.estimate.data-too-long-reject");
  assert(dataTooLongVector, "core data-too-long vector must exist");
  const dataTooLongResult = await specqrAdapter.run(dataTooLongVector);
  assert(dataTooLongResult.status === "passed", "data-too-long reject vector must pass");
  assert(
    dataTooLongResult.checks.some((check) => check.name === "rejects" && check.status === "passed"),
    "data-too-long reject vector must pass rejects check"
  );

  const gs1Suite = JSON.parse(await readFile("vectors/gs1-digital-link.json", "utf8"));
  const gtinElementVector = gs1Suite.vectors.find((vector) => vector.id === "gs1.create-element-string.gtin-01");
  assert(gtinElementVector, "GS1 GTIN element-string vector must exist");
  const gtinElementResult = await specqrAdapter.run(gtinElementVector);
  assert(gtinElementResult.status === "passed", "SpecQR GS1 element-string vector must pass");
  assert(
    gtinElementResult.checks.some((check) => check.name === "gs1" && check.status === "passed"),
    "SpecQR GS1 element-string vector must pass gs1 check"
  );
  assert(gtinElementResult.details?.value === "0104912345678904", "SpecQR GS1 element-string details must include actual value");

  const missingSeparatorVector = gs1Suite.vectors.find((vector) => vector.id === "gs1.validate-element-string.missing-separator-reject");
  assert(missingSeparatorVector, "GS1 missing-separator negative vector must exist");
  const missingSeparatorResult = await specqrAdapter.run(missingSeparatorVector);
  assert(missingSeparatorResult.status === "passed", "SpecQR GS1 negative validation vector must pass by rejecting");
  assert(
    missingSeparatorResult.checks.some((check) => check.name === "validation" && check.status === "passed"),
    "SpecQR GS1 negative validation vector must pass validation check"
  );
  assert(
    missingSeparatorResult.details?.gs1?.errors?.some((error) => error.code === "GS1_MISSING_SEPARATOR"),
    "SpecQR GS1 negative validation result must expose expected error code"
  );

  const normalizeDigitalLinkVector = gs1Suite.vectors.find((vector) => vector.id === "gs1.normalize-digital-link.deterministic");
  assert(normalizeDigitalLinkVector, "GS1 Digital Link normalization vector must exist");
  const normalizeDigitalLinkResult = await specqrAdapter.run(normalizeDigitalLinkVector);
  assert(normalizeDigitalLinkResult.status === "passed", "SpecQR Digital Link normalization vector must pass");
  assert(
    normalizeDigitalLinkResult.checks.some((check) => check.name === "gs1" && check.status === "passed"),
    "SpecQR Digital Link normalization vector must pass gs1 check"
  );
  assert(
    normalizeDigitalLinkResult.details?.value === "https://id.gs1.org/01/04912345678904/10/ABC123?17=251231&linkType=all",
    "SpecQR Digital Link normalization details must include normalized URL"
  );

  const jsqrGs1SkipResult = await jsqrAdapter.run(gtinElementVector);
  assert(jsqrGs1SkipResult.status === "skipped", "jsQR must skip GS1 helper vectors");
  assert(/Unsupported operation/.test(jsqrGs1SkipResult.reason ?? ""), "jsQR GS1 skip reason must mention unsupported operation");

  const nayukiGs1SkipResult = await nayukiAdapter.run(gtinElementVector);
  assert(nayukiGs1SkipResult.status === "skipped", "Nayuki must skip GS1 helper vectors");
  assert(/Unsupported operation/.test(nayukiGs1SkipResult.reason ?? ""), "Nayuki GS1 skip reason must mention unsupported operation");

  const structuredAppendSuite = JSON.parse(await readFile("vectors/structured-append.json", "utf8"));
  const structuredAppendGenerateVector = structuredAppendSuite.vectors.find((vector) => {
    return vector.id === "structured-append.generate.alphanumeric-two-symbol";
  });
  assert(structuredAppendGenerateVector, "Structured Append generate vector must exist");
  const structuredAppendGenerateResult = await specqrAdapter.run(structuredAppendGenerateVector);
  assert(structuredAppendGenerateResult.status === "passed", "SpecQR Structured Append generate vector must pass");
  assert(
    structuredAppendGenerateResult.checks.some((check) => check.name === "structuredAppend" && check.status === "passed"),
    "SpecQR Structured Append generate vector must pass structuredAppend check"
  );
  assert(
    structuredAppendGenerateResult.details?.structuredAppend?.total === 2,
    "SpecQR Structured Append generate details must include total"
  );

  const structuredAppendMergeVector = structuredAppendSuite.vectors.find((vector) => {
    return vector.id === "structured-append.merge-parts.valid-string";
  });
  assert(structuredAppendMergeVector, "Structured Append merge vector must exist");
  const structuredAppendMergeResult = await specqrAdapter.run(structuredAppendMergeVector);
  assert(structuredAppendMergeResult.status === "passed", "SpecQR Structured Append merge vector must pass");
  assert(
    structuredAppendMergeResult.details?.structuredAppend?.data === "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "SpecQR Structured Append merge details must include merged data"
  );

  for (const vectorId of [
    "structured-append.merge-parts.missing-part-reject",
    "structured-append.merge-parts.duplicate-part-reject",
    "structured-append.merge-parts.parity-mismatch-reject"
  ]) {
    const negativeVector = structuredAppendSuite.vectors.find((vector) => vector.id === vectorId);
    assert(negativeVector, `${vectorId} must exist`);
    const negativeResult = await specqrAdapter.run(negativeVector);
    assert(negativeResult.status === "passed", `${vectorId} must pass by rejecting`);
    assert(
      negativeResult.checks.some((check) => check.name === "rejects" && check.status === "passed"),
      `${vectorId} must pass rejects check`
    );
  }

  const jsqrStructuredAppendSkipResult = await jsqrAdapter.run(structuredAppendGenerateVector);
  assert(jsqrStructuredAppendSkipResult.status === "skipped", "jsQR must skip Structured Append helper vectors");
  assert(
    /Structured Append/.test(jsqrStructuredAppendSkipResult.reason ?? ""),
    "jsQR Structured Append skip reason must mention Structured Append"
  );

  const nayukiStructuredAppendSkipResult = await nayukiAdapter.run(structuredAppendGenerateVector);
  assert(nayukiStructuredAppendSkipResult.status === "skipped", "Nayuki must skip Structured Append helper vectors");
  assert(
    /Structured Append/.test(nayukiStructuredAppendSkipResult.reason ?? ""),
    "Nayuki Structured Append skip reason must mention Structured Append"
  );

  const planningDiagnosticsSuite = JSON.parse(await readFile("vectors/planning-diagnostics.json", "utf8"));
  const estimateSimpleVector = planningDiagnosticsSuite.vectors.find((vector) => {
    return vector.id === "planning.estimate.byte-simple-success";
  });
  assert(estimateSimpleVector, "Planning estimate success vector must exist");
  const estimateSimpleResult = await specqrAdapter.run(estimateSimpleVector);
  assert(estimateSimpleResult.status === "passed", "SpecQR planning estimate success vector must pass");
  assert(
    estimateSimpleResult.checks.some((check) => check.name === "planning" && check.status === "passed"),
    "SpecQR planning estimate success vector must pass planning check"
  );

  const estimateTooLongVector = planningDiagnosticsSuite.vectors.find((vector) => {
    return vector.id === "planning.estimate.data-too-long-v1-h";
  });
  assert(estimateTooLongVector, "Planning data-too-long vector must exist");
  const estimateTooLongResult = await specqrAdapter.run(estimateTooLongVector);
  assert(estimateTooLongResult.status === "passed", "SpecQR data-too-long planning vector must pass");
  assert(
    estimateTooLongResult.checks.some((check) => check.name === "rejects" && check.status === "passed"),
    "SpecQR data-too-long planning vector must pass rejects check"
  );
  assert(
    estimateTooLongResult.checks.some((check) => check.name === "planning" && check.status === "passed"),
    "SpecQR data-too-long planning vector must pass planning check"
  );

  const getCapacityVector = planningDiagnosticsSuite.vectors.find((vector) => {
    return vector.id === "planning.get-capacity.v1-l-byte-control";
  });
  assert(getCapacityVector, "Planning getCapacity vector must exist");
  const getCapacityResult = await specqrAdapter.run(getCapacityVector);
  assert(getCapacityResult.status === "passed", "SpecQR getCapacity vector must pass");
  assert(
    getCapacityResult.details?.capacity?.maxBytes === 15,
    "SpecQR getCapacity details must include maxBytes"
  );

  const warningVector = planningDiagnosticsSuite.vectors.find((vector) => {
    return vector.id === "planning.diagnostics.warning.quiet-zone-too-small";
  });
  assert(warningVector, "Planning warning vector must exist");
  const warningResult = await specqrAdapter.run(warningVector);
  assert(warningResult.status === "passed", "SpecQR warning-code planning vector must pass");
  assert(
    warningResult.details?.planning?.ok === true,
    "SpecQR warning-code planning details must include ok true"
  );

  const jsqrPlanningDiagnosticsSkipResult = await jsqrAdapter.run(estimateSimpleVector);
  assert(jsqrPlanningDiagnosticsSkipResult.status === "skipped", "jsQR must skip Planning API vectors");
  assert(
    /Unsupported operation/.test(jsqrPlanningDiagnosticsSkipResult.reason ?? ""),
    "jsQR Planning API skip reason must mention unsupported operation"
  );

  const nayukiPlanningDiagnosticsSkipResult = await nayukiAdapter.run(estimateSimpleVector);
  assert(nayukiPlanningDiagnosticsSkipResult.status === "skipped", "Nayuki must skip Planning API vectors");
  assert(
    /Unsupported operation/.test(nayukiPlanningDiagnosticsSkipResult.reason ?? ""),
    "Nayuki Planning API skip reason must mention unsupported operation"
  );

  const specqrDecodeOnlyResult = await specqrAdapter.run({
    id: "test.decode-only",
    title: "Decode-only expectation",
    category: "test",
    operation: "generate",
    input: {
      text: "HELLO"
    },
    options: {},
    expect: {
      decode: {
        text: "HELLO"
      }
    }
  });
  assert(specqrDecodeOnlyResult.status === "skipped", "SpecQR adapter must leave decode-only expectation to decoder lanes");
  assert(
    specqrDecodeOnlyResult.checks.some((check) => check.name === "decode" && check.status === "skipped"),
    "SpecQR adapter decode expectation must be represented as a skipped check"
  );

  const pngImage = pngToRgba(generate("PNG TEST", { output: "png", scale: 12, margin: 4 }));
  assert(pngImage.width > 0 && pngImage.height > 0, "pngToRgba must parse SpecQR-generated PNG dimensions");
  assert(pngImage.rgba.length === pngImage.width * pngImage.height * 4, "pngToRgba must return RGBA pixels");

  const textVector = coreSuite.vectors.find((vector) => vector.id === "core.generate.byte-text");
  const jsqrTextResult = await jsqrAdapter.run(textVector);
  assert(jsqrTextResult.status === "passed", "jsQR adapter must decode a simple text vector");
  assert(
    jsqrTextResult.checks.some((check) => check.name === "decode.text" && check.status === "passed"),
    "jsQR adapter must pass decode.text check"
  );

  const planningVector = coreSuite.vectors.find((vector) => vector.id === "core.estimate.byte-success");
  const jsqrPlanningResult = await jsqrAdapter.run(planningVector);
  assert(jsqrPlanningResult.status === "skipped", "jsQR adapter must skip planning vectors");
  assert(
    jsqrPlanningResult.checks.some((check) => check.status === "skipped"),
    "jsQR planning skip must include a skipped check"
  );

  const mismatchResult = await jsqrAdapter.run({
    id: "test.decode-mismatch",
    title: "Decode mismatch",
    category: "test",
    operation: "generate",
    input: {
      text: "HELLO"
    },
    options: {},
    expect: {
      decode: {
        text: "WORLD"
      }
    }
  });
  assert(mismatchResult.status === "failed", "jsQR decode text mismatch must fail");
  assert(
    mismatchResult.checks.some((check) => check.name === "decode.text" && check.status === "failed"),
    "jsQR mismatch must include failed decode.text check"
  );

  const binaryVector = coreSuite.vectors.find((vector) => vector.id === "core.generate.binary-00-ff");
  const jsqrBinaryResult = await jsqrAdapter.run(binaryVector);
  const binaryCheck = jsqrBinaryResult.checks.find((check) => check.name === "decode.binaryHex");
  assert(binaryCheck, "jsQR binary vector must include decode.binaryHex check");
  assert(
    binaryCheck.status === "passed" || (binaryCheck.status === "skipped" && /raw byte|raw/i.test(binaryCheck.reason ?? "")),
    "jsQR binary decode must pass via raw bytes or skip with a raw byte limitation reason"
  );

  const kanjiEciBinarySuite = JSON.parse(await readFile("vectors/kanji-eci-binary.json", "utf8"));
  const kanjiAutoVector = kanjiEciBinarySuite.vectors.find((vector) => vector.id === "kanji.auto.japanese-text");
  assert(kanjiAutoVector, "Kanji auto vector must exist");
  const kanjiAutoResult = await specqrAdapter.run(kanjiAutoVector);
  assert(kanjiAutoResult.status === "passed", "SpecQR auto Kanji vector must pass");
  assert(
    kanjiAutoResult.checks.some((check) => check.name === "diagnostics.subset" && check.status === "passed"),
    "SpecQR auto Kanji vector must pass diagnostics subset"
  );

  const eciAutoVector = kanjiEciBinarySuite.vectors.find((vector) => vector.id === "eci.utf8-auto.text");
  assert(eciAutoVector, "ECI auto vector must exist");
  const eciAutoResult = await specqrAdapter.run(eciAutoVector);
  assert(eciAutoResult.status === "passed", "SpecQR ECI UTF-8 vector must pass");
  assert(
    eciAutoResult.checks.some((check) => check.name === "diagnostics.subset" && check.status === "passed"),
    "SpecQR ECI UTF-8 vector must pass diagnostics subset"
  );

  const rawBinaryVector = kanjiEciBinarySuite.vectors.find((vector) => vector.id === "binary.raw.00-ascii-ff");
  assert(rawBinaryVector, "Kanji / ECI / binary raw byte vector must exist");
  const jsqrRawBinaryResult = await jsqrAdapter.run(rawBinaryVector);
  assert(jsqrRawBinaryResult.status === "passed", "jsQR must pass raw byte expectation when binaryData is available");
  assert(
    jsqrRawBinaryResult.checks.some((check) => check.name === "decode.binaryHex" && check.status === "passed"),
    "jsQR raw byte vector must include passed decode.binaryHex check"
  );

  for (const vectorId of [
    "kanji.reject.forced-unsupported-character",
    "eci.reject.invalid-assignment",
    "segments.reject.manual-kanji-missing-payload"
  ]) {
    const negativeVector = kanjiEciBinarySuite.vectors.find((vector) => vector.id === vectorId);
    assert(negativeVector, `${vectorId} must exist`);
    const negativeResult = await specqrAdapter.run(negativeVector);
    assert(negativeResult.status === "passed", `${vectorId} must pass by rejecting`);
    assert(
      negativeResult.checks.some((check) => check.name === "rejects" && check.status === "passed"),
      `${vectorId} must pass rejects check`
    );
  }

  const optionalTextVector = {
    id: "test.optional-cli.decode-text",
    title: "Optional CLI decode text",
    category: "test",
    operation: "generate",
    input: {
      text: "HELLO OPTIONAL CLI"
    },
    options: {},
    expect: {
      decode: {
        text: "HELLO OPTIONAL CLI"
      }
    }
  };

  for (const optionalAdapter of [zbarAdapter, zxingCliAdapter]) {
    const unavailableResult = await optionalAdapter.run(optionalTextVector, {
      discoverCommand: async () => null
    });
    assert(unavailableResult.status === "skipped", `${optionalAdapter.id} must skip when command is unavailable`);
    assert(/not available/.test(unavailableResult.reason ?? ""), `${optionalAdapter.id} skip reason must mention availability`);
    assert(
      unavailableResult.checks.some((check) => check.name === "availability" && check.status === "skipped"),
      `${optionalAdapter.id} unavailable result must include availability skip check`
    );
  }

  assert(parseZbarOutput("SIMPLE PAYLOAD\n") === "SIMPLE PAYLOAD", "zbar parser must extract raw payload");
  assert(parseZxingOutput("Text: \"SIMPLE PAYLOAD\"\nFormat: QRCode\n") === "SIMPLE PAYLOAD", "ZXing parser must extract labelled payload");
  assert(parseZxingOutput("input.png: Text: \"SIMPLE PAYLOAD\"\n") === "SIMPLE PAYLOAD", "ZXing parser must extract filename-prefixed labelled payload");
  assert(parseZxingOutput("Raw result:\nSIMPLE PAYLOAD\nParsed result:\nSIMPLE PAYLOAD\n") === "SIMPLE PAYLOAD", "ZXing parser must extract following-line payload");

  const fakeAvailableRunner = async (command, args) => {
    const isDecode = args.some((arg) => String(arg).endsWith(".png"));
    return {
      command,
      args,
      ok: true,
      unavailable: false,
      exitCode: 0,
      signal: null,
      stdout: isDecode ? "WRONG TEXT\n" : "fake cli\n",
      stderr: "",
      error: null
    };
  };
  const optionalMismatchResult = await zbarAdapter.run(optionalTextVector, {
    commandRunner: fakeAvailableRunner
  });
  assert(optionalMismatchResult.status === "failed", "available optional CLI text mismatch must fail");
  assert(
    optionalMismatchResult.checks.some((check) => check.name === "decode.text" && check.status === "failed"),
    "available optional CLI mismatch must include failed decode.text check"
  );

  const optionalBinaryResult = await zxingCliAdapter.run(rawBinaryVector, {
    commandRunner: fakeAvailableRunner
  });
  assert(optionalBinaryResult.status === "skipped", "optional CLI raw binary expectation must skip without reliable raw bytes");
  assert(
    optionalBinaryResult.checks.some((check) => check.name === "decode.binaryHex" && check.status === "skipped"),
    "optional CLI raw binary result must include skipped decode.binaryHex check"
  );
  assert(
    optionalBinaryResult.checks.some((check) => /raw bytes/i.test(check.reason ?? "")),
    "optional CLI raw binary skip reason must mention raw bytes"
  );

  const matrix = [
    [true, false, true],
    [false, true, false]
  ];
  const rows = matrixRows(matrix);
  assert(rows.join("/") === "101/010", "matrixRows must produce deterministic row-major bit rows");
  assert(matrixSha256(rows) === matrixSha256(rows), "matrixSha256 must be deterministic");

  const referenceSuite = JSON.parse(await readFile("vectors/reference-nayuki.json", "utf8"));
  const numericReferenceVector = referenceSuite.vectors.find((vector) => vector.id === "reference.nayuki.numeric.v1-l-mask0");
  assert(numericReferenceVector, "Nayuki numeric reference vector must exist");
  const nayukiNumericResult = await nayukiAdapter.run(numericReferenceVector);
  assert(nayukiNumericResult.status === "passed", "Nayuki numeric reference vector must pass");
  assert(nayukiNumericResult.details?.matrixSha256, "Nayuki result must include matrixSha256");

  const nayukiSkipResult = await nayukiAdapter.run({
    id: "test.nayuki.non-fixed",
    title: "Nayuki non-fixed skip",
    category: "test",
    operation: "generate",
    input: {
      text: "HELLO"
    },
    options: {
      errorCorrectionLevel: "M"
    },
    expect: {
      referenceMatrix: {
        adapter: "nayuki",
        exact: true,
        scope: "fixed-version-ecc-mask"
      }
    }
  });
  assert(nayukiSkipResult.status === "skipped", "Nayuki non-fixed vector must be skipped clearly");
  assert(/fixed/.test(nayukiSkipResult.reason ?? ""), "Nayuki non-fixed skip must mention fixed condition");

  const mismatch = compareMatrixRows(["10", "01"], ["10", "11"]);
  assert(!mismatch.ok, "compareMatrixRows must detect mismatches");
  assert(mismatch.firstMismatch?.x === 0 && mismatch.firstMismatch?.y === 1, "mismatch details must include first mismatch coordinates");

  console.log(JSON.stringify({ ok: true, checks: requiredPaths.length + requiredScripts.length + allowedOperations.length + 66 }, null, 2));
} catch (error) {
  fail(error.message);
}
