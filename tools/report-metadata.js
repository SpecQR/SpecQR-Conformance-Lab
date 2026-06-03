import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const reportPackageNames = ["specqr", "jsqr", "nayuki-qr-code-generator"];
export const defaultSpecqrPackageName = "specqr";
export const defaultSpecqrTargetSource = "npm";

export function packageJsonPath(cwd, packageName) {
  return path.join(cwd, "node_modules", ...packageName.split("/"), "package.json");
}

export async function readInstalledPackageMetadata(packageName, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const metadataPath = packageJsonPath(cwd, packageName);
  let packageJson;

  try {
    packageJson = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read installed package metadata for ${packageName} at ${metadataPath}: ${error.message}`);
  }

  if (!packageJson.version || typeof packageJson.version !== "string") {
    throw new Error(`Installed package metadata for ${packageName} at ${metadataPath} does not include a string version`);
  }

  return packageJson;
}

export async function readInstalledPackageVersion(packageName, options = {}) {
  const packageJson = await readInstalledPackageMetadata(packageName, options);
  return packageJson.version;
}

async function readPinnedSpecqrTarget(cwd) {
  try {
    const packageJson = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    const pinnedVersion = packageJson.devDependencies?.[defaultSpecqrPackageName];
    return pinnedVersion ? `${defaultSpecqrPackageName}@${pinnedVersion}` : null;
  } catch {
    return null;
  }
}

async function createSpecqrTargetMetadata(packages, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const resolvedVersion = packages[defaultSpecqrPackageName];
  const requested = options.targetRequested
    ?? env.SPECQR_TARGET_REQUESTED
    ?? await readPinnedSpecqrTarget(cwd)
    ?? `${defaultSpecqrPackageName}@${resolvedVersion}`;
  const source = options.targetSource
    ?? env.SPECQR_TARGET_SOURCE
    ?? defaultSpecqrTargetSource;

  return {
    packageName: defaultSpecqrPackageName,
    requested,
    resolvedVersion,
    source
  };
}

export async function createReportMetadata(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const packages = {};

  for (const packageName of reportPackageNames) {
    packages[packageName] = await readInstalledPackageVersion(packageName, { cwd });
  }

  return {
    generatedAt: now.toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    packages,
    target: await createSpecqrTargetMetadata(packages, { ...options, cwd })
  };
}
