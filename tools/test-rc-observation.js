import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyGitHubSnapshot,
  computeSnapshotId,
  evaluateObservation,
  loadObservationContext,
  snapshotSummary,
  summarizeTechnicalEvidence,
  summarizeRegistryEvidence
} from "./rc-observation.js";
import { conformanceSubjectRouting, registrySubjectSha256, validReadinessConformance } from "./rc-evidence-validity.js";
import { rcRegistryTestEvidence } from "./test-rc-evidence.js";
import { validateObservationCollectionTime } from "./run-rc-observation-snapshot.js";
import { sha256, stableStringify } from "./rc-utils.js";
import { validateObservationFileSet } from "./validate-rc-observation.js";

const publishedAt = Date.parse("2026-08-02T07:38:47.138Z");

const requiredPaths = [
  ".github/workflows/rc-observation.yml",
  "docs/rc-observation.md",
  "evidence/specqr-3.0.0-rc.2-observation-manual-v1.json",
  "policies/specqr-3.0.0-rc.2-observation-v1.json",
  "schemas/rc-observation-manual-evidence-v1.schema.json",
  "schemas/rc-observation-policy-v1.schema.json",
  "schemas/rc-observation-v1.schema.json",
  "tools/assemble-rc-observation.js",
  "tools/rc-observation-constants.js",
  "tools/rc-observation-github.js",
  "tools/rc-observation.js",
  "tools/run-rc-observation-snapshot.js",
  "tools/validate-rc-observation.js"
];

function observedAt(ageHours) {
  return new Date(publishedAt + ageHours * 3_600_000).toISOString();
}

function confirmation() {
  return {
    id: "independent-sample-1",
    kind: "independent-sample",
    candidate: "3.0.0-rc.2",
    packageSource: "npm-registry",
    independent: true,
    automatedFixture: false,
    independenceReason: "Separate public sample repository with its own CI run.",
    url: "https://github.com/example/specqr-consumer",
    commit: "1111111111111111111111111111111111111111",
    logUrl: "https://github.com/example/specqr-consumer/actions/runs/1",
    logSha256: "2".repeat(64),
    verifiedAt: observedAt(167),
    summary: "Public registry package consumer passed."
  };
}

function snapshot(ageHours, overrides = {}) {
  const value = {
    schemaVersion: 1,
    kind: "specqr-rc-observation-snapshot",
    observedAt: observedAt(ageHours),
    ageHours,
    lab: {
      repository: "SpecQR/SpecQR-Conformance-Lab",
      commit: "a".repeat(40),
      workflowRunId: null,
      workflowUrl: null
    },
    candidate: {
      exactRequested: "specqr@3.0.0-rc.2",
      nextRequested: "specqr@next",
      resolvedVersion: "3.0.0-rc.2",
      publishedAt: "2026-08-02T07:38:47.138Z"
    },
    registry: {
      status: "pass",
      invariantFingerprint: "3".repeat(64)
    },
    technicalEvidence: {
      evidenceKind: "initial-reference",
      status: "pass",
      runId: 40000000000,
      completedAt: "2026-08-02T08:31:32.000Z"
    },
    github: {
      summary: { unreviewed: 0, blocking: 0 }
    },
    consumerConfirmations: [],
    blockers: [],
    manualEvidenceSha256: "4".repeat(64),
    technicalStatus: "pass",
    ...overrides
  };
  value.technicalEvidence = {
    headSha: "a".repeat(40),
    subjectRoutingRevision: 1,
    conformanceEvidenceRevision: 1,
    ...value.technicalEvidence
  };
  return { ...value, snapshotId: computeSnapshotId(value) };
}

function summaries(values) {
  return values.map((value) => snapshotSummary(value));
}

function registryEvidence(requested, version = "3.0.0-rc.2") {
  return {
    requested,
    resolvedVersion: version,
    source: "npm-registry",
    dist: {
      tarball: "https://registry.npmjs.org/specqr/-/specqr-3.0.0-rc.2.tgz"
    },
    publication: {
      registry: "2026-08-02T07:38:47.138Z"
    },
    hashes: {
      tarballSha256: "c96c324dcd99d72c385d3890156a6ae973ad8db57b840fd5a47f987ddcbb6298",
      expandedSha256: "f507de7da842b3bc5fce88eaa6a4d04388ce1d55541c58cbebf36d4b583ae306",
      manifestSha256: "05fdf7029c6b66f56bf2b952e9297ea38201d8a144929f14cc55d26970f8af1f"
    },
    manifest: Array.from({ length: 121 }, (_, index) => ({ path: String(index) })),
    runtimeDependencyCount: 0,
    runtime: { exports: { generate: "function" }, smoke: { matrix: "ok" } },
    status: "pass"
  };
}

async function run() {
  await Promise.all(requiredPaths.map((filePath) => access(filePath)));
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  for (const script of ["observation:snapshot", "observation:assemble", "observation:validate"]) {
    assert.equal(typeof packageJson.scripts[script], "string", `package.json must define ${script}`);
  }
  const workflow = await readFile(".github/workflows/rc-observation.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /schedule:/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.doesNotMatch(workflow, /continue-on-error/u);

  const context = await loadObservationContext();
  const policy = context.policy.value;
  // Synthetic evidence only: these clocks and run IDs do not create observation artifacts.
  const scope = context.conformanceScope;
  const registryFixture = await rcRegistryTestEvidence();
  const candidateSubjectSha256 = registrySubjectSha256(registryFixture.exact, "specqr@3.0.0-rc.2");
  const labCommit = "a".repeat(40);
  const fixtureMetadata = {
    repository: policy.technicalEvidence.repository,
    run: { id: 40000000000, workflowId: policy.technicalEvidence.workflowId, status: "completed", conclusion: "success", headSha: labCommit, createdAt: observedAt(167), updatedAt: observedAt(168), url: "https://example.test/run" },
    artifact: { expired: false, id: 1, name: `specqr-3.0.0-rc.2-readiness-${labCommit}`, url: "https://example.test/artifact", archiveSha256: "1".repeat(64), readinessSha256: "2".repeat(64) }
  };
  const fixtureReadiness = {
    commit: labCommit, generatedAt: observedAt(168), technicalStatus: "pass", observationStatus: "pending", summary: { failed: 0 },
    release: { version: policy.candidate.resolvedVersion, expectedTarballSha256: policy.candidate.tarballSha256, expectedExpandedSha256: policy.candidate.expandedSha256 },
    targets: { exact: { requested: policy.candidate.exactRequested, resolvedVersion: policy.candidate.resolvedVersion }, next: { requested: policy.candidate.nextRequested, resolvedVersion: policy.candidate.resolvedVersion } },
    registryIntegrity: Object.fromEntries(["exact", "next"].map((id) => [id, { status: "pass", hashes: { tarballSha256: policy.candidate.tarballSha256, expandedSha256: policy.candidate.expandedSha256, manifestSha256: policy.candidate.manifestSha256 }, fileCount: 121, runtimeDependencyCount: 0 }])),
    conformance: Object.fromEntries(Object.entries(scope.targets).map(([id, expected]) => [id, {
      vectors: expected.vectors, results: expected.results, failed: 0, error: 0, scopeSha256: expected.scopeSha256,
      verifiedSubjectSha256: id === "baseline" ? scope.baselineSubjectSha256 : candidateSubjectSha256,
      capabilityCoverage: { revision: 1, status: "pass", claimsSha256: scope.claimsSha256 },
      subjectRouting: { revision: 1, resolver: "shared-specqr-target", packageName: "specqr", packageVersion: expected.version, contentSha256: id === "baseline" ? scope.baselineSubjectSha256 : candidateSubjectSha256 }
    }])),
    expectedDelta: Object.fromEntries(["exact", "next"].map((id) => [id, { status: "pass", rawDeltaCount: 3, matchedExpected: 3, missingExpected: 0, unexpected: 0 }])),
    v3Contract: Object.fromEntries(["exact", "next"].map((id) => [id, { status: "pass", requiredCheckCount: 35, passed: 35, failed: 0 }])),
    toolchain: { packageSurface: policy.technicalEvidence.requiredNodeMajors.map((nodeMajor) => ({ nodeMajor, status: "pass" })), full: { nodeMajor: "22", status: "pass" } },
    artifacts: { artifactSetSha256: "3".repeat(64) }
  };
  for (const field of ["registryIntegrity", "expectedDelta", "v3Contract"]) fixtureReadiness[field].selectorComparison = { status: "pass" };
  const admit = (readiness = fixtureReadiness, metadata = fixtureMetadata) => summarizeTechnicalEvidence(policy, metadata, readiness, labCommit, observedAt(168), scope, registryFixture);
  assert.equal(admit().status, "pass");
  assert.equal(admit().subjectRoutingRevision, 1);
  assert.equal(admit().conformanceEvidenceRevision, 1);
  for (const mutate of [
    (report) => { delete report.conformance.exact.subjectRouting; },
    (report) => { delete report.conformance.exact.capabilityCoverage; },
    (report) => { report.conformance.next.capabilityCoverage.status = "blocked"; },
    (report) => { report.conformance.exact.capabilityCoverage.claimsSha256 = "0".repeat(64); },
    (report) => { for (const id of ["exact", "next"]) { report.conformance[id].subjectRouting.contentSha256 = scope.baselineSubjectSha256; report.conformance[id].verifiedSubjectSha256 = scope.baselineSubjectSha256; } },
    (report) => { report.conformance.exact.subjectRouting.packageVersion = "2.4.0"; },
    (report) => { report.conformance.next.subjectRouting.contentSha256 = "d".repeat(64); },
    (report) => { report.conformance.exact.scopeSha256 = "0".repeat(64); },
    (report) => { report.conformance.exact.vectors -= 1; },
    (report) => { report.commit = "f".repeat(40); }
  ]) {
    const changed = structuredClone(fixtureReadiness);
    mutate(changed);
    assert.equal(admit(changed).status, "blocked");
  }
  const oldRun = structuredClone(fixtureMetadata);
  oldRun.run.id = policy.technicalEvidence.initialRunId;
  assert.equal(admit(fixtureReadiness, oldRun).status, "blocked", "revoked run cannot be rehabilitated by new markers");
  assert.equal(admit(fixtureReadiness, oldRun).checks.find((entry) => entry.id === "technical-evidence-not-revoked").status, "blocked");
  const oldHead = structuredClone(fixtureMetadata);
  oldHead.run.headSha = policy.technicalEvidence.initialHeadSha;
  assert.equal(admit(fixtureReadiness, oldHead).status, "blocked");
  assert.equal(admit(fixtureReadiness, oldHead).checks.find((entry) => entry.id === "technical-evidence-not-revoked").status, "blocked");
  assert.equal(validReadinessConformance(fixtureReadiness), false, "missing source scope must fail closed");
  const rawRouting = fixtureReadiness.conformance.exact.subjectRouting;
  const rawReport = { target: { resolvedVersion: "3.0.0-rc.2" }, metadata: { provenance: { subjectRouting: rawRouting, packages: { specqr: { version: "3.0.0-rc.2", contentSha256: rawRouting.contentSha256 } } } } };
  assert.deepEqual(conformanceSubjectRouting(rawReport), rawRouting);
  rawReport.metadata.provenance.packages.specqr.contentSha256 = "0".repeat(64);
  assert.equal(conformanceSubjectRouting(rawReport), null);
  const collectionTime = Date.parse(observedAt(168));
  validateObservationCollectionTime(observedAt(168), collectionTime);
  assert.throws(() => validateObservationCollectionTime(observedAt(0), collectionTime), /original evidence artifacts/u);
  assert.throws(() => validateObservationCollectionTime(observedAt(169), collectionTime), /original evidence artifacts/u);

  const at0 = snapshot(0);
  const result0 = evaluateObservation(policy, at0, summaries([at0]), { now: observedAt(0) });
  assert.equal(result0.observationStatus, "pending");
  assert(result0.statusReasons.pending.includes("minimum-observation-age"));
  assert(result0.statusReasons.pending.includes("minimum-snapshot-count"));
  assert(result0.statusReasons.pending.includes("independent-consumer-confirmation"));

  const at72 = snapshot(72);
  const result72 = evaluateObservation(policy, at72, summaries([at0, at72]), { now: observedAt(72) });
  assert.equal(result72.observationStatus, "pending");
  assert.equal(result72.criteria.find((entry) => entry.id === "snapshot-after-72-hours").status, "pass");

  const at168Pending = snapshot(168);
  const result168 = evaluateObservation(policy, at168Pending, summaries([at0, at72, at168Pending]), {
    now: observedAt(168)
  });
  assert.equal(result168.observationStatus, "pending");
  assert(result168.statusReasons.pending.includes("independent-consumer-confirmation"));
  assert(result168.statusReasons.pending.includes("final-technical-rerun"));

  const unreviewed = snapshot(168, {
    github: { summary: { unreviewed: 1, blocking: 0 } },
    consumerConfirmations: [confirmation()],
    technicalEvidence: {
      evidenceKind: "final-rerun",
      status: "pass",
      runId: 40000000000,
      completedAt: observedAt(168)
    }
  });
  const unreviewedResult = evaluateObservation(policy, unreviewed, summaries([at0, at72, unreviewed]), {
    now: observedAt(168)
  });
  assert.equal(unreviewedResult.observationStatus, "pending");
  assert(unreviewedResult.statusReasons.pending.includes("open-items-reviewed"));

  const blocking = snapshot(168, {
    blockers: [{ id: "blocking-1" }],
    consumerConfirmations: [confirmation()],
    technicalEvidence: {
      evidenceKind: "final-rerun",
      status: "pass",
      runId: 40000000000,
      completedAt: observedAt(168)
    }
  });
  const blockingResult = evaluateObservation(policy, blocking, summaries([at0, at72, blocking]), {
    now: observedAt(168)
  });
  assert.equal(blockingResult.observationStatus, "blocked");
  assert(blockingResult.statusReasons.blocked.includes("no-open-blockers"));

  const technicalFailure = snapshot(168, {
    technicalStatus: "blocked",
    technicalEvidence: {
      evidenceKind: "final-rerun",
      status: "blocked",
      runId: 40000000000,
      completedAt: observedAt(168)
    }
  });
  const technicalFailureResult = evaluateObservation(
    policy,
    technicalFailure,
    summaries([at0, at72, technicalFailure]),
    { now: observedAt(168) }
  );
  assert.equal(technicalFailureResult.observationStatus, "blocked");
  assert(technicalFailureResult.statusReasons.blocked.includes("technical-evidence"));
  assert(technicalFailureResult.statusReasons.blocked.includes("snapshot-technical-integrity"));

  const final = snapshot(168, {
    consumerConfirmations: [confirmation()],
    technicalEvidence: {
      evidenceKind: "final-rerun",
      status: "pass",
      runId: 40000000000,
      completedAt: observedAt(168)
    }
  });
  const sufficient = evaluateObservation(policy, final, summaries([at0, at72, final]), {
    now: observedAt(168)
  });
  assert.equal(sufficient.observationStatus, "sufficient");
  assert.equal(sufficient.statusReasons.pending.length, 0);
  assert.equal(sufficient.statusReasons.blocked.length, 0);

  for (const mutate of [
    (entry) => { entry.technicalRunId = policy.technicalEvidence.initialRunId; },
    (entry) => { entry.technicalHeadSha = policy.technicalEvidence.initialHeadSha; },
    (entry) => { delete entry.subjectRoutingRevision; },
    (entry) => { delete entry.conformanceEvidenceRevision; }
  ]) {
    const historical = snapshotSummary(at0);
    mutate(historical);
    const rejected = evaluateObservation(policy, final, [historical, snapshotSummary(at72), snapshotSummary(final)], { now: observedAt(168) });
    assert.equal(rejected.observationStatus, "blocked", "old green history cannot count after evidence revocation");
    assert(rejected.statusReasons.blocked.includes("snapshot-technical-integrity"));
  }

  const driftedSummary = snapshotSummary(at72);
  driftedSummary.registryFingerprint = "9".repeat(64);
  const drift = evaluateObservation(policy, final, [snapshotSummary(at0), driftedSummary, snapshotSummary(final)], {
    now: observedAt(168)
  });
  assert.equal(drift.observationStatus, "blocked");
  assert(drift.statusReasons.blocked.includes("registry-invariance"));

  assert.throws(() => evaluateObservation(policy, final, summaries([at0, at72, final]), {
    now: observedAt(167)
  }), /future observedAt/u);
  assert.throws(() => evaluateObservation(policy, at0, summaries([at72, at0]), {
    now: observedAt(168)
  }), /clock rollback/u);
  assert.throws(() => evaluateObservation(policy, at0, [snapshotSummary(at0), snapshotSummary(at0)], {
    now: observedAt(168)
  }), /duplicate snapshot/u);
  const wrongCandidate = snapshotSummary(at0);
  wrongCandidate.candidateVersion = "3.0.0-rc.3";
  assert.throws(() => evaluateObservation(policy, at0, [wrongCandidate], {
    now: observedAt(168)
  }), /candidate does not match/u);

  const automaticItem = {
    repositories: policy.repositories,
    counts: {},
    items: [{
      repository: "SpecQR/SpecQR",
      type: "issue",
      number: 99,
      state: "open",
      title: "Possible regression",
      labels: ["regression"],
      createdAt: observedAt(0),
      updatedAt: observedAt(0),
      closedAt: null,
      url: "https://github.com/SpecQR/SpecQR/issues/99"
    }]
  };
  const classified = classifyGitHubSnapshot(automaticItem, {
    itemReviews: [],
    consumerConfirmations: [],
    reportedBlockers: []
  }, observedAt(1));
  assert.equal(classified.items[0].classification, "unreviewed");
  assert.equal(classified.status, "pending");
  const manualReview = {
    repository: "SpecQR/SpecQR",
    type: "issue",
    number: 99,
    url: "https://github.com/SpecQR/SpecQR/issues/99",
    classification: "blocking",
    reason: "Manual review confirmed a candidate regression.",
    reviewMethod: "manual",
    reviewedAt: observedAt(2)
  };
  const manuallyBlocked = classifyGitHubSnapshot(automaticItem, {
    itemReviews: [manualReview],
    consumerConfirmations: [],
    reportedBlockers: []
  }, observedAt(2));
  assert.equal(manuallyBlocked.items[0].classification, "blocking");
  assert.equal(manuallyBlocked.status, "blocked");
  const staleItem = JSON.parse(JSON.stringify(automaticItem));
  staleItem.items[0].updatedAt = observedAt(3);
  const staleReview = classifyGitHubSnapshot(staleItem, {
    itemReviews: [manualReview],
    consumerConfirmations: [],
    reportedBlockers: []
  }, observedAt(4));
  assert.equal(staleReview.items[0].classification, "unreviewed");

  const exact = registryEvidence("specqr@3.0.0-rc.2");
  const next = registryEvidence("specqr@next");
  const comparison = { status: "pass" };
  assert.equal(summarizeRegistryEvidence(policy, exact, next, comparison, {
    latest: "2.4.0",
    next: "3.0.0-rc.2"
  }).status, "pass");
  assert.equal(summarizeRegistryEvidence(policy, exact, next, comparison, {
    latest: "2.4.0",
    next: "3.0.0-rc.3"
  }).status, "blocked");
  assert.equal(summarizeRegistryEvidence(policy, exact, registryEvidence("specqr@next", "3.0.0-rc.3"), comparison, {
    latest: "2.4.0",
    next: "3.0.0-rc.2"
  }).status, "blocked");

  const changedSnapshot = JSON.parse(JSON.stringify(at0));
  changedSnapshot.ageHours = 1;
  assert.notEqual(changedSnapshot.snapshotId, computeSnapshotId(changedSnapshot));

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "specqr-observation-test-"));
  try {
    const filePath = path.join(temporaryDirectory, "evidence.json");
    await writeFile(filePath, "{\"ok\":true}\n", "utf8");
    const contents = await readFile(filePath);
    const files = [{ path: "evidence.json", size: contents.length, sha256: sha256(contents) }];
    const fileHashes = { artifactSetSha256: sha256(`${stableStringify(files)}\n`), files };
    assert.equal((await validateObservationFileSet(temporaryDirectory, fileHashes)).ok, true);
    await writeFile(filePath, "{\"ok\":false}\n", "utf8");
    assert.equal((await validateObservationFileSet(temporaryDirectory, fileHashes)).ok, false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    checks: 85,
    clocks: [0, 72, 168],
    sufficientStatus: sufficient.observationStatus
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
