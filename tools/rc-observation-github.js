import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "./rc-utils.js";

const apiOrigin = "https://api.github.com";

function localGitHubToken() {
  const environmentToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (environmentToken) {
    return environmentToken;
  }

  const run = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return run.status === 0 ? run.stdout.trim() : null;
}

function requestBuffer(url, options = {}, redirects = 0) {
  if (redirects > 5) {
    throw new Error(`Too many GitHub redirects for ${url}`);
  }

  const parsed = new URL(url);
  const token = options.sendToken === false ? null : options.token;
  const headers = {
    accept: options.accept ?? "application/vnd.github+json",
    "user-agent": "SpecQR-Conformance-Lab"
  };
  if (token && parsed.origin === apiOrigin) {
    headers.authorization = `Bearer ${token}`;
    headers["x-github-api-version"] = "2022-11-28";
  }

  return new Promise((resolve, reject) => {
    const request = https.get(parsed, { headers }, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(requestBuffer(new URL(response.headers.location, parsed).href, {
          ...options,
          sendToken: new URL(response.headers.location, parsed).origin === apiOrigin
        }, redirects + 1));
        return;
      }

      const chunks = [];
      let byteLength = 0;
      response.on("data", (chunk) => {
        byteLength += chunk.length;
        if (byteLength > (options.maxBytes ?? 16 * 1024 * 1024)) {
          response.destroy(new Error(`GitHub response exceeded the size limit: ${parsed.pathname}`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`GitHub API request failed with HTTP ${statusCode}: ${parsed.pathname}`));
          return;
        }
        resolve(body);
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function requestJson(apiPath, token) {
  const body = await requestBuffer(`${apiOrigin}${apiPath}`, { token });
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new Error(`GitHub API returned invalid JSON for ${apiPath}: ${error.message}`);
  }
}

async function paginated(apiPath, token) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const result = await requestJson(`${apiPath}${separator}per_page=100&page=${page}`, token);
    if (!Array.isArray(result)) {
      throw new Error(`GitHub API pagination expected an array for ${apiPath}`);
    }
    values.push(...result);
    if (result.length < 100) {
      return values;
    }
  }
}

function issueRecord(repository, type, item) {
  return {
    repository,
    type,
    number: item.number,
    state: item.state,
    title: item.title,
    labels: (item.labels ?? []).map((label) => typeof label === "string" ? label : label.name).sort(),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    closedAt: item.closed_at ?? null,
    url: item.html_url
  };
}

export async function collectOpenGitHubItems(repositories, options = {}) {
  const token = options.token ?? localGitHubToken();
  const items = [];
  const counts = {};

  for (const repository of repositories) {
    const [issues, pulls] = await Promise.all([
      paginated(`/repos/${repository}/issues?state=open`, token),
      paginated(`/repos/${repository}/pulls?state=open`, token)
    ]);
    const issueRecords = issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => issueRecord(repository, "issue", issue));
    const pullRecords = pulls.map((pull) => issueRecord(repository, "pull-request", pull));
    items.push(...issueRecords, ...pullRecords);
    counts[repository] = {
      issues: issueRecords.length,
      pullRequests: pullRecords.length
    };
  }

  items.sort((left, right) => {
    return left.repository.localeCompare(right.repository) ||
      left.type.localeCompare(right.type) || left.number - right.number;
  });
  return {
    repositories: [...repositories],
    counts,
    items,
    log: [
      "Fetched open issues and pull requests from the GitHub REST API.",
      ...Object.entries(counts).map(([repository, count]) => {
        return `${repository}: ${count.issues} issue(s), ${count.pullRequests} pull request(s)`;
      })
    ].join("\n")
  };
}

function readinessEntry(entries) {
  const candidates = entries.filter((entry) => entry === "readiness.json" || entry.endsWith("/readiness.json"));
  if (candidates.length !== 1) {
    throw new Error(`Technical artifact must contain exactly one readiness.json; found ${candidates.length}`);
  }
  return candidates[0];
}

async function extractReadiness(archive) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "specqr-observation-artifact-"));
  const archivePath = path.join(temporaryDirectory, "artifact.zip");
  try {
    await writeFile(archivePath, archive);
    const listRun = spawnSync("unzip", ["-Z1", archivePath], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    if (listRun.status !== 0) {
      throw new Error(`Cannot list technical artifact ZIP: ${listRun.stderr || listRun.stdout}`.trim());
    }
    const entries = listRun.stdout.split(/\r?\n/u).filter(Boolean);
    if (entries.some((entry) => path.isAbsolute(entry) || entry.split("/").includes(".."))) {
      throw new Error("Technical artifact ZIP contains an unsafe path");
    }
    const entry = readinessEntry(entries);
    const extractRun = spawnSync("unzip", ["-p", archivePath, entry], {
      encoding: null,
      maxBuffer: 16 * 1024 * 1024
    });
    if (extractRun.status !== 0) {
      throw new Error(`Cannot read ${entry} from technical artifact ZIP`);
    }
    const readinessBuffer = Buffer.from(extractRun.stdout);
    return {
      entry,
      buffer: readinessBuffer,
      value: JSON.parse(readinessBuffer.toString("utf8"))
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function collectTechnicalArtifact(policy, runId, options = {}) {
  const token = options.token ?? localGitHubToken();
  if (!token) {
    throw new Error("GitHub authentication is required to download the technical readiness artifact");
  }

  const repository = policy.technicalEvidence.repository;
  const run = await requestJson(`/repos/${repository}/actions/runs/${runId}`, token);
  const artifactResponse = await requestJson(`/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, token);
  const expectedName = `specqr-3.0.0-rc.2-readiness-${run.head_sha}`;
  const artifacts = artifactResponse.artifacts ?? [];
  const matches = artifacts.filter((artifact) => artifact.name === expectedName);
  if (matches.length !== 1) {
    throw new Error(`Technical run ${runId} must have exactly one ${expectedName} artifact`);
  }

  const artifact = matches[0];
  if (artifact.expired) {
    throw new Error(`Technical artifact ${artifact.id} has expired`);
  }
  if (!Number.isInteger(artifact.size_in_bytes) || artifact.size_in_bytes > 8 * 1024 * 1024) {
    throw new Error(`Technical artifact ${artifact.id} exceeds the observation size limit`);
  }
  const archive = await requestBuffer(
    `${apiOrigin}/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    { token, maxBytes: 8 * 1024 * 1024 }
  );
  const archiveSha256 = sha256(archive);
  const expectedArchiveSha256 = String(artifact.digest ?? "").replace(/^sha256:/u, "");
  if (!expectedArchiveSha256 || archiveSha256 !== expectedArchiveSha256) {
    throw new Error(`Technical artifact ${artifact.id} archive SHA-256 does not match GitHub metadata`);
  }
  const readiness = await extractReadiness(archive);

  return {
    metadata: {
      repository,
      run: {
        id: run.id,
        workflowId: run.workflow_id,
        status: run.status,
        conclusion: run.conclusion,
        event: run.event,
        headSha: run.head_sha,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        url: run.html_url
      },
      artifact: {
        id: artifact.id,
        name: artifact.name,
        sizeInBytes: artifact.size_in_bytes,
        digest: artifact.digest,
        archiveSha256,
        expired: artifact.expired,
        createdAt: artifact.created_at,
        expiresAt: artifact.expires_at,
        url: `https://github.com/${repository}/actions/runs/${run.id}/artifacts/${artifact.id}`,
        readinessEntry: readiness.entry,
        readinessSha256: sha256(readiness.buffer)
      }
    },
    readiness: readiness.value,
    readinessText: readiness.buffer.toString("utf8"),
    log: [
      `Verified GitHub Actions run ${run.id} and artifact ${artifact.id}.`,
      `Archive SHA-256: ${archiveSha256}`,
      `Readiness SHA-256: ${sha256(readiness.buffer)}`
    ].join("\n")
  };
}
