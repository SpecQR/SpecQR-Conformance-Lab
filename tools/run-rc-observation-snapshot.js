import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  observationOutputDirectory
} from "./rc-observation-constants.js";
import { collectOpenGitHubItems, collectTechnicalArtifact } from "./rc-observation-github.js";
import {
  assertFixedObservationTarget,
  buildObservationSnapshot,
  loadObservationContext
} from "./rc-observation.js";
import { compareRegistryEvidence, installAndVerifyRegistryTarget } from "./rc-registry.js";
import { writeJson, writeText } from "./rc-utils.js";

function parseArgs(argv) {
  const options = {
    outputDirectory: observationOutputDirectory,
    observedAt: null,
    technicalRunId: null,
    expectedCommit: null,
    manualEvidencePath: null
  };
  const fields = new Map([
    ["--output-directory", "outputDirectory"],
    ["--observed-at", "observedAt"],
    ["--technical-run-id", "technicalRunId"],
    ["--expected-commit", "expectedCommit"],
    ["--manual-evidence", "manualEvidencePath"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) {
      throw new Error(`Invalid RC observation snapshot argument: ${argv[index]}`);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  return options;
}

function gitHead(cwd) {
  const run = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(`Cannot determine Lab commit: ${run.stderr || run.stdout}`.trim());
  }
  return run.stdout.trim();
}

function npmDistTags(cwd) {
  const registryRun = spawnSync("npm", ["config", "get", "registry"], {
    cwd,
    encoding: "utf8"
  });
  if (registryRun.status !== 0 || registryRun.stdout.trim() !== "https://registry.npmjs.org/") {
    throw new Error("RC observation requires the public npm registry https://registry.npmjs.org/");
  }
  const run = spawnSync("npm", ["view", "specqr", "dist-tags", "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  if (run.status !== 0) {
    throw new Error(`npm view specqr dist-tags failed: ${run.stderr || run.stdout}`.trim());
  }
  return {
    tags: JSON.parse(run.stdout),
    log: [
      "$ npm config get registry",
      registryRun.stdout.trim(),
      "",
      "$ npm view specqr dist-tags --json",
      run.stdout.trim()
    ].join("\n")
  };
}

function workflowIdentity() {
  const runId = process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null;
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  return {
    runId: Number.isInteger(runId) ? runId : null,
    url: runId && server && repository ? `${server}/${repository}/actions/runs/${runId}` : null
  };
}

function redactCredentials(value) {
  let result = String(value);
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) {
      result = result.replaceAll(secret, "[redacted]");
    }
  }
  return result;
}

export async function runRcObservationSnapshot(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const outputDirectory = path.resolve(cwd, options.outputDirectory ?? observationOutputDirectory);
  const observedAt = options.observedAt ?? new Date().toISOString();
  if (Date.parse(observedAt) > Date.now()) {
    throw new Error("observedAt cannot be in the future");
  }
  const context = await loadObservationContext({
    cwd,
    manualEvidencePath: options.manualEvidencePath ?? undefined
  });
  assertFixedObservationTarget(context.policy.value);
  const technicalRunId = Number(options.technicalRunId ?? context.policy.value.technicalEvidence.initialRunId);
  if (!Number.isSafeInteger(technicalRunId) || technicalRunId < 1) {
    throw new Error("technical run ID must be a positive integer");
  }
  const labCommit = options.expectedCommit ?? process.env.SPECQR_EVIDENCE_COMMIT ?? process.env.GITHUB_SHA ?? gitHead(cwd);
  const workflow = workflowIdentity();

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(path.join(outputDirectory, "raw"), { recursive: true });
  await mkdir(path.join(outputDirectory, "logs"), { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "specqr-observation-registry-"));

  try {
    const exact = await installAndVerifyRegistryTarget(context.policy.value.candidate.exactRequested, {
      parentRoot: temporaryRoot
    });
    const next = await installAndVerifyRegistryTarget(context.policy.value.candidate.nextRequested, {
      parentRoot: temporaryRoot
    });
    const registryComparison = compareRegistryEvidence(exact.evidence, next.evidence);
    const distTags = npmDistTags(cwd);
    const [github, technical] = await Promise.all([
      collectOpenGitHubItems(context.policy.value.repositories),
      collectTechnicalArtifact(context.policy.value, technicalRunId)
    ]);
    const snapshot = buildObservationSnapshot({
      policy: context.policy.value,
      manualEvidence: context.manualEvidence.value,
      registryExact: exact.evidence,
      registryNext: next.evidence,
      registryComparison,
      distTags: distTags.tags,
      rawGitHub: github,
      technicalMetadata: technical.metadata,
      technicalReadiness: technical.readiness,
      observedAt,
      labCommit,
      workflowRunId: workflow.runId,
      workflowUrl: workflow.url,
      manualEvidenceSha256: context.manualEvidence.sha256
    });

    await Promise.all([
      writeJson(path.join(outputDirectory, "raw/registry-exact.json"), exact.evidence),
      writeJson(path.join(outputDirectory, "raw/registry-next.json"), next.evidence),
      writeJson(path.join(outputDirectory, "raw/registry-comparison.json"), registryComparison),
      writeJson(path.join(outputDirectory, "raw/dist-tags.json"), {
        schemaVersion: 1,
        kind: "specqr-dist-tags-snapshot",
        source: "npm-registry",
        observedAt,
        tags: distTags.tags
      }),
      writeJson(path.join(outputDirectory, "raw/github.json"), {
        schemaVersion: 1,
        kind: "specqr-github-open-items-snapshot",
        source: "github-rest-api",
        observedAt,
        repositories: github.repositories,
        counts: github.counts,
        items: github.items
      }),
      writeJson(path.join(outputDirectory, "raw/technical-run.json"), technical.metadata),
      writeText(path.join(outputDirectory, "raw/technical-readiness.json"), technical.readinessText),
      writeText(path.join(outputDirectory, "raw/observation-policy.json"), context.policy.text),
      writeText(path.join(outputDirectory, "raw/observation-policy.schema.json"), context.policySchema.text),
      writeText(path.join(outputDirectory, "raw/manual-evidence.json"), context.manualEvidence.text),
      writeText(path.join(outputDirectory, "raw/manual-evidence.schema.json"), context.manualEvidenceSchema.text),
      writeText(path.join(outputDirectory, "raw/observation.schema.json"), context.reportSchema.text),
      writeText(
        path.join(outputDirectory, "logs/registry.log"),
        redactCredentials([
          "## exact",
          exact.log,
          "",
          "## next",
          next.log,
          "",
          "## dist-tags",
          distTags.log
        ].join("\n").replaceAll(temporaryRoot, "[temporary-root]"))
      ),
      writeText(path.join(outputDirectory, "logs/github.log"), redactCredentials(github.log)),
      writeText(path.join(outputDirectory, "logs/technical.log"), redactCredentials(technical.log)),
      writeJson(path.join(outputDirectory, "snapshot.json"), snapshot)
    ]);
    return snapshot;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  const outputDirectory = path.resolve(process.cwd(), options.outputDirectory);
  try {
    const snapshot = await runRcObservationSnapshot(options);
    console.log(JSON.stringify({
      ok: snapshot.technicalStatus === "pass",
      snapshotId: snapshot.snapshotId,
      observedAt: snapshot.observedAt,
      ageHours: snapshot.ageHours,
      technicalStatus: snapshot.technicalStatus,
      github: snapshot.github.summary,
      consumerConfirmations: snapshot.consumerConfirmations.length
    }, null, 2));
    if (snapshot.technicalStatus !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    const safeMessage = redactCredentials(error.message);
    await mkdir(path.join(outputDirectory, "logs"), { recursive: true });
    await writeJson(path.join(outputDirectory, "failure.json"), {
      schemaVersion: 1,
      kind: "specqr-rc-observation-failure",
      failedAt: new Date().toISOString(),
      stage: "snapshot",
      error: safeMessage
    });
    await writeText(path.join(outputDirectory, "logs/failure.log"), redactCredentials(error.stack ?? error.message));
    console.error(JSON.stringify({ ok: false, error: safeMessage }, null, 2));
    process.exitCode = 1;
  }
}
