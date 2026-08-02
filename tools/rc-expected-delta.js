import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  rcBaselineSpec,
  rcExactSpec,
  rcExpectedDeltaCount,
  rcExpectedDeltaPolicyPath,
  rcExpectedDeltaPolicySchemaPath,
  rcExpectedDeltaPolicySchemaSha256,
  rcExpectedDeltaPolicySha256,
  rcNextSpec,
  rcVersion
} from "./rc-constants.js";
import { compareRcReports, normalizeRcResult } from "./compare-rc-reports.js";
import { createCheck, deepEqual, sha256, stableStringify, statusCounts, writeJson, writeText } from "./rc-utils.js";
import { validateSchemaValue } from "./validate-schemas.js";

const warningPaths = [
  "$.details.diagnostics.warnings",
  "$.details.planning.warnings"
];

const changePaths = [
  "$.details.diagnostics.warnings.length",
  "$.details.diagnostics.warnings[0]",
  "$.details.planning.warnings.length",
  "$.details.planning.warnings[0]"
];

const fixedEntries = [
  {
    vectorId: "core.estimate.data-too-long-reject",
    operation: "estimate",
    remainingBits: -381,
    beforeFingerprint: "feb36244b3cba7698421c2bfe4357aa091b91980034ed6c6d2c7043cc7644c50",
    afterFingerprint: "3aa336488d9fd8afbfdc1cb6ddf2ef4123f9257659d4ede5ff255af3ad9c33c9"
  },
  {
    vectorId: "planning.estimate.data-too-long-v1-h",
    operation: "estimate",
    remainingBits: -340,
    beforeFingerprint: "13f97c0ed73c276012eaaa150d756da6ca91bac859dffea06b07a01b1816d47a",
    afterFingerprint: "c8a9588eac278ac1c09249b2eaed6ca2714c4f93dd32c1d3a7130e8a3deb00e7"
  },
  {
    vectorId: "planning.analyze-segments.data-too-long-v1-h",
    operation: "analyzeSegments",
    remainingBits: -340,
    beforeFingerprint: "b6f40826566b609cab7cd7bd674a5fbc52b591513eee415276bdc6008f4a23dd",
    afterFingerprint: "e454ec71100d4de4209be8f3340b87f97423f94367483ca9a9a861c2b58bc1a2"
  }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolvedVersion(report) {
  return report.target?.resolvedVersion ?? report.target?.version;
}

function resultKey(vectorId, adapterId = "specqr") {
  return `${vectorId}\u0000${adapterId}`;
}

function resultMap(report) {
  return new Map((report.results ?? []).map((result) => [resultKey(result.vectorId, result.adapterId), result]));
}

function resultFingerprint(result) {
  return sha256(stableStringify(normalizeRcResult(result)));
}

function warningArrays(result) {
  return [result?.details?.diagnostics?.warnings, result?.details?.planning?.warnings];
}

function warningArraysMatch(arrays, count, warningCode) {
  return arrays.every((warnings) => {
    return Array.isArray(warnings) && warnings.length === count &&
      (count === 0 || warnings.every((warning) => warning?.code === warningCode));
  });
}

function policySemantics(policy) {
  const errors = [];
  const expectedTargets = {
    baseline: { requested: rcBaselineSpec, resolvedVersion: "2.4.0" },
    candidate: { requested: [rcExactSpec, rcNextSpec], resolvedVersion: rcVersion }
  };
  if (!policy || !deepEqual(policy.validFor, expectedTargets)) {
    errors.push("validFor must be pinned to the RC 2 baseline and selectors");
  }
  if (policy?.expectedDeltaCount !== rcExpectedDeltaCount || policy?.entries?.length !== rcExpectedDeltaCount) {
    errors.push(`policy must contain exactly ${rcExpectedDeltaCount} entries`);
  }
  if (!deepEqual(policy?.control, {
    id: "capacity-near-limit-positive-control",
    adapterId: "specqr",
    vectorId: "planning.diagnostics.warning.capacity-near-limit",
    operation: "estimate",
    status: "passed",
    planningOk: true,
    planningReason: null,
    remainingBits: 1,
    warningCode: "CAPACITY_NEAR_LIMIT",
    warningCount: 1,
    warningPaths
  })) {
    errors.push("positive control is not the exact pinned control");
  }

  const entriesByVector = new Map((policy?.entries ?? []).map((entry) => [entry.vectorId, entry]));
  if (entriesByVector.size !== rcExpectedDeltaCount) {
    errors.push("entry vector IDs must be unique");
  }
  for (const fixed of fixedEntries) {
    const entry = entriesByVector.get(fixed.vectorId);
    const comparable = entry && {
      targets: entry.targets,
      adapterId: entry.adapterId,
      vectorId: entry.vectorId,
      operation: entry.operation,
      changePaths: entry.changePaths,
      beforeFingerprint: entry.beforeFingerprint,
      afterFingerprint: entry.afterFingerprint,
      warningCode: entry.warningCode,
      remainingBits: entry.precondition?.expectedRemainingBits,
      remainingBitsLessThan: entry.precondition?.remainingBitsLessThan,
      baselineWarningCount: entry.precondition?.baselineWarningCount,
      candidateWarningCount: entry.precondition?.candidateWarningCount,
      invariantMethod: entry.unchangedInvariant?.method,
      invariantPaths: entry.unchangedInvariant?.paths,
      control: entry.control
    };
    const expected = {
      targets: expectedTargets,
      adapterId: "specqr",
      vectorId: fixed.vectorId,
      operation: fixed.operation,
      changePaths,
      beforeFingerprint: fixed.beforeFingerprint,
      afterFingerprint: fixed.afterFingerprint,
      warningCode: "CAPACITY_NEAR_LIMIT",
      remainingBits: fixed.remainingBits,
      remainingBitsLessThan: 0,
      baselineWarningCount: 1,
      candidateWarningCount: 0,
      invariantMethod: "remove-exact-warning-arrays-then-deep-equal",
      invariantPaths: warningPaths,
      control: "capacity-near-limit-positive-control"
    };
    if (!deepEqual(comparable, expected)) {
      errors.push(`entry ${fixed.vectorId} does not match its exact pinned contract`);
    }
  }
  return errors;
}

function parseDocument(text, label) {
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error: `${label}: ${error.message}` };
  }
}

export function validateExpectedDeltaPolicyDocuments(options) {
  const policyText = options.policyText;
  const schemaText = options.schemaText;
  const parsedPolicy = parseDocument(policyText, "policy");
  const parsedSchema = parseDocument(schemaText, "policy schema");
  const policySha256 = sha256(policyText);
  const schemaSha256 = sha256(schemaText);
  const schemaResult = parsedPolicy.value && parsedSchema.value
    ? validateSchemaValue(parsedPolicy.value, parsedSchema.value)
    : { ok: false, errors: [parsedPolicy.error, parsedSchema.error].filter(Boolean) };
  const semanticErrors = parsedPolicy.value ? policySemantics(parsedPolicy.value) : [parsedPolicy.error];
  const checks = [
    createCheck("policy-json", !parsedPolicy.error, { error: parsedPolicy.error }),
    createCheck("policy-schema-json", !parsedSchema.error, { error: parsedSchema.error }),
    createCheck("policy-sha256", policySha256 === rcExpectedDeltaPolicySha256, {
      expected: rcExpectedDeltaPolicySha256,
      actual: policySha256
    }),
    createCheck("policy-schema-sha256", schemaSha256 === rcExpectedDeltaPolicySchemaSha256, {
      expected: rcExpectedDeltaPolicySchemaSha256,
      actual: schemaSha256
    }),
    createCheck("policy-schema", schemaResult.ok, { errors: schemaResult.errors }),
    createCheck("policy-exact-semantics", semanticErrors.length === 0, { errors: semanticErrors })
  ];
  const summary = statusCounts(checks);
  return {
    policy: parsedPolicy.value,
    schema: parsedSchema.value,
    source: {
      path: options.policyPath ?? rcExpectedDeltaPolicyPath,
      sha256: policySha256,
      schemaPath: options.schemaPath ?? rcExpectedDeltaPolicySchemaPath,
      schemaSha256
    },
    checks,
    summary,
    status: summary.failed === 0 ? "pass" : "blocked"
  };
}

export async function loadExpectedDeltaPolicy(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const policyReadPath = options.policyReadPath ?? options.policyPath ?? rcExpectedDeltaPolicyPath;
  const schemaReadPath = options.schemaReadPath ?? options.schemaPath ?? rcExpectedDeltaPolicySchemaPath;
  const [policyText, schemaText] = await Promise.all([
    readFile(path.resolve(cwd, policyReadPath), "utf8"),
    readFile(path.resolve(cwd, schemaReadPath), "utf8")
  ]);
  return validateExpectedDeltaPolicyDocuments({
    policyText,
    schemaText,
    policyPath: options.sourcePolicyPath ?? rcExpectedDeltaPolicyPath,
    schemaPath: options.sourceSchemaPath ?? rcExpectedDeltaPolicySchemaPath
  });
}

function verifyControl(baseReport, candidateReport, control) {
  const base = resultMap(baseReport).get(resultKey(control.vectorId, control.adapterId));
  const candidate = resultMap(candidateReport).get(resultKey(control.vectorId, control.adapterId));
  const reasons = [];
  for (const [label, result] of [["baseline", base], ["candidate", candidate]]) {
    if (!result) {
      reasons.push(`${label} control result is missing`);
      continue;
    }
    if (result.operation !== control.operation || result.status !== control.status) {
      reasons.push(`${label} control operation or status changed`);
    }
    const planning = result.details?.planning;
    if (planning?.ok !== control.planningOk || planning?.reason !== control.planningReason ||
        planning?.remainingBits !== control.remainingBits) {
      reasons.push(`${label} control planning precondition changed`);
    }
    if (!warningArraysMatch(warningArrays(result), control.warningCount, control.warningCode)) {
      reasons.push(`${label} control warning changed`);
    }
  }
  if (base && candidate && !deepEqual(normalizeRcResult(base), normalizeRcResult(candidate))) {
    reasons.push("control result changed between baseline and candidate");
  }
  return {
    id: control.id,
    adapterId: control.adapterId,
    vectorId: control.vectorId,
    operation: control.operation,
    remainingBits: control.remainingBits,
    warningCode: control.warningCode,
    baselineFingerprint: base ? resultFingerprint(base) : null,
    candidateFingerprint: candidate ? resultFingerprint(candidate) : null,
    reasons,
    status: reasons.length === 0 ? "pass" : "blocked"
  };
}

function verifyEntry(entry, baseResult, candidateResult, rawChange, rawBlocking) {
  const reasons = [];
  let invariantPassed = false;
  const beforeFingerprint = baseResult ? resultFingerprint(baseResult) : null;
  const afterFingerprint = candidateResult ? resultFingerprint(candidateResult) : null;
  if (!baseResult || !candidateResult) {
    reasons.push("baseline or candidate result is missing");
  } else {
    if (baseResult.adapterId !== entry.adapterId || candidateResult.adapterId !== entry.adapterId ||
        baseResult.vectorId !== entry.vectorId || candidateResult.vectorId !== entry.vectorId) {
      reasons.push("adapter or vector does not match");
    }
    if (baseResult.operation !== entry.operation || candidateResult.operation !== entry.operation) {
      reasons.push("operation does not match");
    }
    if (baseResult.status !== entry.precondition.status || candidateResult.status !== entry.precondition.status) {
      reasons.push("result status precondition failed");
    }
    for (const [label, result] of [["baseline", baseResult], ["candidate", candidateResult]]) {
      const planning = result.details?.planning;
      if (planning?.ok !== entry.precondition.candidateOk ||
          planning?.reason !== entry.precondition.candidateReason ||
          planning?.remainingBits !== entry.precondition.expectedRemainingBits ||
          !(planning?.remainingBits < entry.precondition.remainingBitsLessThan)) {
        reasons.push(`${label} planning precondition failed`);
      }
    }
    if (!warningArraysMatch(warningArrays(baseResult), entry.precondition.baselineWarningCount, entry.warningCode)) {
      reasons.push("baseline warning precondition failed");
    }
    if (!warningArraysMatch(warningArrays(candidateResult), entry.precondition.candidateWarningCount, entry.warningCode)) {
      reasons.push("candidate warning removal precondition failed");
    }

    const normalizedBase = normalizeRcResult(baseResult);
    const normalizedCandidate = normalizeRcResult(candidateResult);
    if (normalizedBase.details?.diagnostics && normalizedBase.details?.planning) {
      normalizedBase.details.diagnostics.warnings = [];
      normalizedBase.details.planning.warnings = [];
      invariantPassed = deepEqual(normalizedBase, normalizedCandidate);
    } else {
      reasons.push("unchanged field invariant failed");
    }
    if (!invariantPassed &&
        !reasons.includes("unchanged field invariant failed")) {
      reasons.push("unchanged field invariant failed");
    }
  }

  if (beforeFingerprint !== entry.beforeFingerprint || afterFingerprint !== entry.afterFingerprint) {
    reasons.push("full result fingerprint does not match");
  }
  if (!rawChange || rawChange.kind !== "normalized-result" ||
      rawChange.baseFingerprint !== entry.beforeFingerprint ||
      rawChange.candidateFingerprint !== entry.afterFingerprint) {
    reasons.push("raw change fingerprint does not match");
  }
  if (!rawChange || !deepEqual(rawChange.differences?.map((difference) => difference.path), entry.changePaths)) {
    reasons.push("raw change paths do not match");
  }
  if (rawChange) {
    const lengthDifferences = rawChange.differences.filter((difference) => difference.path.endsWith(".length"));
    const warningDifferences = rawChange.differences.filter((difference) => difference.path.endsWith("[0]"));
    if (lengthDifferences.length !== 2 || !lengthDifferences.every((difference) => {
      return difference.base === 1 && difference.candidate === 0;
    })) {
      reasons.push("raw warning count difference is not exact");
    }
    if (warningDifferences.length !== 2 || !warningDifferences.every((difference) => {
      return difference.base?.code === entry.warningCode && difference.candidate === null;
    })) {
      reasons.push("raw warning code difference is not exact");
    }
  }
  if (!rawBlocking || rawBlocking.kind !== "matrix-renderer-helper-or-result-change" ||
      rawBlocking.base !== entry.beforeFingerprint || rawBlocking.candidate !== entry.afterFingerprint) {
    reasons.push("raw blocking regression does not match");
  }

  return {
    id: entry.id,
    key: resultKey(entry.vectorId, entry.adapterId),
    adapterId: entry.adapterId,
    vectorId: entry.vectorId,
    operation: entry.operation,
    changePaths: entry.changePaths,
    beforeFingerprint,
    afterFingerprint,
    warningCode: entry.warningCode,
    precondition: {
      status: entry.precondition.status,
      ok: entry.precondition.candidateOk,
      reason: entry.precondition.candidateReason,
      remainingBits: entry.precondition.expectedRemainingBits,
      remainingBitsLessThan: entry.precondition.remainingBitsLessThan,
      baselineWarningCount: entry.precondition.baselineWarningCount,
      candidateWarningCount: entry.precondition.candidateWarningCount
    },
    unchangedInvariant: {
      method: entry.unchangedInvariant.method,
      paths: entry.unchangedInvariant.paths,
      status: invariantPassed ? "pass" : "blocked"
    },
    control: entry.control,
    reasons,
    status: reasons.length === 0 ? "matched" : "missing"
  };
}

export function adjudicateExpectedDeltas(options) {
  const { baseReport, candidateReport, rawComparison, policyContext } = options;
  const policy = policyContext.policy;
  const expectedRequested = options.expectedRequested ?? candidateReport.target?.requested;
  const recomputedRaw = compareRcReports(baseReport, candidateReport, { kind: rawComparison?.kind });
  const rawChanges = recomputedRaw.changes ?? [];
  const rawBlocking = recomputedRaw.blockingRegressions ?? [];
  const changesByKey = new Map(rawChanges
    .filter((change) => change.kind === "normalized-result")
    .map((change) => [change.key, change]));
  const blockingByKey = new Map(rawBlocking
    .filter((item) => item.kind === "matrix-renderer-helper-or-result-change")
    .map((item) => [item.key, item]));
  const baseResults = resultMap(baseReport);
  const candidateResults = resultMap(candidateReport);
  const entries = (policy?.entries ?? []).map((entry) => {
    const key = resultKey(entry.vectorId, entry.adapterId);
    return verifyEntry(
      entry,
      baseResults.get(key),
      candidateResults.get(key),
      changesByKey.get(key),
      blockingByKey.get(key)
    );
  });
  const matchedKeys = new Set(entries.filter((entry) => entry.status === "matched").map((entry) => entry.key));
  const missingExpected = entries.filter((entry) => entry.status !== "matched").map((entry) => ({
    id: entry.id,
    key: entry.key,
    reasons: entry.reasons
  }));
  const unexpected = [
    ...rawChanges.filter((change) => change.kind !== "normalized-result" || !matchedKeys.has(change.key)).map((change) => ({
      source: "changes",
      kind: change.kind,
      key: change.key
    })),
    ...rawBlocking.filter((item) => item.kind !== "matrix-renderer-helper-or-result-change" || !matchedKeys.has(item.key)).map((item) => ({
      source: "blockingRegressions",
      kind: item.kind,
      key: item.key
    }))
  ];
  const control = policy?.control
    ? verifyControl(baseReport, candidateReport, policy.control)
    : { id: null, reasons: ["policy control is missing"], status: "blocked" };
  const matchedExpected = entries.filter((entry) => entry.status === "matched").length;
  const targetMatches = baseReport.target?.requested === rcBaselineSpec && resolvedVersion(baseReport) === "2.4.0" &&
    candidateReport.target?.requested === expectedRequested &&
    policy?.validFor?.candidate?.requested?.includes(expectedRequested) &&
    resolvedVersion(candidateReport) === rcVersion;
  const checks = [
    createCheck("policy-integrity", policyContext.status === "pass", { policyStatus: policyContext.status }),
    createCheck("raw-comparison-integrity", deepEqual(rawComparison, recomputedRaw)),
    createCheck("target-pin", targetMatches, {
      expected: { baseline: rcBaselineSpec, candidate: expectedRequested, resolvedVersion: rcVersion },
      actual: {
        baseline: baseReport.target,
        candidate: candidateReport.target
      }
    }),
    createCheck("raw-strict-remains-blocked", recomputedRaw.status === "blocked"),
    createCheck("raw-delta-count", rawChanges.length === rcExpectedDeltaCount, {
      expected: rcExpectedDeltaCount,
      actual: rawChanges.length
    }),
    createCheck("raw-blocking-count", rawBlocking.length === rcExpectedDeltaCount, {
      expected: rcExpectedDeltaCount,
      actual: rawBlocking.length
    }),
    createCheck("matched-expected", matchedExpected === rcExpectedDeltaCount, {
      expected: rcExpectedDeltaCount,
      actual: matchedExpected
    }),
    createCheck("missing-expected", missingExpected.length === 0, { count: missingExpected.length }),
    createCheck("unexpected", unexpected.length === 0, { count: unexpected.length }),
    createCheck("positive-control", control.status === "pass", { controlStatus: control.status })
  ];
  const summary = statusCounts(checks);
  return {
    schemaVersion: 1,
    kind: "specqr-rc-expected-delta-adjudication",
    target: {
      baseline: { requested: baseReport.target?.requested, resolvedVersion: resolvedVersion(baseReport) },
      candidate: { requested: candidateReport.target?.requested, resolvedVersion: resolvedVersion(candidateReport) }
    },
    policy: {
      id: policy?.id ?? null,
      path: policyContext.source.path,
      sha256: policyContext.source.sha256,
      schemaPath: policyContext.source.schemaPath,
      schemaSha256: policyContext.source.schemaSha256,
      expectedDeltaCount: policy?.expectedDeltaCount ?? null,
      status: policyContext.status
    },
    evidenceFiles: options.evidenceFiles ?? {},
    rawStatus: recomputedRaw.status,
    rawDeltaCount: rawChanges.length,
    rawBlockingRegressionCount: rawBlocking.length,
    matchedExpected,
    missingExpected,
    unexpected,
    control,
    entries,
    checks,
    summary,
    status: summary.failed === 0 ? "pass" : "blocked"
  };
}

function selectorComparable(adjudication) {
  return {
    policy: adjudication.policy,
    rawStatus: adjudication.rawStatus,
    rawDeltaCount: adjudication.rawDeltaCount,
    rawBlockingRegressionCount: adjudication.rawBlockingRegressionCount,
    matchedExpected: adjudication.matchedExpected,
    missingExpected: adjudication.missingExpected,
    unexpected: adjudication.unexpected,
    control: adjudication.control,
    entries: adjudication.entries,
    status: adjudication.status
  };
}

export function compareExpectedDeltaAdjudications(exact, next) {
  const exactComparable = selectorComparable(exact);
  const nextComparable = selectorComparable(next);
  const identical = deepEqual(exactComparable, nextComparable);
  const checks = [
    createCheck("exact-status", exact.status === "pass"),
    createCheck("next-status", next.status === "pass"),
    createCheck("selector-evidence-identical", identical, {
      exactSha256: sha256(stableStringify(exactComparable)),
      nextSha256: sha256(stableStringify(nextComparable))
    })
  ];
  const summary = statusCounts(checks);
  return {
    schemaVersion: 1,
    kind: "specqr-rc-expected-delta-selector-comparison",
    exactRequested: exact.target.candidate.requested,
    nextRequested: next.target.candidate.requested,
    exactSha256: sha256(stableStringify(exactComparable)),
    nextSha256: sha256(stableStringify(nextComparable)),
    identical,
    checks,
    summary,
    status: summary.failed === 0 ? "pass" : "blocked"
  };
}

export function renderExpectedDeltaMarkdown(adjudication) {
  const rows = adjudication.entries.map((entry) => {
    return `| ${entry.vectorId} | ${entry.operation} | \`${entry.beforeFingerprint}\` | \`${entry.afterFingerprint}\` | ${entry.status} |`;
  });
  return `# SpecQR RC Expected Delta Adjudication

- Candidate: \`${adjudication.target.candidate.requested}\` -> \`${adjudication.target.candidate.resolvedVersion}\`
- Raw strict status: **${adjudication.rawStatus}**
- Raw deltas: ${adjudication.rawDeltaCount}
- Matched expected: ${adjudication.matchedExpected}
- Missing expected: ${adjudication.missingExpected.length}
- Unexpected: ${adjudication.unexpected.length}
- Policy: \`${adjudication.policy.path}\`
- Policy SHA-256: \`${adjudication.policy.sha256}\`
- Status: **${adjudication.status}**

| Vector | Operation | Before fingerprint | After fingerprint | Result |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

## Positive control

- Vector: \`${adjudication.control.vectorId}\`
- Remaining bits: ${adjudication.control.remainingBits}
- Warning: \`${adjudication.control.warningCode}\`
- Status: **${adjudication.control.status}**
`;
}

export async function writeExpectedDeltaEvidence(options) {
  await writeJson(options.jsonPath, options.adjudication);
  if (options.markdownPath) {
    await writeText(options.markdownPath, renderExpectedDeltaMarkdown(options.adjudication));
  }
}
