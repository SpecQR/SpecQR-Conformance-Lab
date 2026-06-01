import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createBadgeSet, normalizeCounts, summarizeStatus } from "./report-utils.js";

const jsonReportPath = path.resolve("reports/latest.json");
const htmlReportPath = path.resolve("reports/latest.html");
const badgeDir = path.resolve("badges");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
      target: {
        name: "specqr",
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

function scopeSection(title, description, summary, categoryTitle) {
  return `  <h2>${escapeHtml(title)}</h2>
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

const report = await readReport();
const summary = report.summary ?? {};
const adapters = Array.isArray(report.adapters) ? report.adapters : [];
const suites = Array.isArray(report.suites) ? report.suites : [];
const results = Array.isArray(report.results) ? report.results : [];
const metadata = report.metadata ?? {};
const packages = metadata.packages ?? {};
const runtime = metadata.runtime ?? {};
const adapterSummary = summary.adapterSummary ?? {};
const gs1DigitalLink = summary.gs1DigitalLink ?? {};
const structuredAppend = summary.structuredAppend ?? {};
const planningDiagnostics = summary.planningDiagnostics ?? {};
const rawByteSkipped = results.flatMap((result) => {
  return (result.checks ?? [])
    .filter((check) => check.name === "decode.binaryHex" && check.status === "skipped")
    .map((check) => ({ vectorId: result.vectorId, reason: check.reason }));
});

const statusBands = [
  statusBand("Overall", "全 vector / adapter 結果", summary),
  statusBand("SpecQR", "published npm package の generation / helper / planning", adapterSummary.specqr),
  statusBand("jsQR decode readability", "SpecQR 生成 PNG の text / raw byte decode readability", adapterSummary.jsqr),
  statusBand("Nayuki reference matrix", "固定 Version/ECC/mask の matrix exact match", adapterSummary.nayuki),
  statusBand("GS1 / Digital Link", "SpecQR がサポートする GS1 helper subset", gs1DigitalLink),
  statusBand("Structured Append", "generation と merge helper の scope", structuredAppend),
  statusBand("Planning / Diagnostics", "estimate / analyzeSegments / getCapacity と warnings", planningDiagnostics)
].join("\n");

const adapterRows = adapters
  .map(
    (adapter) => `      <tr><td>${escapeHtml(adapter.id)}</td><td>${escapeHtml(adapter.name)}</td><td>${escapeHtml(adapter.status)}</td><td>${escapeHtml(adapter.packageName ?? "")}</td><td>${escapeHtml(adapter.packageVersion ?? "")}</td></tr>`
  )
  .join("\n");

const suiteRows = suites
  .map(
    (suite) => `      <tr><td>${escapeHtml(suite.id)}</td><td>${escapeHtml(suite.category)}</td><td>${escapeHtml(suite.vectorCount)}</td><td>${escapeHtml(suite.file)}</td></tr>`
  )
  .join("\n");

const metadataRows = [
  ["generatedAt", metadata.generatedAt],
  ["Node", runtime.node],
  ["platform", runtime.platform],
  ["arch", runtime.arch],
  ["specqr", packages.specqr],
  ["jsqr", packages.jsqr],
  ["nayuki-qr-code-generator", packages["nayuki-qr-code-generator"]]
]
  .map(([label, value]) => `      <tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
  .join("\n");

const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SpecQR Conformance Lab Report</title>
  <style>
    body { color: #1f2933; font-family: system-ui, sans-serif; line-height: 1.5; margin: 2rem; max-width: 72rem; }
    h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.2rem; margin-top: 1.75rem; }
    h3 { font-size: 1rem; margin-top: 1.25rem; }
    table { border-collapse: collapse; margin-top: 1rem; width: 100%; }
    th, td { border: 1px solid #d9e2ec; padding: 0.5rem; text-align: left; vertical-align: top; }
    th { background: #f0f4f8; }
    code { background: #f0f4f8; padding: 0.1rem 0.25rem; }
    ul { padding-left: 1.25rem; }
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
    @media (max-width: 40rem) {
      body { margin: 1rem; }
      .status-band dl { grid-template-columns: repeat(3, minmax(3rem, 1fr)); }
    }
  </style>
</head>
<body>
  <h1>SpecQR Conformance Lab レポート</h1>
  <p>状態: <code>${escapeHtml(report.status)}</code></p>
  <p>対象: <code>${escapeHtml(report.target?.name)}@${escapeHtml(report.target?.version)}</code> from <code>${escapeHtml(report.target?.source)}</code></p>
  <div class="status-grid">
${statusBands}
  </div>
  <p class="scope-note">スキップ件数は隠さず表示します。adapter の責務外であることが明示された scope skip は、失敗やエラーとは別に扱います。</p>
  <h2>何を検証していないか</h2>
  <ul>
    <li>Micro QR</li>
    <li>rMQR</li>
    <li>full GS1 catalog</li>
    <li>full QR reader</li>
    <li>scanner metadata merge support</li>
    <li>logo/styled QR</li>
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
  "GS1 / Digital Link categories"
)}
${scopeSection(
  "Structured Append 集計",
  "この集計は SpecQR の Structured Append generation と merge helper を確認します。jsQR decode readability は Structured Append metadata validation ではなく、decoder merge support も主張しません。Nayuki lane も Structured Append scope は対象外です。",
  structuredAppend,
  "Structured Append categories"
)}
${scopeSection(
  "Planning / Diagnostics 集計",
  "この集計は SpecQR 2.4.0 の estimate / analyzeSegments / getCapacity と planning diagnostics warning surface を確認します。jsQR と Nayuki は Planning API を実行しません。",
  planningDiagnostics,
  "Planning / Diagnostics categories"
)}
  <h2>SpecQR 生成/Planning/Diagnostics/GS1/Structured Append checks</h2>
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
      <tr><th>ID</th><th>Name</th><th>Status</th><th>Package</th><th>Version</th></tr>
    </thead>
    <tbody>
${adapterRows}
    </tbody>
  </table>
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
