import assert from "node:assert/strict";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { readCoverageClaimsFile } from "./coverage-claims.js";
import { createConformanceReport } from "./run-conformance.js";
import { verifyCoverageClaimsObject } from "./verify-coverage-claims.js";

const clone = (value) => JSON.parse(JSON.stringify(value));

export async function testCoverageIntegrity(options = {}) {
  const claims = await readCoverageClaimsFile();
  const report = options.report ?? (await createConformanceReport({ metadataOptions: { env: {} } })).report;
  const baseline = await verifyCoverageClaimsObject(claims, { report });
  assert.equal(baseline.ok, true, JSON.stringify(baseline.errors));
  assert(baseline.evidence.every((entry) => entry.applicableResults > 0));
  assert(baseline.evidence.filter((entry) => entry.required)
    .every((entry) => entry.passedChecks === entry.expectedChecks && entry.unavailableResults === 0));

  let negativeControls = 0;
  const rejectMutation = async (title, mutate, expectedLabel) => {
    const candidateReport = clone(report);
    const candidateClaims = clone(claims);
    mutate(candidateReport, candidateClaims);
    const result = await verifyCoverageClaimsObject(candidateClaims, { report: candidateReport });
    assert.equal(result.ok, false, `${title} must not verify`);
    assert(result.errors.some((error) => error.label === expectedLabel), `${title}: ${JSON.stringify(result.errors)}`);
    negativeControls += 1;
  };
  const row = (report, vectorId, adapterId = "specqr") => {
    const result = report.results.find((entry) => entry.vectorId === vectorId && entry.adapterId === adapterId);
    assert(result, `missing test fixture ${vectorId}/${adapterId}`);
    return result;
  };

  await rejectMutation("entire jsQR lane fails while SpecQR passes", (report) => {
    for (const result of report.results.filter((entry) => entry.suiteId === "core" && entry.adapterId === "jsqr")) {
      result.status = "failed";
      result.checks = [{ name: "decode.read", status: "failed" }];
    }
  }, "claims.failedEvidence");

  await rejectMutation("missing required vector", (report) => {
    report.results = report.results.filter((entry) => !(entry.vectorId === "core.generate.byte-text" && entry.adapterId === "jsqr"));
  }, "claims.requiredResult");

  await rejectMutation("missing report adapter inventory", (report) => {
    delete report.adapters;
  }, "claims.adapters");

  await rejectMutation("deleted check hidden by another passing check", (report) => {
    const result = row(report, "rendering.matrix.simple-text");
    result.checks = result.checks.filter((check) => check.name !== "render.matrix");
  }, "claims.requiredCheck");

  await rejectMutation("skipped planning check hidden by passing rejection check", (report) => {
    row(report, "planning.estimate.data-too-long-v1-h").checks.find((check) => check.name === "planning").status = "skipped";
  }, "claims.requiredCheck");

  await rejectMutation("TypeScript check replaced with arbitrary pass", (report) => {
    row(report, "package.typescript-consumer.compile").checks = [{ name: "unrelated", status: "passed" }];
  }, "claims.requiredCheck");

  await rejectMutation("jsQR loses raw byte capability", (report) => {
    const result = row(report, "core.generate.binary-00-ff", "jsqr");
    result.status = "skipped";
    result.checks = [{ name: "decode.binaryHex", status: "skipped", reason: "raw bytes not exposed" }];
  }, "claims.requiredCheck");

  await rejectMutation("Nayuki exact matrix becomes not run", (report) => {
    const result = report.results.find((entry) => entry.suiteId === "reference-nayuki" && entry.adapterId === "nayuki");
    result.status = "skipped";
    result.checks = [{ name: "referenceMatrix.scope", status: "skipped", reason: "unsupported" }];
  }, "claims.requiredCheck");

  await rejectMutation("duplicate expected check", (report) => {
    const result = row(report, "core.generate.byte-text", "jsqr");
    result.checks.push(clone(result.checks[0]));
  }, "claims.requiredCheck");

  await rejectMutation("duplicate applicable result", (report) => {
    report.results.push(clone(row(report, "core.generate.byte-text", "jsqr")));
  }, "claims.requiredResult");

  await rejectMutation("result borrowed from another operation", (report) => {
    row(report, "core.generate.byte-text", "jsqr").operation = "getCapacity";
  }, "claims.resultIdentity");

  await rejectMutation("required report adapter relabelled optional", (report) => {
    report.adapters.find((entry) => entry.id === "jsqr").required = false;
    const result = row(report, "core.generate.byte-text", "jsqr");
    result.status = "skipped";
    result.checks = [{ name: "availability", status: "skipped", reason: "not installed" }];
    result.details = { availability: { optional: true, commands: ["jsqr"] } };
  }, "claims.requiredCheck");

  await rejectMutation("missing capability requirement", (_report, claims) => {
    claims.claims[0].evidenceRequirements = claims.claims[0].evidenceRequirements.filter((entry) => entry.adapterId !== "jsqr");
  }, "claims.evidenceRequirements");

  await rejectMutation("unsupported optional capability substituted for jsQR", (_report, claims) => {
    claims.claims[0].evidenceRequirements.find((entry) => entry.adapterId === "jsqr").capability = "optional-cli-text-v1";
  }, "claims.capability");

  await rejectMutation("partial claim hides a failed applicable check", (report) => {
    const result = report.results.find((entry) => entry.suiteId === "gs1-digital-link" && entry.adapterId === "specqr");
    result.checks[0].status = "failed";
  }, "claims.failedEvidence");

  await rejectMutation("data URL loses embedded SVG validation", (report) => {
    const result = row(report, "rendering.svg.data-url");
    result.checks = result.checks.filter((check) => check.name !== "render.svg");
  }, "claims.requiredCheck");

  await rejectMutation("non-claim references an evidence capability", (_report, claims) => {
    claims.nonClaims[0].evidenceRequirements = [{ adapterId: "jsqr", capability: "jsqr-text-binary-v1" }];
  }, "claims.notClaimedCoverage");

  await rejectMutation("filtered report advertised as complete claim coverage", (report) => {
    report.run.mode = "filtered";
    report.run.filters.vectors = ["core.generate.byte-text"];
    report.results = report.results.filter((entry) => entry.vectorId === "core.generate.byte-text");
  }, "claims.requiredResult");

  // Explicit optional command absence remains valid, independent of whether a
  // particular developer happens to have a native CLI decoder installed.
  const unavailableReport = clone(report);
  for (const result of unavailableReport.results.filter((entry) => ["zbarimg", "zxing-cli"].includes(entry.adapterId))) {
    if (!["generate", "generateSegments"].includes(result.operation)) continue;
    result.status = "skipped";
    result.checks = [{ name: "availability", status: "skipped", reason: "test fixture: optional command absent" }];
    result.details = { availability: { optional: true, commands: [result.adapterId] } };
  }
  const unavailable = await verifyCoverageClaimsObject(claims, { report: unavailableReport });
  assert.equal(unavailable.ok, true, JSON.stringify(unavailable.errors));
  assert(unavailable.evidence.filter((entry) => !entry.required)
    .every((entry) => entry.unavailableResults === entry.applicableResults && entry.passedChecks === 0));

  await rejectMutation("optional available decoder skips expected text", (report) => {
    const result = row(report, "core.generate.byte-text", "zbarimg");
    result.status = "skipped";
    result.checks = [{ name: "decode.text", status: "skipped", reason: "unexpected loss of capability" }];
    delete result.details;
  }, "claims.requiredCheck");

  await rejectMutation("optional decoder failure cannot masquerade as absence", (report) => {
    const result = row(report, "core.generate.byte-text", "zbarimg");
    result.status = "skipped";
    result.checks = [{ name: "availability", status: "skipped", reason: "" }];
    result.details = { availability: { optional: true, commands: ["zbarimg"] } };
  }, "claims.requiredCheck");

  await rejectMutation("optional-only claim promoted to verified", (_report, claims) => {
    claims.claims.find((entry) => entry.id === "optional-cli-decoder-lanes").status = "verified";
  }, "claims.evidenceRequirements");

  // Source-backed scope skips remain allowed: SpecQR does not decode; jsQR
  // does not run planning; native CLIs do not expose reliable raw binary data.
  const scopedReport = clone(unavailableReport);
  const binary = row(scopedReport, "core.generate.binary-00-ff", "zbarimg");
  binary.status = "skipped";
  binary.checks = [{ name: "decode.binaryHex", status: "skipped", reason: "raw byte output is outside this capability" }];
  delete binary.details;
  assert(row(scopedReport, "core.generate.byte-text").checks.some((check) => check.name === "decode" && check.status === "skipped"));
  assert.equal(row(scopedReport, "core.estimate.byte-success", "jsqr").status, "skipped");
  const scoped = await verifyCoverageClaimsObject(claims, { report: scopedReport });
  assert.equal(scoped.ok, true, JSON.stringify(scoped.errors));

  return { ok: true, negativeControls, positiveControls: 3, evidenceContracts: baseline.evidence.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await testCoverageIntegrity(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
    process.exitCode = 1;
  }
}
