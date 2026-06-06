import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const statusFields = ["passed", "failed", "error", "skipped"];
const countFields = ["total", "executed", ...statusFields];
const keyScopes = [
  ["GS1 / DL", "gs1DigitalLink"],
  ["Structured Append", "structuredAppend"],
  ["Planning / Diagnostics", "planningDiagnostics"],
  ["Kanji / ECI / binary", "kanjiEciBinary"]
];

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function targetLabel(target = {}) {
  const name = target.name ?? "specqr";
  const requested = target.requested ?? `${name}@${target.version ?? target.resolvedVersion ?? "unknown"}`;
  const resolved = `${name}@${target.resolvedVersion ?? target.version ?? "unknown"}`;
  const source = target.source ?? "unknown";
  return { name, requested, resolved, source };
}

function isOptionalAdapter(adapter = {}) {
  return adapter.required === false || adapter.status === "optional" || adapter.lane === "optional-decode-readability";
}

function requiredAdapterIds(report = {}) {
  return new Set((report.adapters ?? [])
    .filter((adapter) => !isOptionalAdapter(adapter))
    .map((adapter) => adapter.id));
}

function resultKey(result) {
  return `${result.vectorId}\u0000${result.adapterId}`;
}

function resultMap(report = {}) {
  return new Map((report.results ?? []).map((result) => [resultKey(result), result]));
}

function splitResultKey(key) {
  const [vectorId, adapterId] = key.split("\u0000");
  return { vectorId, adapterId };
}

function countsFor(summary = {}) {
  return {
    totalVectors: number(summary.totalVectors ?? summary.vectorCount),
    totalResults: number(summary.totalResults ?? summary.resultCount ?? summary.total),
    executed: number(summary.executed),
    passed: number(summary.passed),
    failed: number(summary.failed),
    error: number(summary.error),
    skipped: number(summary.skipped)
  };
}

function adapterCounts(adapterSummary = {}) {
  return {
    total: number(adapterSummary.total),
    executed: number(adapterSummary.executed),
    passed: number(adapterSummary.passed),
    failed: number(adapterSummary.failed),
    error: number(adapterSummary.error),
    skipped: number(adapterSummary.skipped)
  };
}

function deltaCounts(base = {}, candidate = {}, fields = countFields) {
  const delta = {};
  for (const field of fields) {
    delta[field] = number(candidate[field]) - number(base[field]);
  }
  return delta;
}

function changedCounts(delta) {
  return Object.values(delta).some((value) => value !== 0);
}

function compareAdapters(baseReport, candidateReport) {
  const baseSummary = baseReport.summary?.adapterSummary ?? {};
  const candidateSummary = candidateReport.summary?.adapterSummary ?? {};
  const ids = Array.from(new Set([
    ...Object.keys(baseSummary),
    ...Object.keys(candidateSummary)
  ])).sort();

  return ids.map((id) => {
    const base = adapterCounts(baseSummary[id]);
    const candidate = adapterCounts(candidateSummary[id]);
    const delta = deltaCounts(base, candidate);
    return {
      id,
      base,
      candidate,
      delta,
      changed: changedCounts(delta)
    };
  });
}

function scopedCounts(scope = {}) {
  return {
    vectorCount: number(scope.vectorCount),
    resultCount: number(scope.resultCount ?? scope.total),
    executed: number(scope.executed),
    passed: number(scope.passed),
    failed: number(scope.failed),
    error: number(scope.error),
    skipped: number(scope.skipped)
  };
}

function compareScopes(baseReport, candidateReport) {
  return keyScopes.map(([label, key]) => {
    const base = scopedCounts(baseReport.summary?.[key]);
    const candidate = scopedCounts(candidateReport.summary?.[key]);
    const delta = deltaCounts(base, candidate, ["vectorCount", "resultCount", "executed", ...statusFields]);
    return {
      key,
      label,
      base,
      candidate,
      delta,
      changed: changedCounts(delta)
    };
  });
}

function compareTargets(baseTarget, candidateTarget) {
  return {
    requestedChanged: baseTarget.requested !== candidateTarget.requested,
    resolvedChanged: baseTarget.resolved !== candidateTarget.resolved,
    sourceChanged: baseTarget.source !== candidateTarget.source
  };
}

function statusIsFailure(status) {
  return status === "failed" || status === "error";
}

function checkMap(result = {}) {
  return new Map((result.checks ?? []).map((check) => [check.name, check]));
}

function resultStatusRegression({ baseStatus, candidateStatus, required }) {
  if (statusIsFailure(candidateStatus) && !statusIsFailure(baseStatus)) {
    return "new failed/error result";
  }
  if (required && baseStatus === "passed" && candidateStatus !== "passed") {
    return "required result lost passed status";
  }
  return null;
}

function checkStatusRegression({ baseStatus, candidateStatus, required }) {
  if (statusIsFailure(candidateStatus) && !statusIsFailure(baseStatus)) {
    return "new failed/error check";
  }
  if (required && baseStatus === "passed" && candidateStatus !== "passed") {
    return "required check lost passed status";
  }
  return null;
}

function compareResults(baseReport, candidateReport) {
  const baseResults = resultMap(baseReport);
  const candidateResults = resultMap(candidateReport);
  const requiredIds = new Set([
    ...requiredAdapterIds(baseReport),
    ...requiredAdapterIds(candidateReport)
  ]);
  const keys = Array.from(new Set([...baseResults.keys(), ...candidateResults.keys()])).sort();
  const statusChanges = [];
  const checkChanges = [];
  const regressions = [];

  for (const key of keys) {
    const base = baseResults.get(key);
    const candidate = candidateResults.get(key);
    const { vectorId, adapterId } = splitResultKey(key);
    const required = requiredIds.has(adapterId);
    const baseStatus = base?.status ?? "missing";
    const candidateStatus = candidate?.status ?? "missing";
    const category = candidate?.category ?? base?.category;
    const operation = candidate?.operation ?? base?.operation;
    const resultRegression = resultStatusRegression({ baseStatus, candidateStatus, required });

    if (baseStatus !== candidateStatus) {
      const change = {
        vectorId,
        adapterId,
        requiredAdapter: required,
        category,
        operation,
        baseStatus,
        candidateStatus,
        regression: Boolean(resultRegression),
        reason: resultRegression
      };
      statusChanges.push(change);
      if (change.regression) {
        regressions.push({ type: "result", ...change });
      }
    }

    if (!base || !candidate) {
      continue;
    }

    const baseChecks = checkMap(base);
    const candidateChecks = checkMap(candidate);
    const checkNames = Array.from(new Set([...baseChecks.keys(), ...candidateChecks.keys()])).sort();
    for (const checkName of checkNames) {
      const baseCheck = baseChecks.get(checkName);
      const candidateCheck = candidateChecks.get(checkName);
      const baseCheckStatus = baseCheck?.status ?? "missing";
      const candidateCheckStatus = candidateCheck?.status ?? "missing";
      const checkRegression = checkStatusRegression({
        baseStatus: baseCheckStatus,
        candidateStatus: candidateCheckStatus,
        required
      });
      const interesting = baseCheckStatus !== candidateCheckStatus &&
        (checkRegression || statusIsFailure(baseCheckStatus) || statusIsFailure(candidateCheckStatus));

      if (!interesting) {
        continue;
      }

      const change = {
        vectorId,
        adapterId,
        check: checkName,
        requiredAdapter: required,
        baseStatus: baseCheckStatus,
        candidateStatus: candidateCheckStatus,
        regression: Boolean(checkRegression),
        reason: checkRegression
      };
      checkChanges.push(change);
      if (change.regression) {
        regressions.push({ type: "check", ...change });
      }
    }
  }

  return {
    statusChanges,
    checkChanges,
    regressions
  };
}

export function compareReports(baseReport, candidateReport, options = {}) {
  const baseTarget = targetLabel(baseReport.target);
  const candidateTarget = targetLabel(candidateReport.target);
  const targetDelta = compareTargets(baseTarget, candidateTarget);
  const baseCounts = countsFor(baseReport.summary);
  const candidateCounts = countsFor(candidateReport.summary);
  const summaryDelta = deltaCounts(baseCounts, candidateCounts, [
    "totalVectors",
    "totalResults",
    "executed",
    ...statusFields
  ]);
  const adapters = compareAdapters(baseReport, candidateReport);
  const keySuites = compareScopes(baseReport, candidateReport);
  const resultComparison = compareResults(baseReport, candidateReport);
  const diff = {
    ok: true,
    comparedAt: options.now?.toISOString?.() ?? new Date().toISOString(),
    base: {
      target: baseTarget,
      summary: baseCounts
    },
    candidate: {
      target: candidateTarget,
      summary: candidateCounts
    },
    targetDelta,
    summaryDelta,
    adapterSummaries: adapters,
    keySuiteSummaries: keySuites,
    resultStatusChanges: resultComparison.statusChanges,
    checkStatusChanges: resultComparison.checkChanges,
    regressions: resultComparison.regressions,
    hasRegression: resultComparison.regressions.length > 0,
    hasChanges: Object.values(targetDelta).some(Boolean) ||
      changedCounts(summaryDelta) ||
      adapters.some((adapter) => adapter.changed) ||
      keySuites.some((suite) => suite.changed) ||
      resultComparison.statusChanges.length > 0 ||
      resultComparison.checkChanges.length > 0
  };

  return diff;
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function table(headers, rows) {
  const header = `| ${headers.map(markdownCell).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function signed(value) {
  const numeric = number(value);
  return numeric > 0 ? `+${numeric}` : String(numeric);
}

function summarizeChange(change) {
  return `${change.baseStatus} -> ${change.candidateStatus}`;
}

export function renderComparisonMarkdown(diff) {
  const changedAdapters = diff.adapterSummaries.filter((adapter) => adapter.changed);
  const changedSuites = diff.keySuiteSummaries.filter((suite) => suite.changed);
  const statusChanges = diff.resultStatusChanges.slice(0, 25);
  const checkChanges = diff.checkStatusChanges.slice(0, 25);
  const regressionLabel = diff.hasRegression ? "あり" : "なし";
  const changeLabel = diff.hasChanges ? "あり" : "なし";
  const lines = [
    "# SpecQR Conformance Comparison",
    "",
    `- Base requested: \`${diff.base.target.requested}\` / resolved: \`${diff.base.target.resolved}\` (\`${diff.base.target.source}\`)`,
    `- Candidate requested: \`${diff.candidate.target.requested}\` / resolved: \`${diff.candidate.target.resolved}\` (\`${diff.candidate.target.source}\`)`,
    `- 変更: ${changeLabel}`,
    `- Regression: ${regressionLabel}`,
    "",
    "## Summary counts",
    "",
    table(
      ["Metric", "Base", "Candidate", "Delta"],
      [
        ["Vectors", diff.base.summary.totalVectors, diff.candidate.summary.totalVectors, signed(diff.summaryDelta.totalVectors)],
        ["Results", diff.base.summary.totalResults, diff.candidate.summary.totalResults, signed(diff.summaryDelta.totalResults)],
        ["Executed", diff.base.summary.executed, diff.candidate.summary.executed, signed(diff.summaryDelta.executed)],
        ["Passed", diff.base.summary.passed, diff.candidate.summary.passed, signed(diff.summaryDelta.passed)],
        ["Failed", diff.base.summary.failed, diff.candidate.summary.failed, signed(diff.summaryDelta.failed)],
        ["Error", diff.base.summary.error, diff.candidate.summary.error, signed(diff.summaryDelta.error)],
        ["Skipped", diff.base.summary.skipped, diff.candidate.summary.skipped, signed(diff.summaryDelta.skipped)]
      ]
    ),
    "",
    "## Adapter changes",
    "",
    changedAdapters.length > 0
      ? table(
        ["Adapter", "Passed", "Failed", "Error", "Skipped", "Executed"],
        changedAdapters.map((adapter) => [
          adapter.id,
          signed(adapter.delta.passed),
          signed(adapter.delta.failed),
          signed(adapter.delta.error),
          signed(adapter.delta.skipped),
          signed(adapter.delta.executed)
        ])
      )
      : "Adapter summary に変更はありません。",
    "",
    "## Key suite changes",
    "",
    changedSuites.length > 0
      ? table(
        ["Scope", "Passed", "Failed", "Error", "Skipped", "Executed"],
        changedSuites.map((suite) => [
          suite.label,
          signed(suite.delta.passed),
          signed(suite.delta.failed),
          signed(suite.delta.error),
          signed(suite.delta.skipped),
          signed(suite.delta.executed)
        ])
      )
      : "Key suite summary に変更はありません。",
    "",
    "## Result status changes",
    "",
    statusChanges.length > 0
      ? table(
        ["Vector", "Adapter", "Change", "Regression", "Reason"],
        statusChanges.map((change) => [
          change.vectorId,
          change.adapterId,
          summarizeChange(change),
          change.regression ? "yes" : "no",
          change.reason ?? ""
        ])
      )
      : "Vector / adapter status に変更はありません。",
    diff.resultStatusChanges.length > statusChanges.length
      ? `\n${diff.resultStatusChanges.length - statusChanges.length} 件の status change を省略しました。`
      : null,
    "",
    "## Check-level failed/error changes",
    "",
    checkChanges.length > 0
      ? table(
        ["Vector", "Adapter", "Check", "Change", "Regression", "Reason"],
        checkChanges.map((change) => [
          change.vectorId,
          change.adapterId,
          change.check,
          summarizeChange(change),
          change.regression ? "yes" : "no",
          change.reason ?? ""
        ])
      )
      : "Failed/error に関わる check-level change はありません。",
    diff.checkStatusChanges.length > checkChanges.length
      ? `\n${diff.checkStatusChanges.length - checkChanges.length} 件の check change を省略しました。`
      : null
  ].filter((line) => line !== null);

  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = {
    basePath: null,
    candidatePath: null,
    jsonOutputPath: null,
    markdownOutputPath: null,
    failOnRegression: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--base":
      case "--candidate":
      case "--json-output":
      case "--markdown-output": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error(`${arg} requires a value`);
        }
        index += 1;
        if (arg === "--base") {
          options.basePath = value;
        } else if (arg === "--candidate") {
          options.candidatePath = value;
        } else if (arg === "--json-output") {
          options.jsonOutputPath = value;
        } else {
          options.markdownOutputPath = value;
        }
        break;
      }
      case "--fail-on-regression":
        options.failOnRegression = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.basePath) {
    throw new Error("--base is required");
  }
  if (!options.candidatePath) {
    throw new Error("--candidate is required");
  }

  return options;
}

async function writeOutput(filePath, content) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function compareReportFiles(options = {}) {
  const baseReport = JSON.parse(await readFile(options.basePath, "utf8"));
  const candidateReport = JSON.parse(await readFile(options.candidatePath, "utf8"));
  const diff = compareReports(baseReport, candidateReport, options);
  const json = `${JSON.stringify(diff, null, 2)}\n`;
  const markdown = renderComparisonMarkdown(diff);

  if (options.jsonOutputPath) {
    await writeOutput(options.jsonOutputPath, json);
  }
  if (options.markdownOutputPath) {
    await writeOutput(options.markdownOutputPath, markdown);
  }

  return {
    ok: !options.failOnRegression || !diff.hasRegression,
    diff,
    json,
    markdown
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await compareReportFiles(options);
    if (!options.jsonOutputPath) {
      process.stdout.write(result.json);
    }
    if (!options.markdownOutputPath) {
      process.stderr.write(result.markdown);
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message
    }, null, 2));
    process.exitCode = 1;
  }
}
