import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  activeAdapters,
  createSummary,
  defaultReportPath,
  normalizeFilters,
  readSuites,
  selectRunScope
} from "./run-conformance.js";

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => {
      return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
    }).join(",")}}`;
  }

  return JSON.stringify(value);
}

function deepEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function addMismatch(errors, label, expected, actual) {
  if (!deepEqual(expected, actual)) {
    errors.push({
      label,
      expected,
      actual
    });
  }
}

function suiteMetadata(suite) {
  return {
    file: suite.file,
    id: suite.id,
    name: suite.name,
    description: suite.description,
    category: suite.category,
    vectorCount: Array.isArray(suite.vectors) ? suite.vectors.length : 0
  };
}

function countResultPairs(results) {
  const counts = new Map();
  for (const result of results) {
    const key = `${result.vectorId}\u0000${result.adapterId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function requiredSummaryFields(summary) {
  return {
    suiteCount: summary.suiteCount,
    totalVectors: summary.totalVectors,
    totalResults: summary.totalResults,
    categories: summary.categories,
    operations: summary.operations,
    adapterSummary: summary.adapterSummary,
    gs1DigitalLink: summary.gs1DigitalLink,
    structuredAppend: summary.structuredAppend,
    planningDiagnostics: summary.planningDiagnostics,
    kanjiEciBinary: summary.kanjiEciBinary,
    executed: summary.executed,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    error: summary.error
  };
}

function optionalUnavailableSkipCount(report) {
  const optionalAdapters = new Set((report.adapters ?? [])
    .filter((adapter) => adapter.required === false || adapter.status === "optional")
    .map((adapter) => adapter.id));

  return (report.results ?? []).filter((result) => {
    return optionalAdapters.has(result.adapterId) &&
      result.status === "skipped" &&
      (result.checks ?? []).some((check) => check.name === "availability" && check.status === "skipped");
  }).length;
}

function addTargetMetadataErrors(errors, report) {
  const target = report.target ?? {};
  const installedSpecqr = report.metadata?.packages?.specqr;
  const resolvedVersion = target.resolvedVersion ?? target.version;

  if (target.name !== "specqr") {
    errors.push({ label: "target.name", expected: "specqr", actual: target.name });
  }

  if (!target.requested && !target.version) {
    errors.push({ label: "target.requested", expected: "requested target or legacy version", actual: target.requested });
  }

  if (!resolvedVersion) {
    errors.push({ label: "target.resolvedVersion", expected: "installed specqr version", actual: resolvedVersion });
  }

  if (installedSpecqr && resolvedVersion && installedSpecqr !== resolvedVersion) {
    errors.push({ label: "target.resolvedVersion", expected: installedSpecqr, actual: resolvedVersion });
  }

  if (!target.source) {
    errors.push({ label: "target.source", expected: "package source", actual: target.source });
  }
}

export async function verifyReportObject(report, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const errors = [];

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return {
      ok: false,
      errors: [{ label: "report", expected: "object", actual: report }]
    };
  }

  const filters = normalizeFilters(report.run?.filters ?? {});
  const suites = await readSuites({ cwd });
  let scope;
  try {
    scope = selectRunScope(suites, activeAdapters, filters);
  } catch (error) {
    return {
      ok: false,
      errors: [{ label: "run.filters", expected: "known filters", actual: error.message }]
    };
  }

  const results = Array.isArray(report.results) ? report.results : [];
  const vectorIds = new Set(scope.vectors.map((vector) => vector.id));
  const adapterIds = new Set(scope.adapters.map((adapter) => adapter.id));

  addTargetMetadataErrors(errors, report);

  for (const result of results) {
    if (!vectorIds.has(result.vectorId)) {
      errors.push({ label: "results.vectorId", expected: "selected vector", actual: result.vectorId });
    }
    if (!adapterIds.has(result.adapterId)) {
      errors.push({ label: "results.adapterId", expected: "selected adapter", actual: result.adapterId });
    }
  }

  const pairCounts = countResultPairs(results);
  for (const vector of scope.vectors) {
    for (const adapter of scope.adapters) {
      const key = `${vector.id}\u0000${adapter.id}`;
      const count = pairCounts.get(key) ?? 0;
      if (count !== 1) {
        errors.push({
          label: "results.coverage",
          expected: 1,
          actual: count,
          vectorId: vector.id,
          adapterId: adapter.id
        });
      }
    }
  }

  const expectedSuites = scope.suites.map(suiteMetadata);
  addMismatch(errors, "suites", expectedSuites, report.suites ?? []);

  const expectedSummary = createSummary(scope.suites, scope.vectors, scope.adapters, results);
  addMismatch(
    errors,
    "summary",
    requiredSummaryFields(expectedSummary),
    requiredSummaryFields(report.summary ?? {})
  );

  if ((report.summary?.failed ?? 0) !== 0 || (report.summary?.error ?? 0) !== 0) {
    errors.push({
      label: "summary.required-ci-status",
      expected: { failed: 0, error: 0 },
      actual: {
        failed: report.summary?.failed ?? null,
        error: report.summary?.error ?? null
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    report: report.run?.outputPath ?? defaultReportPath,
    mode: report.run?.mode ?? "full",
    filters,
    vectorCount: scope.vectors.length,
    adapterCount: scope.adapters.length,
    resultCount: results.length,
    optionalUnavailableSkips: optionalUnavailableSkipCount(report)
  };
}

export async function verifyReportFile(reportPath = defaultReportPath, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const absoluteReportPath = path.resolve(cwd, reportPath);
  const report = JSON.parse(await readFile(absoluteReportPath, "utf8"));
  return verifyReportObject(report, { cwd });
}

function parseCliArgs(argv) {
  const options = {
    reportPath: defaultReportPath
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--report") {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--report requires a value");
    }
    options.reportPath = value;
    index += 1;
  }

  return options;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const result = await verifyReportFile(options.reportPath);
    console.log(JSON.stringify(result, null, 2));
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
