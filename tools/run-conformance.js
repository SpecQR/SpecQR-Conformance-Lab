import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import jsqrAdapter from "../adapters/jsqr.js";
import nayukiAdapter from "../adapters/nayuki.js";
import specqrAdapter from "../adapters/specqr.js";
import zbarAdapter from "../adapters/zbar.js";
import zxingCliAdapter from "../adapters/zxing-cli.js";
import { createReportMetadata } from "./report-metadata.js";

export const defaultReportPath = "reports/latest.json";
export const activeAdapters = [specqrAdapter, jsqrAdapter, nayukiAdapter, zbarAdapter, zxingCliAdapter];

const adapterReportDefaults = {
  specqr: {
    lane: "generation-planning",
    required: true
  },
  jsqr: {
    lane: "decode-readability",
    required: true
  },
  nayuki: {
    lane: "reference-matrix",
    required: true
  }
};

const defaultFilters = {
  suites: [],
  categories: [],
  adapters: [],
  vectors: []
};

export function normalizeFilters(filters = {}) {
  return {
    suites: Array.from(new Set(filters.suites ?? filters.suite ?? [])).filter(Boolean),
    categories: Array.from(new Set(filters.categories ?? filters.category ?? [])).filter(Boolean),
    adapters: Array.from(new Set(filters.adapters ?? filters.adapter ?? [])).filter(Boolean),
    vectors: Array.from(new Set(filters.vectors ?? filters.vector ?? [])).filter(Boolean)
  };
}

export function isFullRun(filters = {}) {
  const normalized = normalizeFilters(filters);
  return Object.values(normalized).every((values) => values.length === 0);
}

export function parseCliArgs(argv) {
  const options = {
    filters: { ...defaultFilters },
    outputPath: defaultReportPath,
    listSuites: false,
    listAdapters: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--list-suites":
        options.listSuites = true;
        break;
      case "--list-adapters":
        options.listAdapters = true;
        break;
      case "--suite":
      case "--category":
      case "--adapter":
      case "--vector":
      case "--output": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error(`${arg} requires a value`);
        }
        index += 1;
        if (arg === "--suite") {
          options.filters.suites.push(value);
        } else if (arg === "--category") {
          options.filters.categories.push(value);
        } else if (arg === "--adapter") {
          options.filters.adapters.push(value);
        } else if (arg === "--vector") {
          options.filters.vectors.push(value);
        } else {
          options.outputPath = value;
        }
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.filters = normalizeFilters(options.filters);
  return options;
}

export async function readSuites(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const vectorsDir = path.resolve(cwd, "vectors");
  const entries = await readdir(vectorsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const suites = [];
  for (const fileName of files) {
    const file = path.join("vectors", fileName);
    const suite = JSON.parse(await readFile(path.join(vectorsDir, fileName), "utf8"));
    suites.push({ file, ...suite });
  }

  return suites;
}

export function suiteVectors(suites) {
  return suites.flatMap((suite) => {
    return (Array.isArray(suite.vectors) ? suite.vectors : []).map((vector) => ({
      suiteFile: suite.file,
      suiteId: suite.id,
      suiteCategory: suite.category,
      ...vector
    }));
  });
}

function assertKnownFilters(filters, suites, vectors, adapters) {
  const suiteIds = new Set(suites.map((suite) => suite.id));
  const categories = new Set(vectors.map((vector) => vector.category));
  const vectorIds = new Set(vectors.map((vector) => vector.id));
  const adapterIds = new Set(adapters.map((adapter) => adapter.id));

  for (const suiteId of filters.suites) {
    if (!suiteIds.has(suiteId)) {
      throw new Error(`Unknown suite: ${suiteId}`);
    }
  }

  for (const category of filters.categories) {
    if (!categories.has(category)) {
      throw new Error(`Unknown category: ${category}`);
    }
  }

  for (const vectorId of filters.vectors) {
    if (!vectorIds.has(vectorId)) {
      throw new Error(`Unknown vector: ${vectorId}`);
    }
  }

  for (const adapterId of filters.adapters) {
    if (!adapterIds.has(adapterId)) {
      throw new Error(`Unknown adapter: ${adapterId}`);
    }
  }
}

export function selectRunScope(suites, adapters, filters = {}) {
  const normalized = normalizeFilters(filters);
  const allVectors = suiteVectors(suites);
  assertKnownFilters(normalized, suites, allVectors, adapters);

  const selectedVectors = allVectors.filter((vector) => {
    if (normalized.suites.length > 0 && !normalized.suites.includes(vector.suiteId)) {
      return false;
    }
    if (normalized.categories.length > 0 && !normalized.categories.includes(vector.category)) {
      return false;
    }
    if (normalized.vectors.length > 0 && !normalized.vectors.includes(vector.id)) {
      return false;
    }
    return true;
  });

  if (selectedVectors.length === 0) {
    throw new Error("Filters selected no vectors");
  }

  const selectedVectorIds = new Set(selectedVectors.map((vector) => vector.id));
  const selectedSuites = suites
    .map((suite) => {
      const vectors = (suite.vectors ?? []).filter((vector) => selectedVectorIds.has(vector.id));
      return {
        ...suite,
        vectors
      };
    })
    .filter((suite) => suite.vectors.length > 0);

  const selectedAdapters = normalized.adapters.length > 0
    ? adapters.filter((adapter) => normalized.adapters.includes(adapter.id))
    : adapters;

  if (selectedAdapters.length === 0) {
    throw new Error("Filters selected no adapters");
  }

  return {
    filters: normalized,
    suites: selectedSuites,
    vectors: selectedVectors,
    adapters: selectedAdapters
  };
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = item[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function createStatusCounts(results) {
  const counts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    error: 0
  };

  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }

  return counts;
}

function createAdapterSummary(adapter, results) {
  const adapterResults = results.filter((result) => result.adapterId === adapter.id);
  const statusCounts = createStatusCounts(adapterResults);
  return {
    id: adapter.id,
    name: adapter.name,
    status: adapter.status,
    total: adapterResults.length,
    executed: adapterResults.filter((result) => result.status !== "skipped").length,
    ...statusCounts
  };
}

function createScopedSummary(vectors, results, adapters, predicate) {
  const scopedVectors = vectors.filter((vector) => predicate(vector.category));
  const scopedResults = results.filter((result) => predicate(result.category));
  const statusCounts = createStatusCounts(scopedResults);
  const adapterSummary = Object.fromEntries(
    adapters.map((activeAdapter) => {
      const adapterResults = scopedResults.filter((result) => result.adapterId === activeAdapter.id);
      const adapterStatusCounts = createStatusCounts(adapterResults);
      return [
        activeAdapter.id,
        {
          id: activeAdapter.id,
          name: activeAdapter.name,
          total: adapterResults.length,
          executed: adapterResults.filter((result) => result.status !== "skipped").length,
          ...adapterStatusCounts
        }
      ];
    })
  );

  return {
    categories: countBy(scopedVectors, "category"),
    operations: countBy(scopedVectors, "operation"),
    vectorCount: scopedVectors.length,
    resultCount: scopedResults.length,
    executed: scopedResults.filter((result) => result.status !== "skipped").length,
    ...statusCounts,
    adapterSummary
  };
}

function isGs1DigitalLinkCategory(category) {
  return category === "gs1" || category === "gs1-digital-link";
}

function isStructuredAppendCategory(category) {
  return category === "structured-append";
}

function isPlanningDiagnosticsCategory(category) {
  return category === "planning-diagnostics";
}

function isKanjiEciBinaryCategory(category) {
  return category === "kanji-eci-binary";
}

export function createSummary(suites, vectors, adapters, results) {
  const statusCounts = createStatusCounts(results);
  const adapterSummary = Object.fromEntries(
    adapters.map((activeAdapter) => [
      activeAdapter.id,
      createAdapterSummary(activeAdapter, results)
    ])
  );

  return {
    suiteCount: suites.length,
    totalVectors: vectors.length,
    totalResults: results.length,
    categories: countBy(vectors, "category"),
    operations: countBy(vectors, "operation"),
    adapterSummary,
    gs1DigitalLink: createScopedSummary(vectors, results, adapters, isGs1DigitalLinkCategory),
    structuredAppend: createScopedSummary(vectors, results, adapters, isStructuredAppendCategory),
    planningDiagnostics: createScopedSummary(vectors, results, adapters, isPlanningDiagnosticsCategory),
    kanjiEciBinary: createScopedSummary(vectors, results, adapters, isKanjiEciBinaryCategory),
    executed: results.filter((result) => result.status !== "skipped").length,
    passed: statusCounts.passed,
    failed: statusCounts.failed,
    skipped: statusCounts.skipped,
    error: statusCounts.error
  };
}

function createAdapterReportMetadata(activeAdapter, metadata) {
  const defaults = adapterReportDefaults[activeAdapter.id] ?? {};
  const packageVersion = activeAdapter.packageName ? metadata.packages[activeAdapter.packageName] : activeAdapter.packageVersion;

  return {
    id: activeAdapter.id,
    name: activeAdapter.name,
    packageName: activeAdapter.packageName,
    packageVersion,
    status: activeAdapter.status,
    lane: activeAdapter.lane ?? defaults.lane,
    required: activeAdapter.required ?? defaults.required ?? true,
    ...(Array.isArray(activeAdapter.commandCandidates) ? { commandCandidates: activeAdapter.commandCandidates } : {})
  };
}

function suiteReportMetadata(suite) {
  return {
    file: suite.file,
    id: suite.id,
    name: suite.name,
    description: suite.description,
    category: suite.category,
    vectorCount: Array.isArray(suite.vectors) ? suite.vectors.length : 0
  };
}

function relativeOutputPath(outputPath, cwd = process.cwd()) {
  const absoluteOutputPath = path.resolve(cwd, outputPath);
  return path.relative(cwd, absoluteOutputPath) || ".";
}

export async function createConformanceReport(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const allSuites = options.suites ?? await readSuites({ cwd });
  const filters = normalizeFilters(options.filters);
  const scope = selectRunScope(allSuites, options.adapters ?? activeAdapters, filters);
  const metadata = await createReportMetadata(options.metadataOptions);

  const results = [];
  for (const vector of scope.vectors) {
    for (const activeAdapter of scope.adapters) {
      const adapterResult = await activeAdapter.run(vector);
      results.push({
        suiteId: vector.suiteId,
        vectorId: vector.id,
        title: vector.title,
        adapterId: activeAdapter.id,
        category: vector.category,
        operation: vector.operation,
        status: adapterResult.status,
        checks: adapterResult.checks ?? [],
        ...(adapterResult.reason ? { reason: adapterResult.reason } : {}),
        ...(adapterResult.error ? { error: adapterResult.error } : {}),
        ...(adapterResult.details ? { details: adapterResult.details } : {})
      });
    }
  }

  const outputPath = options.outputPath ?? defaultReportPath;
  const report = {
    schemaVersion: 1,
    labVersion: "0.1.0",
    status: "executed",
    metadata,
    run: {
      mode: isFullRun(scope.filters) ? "full" : "filtered",
      filters: scope.filters,
      outputPath: relativeOutputPath(outputPath, cwd)
    },
    target: {
      name: metadata.target?.packageName ?? "specqr",
      requested: metadata.target?.requested ?? `specqr@${metadata.packages.specqr}`,
      resolvedVersion: metadata.target?.resolvedVersion ?? metadata.packages.specqr,
      version: metadata.target?.resolvedVersion ?? metadata.packages.specqr,
      source: metadata.target?.source ?? "npm"
    },
    adapters: scope.adapters.map((activeAdapter) => createAdapterReportMetadata(activeAdapter, metadata)),
    suites: scope.suites.map(suiteReportMetadata),
    summary: createSummary(scope.suites, scope.vectors, scope.adapters, results),
    results
  };

  return {
    ok: true,
    report,
    outputPath: path.resolve(cwd, outputPath),
    filters: scope.filters,
    vectors: scope.vectors,
    suites: scope.suites,
    adapters: scope.adapters
  };
}

export async function runConformance(options = {}) {
  const result = await createConformanceReport(options);
  const writeReport = options.writeReport ?? true;
  if (writeReport) {
    await mkdir(path.dirname(result.outputPath), { recursive: true });
    await writeFile(result.outputPath, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");
  }
  return result;
}

export async function listSuites(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const suites = options.suites ?? await readSuites({ cwd });
  const filters = normalizeFilters(options.filters);
  const scope = selectRunScope(suites, activeAdapters, {
    suites: filters.suites,
    categories: filters.categories,
    vectors: filters.vectors
  });

  return {
    ok: true,
    mode: isFullRun(filters) ? "full" : "filtered",
    filters,
    suites: scope.suites.map(suiteReportMetadata)
  };
}

export async function listAdapters(options = {}) {
  const filters = normalizeFilters(options.filters);
  const selectedAdapters = filters.adapters.length > 0
    ? activeAdapters.filter((adapter) => filters.adapters.includes(adapter.id))
    : activeAdapters;
  const unknownAdapters = filters.adapters.filter((adapterId) => !activeAdapters.some((adapter) => adapter.id === adapterId));
  if (unknownAdapters.length > 0) {
    throw new Error(`Unknown adapter: ${unknownAdapters.join(", ")}`);
  }
  const metadata = await createReportMetadata(options.metadataOptions);

  return {
    ok: true,
    mode: isFullRun(filters) ? "full" : "filtered",
    filters,
    adapters: selectedAdapters.map((adapter) => createAdapterReportMetadata(adapter, metadata))
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const cliOptions = parseCliArgs(argv);

  if (cliOptions.listSuites || cliOptions.listAdapters) {
    const result = {
      ok: true,
      mode: isFullRun(cliOptions.filters) ? "full" : "filtered",
      filters: cliOptions.filters
    };
    if (cliOptions.listSuites) {
      result.suites = (await listSuites({ cwd, filters: cliOptions.filters })).suites;
    }
    if (cliOptions.listAdapters) {
      result.adapters = (await listAdapters({ cwd, filters: cliOptions.filters })).adapters;
    }
    printJson(result);
    return result;
  }

  const result = await runConformance({
    cwd,
    filters: cliOptions.filters,
    outputPath: cliOptions.outputPath
  });
  const statusCounts = createStatusCounts(result.report.results);
  const output = {
    ok: true,
    report: relativeOutputPath(result.outputPath, cwd),
    mode: result.report.run.mode,
    filters: result.report.run.filters,
    adapters: result.adapters.map((adapter) => adapter.id),
    vectorCount: result.report.summary.totalVectors,
    resultCount: result.report.summary.totalResults,
    executed: result.report.summary.executed,
    ...statusCounts
  };
  printJson(output);
  return output;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    await runCli();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message
    }, null, 2));
    process.exitCode = 1;
  }
}
