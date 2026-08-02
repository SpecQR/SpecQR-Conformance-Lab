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
import { buildObservationReport, computeSnapshotId, loadObservationContext } from "./rc-observation.js";
import { deepEqual, readJson, sha256, stableStringify, writeJson, writeText } from "./rc-utils.js";
import { validateSchemaValue } from "./validate-schemas.js";
import { validateRcObservation } from "./validate-rc-observation.js";

const evidencePaths = [
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
  const options = {
    outputDirectory: observationOutputDirectory,
    snapshotPath: null,
    previousReportPath: null,
    generatedAt: null
  };
  const fields = new Map([
    ["--output-directory", "outputDirectory"],
    ["--snapshot", "snapshotPath"],
    ["--previous-report", "previousReportPath"],
    ["--generated-at", "generatedAt"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) {
      throw new Error(`Invalid RC observation assembly argument: ${argv[index]}`);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  return options;
}

async function describeFiles(root, relativePaths) {
  const files = [];
  for (const relativePath of [...relativePaths].sort()) {
    if (path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
      throw new Error(`Unsafe observation evidence path: ${relativePath}`);
    }
    const absolutePath = path.resolve(root, relativePath);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile()) {
      throw new Error(`Observation evidence is not a regular file: ${relativePath}`);
    }
    const contents = await readFile(absolutePath);
    files.push({ path: relativePath, size: metadata.size, sha256: sha256(contents) });
  }
  return {
    artifactSetSha256: sha256(`${stableStringify(files)}\n`),
    files
  };
}

function policyReference(context) {
  return {
    id: context.policy.value.id,
    path: observationPolicyPath,
    sha256: observationPolicySha256,
    schemaPath: observationPolicySchemaPath,
    schemaSha256: observationPolicySchemaSha256,
    manualEvidencePath: observationManualEvidencePath,
    manualEvidenceSha256: context.manualEvidence.sha256,
    manualEvidenceSchemaPath: observationManualEvidenceSchemaPath,
    manualEvidenceSchemaSha256: observationManualEvidenceSchemaSha256,
    reportSchemaPath: observationReportSchemaPath,
    reportSchemaSha256: observationReportSchemaSha256
  };
}

function renderMarkdown(report) {
  const issueSummary = report.github.summary;
  const criteriaRows = report.criteria.map((entry) => {
    return `| \`${entry.id}\` | ${entry.status} | ${entry.actual} | ${entry.required} |`;
  });
  return [
    "# SpecQR RC 2 Observation",
    "",
    `- Candidate: \`${report.candidate.resolvedVersion}\` / \`specqr@next\``,
    `- Observed at: ${report.observedAt}`,
    `- Age: ${report.ageHours} hours`,
    `- Technical status: \`${report.technicalStatus}\``,
    `- Observation status: \`${report.observationStatus}\``,
    `- Technical evidence: [run ${report.technicalEvidence.runId}](${report.technicalEvidence.runUrl})`,
    `- Registry: exact \`${report.registry.exact.status}\`, next \`${report.registry.next.status}\``,
    `- GitHub: ${issueSummary.issues} issue(s), ${issueSummary.pullRequests} pull request(s), ` +
      `${issueSummary.unreviewed} unreviewed, ${issueSummary.blocking} blocking`,
    `- Independent consumer confirmations: ${report.consumerConfirmations.length}`,
    `- Snapshot count: ${report.snapshots.length}`,
    "",
    "## Criteria",
    "",
    "| Criterion | Status | Actual | Required |",
    "| --- | --- | ---: | ---: |",
    ...criteriaRows,
    "",
    "## Pending",
    "",
    ...(report.statusReasons.pending.length === 0 ? ["None."] : report.statusReasons.pending.map((id) => `- \`${id}\``)),
    "",
    "This artifact does not publish stable, change npm dist-tags, update GitHub Release, or change GitHub Pages."
  ].join("\n");
}

export async function assembleRcObservation(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const outputDirectory = path.resolve(cwd, options.outputDirectory ?? observationOutputDirectory);
  const snapshotPath = path.resolve(cwd, options.snapshotPath ?? path.join(outputDirectory, "snapshot.json"));
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const context = await loadObservationContext({ cwd });
  const snapshot = await readJson(snapshotPath);
  if (snapshot.snapshotId !== computeSnapshotId(snapshot)) {
    throw new Error("Current observation snapshot fingerprint does not match its contents");
  }

  let previousReport = null;
  let historyReference = null;
  const files = [...evidencePaths];
  if (options.previousReportPath) {
    const previousPath = path.resolve(cwd, options.previousReportPath);
    const previousValidation = await validateRcObservation({ cwd, reportPath: previousPath, now: generatedAt });
    if (!previousValidation.ok) {
      throw new Error("Previous observation artifact failed integrity validation");
    }
    previousReport = await readJson(previousPath);
    const schemaResult = validateSchemaValue(previousReport, context.reportSchema.value);
    if (!schemaResult.ok || previousReport.technicalStatus !== "pass" || previousReport.observationStatus === "blocked") {
      throw new Error("Previous observation report is not valid reusable history evidence");
    }
    if (!deepEqual(previousReport.policy, {
      ...policyReference(context),
      manualEvidenceSha256: previousReport.policy.manualEvidenceSha256
    })) {
      throw new Error("Previous observation report uses a different policy or schema");
    }
    const historyPath = path.join(outputDirectory, "history/previous-observation.json");
    await writeText(historyPath, await readFile(previousPath, "utf8"));
    files.push("history/previous-observation.json");
    const historyContents = await readFile(historyPath);
    historyReference = {
      path: "history/previous-observation.json",
      sha256: sha256(historyContents),
      snapshotCount: previousReport.snapshots.length,
      workflowRunId: previousReport.lab.workflowRunId,
      workflowUrl: previousReport.lab.workflowUrl,
      artifactSetSha256: previousReport.fileHashes.artifactSetSha256
    };
  }

  const fileHashes = await describeFiles(outputDirectory, files);
  const report = buildObservationReport({
    policy: context.policy.value,
    snapshot,
    previousReport,
    generatedAt,
    policyReference: policyReference(context),
    historyReference,
    fileHashes
  });
  const schemaResult = validateSchemaValue(report, context.reportSchema.value);
  if (!schemaResult.ok) {
    throw new Error(`Assembled observation report does not match schema: ${JSON.stringify(schemaResult.errors)}`);
  }
  await Promise.all([
    writeJson(path.join(outputDirectory, "observation.json"), report),
    writeText(path.join(outputDirectory, "observation.md"), renderMarkdown(report)),
    writeJson(path.join(outputDirectory, "manifest.json"), {
      schemaVersion: 1,
      kind: "specqr-rc-observation-manifest",
      ...fileHashes
    })
  ]);
  return report;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await assembleRcObservation(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      ok: result.observationStatus !== "blocked",
      technicalStatus: result.technicalStatus,
      observationStatus: result.observationStatus,
      observedAt: result.observedAt,
      ageHours: result.ageHours,
      snapshots: result.snapshots.length,
      pendingReasons: result.statusReasons.pending,
      artifactSetSha256: result.fileHashes.artifactSetSha256
    }, null, 2));
    if (result.observationStatus === "blocked") {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
