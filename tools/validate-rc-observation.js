import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  observationManualEvidencePath,
  observationManualEvidenceSchemaPath,
  observationManualEvidenceSchemaSha256,
  observationOutputDirectory,
  observationPolicyPath,
  observationPolicySchemaPath,
  observationPolicySchemaSha256,
  observationPolicySha256,
  observationReportSchemaPath,
  observationReportSchemaSha256
} from "./rc-observation-constants.js";
import {
  buildObservationReport,
  buildObservationSnapshot,
  loadObservationContext
} from "./rc-observation.js";
import { createCheck, deepEqual, readJson, sha256, stableStringify, statusCounts } from "./rc-utils.js";
import { validateSchemaValue } from "./validate-schemas.js";

const requiredEvidencePaths = [
  "raw/registry-exact.json",
  "raw/registry-next.json",
  "raw/registry-comparison.json",
  "raw/dist-tags.json",
  "raw/github.json",
  "raw/technical-run.json",
  "raw/technical-readiness.json",
  "raw/observation-policy.json",
  "raw/observation-policy.schema.json",
  "raw/manual-evidence.json",
  "raw/manual-evidence.schema.json",
  "raw/observation.schema.json",
  "logs/registry.log",
  "logs/github.log",
  "logs/technical.log",
  "snapshot.json"
];

function parseArgs(argv) {
  const options = { reportPath: `${observationOutputDirectory}/observation.json` };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--report" || !argv[index + 1]) {
      throw new Error(`Invalid RC observation validation argument: ${argv[index]}`);
    }
    options.reportPath = argv[index + 1];
    index += 1;
  }
  return options;
}

function safeArtifactPath(root, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw new Error(`Unsafe observation artifact path: ${relativePath}`);
  }
  const absolutePath = path.resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Observation artifact path escapes root: ${relativePath}`);
  }
  return absolutePath;
}

export async function validateObservationFileSet(root, fileHashes) {
  const errors = [];
  const seen = new Set();
  for (const [index, file] of (fileHashes.files ?? []).entries()) {
    if (path.isAbsolute(file.path) || file.path.split("/").includes("..")) {
      errors.push({ path: `$.fileHashes.files[${index}].path`, message: "must be a safe relative path" });
      continue;
    }
    const absolutePath = path.resolve(root, file.path);
    if (!absolutePath.startsWith(`${root}${path.sep}`) || seen.has(absolutePath)) {
      errors.push({ path: file.path, message: seen.has(absolutePath) ? "duplicates a path" : "escapes artifact root" });
      continue;
    }
    seen.add(absolutePath);
    try {
      const metadata = await lstat(absolutePath);
      const contents = await readFile(absolutePath);
      if (!metadata.isFile()) {
        errors.push({ path: file.path, message: "is not a regular file" });
      }
      if (metadata.size !== file.size) {
        errors.push({ path: file.path, message: "size mismatch", expected: file.size, actual: metadata.size });
      }
      const actual = sha256(contents);
      if (actual !== file.sha256) {
        errors.push({ path: file.path, message: "SHA-256 mismatch", expected: file.sha256, actual });
      }
    } catch (error) {
      errors.push({ path: file.path, message: `cannot read evidence file: ${error.message}` });
    }
  }
  const artifactSetSha256 = sha256(`${stableStringify(fileHashes.files)}\n`);
  if (artifactSetSha256 !== fileHashes.artifactSetSha256) {
    errors.push({ path: "$.fileHashes.artifactSetSha256", message: "artifact set SHA-256 mismatch" });
  }
  return { ok: errors.length === 0, errors, artifactSetSha256 };
}

function policyReference(context, report) {
  return {
    id: context.policy.value.id,
    path: observationPolicyPath,
    sha256: observationPolicySha256,
    schemaPath: observationPolicySchemaPath,
    schemaSha256: observationPolicySchemaSha256,
    manualEvidencePath: observationManualEvidencePath,
    manualEvidenceSha256: report.policy.manualEvidenceSha256,
    manualEvidenceSchemaPath: observationManualEvidenceSchemaPath,
    manualEvidenceSchemaSha256: observationManualEvidenceSchemaSha256,
    reportSchemaPath: observationReportSchemaPath,
    reportSchemaSha256: observationReportSchemaSha256
  };
}

export async function validateRcObservation(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const reportPath = path.resolve(cwd, options.reportPath ?? `${observationOutputDirectory}/observation.json`);
  const root = path.dirname(reportPath);
  const context = await loadObservationContext({ cwd });
  const report = await readJson(reportPath);
  const schemaResult = validateSchemaValue(report, context.reportSchema.value);
  const filesResult = await validateObservationFileSet(root, report.fileHashes ?? {});
  const manifest = await readJson(path.join(root, "manifest.json"));
  const [
    registryExact,
    registryNext,
    registryComparison,
    distTagEvidence,
    rawGitHub,
    technicalMetadata,
    technicalReadiness,
    rawPolicy,
    rawPolicySchema,
    manualEvidence,
    rawManualEvidenceSchema,
    rawReportSchema,
    storedSnapshot
  ] = await Promise.all([
    readJson(path.join(root, "raw/registry-exact.json")),
    readJson(path.join(root, "raw/registry-next.json")),
    readJson(path.join(root, "raw/registry-comparison.json")),
    readJson(path.join(root, "raw/dist-tags.json")),
    readJson(path.join(root, "raw/github.json")),
    readJson(path.join(root, "raw/technical-run.json")),
    readJson(path.join(root, "raw/technical-readiness.json")),
    readJson(path.join(root, "raw/observation-policy.json")),
    readJson(path.join(root, "raw/observation-policy.schema.json")),
    readJson(path.join(root, "raw/manual-evidence.json")),
    readJson(path.join(root, "raw/manual-evidence.schema.json")),
    readJson(path.join(root, "raw/observation.schema.json")),
    readJson(path.join(root, "snapshot.json"))
  ]);
  const rebuiltSnapshot = buildObservationSnapshot({
    policy: context.policy.value,
    manualEvidence,
    registryExact,
    registryNext,
    registryComparison,
    distTags: distTagEvidence.tags,
    rawGitHub,
    technicalMetadata,
    technicalReadiness,
    observedAt: storedSnapshot.observedAt,
    labCommit: storedSnapshot.lab.commit,
    workflowRunId: storedSnapshot.lab.workflowRunId,
    workflowUrl: storedSnapshot.lab.workflowUrl,
    manualEvidenceSha256: report.policy.manualEvidenceSha256
  });
  let previousReport = null;
  if (report.history) {
    if (report.history.path !== "history/previous-observation.json") {
      throw new Error("Observation history path is not the required fixed path");
    }
    previousReport = await readJson(safeArtifactPath(root, report.history.path));
  }
  const rebuiltReport = buildObservationReport({
    policy: context.policy.value,
    snapshot: rebuiltSnapshot,
    previousReport,
    generatedAt: report.generatedAt,
    policyReference: policyReference(context, report),
    historyReference: report.history,
    fileHashes: report.fileHashes
  });
  const now = Date.parse(options.now ?? new Date().toISOString());
  const artifactText = filesResult.ok ? (await Promise.all(report.fileHashes.files.map(async (file) => {
    return readFile(safeArtifactPath(root, file.path), "utf8");
  }))).join("\n") : "";
  const credentialValues = ["GITHUB_TOKEN", "GH_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]
    .map((name) => process.env[name])
    .filter((value) => value && value.length >= 8);
  const listedPaths = new Set(report.fileHashes.files.map((file) => file.path));
  const manualSchemaResult = validateSchemaValue(manualEvidence, context.manualEvidenceSchema.value);
  const previousSchemaResult = previousReport ? validateSchemaValue(previousReport, context.reportSchema.value) : { ok: true };
  const checks = [
    createCheck("schema", schemaResult.ok, { errors: schemaResult.errors }),
    createCheck("policy-reference", deepEqual(report.policy, policyReference(context, report))),
    createCheck("policy-snapshot", deepEqual(rawPolicy, context.policy.value) &&
      deepEqual(rawPolicySchema, context.policySchema.value) &&
      deepEqual(rawManualEvidenceSchema, context.manualEvidenceSchema.value) &&
      deepEqual(rawReportSchema, context.reportSchema.value)),
    createCheck("manual-evidence-schema", manualSchemaResult.ok, { errors: manualSchemaResult.errors }),
    createCheck("manual-evidence-hash", report.policy.manualEvidenceSha256 ===
      sha256(await readFile(path.join(root, "raw/manual-evidence.json")))),
    createCheck("required-evidence-set", requiredEvidencePaths.every((filePath) => listedPaths.has(filePath)) &&
      (!report.history || listedPaths.has(report.history.path))),
    createCheck("history-schema", previousSchemaResult.ok),
    createCheck("snapshot-recomputed", deepEqual(storedSnapshot, rebuiltSnapshot)),
    createCheck("report-recomputed", deepEqual(report, rebuiltReport)),
    createCheck("artifact-files", filesResult.ok, { errors: filesResult.errors }),
    createCheck("manifest", manifest.kind === "specqr-rc-observation-manifest" &&
      manifest.artifactSetSha256 === report.fileHashes.artifactSetSha256 &&
      deepEqual(manifest.files, report.fileHashes.files)),
    createCheck("timestamp-not-future", Date.parse(report.observedAt) <= now && Date.parse(report.generatedAt) <= now),
    createCheck("credential-redaction", credentialValues.every((secret) => !artifactText.includes(secret))),
    createCheck("technical-status", report.technicalStatus === "pass"),
    createCheck("observation-status", ["pending", "sufficient"].includes(report.observationStatus))
  ];
  const summary = statusCounts(checks);
  return {
    ok: summary.failed === 0,
    report: options.reportPath ?? `${observationOutputDirectory}/observation.json`,
    technicalStatus: report.technicalStatus,
    observationStatus: report.observationStatus,
    pendingReasons: report.statusReasons?.pending ?? [],
    checks,
    summary
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await validateRcObservation(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
