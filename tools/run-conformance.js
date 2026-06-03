import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import jsqrAdapter from "../adapters/jsqr.js";
import nayukiAdapter from "../adapters/nayuki.js";
import specqrAdapter from "../adapters/specqr.js";
import zbarAdapter from "../adapters/zbar.js";
import zxingCliAdapter from "../adapters/zxing-cli.js";
import { createReportMetadata } from "./report-metadata.js";

const vectorsDir = path.resolve("vectors");
const reportPath = path.resolve("reports/latest.json");
const activeAdapters = [specqrAdapter, jsqrAdapter, nayukiAdapter, zbarAdapter, zxingCliAdapter];

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

async function readSuites() {
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

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = item[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function createStatusCounts(results) {
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

function createAdapterSummary(adapter, vectors, results) {
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

function createScopedSummary(vectors, results, predicate) {
  const scopedVectors = vectors.filter((vector) => predicate(vector.category));
  const scopedResults = results.filter((result) => predicate(result.category));
  const statusCounts = createStatusCounts(scopedResults);
  const adapterSummary = Object.fromEntries(
    activeAdapters.map((activeAdapter) => {
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

function createGs1DigitalLinkSummary(vectors, results) {
  return createScopedSummary(vectors, results, isGs1DigitalLinkCategory);
}

function isStructuredAppendCategory(category) {
  return category === "structured-append";
}

function createStructuredAppendSummary(vectors, results) {
  return createScopedSummary(vectors, results, isStructuredAppendCategory);
}

function isPlanningDiagnosticsCategory(category) {
  return category === "planning-diagnostics";
}

function createPlanningDiagnosticsSummary(vectors, results) {
  return createScopedSummary(vectors, results, isPlanningDiagnosticsCategory);
}

function isKanjiEciBinaryCategory(category) {
  return category === "kanji-eci-binary";
}

function createKanjiEciBinarySummary(vectors, results) {
  return createScopedSummary(vectors, results, isKanjiEciBinaryCategory);
}

const suites = await readSuites();
const vectors = suites.flatMap((suite) => {
  return (Array.isArray(suite.vectors) ? suite.vectors : []).map((vector) => ({
    suiteFile: suite.file,
    suiteId: suite.id,
    suiteCategory: suite.category,
    ...vector
  }));
});

const results = [];
for (const vector of vectors) {
  for (const activeAdapter of activeAdapters) {
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

const statusCounts = createStatusCounts(results);
const adapterSummary = Object.fromEntries(
  activeAdapters.map((activeAdapter) => [
    activeAdapter.id,
    createAdapterSummary(activeAdapter, vectors, results)
  ])
);
const metadata = await createReportMetadata();

function createAdapterReportMetadata(activeAdapter) {
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

const report = {
  schemaVersion: 1,
  labVersion: "0.1.0",
  status: "executed",
  metadata,
  target: {
    name: "specqr",
    version: metadata.packages.specqr,
    source: "npm"
  },
  adapters: activeAdapters.map(createAdapterReportMetadata),
  suites: suites.map((suite) => ({
    file: suite.file,
    id: suite.id,
    name: suite.name,
    description: suite.description,
    category: suite.category,
    vectorCount: Array.isArray(suite.vectors) ? suite.vectors.length : 0
  })),
  summary: {
    suiteCount: suites.length,
    totalVectors: vectors.length,
    totalResults: results.length,
    categories: countBy(vectors, "category"),
    operations: countBy(vectors, "operation"),
    adapterSummary,
    gs1DigitalLink: createGs1DigitalLinkSummary(vectors, results),
    structuredAppend: createStructuredAppendSummary(vectors, results),
    planningDiagnostics: createPlanningDiagnosticsSummary(vectors, results),
    kanjiEciBinary: createKanjiEciBinarySummary(vectors, results),
    executed: results.filter((result) => result.status !== "skipped").length,
    passed: statusCounts.passed,
    failed: statusCounts.failed,
    skipped: statusCounts.skipped,
    error: statusCounts.error
  },
  results
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  ok: true,
  report: "reports/latest.json",
  adapters: activeAdapters.map((adapter) => adapter.id),
  vectorCount: vectors.length,
  resultCount: results.length,
  executed: report.summary.executed,
  ...statusCounts
}, null, 2));
