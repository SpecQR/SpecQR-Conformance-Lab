import assert from "node:assert/strict";
import {
  activeAdapters,
  createConformanceReport,
  createSummary,
  readSuites,
  selectRunScope
} from "./run-conformance.js";
import { verifyReportObject } from "./verify-report.js";
import { semanticReportSha256 } from "./report-provenance.js";

const suites = await readSuites();
const baseline = (await createConformanceReport({ suites, metadataOptions: { env: {} } })).report;
let checks = 0;

function firstPassed(report) {
  const result = report.results.find((entry) => entry.status === "passed");
  assert(result, "baseline must contain a passing result for negative controls");
  return result;
}

function refreshCounts(report) {
  const scope = selectRunScope(suites, activeAdapters, report.run.filters);
  report.summary = createSummary(scope.suites, scope.vectors, scope.adapters, report.results, {
    coverageClaims: report.summary.coverageClaims
  });
}

async function expectValid(name, report) {
  const verification = await verifyReportObject(report);
  assert.equal(verification.ok, true, `${name}: ${JSON.stringify(verification.errors)}`);
  checks += 1;
}

async function expectRejected(name, mutate, expectedLabel, source = baseline) {
  const report = structuredClone(source);
  mutate(report);
  // Prove the semantic controls independently of the optional checksum.
  delete report.semanticSha256;
  const verification = await verifyReportObject(report);
  assert.equal(verification.ok, false, `${name} must not be accepted`);
  assert(verification.errors.some((entry) => entry.label === expectedLabel),
    `${name} must identify ${expectedLabel}: ${JSON.stringify(verification.errors)}`);
  checks += 1;
}

await expectValid("full baseline", baseline);
await expectValid("serialized full report preserves its semantic digest", JSON.parse(JSON.stringify(baseline)));
const legacy = structuredClone(baseline);
delete legacy.target.requested;
delete legacy.target.resolvedVersion;
delete legacy.semanticSha256;
delete legacy.metadata.provenance;
await expectValid("legacy target version compatibility", legacy);

const mixed = structuredClone(baseline);
firstPassed(mixed).checks.push({ name: "integrity.optional-limitation", status: "skipped", reason: "Optional check unavailable" });
mixed.semanticSha256 = semanticReportSha256(mixed);
await expectValid("passed result may contain explicit skipped checks", mixed);

const checksumTamper = structuredClone(baseline);
firstPassed(checksumTamper).details = { negativeControl: "changed evidence" };
const checksumVerification = await verifyReportObject(checksumTamper);
assert.equal(checksumVerification.ok, false, "changed evidence must invalidate the semantic checksum");
assert.deepEqual(checksumVerification.errors.map((entry) => entry.label), ["semanticSha256"]);
checks += 1;

const volatileMetadata = structuredClone(baseline);
volatileMetadata.metadata.generatedAt = "2026-01-01T00:00:00.000Z";
volatileMetadata.metadata.runtime = { node: "v22.0.0", platform: "linux", arch: "x64" };
volatileMetadata.run.outputPath = "reports/reproduced.json";
await expectValid("semantic digest is independent of execution metadata and output location", volatileMetadata);

const filtered = (await createConformanceReport({
  filters: { vectors: ["core.generate.byte-text"], adapters: ["specqr", "jsqr"] },
  metadataOptions: { env: {} }
})).report;
await expectValid("actual filtered adapter execution", filtered);

for (const status of ["failed", "error", "skipped"]) {
  await expectRejected(`passed status hiding ${status} check`, (report) => {
    firstPassed(report).checks = [{ name: "negative-control", status }];
  }, "results.status-from-checks");
}
await expectRejected("skipped result hiding failed check", (report) => {
  report.results.find((result) => result.status === "skipped").checks = [{ name: "negative-control", status: "failed" }];
}, "results.status-from-checks");
await expectRejected("passed check mislabeled skipped", (report) => {
  firstPassed(report).status = "skipped";
  refreshCounts(report);
}, "results.status-from-checks");
await expectRejected("error takes precedence over failure", (report) => {
  const result = firstPassed(report);
  result.status = "failed";
  result.checks = [{ name: "failure", status: "failed" }, { name: "execution", status: "error" }];
  refreshCounts(report);
}, "results.status-from-checks");

for (const [name, value, label] of [
  ["empty checks", [], "results.checks"],
  ["missing checks", undefined, "results.checks"],
  ["non-array checks", {}, "results.checks"],
  ["null check", [null], "results.checks"],
  ["blank check name", [{ name: "  ", status: "passed" }], "results.checks.name"],
  ["non-string check name", [{ name: 1, status: "passed" }], "results.checks.name"],
  ["unknown check status", [{ name: "negative-control", status: "success" }], "results.checks.status"],
  ["duplicate check name", [{ name: "duplicate", status: "failed" }, { name: "duplicate", status: "passed" }], "results.checks.name"]
]) {
  await expectRejected(name, (report) => { firstPassed(report).checks = value; }, label);
}
await expectRejected("unknown result status", (report) => { firstPassed(report).status = "success"; }, "results.status");

for (const [field, value] of Object.entries({
  suiteId: "missing-suite", title: "Different vector", category: "other-category", operation: "estimate"
})) {
  await expectRejected(`forged result ${field}`, (report) => {
    firstPassed(report)[field] = value;
    refreshCounts(report);
  }, `results.${field}`);
}
await expectRejected("missing vector/adapter pair", (report) => { report.results.pop(); refreshCounts(report); }, "results.coverage");
await expectRejected("duplicate vector/adapter pair", (report) => { report.results.push(structuredClone(report.results[0])); refreshCounts(report); }, "results.coverage");
await expectRejected("unknown vector", (report) => { firstPassed(report).vectorId = "missing-vector"; }, "results.vectorId");
await expectRejected("unknown adapter", (report) => { firstPassed(report).adapterId = "missing-adapter"; }, "results.adapterId");

await expectRejected("full scope mislabeled filtered", (report) => { report.run.mode = "filtered"; }, "run.mode");
await expectRejected("filtered scope mislabeled full", (report) => { report.run.mode = "full"; }, "run.mode", filtered);
await expectRejected("string filter", (report) => { report.run.filters.vectors = "core.generate.byte-text"; }, "run.filters");
await expectRejected("unknown filter", (report) => { report.run.filters.vectors = ["missing-vector"]; }, "run.filters");

for (const [name, mutation] of [
  ["empty adapters", (report) => { report.adapters = []; }],
  ["duplicate adapter", (report) => { report.adapters.push(structuredClone(report.adapters[0])); }],
  ["unknown adapter metadata", (report) => { report.adapters[0].id = "missing-adapter"; }]
]) {
  await expectRejected(name, mutation, "adapters.ids");
}
for (const [field, value] of Object.entries({
  required: false, status: "optional", name: "Unrelated implementation", packageName: "other-package",
  packageVersion: "0.0.0", lane: "optional-decode-readability", commandCandidates: ["fake-decoder"]
})) {
  await expectRejected(`forged adapter ${field}`, (report) => {
    report.adapters.find((adapter) => adapter.id === "specqr")[field] = value;
  }, `adapters.specqr.${field}`);
}
await expectRejected("inconsistent legacy version", (report) => { report.target.version = "0.0.0"; }, "target.version");
for (const [field, value] of Object.entries({
  packageName: "other-package", resolvedVersion: "0.0.0", requested: "specqr@other", source: "other-source"
})) {
  await expectRejected(`inconsistent metadata target ${field}`, (report) => {
    report.metadata.target[field] = value;
  }, `metadata.target.${field}`);
}
await expectRejected("missing package provenance", (report) => { delete report.metadata.packages.specqr; }, "metadata.packages.specqr");
for (const [name, adapterId] of [["jsqr", "jsqr"], ["nayuki-qr-code-generator", "nayuki"]]) {
  await expectRejected(`package inventory cannot omit ${name} from every report field`, (report) => {
    delete report.metadata.packages[name];
    delete report.metadata.provenance.packages[name];
    delete report.adapters.find((adapter) => adapter.id === adapterId).packageVersion;
  }, `metadata.packages.${name}`);
  await expectRejected(`legacy report still requires selected ${name} package version`, (report) => {
    delete report.metadata.provenance;
    delete report.metadata.packages[name];
    delete report.adapters.find((adapter) => adapter.id === adapterId).packageVersion;
  }, `metadata.packages.${name}`);
  await expectRejected(`selected ${name} adapter must declare its package version`, (report) => {
    delete report.adapters.find((adapter) => adapter.id === adapterId).packageVersion;
  }, `adapters.${adapterId}.packageVersion`);
  await expectRejected(`provenance inventory independently requires ${name}`, (report) => {
    delete report.metadata.packages[name];
    delete report.metadata.provenance.packages[name];
  }, `metadata.provenance.packages.${name}`);
}
const omittedDependencies = structuredClone(baseline);
for (const [name, adapterId] of [["jsqr", "jsqr"], ["nayuki-qr-code-generator", "nayuki"]]) {
  delete omittedDependencies.metadata.packages[name];
  delete omittedDependencies.metadata.provenance.packages[name];
  delete omittedDependencies.adapters.find((adapter) => adapter.id === adapterId).packageVersion;
}
omittedDependencies.semanticSha256 = semanticReportSha256(omittedDependencies);
const omittedVerification = await verifyReportObject(omittedDependencies);
assert.equal(omittedVerification.ok, false, "removing both independent dependencies must fail even with a refreshed checksum");
assert(!omittedVerification.errors.some((entry) => entry.label === "semanticSha256"));
for (const name of ["jsqr", "nayuki-qr-code-generator"]) {
  assert(omittedVerification.errors.some((entry) => entry.label === `metadata.packages.${name}`));
  assert(omittedVerification.errors.some((entry) => entry.label === `metadata.provenance.packages.${name}`));
}
checks += 1;
await expectRejected("filtered provenance retains all baseline package identities", (report) => {
  delete report.metadata.packages["nayuki-qr-code-generator"];
  delete report.metadata.provenance.packages["nayuki-qr-code-generator"];
}, "metadata.packages.nayuki-qr-code-generator", filtered);
for (const value of [null, "", "   ", 140]) {
  await expectRejected("invalid declared dependency version", (report) => {
    report.metadata.packages.jsqr = value;
    report.metadata.provenance.packages.jsqr.version = value;
    report.adapters.find((adapter) => adapter.id === "jsqr").packageVersion = value;
  }, "metadata.packages.jsqr");
}
await expectRejected("missing target metadata", (report) => { delete report.metadata.target; }, "metadata.target");
for (const [field, value] of Object.entries({
  revision: 2, resolver: "other-resolver", packageName: "jsqr", packageVersion: "0.0.0", contentSha256: "0".repeat(64)
})) {
  await expectRejected(`inconsistent subject routing ${field}`, (report) => {
    report.metadata.provenance.subjectRouting[field] = value;
  }, `metadata.provenance.subjectRouting.${field}`);
}
for (const name of ["specqr", "jsqr", "nayuki-qr-code-generator"]) {
  await expectRejected(`inconsistent provenance package ${name} version`, (report) => {
    report.metadata.provenance.packages[name].version = "0.0.0";
  }, `metadata.provenance.packages.${name}.version`);
}
await expectRejected("invalid package content digest", (report) => {
  report.metadata.provenance.packages.jsqr.contentSha256 = "not-a-hash";
}, "metadata.provenance.packages.jsqr.contentSha256");
await expectRejected("missing provenance package", (report) => { delete report.metadata.provenance.packages.jsqr; }, "metadata.provenance.packages");
await expectRejected("unexpected provenance package", (report) => {
  report.metadata.provenance.packages.unrelated = { version: "1.0.0", contentSha256: "0".repeat(64), lockIntegrity: null };
}, "metadata.provenance.packages");
await expectRejected("missing subject routing", (report) => { delete report.metadata.provenance.subjectRouting; }, "metadata.provenance.subjectRouting");
await expectRejected("null provenance", (report) => { report.metadata.provenance = null; }, "metadata.provenance");
await expectRejected("null result", (report) => { report.results[0] = null; }, "results");
await expectRejected("non-array results", (report) => { report.results = {}; }, "results");
await expectRejected("non-array adapters", (report) => { report.adapters = {}; }, "adapters");
await expectRejected("null adapter", (report) => { report.adapters[0] = null; }, "adapters");

console.log(JSON.stringify({ ok: true, checks, scope: "report semantic integrity and negative controls" }, null, 2));
