import { readFile } from "node:fs/promises";
import path from "node:path";
import { readCoverageClaimsFile } from "./coverage-claims.js";
import { contentSha256, manifestContentSha256 } from "./report-provenance.js";
import { rcExpandedSha256, rcFileCount, rcTarballSha256, rcVersion } from "./rc-constants.js";
import { verifyCoverageClaimsObject } from "./verify-coverage-claims.js";
import { activeAdapters, readSuites } from "./run-conformance.js";
import { suitesForTarget } from "./rc-target-suites.js";
import { deepEqual, sha256, stableStringify } from "./rc-utils.js";
import { verifyReportObject } from "./verify-report.js";
import { validateSchemaValue } from "./validate-schemas.js";

// These identifiers remain historical evidence. They must never become a green
// RC reference again: independent lanes generated the pinned baseline subject.
export const revokedRcTechnicalEvidence = Object.freeze({
  runIds: [30739905031],
  headShas: ["383399338481ed80acf9f596099bbeb9c79a59cb"],
  reason: "Independent adapter subject routing used the pinned baseline instead of the isolated RC."
});

export function isRevokedRcEvidence(runId, headSha) {
  return revokedRcTechnicalEvidence.runIds.includes(runId) ||
    revokedRcTechnicalEvidence.headShas.includes(headSha);
}

export function validSubjectRouting(routing, version) {
  return routing?.revision === 1 && routing.resolver === "shared-specqr-target" &&
    routing.packageName === "specqr" && routing.packageVersion === version &&
    typeof routing.contentSha256 === "string" && /^[0-9a-f]{64}$/u.test(routing.contentSha256);
}

export function conformanceSubjectRouting(report) {
  const provenance = report?.metadata?.provenance;
  const routing = provenance?.subjectRouting;
  const subject = provenance?.packages?.specqr;
  if (!validSubjectRouting(routing, report?.target?.resolvedVersion) ||
      subject?.version !== routing.packageVersion || subject?.contentSha256 !== routing.contentSha256) {
    return null;
  }
  return routing;
}

export async function loadRcConformanceScope(cwd) {
  const suites = await readSuites({ cwd });
  const adapters = activeAdapters;
  const claims = await readCoverageClaimsFile({ cwd });
  const claimsSha256 = sha256(stableStringify(claims));
  const baselineRoot = path.resolve(cwd ?? process.cwd(), "node_modules/specqr");
  const baselinePackage = JSON.parse(await readFile(path.join(baselineRoot, "package.json"), "utf8"));
  if (baselinePackage.name !== "specqr" || baselinePackage.version !== "2.4.0") throw new Error("RC baseline evidence requires the pinned specqr@2.4.0 install");
  const baselineSubjectSha256 = await contentSha256(baselineRoot);
  const vectors = suites.reduce((total, suite) => total + suite.vectors.length, 0);
  const targets = {};
  for (const [id, version] of Object.entries({ baseline: "2.4.0", exact: "3.0.0-rc.2", next: "3.0.0-rc.2" })) {
    const targetSuites = suitesForTarget(suites, version).suites;
    targets[id] = {
      version,
      suites: targetSuites,
      // Hash the actual source vectors, including expectations, and adapter IDs.
      // A report's own counts can never define the accepted coverage scope.
      scopeSha256: sha256(stableStringify({ suites: targetSuites, adapters: adapters.map((adapter) => adapter.id), claims })),
      vectors,
      results: vectors * adapters.length
    };
  }
  return { targets, adapters, claims, claimsSha256, baselineSubjectSha256 };
}

export function registrySubjectSha256(evidence, requested) {
  const manifest = evidence?.manifest;
  if (evidence?.status !== "pass" || evidence.source !== "npm-registry" ||
      evidence.requested !== requested || evidence.resolvedVersion !== rcVersion ||
      evidence.hashes?.tarballSha256 !== rcTarballSha256 || evidence.hashes?.expandedSha256 !== rcExpandedSha256 ||
      !Array.isArray(manifest) || manifest.length !== rcFileCount ||
      sha256(`${JSON.stringify(manifest)}\n`) !== rcExpandedSha256) return null;
  // The fixed expanded digest authenticates paths, byte lengths and per-file
  // hashes before projecting to the report's portable package-content format.
  return manifestContentSha256(manifest);
}

function verifiedSubjects(scope, registryEvidence) {
  return {
    baseline: scope.baselineSubjectSha256,
    exact: registrySubjectSha256(registryEvidence?.exact, "specqr@3.0.0-rc.2"),
    next: registrySubjectSha256(registryEvidence?.next, "specqr@next")
  };
}

export async function assessRcConformanceReports(reports, cwd, registryEvidence) {
  const scope = await loadRcConformanceScope(cwd);
  const schema = JSON.parse(await readFile(path.resolve(cwd ?? process.cwd(), "schemas/conformance-report-v1.schema.json"), "utf8"));
  const targets = {};
  const expectedSubjects = verifiedSubjects(scope, registryEvidence);
  for (const [id, expected] of Object.entries(scope.targets)) {
    const report = reports[id];
    const schemaResult = validateSchemaValue(report, schema);
    const integrity = await verifyReportObject(report, { cwd, suites: expected.suites, adapters: scope.adapters });
    const claims = await verifyCoverageClaimsObject(scope.claims, { cwd, report, suites: expected.suites });
    const subjectRouting = conformanceSubjectRouting(report);
    targets[id] = {
      subjectRouting,
      scopeSha256: expected.scopeSha256,
      verifiedSubjectSha256: expectedSubjects[id],
      capabilityCoverage: { revision: 1, status: claims.ok ? "pass" : "blocked", claimsSha256: scope.claimsSha256 },
      valid: Boolean(schemaResult.ok && integrity.ok && claims.ok && expectedSubjects[id] && subjectRouting?.contentSha256 === expectedSubjects[id] && subjectRouting && subjectRouting.packageVersion === expected.version &&
        report.run?.mode === "full" && report.summary?.totalVectors === expected.vectors &&
        report.summary?.totalResults === expected.results && report.summary?.failed === 0 && report.summary?.error === 0),
      errors: [
        ...schemaResult.errors.map((error) => ({ label: "schema", ...error })), ...integrity.errors, ...claims.errors,
        ...(!expectedSubjects[id] ? [{ label: "subject.registry-evidence", message: "Required independently verified package manifest is missing or invalid" }] : []),
        ...(expectedSubjects[id] && subjectRouting?.contentSha256 !== expectedSubjects[id] ? [{ label: "subject.content-binding", expected: expectedSubjects[id], actual: subjectRouting?.contentSha256 ?? null }] : [])
      ]
    };
  }
  return {
    targets,
    valid: Object.values(targets).every((target) => target.valid) &&
      deepEqual(targets.exact.subjectRouting, targets.next.subjectRouting)
  };
}

export function validReadinessConformance(readiness, scope, registryEvidence) {
  if (!scope) return false;
  const expectedSubjects = verifiedSubjects(scope, registryEvidence);
  return Object.entries(scope.targets).every(([id, expected]) => {
    const target = readiness.conformance?.[id];
    return validSubjectRouting(target?.subjectRouting, expected.version) &&
      Boolean(expectedSubjects[id]) && target.subjectRouting.contentSha256 === expectedSubjects[id] &&
      target.verifiedSubjectSha256 === expectedSubjects[id] &&
      target.capabilityCoverage?.revision === 1 && target.capabilityCoverage?.status === "pass" &&
      target.capabilityCoverage?.claimsSha256 === scope.claimsSha256 &&
      target?.scopeSha256 === expected.scopeSha256 && target?.vectors === expected.vectors &&
      target?.results === expected.results && target?.failed === 0 && target?.error === 0;
  }) && deepEqual(readiness.conformance?.exact?.subjectRouting, readiness.conformance?.next?.subjectRouting);
}
