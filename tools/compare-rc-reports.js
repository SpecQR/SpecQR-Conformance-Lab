import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createCheck, deepEqual, sha256, stableStringify, statusCounts, writeJson, writeText } from "./rc-utils.js";

export const rcComparisonNormalizations = [
  "generatedAt、runtime、report output path は実行 provenance として比較対象外",
  "target.requested、target.resolvedVersion、target.version、metadata.packages.specqr、adapter packageVersion は target identity として比較対象外",
  "package.metadata.published-surface の metadata.version は target identity として比較対象外",
  "manual Structured Append diagnostics の splitUnits、splitUnitsDetail、splitUnitCount は v3 candidate contract で別途 required 検証"
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripV3Diagnostics(value) {
  if (Array.isArray(value)) {
    value.forEach(stripV3Diagnostics);
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const child of Object.values(value)) {
    stripV3Diagnostics(child);
  }
  if (value.splitStrategy === "segment-boundary-byte-chunk") {
    delete value.splitUnits;
    delete value.splitUnitsDetail;
    delete value.splitUnitCount;
  }
}

export function normalizeRcResult(result) {
  const normalized = clone(result);
  if (normalized.vectorId === "package.metadata.published-surface") {
    delete normalized.details?.packageSurface?.metadata?.version;
  }
  if (normalized.operation === "structuredAppend.generateSegments") {
    stripV3Diagnostics(normalized.details);
  }
  return normalized;
}

function resultKey(result) {
  return `${result.vectorId}\u0000${result.adapterId}`;
}

function checkEntries(checks = []) {
  const counts = new Map();
  return checks.map((check) => {
    const index = counts.get(check.name) ?? 0;
    counts.set(check.name, index + 1);
    return [`${check.name}#${index}`, check];
  });
}

function adapterComparable(adapter) {
  const normalized = clone(adapter);
  if (normalized.id === "specqr") {
    delete normalized.packageVersion;
  }
  return normalized;
}

function summaryComparable(summary) {
  return clone(summary);
}

function addBlocking(blocking, kind, key, base, candidate) {
  blocking.push({ kind, key, base, candidate });
}

function compactValue(value) {
  const serialized = stableStringify(value);
  if (serialized.length <= 600) {
    return value;
  }
  return {
    type: Array.isArray(value) ? "array" : typeof value,
    length: Array.isArray(value) ? value.length : undefined,
    sha256: sha256(serialized)
  };
}

function valueDifferences(base, candidate, currentPath = "$", output = []) {
  if (output.length >= 40 || deepEqual(base, candidate)) {
    return output;
  }
  if (Array.isArray(base) && Array.isArray(candidate)) {
    if (base.length !== candidate.length) {
      output.push({ path: `${currentPath}.length`, base: base.length, candidate: candidate.length });
    }
    for (let index = 0; index < Math.min(base.length, candidate.length); index += 1) {
      valueDifferences(base[index], candidate[index], `${currentPath}[${index}]`, output);
    }
    if (base.length > candidate.length) {
      output.push({ path: `${currentPath}[${candidate.length}]`, base: compactValue(base[candidate.length]), candidate: null });
    } else if (candidate.length > base.length) {
      output.push({ path: `${currentPath}[${base.length}]`, base: null, candidate: compactValue(candidate[base.length]) });
    }
    return output;
  }
  if (base && candidate && typeof base === "object" && typeof candidate === "object" && !Array.isArray(base) && !Array.isArray(candidate)) {
    for (const key of Array.from(new Set([...Object.keys(base), ...Object.keys(candidate)])).sort()) {
      if (!Object.hasOwn(base, key) || !Object.hasOwn(candidate, key)) {
        output.push({
          path: `${currentPath}.${key}`,
          base: Object.hasOwn(base, key) ? compactValue(base[key]) : null,
          candidate: Object.hasOwn(candidate, key) ? compactValue(candidate[key]) : null
        });
      } else {
        valueDifferences(base[key], candidate[key], `${currentPath}.${key}`, output);
      }
      if (output.length >= 40) {
        break;
      }
    }
    return output;
  }
  output.push({ path: currentPath, base: compactValue(base), candidate: compactValue(candidate) });
  return output;
}

function adapterSkipCounts(report) {
  return Object.fromEntries((report.adapters ?? []).map((adapter) => {
    const skipped = (report.results ?? []).filter((result) => {
      return result.adapterId === adapter.id && result.status === "skipped";
    }).length;
    return [adapter.id, { required: adapter.required !== false, skipped }];
  }));
}

export function compareRcReports(base, candidate, options = {}) {
  const blocking = [];
  const changes = [];
  const baseResults = new Map((base.results ?? []).map((result) => [resultKey(result), result]));
  const candidateResults = new Map((candidate.results ?? []).map((result) => [resultKey(result), result]));
  const requiredAdapters = new Set((base.adapters ?? [])
    .filter((adapter) => adapter.required !== false)
    .map((adapter) => adapter.id));

  for (const [key, baseResult] of baseResults) {
    const candidateResult = candidateResults.get(key);
    if (!candidateResult) {
      addBlocking(blocking, "missing-result", key, baseResult.status, null);
      continue;
    }

    if (baseResult.status !== candidateResult.status) {
      changes.push({ kind: "result-status", key, base: baseResult.status, candidate: candidateResult.status });
      if (["failed", "error"].includes(candidateResult.status) && baseResult.status !== candidateResult.status) {
        addBlocking(blocking, "new-failed-or-error", key, baseResult.status, candidateResult.status);
      } else if (requiredAdapters.has(baseResult.adapterId) && candidateResult.status === "skipped") {
        addBlocking(blocking, "required-adapter-skip", key, baseResult.status, candidateResult.status);
      }
    }

    const candidateChecks = new Map(checkEntries(candidateResult.checks));
    for (const [checkKey, baseCheck] of checkEntries(baseResult.checks)) {
      const candidateCheck = candidateChecks.get(checkKey);
      if (!candidateCheck) {
        addBlocking(blocking, "missing-required-check", `${key}\u0000${checkKey}`, baseCheck.status, null);
      } else if (baseCheck.status !== candidateCheck.status) {
        changes.push({
          kind: "check-status",
          key: `${key}\u0000${checkKey}`,
          base: baseCheck.status,
          candidate: candidateCheck.status
        });
        if (baseCheck.status === "passed" || ["failed", "error"].includes(candidateCheck.status)) {
          addBlocking(
            blocking,
            "required-check-status",
            `${key}\u0000${checkKey}`,
            baseCheck.status,
            candidateCheck.status
          );
        }
      }
    }

    const normalizedBase = normalizeRcResult(baseResult);
    const normalizedCandidate = normalizeRcResult(candidateResult);
    if (!deepEqual(normalizedBase, normalizedCandidate)) {
      changes.push({
        kind: "normalized-result",
        key,
        baseFingerprint: sha256(stableStringify(normalizedBase)),
        candidateFingerprint: sha256(stableStringify(normalizedCandidate)),
        differences: valueDifferences(normalizedBase, normalizedCandidate)
      });
      if (baseResult.status !== "skipped" || requiredAdapters.has(baseResult.adapterId)) {
        addBlocking(
          blocking,
          "matrix-renderer-helper-or-result-change",
          key,
          sha256(stableStringify(normalizedBase)),
          sha256(stableStringify(normalizedCandidate))
        );
      }
    }
  }

  for (const [key, candidateResult] of candidateResults) {
    if (!baseResults.has(key)) {
      addBlocking(blocking, "unexpected-result", key, null, candidateResult.status);
    }
  }

  const baseSkips = adapterSkipCounts(base);
  const candidateSkips = adapterSkipCounts(candidate);
  for (const [adapterId, counts] of Object.entries(baseSkips)) {
    const candidateCount = candidateSkips[adapterId]?.skipped;
    if (counts.required && Number.isInteger(candidateCount) && candidateCount > counts.skipped) {
      addBlocking(blocking, "required-adapter-skip-increase", adapterId, counts.skipped, candidateCount);
    }
  }

  const baseAdapters = (base.adapters ?? []).map(adapterComparable);
  const candidateAdapters = (candidate.adapters ?? []).map(adapterComparable);
  if (!deepEqual(baseAdapters, candidateAdapters)) {
    addBlocking(blocking, "adapter-contract-change", "adapters", baseAdapters, candidateAdapters);
  }
  if (!deepEqual(base.suites ?? [], candidate.suites ?? [])) {
    addBlocking(blocking, "suite-contract-change", "suites", base.suites ?? [], candidate.suites ?? []);
  }
  if (!deepEqual(summaryComparable(base.summary), summaryComparable(candidate.summary))) {
    addBlocking(blocking, "summary-change", "summary", base.summary, candidate.summary);
  }

  const deduplicated = Array.from(new Map(blocking.map((item) => [
    `${item.kind}\u0000${item.key}`,
    item
  ])).values());
  const checks = [
    createCheck("base-result-coverage", baseResults.size > 0, { resultCount: baseResults.size }),
    createCheck("candidate-result-coverage", candidateResults.size === baseResults.size, {
      expected: baseResults.size,
      actual: candidateResults.size
    }),
    createCheck("blocking-regression", deduplicated.length === 0, { count: deduplicated.length })
  ];
  const counts = statusCounts(checks);
  return {
    schemaVersion: 1,
    kind: options.kind ?? "specqr-rc-common-comparison",
    base: {
      requested: base.target?.requested,
      resolvedVersion: base.target?.resolvedVersion ?? base.target?.version
    },
    candidate: {
      requested: candidate.target?.requested,
      resolvedVersion: candidate.target?.resolvedVersion ?? candidate.target?.version
    },
    commonResultCount: baseResults.size,
    requiredAdapters: Array.from(requiredAdapters).sort(),
    normalizations: rcComparisonNormalizations,
    adapterSkips: {
      base: baseSkips,
      candidate: candidateSkips
    },
    changes,
    blockingRegressions: deduplicated,
    checks,
    summary: counts,
    status: counts.failed === 0 ? "pass" : "blocked"
  };
}

function markdownTable(rows) {
  const body = rows.length > 0 ? rows : [["none", "none", "-", "-"]];
  return [
    "| Kind | Key | Base | Candidate |",
    "| --- | --- | --- | --- |",
    ...body.map((row) => `| ${row.map((value) => String(value).replaceAll("|", "\\|")).join(" | ")} |`)
  ].join("\n");
}

export function renderRcComparisonMarkdown(comparison) {
  const regressions = comparison.blockingRegressions.map((entry) => [
    entry.kind,
    entry.key.replaceAll("\u0000", " / "),
    typeof entry.base === "object" ? "object" : entry.base,
    typeof entry.candidate === "object" ? "object" : entry.candidate
  ]);
  return `# SpecQR RC Strict Comparison

- Base: \`${comparison.base.requested}\` -> \`${comparison.base.resolvedVersion}\`
- Candidate: \`${comparison.candidate.requested}\` -> \`${comparison.candidate.resolvedVersion}\`
- Common results: ${comparison.commonResultCount}
- Status: **${comparison.status}**
- Blocking regressions: ${comparison.blockingRegressions.length}

## Normalization

${comparison.normalizations.map((rule) => `- ${rule}`).join("\n")}

## Blocking regressions

${markdownTable(regressions)}
`;
}

export async function compareRcReportFiles(options) {
  const base = JSON.parse(await readFile(options.basePath, "utf8"));
  const candidate = JSON.parse(await readFile(options.candidatePath, "utf8"));
  const comparison = compareRcReports(base, candidate, { kind: options.kind });
  if (options.jsonOutputPath) {
    await writeJson(options.jsonOutputPath, comparison);
  }
  if (options.markdownOutputPath) {
    await writeText(options.markdownOutputPath, renderRcComparisonMarkdown(comparison));
  }
  return comparison;
}

function parseArgs(argv) {
  const options = {};
  const fields = new Map([
    ["--base", "basePath"],
    ["--candidate", "candidatePath"],
    ["--json-output", "jsonOutputPath"],
    ["--markdown-output", "markdownOutputPath"],
    ["--kind", "kind"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) {
      throw new Error(`Invalid strict comparison argument: ${argv[index]}`);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  if (!options.basePath || !options.candidatePath) {
    throw new Error("Strict comparison requires --base and --candidate");
  }
  return options;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await compareRcReportFiles(options);
    if (!options.markdownOutputPath) {
      process.stderr.write(renderRcComparisonMarkdown(result));
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
