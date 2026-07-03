import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  allCoverageClaims,
  readCoverageClaimsFile,
  summarizeCoverageClaims
} from "./coverage-claims.js";
import { createBadgeSet, normalizeCounts, summarizeStatus } from "./report-utils.js";

const jsonReportPath = path.resolve("reports/latest.json");
const htmlReportPath = path.resolve("reports/latest.html");
const badgeDir = path.resolve("badges");
const publicBaseUrl = "https://specqr.github.io/SpecQR-Conformance-Lab";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slug(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown";
}

function anchorId(prefix, value) {
  return `${prefix}-${slug(value)}`;
}

function publicUrl(relativePath) {
  return `${publicBaseUrl}/${String(relativePath).replace(/^\/+/, "")}`;
}

function publicLink(relativePath, label = relativePath) {
  return `<a href="${escapeHtml(publicUrl(relativePath))}">${escapeHtml(label)}</a>`;
}

function localAnchorLink(id, label) {
  return `<a href="#${escapeHtml(id)}">${escapeHtml(label)}</a>`;
}

async function readReport() {
  try {
    return JSON.parse(await readFile(jsonReportPath, "utf8"));
  } catch {
    return {
      schemaVersion: 1,
      labVersion: "0.1.0",
      status: "placeholder",
      metadata: {
        generatedAt: "",
        runtime: {},
        packages: {}
      },
      run: {
        mode: "full",
        filters: {
          suites: [],
          categories: [],
          adapters: [],
          vectors: []
        },
        outputPath: "reports/latest.json"
      },
      target: {
        name: "specqr",
        requested: "specqr@2.4.0",
        resolvedVersion: "2.4.0",
        version: "2.4.0",
        source: "npm"
      },
      adapters: [],
      suites: [],
      summary: {
        suiteCount: 0,
        totalVectors: 0,
        totalResults: 0,
        categories: {},
        operations: {},
        adapterSummary: {},
        gs1DigitalLink: {},
        structuredAppend: {},
        planningDiagnostics: {},
        kanjiEciBinary: {},
        renderingOutput: {},
        packageSurface: {},
        coverageClaims: summarizeCoverageClaims(),
        executed: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        error: 0
      },
      results: []
    };
  }
}

function objectRows(object) {
  return Object.entries(object ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `      <tr><td>${escapeHtml(key)}</td><td>${escapeHtml(count)}</td></tr>`)
    .join("\n");
}

function checkSummary(checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return "";
  }

  return checks.map((check) => `${check.name}: ${check.status}`).join(", ");
}

function renderAdapterResultRows(results, adapterId) {
  return results
    .filter((result) => result.adapterId === adapterId)
    .map((result) => {
      return `      <tr><td>${escapeHtml(result.vectorId)}</td><td>${escapeHtml(result.operation)}</td><td>${escapeHtml(result.status)}</td><td>${escapeHtml(checkSummary(result.checks))}</td><td>${escapeHtml(result.reason ?? "")}</td></tr>`;
    })
    .join("\n");
}

function countTableRows(counts, options = {}) {
  const normalized = normalizeCounts(counts);
  const rows = [];

  if (options.vectorCount) {
    rows.push(["Vectors", counts?.vectorCount ?? 0]);
  }

  if (options.resultCount) {
    rows.push(["Results", counts?.resultCount ?? counts?.totalResults ?? counts?.total ?? 0]);
  }

  rows.push(
    ["実行", normalized.executed],
    ["成功", normalized.passed],
    ["失敗", normalized.failed],
    ["スキップ", normalized.skipped],
    ["エラー", normalized.error]
  );

  return rows
    .map(([label, value]) => `      <tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("\n");
}

function statusBand(title, subtitle, counts) {
  const status = summarizeStatus(counts);
  const normalized = normalizeCounts(counts);

  return `    <section class="status-band status-${status.color}">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(subtitle)}</p>
      </div>
      <strong>${escapeHtml(status.labelJa)}</strong>
      <dl>
        <div><dt>実行</dt><dd>${escapeHtml(normalized.executed)}</dd></div>
        <div><dt>成功</dt><dd>${escapeHtml(normalized.passed)}</dd></div>
        <div><dt>失敗</dt><dd>${escapeHtml(normalized.failed)}</dd></div>
        <div><dt>スキップ</dt><dd>${escapeHtml(normalized.skipped)}</dd></div>
        <div><dt>エラー</dt><dd>${escapeHtml(normalized.error)}</dd></div>
      </dl>
    </section>`;
}

function adapterSummaryRows(adapterSummary) {
  return Object.values(adapterSummary ?? {})
    .map((adapter) => {
      return `      <tr><td>${escapeHtml(adapter.id)}</td><td>${escapeHtml(adapter.status ?? "active")}</td><td>${escapeHtml(adapter.executed)}</td><td>${escapeHtml(adapter.passed)}</td><td>${escapeHtml(adapter.failed)}</td><td>${escapeHtml(adapter.skipped)}</td><td>${escapeHtml(adapter.error)}</td></tr>`;
    })
    .join("\n");
}

function scopeAdapterSummaryRows(scopeSummary) {
  return Object.values(scopeSummary?.adapterSummary ?? {})
    .map((adapter) => {
      return `      <tr><td>${escapeHtml(adapter.id)}</td><td>${escapeHtml(adapter.executed)}</td><td>${escapeHtml(adapter.passed)}</td><td>${escapeHtml(adapter.failed)}</td><td>${escapeHtml(adapter.skipped)}</td><td>${escapeHtml(adapter.error)}</td></tr>`;
    })
    .join("\n");
}

function scopeSection(title, description, summary, categoryTitle, sectionId) {
  const idAttribute = sectionId ? ` id="${escapeHtml(sectionId)}"` : "";
  return `  <h2${idAttribute}>${escapeHtml(title)}</h2>
  <p>${escapeHtml(description)}</p>
  <table>
    <tbody>
${countTableRows(summary, { vectorCount: true, resultCount: true })}
    </tbody>
  </table>
  <table>
    <thead>
      <tr><th>Adapter</th><th>実行</th><th>成功</th><th>失敗</th><th>スキップ</th><th>エラー</th></tr>
    </thead>
    <tbody>
${scopeAdapterSummaryRows(summary)}
    </tbody>
  </table>
  <h3>${escapeHtml(categoryTitle)}</h3>
  <table>
    <thead>
      <tr><th>Category</th><th>Vectors</th></tr>
    </thead>
    <tbody>
${objectRows(summary?.categories)}
    </tbody>
  </table>`;
}

function claimList(value) {
  return Array.isArray(value) && value.length > 0 ? value.join(", ") : "-";
}

function claimLimits(value) {
  return Array.isArray(value) && value.length > 0 ? value.join(" / ") : "-";
}

function linkList(items, linkForItem) {
  if (!Array.isArray(items) || items.length === 0) {
    return "-";
  }

  return items.map((item) => linkForItem(item)).join(", ");
}

const summarySectionIds = {
  gs1DigitalLink: "summary-gs1-digital-link",
  structuredAppend: "summary-structured-append",
  planningDiagnostics: "summary-planning-diagnostics",
  kanjiEciBinary: "summary-kanji-eci-binary",
  renderingOutput: "summary-rendering-output",
  packageSurface: "summary-package-surface"
};

function suiteLinks(suiteIds) {
  return linkList(suiteIds, (suiteId) => localAnchorLink(anchorId("suite", suiteId), suiteId));
}

function adapterLinks(adapterIds) {
  return linkList(adapterIds, (adapterId) => localAnchorLink(anchorId("adapter", adapterId), adapterId));
}

function badgeLinks(badges) {
  return linkList(badges, (badgePath) => publicLink(badgePath, badgePath.replace(/^badges\//, "")));
}

function reportSummaryLink(reportSummaryKey) {
  if (!reportSummaryKey) {
    return "-";
  }
  const sectionId = summarySectionIds[reportSummaryKey];
  return sectionId ? localAnchorLink(sectionId, reportSummaryKey) : escapeHtml(reportSummaryKey);
}

function statusPill(status, options = {}) {
  const extraClass = options.extraClass ? ` ${options.extraClass}` : "";
  const suffix = options.suffix ? ` ${options.suffix}` : "";
  return `<span class="status-pill status-${escapeHtml(status)}${extraClass}">${escapeHtml(status)}${escapeHtml(suffix)}</span>`;
}

function coverageClaimRows(claims) {
  return claims
    .map((claim) => {
      return `      <tr class="claim-row claim-${escapeHtml(claim.status)}"><td>${escapeHtml(claim.id)}</td><td>${escapeHtml(claim.title)}</td><td>${statusPill(claim.status)}</td><td>${escapeHtml(claim.summary)}</td><td>${suiteLinks(claim.suites)}</td><td>${adapterLinks(claim.adapters)}</td><td>${badgeLinks(claim.badges)}</td><td>${reportSummaryLink(claim.reportSummaryKey)}</td><td>${escapeHtml(claimLimits(claim.limits))}</td></tr>`;
    })
    .join("\n");
}

function nonClaimRows(nonClaims) {
  return nonClaims
    .map((claim) => {
      return `      <tr class="claim-row claim-not-claimed"><td>${escapeHtml(claim.id)}</td><td>${escapeHtml(claim.title)}</td><td>${statusPill(claim.status)}</td><td>${escapeHtml(claim.reason ?? claim.summary)}</td><td>${escapeHtml(claim.futureDirection ?? "-")}</td><td>${escapeHtml(claimLimits(claim.limits))}</td></tr>`;
    })
    .join("\n");
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))]
    .sort((left, right) => String(left).localeCompare(String(right)));
}

function selectOptions(values, selectedValue = "") {
  return values
    .map((value) => {
      const selected = value === selectedValue ? " selected" : "";
      return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(value)}</option>`;
    })
    .join("\n");
}

function renderChecksTable(checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return "<p>checks はありません。</p>";
  }

  return `<table class="nested-table">
        <thead>
          <tr><th>Check</th><th>Status</th><th>Reason</th><th>Important fields</th></tr>
        </thead>
        <tbody>
${checks.map((check) => {
  const important = Object.entries(check)
    .filter(([key]) => !["name", "status", "reason"].includes(key))
    .map(([key, value]) => `${key}: ${formatDetailValue(value)}`)
    .join(" / ");
  return `          <tr><td>${escapeHtml(check.name)}</td><td>${statusPill(check.status)}</td><td>${escapeHtml(check.reason ?? "")}</td><td>${escapeHtml(important || "-")}</td></tr>`;
}).join("\n")}
        </tbody>
      </table>`;
}

function detailAt(object, pathParts) {
  let current = object;
  for (const part of pathParts) {
    if (current === null || current === undefined || typeof current !== "object" || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function formatDetailValue(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function truncateValue(value, maxLength = 96) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function importantDetailPairs(result) {
  const details = result.details ?? {};
  const pairs = [];
  const paths = [
    ["matrixSha256", ["matrixSha256"]],
    ["specqrMatrixSha256", ["specqrMatrixSha256"]],
    ["nayukiMatrixSha256", ["nayukiMatrixSha256"]],
    ["render.format", ["render", "format"]],
    ["render.width", ["render", "width"]],
    ["render.height", ["render", "height"]],
    ["render.size", ["render", "size"]],
    ["render.byteLength", ["render", "byteLength"]],
    ["render.mediaType", ["render", "mediaType"]],
    ["image.width", ["image", "width"]],
    ["image.height", ["image", "height"]],
    ["decoded.text", ["decoded", "text"]],
    ["decoded.binaryHex", ["decoded", "binaryHex"]],
    ["decoded.version", ["decoded", "version"]],
    ["diagnostics.version", ["diagnostics", "version"]],
    ["diagnostics.size", ["diagnostics", "size"]],
    ["diagnostics.mode", ["diagnostics", "mode"]],
    ["diagnostics.errorCorrectionLevel", ["diagnostics", "errorCorrectionLevel"]],
    ["diagnostics.maskPattern", ["diagnostics", "maskPattern"]],
    ["diagnostics.eciAssignmentNumber", ["diagnostics", "eciAssignmentNumber"]],
    ["diagnostics.gs1", ["diagnostics", "gs1"]],
    ["planning.selectedVersion", ["planning", "selectedVersion"]],
    ["planning.remainingBits", ["planning", "remainingBits"]],
    ["capacity.version", ["capacity", "version"]],
    ["capacity.mode", ["capacity", "mode"]],
    ["capacity.maxCharacters", ["capacity", "maxCharacters"]],
    ["gs1.ok", ["gs1", "ok"]],
    ["value", ["value"]],
    ["structuredAppend.total", ["structuredAppend", "total"]],
    ["structuredAppend.parity", ["structuredAppend", "parity"]],
    ["packageSurface.kind", ["packageSurface", "kind"]],
    ["packageSurface.metadata.version", ["packageSurface", "metadata", "version"]],
    ["packageSurface.pngBuffer.byteLength", ["packageSurface", "pngBuffer", "byteLength"]],
    ["packageSurface.typescript.exitCode", ["packageSurface", "typescript", "exitCode"]],
    ["availability.commands", ["availability", "commands"]]
  ];

  for (const [label, pathParts] of paths) {
    const value = detailAt(details, pathParts);
    if (value !== undefined && value !== null && value !== "") {
      pairs.push([label, truncateValue(formatDetailValue(value))]);
    }
  }

  for (const check of result.checks ?? []) {
    for (const key of ["matrixSha256", "specqrMatrixSha256", "nayukiMatrixSha256", "version", "size", "errorCorrectionLevel", "maskPattern", "mode", "format"]) {
      if (check[key] !== undefined && check[key] !== null && check[key] !== "") {
        pairs.push([`check.${check.name}.${key}`, truncateValue(formatDetailValue(check[key]))]);
      }
    }
  }

  return pairs;
}

function importantDetailRows(result) {
  const pairs = importantDetailPairs(result);
  if (pairs.length === 0) {
    return "          <tr><td colspan=\"2\">重要 detail はありません。</td></tr>";
  }

  return pairs
    .map(([label, value]) => `          <tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("\n");
}

function resultDetailBlock(result) {
  const detailJson = JSON.stringify(result.details ?? {});
  return `<details class="result-detail">
        <summary>結果詳細</summary>
        <dl class="result-meta">
          <div><dt>Vector</dt><dd>${escapeHtml(result.vectorId)}</dd></div>
          <div><dt>Suite</dt><dd>${escapeHtml(result.suiteId)}</dd></div>
          <div><dt>Category</dt><dd>${escapeHtml(result.category)}</dd></div>
          <div><dt>Operation</dt><dd>${escapeHtml(result.operation)}</dd></div>
          <div><dt>Adapter</dt><dd>${escapeHtml(result.adapterId)}</dd></div>
          <div><dt>Status</dt><dd>${statusPill(result.status)}</dd></div>
        </dl>
        <p><strong>Reason:</strong> ${escapeHtml(result.reason ?? "-")}</p>
        <h4>Checks</h4>
${renderChecksTable(result.checks)}
        <h4>Important details</h4>
        <table class="nested-table">
          <tbody>
${importantDetailRows(result)}
          </tbody>
        </table>
        <h4>Raw details JSON</h4>
        <pre>${escapeHtml(detailJson === "{}" ? "{ }" : detailJson)}</pre>
      </details>`;
}

const report = await readReport();
const coverageClaimsMap = await readCoverageClaimsFile().catch(() => ({
  schemaVersion: 1,
  claims: [],
  nonClaims: []
}));
const summary = report.summary ?? {};
const target = report.target ?? {};
const adapters = Array.isArray(report.adapters) ? report.adapters : [];
const suites = Array.isArray(report.suites) ? report.suites : [];
const results = Array.isArray(report.results) ? report.results : [];
const metadata = report.metadata ?? {};
const run = report.run ?? {};
const runFilters = run.filters ?? {};
const packages = metadata.packages ?? {};
const runtime = metadata.runtime ?? {};
const adapterSummary = summary.adapterSummary ?? {};
const gs1DigitalLink = summary.gs1DigitalLink ?? {};
const structuredAppend = summary.structuredAppend ?? {};
const planningDiagnostics = summary.planningDiagnostics ?? {};
const kanjiEciBinary = summary.kanjiEciBinary ?? {};
const renderingOutput = summary.renderingOutput ?? {};
const packageSurface = summary.packageSurface ?? {};
const coverageClaims = summary.coverageClaims ?? summarizeCoverageClaims(coverageClaimsMap);
const coverageClaimRowsHtml = coverageClaimRows(coverageClaimsMap.claims ?? []);
const nonClaimRowsHtml = nonClaimRows(coverageClaimsMap.nonClaims ?? []);
const coverageClaimList = allCoverageClaims(coverageClaimsMap);
const optionalDecoderAdapters = adapters.filter((adapter) => {
  return adapter.lane === "optional-decode-readability" || adapter.required === false;
});
const adapterById = Object.fromEntries(adapters.map((adapter) => [adapter.id, adapter]));
const requiredAdapterIds = new Set(adapters.filter((adapter) => adapter.required !== false).map((adapter) => adapter.id));
const rawByteSkipped = results.flatMap((result) => {
  return (result.checks ?? [])
    .filter((check) => check.name === "decode.binaryHex" && check.status === "skipped")
    .map((check) => ({ vectorId: result.vectorId, reason: check.reason }));
});

function isOptionalAvailabilitySkip(result) {
  const adapter = adapterById[result.adapterId];
  if (!adapter || adapter.required !== false || result.status !== "skipped") {
    return false;
  }
  return (result.checks ?? []).some((check) => {
    return check.name === "availability" && check.status === "skipped";
  });
}

function resultRow(result) {
  const adapter = adapterById[result.adapterId] ?? {};
  const expectedSkip = isOptionalAvailabilitySkip(result);
  const requiredIssue = requiredAdapterIds.has(result.adapterId) && ["failed", "error"].includes(result.status);
  const rowClasses = [
    "result-row",
    `result-status-${result.status}`,
    adapter.required === false ? "result-optional-adapter" : "result-required-adapter",
    expectedSkip ? "result-expected-skip" : "",
    requiredIssue ? "result-required-issue" : ""
  ].filter(Boolean).join(" ");
  const status = expectedSkip ? statusPill(result.status, { suffix: "(expected)" }) : statusPill(result.status);
  const suite = localAnchorLink(anchorId("suite", result.suiteId), result.suiteId);
  const adapterLink = localAnchorLink(anchorId("adapter", result.adapterId), result.adapterId);
  const vectorSearch = [
    result.vectorId,
    result.title,
    result.suiteId,
    result.category,
    result.operation,
    result.adapterId,
    result.status,
    result.reason,
    checkSummary(result.checks)
  ].filter(Boolean).join(" ").toLowerCase();

  return `      <tr class="${escapeHtml(rowClasses)}" data-suite="${escapeHtml(result.suiteId)}" data-category="${escapeHtml(result.category)}" data-adapter="${escapeHtml(result.adapterId)}" data-status="${escapeHtml(result.status)}" data-vector-search="${escapeHtml(vectorSearch)}">
        <td><code>${escapeHtml(result.vectorId)}</code><br><span class="muted">${escapeHtml(result.title ?? "")}</span></td>
        <td>${suite}</td>
        <td>${escapeHtml(result.category)}</td>
        <td>${escapeHtml(result.operation)}</td>
        <td>${adapterLink}</td>
        <td>${status}</td>
        <td>${escapeHtml(checkSummary(result.checks) || "-")}</td>
        <td>${escapeHtml(result.reason ?? "-")}</td>
        <td>${resultDetailBlock(result)}</td>
      </tr>`;
}

function resultRows(allResults) {
  return allResults.map((result) => resultRow(result)).join("\n");
}

function requiredIssueRows(allResults) {
  const issues = allResults.filter((result) => {
    return requiredAdapterIds.has(result.adapterId) && ["failed", "error"].includes(result.status);
  });

  if (issues.length === 0) {
    return `  <section class="required-alert required-alert-ok">
    <h2>Required adapter failures/errors</h2>
    <p>Required adapter の failed / error result はありません。</p>
  </section>`;
  }

  return `  <section class="required-alert required-alert-error">
    <h2>Required adapter failures/errors</h2>
    <p>Required adapter の failed / error は release gate 上の強い signal として扱います。</p>
    <table>
      <thead>
        <tr><th>Vector</th><th>Suite</th><th>Adapter</th><th>Status</th><th>Reason</th></tr>
      </thead>
      <tbody>
${issues.map((result) => `        <tr><td><code>${escapeHtml(result.vectorId)}</code></td><td>${escapeHtml(result.suiteId)}</td><td>${escapeHtml(result.adapterId)}</td><td>${statusPill(result.status)}</td><td>${escapeHtml(result.reason ?? "")}</td></tr>`).join("\n")}
      </tbody>
    </table>
  </section>`;
}

const explorerSuiteOptions = selectOptions(uniqueSorted(results.map((result) => result.suiteId)));
const explorerCategoryOptions = selectOptions(uniqueSorted(results.map((result) => result.category)));
const explorerAdapterOptions = selectOptions(uniqueSorted(results.map((result) => result.adapterId)));
const explorerStatusOptions = selectOptions(uniqueSorted(results.map((result) => result.status)));
const resultRowsHtml = resultRows(results);
const requiredIssuesHtml = requiredIssueRows(results);
const publicArtifactRows = [
  ["JSON report", publicLink("reports/latest.json", "reports/latest.json")],
  ["HTML report", publicLink("reports/latest.html", "reports/latest.html")],
  ["Coverage claims", publicLink("coverage/claims-v1.json", "coverage/claims-v1.json")],
  ["Vector schema", publicLink("schemas/vector-suite-v1.schema.json", "schemas/vector-suite-v1.schema.json")],
  ["Report schema", publicLink("schemas/conformance-report-v1.schema.json", "schemas/conformance-report-v1.schema.json")],
  ["Badge schema", publicLink("schemas/badge-v1.schema.json", "schemas/badge-v1.schema.json")],
  ["Claims schema", publicLink("schemas/coverage-claims-v1.schema.json", "schemas/coverage-claims-v1.schema.json")],
  ["Overall badge", publicLink("badges/overall.json", "badges/overall.json")],
  ["SpecQR badge", publicLink("badges/specqr.json", "badges/specqr.json")]
]
  .map(([label, link]) => `      <tr><th>${escapeHtml(label)}</th><td>${link}</td></tr>`)
  .join("\n");

const statusBands = [
  statusBand("Overall", "全 vector / adapter 結果", summary),
  statusBand("SpecQR", "published npm package の generation / helper / planning", adapterSummary.specqr),
  statusBand("jsQR decode readability", "SpecQR 生成 PNG の text / raw byte decode readability", adapterSummary.jsqr),
  statusBand("Nayuki reference matrix", "固定 Version/ECC/mask の matrix exact match", adapterSummary.nayuki),
  ...optionalDecoderAdapters.map((adapter) => {
    return statusBand(
      `${adapter.name} optional decode readability`,
      "任意 CLI decoder。未導入の場合は expected skip として扱います",
      adapterSummary[adapter.id]
    );
  }),
  statusBand("GS1 / Digital Link", "SpecQR がサポートする GS1 helper subset", gs1DigitalLink),
  statusBand("Structured Append", "generation と merge helper の scope", structuredAppend),
  statusBand("Planning / Diagnostics", "estimate / analyzeSegments / getCapacity と warnings", planningDiagnostics),
  statusBand("Kanji / ECI / Binary", "Kanji mode、ECI UTF-8、raw byte payload の scope", kanjiEciBinary),
  statusBand("Rendering / Output", "matrix / SVG / PNG / Data URL output surface", renderingOutput),
  statusBand("Package Surface", "root / browser / node subpath と TypeScript consumer", packageSurface)
].join("\n");

function commandCandidates(adapter) {
  return Array.isArray(adapter.commandCandidates) ? adapter.commandCandidates.join(", ") : "";
}

const adapterRows = adapters
  .map(
    (adapter) => `      <tr id="${escapeHtml(anchorId("adapter", adapter.id))}"><td>${escapeHtml(adapter.id)}</td><td>${escapeHtml(adapter.name)}</td><td>${escapeHtml(adapter.required === false ? "optional" : "required")}</td><td>${escapeHtml(adapter.status)}</td><td>${escapeHtml(adapter.lane ?? "")}</td><td>${escapeHtml(adapter.packageName ?? "")}</td><td>${escapeHtml(adapter.packageVersion ?? "")}</td><td>${escapeHtml(commandCandidates(adapter))}</td></tr>`
  )
  .join("\n");

const suiteRows = suites
  .map(
    (suite) => `      <tr id="${escapeHtml(anchorId("suite", suite.id))}"><td>${escapeHtml(suite.id)}</td><td>${escapeHtml(suite.category)}</td><td>${escapeHtml(suite.vectorCount)}</td><td>${escapeHtml(suite.file)}</td></tr>`
  )
  .join("\n");

const metadataRows = [
  ["generatedAt", metadata.generatedAt],
  ["target.requested", target.requested ?? `${target.name ?? "specqr"}@${target.version ?? ""}`],
  ["target.resolvedVersion", target.resolvedVersion ?? target.version],
  ["target.source", target.source],
  ["run mode", run.mode ?? "full"],
  ["filters.suites", (runFilters.suites ?? []).join(", ")],
  ["filters.categories", (runFilters.categories ?? []).join(", ")],
  ["filters.adapters", (runFilters.adapters ?? []).join(", ")],
  ["filters.vectors", (runFilters.vectors ?? []).join(", ")],
  ["Node", runtime.node],
  ["platform", runtime.platform],
  ["arch", runtime.arch],
  ["specqr", packages.specqr],
  ["jsqr", packages.jsqr],
  ["nayuki-qr-code-generator", packages["nayuki-qr-code-generator"]]
]
  .map(([label, value]) => `      <tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
  .join("\n");

const optionalDecoderSections = optionalDecoderAdapters
  .map((adapter) => {
    return `  <h2>${escapeHtml(adapter.name)} optional decoder checks</h2>
  <p>${escapeHtml(adapter.name)} lane は任意 CLI decoder の readability check です。command が見つからない環境では expected skip として記録し、CI failure にはしません。候補 command: <code>${escapeHtml(commandCandidates(adapter))}</code></p>
  <table>
    <thead>
      <tr><th>Vector</th><th>Operation</th><th>状態</th><th>Checks</th><th>理由</th></tr>
    </thead>
    <tbody>
${renderAdapterResultRows(results, adapter.id)}
    </tbody>
  </table>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SpecQR Conformance Lab Report</title>
  <style>
    body { color: #1f2933; font-family: system-ui, sans-serif; line-height: 1.5; margin: 2rem; max-width: 72rem; }
    a { color: #1f6091; }
    h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.2rem; margin-top: 1.75rem; }
    h3 { font-size: 1rem; margin-top: 1.25rem; }
    h4 { font-size: 0.95rem; margin: 1rem 0 0.35rem; }
    table { border-collapse: collapse; margin-top: 1rem; width: 100%; }
    th, td { border: 1px solid #d9e2ec; padding: 0.5rem; text-align: left; vertical-align: top; }
    th { background: #f0f4f8; }
    code { background: #f0f4f8; padding: 0.1rem 0.25rem; }
    pre { background: #111827; color: #f8fafc; font-size: 0.8rem; line-height: 1.4; max-height: 24rem; overflow: auto; padding: 0.75rem; }
    ul { padding-left: 1.25rem; }
    .muted { color: #627d98; font-size: 0.85rem; }
    .status-grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); margin-top: 1rem; }
    .status-band { border-left: 0.5rem solid #9fb3c8; background: #f8fafc; padding: 0.9rem 1rem; }
    .status-band h2 { font-size: 1rem; margin: 0; }
    .status-band p { margin: 0.25rem 0 0.75rem; }
    .status-band strong { display: inline-block; margin-bottom: 0.5rem; }
    .status-band dl { display: grid; gap: 0.35rem; grid-template-columns: repeat(5, minmax(3rem, 1fr)); margin: 0; }
    .status-band div { min-width: 0; }
    .status-band dt { color: #52606d; font-size: 0.8rem; }
    .status-band dd { font-weight: 700; margin: 0; }
    .status-green { border-color: #2f855a; }
    .status-yellow { border-color: #b7791f; }
    .status-red { border-color: #c53030; }
    .scope-note { background: #fffbea; border: 1px solid #f7d070; padding: 0.75rem 1rem; }
    .required-alert { border: 1px solid #d9e2ec; margin-top: 1rem; padding: 0.75rem 1rem; }
    .required-alert h2 { margin-top: 0; }
    .required-alert-ok { background: #f0fff4; border-color: #9ae6b4; }
    .required-alert-error { background: #fff5f5; border-color: #feb2b2; }
    .filter-panel { align-items: end; border: 1px solid #d9e2ec; display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); margin-top: 1rem; padding: 1rem; }
    .filter-panel label { display: grid; gap: 0.25rem; font-weight: 700; }
    .filter-panel input, .filter-panel select, .filter-panel button { font: inherit; min-height: 2.25rem; padding: 0.35rem 0.45rem; }
    .filter-panel button { background: #1f6091; border: 0; color: white; cursor: pointer; font-weight: 700; }
    .filter-count { font-weight: 700; }
    .table-scroll { overflow-x: auto; }
    .result-row.result-required-issue td { background: #fff5f5; }
    .result-row.result-expected-skip td { background: #fffbea; }
    .status-pill { border-radius: 999px; display: inline-block; font-size: 0.8rem; font-weight: 700; padding: 0.15rem 0.45rem; white-space: nowrap; }
    .status-passed, .status-verified { background: #c6f6d5; color: #22543d; }
    .status-skipped, .status-partial { background: #fefcbf; color: #744210; }
    .status-failed, .status-error { background: #fed7d7; color: #742a2a; }
    .status-not-claimed { background: #e2e8f0; color: #334e68; }
    .claim-row.claim-verified td { border-left: 0.3rem solid #2f855a; }
    .claim-row.claim-partial td { border-left: 0.3rem solid #b7791f; }
    .claim-row.claim-not-claimed td { border-left: 0.3rem solid #718096; }
    .result-detail summary { cursor: pointer; font-weight: 700; }
    .result-meta { display: grid; gap: 0.35rem; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); margin: 0.75rem 0; }
    .result-meta div { border: 1px solid #d9e2ec; padding: 0.4rem; }
    .result-meta dt { color: #52606d; font-size: 0.78rem; }
    .result-meta dd { margin: 0; }
    .nested-table { font-size: 0.9rem; margin-top: 0.35rem; }
    noscript p { background: #fffbea; border: 1px solid #f7d070; padding: 0.75rem 1rem; }
    @media (max-width: 40rem) {
      body { margin: 1rem; }
      .status-band dl { grid-template-columns: repeat(3, minmax(3rem, 1fr)); }
    }
  </style>
</head>
<body>
  <h1>SpecQR Conformance Lab レポート</h1>
  <p>状態: <code>${escapeHtml(report.status)}</code></p>
  <p>対象 requested: <code>${escapeHtml(target.requested ?? `${target.name ?? "specqr"}@${target.version ?? ""}`)}</code> / resolved: <code>${escapeHtml(target.name ?? "specqr")}@${escapeHtml(target.resolvedVersion ?? target.version)}</code> from <code>${escapeHtml(target.source)}</code></p>
  <div class="status-grid">
${statusBands}
  </div>
  <p class="scope-note">スキップ件数は隠さず表示します。adapter の責務外であることが明示された scope skip と、任意 CLI decoder が未導入の expected skip は、失敗やエラーとは別に扱います。</p>
${requiredIssuesHtml}
  <h2>Machine-readable artifacts</h2>
  <p>HTML は <code>reports/latest.json</code> と <code>coverage/claims-v1.json</code> から生成した view です。公開 artifact は次の URL から直接確認できます。</p>
  <table>
    <tbody>
${publicArtifactRows}
    </tbody>
  </table>
  <h2>Coverage claims / non-claims</h2>
  <p>機械可読な claims map は ${publicLink("coverage/claims-v1.json", "coverage/claims-v1.json")} にあります。この report では verified / partial / not-claimed を分け、既存 vector や adapter が支えない scope を release claim として扱わないようにします。</p>
  <table>
    <tbody>
      <tr><th>Claims file</th><td>${escapeHtml(coverageClaims.file ?? "coverage/claims-v1.json")}</td></tr>
      <tr><th>Total claims</th><td>${escapeHtml(coverageClaims.claimCount ?? coverageClaimList.length)}</td></tr>
      <tr><th>Verified</th><td>${escapeHtml(coverageClaims.verified ?? 0)}</td></tr>
      <tr><th>Partial</th><td>${escapeHtml(coverageClaims.partial ?? 0)}</td></tr>
      <tr><th>Not claimed</th><td>${escapeHtml(coverageClaims.notClaimed ?? 0)}</td></tr>
    </tbody>
  </table>
  <h3>Verified / partial claims</h3>
  <table>
    <thead>
      <tr><th>ID</th><th>Title</th><th>Status</th><th>Summary</th><th>Suites</th><th>Adapters</th><th>Badges</th><th>Report key</th><th>Limits</th></tr>
    </thead>
    <tbody>
${coverageClaimRowsHtml}
    </tbody>
  </table>
  <h3>Explicit non-claims</h3>
  <table>
    <thead>
      <tr><th>ID</th><th>Title</th><th>Status</th><th>Reason</th><th>Future direction</th><th>Limits</th></tr>
    </thead>
    <tbody>
${nonClaimRowsHtml}
    </tbody>
  </table>
  <h2>何を検証していないか</h2>
  <ul>
    <li>Micro QR</li>
    <li>rMQR</li>
    <li>full GS1 catalog</li>
    <li>full QR reader</li>
    <li>scanner metadata merge support</li>
    <li>logo/styled QR</li>
    <li>Canvas / browser helper validation</li>
  </ul>
  <h2>概要</h2>
  <table>
    <tbody>
      <tr><th>Suites</th><td>${escapeHtml(summary.suiteCount ?? 0)}</td></tr>
      <tr><th>Total vectors</th><td>${escapeHtml(summary.totalVectors ?? 0)}</td></tr>
      <tr><th>Total results</th><td>${escapeHtml(summary.totalResults ?? 0)}</td></tr>
${countTableRows(summary)}
    </tbody>
  </table>
  <h2>実行メタデータ</h2>
  <table>
    <tbody>
${metadataRows}
    </tbody>
  </table>
  <h2>Adapter 集計</h2>
  <table>
    <thead>
      <tr><th>Adapter</th><th>状態</th><th>実行</th><th>成功</th><th>失敗</th><th>スキップ</th><th>エラー</th></tr>
    </thead>
    <tbody>
${adapterSummaryRows(adapterSummary)}
    </tbody>
  </table>
${scopeSection(
  "GS1 / Digital Link 集計",
  "この集計は SpecQR がサポートする GS1 AI subset と Digital Link helper の確認であり、GS1 full catalog conformance は主張しません。",
  gs1DigitalLink,
  "GS1 / Digital Link categories",
  summarySectionIds.gs1DigitalLink
)}
${scopeSection(
  "Structured Append 集計",
  "この集計は SpecQR の Structured Append generation と merge helper を確認します。jsQR decode readability は Structured Append metadata validation ではなく、decoder merge support も主張しません。Nayuki lane も Structured Append scope は対象外です。",
  structuredAppend,
  "Structured Append categories",
  summarySectionIds.structuredAppend
)}
${scopeSection(
  "Planning / Diagnostics 集計",
  "この集計は SpecQR 2.4.0 の estimate / analyzeSegments / getCapacity と planning diagnostics warning surface を確認します。jsQR と Nayuki は Planning API を実行しません。",
  planningDiagnostics,
  "Planning / Diagnostics categories",
  summarySectionIds.planningDiagnostics
)}
${scopeSection(
  "Kanji / ECI / Binary 集計",
  "この集計は Kanji mode、ECI UTF-8、raw binary payload の generation diagnostics と decoder readability を確認します。decoder が raw bytes や ECI metadata を露出しない場合は、制限として skip を記録します。",
  kanjiEciBinary,
  "Kanji / ECI / Binary categories",
  summarySectionIds.kanjiEciBinary
)}
${scopeSection(
  "Rendering / Output 集計",
  "この集計は Node 上で published specqr@2.4.0 の matrix、SVG、PNG、SVG Data URL、PNG Data URL output surface を確認します。Canvas / browser helper はこの Node-only suite の対象外です。",
  renderingOutput,
  "Rendering / Output categories",
  summarySectionIds.renderingOutput
)}
${scopeSection(
  "Package Surface 集計",
  "この集計は published specqr@2.4.0 の root export、browser subpath、node subpath、package metadata、TypeScript consumer compile を確認します。browser helper は Node 上で import / type check し、browser automation は行いません。",
  packageSurface,
  "Package Surface categories",
  summarySectionIds.packageSurface
)}
  <h2 id="result-explorer">Result explorer</h2>
  <p>全 result を suite、category、adapter、status、vector id search で絞り込めます。JavaScript が無効でも full table を最初から表示します。</p>
  <form id="result-filters" class="filter-panel">
    <label for="filter-suite">Suite
      <select id="filter-suite" name="suite">
        <option value="">All suites</option>
${explorerSuiteOptions}
      </select>
    </label>
    <label for="filter-category">Category
      <select id="filter-category" name="category">
        <option value="">All categories</option>
${explorerCategoryOptions}
      </select>
    </label>
    <label for="filter-adapter">Adapter
      <select id="filter-adapter" name="adapter">
        <option value="">All adapters</option>
${explorerAdapterOptions}
      </select>
    </label>
    <label for="filter-status">Status
      <select id="filter-status" name="status">
        <option value="">All statuses</option>
${explorerStatusOptions}
      </select>
    </label>
    <label for="filter-search">Vector id search
      <input id="filter-search" name="search" type="search" placeholder="core.generate.byte-text">
    </label>
    <button id="filter-reset" type="button">Reset filters</button>
  </form>
  <p id="result-filter-count" class="filter-count" data-total="${escapeHtml(results.length)}">表示: ${escapeHtml(results.length)} / ${escapeHtml(results.length)} results</p>
  <noscript><p>JavaScript が無効なため、filter control は動作しません。全 result table はこのまま確認できます。</p></noscript>
  <div class="table-scroll">
    <table id="result-table">
      <thead>
        <tr><th>Vector</th><th>Suite</th><th>Category</th><th>Operation</th><th>Adapter</th><th>Status</th><th>Checks</th><th>Reason</th><th>Detail</th></tr>
      </thead>
      <tbody>
${resultRowsHtml}
      </tbody>
    </table>
  </div>
  <h2>SpecQR 生成/Planning/Diagnostics/GS1/Structured Append/Kanji/ECI/Binary/Rendering/Package checks</h2>
  <table>
    <thead>
      <tr><th>Vector</th><th>Operation</th><th>状態</th><th>Checks</th><th>理由</th></tr>
    </thead>
    <tbody>
${renderAdapterResultRows(results, "specqr")}
    </tbody>
  </table>
  <h2>jsQR decode readability checks</h2>
  <table>
    <thead>
      <tr><th>Vector</th><th>Operation</th><th>状態</th><th>Checks</th><th>理由</th></tr>
    </thead>
    <tbody>
${renderAdapterResultRows(results, "jsqr")}
    </tbody>
  </table>
  <p>jsQR lane は readable text と raw byte payload を確認します。jsQR が raw byte を公開できない場合は、binary decode check だけを制限としてスキップします。現在の raw byte skip 件数: <code>${escapeHtml(rawByteSkipped.length)}</code></p>
${optionalDecoderSections}
  <h2>Nayuki reference matrix checks</h2>
  <table>
    <thead>
      <tr><th>Vector</th><th>Operation</th><th>状態</th><th>Checks</th><th>理由</th></tr>
    </thead>
    <tbody>
${renderAdapterResultRows(results, "nayuki")}
    </tbody>
  </table>
  <p>Nayuki lane は固定 Version/ECC/mask の matrix exact match だけを確認します。GS1、Kanji、Structured Append、renderer output、auto segmentation の同等性は主張しません。</p>
  <h2>Suites</h2>
  <table>
    <thead>
      <tr><th>ID</th><th>Category</th><th>Vectors</th><th>File</th></tr>
    </thead>
    <tbody>
${suiteRows}
    </tbody>
  </table>
  <h2>Categories</h2>
  <table>
    <thead>
      <tr><th>Category</th><th>Vectors</th></tr>
    </thead>
    <tbody>
${objectRows(summary.categories)}
    </tbody>
  </table>
  <h2>Operations</h2>
  <table>
    <thead>
      <tr><th>Operation</th><th>Vectors</th></tr>
    </thead>
    <tbody>
${objectRows(summary.operations)}
    </tbody>
  </table>
  <h2>Adapters</h2>
  <table>
    <thead>
      <tr><th>ID</th><th>Name</th><th>Required</th><th>Status</th><th>Lane</th><th>Package</th><th>Version</th><th>Command candidates</th></tr>
    </thead>
    <tbody>
${adapterRows}
    </tbody>
  </table>
  <script>
    (() => {
      const table = document.getElementById("result-table");
      if (!table) {
        return;
      }
      const rows = Array.from(table.querySelectorAll("tbody tr.result-row"));
      const controls = {
        suite: document.getElementById("filter-suite"),
        category: document.getElementById("filter-category"),
        adapter: document.getElementById("filter-adapter"),
        status: document.getElementById("filter-status"),
        search: document.getElementById("filter-search")
      };
      const count = document.getElementById("result-filter-count");
      const reset = document.getElementById("filter-reset");

      const controlValues = () => ({
        suite: controls.suite?.value ?? "",
        category: controls.category?.value ?? "",
        adapter: controls.adapter?.value ?? "",
        status: controls.status?.value ?? "",
        search: (controls.search?.value ?? "").trim().toLowerCase()
      });

      const matches = (row, values) => {
        return (!values.suite || row.dataset.suite === values.suite)
          && (!values.category || row.dataset.category === values.category)
          && (!values.adapter || row.dataset.adapter === values.adapter)
          && (!values.status || row.dataset.status === values.status)
          && (!values.search || (row.dataset.vectorSearch ?? "").includes(values.search));
      };

      const update = () => {
        const values = controlValues();
        let visible = 0;
        for (const row of rows) {
          const show = matches(row, values);
          row.hidden = !show;
          if (show) {
            visible += 1;
          }
        }
        if (count) {
          count.textContent = \`表示: \${visible} / \${rows.length} results\`;
        }
      };

      for (const control of Object.values(controls)) {
        control?.addEventListener("input", update);
        control?.addEventListener("change", update);
      }

      reset?.addEventListener("click", () => {
        for (const control of Object.values(controls)) {
          if (control) {
            control.value = "";
          }
        }
        update();
      });

      update();
    })();
  </script>
</body>
</html>
`;

const badges = createBadgeSet(summary);

await mkdir(path.dirname(htmlReportPath), { recursive: true });
await mkdir(badgeDir, { recursive: true });
await writeFile(htmlReportPath, html, "utf8");

for (const [fileName, badge] of Object.entries(badges)) {
  await writeFile(path.join(badgeDir, fileName), `${JSON.stringify(badge, null, 2)}\n`, "utf8");
}

await writeFile(path.join(badgeDir, "conformance.json"), `${JSON.stringify(badges["overall.json"], null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  ok: true,
  report: "reports/latest.html",
  badges: Object.keys(badges).map((fileName) => `badges/${fileName}`)
}, null, 2));
