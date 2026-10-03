import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assessRcConformanceReports, loadRcConformanceScope, registrySubjectSha256 } from "./rc-evidence-validity.js";
import { createSummary, selectRunScope } from "./run-conformance.js";
import { semanticReportSha256 } from "./report-provenance.js";
import { verifyReportObject } from "./verify-report.js";

export async function rcRegistryTestEvidence() {
  // Public registry manifest captured from the verified RC tarball. Production
  // admission authenticates the complete manifest against its pinned digest.
  const fixture = JSON.parse(await readFile(new URL("../fixtures/rc2-registry-manifest.json", import.meta.url), "utf8"));
  return Object.fromEntries(["exact", "next"].map((id) => [id, {
    status: "pass", source: "npm-registry", resolvedVersion: fixture.resolvedVersion,
    requested: id === "exact" ? "specqr@3.0.0-rc.2" : "specqr@next",
    manifest: fixture.manifest,
    hashes: { tarballSha256: fixture.tarballSha256, expandedSha256: fixture.expandedSha256 }
  }]));
}

export async function testRcEvidenceAdmission(baselineReport) {
  const scope = await loadRcConformanceScope();
  const registry = await rcRegistryTestEvidence();
  const candidateDigest = registrySubjectSha256(registry.exact, "specqr@3.0.0-rc.2");
  assert(candidateDigest, "offline RC registry fixture must match the pinned tarball manifest");
  assert.notEqual(candidateDigest, scope.baselineSubjectSha256);
  const reports = {};
  const refresh = (report, id) => {
    const selected = selectRunScope(scope.targets[id].suites, scope.adapters, report.run.filters);
    report.summary = createSummary(selected.suites, selected.vectors, selected.adapters, report.results, {
      coverageClaims: report.summary.coverageClaims
    });
    report.semanticSha256 = semanticReportSha256(report);
  };
  for (const [id, expected] of Object.entries(scope.targets)) {
    // Synthetic candidate identities isolate admission logic; these objects are
    // never written as execution, readiness, or observation evidence.
    const report = structuredClone(baselineReport);
    const requested = id === "baseline" ? "specqr@2.4.0" : id === "exact" ? "specqr@3.0.0-rc.2" : "specqr@next";
    Object.assign(report.target, { requested, version: expected.version, resolvedVersion: expected.version });
    Object.assign(report.metadata.target, { requested, resolvedVersion: expected.version });
    report.metadata.packages.specqr = expected.version;
    report.adapters.find((adapter) => adapter.id === "specqr").packageVersion = expected.version;
    report.results.find((result) => result.vectorId === "package.metadata.published-surface" && result.adapterId === "specqr")
      .details.packageSurface.metadata.version = expected.version;
    const digest = id === "baseline" ? scope.baselineSubjectSha256 : candidateDigest;
    Object.assign(report.metadata.provenance.subjectRouting, { packageVersion: expected.version, contentSha256: digest });
    Object.assign(report.metadata.provenance.packages.specqr, { version: expected.version, contentSha256: digest, lockIntegrity: null });
    refresh(report, id);
    reports[id] = report;
  }
  const positive = await assessRcConformanceReports(reports, undefined, registry);
  assert.equal(positive.valid, true, JSON.stringify(positive.targets));
  let rejected = 0;
  for (const id of Object.keys(reports)) {
    for (const mutation of ["required-lane-skipped", "required-check-dropped"]) {
      const changed = structuredClone(reports);
      if (mutation === "required-lane-skipped") {
        for (const result of changed[id].results.filter((entry) => entry.adapterId === "jsqr")) {
          result.status = "skipped";
          result.checks = [{ name: "decode.scope", status: "skipped", reason: "synthetic lost capability" }];
        }
      } else {
        const result = changed[id].results.find((entry) => entry.vectorId === "rendering.matrix.simple-text" && entry.adapterId === "specqr");
        result.checks = result.checks.filter((check) => check.name !== "render.matrix");
      }
      refresh(changed[id], id);
      const structural = await verifyReportObject(changed[id], { suites: scope.targets[id].suites, adapters: scope.adapters });
      assert.equal(structural.ok, true, `${id}/${mutation} must be structurally consistent: ${JSON.stringify(structural.errors)}`);
      const assessment = await assessRcConformanceReports(changed, undefined, registry);
      assert.equal(assessment.valid, false, `${id}/${mutation} must block RC admission despite refreshed summaries and hashes`);
      assert.equal(assessment.targets[id].capabilityCoverage.status, "blocked");
      assert(assessment.targets[id].errors.some((error) => error.label === "claims.requiredCheck"));
      rejected += 1;
    }
    const missingOracle = structuredClone(reports);
    for (const name of ["jsqr", "nayuki-qr-code-generator"]) {
      delete missingOracle[id].metadata.packages[name];
      delete missingOracle[id].metadata.provenance.packages[name];
    }
    for (const adapter of missingOracle[id].adapters.filter((entry) => ["jsqr", "nayuki"].includes(entry.id))) delete adapter.packageVersion;
    refresh(missingOracle[id], id);
    const oracleAssessment = await assessRcConformanceReports(missingOracle, undefined, registry);
    assert.equal(oracleAssessment.valid, false, `${id} requires independent decoder/reference package provenance`);
    assert(oracleAssessment.targets[id].errors.some((error) => error.label === "schema"));
    rejected += 1;
  }
  const baselineDisguisedAsRc = structuredClone(reports);
  for (const id of ["exact", "next"]) {
    baselineDisguisedAsRc[id].metadata.provenance.packages.specqr.contentSha256 = scope.baselineSubjectSha256;
    baselineDisguisedAsRc[id].metadata.provenance.subjectRouting.contentSha256 = scope.baselineSubjectSha256;
    refresh(baselineDisguisedAsRc[id], id);
  }
  const disguised = await assessRcConformanceReports(baselineDisguisedAsRc, undefined, registry);
  assert.equal(disguised.valid, false, "matching selectors and metadata cannot replace registry subject binding");
  assert.equal(disguised.targets.exact.valid, false);
  assert.equal(disguised.targets.next.valid, false);
  rejected += 1;
  const alteredManifest = structuredClone(registry);
  alteredManifest.exact.manifest[0].sha256 = "0".repeat(64);
  assert.equal((await assessRcConformanceReports(reports, undefined, alteredManifest)).valid, false, "a claimed pass and fixed hash fields cannot authenticate changed manifest bytes");
  rejected += 1;
  assert.equal((await assessRcConformanceReports(reports)).valid, false, "registry evidence must be supplied independently");
  return rejected + 1;
}
