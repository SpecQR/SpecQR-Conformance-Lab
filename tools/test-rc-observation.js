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
  summarizeRegistryEvidence
} from "./rc-observation.js";
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
      runId: 30739905031,
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
    checks: 55,
    clocks: [0, 72, 168],
    sufficientStatus: sufficient.observationStatus
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
