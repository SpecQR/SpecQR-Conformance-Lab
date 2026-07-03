import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { activeAdapters, defaultReportPath, readSuites } from "./run-conformance.js";
import {
  allCoverageClaims,
  defaultCoverageClaimsPath,
  readCoverageClaimsFile,
  summarizeCoverageClaims
} from "./coverage-claims.js";
import { loadSchemas, readJsonFile, validateSchemaValue } from "./validate-schemas.js";

function addError(errors, label, message, extra = {}) {
  errors.push({ label, message, ...extra });
}

function normalizeBadgePath(badgePath) {
  return String(badgePath).startsWith("badges/")
    ? badgePath
    : path.join("badges", String(badgePath));
}

function isUrl(value) {
  return /^https?:\/\//.test(String(value));
}

async function fileExists(relativePath, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  try {
    await access(path.resolve(cwd, relativePath));
    return true;
  } catch {
    return false;
  }
}

function uniqueIds(claims, errors) {
  const seen = new Set();
  for (const claim of claims) {
    if (seen.has(claim.id)) {
      addError(errors, "claims.id", "claim id must be unique", { claimId: claim.id });
    }
    seen.add(claim.id);
  }
}

function resultCoverage(report, claim) {
  const suites = new Set(claim.suites ?? []);
  const adapters = new Set(claim.adapters ?? []);
  return (report.results ?? []).filter((result) => {
    return suites.has(result.suiteId) && adapters.has(result.adapterId);
  });
}

async function validateClaimReferences(claim, context) {
  const {
    cwd,
    errors,
    warnings,
    vectorSuiteIds,
    reportSuiteIds,
    reportAdapterIds,
    report,
    summary
  } = context;
  const claimPath = `claims.${claim.id}`;

  for (const suiteId of claim.suites ?? []) {
    if (!vectorSuiteIds.has(suiteId)) {
      addError(errors, "claims.suites", "referenced suite does not exist in vectors", { claimId: claim.id, suiteId });
    }
    if (!reportSuiteIds.has(suiteId)) {
      addError(errors, "claims.suites", "referenced suite does not exist in report", { claimId: claim.id, suiteId });
    }
  }

  for (const adapterId of claim.adapters ?? []) {
    if (!reportAdapterIds.has(adapterId)) {
      addError(errors, "claims.adapters", "referenced adapter does not exist in report", { claimId: claim.id, adapterId });
    }
  }

  for (const badge of claim.badges ?? []) {
    const badgePath = normalizeBadgePath(badge);
    if (!await fileExists(badgePath, { cwd })) {
      addError(errors, "claims.badges", "referenced badge file does not exist", { claimId: claim.id, badge: badgePath });
    }
  }

  for (const docPath of claim.publicDocs ?? []) {
    if (!isUrl(docPath) && !await fileExists(docPath, { cwd })) {
      addError(errors, "claims.publicDocs", "referenced public doc does not exist", { claimId: claim.id, docPath });
    }
  }

  if (claim.reportSummaryKey !== null && claim.reportSummaryKey !== undefined) {
    if (!Object.hasOwn(summary, claim.reportSummaryKey)) {
      addError(errors, "claims.reportSummaryKey", "referenced report summary key does not exist", {
        claimId: claim.id,
        reportSummaryKey: claim.reportSummaryKey
      });
    } else if ((summary[claim.reportSummaryKey]?.vectorCount ?? 0) === 0) {
      warnings.push({
        label: "claims.reportSummaryKey",
        message: "referenced report summary key has no vectors",
        claimId: claim.id,
        reportSummaryKey: claim.reportSummaryKey
      });
    }
  }

  if (claim.status === "not-claimed") {
    if ((claim.suites ?? []).length > 0 || (claim.adapters ?? []).length > 0 || (claim.badges ?? []).length > 0 || claim.reportSummaryKey !== null) {
      addError(errors, "claims.notClaimedCoverage", "not-claimed entries must not reference vector, adapter, badge, or report coverage", {
        claimId: claim.id,
        suites: claim.suites ?? [],
        adapters: claim.adapters ?? [],
        badges: claim.badges ?? [],
        reportSummaryKey: claim.reportSummaryKey ?? null
      });
    }
    if (!claim.reason) {
      addError(errors, "claims.reason", "not-claimed entries must include a reason", { claimId: claim.id });
    }
    return;
  }

  for (const [field, values] of Object.entries({
    suites: claim.suites ?? [],
    adapters: claim.adapters ?? [],
    badges: claim.badges ?? []
  })) {
    if (values.length === 0) {
      addError(errors, "claims.references", `${claim.status} entries must include at least one ${field} reference`, {
        claimId: claim.id,
        field
      });
    }
  }

  const coveredResults = resultCoverage(report, claim);
  if (coveredResults.length === 0) {
    addError(errors, "claims.resultCoverage", "claim references no report results", { claimId: claim.id });
  } else if (claim.status === "verified" && !coveredResults.some((result) => result.status === "passed")) {
    addError(errors, "claims.passingCoverage", "verified claim must have at least one passing report result", {
      claimId: claim.id,
      resultCount: coveredResults.length
    });
  }

  if (!Array.isArray(claim.limits) || claim.limits.length === 0) {
    warnings.push({
      label: "claims.limits",
      message: `${claimPath} has no explicit limits`,
      claimId: claim.id
    });
  }
}

export async function verifyCoverageClaimsObject(claimsMap, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const reportPath = options.reportPath ?? defaultReportPath;
  const report = options.report ?? await readJsonFile(reportPath, { cwd });
  const errors = [];
  const warnings = [];
  const schemas = await loadSchemas({ cwd });
  const schemaResult = validateSchemaValue(claimsMap, schemas.coverageClaims);

  if (!schemaResult.ok) {
    for (const validationError of schemaResult.errors) {
      addError(errors, "schema", validationError.message, validationError);
    }
  }

  const suites = await readSuites({ cwd });
  const vectorSuiteIds = new Set(suites.map((suite) => suite.id));
  const reportSuiteIds = new Set((report.suites ?? []).map((suite) => suite.id));
  const reportAdapterIds = new Set((report.adapters ?? activeAdapters).map((adapter) => adapter.id));
  const summary = report.summary ?? {};
  const claims = allCoverageClaims(claimsMap);

  uniqueIds(claims, errors);

  for (const claim of claims) {
    await validateClaimReferences(claim, {
      cwd,
      errors,
      warnings,
      vectorSuiteIds,
      reportSuiteIds,
      reportAdapterIds,
      report,
      summary
    });
  }

  const statusSummary = summarizeCoverageClaims(claimsMap, {
    file: options.claimsPath ?? defaultCoverageClaimsPath
  });

  return {
    ok: errors.length === 0,
    claims: options.claimsPath ?? defaultCoverageClaimsPath,
    report: report.run?.outputPath ?? reportPath,
    claimCount: statusSummary.claimCount,
    statusCounts: statusSummary.statusCounts,
    warnings,
    errors
  };
}

export async function verifyCoverageClaimsFile(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const claimsPath = options.claimsPath ?? defaultCoverageClaimsPath;
  const claimsMap = await readCoverageClaimsFile({ cwd, claimsPath });
  return verifyCoverageClaimsObject(claimsMap, { ...options, cwd, claimsPath });
}

function parseCliArgs(argv) {
  const options = {
    claimsPath: defaultCoverageClaimsPath,
    reportPath: defaultReportPath
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--claims":
      case "--report": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error(`${arg} requires a value`);
        }
        index += 1;
        if (arg === "--claims") {
          options.claimsPath = value;
        } else {
          options.reportPath = value;
        }
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await verifyCoverageClaimsFile(parseCliArgs(process.argv.slice(2)));
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
