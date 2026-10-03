import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256, stableStringify } from "./rc-utils.js";

const sourceDirectories = ["adapters", "tools", "vectors", "schemas", "coverage", "fixtures", "policies"];

// Hash a portable manifest of relative paths and file digests, never absolute paths.
export async function contentManifest(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".DS_Store") continue;
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await contentManifest(root, name));
    else if (entry.isFile()) files.push({ path: name, sha256: sha256(await readFile(path.join(root, name))) });
    else throw new Error(`Unsupported entry in provenance manifest: ${name}`);
  }
  return files;
}

export async function contentSha256(root) {
  return manifestContentSha256(await contentManifest(root));
}

export function manifestContentSha256(manifest) {
  const content = manifest.map(({ path, sha256 }) => ({ path, sha256 }));
  content.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return sha256(stableStringify(content));
}

export function semanticSha256(value) {
  return sha256(stableStringify(value));
}

export function semanticReportSha256(report) {
  const { schemaVersion, labVersion, status, target, adapters, suites, summary, results } = report;
  const evidence = { schemaVersion, labVersion, status, run: { mode: report.run?.mode, filters: report.run?.filters }, target, adapters, suites, summary, results };
  return semanticSha256(JSON.parse(JSON.stringify(evidence)));
}

function gitIdentity(cwd) {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { labCommit: /^[a-f0-9]{40,64}$/.test(commit) ? commit : null, workingTreeDirty: status.trim().length > 0 };
  } catch {
    return { labCommit: null, workingTreeDirty: null };
  }
}

export async function createReportProvenance(packages, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const lockBytes = await readFile(path.join(cwd, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  const packageProvenance = {};
  for (const [name, version] of Object.entries(packages)) {
    const override = options.packageRoots?.[name];
    const root = override ?? path.join(cwd, "node_modules", name);
    const locked = lock.packages?.[`node_modules/${name}`];
    packageProvenance[name] = {
      version,
      contentSha256: await contentSha256(root),
      // An isolated candidate is not attested by the Lab's baseline lock entry.
      lockIntegrity: !options.isolatedPackageNames?.includes(name) && locked?.version === version ? locked.integrity ?? null : null
    };
  }
  const sourceManifest = [];
  for (const directory of sourceDirectories) {
    sourceManifest.push(...(await contentManifest(path.join(cwd, directory))).map((entry) => ({ ...entry, path: `${directory}/${entry.path}` })));
  }
  for (const name of ["package.json", "package-lock.json"]) {
    sourceManifest.push({ path: name, sha256: sha256(await readFile(path.join(cwd, name))) });
  }
  sourceManifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const vectorFiles = (await readdir(path.join(cwd, "vectors"))).filter((name) => name.endsWith(".json")).sort();
  const vectors = await Promise.all(vectorFiles.map(async (name) => ({ file: name, suite: JSON.parse(await readFile(path.join(cwd, "vectors", name), "utf8")) })));
  return {
    schemaVersion: 1,
    ...gitIdentity(cwd),
    sourceSha256: semanticSha256(sourceManifest),
    vectorsSha256: semanticSha256(vectors),
    lockfileSha256: sha256(lockBytes),
    packages: packageProvenance,
    subjectRouting: {
      revision: 1,
      resolver: "shared-specqr-target",
      packageName: "specqr",
      packageVersion: packages.specqr,
      contentSha256: packageProvenance.specqr.contentSha256
    }
  };
}
