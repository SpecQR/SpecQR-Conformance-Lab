import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  observationCandidateVersion,
  observationExactSpec,
  observationManualEvidencePath,
  observationManualEvidenceSchemaPath,
  observationManualEvidenceSchemaSha256,
  observationNextSpec,
  observationPolicyPath,
  observationPolicySchemaPath,
  observationPolicySchemaSha256,
  observationPolicySha256,
  observationPublishedAt,
  observationReportSchemaPath,
  observationReportSchemaSha256,
  observationRepository
} from "./rc-observation-constants.js";
import { deepEqual, sha256, stableStringify } from "./rc-utils.js";
import { validateSchemaValue } from "./validate-schemas.js";

function parseDate(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid date-time`);
  }
  return timestamp;
}

function hoursBetween(earlier, later) {
  return Number(((later - earlier) / 3_600_000).toFixed(6));
}

function check(id, condition, details = {}) {
  return {
    id,
    status: condition ? "pass" : "blocked",
    ...details
  };
}

function criterion(id, status, reason, actual, required) {
  return { id, status, reason, actual, required };
}

function countStatuses(values, field = "status") {
  const counts = {};
  for (const value of values) {
    counts[value[field]] = (counts[value[field]] ?? 0) + 1;
  }
  return counts;
}

async function loadJsonAndText(cwd, filePath) {
  const text = await readFile(path.resolve(cwd, filePath), "utf8");
  return { text, value: JSON.parse(text), sha256: sha256(text) };
}

function assertSchema(value, schema, label) {
  const result = validateSchemaValue(value, schema);
  if (!result.ok) {
    throw new Error(`${label} does not match its schema: ${JSON.stringify(result.errors)}`);
  }
}

export async function loadObservationContext(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const [policy, policySchema, manualEvidence, manualEvidenceSchema, reportSchema] = await Promise.all([
    loadJsonAndText(cwd, options.policyPath ?? observationPolicyPath),
    loadJsonAndText(cwd, observationPolicySchemaPath),
    loadJsonAndText(cwd, options.manualEvidencePath ?? observationManualEvidencePath),
    loadJsonAndText(cwd, observationManualEvidenceSchemaPath),
    loadJsonAndText(cwd, observationReportSchemaPath)
  ]);

  assertSchema(policy.value, policySchema.value, "RC observation policy");
  assertSchema(manualEvidence.value, manualEvidenceSchema.value, "RC observation manual evidence");
  const integrity = [
    ["policy", policy.sha256, observationPolicySha256],
    ["policy schema", policySchema.sha256, observationPolicySchemaSha256],
    ["manual evidence schema", manualEvidenceSchema.sha256, observationManualEvidenceSchemaSha256],
    ["report schema", reportSchema.sha256, observationReportSchemaSha256]
  ];
  for (const [label, actual, expected] of integrity) {
    if (actual !== expected) {
      throw new Error(`RC observation ${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
    }
  }
  if (manualEvidence.value.candidate !== policy.value.candidate.resolvedVersion) {
    throw new Error("RC observation manual evidence candidate does not match policy");
  }

  return {
    cwd,
    policy,
    policySchema,
    manualEvidence,
    manualEvidenceSchema,
    reportSchema
  };
}

function registryTargetSummary(evidence) {
  return {
    requested: evidence.requested,
    resolvedVersion: evidence.resolvedVersion,
    source: evidence.source,
    tarballUrl: evidence.dist?.tarball ?? null,
    publication: evidence.publication,
    hashes: evidence.hashes,
    fileCount: evidence.manifest?.length ?? 0,
    runtimeDependencyCount: evidence.runtimeDependencyCount,
    exportsFingerprint: sha256(stableStringify(evidence.runtime?.exports)),
    runtimeFingerprint: sha256(stableStringify(evidence.runtime?.smoke)),
    status: evidence.status
  };
}

export function summarizeRegistryEvidence(policy, exactEvidence, nextEvidence, comparison, distTags) {
  const exact = registryTargetSummary(exactEvidence);
  const next = registryTargetSummary(nextEvidence);
  const expected = policy.candidate;
  const targetMatches = (target, requested) => {
    return target.requested === requested &&
      target.resolvedVersion === expected.resolvedVersion &&
      target.source === "npm-registry" &&
      target.tarballUrl === "https://registry.npmjs.org/specqr/-/specqr-3.0.0-rc.2.tgz" &&
      target.publication?.registry === expected.publishedAt &&
      target.hashes?.tarballSha256 === expected.tarballSha256 &&
      target.hashes?.expandedSha256 === expected.expandedSha256 &&
      target.hashes?.manifestSha256 === expected.manifestSha256 &&
      target.fileCount === expected.fileCount &&
      target.runtimeDependencyCount === expected.runtimeDependencyCount &&
      target.status === "pass";
  };
  const checks = [
    check("exact-registry-integrity", targetMatches(exact, expected.exactRequested)),
    check("next-registry-integrity", targetMatches(next, expected.nextRequested)),
    check("exact-next-equivalence", comparison.status === "pass" &&
      deepEqual({ ...exact, requested: null }, { ...next, requested: null })),
    check("latest-dist-tag", distTags.latest === policy.distTags.latest, {
      expected: policy.distTags.latest,
      actual: distTags.latest ?? null
    }),
    check("next-dist-tag", distTags.next === policy.distTags.next, {
      expected: policy.distTags.next,
      actual: distTags.next ?? null
    })
  ];
  const invariant = {
    resolvedVersion: exact.resolvedVersion,
    publishedAt: exact.publication?.registry,
    distTags: {
      latest: distTags.latest ?? null,
      next: distTags.next ?? null
    },
    hashes: exact.hashes,
    tarballUrl: exact.tarballUrl,
    fileCount: exact.fileCount,
    runtimeDependencyCount: exact.runtimeDependencyCount,
    exportsFingerprint: exact.exportsFingerprint,
    runtimeFingerprint: exact.runtimeFingerprint
  };
  return {
    exact,
    next,
    distTags: {
      latest: distTags.latest ?? null,
      next: distTags.next ?? null
    },
    selectorComparisonStatus: comparison.status,
    invariantFingerprint: sha256(stableStringify(invariant)),
    checks,
    status: checks.every((entry) => entry.status === "pass") ? "pass" : "blocked"
  };
}

function technicalReadinessChecks(policy, metadata, readiness, labCommit, observedAt) {
  const requiredMajors = policy.technicalEvidence.requiredNodeMajors;
  const nodeMajors = readiness.toolchain?.packageSurface?.map((entry) => entry.nodeMajor) ?? [];
  const conformanceTargets = [readiness.conformance?.baseline, readiness.conformance?.exact, readiness.conformance?.next];
  const runId = metadata.run.id;
  const initial = runId === policy.technicalEvidence.initialRunId;
  const checks = [
    check("workflow", metadata.run.workflowId === policy.technicalEvidence.workflowId),
    check("run-success", metadata.run.status === "completed" && metadata.run.conclusion === "success"),
    check("run-not-after-observation", parseDate(metadata.run.updatedAt, "technical run updatedAt") <= observedAt),
    check("artifact-current", metadata.artifact.expired === false &&
      metadata.artifact.name === `specqr-3.0.0-rc.2-readiness-${metadata.run.headSha}`),
    check("readiness-technical-pass", readiness.technicalStatus === "pass" && readiness.summary?.failed === 0),
    check("readiness-observation-boundary", readiness.observationStatus === "pending"),
    check("readiness-release", readiness.release?.version === policy.candidate.resolvedVersion &&
      readiness.release?.expectedTarballSha256 === policy.candidate.tarballSha256 &&
      readiness.release?.expectedExpandedSha256 === policy.candidate.expandedSha256),
    check("readiness-targets", readiness.targets?.exact?.requested === policy.candidate.exactRequested &&
      readiness.targets?.exact?.resolvedVersion === policy.candidate.resolvedVersion &&
      readiness.targets?.next?.requested === policy.candidate.nextRequested &&
      readiness.targets?.next?.resolvedVersion === policy.candidate.resolvedVersion),
    check("readiness-registry", [readiness.registryIntegrity?.exact, readiness.registryIntegrity?.next].every((target) => {
      return target?.status === "pass" &&
        target?.hashes?.tarballSha256 === policy.candidate.tarballSha256 &&
        target?.hashes?.expandedSha256 === policy.candidate.expandedSha256 &&
        target?.hashes?.manifestSha256 === policy.candidate.manifestSha256 &&
        target?.fileCount === policy.candidate.fileCount &&
        target?.runtimeDependencyCount === policy.candidate.runtimeDependencyCount;
    }) && readiness.registryIntegrity?.selectorComparison?.status === "pass"),
    check("readiness-conformance", conformanceTargets.every((target) => {
      return target?.vectors === 91 && target?.results === 455 && target?.failed === 0 && target?.error === 0;
    })),
    check("readiness-expected-delta", [readiness.expectedDelta?.exact, readiness.expectedDelta?.next].every((target) => {
      return target?.status === "pass" && target?.rawDeltaCount === 3 && target?.matchedExpected === 3 &&
        target?.missingExpected === 0 && target?.unexpected === 0;
    }) && readiness.expectedDelta?.selectorComparison?.status === "pass"),
    check("readiness-v3-contract", [readiness.v3Contract?.exact, readiness.v3Contract?.next].every((target) => {
      return target?.status === "pass" && target?.requiredCheckCount === policy.technicalEvidence.requiredV3ContractChecks &&
        target?.passed === policy.technicalEvidence.requiredV3ContractChecks && target?.failed === 0;
    }) && readiness.v3Contract?.selectorComparison?.status === "pass"),
    check("readiness-node-matrix", deepEqual(nodeMajors, requiredMajors) &&
      readiness.toolchain.packageSurface.every((entry) => entry.status === "pass") &&
      readiness.toolchain?.full?.nodeMajor === "22" && readiness.toolchain?.full?.status === "pass")
  ];

  if (initial) {
    checks.push(
      check("initial-run-id", runId === policy.technicalEvidence.initialRunId),
      check("initial-head", metadata.run.headSha === policy.technicalEvidence.initialHeadSha),
      check("initial-artifact-id", metadata.artifact.id === policy.technicalEvidence.initialArtifactId),
      check("initial-artifact-name", metadata.artifact.name === policy.technicalEvidence.initialArtifactName),
      check("initial-artifact-sha256", metadata.artifact.archiveSha256 === policy.technicalEvidence.initialArtifactSha256),
      check("initial-readiness-sha256", metadata.artifact.readinessSha256 === policy.technicalEvidence.initialReadinessSha256),
      check("initial-artifact-set", readiness.artifacts?.artifactSetSha256 ===
        policy.technicalEvidence.initialReadinessArtifactSetSha256)
    );
  } else {
    checks.push(check("final-rerun-head", metadata.run.headSha === labCommit, {
      expected: labCommit,
      actual: metadata.run.headSha
    }));
  }

  return {
    kind: initial ? "initial-reference" : "final-rerun",
    checks,
    status: checks.every((entry) => entry.status === "pass") ? "pass" : "blocked"
  };
}

export function summarizeTechnicalEvidence(policy, metadata, readiness, labCommit, observedAtValue) {
  const observedAt = parseDate(observedAtValue, "observedAt");
  const evaluation = technicalReadinessChecks(policy, metadata, readiness, labCommit, observedAt);
  const nodeMajors = readiness.toolchain?.packageSurface?.map((entry) => entry.nodeMajor) ?? [];
  const summary = {
    evidenceKind: evaluation.kind,
    repository: metadata.repository,
    runId: metadata.run.id,
    workflowId: metadata.run.workflowId,
    runStatus: metadata.run.status,
    conclusion: metadata.run.conclusion,
    headSha: metadata.run.headSha,
    createdAt: metadata.run.createdAt,
    completedAt: metadata.run.updatedAt,
    runUrl: metadata.run.url,
    artifactId: metadata.artifact.id,
    artifactName: metadata.artifact.name,
    artifactUrl: metadata.artifact.url,
    artifactSha256: metadata.artifact.archiveSha256,
    readinessSha256: metadata.artifact.readinessSha256,
    readinessArtifactSetSha256: readiness.artifacts?.artifactSetSha256 ?? null,
    readinessGeneratedAt: readiness.generatedAt,
    nodeMajors,
    v3Contract: {
      exact: readiness.v3Contract?.exact?.passed ?? 0,
      next: readiness.v3Contract?.next?.passed ?? 0,
      required: policy.technicalEvidence.requiredV3ContractChecks
    },
    checks: evaluation.checks,
    status: evaluation.status
  };
  return {
    ...summary,
    fingerprint: sha256(stableStringify({
      runId: summary.runId,
      headSha: summary.headSha,
      artifactSha256: summary.artifactSha256,
      readinessSha256: summary.readinessSha256,
      readinessArtifactSetSha256: summary.readinessArtifactSetSha256,
      status: summary.status
    }))
  };
}

function reviewKey(value) {
  return `${value.repository}:${value.type}:${value.number}`;
}

export function classifyGitHubSnapshot(rawGitHub, manualEvidence, observedAtValue) {
  const observedAt = parseDate(observedAtValue, "observedAt");
  const reviews = new Map();
  for (const review of manualEvidence.itemReviews) {
    const key = reviewKey(review);
    if (reviews.has(key)) {
      throw new Error(`Manual evidence repeats item review ${key}`);
    }
    reviews.set(key, review);
  }

  const items = rawGitHub.items.map((item) => {
    const review = reviews.get(reviewKey(item));
    const reviewedAt = review ? parseDate(review.reviewedAt, `review ${reviewKey(review)} reviewedAt`) : null;
    const reviewIsUsable = review && review.url === item.url && reviewedAt <= observedAt &&
      reviewedAt >= parseDate(item.updatedAt, `item ${reviewKey(item)} updatedAt`);
    if (!reviewIsUsable) {
      return {
        ...item,
        classification: "unreviewed",
        classificationReason: "この open item に一致する manual review evidence がない。",
        classificationSource: "unreviewed"
      };
    }
    return {
      ...item,
      classification: review.classification,
      classificationReason: review.reason,
      classificationSource: review.reviewMethod,
      reviewedAt: review.reviewedAt
    };
  });
  const classifications = countStatuses(items, "classification");
  const summary = {
    total: items.length,
    issues: items.filter((item) => item.type === "issue").length,
    pullRequests: items.filter((item) => item.type === "pull-request").length,
    unreviewed: classifications.unreviewed ?? 0,
    nonBlocking: classifications["non-blocking"] ?? 0,
    blocking: classifications.blocking ?? 0,
    repositories: rawGitHub.counts
  };
  return {
    repositories: rawGitHub.repositories,
    items,
    summary,
    fingerprint: sha256(stableStringify(items)),
    status: summary.blocking > 0 ? "blocked" : summary.unreviewed > 0 ? "pending" : "pass"
  };
}

function validateManualTimestamps(manualEvidence, observedAtValue) {
  const observedAt = parseDate(observedAtValue, "observedAt");
  const publishedAt = parseDate(observationPublishedAt, "candidate publishedAt");
  for (const review of manualEvidence.itemReviews) {
    const reviewedAt = parseDate(review.reviewedAt, `review ${reviewKey(review)} reviewedAt`);
    if (reviewedAt < publishedAt || reviewedAt > observedAt) {
      throw new Error(`Item review ${reviewKey(review)} is outside the observation window`);
    }
  }
  const ids = new Set();
  for (const confirmation of manualEvidence.consumerConfirmations) {
    if (ids.has(confirmation.id)) {
      throw new Error(`Manual evidence repeats consumer confirmation ${confirmation.id}`);
    }
    ids.add(confirmation.id);
    const verifiedAt = parseDate(confirmation.verifiedAt, `confirmation ${confirmation.id} verifiedAt`);
    if (verifiedAt < publishedAt || verifiedAt > observedAt) {
      throw new Error(`Consumer confirmation ${confirmation.id} is outside the observation window`);
    }
  }
  for (const blocker of manualEvidence.reportedBlockers) {
    if (parseDate(blocker.observedAt, `blocker ${blocker.id} observedAt`) > observedAt) {
      throw new Error(`Reported blocker ${blocker.id} is in the future`);
    }
  }
}

function buildBlockers(github, manualEvidence) {
  const githubBlockers = github.items
    .filter((item) => item.classification === "blocking")
    .map((item) => ({
      id: `github:${item.repository}:${item.type}:${item.number}`,
      category: "reviewed-open-item",
      summary: item.classificationReason,
      url: item.url,
      source: "github"
    }));
  const reported = manualEvidence.reportedBlockers
    .filter((blocker) => blocker.state === "open")
    .map((blocker) => ({ ...blocker, source: "manual-evidence" }));
  return [...githubBlockers, ...reported];
}

function snapshotPayload(snapshot) {
  const { snapshotId: _snapshotId, ...payload } = snapshot;
  return payload;
}

export function computeSnapshotId(snapshot) {
  return sha256(`${stableStringify(snapshotPayload(snapshot))}\n`);
}

export function buildObservationSnapshot(options) {
  const {
    policy,
    manualEvidence,
    registryExact,
    registryNext,
    registryComparison,
    distTags,
    rawGitHub,
    technicalMetadata,
    technicalReadiness,
    observedAt,
    labCommit,
    workflowRunId = null,
    workflowUrl = null,
    manualEvidenceSha256
  } = options;
  const publishedTimestamp = parseDate(policy.candidate.publishedAt, "candidate publishedAt");
  const observedTimestamp = parseDate(observedAt, "observedAt");
  if (observedTimestamp < publishedTimestamp) {
    throw new Error("observedAt cannot be before candidate publishedAt");
  }
  if (!/^[0-9a-f]{40}$/u.test(labCommit)) {
    throw new Error("Lab commit must be a full 40-character commit SHA");
  }
  validateManualTimestamps(manualEvidence, observedAt);

  const registry = summarizeRegistryEvidence(
    policy,
    registryExact,
    registryNext,
    registryComparison,
    distTags
  );
  const technicalEvidence = summarizeTechnicalEvidence(
    policy,
    technicalMetadata,
    technicalReadiness,
    labCommit,
    observedAt
  );
  const github = classifyGitHubSnapshot(rawGitHub, manualEvidence, observedAt);
  const blockers = buildBlockers(github, manualEvidence);
  const technicalStatus = registry.status === "pass" && technicalEvidence.status === "pass" ? "pass" : "blocked";
  const snapshot = {
    schemaVersion: 1,
    kind: "specqr-rc-observation-snapshot",
    observedAt,
    ageHours: hoursBetween(publishedTimestamp, observedTimestamp),
    lab: {
      repository: observationRepository,
      commit: labCommit,
      workflowRunId,
      workflowUrl
    },
    candidate: {
      exactRequested: policy.candidate.exactRequested,
      nextRequested: policy.candidate.nextRequested,
      resolvedVersion: policy.candidate.resolvedVersion,
      publishedAt: policy.candidate.publishedAt
    },
    registry,
    technicalEvidence,
    github,
    consumerConfirmations: manualEvidence.consumerConfirmations,
    blockers,
    manualEvidenceSha256,
    technicalStatus
  };
  return { ...snapshot, snapshotId: computeSnapshotId(snapshot) };
}

export function snapshotSummary(snapshot) {
  return {
    snapshotId: snapshot.snapshotId,
    observedAt: snapshot.observedAt,
    ageHours: snapshot.ageHours,
    labCommit: snapshot.lab.commit,
    workflowRunId: snapshot.lab.workflowRunId,
    candidateVersion: snapshot.candidate.resolvedVersion,
    registryStatus: snapshot.registry.status,
    registryFingerprint: snapshot.registry.invariantFingerprint,
    technicalStatus: snapshot.technicalStatus,
    technicalEvidenceKind: snapshot.technicalEvidence.evidenceKind,
    technicalRunId: snapshot.technicalEvidence.runId,
    technicalCompletedAt: snapshot.technicalEvidence.completedAt,
    githubUnreviewed: snapshot.github.summary.unreviewed,
    githubBlocking: snapshot.github.summary.blocking,
    consumerConfirmationCount: snapshot.consumerConfirmations.length,
    blockerCount: snapshot.blockers.length
  };
}

function assertSnapshotTimeline(policy, snapshots, nowValue) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error("Observation report requires at least one snapshot");
  }
  const now = parseDate(nowValue, "validation time");
  const publishedAt = parseDate(policy.candidate.publishedAt, "candidate publishedAt");
  const ids = new Set();
  const observedValues = new Set();
  let previous = null;
  for (const snapshot of snapshots) {
    const observedAt = parseDate(snapshot.observedAt, "snapshot observedAt");
    if (observedAt > now) {
      throw new Error(`Snapshot ${snapshot.snapshotId} has a future observedAt`);
    }
    if (ids.has(snapshot.snapshotId) || observedValues.has(snapshot.observedAt)) {
      throw new Error(`Observation timeline contains duplicate snapshot ${snapshot.snapshotId}`);
    }
    if (previous !== null && observedAt <= previous) {
      throw new Error("Observation timeline contains clock rollback or non-increasing timestamps");
    }
    const expectedAge = hoursBetween(publishedAt, observedAt);
    if (Math.abs(expectedAge - snapshot.ageHours) > 0.000001) {
      throw new Error(`Snapshot ${snapshot.snapshotId} ageHours does not match observedAt`);
    }
    if (snapshot.candidateVersion !== policy.candidate.resolvedVersion) {
      throw new Error(`Snapshot ${snapshot.snapshotId} candidate does not match policy`);
    }
    ids.add(snapshot.snapshotId);
    observedValues.add(snapshot.observedAt);
    previous = observedAt;
  }
}

export function evaluateObservation(policy, currentSnapshot, snapshots, options = {}) {
  const now = options.now ?? new Date().toISOString();
  assertSnapshotTimeline(policy, snapshots, now);
  const timeline = policy.timeline;
  const last = snapshots.at(-1);
  if (last.snapshotId !== currentSnapshot.snapshotId) {
    throw new Error("Current snapshot must be the final observation timeline entry");
  }
  const initialMilestone = timeline.milestones.find((milestone) => milestone.id === "initial");
  const milestone72 = timeline.milestones.find((milestone) => milestone.id === "after-72-hours");
  const milestone168 = timeline.milestones.find((milestone) => milestone.id === "after-168-hours");
  const finalGapHours = snapshots.length < 2 ? 0 : hoursBetween(
    parseDate(snapshots.at(-2).observedAt, "previous snapshot observedAt"),
    parseDate(last.observedAt, "final snapshot observedAt")
  );
  const registryFingerprints = new Set(snapshots.map((snapshot) => snapshot.registryFingerprint));
  const registryInvariantPass = snapshots.every((snapshot) => snapshot.registryStatus === "pass") &&
    registryFingerprints.size === 1;
  const snapshotTechnicalPass = snapshots.every((snapshot) => snapshot.technicalStatus === "pass");
  const finalRerunEarliest = parseDate(policy.candidate.publishedAt, "candidate publishedAt") +
    timeline.minimumAgeHours * 3_600_000;
  const finalTechnicalPass = currentSnapshot.technicalEvidence.evidenceKind === "final-rerun" &&
    currentSnapshot.technicalEvidence.status === "pass" &&
    parseDate(currentSnapshot.technicalEvidence.completedAt, "technical completedAt") >= finalRerunEarliest &&
    currentSnapshot.ageHours >= timeline.minimumAgeHours;
  const confirmations = currentSnapshot.consumerConfirmations.length;
  const criteria = [
    criterion(
      "registry-integrity",
      currentSnapshot.registry.status === "pass" ? "pass" : "blocked",
      currentSnapshot.registry.status === "pass" ? "exact RC と next の registry evidence は不変。" : "Registry integrity または dist-tag が固定値と不一致。",
      currentSnapshot.registry.status,
      "pass"
    ),
    criterion(
      "technical-evidence",
      currentSnapshot.technicalEvidence.status === "pass" ? "pass" : "blocked",
      currentSnapshot.technicalEvidence.status === "pass" ? "参照した RC readiness evidence は green。" : "RC readiness evidence が required technical gate を満たさない。",
      currentSnapshot.technicalEvidence.status,
      "pass"
    ),
    criterion(
      "registry-invariance",
      registryInvariantPass ? "pass" : "blocked",
      registryInvariantPass ? "全 snapshot の registry fingerprint は一致。" : "Snapshot 間で registry fingerprint drift を検出。",
      registryFingerprints.size,
      1
    ),
    criterion(
      "snapshot-technical-integrity",
      snapshotTechnicalPass ? "pass" : "blocked",
      snapshotTechnicalPass ? "全 selected snapshot の technical evidence は green。" :
        "Technical failure を含む snapshot は timeline evidence に採用できない。",
      snapshots.filter((snapshot) => snapshot.technicalStatus !== "pass").length,
      0
    ),
    criterion(
      "open-items-reviewed",
      currentSnapshot.github.summary.unreviewed === 0 ? "pass" : "pending",
      currentSnapshot.github.summary.unreviewed === 0 ? "全 open issue / PR に manual classification がある。" : "未 review の open issue / PR がある。",
      currentSnapshot.github.summary.unreviewed,
      0
    ),
    criterion(
      "no-open-blockers",
      currentSnapshot.blockers.length === 0 ? "pass" : "blocked",
      currentSnapshot.blockers.length === 0 ? "未解決の blocking evidence はない。" : "未解決の blocking evidence がある。",
      currentSnapshot.blockers.length,
      0
    ),
    criterion(
      "minimum-observation-age",
      currentSnapshot.ageHours >= timeline.minimumAgeHours ? "pass" : "pending",
      currentSnapshot.ageHours >= timeline.minimumAgeHours ? "最小観察期間を満たす。" : "最小観察期間に達していない。",
      currentSnapshot.ageHours,
      timeline.minimumAgeHours
    ),
    criterion(
      "minimum-snapshot-count",
      snapshots.length >= timeline.minimumSnapshots ? "pass" : "pending",
      snapshots.length >= timeline.minimumSnapshots ? "必要な snapshot 数を満たす。" : "必要な snapshot 数に達していない。",
      snapshots.length,
      timeline.minimumSnapshots
    ),
    criterion(
      "initial-snapshot",
      snapshots.some((snapshot) => snapshot.ageHours >= initialMilestone.minimumAgeHours &&
        snapshot.ageHours < initialMilestone.maximumAgeHours) ? "pass" : "pending",
      "公開後 72 時間より前の initial snapshot を要求する。",
      snapshots.map((snapshot) => snapshot.ageHours),
      `< ${initialMilestone.maximumAgeHours}`
    ),
    criterion(
      "snapshot-after-72-hours",
      snapshots.some((snapshot) => snapshot.ageHours >= milestone72.minimumAgeHours) ? "pass" : "pending",
      "公開後 72 時間以降の snapshot を要求する。",
      Math.max(...snapshots.map((snapshot) => snapshot.ageHours)),
      milestone72.minimumAgeHours
    ),
    criterion(
      "snapshot-after-168-hours",
      snapshots.some((snapshot) => snapshot.ageHours >= milestone168.minimumAgeHours) ? "pass" : "pending",
      "公開後 168 時間以降の snapshot を要求する。",
      Math.max(...snapshots.map((snapshot) => snapshot.ageHours)),
      milestone168.minimumAgeHours
    ),
    criterion(
      "minimum-final-gap",
      finalGapHours >= timeline.minimumFinalGapHours ? "pass" : "pending",
      "最終 2 snapshot の間隔は 48 時間以上必要。",
      finalGapHours,
      timeline.minimumFinalGapHours
    ),
    criterion(
      "independent-consumer-confirmation",
      confirmations >= policy.consumerConfirmation.minimumIndependentConfirmations ? "pass" : "pending",
      confirmations >= policy.consumerConfirmation.minimumIndependentConfirmations ?
        "Registry package だけを使う独立 consumer confirmation がある。" :
        "Registry package だけを使う独立 consumer confirmation が不足。",
      confirmations,
      policy.consumerConfirmation.minimumIndependentConfirmations
    ),
    criterion(
      "final-technical-rerun",
      finalTechnicalPass ? "pass" : "pending",
      finalTechnicalPass ? "最終 snapshot で exact RC と next の technical readiness を再実行済み。" :
        "公開後 168 時間以降の最終 technical readiness rerun が未完了。",
      currentSnapshot.technicalEvidence.evidenceKind,
      "final-rerun"
    )
  ];
  const blocked = criteria.filter((entry) => entry.status === "blocked");
  const pending = criteria.filter((entry) => entry.status === "pending");
  const observationStatus = blocked.length > 0 ? "blocked" : pending.length > 0 ? "pending" : "sufficient";
  return {
    criteria,
    technicalStatus: currentSnapshot.technicalStatus,
    observationStatus,
    statusReasons: {
      pending: pending.map((entry) => entry.id),
      blocked: blocked.map((entry) => entry.id)
    }
  };
}

export function buildObservationReport(options) {
  const previousSnapshots = options.previousReport?.snapshots ?? [];
  const currentSummary = snapshotSummary(options.snapshot);
  const snapshots = [...previousSnapshots, currentSummary];
  const evaluation = evaluateObservation(options.policy, options.snapshot, snapshots, { now: options.generatedAt });
  return {
    schemaVersion: 1,
    kind: "specqr-rc-observation",
    generatedAt: options.generatedAt,
    candidate: options.snapshot.candidate,
    publishedAt: options.snapshot.candidate.publishedAt,
    observedAt: options.snapshot.observedAt,
    ageHours: options.snapshot.ageHours,
    lab: options.snapshot.lab,
    technicalEvidence: options.snapshot.technicalEvidence,
    registry: options.snapshot.registry,
    github: options.snapshot.github,
    consumerConfirmations: options.snapshot.consumerConfirmations,
    blockers: options.snapshot.blockers,
    snapshots,
    criteria: evaluation.criteria,
    technicalStatus: evaluation.technicalStatus,
    observationStatus: evaluation.observationStatus,
    statusReasons: evaluation.statusReasons,
    policy: options.policyReference,
    history: options.historyReference ?? null,
    nonClaims: options.policy.nonClaims,
    fileHashes: options.fileHashes
  };
}

export function assertFixedObservationTarget(policy) {
  if (policy.candidate.exactRequested !== observationExactSpec ||
      policy.candidate.nextRequested !== observationNextSpec ||
      policy.candidate.resolvedVersion !== observationCandidateVersion ||
      policy.candidate.publishedAt !== observationPublishedAt) {
    throw new Error("Observation policy does not match the fixed RC 2 target");
  }
}
