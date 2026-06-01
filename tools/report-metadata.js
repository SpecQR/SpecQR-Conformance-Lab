import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const reportPackageNames = ["specqr", "jsqr", "nayuki-qr-code-generator"];

function packageJsonPath(cwd, packageName) {
  return path.join(cwd, "node_modules", ...packageName.split("/"), "package.json");
}

export async function readInstalledPackageVersion(packageName, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const packageJson = JSON.parse(await readFile(packageJsonPath(cwd, packageName), "utf8"));
  return packageJson.version;
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
    packages
  };
}
