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
import { readCoverageClaimsFile, summarizeCoverageClaims } from "./coverage-claims.js";
import { semanticReportSha256 } from "./report-provenance.js";
import { reportPackageNames } from "./report-metadata.js";

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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const resultStatuses = new Set(["passed", "failed", "error", "skipped"]);
const defaultAdapterLanes = {
  specqr: "generation-planning",
  jsqr: "decode-readability",
  nayuki: "reference-matrix"
};

function addResultErrors(errors, result, vector, index) {
  const context = { resultIndex: index, vectorId: result.vectorId, adapterId: result.adapterId };
  const mismatch = (label, expected, actual) => {
    if (!deepEqual(expected, actual)) {
      errors.push({ label, expected, actual, ...context });
    }
  };

  if (vector) {
    for (const field of ["suiteId", "title", "category", "operation"]) {
      mismatch(`results.${field}`, vector[field], result[field]);
    }
  }
  if (!resultStatuses.has(result.status)) {
    errors.push({ label: "results.status", expected: [...resultStatuses], actual: result.status, ...context });
  }
  if (!Array.isArray(result.checks) || result.checks.length === 0) {
    errors.push({ label: "results.checks", expected: "at least one check, including for skipped results", actual: result.checks, ...context });
    return;
  }

  const names = new Set();
  let checksValid = true;
  for (const [checkIndex, check] of result.checks.entries()) {
    if (!isObject(check)) {
      errors.push({ label: "results.checks", expected: "check object", actual: check, checkIndex, ...context });
      checksValid = false;
      continue;
    }
    if (typeof check.name !== "string" || check.name.trim().length === 0 || names.has(check.name)) {
      errors.push({ label: "results.checks.name", expected: "nonempty unique check name", actual: check.name, checkIndex, ...context });
      checksValid = false;
    }
    names.add(check.name);
    if (!resultStatuses.has(check.status)) {
      errors.push({ label: "results.checks.status", expected: [...resultStatuses], actual: check.status, checkIndex, ...context });
      checksValid = false;
    }
  }

  if (checksValid) {
    const statuses = new Set(result.checks.map((check) => check.status));
    const expectedStatus = ["error", "failed", "passed", "skipped"].find((status) => statuses.has(status));
    mismatch("results.status-from-checks", expectedStatus, result.status);
  }
}

function addAdapterMetadataErrors(errors, report, adapters) {
  if (!Array.isArray(report.adapters)) {
    errors.push({ label: "adapters", expected: "array of selected adapter metadata", actual: report.adapters });
    return;
  }
  const reportedAdapters = report.adapters.filter(isObject);
  addMismatch(errors, "adapters.ids", adapters.map((adapter) => adapter.id).sort(), reportedAdapters.map((adapter) => adapter.id).sort());
  if (reportedAdapters.length !== report.adapters.length) {
    errors.push({ label: "adapters", expected: "adapter objects", actual: report.adapters });
  }
  for (const adapter of adapters) {
    const actual = reportedAdapters.find((entry) => entry.id === adapter.id);
    if (!actual) {
      continue;
    }
    if (adapter.packageName && (typeof actual.packageVersion !== "string" || actual.packageVersion.trim().length === 0)) {
      errors.push({ label: `adapters.${adapter.id}.packageVersion`, expected: "nonempty package version matching metadata.packages", actual: actual.packageVersion });
    }
    const expected = {
      name: adapter.name,
      status: adapter.status,
      required: adapter.required ?? true,
      packageName: adapter.packageName,
      packageVersion: adapter.packageName ? report.metadata?.packages?.[adapter.packageName] : adapter.packageVersion,
      lane: adapter.lane ?? defaultAdapterLanes[adapter.id],
      commandCandidates: adapter.commandCandidates
    };
    for (const [field, value] of Object.entries(expected)) {
      addMismatch(errors, `adapters.${adapter.id}.${field}`, value, actual[field]);
    }
  }
}

function addRequiredPackageErrors(errors, report, adapters) {
  const packages = report.metadata?.packages;
  if (!isObject(packages)) {
    errors.push({ label: "metadata.packages", expected: "installed package version map", actual: packages });
    return;
  }
  // Use the configured adapters and provenance contract as the authority. A
  // report cannot reduce its evidence requirements by removing its own fields.
  const requiredPackages = new Set(adapters.map((adapter) => adapter.packageName).filter(Boolean));
  if (Object.hasOwn(report.metadata, "provenance")) {
    for (const name of reportPackageNames) requiredPackages.add(name);
  }
  for (const name of requiredPackages) {
    if (!Object.hasOwn(packages, name) || typeof packages[name] !== "string" || packages[name].trim().length === 0) {
      errors.push({ label: `metadata.packages.${name}`, expected: "nonempty installed package version", actual: packages[name] });
    }
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
    renderingOutput: summary.renderingOutput,
    packageSurface: summary.packageSurface,
    coverageClaims: summary.coverageClaims,
    executed: summary.executed,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    error: summary.error
  };
}

function optionalUnavailableSkipCount(report) {
  const optionalAdapters = new Set((Array.isArray(report.adapters) ? report.adapters : [])
    .filter((adapter) => isObject(adapter) && (adapter.required === false || adapter.status === "optional"))
    .map((adapter) => adapter.id));

  return (report.results ?? []).filter((result) => {
    return optionalAdapters.has(result.adapterId) &&
      result.status === "skipped" &&
      Array.isArray(result.checks) &&
      result.checks.some((check) => isObject(check) && check.name === "availability" && check.status === "skipped");
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

  if (typeof installedSpecqr !== "string" || installedSpecqr.trim().length === 0) {
    errors.push({ label: "metadata.packages.specqr", expected: "installed specqr version", actual: installedSpecqr });
  }
  if (Object.hasOwn(target, "version")) {
    addMismatch(errors, "target.version", resolvedVersion, target.version);
  }
  const metadataTarget = report.metadata?.target;
  if (!isObject(metadataTarget)) {
    errors.push({ label: "metadata.target", expected: "target metadata object", actual: metadataTarget });
    return;
  }
  addMismatch(errors, "metadata.target.packageName", "specqr", metadataTarget.packageName);
  addMismatch(errors, "metadata.target.resolvedVersion", resolvedVersion, metadataTarget.resolvedVersion);
  addMismatch(errors, "metadata.target.source", target.source, metadataTarget.source);
  if (target.requested !== undefined) {
    addMismatch(errors, "metadata.target.requested", target.requested, metadataTarget.requested);
  }
}

function addProvenanceErrors(errors, report) {
  if (!Object.hasOwn(report.metadata ?? {}, "provenance")) {
    return; // v1 reports predating portable provenance remain readable.
  }
  const provenance = report.metadata.provenance;
  if (!isObject(provenance) || !isObject(provenance.packages)) {
    errors.push({ label: "metadata.provenance", expected: "provenance object with package evidence", actual: provenance });
    return;
  }
  const versions = report.metadata.packages ?? {};
  addMismatch(errors, "metadata.provenance.packages", Object.keys(versions).sort(), Object.keys(provenance.packages).sort());
  for (const name of new Set([...reportPackageNames, ...Object.keys(versions)])) {
    const version = versions[name];
    const evidence = provenance.packages[name];
    if (!isObject(evidence)) {
      errors.push({ label: `metadata.provenance.packages.${name}`, expected: "package evidence object", actual: evidence });
      continue;
    }
    addMismatch(errors, `metadata.provenance.packages.${name}.version`, version, evidence.version);
    if (typeof evidence.contentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(evidence.contentSha256)) {
      errors.push({ label: `metadata.provenance.packages.${name}.contentSha256`, expected: "SHA-256 content digest", actual: evidence.contentSha256 });
    }
  }
  const routing = provenance.subjectRouting;
  if (!isObject(routing)) {
    errors.push({ label: "metadata.provenance.subjectRouting", expected: "shared target routing evidence", actual: routing });
    return;
  }
  for (const [field, expected] of Object.entries({
    revision: 1,
    resolver: "shared-specqr-target",
    packageName: "specqr",
    packageVersion: versions.specqr,
    contentSha256: provenance.packages.specqr?.contentSha256
  })) {
    addMismatch(errors, `metadata.provenance.subjectRouting.${field}`, expected, routing[field]);
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

  if (Object.hasOwn(report, "semanticSha256")) {
    addMismatch(errors, "semanticSha256", semanticReportSha256(report), report.semanticSha256);
  }

  const rawFilters = report.run?.filters;
  if (!isObject(rawFilters) || ["suites", "categories", "adapters", "vectors"].some((field) => {
    return !Array.isArray(rawFilters[field]) || rawFilters[field].some((value) => typeof value !== "string" || value.trim().length === 0);
  })) {
    return { ok: false, errors: [{ label: "run.filters", expected: "arrays of nonempty string filters", actual: rawFilters }] };
  }
  const filters = normalizeFilters(rawFilters);
  addMismatch(errors, "run.mode", Object.values(filters).every((values) => values.length === 0) ? "full" : "filtered", report.run.mode);
  const suites = options.suites ?? await readSuites({ cwd });
  const adapters = options.adapters ?? activeAdapters;
  let scope;
  try {
    scope = selectRunScope(suites, adapters, filters);
  } catch (error) {
    return {
      ok: false,
      errors: [{ label: "run.filters", expected: "known filters", actual: error.message }]
    };
  }

  if (!Array.isArray(report.results) || report.results.some((result) => !isObject(result))) {
    return { ok: false, errors: [...errors, { label: "results", expected: "array of result objects", actual: report.results }] };
  }
  const results = report.results;
  const vectorsById = new Map(scope.vectors.map((vector) => [vector.id, vector]));
  const adapterIds = new Set(scope.adapters.map((adapter) => adapter.id));

  addTargetMetadataErrors(errors, report);
  addRequiredPackageErrors(errors, report, scope.adapters);
  addProvenanceErrors(errors, report);
  addAdapterMetadataErrors(errors, report, scope.adapters);

  for (const [index, result] of results.entries()) {
    const vector = vectorsById.get(result.vectorId);
    if (!vector) {
      errors.push({ label: "results.vectorId", expected: "selected vector", actual: result.vectorId });
    }
    if (!adapterIds.has(result.adapterId)) {
      errors.push({ label: "results.adapterId", expected: "selected adapter", actual: result.adapterId });
    }
    addResultErrors(errors, result, vector, index);
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

  const coverageClaims = await readCoverageClaimsFile({ cwd });
  const expectedSummary = createSummary(scope.suites, scope.vectors, scope.adapters, results, {
    coverageClaims: summarizeCoverageClaims(coverageClaims)
  });
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
  return verifyReportObject(report, { ...options, cwd });
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
