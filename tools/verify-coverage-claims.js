import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { defaultReportPath, readSuites } from "./run-conformance.js";
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

// These are evidence contracts, not adapter introspection. A regression in an
// adapter's supportsOperation() or returned checks must not reduce its own gate.
// Bump the capability version when intentionally changing its supported scope.
const capabilityContracts = {
  "specqr-expectations-v1": { adapters: ["specqr"], required: true },
  "jsqr-text-binary-v1": { adapters: ["jsqr"], required: true },
  "nayuki-fixed-matrix-v1": { adapters: ["nayuki"], required: true },
  "optional-cli-text-v1": { adapters: ["zbarimg", "zxing-cli"], required: false }
};

function hasPath(value, fieldPath) {
  for (const field of fieldPath.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, field)) {
      return false;
    }
    value = value[field];
  }
  return true;
}

function expectedChecks(vector, capability) {
  const expect = vector.expect ?? {};
  if (capability === "specqr-expectations-v1") {
    const checks = [
      "rejects", "matrixHash", "diagnostics.subset", "planning", "gs1",
      "structuredAppend", "validation", "package.metadataSubset",
      "package.exportedSymbols", "package.helpers", "package.pngBuffer",
      "package.typescript", "package.subset"
    ].filter((field) => hasPath(expect, field));
    if (hasPath(expect, "render")) {
      checks.push("render.format");
      const format = expect.render.format;
      if (format === "matrix") checks.push("render.matrix");
      if (format === "svg" || format === "svg-data-url") checks.push("render.svg");
      if (format === "png" || format === "png-data-url") checks.push("render.png");
      if (format === "svg-data-url" || format === "png-data-url") checks.push("render.dataUrl");
      if (hasPath(expect, "render.diagnosticsSubset")) checks.push("render.diagnosticsSubset");
    }
    return checks;
  }
  if (capability === "nayuki-fixed-matrix-v1") {
    return expect.referenceMatrix?.adapter === "nayuki" ? ["referenceMatrix.exact"] : [];
  }
  if (["jsqr-text-binary-v1", "optional-cli-text-v1"].includes(capability)) {
    if (!["generate", "generateSegments"].includes(vector.operation)) return [];
    const fields = capability === "jsqr-text-binary-v1" ? ["text", "binaryHex"] : ["text"];
    return fields.filter((field) => hasPath(expect, `decode.${field}`)).map((field) => `decode.${field}`);
  }
  return [];
}

function isOptionalUnavailable(result) {
  return result.status === "skipped"
    && result.details?.availability?.optional === true
    && Array.isArray(result.details.availability.commands)
    && result.details.availability.commands.length > 0
    && result.checks?.length === 1
    && result.checks[0].name === "availability"
    && result.checks[0].status === "skipped"
    && typeof result.checks[0].reason === "string"
    && result.checks[0].reason.trim().length > 0;
}

function validateClaimEvidence(claim, { errors, evidence, suites, report }) {
  const requirements = Array.isArray(claim.evidenceRequirements) ? claim.evidenceRequirements : [];
  const requirementAdapters = new Set();
  const scopedVectors = suites.filter((suite) => (claim.suites ?? []).includes(suite.id))
    .flatMap((suite) => suite.vectors.map((vector) => ({ ...vector, suiteId: suite.id })));
  let requiredCapabilities = 0;

  for (const requirement of requirements) {
    if (requirement === null || typeof requirement !== "object") continue; // Reported by schema validation.
    const { adapterId, capability } = requirement;
    const context = { claimId: claim.id, adapterId, capability };
    const contract = Object.hasOwn(capabilityContracts, capability) ? capabilityContracts[capability] : null;
    if (!contract || !contract.adapters.includes(adapterId)) {
      addError(errors, "claims.capability", "capability does not apply to this adapter", context);
      continue;
    }
    if (!(claim.adapters ?? []).includes(adapterId) || requirementAdapters.has(adapterId)) {
      addError(errors, "claims.evidenceRequirements", "each requirement must name a distinct referenced adapter", context);
    }
    requirementAdapters.add(adapterId);
    if (contract.required) requiredCapabilities += 1;

    const coverage = { ...context, required: contract.required, applicableResults: 0, passedChecks: 0, expectedChecks: 0, unavailableResults: 0 };
    for (const vector of scopedVectors) {
      const checks = expectedChecks(vector, capability);
      if (checks.length === 0) continue; // Explicitly outside this capability's scope.
      coverage.applicableResults += 1;
      coverage.expectedChecks += checks.length;
      const resultContext = { ...context, suiteId: vector.suiteId, vectorId: vector.id };
      const matches = (report.results ?? []).filter((result) => result.suiteId === vector.suiteId
        && result.vectorId === vector.id && result.adapterId === adapterId);
      if (matches.length !== 1) {
        addError(errors, "claims.requiredResult", "applicable vector must have exactly one report result", { ...resultContext, resultCount: matches.length });
        continue;
      }
      const result = matches[0];
      if (result.category !== vector.category || result.operation !== vector.operation) {
        addError(errors, "claims.resultIdentity", "applicable result category and operation must match its vector", resultContext);
      }
      if (!contract.required && isOptionalUnavailable(result)) {
        coverage.unavailableResults += 1;
        continue;
      }
      if (result.status !== "passed") {
        addError(errors, "claims.requiredResult", "applicable evidence must pass; scope skips cannot replace required coverage", { ...resultContext, status: result.status });
      }
      for (const name of checks) {
        const matches = (result.checks ?? []).filter((check) => check.name === name);
        if (matches.length !== 1 || matches[0].status !== "passed") {
          addError(errors, "claims.requiredCheck", "expected applicable check must occur exactly once and pass", {
            ...resultContext, checkName: name, checkCount: matches.length, statuses: matches.map((check) => check.status)
          });
        } else {
          coverage.passedChecks += 1;
        }
      }
    }
    if (coverage.applicableResults === 0) {
      addError(errors, "claims.capabilityCoverage", "declared capability has no applicable source vectors", context);
    }
    evidence.push(coverage);
  }

  for (const adapterId of claim.adapters ?? []) {
    if (!requirementAdapters.has(adapterId)) {
      addError(errors, "claims.evidenceRequirements", "referenced adapter must declare its evidence capability", { claimId: claim.id, adapterId });
    }
  }
  if (claim.status === "verified" && requiredCapabilities === 0) {
    addError(errors, "claims.evidenceRequirements", "verified claims require a non-optional evidence capability", { claimId: claim.id });
  }
  for (const result of resultCoverage(report, claim)) {
    if (["failed", "error"].includes(result.status)
      || (result.checks ?? []).some((check) => ["failed", "error"].includes(check.status))) {
      addError(errors, "claims.failedEvidence", "claim coverage contains failed or errored evidence", {
        claimId: claim.id, suiteId: result.suiteId, vectorId: result.vectorId, adapterId: result.adapterId
      });
    }
  }
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
    if ((claim.suites ?? []).length > 0 || (claim.adapters ?? []).length > 0 || (claim.badges ?? []).length > 0 || (claim.evidenceRequirements ?? []).length > 0 || claim.reportSummaryKey !== null) {
      addError(errors, "claims.notClaimedCoverage", "not-claimed entries must not reference vector, adapter, badge, report, or capability coverage", {
        claimId: claim.id,
        suites: claim.suites ?? [],
        adapters: claim.adapters ?? [],
        badges: claim.badges ?? [],
        evidenceRequirements: claim.evidenceRequirements ?? [],
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
  }
  validateClaimEvidence(claim, context);

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
  const evidence = [];
  const schemas = await loadSchemas({ cwd });
  const schemaResult = validateSchemaValue(claimsMap, schemas.coverageClaims);

  if (!schemaResult.ok) {
    for (const validationError of schemaResult.errors) {
      addError(errors, "schema", validationError.message, validationError);
    }
  }

  const suites = options.suites ?? await readSuites({ cwd });
  const vectorSuiteIds = new Set(suites.map((suite) => suite.id));
  const reportSuiteIds = new Set((report.suites ?? []).map((suite) => suite.id));
  const reportAdapterIds = new Set((report.adapters ?? []).map((adapter) => adapter.id));
  const summary = report.summary ?? {};
  const claims = allCoverageClaims(claimsMap);

  uniqueIds(claims, errors);

  for (const claim of claims) {
    await validateClaimReferences(claim, {
      cwd,
      errors,
      warnings,
      evidence,
      suites,
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
    evidence,
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
