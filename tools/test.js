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
import { pngToRgba } from "./png-rgba.js";
import { createReportMetadata } from "./report-metadata.js";
import { badgeFileNames, createBadge, createBadgeSet, summarizeStatus } from "./report-utils.js";
import { activeAdapters, createConformanceReport } from "./run-conformance.js";
import { verifyReportObject } from "./verify-report.js";

const requiredPaths = [
  "package.json",
  "README.md",
  "LICENSE",
  "docs/vector-schema.md",
  "docs/adapter-contract.md",
  "docs/known-limits.md",
  "docs/development-policy.md",
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
  "tools/run-conformance.js",
  "tools/report.js",
  "tools/report-metadata.js",
  "tools/report-utils.js",
  "tools/verify-report.js",
  "tools/build-pages.js",
  "tools/png-rgba.js",
  ".github/workflows/verify.yml",
  ".github/workflows/pages.yml"
];

const requiredScripts = ["test", "validate:vectors", "conformance", "report", "verify:report", "pages:build", "verify"];
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
    "adapters/README.md",
    "docs/vector-schema.md",
    "docs/adapter-contract.md",
    "docs/known-limits.md",
    "docs/development-policy.md",
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
    "npm run conformance -- --list-suites",
    "npm run conformance -- --suite kanji-eci-binary",
    "npm run conformance -- --adapter specqr",
    "npm run conformance -- --vector core.generate.byte-text",
    "npm run verify:report",
    "npm run pages:build",
    "public/",
    "docs/development-policy.md",
    ".github/workflows/pages.yml"
  ]) {
    requireText(readme, text, "README.md");
  }

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

  const fullReportForIntegrity = await createConformanceReport();
  const validIntegrity = await verifyReportObject(fullReportForIntegrity.report);
  assert(validIntegrity.ok, "valid full report must pass integrity check");
  const mismatchedReport = JSON.parse(JSON.stringify(fullReportForIntegrity.report));
  mismatchedReport.summary.totalResults += 1;
  const mismatchedIntegrity = await verifyReportObject(mismatchedReport);
  assert(!mismatchedIntegrity.ok, "report integrity checker must catch mismatched summary counts");
  assert(
    mismatchedIntegrity.errors.some((error) => error.label === "summary"),
    "mismatched summary count must be reported as a summary integrity error"
  );

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
  }
  assert(badgeSet["overall.json"].color === "green", "overall badge with expected skips must stay green");
  assert(badgeSet["kanji-eci-binary.json"].color === "green", "Kanji / ECI / binary passing scope badge must be green");
  assert(badgeSet["structured-append.json"].color === "yellow", "skipped-only scope badge must be yellow");
  assert(badgeSet["zbarimg.json"].color === "yellow", "missing optional zbarimg lane badge must be yellow");
  assert(badgeSet["zxing-cli.json"].color === "yellow", "missing optional ZXing lane badge must be yellow");

  const metadata = await createReportMetadata({ now: new Date("2026-01-01T00:00:00.000Z") });
  assert(metadata.generatedAt === "2026-01-01T00:00:00.000Z", "report metadata must include generatedAt");
  assert(metadata.runtime.node === process.version, "report metadata must include Node version");
  assert(typeof metadata.runtime.platform === "string" && metadata.runtime.platform.length > 0, "report metadata must include platform");
  assert(typeof metadata.runtime.arch === "string" && metadata.runtime.arch.length > 0, "report metadata must include arch");
  assert(metadata.packages.specqr === "2.4.0", "report metadata must include specqr package version");
  assert(metadata.packages.jsqr === "1.4.0", "report metadata must include jsqr package version");
  assert(
    metadata.packages["nayuki-qr-code-generator"] === "1.8.0",
    "report metadata must include Nayuki package version"
  );

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "specqr-pages-test-"));
  try {
    await mkdir(path.join(tmpRoot, "reports"), { recursive: true });
    await mkdir(path.join(tmpRoot, "badges"), { recursive: true });
    await writeFile(path.join(tmpRoot, "reports/latest.html"), "<!doctype html><title>report</title>", "utf8");
    await writeFile(path.join(tmpRoot, "reports/latest.json"), `${JSON.stringify({ schemaVersion: 1 })}\n`, "utf8");
    for (const [fileName, badge] of Object.entries(badgeSet)) {
      await writeFile(path.join(tmpRoot, "badges", fileName), `${JSON.stringify(badge)}\n`, "utf8");
    }

    const pagesResult = await buildPages({ cwd: tmpRoot });
    assert(pagesResult.files.includes("index.html"), "Pages artifact must include index.html");
    assert(pagesResult.files.includes("reports/latest.json"), "Pages artifact must include reports/latest.json");
    await access(path.join(tmpRoot, "public/index.html"));
    await access(path.join(tmpRoot, "public/reports/latest.json"));
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

  console.log(JSON.stringify({ ok: true, checks: requiredPaths.length + requiredScripts.length + allowedOperations.length + 54 }, null, 2));
} catch (error) {
  fail(error.message);
}
