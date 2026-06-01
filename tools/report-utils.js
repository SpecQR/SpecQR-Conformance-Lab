export const badgeFileNames = [
  "overall.json",
  "specqr.json",
  "jsqr.json",
  "nayuki.json",
  "gs1-digital-link.json",
  "structured-append.json",
  "planning-diagnostics.json"
];

function toCount(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function normalizeCounts(counts = {}) {
  return {
    total: toCount(counts.total ?? counts.totalResults ?? counts.resultCount),
    executed: toCount(counts.executed),
    passed: toCount(counts.passed),
    failed: toCount(counts.failed),
    skipped: toCount(counts.skipped),
    error: toCount(counts.error)
  };
}

export function summarizeStatus(counts = {}) {
  const normalized = normalizeCounts(counts);

  if (normalized.failed > 0 || normalized.error > 0) {
    return {
      key: "failing",
      color: "red",
      labelJa: "要確認",
      message: `${normalized.failed + normalized.error} failing`
    };
  }

  if (normalized.executed === 0) {
    return {
      key: "skipped",
      color: "yellow",
      labelJa: "スコープ外",
      message: normalized.skipped > 0 ? `${normalized.skipped} skipped` : "no checks"
    };
  }

  return {
    key: "passing",
    color: "green",
    labelJa: "成功",
    message: `${normalized.passed} passed`
  };
}

export function createBadge(label, counts = {}) {
  const status = summarizeStatus(counts);

  return {
    schemaVersion: 1,
    label,
    message: status.message,
    color: status.color
  };
}

export function createBadgeSet(summary = {}) {
  const adapterSummary = summary.adapterSummary ?? {};

  return {
    "overall.json": createBadge("overall", summary),
    "specqr.json": createBadge("specqr", adapterSummary.specqr),
    "jsqr.json": createBadge("jsqr", adapterSummary.jsqr),
    "nayuki.json": createBadge("nayuki", adapterSummary.nayuki),
    "gs1-digital-link.json": createBadge("gs1 digital link", summary.gs1DigitalLink),
    "structured-append.json": createBadge("structured append", summary.structuredAppend),
    "planning-diagnostics.json": createBadge("planning diagnostics", summary.planningDiagnostics)
  };
}
