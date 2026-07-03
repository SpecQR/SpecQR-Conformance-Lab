import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const defaultCoverageClaimsPath = "coverage/claims-v1.json";

export function allCoverageClaims(claimsMap = {}) {
  return [
    ...(Array.isArray(claimsMap.claims) ? claimsMap.claims : []),
    ...(Array.isArray(claimsMap.nonClaims) ? claimsMap.nonClaims : [])
  ];
}

export async function readCoverageClaimsFile(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const claimsPath = options.claimsPath ?? defaultCoverageClaimsPath;
  const absolutePath = path.resolve(cwd, claimsPath);
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

export function summarizeCoverageClaims(claimsMap = {}, options = {}) {
  const claims = allCoverageClaims(claimsMap);
  const statusCounts = {
    verified: 0,
    partial: 0,
    "not-claimed": 0
  };

  for (const claim of claims) {
    if (Object.hasOwn(statusCounts, claim.status)) {
      statusCounts[claim.status] += 1;
    }
  }

  return {
    file: options.file ?? defaultCoverageClaimsPath,
    schemaVersion: claimsMap.schemaVersion ?? 1,
    claimCount: claims.length,
    verified: statusCounts.verified,
    partial: statusCounts.partial,
    notClaimed: statusCounts["not-claimed"],
    statusCounts,
    claims: claims.map((claim) => ({
      id: claim.id,
      title: claim.title,
      status: claim.status,
      reportSummaryKey: claim.reportSummaryKey ?? null
    }))
  };
}
