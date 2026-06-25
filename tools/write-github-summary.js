import { appendFile, readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const defaultSummaryReportPath = "reports/latest.json";
export const defaultPagesUrl = "https://specqr.github.io/SpecQR-Conformance-Lab/";

const keyScopes = [
  ["GS1 / DL", "gs1DigitalLink"],
  ["Structured Append", "structuredAppend"],
  ["Planning / Diagnostics", "planningDiagnostics"],
  ["Kanji / ECI / binary", "kanjiEciBinary"],
  ["Rendering / Output", "renderingOutput"],
  ["Package Surface", "packageSurface"]
];

function count(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function adapterRequirement(adapter) {
  return adapter.required === false ? "optional" : "required";
}

function commandCandidates(adapter) {
  return Array.isArray(adapter.commandCandidates) && adapter.commandCandidates.length > 0
    ? adapter.commandCandidates.join(", ")
    : "-";
}

function formatFilters(run = {}) {
  const filters = run.filters ?? {};
  const parts = [
    ["suite", filters.suites],
    ["category", filters.categories],
    ["adapter", filters.adapters],
    ["vector", filters.vectors]
  ].flatMap(([label, values]) => {
    return Array.isArray(values) && values.length > 0
      ? [`${label}=${values.join(",")}`]
      : [];
  });

  return parts.length > 0 ? parts.join(" / ") : "なし";
}

function statusLine(summary = {}) {
  return [
    `passed ${count(summary.passed)}`,
    `failed ${count(summary.failed)}`,
    `error ${count(summary.error)}`,
    `skipped ${count(summary.skipped)}`
  ].join(" / ");
}

function targetRequested(target = {}) {
  return target.requested ?? `${target.name ?? "specqr"}@${target.version ?? target.resolvedVersion ?? "unknown"}`;
}

function targetResolved(target = {}) {
  return `${target.name ?? "specqr"}@${target.resolvedVersion ?? target.version ?? "unknown"}`;
}

function resultCountRows(counts = {}) {
  return [
    count(counts.total ?? counts.totalResults ?? counts.resultCount),
    count(counts.executed),
    count(counts.passed),
    count(counts.failed),
    count(counts.error),
    count(counts.skipped)
  ];
}

function adapterSummaryRows(report) {
  const adapters = Array.isArray(report.adapters) ? report.adapters : [];
  const adapterSummary = report.summary?.adapterSummary ?? {};

  return adapters.map((adapter) => {
    const counts = adapterSummary[adapter.id] ?? {};
    return [
      adapter.id,
      adapterRequirement(adapter),
      adapter.status ?? "active",
      ...resultCountRows(counts)
    ];
  });
}

function scopeSummaryRows(report) {
  const summary = report.summary ?? {};
  return keyScopes.map(([label, key]) => {
    const scope = summary[key] ?? {};
    return [
      label,
      count(scope.vectorCount),
      ...resultCountRows(scope)
    ];
  });
}

function availabilitySkipCount(report, adapterId) {
  return (Array.isArray(report.results) ? report.results : [])
    .filter((result) => {
      return result.adapterId === adapterId
        && result.status === "skipped"
        && Array.isArray(result.checks)
        && result.checks.some((check) => check.name === "availability" && check.status === "skipped");
    })
    .length;
}

function optionalDecoderRows(report) {
  const adapters = Array.isArray(report.adapters) ? report.adapters : [];
  const adapterSummary = report.summary?.adapterSummary ?? {};
  return adapters
    .filter((adapter) => {
      return adapter.required === false
        || adapter.status === "optional"
        || adapter.lane === "optional-decode-readability";
    })
    .map((adapter) => {
      const counts = adapterSummary[adapter.id] ?? {};
      return [
        adapter.id,
        commandCandidates(adapter),
        availabilitySkipCount(report, adapter.id),
        count(counts.skipped),
        count(counts.executed)
      ];
    });
}

function table(headers, rows) {
  const header = `| ${headers.map(markdownCell).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

export function renderGithubSummary(report, options = {}) {
  const summary = report.summary ?? {};
  const target = report.target ?? {};
  const run = report.run ?? {};
  const pagesUrl = options.pagesUrl || defaultPagesUrl;
  const generatedAt = report.metadata?.generatedAt;

  const lines = [
    "# SpecQR Conformance Summary",
    "",
    `- 対象 requested: \`${targetRequested(target)}\``,
    `- 対象 resolved: \`${targetResolved(target)}\` (\`${target.source ?? "unknown"}\`)`,
    `- 実行: \`${run.mode ?? "full"}\` / filters: ${formatFilters(run)}`,
    `- Vectors: ${count(summary.totalVectors)} / Results: ${count(summary.totalResults)} / Executed: ${count(summary.executed)}`,
    `- Status: ${statusLine(summary)}`,
    `- Pages: [latest report](${pagesUrl})`,
    generatedAt ? `- Generated at: \`${generatedAt}\`` : null,
    "",
    "## Adapter summary",
    "",
    table(
      ["Adapter", "Required", "Status", "Results", "Executed", "Passed", "Failed", "Error", "Skipped"],
      adapterSummaryRows(report)
    ),
    "",
    "## Key suite summary",
    "",
    table(
      ["Scope", "Vectors", "Results", "Executed", "Passed", "Failed", "Error", "Skipped"],
      scopeSummaryRows(report)
    ),
    "",
    "## Optional decoder availability",
    "",
    table(
      ["Adapter", "Candidates", "Availability skips", "Total skips", "Executed"],
      optionalDecoderRows(report)
    )
  ].filter((line) => line !== null);

  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = {
    reportPath: defaultSummaryReportPath,
    pagesUrl: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--report":
      case "--pages-url": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error(`${arg} requires a value`);
        }
        index += 1;
        if (arg === "--report") {
          options.reportPath = value;
        } else {
          options.pagesUrl = value;
        }
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export async function writeGithubSummary(options = {}) {
  const reportPath = options.reportPath ?? defaultSummaryReportPath;
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const markdown = renderGithubSummary(report, {
    pagesUrl: options.pagesUrl || env.SPECQR_PAGES_URL || defaultPagesUrl
  });

  stdout.write(markdown);

  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  }

  return {
    ok: true,
    report: reportPath,
    wroteStepSummary: Boolean(env.GITHUB_STEP_SUMMARY),
    markdown
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    await writeGithubSummary(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message
    }, null, 2));
    process.exitCode = 1;
  }
}
